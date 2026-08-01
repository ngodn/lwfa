//! Hardware H.264 encoding, one session per window.
//!
//! Replaces the JPEG stopgap. Measured on the dev machine's RTX 3060 at
//! 631x1366: **3.7 KB per frame against JPEG's 30.5 KB**, and 0.80ms of
//! encode against several milliseconds of software JPEG on the CPU. That is
//! roughly 1.8 Mbps per busy window instead of 15, which is the difference
//! between "works on a LAN" and "works on a phone".
//!
//! The win comes from inter-frame prediction: an idle window costs almost
//! nothing, where JPEG re-compresses the whole image every time.
//!
//! # Why ffmpeg and not the NVENC SDK directly
//!
//! `nvidia-video-codec-sdk` would allow feeding NVENC straight from a GPU
//! texture, which is where this should eventually go. It is not usable here:
//! its `cudarc` dependency hard-panics at build time on CUDA 13.3, which is
//! what this machine has. ffmpeg 8.1 exposes the same encoder, tracks CUDA
//! versions itself, and its Rust bindings match the installed version exactly.
//!
//! The cost of that choice is one GPU-to-CPU readback per captured frame,
//! which `capture.rs` already does. Removing it needs CUDA/GL interop and is
//! the obvious next optimisation, not a redesign: only this module changes.
//!
//! # Session limits
//!
//! Consumer NVIDIA cards cap concurrent NVENC sessions (8 on this GPU). A
//! ninth streaming window must degrade rather than go blank, so
//! [`Encoders`] falls back to JPEG when a session cannot be created. That is
//! why `FrameFormat` is on the wire per frame rather than negotiated once.

use std::collections::HashMap;

use ff::format::Pixel;
use ff::software::scaling;
use ffmpeg_next as ff;
use lwfa_proto::{FrameFormat, WindowId};

use crate::capture::CapturedFrame;

/// Matches the documented NVENC concurrent session limit on consumer cards.
///
/// NVIDIA raised this from 3 to 5 in March 2023 and 5 to 8 in early 2024. It
/// is a driver-enforced ceiling, not a guess, but creating a session can still
/// fail for other reasons, so the fallback does not rely on this number being
/// right.
const MAX_SESSIONS: usize = 8;

/// Keyframe interval. Also the worst-case wait before a newly attached browser
/// can start decoding, so it trades startup latency against bandwidth.
const GOP: u32 = 120;

/// An encoded frame ready for the wire.
pub struct EncodedFrame {
    pub format: FrameFormat,
    pub keyframe: bool,
    pub bytes: Vec<u8>,
}

struct Session {
    encoder: ff::encoder::video::Encoder,
    scaler: scaling::Context,
    nv12: ff::frame::Video,
    width: u32,
    height: u32,
    pts: i64,
    /// Set when a client attaches, to force an IDR on the next frame.
    force_keyframe: bool,
}

/// Per-window encoders, with a JPEG fallback when hardware sessions run out.
pub struct Encoders {
    sessions: HashMap<WindowId, Session>,
    /// Windows that failed to get a hardware session. Tracked so the failure is
    /// logged once rather than every frame.
    fallback: HashMap<WindowId, ()>,
    available: bool,
}

impl Default for Encoders {
    fn default() -> Self {
        Self::new()
    }
}

impl Encoders {
    pub fn new() -> Self {
        let available = match ff::init() {
            Ok(()) => {
                let found = ff::encoder::find_by_name(ENCODER_NAME).is_some();
                if !found {
                    tracing::warn!(
                        "{ENCODER_NAME} not available in this ffmpeg build; falling back to JPEG"
                    );
                }
                found
            }
            Err(err) => {
                tracing::warn!("could not initialise ffmpeg ({err}); falling back to JPEG");
                false
            }
        };

        Self {
            sessions: HashMap::new(),
            fallback: HashMap::new(),
            available,
        }
    }

    pub fn forget(&mut self, id: WindowId) {
        self.sessions.remove(&id);
        self.fallback.remove(&id);
    }

    /// Request an IDR on every stream's next frame.
    ///
    /// Called when a shell connects. Without this, a browser attaching between
    /// keyframes waits up to [`GOP`] frames before anything appears.
    pub fn request_keyframes(&mut self) {
        for session in self.sessions.values_mut() {
            session.force_keyframe = true;
        }
    }

    /// Encode a captured frame, falling back to JPEG if hardware is unavailable.
    pub fn encode(&mut self, frame: &CapturedFrame) -> Option<EncodedFrame> {
        if self.available && self.ensure_session(frame) {
            if let Some(encoded) = self.encode_h264(frame) {
                return Some(encoded);
            }
            // A session that fails mid-stream is dropped so the next frame
            // either rebuilds it or falls back cleanly.
            tracing::warn!("h264 encode failed for {}; dropping the session", frame.id);
            self.sessions.remove(&frame.id);
        }

        Some(EncodedFrame {
            format: FrameFormat::Jpeg,
            keyframe: true,
            bytes: frame.to_jpeg(JPEG_QUALITY)?,
        })
    }

    /// True when a usable session exists for this frame's size.
    fn ensure_session(&mut self, frame: &CapturedFrame) -> bool {
        if let Some(session) = self.sessions.get(&frame.id) {
            if session.width == frame.width && session.height == frame.height {
                return true;
            }
            // Resized. H.264 cannot change resolution mid-stream, so the
            // session is rebuilt and the next frame is an IDR.
            self.sessions.remove(&frame.id);
        }

        if self.sessions.len() >= MAX_SESSIONS {
            if self.fallback.insert(frame.id, ()).is_none() {
                tracing::warn!(
                    "NVENC session limit ({MAX_SESSIONS}) reached; {} falls back to JPEG",
                    frame.id
                );
            }
            return false;
        }

        match Session::new(frame.width, frame.height) {
            Ok(session) => {
                self.fallback.remove(&frame.id);
                self.sessions.insert(frame.id, session);
                tracing::info!(
                    "opened an h264 session for {} ({}x{}), {} of {MAX_SESSIONS} in use",
                    frame.id,
                    frame.width,
                    frame.height,
                    self.sessions.len()
                );
                true
            }
            Err(err) => {
                if self.fallback.insert(frame.id, ()).is_none() {
                    tracing::warn!("could not open an h264 session for {}: {err}", frame.id);
                }
                false
            }
        }
    }

    fn encode_h264(&mut self, frame: &CapturedFrame) -> Option<EncodedFrame> {
        let session = self.sessions.get_mut(&frame.id)?;
        session.encode(&frame.rgba)
    }
}

const ENCODER_NAME: &str = "h264_nvenc";
const JPEG_QUALITY: u8 = 70;

impl Session {
    fn new(width: u32, height: u32) -> Result<Self, ff::Error> {
        let codec = ff::encoder::find_by_name(ENCODER_NAME).ok_or(ff::Error::EncoderNotFound)?;
        let ctx = ff::codec::context::Context::new_with_codec(codec);
        let mut enc = ctx.encoder().video()?;

        enc.set_width(width);
        enc.set_height(height);
        enc.set_format(Pixel::NV12);
        enc.set_time_base(ff::Rational(1, 60));
        enc.set_gop(GOP);
        // No B-frames: they reorder output, which adds latency for no benefit
        // on an interactive stream.
        enc.set_max_b_frames(0);
        enc.set_bit_rate(4_000_000);

        let mut opts = ff::Dictionary::new();
        opts.set("preset", "p1"); // fastest
        opts.set("tune", "ull"); // ultra low latency
        opts.set("zerolatency", "1");
        opts.set("delay", "0");
        // Repeat SPS/PPS on every keyframe so a browser attaching mid-stream
        // can configure its decoder from the stream itself.
        opts.set("repeat_headers", "1");
        // Make a forced keyframe an actual IDR.
        //
        // Without this, setting `pict_type = I` produces an I-frame, and an
        // I-frame is not an IDR: it carries no SPS/PPS and does not reset the
        // reference chain. A browser attaching mid-stream then receives a
        // stream starting with an SEI NAL, has nothing to configure a decoder
        // from, and shows the window blank forever. NVENC ignores the request
        // entirely unless this is set.
        opts.set("forced-idr", "1");

        let encoder = enc.open_with(opts)?;

        let scaler = scaling::Context::get(
            Pixel::RGBA,
            width,
            height,
            Pixel::NV12,
            width,
            height,
            // FAST_BILINEAR: this is a 1:1 colour conversion, not a rescale,
            // so filter quality is irrelevant and speed is not.
            scaling::Flags::FAST_BILINEAR,
        )?;

        Ok(Self {
            encoder,
            scaler,
            nv12: ff::frame::Video::new(Pixel::NV12, width, height),
            width,
            height,
            pts: 0,
            force_keyframe: true,
        })
    }

    fn encode(&mut self, rgba: &[u8]) -> Option<EncodedFrame> {
        let mut source = ff::frame::Video::new(Pixel::RGBA, self.width, self.height);
        copy_rows(rgba, &mut source, self.width, self.height);

        self.scaler.run(&source, &mut self.nv12).ok()?;
        self.nv12.set_pts(Some(self.pts));
        if self.force_keyframe {
            self.nv12.set_kind(ff::picture::Type::I);
            self.force_keyframe = false;
        } else {
            self.nv12.set_kind(ff::picture::Type::None);
        }
        self.pts += 1;

        self.encoder.send_frame(&self.nv12).ok()?;

        // The encoder may emit several packets, or none. Concatenating is
        // correct for Annex B, where packets are just NAL units in order.
        let mut bytes = Vec::new();
        let mut keyframe = false;
        let mut packet = ff::Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            if let Some(data) = packet.data() {
                bytes.extend_from_slice(data);
            }
            keyframe |= packet.is_key();
        }

        if bytes.is_empty() {
            // Encoder is buffering. Not an error; the next frame will produce
            // output.
            return None;
        }

        Some(EncodedFrame {
            format: FrameFormat::H264,
            keyframe,
            bytes,
        })
    }
}

/// Copy tightly-packed RGBA into an ffmpeg frame, honouring its stride.
///
/// ffmpeg aligns each row, so the destination stride is usually wider than
/// `width * 4`. Copying the buffer wholesale would shear the image.
fn copy_rows(rgba: &[u8], frame: &mut ff::frame::Video, width: u32, height: u32) {
    let stride = frame.stride(0);
    let row_bytes = width as usize * 4;
    let dst = frame.data_mut(0);
    for y in 0..height as usize {
        let src_start = y * row_bytes;
        let dst_start = y * stride;
        let Some(src) = rgba.get(src_start..src_start + row_bytes) else {
            break;
        };
        let Some(dst_row) = dst.get_mut(dst_start..dst_start + row_bytes) else {
            break;
        };
        dst_row.copy_from_slice(src);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32) -> CapturedFrame {
        CapturedFrame {
            id: WindowId(1),
            width,
            height,
            // A gradient rather than flat colour, so a stride bug shears
            // visibly instead of being hidden by uniform pixels.
            rgba: (0..width as usize * height as usize)
                .flat_map(|i| {
                    let x = (i % width as usize) as u8;
                    let y = (i / width as usize) as u8;
                    [x, y, x.wrapping_add(y), 255]
                })
                .collect(),
        }
    }

    #[test]
    fn copy_rows_respects_a_wider_destination_stride() {
        // The bug this guards against shears the image diagonally, which is
        // easy to mistake for a capture problem three layers away.
        ff::init().ok();
        let width = 7; // deliberately not a multiple of any alignment
        let height = 4;
        let src = frame(width, height);
        let mut dst = ff::frame::Video::new(Pixel::RGBA, width, height);

        copy_rows(&src.rgba, &mut dst, width, height);

        let stride = dst.stride(0);
        let row_bytes = width as usize * 4;
        for y in 0..height as usize {
            let expected = &src.rgba[y * row_bytes..(y + 1) * row_bytes];
            let actual = &dst.data(0)[y * stride..y * stride + row_bytes];
            assert_eq!(actual, expected, "row {y} differs");
        }
    }

    #[test]
    fn encoders_report_availability_without_panicking() {
        // Must not panic on a machine with no NVENC; it should just fall back.
        let encoders = Encoders::new();
        // Either outcome is valid depending on the host; what matters is that
        // construction succeeded.
        let _ = encoders.available;
    }

    #[test]
    fn falls_back_to_jpeg_when_hardware_is_unavailable() {
        let mut encoders = Encoders::new();
        encoders.available = false;
        let encoded = encoders
            .encode(&frame(64, 64))
            .expect("should still encode");
        assert_eq!(encoded.format, FrameFormat::Jpeg);
        assert!(encoded.keyframe, "jpeg is always self-contained");
        assert!(encoded.bytes.starts_with(&[0xff, 0xd8]), "should be a JPEG");
    }

    #[test]
    fn forgetting_a_window_drops_its_session() {
        let mut encoders = Encoders::new();
        encoders.fallback.insert(WindowId(1), ());
        encoders.forget(WindowId(1));
        assert!(encoders.fallback.is_empty());
        assert!(encoders.sessions.is_empty());
    }
}

// ---------------------------------------------------------------------------
// Running the encoder off the render loop
// ---------------------------------------------------------------------------

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::thread;

use crate::shell::FrameSink;

/// How many captured frames may wait to be encoded.
///
/// Small on purpose. A backlog here is latency the user sees as the remote view
/// lagging behind reality, and for an interactive desktop a fresh frame is worth
/// more than a complete history. Dropping is the correct response to a
/// consumer that cannot keep up.
const QUEUE_DEPTH: usize = 2;

/// Encoding, moved onto its own thread.
///
/// # Why this exists
///
/// Measured on this machine, capture and read-back cost about 1ms per window,
/// but *opening* an NVENC session costs **90-160ms**. A session has to be
/// rebuilt whenever a window resizes, because H.264 cannot change resolution
/// mid-stream, and windows resize whenever the layout changes.
///
/// With encoding inline that stall lands squarely in the render loop: up to
/// eight dropped frames every time you change a column width or switch
/// workspace. Off the render loop it stalls only this thread, and the
/// compositor keeps painting.
///
/// That measurement is also why zero-copy capture is not the priority it looked
/// like. Removing the read-back would save around a millisecond; this saves two
/// orders of magnitude more.
pub struct EncodeWorker {
    frames: SyncSender<Job>,
    /// Signals sent alongside frames, so ordering with them is preserved.
    control: SyncSender<Control>,
    /// Frames submitted but not yet encoded.
    ///
    /// `SyncSender` exposes no depth, and `try_send` is the only real test, but
    /// knowing the queue is backed up lets the caller skip capturing at all
    /// rather than doing GPU work and then throwing it away.
    queued: Arc<AtomicUsize>,
}

struct Job {
    frame: CapturedFrame,
}

enum Control {
    Forget(WindowId),
    RequestKeyframes,
}

impl EncodeWorker {
    pub fn spawn(sink: FrameSink) -> std::io::Result<Self> {
        let (frames_tx, frames_rx) = sync_channel::<Job>(QUEUE_DEPTH);
        let (control_tx, control_rx) = sync_channel::<Control>(16);
        let queued = Arc::new(AtomicUsize::new(0));
        let worker_queued = Arc::clone(&queued);

        thread::Builder::new()
            .name("lwfa-encode".into())
            .spawn(move || {
                let mut encoders = Encoders::new();
                loop {
                    // Control first, so a "forget" cannot be overtaken by a
                    // frame for a window that has just closed.
                    while let Ok(message) = control_rx.try_recv() {
                        match message {
                            Control::Forget(id) => encoders.forget(id),
                            Control::RequestKeyframes => encoders.request_keyframes(),
                        }
                    }

                    let Ok(job) = frames_rx.recv() else {
                        return; // compositor is gone
                    };
                    worker_queued.fetch_sub(1, Ordering::Relaxed);

                    let Some(encoded) = encoders.encode(&job.frame) else {
                        continue;
                    };

                    let header = lwfa_proto::FrameHeader {
                        window: job.frame.id,
                        width: job.frame.width,
                        height: job.frame.height,
                        format: encoded.format,
                        keyframe: encoded.keyframe,
                    };
                    sink.send_frame(header.encode_with_payload(&encoded.bytes));
                }
            })?;

        Ok(Self {
            frames: frames_tx,
            control: control_tx,
            queued,
        })
    }

    /// Queue a frame, or drop it if the encoder is behind.
    ///
    /// Returns false when dropped, so the caller can leave the capture's damage
    /// state untouched and try again next frame rather than losing the update.
    pub fn submit(&self, frame: CapturedFrame) -> bool {
        self.queued.fetch_add(1, Ordering::Relaxed);
        match self.frames.try_send(Job { frame }) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.queued.fetch_sub(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Room for another frame without blocking.
    pub fn has_capacity(&self) -> bool {
        self.queued.load(Ordering::Relaxed) < QUEUE_DEPTH
    }

    pub fn forget(&self, id: WindowId) {
        let _ = self.control.try_send(Control::Forget(id));
    }

    pub fn request_keyframes(&self) {
        let _ = self.control.try_send(Control::RequestKeyframes);
    }
}
