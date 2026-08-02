//! The client's microphone, plugged into the machine.
//!
//! # What this creates
//!
//! A machine-visible audio source named "lwfa Microphone". Anything on the
//! desktop that asks for a microphone (a browser in a meeting, a recorder, a
//! dictation tool) sees it in its device list like any physical mic, and what
//! it hears is whatever the connected client's microphone hears.
//!
//! It exists only while a session is actually feeding it. A virtual mic left
//! plugged in would be a device that claims to hear a room it cannot, and
//! worse, a reason for someone to wonder whether it can.
//!
//! # How the device is made
//!
//! Two PulseAudio modules, loaded through `pactl` against PipeWire's Pulse
//! server, the same tooling `audio.rs` already leans on for capture:
//!
//! 1. `module-null-sink`: a sink whose monitor carries whatever is played
//!    into it.
//! 2. `module-remap-source` over that monitor: a *proper source*, not a
//!    "Monitor of…" entry. The distinction matters because Chromium hides
//!    monitor sources from `getUserMedia` device lists, and a virtual mic
//!    Meet cannot see would miss the entire point.
//!
//! Decoded microphone audio is then simply *played* into the null sink with
//! `pacat`, and the remap source republishes it as microphone input.
//!
//! # Why a subprocess and not the PipeWire API
//!
//! Same reasoning as `audio.rs`, in the other direction: `pacat` is already
//! installed wherever PipeWire's Pulse shim is, it reads exactly the format
//! needed from stdin, and it costs one pipe. Linking `libpipewire` would buy
//! a second event loop and a build-time dependency to arrive at the same
//! bytes.
//!
//! # Latency and loss
//!
//! Chunks arrive from the network on the compositor's event loop, which must
//! never block on an audio pipe. So the loop hands them to a bounded channel
//! and a feeder thread does the decoding and the writing. The channel holds
//! at most eight 20ms chunks: when the far side bursts or the pipe stalls,
//! the oldest thing that can happen is 160ms of backlog, and beyond that
//! chunks are dropped whole. A microphone that skips a syllable under
//! pressure beats one that drifts seconds behind the speaker.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::thread;

use lwfa_proto::{MIC_TAG_OPUS, MIC_TAG_PCM};

/// Matches the uplink format the shell declares: Opus or PCM at 48kHz mono.
const SAMPLE_RATE: u32 = 48_000;

/// Mono. A microphone is a voice, not a soundstage, and half the bytes.
const CHANNELS: u8 = 1;

/// Bounded backlog, in 20ms chunks. See the module docs on latency.
const QUEUE_CHUNKS: usize = 8;

/// The largest PCM a single Opus packet can decode to at these settings:
/// Opus frames are at most 120ms.
const MAX_FRAME_SAMPLES: usize = (SAMPLE_RATE as usize * 120) / 1000;

/// A running virtual microphone. Dropping it unplugs the device.
pub struct Mic {
    feeder: SyncSender<Vec<u8>>,
    child: Child,
    /// Module indices to unload, in reverse order of loading.
    modules: Vec<String>,
    /// Chunks dropped because the queue was full, for the log on drop.
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl Mic {
    /// Create the device and start the feeder.
    ///
    /// Fails if the Pulse tooling is unavailable or refuses, in which case
    /// nothing is left half-plugged: any module that did load is unloaded.
    pub fn start() -> Result<Self, String> {
        let mut modules = Vec::new();

        let sink = load_module(&[
            "module-null-sink",
            "sink_name=lwfa_mic_sink",
            "sink_properties=device.description=lwfa-mic-sink",
        ])?;
        modules.push(sink);

        match load_module(&[
            "module-remap-source",
            "master=lwfa_mic_sink.monitor",
            "source_name=lwfa_mic",
            "source_properties=device.description=lwfa-Microphone",
        ]) {
            Ok(source) => modules.push(source),
            Err(err) => {
                unload_modules(&modules);
                return Err(err);
            }
        }

        // Feed the sink by playing into it. `--raw` PCM on stdin, the format
        // the feeder thread produces.
        let child = Command::new("pacat")
            .args([
                "--playback",
                "--device=lwfa_mic_sink",
                "--raw",
                "--format=s16le",
                &format!("--rate={SAMPLE_RATE}"),
                &format!("--channels={CHANNELS}"),
                "--latency-msec=40",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(err) => {
                unload_modules(&modules);
                return Err(format!("could not run pacat: {err}"));
            }
        };
        let Some(pipe) = child.stdin.take() else {
            let _ = child.kill();
            unload_modules(&modules);
            return Err("pacat has no stdin".into());
        };

        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(QUEUE_CHUNKS);
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

        // From here on `Drop` owns the cleanup, so an error path below must
        // only construct and discard.
        let mic = Self {
            feeder: tx,
            child,
            modules,
            dropped,
        };

        if let Err(err) = thread::Builder::new()
            .name("lwfa-mic".into())
            .spawn(move || feed(rx, pipe))
        {
            return Err(format!("could not start the mic feeder: {err}"));
        }

        tracing::info!("virtual microphone plugged in (lwfa_mic)");
        Ok(mic)
    }

    /// Hand one tagged uplink message to the feeder.
    ///
    /// Never blocks: a full queue drops the chunk, which is the deliberate
    /// bound on how far behind the speaker this device can fall.
    pub fn feed(&self, message: &[u8]) {
        match self.feeder.try_send(message.to_vec()) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

impl Drop for Mic {
    fn drop(&mut self) {
        // Killing pacat first closes the pipe under the feeder thread, whose
        // next write fails and ends it; the channel sender dying with `self`
        // covers the case where it was parked in `recv`.
        let _ = self.child.kill();
        let _ = self.child.wait();
        unload_modules(&self.modules);
        let dropped = self.dropped.load(std::sync::atomic::Ordering::Relaxed);
        if dropped > 0 {
            tracing::info!("virtual microphone unplugged; {dropped} chunk(s) dropped under pressure");
        } else {
            tracing::info!("virtual microphone unplugged");
        }
    }
}

/// The feeder: decode each tagged message and play it.
///
/// Owns the Opus decoder because Opus is stateful; packets must be decoded in
/// order by one decoder for the audio to be continuous.
fn feed(rx: Receiver<Vec<u8>>, mut pipe: impl Write) {
    let mut opus = match opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono) {
        Ok(decoder) => Some(decoder),
        Err(err) => {
            // PCM still works; only compressed chunks are lost.
            tracing::warn!("no Opus decoder for the mic ({err}); PCM only");
            None
        }
    };
    let mut pcm = vec![0i16; MAX_FRAME_SAMPLES];

    while let Ok(message) = rx.recv() {
        let Some((&tag, payload)) = message.split_first() else {
            continue;
        };
        let samples: &[i16] = match tag {
            MIC_TAG_OPUS => {
                let Some(decoder) = opus.as_mut() else { continue };
                match decoder.decode(payload, &mut pcm, false) {
                    Ok(count) => &pcm[..count],
                    Err(err) => {
                        tracing::debug!("undecodable mic packet: {err}");
                        continue;
                    }
                }
            }
            MIC_TAG_PCM => {
                // Already the wire format; just realign to samples.
                let count = payload.len() / 2;
                for (i, sample) in pcm.iter_mut().take(count).enumerate() {
                    *sample = i16::from_le_bytes([payload[i * 2], payload[i * 2 + 1]]);
                }
                &pcm[..count]
            }
            _ => continue,
        };

        // i16 to bytes without an extra copy per sample.
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        if let Err(err) = pipe.write_all(&bytes) {
            // pacat is gone. During a normal unplug that is `Drop` killing
            // it; any other time it means the device went deaf mid-call,
            // which must be said out loud rather than swallowed.
            tracing::warn!("mic feeder stopped: {err}");
            return;
        }
    }
}

/// `pactl load-module …`, returning the module index for later unload.
fn load_module(args: &[&str]) -> Result<String, String> {
    let output = Command::new("pactl")
        .arg("load-module")
        .args(args)
        .output()
        .map_err(|err| format!("could not run pactl: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "pactl load-module {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn unload_modules(modules: &[String]) {
    // Reverse order: the remap source depends on the sink.
    for index in modules.iter().rev() {
        let _ = Command::new("pactl")
            .args(["unload-module", index])
            .status();
    }
}
