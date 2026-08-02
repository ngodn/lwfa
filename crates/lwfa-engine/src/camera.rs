//! The client's camera, plugged into the machine.
//!
//! # What this creates
//!
//! A machine-visible camera. Anything on the desktop that asks for one (a
//! meeting in a browser, a capture tool) can select it, and what it shows is
//! whatever the connected client's camera sees. Like the microphone
//! (`mic.rs`), it exists only while a session is actually feeding it.
//!
//! # How the frames travel and land
//!
//! The shell encodes H.264 in Annex-B form, one frame per tagged binary
//! message (see [`lwfa_proto::CAM_TAG`]). Here they are piped into a
//! GStreamer subprocess that parses, decodes, and hands raw video to one of
//! two sinks:
//!
//! - **v4l2loopback**, when a loopback device exists: `/dev/video*` is what
//!   Chromium (and therefore Meet in Chrome) enumerates, so it is preferred
//!   whenever the user has the module loaded.
//! - **PipeWire** otherwise, as a `Video/Source` node: no kernel module
//!   needed, and Firefox and PipeWire-native apps see it directly.
//!
//! A subprocess for the same reason `pacat` and `parec` are: `gst-launch`
//! is already on any machine with PipeWire's GStreamer plugins, it turns a
//! byte stream on stdin into a camera with one command line, and it dies
//! with us.
//!
//! # Latency and loss
//!
//! Same policy as the microphone: a bounded queue between the socket thread
//! and the pipe, drop-newest under pressure. A camera a second behind the
//! face in front of it is broken in a way a skipped frame is not.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::thread;

/// Bounded backlog, in frames. At 30fps this is a fifth of a second.
const QUEUE_FRAMES: usize = 6;

/// A running virtual camera. Dropping it unplugs the device.
pub struct Camera {
    feeder: SyncSender<Vec<u8>>,
    child: Child,
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl Camera {
    /// Create the device and start the feeder.
    pub fn start() -> Result<Self, String> {
        let sink = pick_sink()?;
        let pipeline: Vec<String> = match &sink {
            Sink::V4l2(device) => {
                tracing::info!("virtual camera will use {device} (v4l2loopback)");
                [
                    "fdsrc", "fd=0", "!", "h264parse", "!", "avdec_h264", "!",
                    "videoconvert", "!", "video/x-raw,format=YUY2", "!", "v4l2sink",
                ]
                .iter()
                .map(ToString::to_string)
                .chain([format!("device={device}"), "sync=false".to_string()])
                .collect()
            }
            Sink::PipeWire => {
                tracing::info!("virtual camera will be a PipeWire node (no v4l2loopback found)");
                [
                    "fdsrc", "fd=0", "!", "h264parse", "!", "avdec_h264", "!",
                    "videoconvert", "!", "pipewiresink", "mode=provide",
                    "client-name=lwfa-camera",
                    "stream-properties=props,media.class=Video/Source,node.name=lwfa-camera,node.description=lwfa-Camera",
                    "sync=false",
                ]
                .iter()
                .map(ToString::to_string)
                .collect()
            }
        };

        let mut child = Command::new("gst-launch-1.0")
            .args(&pipeline)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("could not run gst-launch-1.0: {err}"))?;
        let Some(pipe) = child.stdin.take() else {
            let _ = child.kill();
            return Err("gst-launch has no stdin".into());
        };

        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(QUEUE_FRAMES);
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

        let camera = Self {
            feeder: tx,
            child,
            dropped,
        };

        if let Err(err) = thread::Builder::new()
            .name("lwfa-camera".into())
            .spawn(move || feed(rx, pipe))
        {
            return Err(format!("could not start the camera feeder: {err}"));
        }

        tracing::info!("virtual camera plugged in");
        Ok(camera)
    }

    /// Hand one Annex-B frame (tag already stripped) to the feeder.
    pub fn feed(&self, frame: &[u8]) {
        match self.feeder.try_send(frame.to_vec()) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let dropped = self.dropped.load(std::sync::atomic::Ordering::Relaxed);
        if dropped > 0 {
            tracing::info!("virtual camera unplugged; {dropped} frame(s) dropped under pressure");
        } else {
            tracing::info!("virtual camera unplugged");
        }
    }
}

enum Sink {
    V4l2(String),
    PipeWire,
}

/// Prefer a v4l2loopback device (Chromium sees those); else PipeWire.
fn pick_sink() -> Result<Sink, String> {
    let virtuals = std::path::Path::new("/sys/devices/virtual/video4linux");
    if let Ok(entries) = std::fs::read_dir(virtuals) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("video") {
                return Ok(Sink::V4l2(format!("/dev/{name}")));
            }
        }
    }
    Ok(Sink::PipeWire)
}

fn feed(rx: Receiver<Vec<u8>>, mut pipe: impl Write) {
    while let Ok(frame) = rx.recv() {
        if let Err(err) = pipe.write_all(&frame) {
            tracing::warn!("camera feeder stopped: {err}");
            return;
        }
    }
}
