//! Capturing what the machine is playing, for a remote shell.
//!
//! # What is captured
//!
//! The default sink's monitor: everything you would hear if you were sitting at
//! the machine. Not per application, because there is no reliable link from a
//! Wayland window to the PipeWire node its client is writing to; a browser tab
//! playing a video is one node for the whole browser, and a game's audio thread
//! is not associated with its surface at all. So this is session audio, and the
//! shell presents it as such.
//!
//! That has a privacy consequence worth being deliberate about: it includes
//! sound produced by things that are *not* running in lwfa. Which is why
//! nothing is captured until a connected client asks for it, and why asking is
//! a per-session switch rather than a config file setting somebody turns on
//! once and forgets.
//!
//! # Why a subprocess and not the PipeWire API
//!
//! `parec` is part of the PipeWire install that is already running here, it
//! writes exactly the format needed to stdout, and it costs one pipe. Linking
//! `libpipewire` would mean an FFI dependency, a second event loop to integrate
//! with calloop, and a build that fails on a machine without the development
//! headers, all to arrive at the same bytes. The project already treats ffmpeg
//! the same way for the same reason.
//!
//! The cost is one process and the latency of a pipe, which at a 20ms capture
//! quantum is not the dominant term in a chain that ends with a WebSocket and a
//! browser's audio graph.
//!
//! # Why uncompressed
//!
//! `AudioFormat::Pcm16` has the reasoning. Short version: WebCodecs needs a
//! secure context, so a browser on plain HTTP has no `AudioDecoder`, and Opus
//! it could not play would be worse than PCM it can.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread;

use lwfa_proto::{AudioFormat, AudioHeader};

/// Sample rate, in Hz. Matches what PipeWire runs at here, so nothing resamples.
pub const SAMPLE_RATE: u32 = 48_000;

/// Stereo. Downmixing to mono would halve the bandwidth and lose the one thing
/// that makes a desktop sound like a place rather than a phone call.
pub const CHANNELS: u8 = 2;

/// Bytes per sample frame: 16 bits per channel.
const BYTES_PER_FRAME: usize = 2 * CHANNELS as usize;

/// How much audio is in each chunk sent to the shell.
///
/// 20ms is the usual quantum for interactive audio: small enough that it is
/// well under the threshold where lip sync and key clicks feel detached, large
/// enough that the per-message overhead of a WebSocket frame is negligible
/// against a payload of nearly four kilobytes.
const CHUNK_MS: u32 = 20;

const FRAMES_PER_CHUNK: usize = (SAMPLE_RATE as usize * CHUNK_MS as usize) / 1000;
const BYTES_PER_CHUNK: usize = FRAMES_PER_CHUNK * BYTES_PER_FRAME;

/// One captured chunk, in whichever encodings the listeners currently need.
///
/// Both can be present at once. The fan-out used to compress for everyone or
/// nobody, so one browser without an Opus decoder silently put every other
/// device on raw PCM at 1.5 Mbit/s, and on a congested link that fixed load
/// was what dragged the whole stream down. Now each payload is built exactly
/// when somebody needs it and each client is sent the one it can decode.
pub struct Chunk {
    /// Framed Opus message, when at least one listener decodes Opus.
    pub opus: Option<Vec<u8>>,
    /// Framed PCM message, when at least one listener cannot.
    pub pcm: Option<Vec<u8>>,
}

/// A running capture. Dropping it stops the capture and reaps the process.
pub struct Capture {
    child: Child,
    running: Arc<AtomicBool>,
    /// Whether any listener decodes Opus. Read by the capture thread per chunk.
    wants_opus: Arc<AtomicBool>,
    /// Whether any listener needs raw PCM. Same cadence.
    wants_pcm: Arc<AtomicBool>,
    /// Bits per second for Opus. Read by the capture thread per chunk.
    opus_bitrate: Arc<AtomicI32>,
}

impl Capture {
    /// Which encodings the current listeners need, from the next chunk.
    ///
    /// Takes effect on the next 20ms chunk. Changing it mid-stream is safe:
    /// every chunk says what it is in its own header, so a client sees the
    /// format change and follows it without resynchronising.
    pub fn set_formats(&self, opus: bool, pcm: bool) {
        self.wants_opus.store(opus, Ordering::Relaxed);
        self.wants_pcm.store(pcm, Ordering::Relaxed);
    }

    /// Spend this many bits per second on the sound, from the next chunk.
    ///
    /// Opus changes rate mid-stream without a hiccup: the encoder simply
    /// spends fewer bits on the next frame, and the decoder never needs to be
    /// told. This is what audio quality settings and the adaptive budget pull
    /// on; nothing is rebuilt.
    pub fn set_bitrate(&self, bits: i32) {
        self.opus_bitrate.store(bits, Ordering::Relaxed);
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // Order matters. Clearing the flag first means the reader thread stops
        // publishing before the pipe dies, so a partially read chunk is never
        // sent as a burst of noise.
        self.running.store(false, Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Start capturing, calling `on_chunk` with one encoded audio message at a time.
///
/// `on_chunk` runs on the capture thread, not the compositor's, so it must not
/// touch compositor state. It is given bytes that are already framed and ready
/// to put on a socket.
///
/// Returns `None` if capture could not be started, having said why. A machine
/// with no working audio is a perfectly good machine to run a desktop on, and
/// the session must not fail because nobody can hear it.
pub fn start(
    device: Option<&str>,
    opus: bool,
    pcm: bool,
    on_chunk: impl Fn(Chunk) + Send + 'static,
) -> Option<Capture> {
    let mut command = Command::new("parec");
    command
        .arg("--format=s16le")
        .arg(format!("--rate={SAMPLE_RATE}"))
        .arg(format!("--channels={CHANNELS}"))
        // Ask for a small buffer. Without this `parec` picks a comfortable one
        // for recording to a file, which is exactly the wrong trade here: it
        // would add its own latency on top of everything downstream.
        .arg(format!("--latency-msec={CHUNK_MS}"))
        .stdout(Stdio::piped())
        // Inherited would interleave PulseAudio's warnings into the engine's
        // log with no context. Null, and the exit status carries the failure.
        .stderr(Stdio::null());

    if let Some(device) = device {
        command.arg("-d").arg(device);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            tracing::warn!("could not start audio capture ({err}); the session will be silent");
            return None;
        }
    };

    let Some(mut stdout) = child.stdout.take() else {
        tracing::warn!("audio capture produced no pipe; the session will be silent");
        let _ = child.kill();
        return None;
    };

    let running = Arc::new(AtomicBool::new(true));
    let thread_running = Arc::clone(&running);
    let wants_opus = Arc::new(AtomicBool::new(opus));
    let thread_opus = Arc::clone(&wants_opus);
    let wants_pcm = Arc::new(AtomicBool::new(pcm));
    let thread_pcm = Arc::clone(&wants_pcm);
    let opus_bitrate = Arc::new(AtomicI32::new(OPUS_BITRATE));
    let thread_bitrate = Arc::clone(&opus_bitrate);

    if let Err(err) = thread::Builder::new()
        .name("lwfa-audio".into())
        .spawn(move || {
            let mut buffer = vec![0u8; BYTES_PER_CHUNK];
            // One encoder for the life of the capture. Opus is stateful: it
            // predicts from previous frames, so a fresh encoder per chunk would
            // both cost more bits and lose the continuity that makes it sound
            // like a stream rather than a sequence of clips.
            let mut opus = Opus::new();
            // Reused, because an allocation per 20ms is fifty an hour of pure
            // waste. Opus never exceeds this for one frame at these settings.
            let mut packet = vec![0u8; 4000];
            let mut samples = vec![0i16; FRAMES_PER_CHUNK * CHANNELS as usize];
            let mut applied_bitrate = OPUS_BITRATE;
            // What the last chunk actually carried, so the log announces
            // format changes once rather than fifty times a second. Raw PCM
            // on the wire is a megabit and a half that no bitrate setting can
            // shrink, which is exactly the sort of thing a log must not hide.
            let mut sent = (false, false);

            while thread_running.load(Ordering::Relaxed) {
                // Follow the requested rate. Checked per chunk because that
                // is this thread's natural heartbeat; applying is one setter
                // on the live encoder, no restart.
                let wanted_bitrate = thread_bitrate.load(Ordering::Relaxed);
                if wanted_bitrate != applied_bitrate {
                    opus.set_bitrate(wanted_bitrate);
                    applied_bitrate = wanted_bitrate;
                    // Only meaningful for Opus. PCM has no knob, and logging
                    // a rate that nothing applies to reads as "adapting fine"
                    // while the wire carries 1.5 Mbit/s regardless.
                    if thread_opus.load(Ordering::Relaxed) {
                        tracing::info!("Opus audio is now {} kbit/s", wanted_bitrate / 1000);
                    }
                }
                // Whole chunks only. A short read mid-frame would shift every
                // subsequent sample by a byte and turn the stream into noise
                // permanently, so this fills the buffer or gives up.
                match stdout.read_exact(&mut buffer) {
                    Ok(()) => {}
                    Err(err) => {
                        if thread_running.load(Ordering::Relaxed) {
                            tracing::info!("audio capture ended: {err}");
                        }
                        return;
                    }
                }
                // Each encoding is built exactly when some listener needs it,
                // and both can be needed at once: the fan-out sends every
                // client the one it can decode. See `Chunk`.
                let want_opus = thread_opus.load(Ordering::Relaxed);
                let want_pcm = thread_pcm.load(Ordering::Relaxed);

                let encoded = if want_opus {
                    for (sample, chunk) in samples.iter_mut().zip(buffer.chunks_exact(2)) {
                        *sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                    }
                    // A failed encode should not happen at a fixed rate and
                    // frame size; falling back to PCM below keeps the sound
                    // going rather than dropping it.
                    opus.encode(&samples, &mut packet)
                } else {
                    None
                };

                let chunk = Chunk {
                    opus: encoded.map(|len| frame(AudioFormat::Opus, &packet[..len])),
                    // Also the safety net: an Opus listener with no packet to
                    // send gets PCM this chunk, and the header tells it so.
                    pcm: (want_pcm || (want_opus && encoded.is_none()))
                        .then(|| frame(AudioFormat::Pcm16, &buffer)),
                };

                let sending = (chunk.opus.is_some(), chunk.pcm.is_some());
                if sending != sent {
                    sent = sending;
                    match sending {
                        (true, true) => tracing::info!(
                            "audio is Opus plus raw PCM (1.5 Mbit/s) for a listener that cannot decode Opus"
                        ),
                        (true, false) => tracing::info!(
                            "audio is Opus at {} kbit/s",
                            applied_bitrate / 1000
                        ),
                        (false, true) => tracing::info!(
                            "audio is raw PCM at 1.5 Mbit/s; no listener decodes Opus"
                        ),
                        (false, false) => {}
                    }
                }

                on_chunk(chunk);
            }
        })
    {
        tracing::warn!("could not start the audio thread ({err}); the session will be silent");
        let _ = child.kill();
        return None;
    }

    tracing::info!(
        "capturing audio at {SAMPLE_RATE}Hz, {CHANNELS} channels, {CHUNK_MS}ms chunks{}",
        match device {
            Some(device) => format!(" from {device}"),
            None => " from the default sink".to_string(),
        }
    );
    Some(Capture {
        child,
        running,
        wants_opus,
        wants_pcm,
        opus_bitrate,
    })
}

/// One payload, framed and ready for a socket.
fn frame(format: AudioFormat, payload: &[u8]) -> Vec<u8> {
    AudioHeader {
        format,
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        frames: FRAMES_PER_CHUNK as u32,
    }
    .encode_with_payload(payload)
}

/// An Opus encoder for this capture's fixed format.
///
/// Wrapped so the rest of the file does not care whether libopus is present:
/// if it cannot be created the encoder simply never produces a packet and the
/// stream stays PCM, which is worse over cellular and perfectly fine.
struct Opus {
    encoder: Option<opus::Encoder>,
}

impl Opus {
    fn new() -> Self {
        let channels = if CHANNELS == 1 {
            opus::Channels::Mono
        } else {
            opus::Channels::Stereo
        };
        // `Audio` rather than `Voip`: this carries music and interface sounds,
        // not speech, and the voice modes trade fidelity for intelligibility.
        match opus::Encoder::new(SAMPLE_RATE, channels, opus::Application::Audio) {
            Ok(mut encoder) => {
                // 128 kbit/s stereo is transparent for desktop audio, and is
                // still a twelfth of the 1.5 Mbit/s the raw stream costs.
                let _ = encoder.set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE));
                Self { encoder: Some(encoder) }
            }
            Err(err) => {
                tracing::warn!("no Opus encoder ({err}); audio stays uncompressed");
                Self { encoder: None }
            }
        }
    }

    /// Change the rate mid-stream. Harmless when there is no encoder.
    fn set_bitrate(&mut self, bits: i32) {
        if let Some(encoder) = self.encoder.as_mut() {
            let _ = encoder.set_bitrate(opus::Bitrate::Bits(bits));
        }
    }

    /// Encode one 20ms frame. `None` means the caller should send raw PCM.
    fn encode(&mut self, samples: &[i16], out: &mut [u8]) -> Option<usize> {
        let encoder = self.encoder.as_mut()?;
        match encoder.encode(samples, out) {
            Ok(len) if len > 0 => Some(len),
            Ok(_) => None,
            Err(err) => {
                tracing::warn!("Opus encode failed ({err}); sending this chunk raw");
                None
            }
        }
    }
}

/// Bits per second for Opus. See `Opus::new`.
const OPUS_BITRATE: i32 = 128_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_is_exactly_the_advertised_length() {
        // The reader fills a fixed buffer and declares its length in the
        // header. If those two disagree the browser plays part of the next
        // chunk as the tail of this one, forever.
        assert_eq!(BYTES_PER_CHUNK, FRAMES_PER_CHUNK * BYTES_PER_FRAME);
        assert_eq!(FRAMES_PER_CHUNK, 960); // 20ms at 48kHz
        assert_eq!(BYTES_PER_CHUNK, 3840);
    }

    #[test]
    fn the_wire_size_is_what_the_bandwidth_note_claims() {
        // 1.5 Mbit/s, quoted in the format's documentation and in the UI.
        let bytes_per_second = SAMPLE_RATE as usize * BYTES_PER_FRAME;
        assert_eq!(bytes_per_second * 8, 1_536_000);
    }
}
