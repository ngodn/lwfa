//! A private audio device for the session.
//!
//! # Why not just capture the speakers
//!
//! Capturing the default sink's monitor was the first implementation and it is
//! wrong in two ways at once. It sends the *machine's* audio rather than the
//! session's, so a remote listener hears everything happening on the desk,
//! including things that have nothing to do with lwfa. And it leaves the sound
//! playing out of the speakers, which is exactly what you do not want when the
//! reason you are streaming it is that you are somewhere else.
//!
//! So the session gets a sink of its own: a null device that goes nowhere.
//! Applications lwfa starts are pointed at it, its monitor is what gets
//! captured, and the machine stays quiet.
//!
//! Playing on the machine as well is then an explicit choice rather than an
//! unavoidable side effect: a loopback from that monitor back to the real
//! output, loaded on request. Off by default, because the common case is that
//! you are not in the room.
//!
//! # Why `pactl` and not the PipeWire API
//!
//! Same reasoning as `audio.rs`: these are three one-shot commands run when a
//! setting changes, not a hot path. Linking `libpipewire` to issue them would
//! be a dependency and an event loop for something a subprocess does in a
//! millisecond.

use std::process::Command;

/// The sink's name, and the value of `PULSE_SINK` for applications.
pub const SINK_NAME: &str = "lwfa";

/// What to capture: everything written to that sink.
pub const MONITOR: &str = "lwfa.monitor";

/// Owns the modules for as long as the session wants them.
#[derive(Default)]
pub struct PrivateSink {
    /// Module id of the null sink, if this process created it.
    sink: Option<String>,
    /// Module id of the loopback to the real output, when playing locally.
    loopback: Option<String>,
}

impl PrivateSink {
    /// Create the sink if it is not already there.
    ///
    /// Idempotent, and deliberately tolerant: if the sink already exists
    /// because a previous run left it behind, that is reused rather than
    /// duplicated, and this process does not claim ownership of something it
    /// did not create.
    pub fn ensure(&mut self) -> bool {
        if self.sink.is_some() || exists(MONITOR) {
            return true;
        }
        match run(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={SINK_NAME}"),
            &format!("sink_properties=device.description={SINK_NAME}"),
        ]) {
            Some(id) => {
                tracing::info!("created the {SINK_NAME} audio sink; the machine stays silent");
                self.sink = Some(id);
                true
            }
            None => {
                tracing::warn!(
                    "could not create a private audio sink; falling back to the default output, \
                     which means the machine will also play what it streams"
                );
                false
            }
        }
    }

    /// Also play through the machine's own speakers, or stop doing so.
    pub fn set_local_playback(&mut self, enabled: bool) {
        if enabled == self.loopback.is_some() {
            return;
        }
        if !enabled {
            if let Some(id) = self.loopback.take() {
                run(&["unload-module", &id]);
                tracing::info!("stopped playing session audio on this machine");
            }
            return;
        }

        let Some(sink) = default_sink() else {
            tracing::warn!("no default audio output; cannot also play locally");
            return;
        };
        // A short latency, because this is monitoring rather than playback:
        // hearing the machine a quarter of a second behind the picture is
        // worse than not hearing it.
        match run(&[
            "load-module",
            "module-loopback",
            &format!("source={MONITOR}"),
            &format!("sink={sink}"),
            "latency_msec=20",
        ]) {
            Some(id) => {
                tracing::info!("also playing session audio on this machine");
                self.loopback = Some(id);
            }
            None => tracing::warn!("could not start local playback"),
        }
    }

    /// Whether applications should be pointed at the private sink.
    pub fn available(&self) -> bool {
        self.sink.is_some() || exists(MONITOR)
    }
}

impl Drop for PrivateSink {
    /// Take back only what this process added.
    ///
    /// A sink left over from an earlier run is left alone: unloading it would
    /// break whatever is still playing into it.
    fn drop(&mut self) {
        if let Some(id) = self.loopback.take() {
            run(&["unload-module", &id]);
        }
        if let Some(id) = self.sink.take() {
            run(&["unload-module", &id]);
        }
    }
}

fn exists(source: &str) -> bool {
    Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(source))
        .unwrap_or(false)
}

fn default_sink() -> Option<String> {
    let out = Command::new("pactl").arg("get-default-sink").output().ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Run `pactl` and return its stdout, which for `load-module` is the module id.
fn run(args: &[&str]) -> Option<String> {
    let out = Command::new("pactl").args(args).output().ok()?;
    if !out.status.success() {
        tracing::debug!(
            "pactl {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!id.is_empty()).then_some(id)
}
