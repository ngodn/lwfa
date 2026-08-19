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
use ffmpeg_next as ff;
use lwfa_proto::{FrameFormat, WindowId};

use crate::capture::CapturedFrame;

// `max_h264_sessions`, `gop` and `jpeg_quality` live in `[stream]` of
// `configs/defaults.toml`. The session limit in particular is a property of the
// card rather than of this code: NVIDIA raised the consumer ceiling from 3 to 5
// in March 2023 and 5 to 8 in early 2024, and a workstation card allows more.
// It is driver-enforced rather than a guess, but a session can still fail to
// open for other reasons, so the JPEG fallback does not trust the number.

/// An encoded frame ready for the wire.
pub struct EncodedFrame {
    pub format: FrameFormat,
    pub keyframe: bool,
    pub bytes: Vec<u8>,
}

struct Session {
    /// Which codec this session encodes, so frames can be labelled.
    codec: lwfa_proto::Codec,
    /// The rate it was built with, so a changed share can be noticed.
    bitrate: u32,
    encoder: ff::encoder::video::Encoder,
    width: u32,
    height: u32,
    pts: i64,
    /// Set when a client attaches, to force an IDR on the next frame.
    force_keyframe: bool,
}

/// Per-window encoders, with a JPEG fallback when hardware sessions run out.
pub struct Encoders {
    config: crate::config::Stream,
    sessions: HashMap<WindowId, Session>,
    /// Windows that failed to get a hardware session. Tracked so the failure is
    /// logged once rather than every frame.
    fallback: HashMap<WindowId, ()>,
    /// Sessions whose window stopped being streamed, and when it stopped.
    ///
    /// Their sessions are still in `sessions`; this is the list of which ones
    /// may be taken when a slot is needed. See [`Encoders::retire`].
    retired: HashMap<WindowId, std::time::Instant>,
    available: bool,
    /// Whether the connected client can decode H.264 at all.
    ///
    /// A browser reached over plain HTTP has no WebCodecs `VideoDecoder`,
    /// because that API is gated on a secure context. Sending it H.264 produces
    /// a permanently blank window, so it gets JPEG instead.
    /// What the clients can decode, or `None` for JPEG. See `codec_for_all`.
    codec: Option<lwfa_proto::Codec>,
    /// Bits per second for each window, from the budget. See `bitrate`.
    rates: std::collections::HashMap<WindowId, u32>,
    /// What a window with no allocation yet gets.
    fallback_rate: u32,
}

impl Default for Encoders {
    fn default() -> Self {
        Self::new(crate::config::Stream::default())
    }
}

impl Encoders {
    pub fn new(config: crate::config::Stream) -> Self {
        let available = match ff::init() {
            Ok(()) => {
                // Any hardware encoder at all is enough to be "available";
                // which one gets used depends on what the clients can decode
                // and is decided per session. A build with H.264 but not HEVC
                // is a real configuration, and it should stream rather than
                // fall back to JPEG for want of the better codec.
                let usable: Vec<&str> = lwfa_proto::Codec::ALL
                    .into_iter()
                    .map(encoder_name)
                    .filter(|name| ff::encoder::find_by_name(name).is_some())
                    .collect();
                if usable.is_empty() {
                    tracing::warn!("no hardware encoder in this ffmpeg build; falling back to JPEG");
                } else {
                    tracing::info!("hardware encoders available: {}", usable.join(", "));
                }
                !usable.is_empty()
            }
            Err(err) => {
                tracing::warn!("could not initialise ffmpeg ({err}); falling back to JPEG");
                false
            }
        };

        Self {
            config,
            sessions: HashMap::new(),
            fallback: HashMap::new(),
            retired: HashMap::new(),
            available,
            codec: Some(lwfa_proto::Codec::H264),
            rates: std::collections::HashMap::new(),
            fallback_rate: crate::bitrate::STEPS[3],
        }
    }

    /// Drop a window's session for good. Its window is gone.
    pub fn forget(&mut self, id: WindowId) {
        self.sessions.remove(&id);
        self.fallback.remove(&id);
        self.retired.remove(&id);
    }

    /// Stop streaming a window without throwing its encoder away.
    ///
    /// A window scrolled out of view is not a window that has gone. Usually it
    /// is the same one that scrolls back a few seconds later, and rebuilding
    /// its session costs the 90-160ms this module exists to keep off the render
    /// loop, plus a keyframe on a link that is being rate-controlled, which is
    /// the largest frame there is arriving at the worst possible moment.
    ///
    /// Measured over one day of real use: 47 of 113 session builds were a
    /// window returning at exactly the size it left at. Every one of them was
    /// this.
    ///
    /// The session cannot be kept forever, because the card caps how many can
    /// exist at once. It is kept until the slot is actually wanted, which is
    /// strictly better than a timer: nothing is rebuilt speculatively, and
    /// whatever the wait cost, it is the same rebuild either way. See
    /// [`Encoders::reclaim_a_slot`].
    pub fn retire(&mut self, id: WindowId, now: std::time::Instant) {
        self.fallback.remove(&id);
        // Recorded whether or not there is a session to keep. An id naming
        // nothing costs one skipped entry when a slot is next wanted, where
        // checking here would put the same question in two places and let them
        // disagree.
        self.retired.insert(id, now);
    }

    /// Free a session slot by dropping whichever retired window left longest ago.
    ///
    /// Never at the expense of a window streaming now: only sessions already
    /// retired are eligible. Among those, the one out of view longest is the
    /// one least likely to come back, and rebuilding it later costs exactly
    /// what rebuilding it now would.
    fn reclaim_a_slot(&mut self) -> bool {
        while let Some(oldest) = out_of_view_longest(&self.retired) {
            self.retired.remove(&oldest);
            // A retired id whose session has since gone (a codec change, a new
            // share of the budget) frees nothing, so keep looking.
            if self.sessions.remove(&oldest).is_some() {
                return true;
            }
        }
        false
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

    /// Tell the encoders which codec every client can decode.
    ///
    /// Dropping the sessions on a change matters: a client cannot be left
    /// holding a stream in a codec it will never render, and a client that has
    /// just arrived needs a fresh session with an IDR rather than resuming
    /// mid-GOP in a codec that has changed underneath it.
    /// Set each window's share of the budget.
    ///
    /// A session's rate is fixed when it is created, and `ffmpeg-next` exposes
    /// no way to reconfigure one, so a change means rebuilding that window's
    /// session and paying a keyframe for it. NVENC itself can reconfigure on
    /// the fly; the binding cannot ask it to.
    ///
    /// So only the windows whose share genuinely moved are rebuilt, and only
    /// when it moved by more than a quarter. Without that, one window opening
    /// shifts every other window's share by a few percent and rebuilds all of
    /// them for no visible gain.
    pub fn set_rates(&mut self, rates: std::collections::HashMap<WindowId, u32>, fallback: u32) {
        self.fallback_rate = fallback;

        let mut rebuilt = 0;
        for (id, rate) in &rates {
            let current = self.sessions.get(id).map(|s| s.bitrate);
            if current.is_some_and(|current| worth_rebuilding(current, *rate)) {
                self.sessions.remove(id);
                rebuilt += 1;
            }
        }
        if rebuilt > 0 {
            tracing::debug!("re-encoding {rebuilt} window(s) at a new share of the budget");
        }
        self.rates = rates;
    }

    /// What this window should be encoded at.
    fn rate_for(&self, id: WindowId) -> u32 {
        self.rates.get(&id).copied().unwrap_or(self.fallback_rate)
    }

    pub fn set_codec(&mut self, codec: Option<lwfa_proto::Codec>) {
        if self.codec != codec {
            match codec {
                Some(codec) => tracing::info!("encoding as {}", encoder_name(codec)),
                None => tracing::info!("no codec every client can decode; falling back to JPEG"),
            }
            self.codec = codec;
            self.sessions.clear();
            self.retired.clear();
        }
    }

    /// Encode a captured frame, falling back to JPEG if hardware is unavailable
    /// or the client cannot decode it.
    ///
    /// `&mut` because the frame's pts and picture type are stamped in place;
    /// the pixels themselves are read, not written.
    pub fn encode(&mut self, frame: &mut CapturedFrame) -> Option<EncodedFrame> {
        if self.available && self.codec.is_some() && self.ensure_session(frame) {
            if let Some(encoded) = self.encode_video(frame) {
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
            bytes: frame.to_jpeg(self.config.jpeg_quality)?,
        })
    }

    /// True when a usable session exists for this frame's size.
    fn ensure_session(&mut self, frame: &CapturedFrame) -> bool {
        // Streaming again, so it is no longer a candidate for reclaiming.
        let returning = self.retired.remove(&frame.id).is_some();

        if let Some((width, height, bitrate)) = self
            .sessions
            .get(&frame.id)
            .map(|s| (s.width, s.height, s.bitrate))
        {
            // A returning window's session was built for whatever the budget
            // was when it left. Reusing it as-is would quietly ignore the share
            // it has now, so it is rebuilt on the same threshold `set_rates`
            // uses, and only when the share really moved.
            let stale = returning && worth_rebuilding(bitrate, self.rate_for(frame.id));
            if width == frame.width && height == frame.height && !stale {
                return true;
            }
            // Resized. H.264 cannot change resolution mid-stream, so the
            // session is rebuilt and the next frame is an IDR.
            self.sessions.remove(&frame.id);
        }

        if self.sessions.len() >= self.config.max_h264_sessions && !self.reclaim_a_slot() {
            if self.fallback.insert(frame.id, ()).is_none() {
                tracing::warn!(
                    "NVENC session limit ({}) reached; {} falls back to JPEG",
                    self.config.max_h264_sessions,
                    frame.id
                );
            }
            return false;
        }

        let Some(codec) = self.codec else {
            return false;
        };
        match Session::new(codec, frame, self.config.gop, self.rate_for(frame.id)) {
            Ok(session) => {
                self.fallback.remove(&frame.id);
                self.sessions.insert(frame.id, session);
                tracing::info!(
                    "opened a {} session for {} ({}x{}), {} of {} in use",
                    encoder_name(codec),
                    frame.id,
                    frame.width,
                    frame.height,
                    self.sessions.len(),
                    self.config.max_h264_sessions
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

    fn encode_video(&mut self, frame: &mut CapturedFrame) -> Option<EncodedFrame> {
        let session = self.sessions.get_mut(&frame.id)?;
        session.encode(&mut frame.frame)
    }
}

/// Which retired window has been out of view longest.
///
/// Split out from [`Encoders::reclaim_a_slot`] because it is the whole of the
/// choice, and the rest of that function is a loop that cannot be exercised
/// without a real NVENC session.
fn out_of_view_longest(
    retired: &HashMap<WindowId, std::time::Instant>,
) -> Option<WindowId> {
    retired
        .iter()
        .min_by_key(|(_, at)| **at)
        .map(|(id, _)| *id)
}

/// Whether a session built for one rate is wrong enough for another to rebuild.
///
/// One rule, in one place, because two callers ask the same question: the
/// budget moving under a streaming window, and a returning window meeting a
/// budget that moved while it was away. A rebuild costs a keyframe, so the
/// answer has to be "no" for the small drift that one window opening causes in
/// every other window's share.
fn worth_rebuilding(from: u32, to: u32) -> bool {
    (f64::from(to) - f64::from(from)).abs() / f64::from(from.max(1)) > crate::bitrate::DEADBAND
}

/// The NVENC encoder for each codec.
///
/// HEVC costs the same to encode here, since the card has a dedicated block for
/// it, and spends roughly a third fewer bits for the same picture.
fn encoder_name(codec: lwfa_proto::Codec) -> &'static str {
    match codec {
        lwfa_proto::Codec::Hevc => "hevc_nvenc",
        lwfa_proto::Codec::H264 => "h264_nvenc",
    }
}

impl Session {
    fn new(
        codec: lwfa_proto::Codec,
        frame: &CapturedFrame,
        gop: u32,
        bitrate: u32,
    ) -> Result<Self, ff::Error> {
        let (width, height) = (frame.width, frame.height);
        let wanted = codec;
        let codec = ff::encoder::find_by_name(encoder_name(codec)).ok_or(ff::Error::EncoderNotFound)?;
        let ctx = ff::codec::context::Context::new_with_codec(codec);
        let mut enc = ctx.encoder().video()?;

        enc.set_width(width);
        enc.set_height(height);
        if crate::cuda::is_gpu(&frame.frame) {
            // The frame is already on the GPU: name its pool and NVENC reads
            // it in place. Nothing crosses the bus but the bitstream.
            enc.set_format(Pixel::CUDA);
            if !crate::cuda::adopt_frames(&mut enc, &frame.frame) {
                return Err(ff::Error::InvalidData);
            }
        } else {
            // RGB0: the capture's RGBA bytes, with NVENC told to ignore the
            // alpha. The driver does the RGB-to-YUV conversion on the GPU,
            // which is what deleted the CPU swscale stage this pipeline used
            // to carry. The conversion NVENC applies matches the BT.601
            // matrix swscale used, so colours did not shift when the stage
            // moved.
            enc.set_format(Pixel::RGBZ);
        }
        enc.set_time_base(ff::Rational(1, 60));
        // Keyframe interval, and so also the worst case wait before a newly
        // attached browser can decode anything: startup latency against
        // bandwidth.
        enc.set_gop(gop);
        // No B-frames: they reorder output, which adds latency for no benefit
        // on an interactive stream.
        enc.set_max_b_frames(0);
        // Chosen by the controller from how the connection is coping, not
        // fixed. See `bitrate`.
        enc.set_bit_rate(bitrate as usize);

        let mut opts = ff::Dictionary::new();
        // p4 rather than p1. p1 is NVENC's fastest and visibly worst preset,
        // and it is why the stream looked soft even with bitrate to spare:
        // preset, not bits, was the ceiling on quality. p4 costs a few more
        // milliseconds on the dedicated encoder thread, which the zero-copy
        // path has left mostly idle, and spends the same bits far better.
        opts.set("preset", "p4");
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

        Ok(Self {
            encoder,
            width,
            height,
            codec: wanted,
            bitrate,
            pts: 0,
            force_keyframe: true,
        })
    }

    /// Encode the captured frame in place.
    ///
    /// The frame arrives already in the layout the encoder eats, so nothing is
    /// copied or converted here: NVENC uploads it and does the colour
    /// conversion itself. `send_frame` copies into the encoder's own input
    /// surface before returning, which is what makes handing the same pooled
    /// frame back for reuse safe.
    fn encode(&mut self, source: &mut ff::frame::Video) -> Option<EncodedFrame> {
        source.set_pts(Some(self.pts));
        if self.force_keyframe {
            source.set_kind(ff::picture::Type::I);
            self.force_keyframe = false;
        } else {
            source.set_kind(ff::picture::Type::None);
        }
        self.pts += 1;

        self.encoder.send_frame(source).ok()?;

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
            // The wire format follows the codec this session was built for, so
            // the client knows which decoder to configure without guessing
            // from the bitstream.
            format: match self.codec {
                lwfa_proto::Codec::Hevc => FrameFormat::Hevc,
                lwfa_proto::Codec::H264 => FrameFormat::H264,
            },
            keyframe,
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32) -> CapturedFrame {
        // A gradient rather than flat colour, so a stride bug shears
        // visibly instead of being hidden by uniform pixels.
        let rgba: Vec<u8> = (0..width as usize * height as usize)
            .flat_map(|i| {
                let x = (i % width as usize) as u8;
                let y = (i / width as usize) as u8;
                [x, y, x.wrapping_add(y), 255]
            })
            .collect();
        CapturedFrame::for_tests(WindowId(1), width, height, &rgba)
    }

    #[test]
    fn encoders_report_availability_without_panicking() {
        // Must not panic on a machine with no NVENC; it should just fall back.
        let encoders = Encoders::new(crate::config::Stream::default());
        // Either outcome is valid depending on the host; what matters is that
        // construction succeeded.
        let _ = encoders.available;
    }

    #[test]
    fn falls_back_to_jpeg_when_hardware_is_unavailable() {
        let mut encoders = Encoders::new(crate::config::Stream::default());
        encoders.available = false;
        let encoded = encoders
            .encode(&mut frame(64, 64))
            .expect("should still encode");
        assert_eq!(encoded.format, FrameFormat::Jpeg);
        assert!(encoded.keyframe, "jpeg is always self-contained");
        assert!(encoded.bytes.starts_with(&[0xff, 0xd8]), "should be a JPEG");
    }

    #[test]
    fn forgetting_a_window_drops_its_session() {
        let mut encoders = Encoders::new(crate::config::Stream::default());
        encoders.fallback.insert(WindowId(1), ());
        encoders.forget(WindowId(1));
        assert!(encoders.fallback.is_empty());
        assert!(encoders.sessions.is_empty());
    }

    #[test]
    fn a_window_that_stops_streaming_is_only_offered_up() {
        // The whole point. Scrolling a window out of view used to destroy its
        // session, so scrolling back cost a 90-160ms rebuild and a keyframe,
        // 47 times in one day, to free a slot nothing was asking for.
        //
        // Only the bookkeeping is tested here. Whether the session itself
        // survives cannot be: an NVENC session has no constructor that does not
        // go through the driver, and building real ones across parallel test
        // threads segfaults inside it. The reuse is verified against the
        // running engine instead, by the absence of a second "opened a session"
        // line for a window that comes back at the size it left at.
        let mut encoders = Encoders::new(crate::config::Stream::default());
        encoders.fallback.insert(WindowId(1), ());
        encoders.retire(WindowId(1), std::time::Instant::now());
        assert!(encoders.retired.contains_key(&WindowId(1)));
        assert!(
            encoders.fallback.is_empty(),
            "a window out of view is not a window that failed to get hardware",
        );
    }

    #[test]
    fn the_window_out_of_view_longest_goes_first() {
        // Among sessions nobody is watching, the one gone longest is the one
        // least likely to be missed, and rebuilding it later costs exactly what
        // rebuilding it now would.
        let mut retired = HashMap::new();
        let now = std::time::Instant::now();
        retired.insert(WindowId(1), now - std::time::Duration::from_secs(1));
        retired.insert(WindowId(2), now - std::time::Duration::from_secs(60));
        retired.insert(WindowId(3), now);
        assert_eq!(out_of_view_longest(&retired), Some(WindowId(2)));
    }

    #[test]
    fn nothing_out_of_view_means_nothing_to_take() {
        // The case that protects a streaming window: with nothing retired there
        // is no slot to reclaim, so a newcomer degrades to JPEG rather than
        // stealing hardware from a window somebody is looking at.
        assert_eq!(out_of_view_longest(&HashMap::new()), None);
        let mut encoders = Encoders::new(crate::config::Stream::default());
        assert!(!encoders.reclaim_a_slot());
    }

    #[test]
    fn a_retired_id_whose_session_already_went_frees_nothing() {
        // `set_rates` and a codec change both drop sessions without consulting
        // the retired list, so an id in it can name a session that no longer
        // exists. Reclaiming has to keep looking rather than reporting success.
        let mut encoders = Encoders::new(crate::config::Stream::default());
        encoders
            .retired
            .insert(WindowId(1), std::time::Instant::now());
        assert!(!encoders.reclaim_a_slot());
        assert!(encoders.retired.is_empty(), "and not look at it forever");
    }

    #[test]
    fn a_closed_window_takes_its_session_with_it() {
        let mut encoders = Encoders::new(crate::config::Stream::default());
        encoders
            .retired
            .insert(WindowId(1), std::time::Instant::now());
        encoders.forget(WindowId(1));
        assert!(encoders.retired.is_empty());
    }

    #[test]
    fn a_rebuild_is_worth_it_only_past_the_deadband() {
        // The rule both callers share. A window opening shifts every other
        // window's share by a few percent, and rebuilding all of them for that
        // would cost a screen full of keyframes for no visible gain.
        assert!(!worth_rebuilding(1_000_000, 1_050_000));
        assert!(worth_rebuilding(1_000_000, 500_000));
        assert!(worth_rebuilding(500_000, 1_000_000));
        assert!(!worth_rebuilding(0, 0), "a rate of zero is not a division");
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

// The queue depth is `[stream].encoder_queue_depth`. Small on purpose: a
// backlog here is latency the user sees as the remote view lagging reality, and
// for an interactive desktop a fresh frame is worth more than a complete
// history. Dropping is the correct response to a consumer that cannot keep up.

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
    /// Mirrored from the config so `has_capacity` stays a plain atomic read.
    queue_depth: usize,
}

struct Job {
    frame: CapturedFrame,
}

enum Control {
    Forget(WindowId),
    Retire(WindowId),
    RequestKeyframes,
    Codec(Option<lwfa_proto::Codec>),
    Rates(std::collections::HashMap<WindowId, u32>, u32),
}

impl EncodeWorker {
    pub fn spawn(sink: FrameSink, config: crate::config::Stream) -> std::io::Result<Self> {
        let queue_depth = config.encoder_queue_depth.max(1);
        let (frames_tx, frames_rx) = sync_channel::<Job>(queue_depth);
        let (control_tx, control_rx) = sync_channel::<Control>(16);
        let queued = Arc::new(AtomicUsize::new(0));
        let worker_queued = Arc::clone(&queued);

        thread::Builder::new()
            .name("lwfa-encode".into())
            .spawn(move || {
                let mut encoders = Encoders::new(config);
                loop {
                    let Ok(mut job) = frames_rx.recv() else {
                        return; // compositor is gone
                    };
                    worker_queued.fetch_sub(1, Ordering::Relaxed);

                    // Drain control *after* receiving, not before.
                    //
                    // This thread spends nearly all its time blocked in
                    // recv(), so anything sent while it was blocked has to be
                    // applied to the frame that just woke it. Handling control
                    // only at the top of the loop applies it one frame late,
                    // and that one frame is precisely the one a newly attached
                    // client needs to be an IDR. It would arrive as a delta
                    // with no SPS, the client would wait for a keyframe, and
                    // because damage tracking means an idle window sends
                    // nothing further, it would wait forever.
                    while let Ok(message) = control_rx.try_recv() {
                        match message {
                            Control::Forget(id) => encoders.forget(id),
                            Control::Retire(id) => {
                                encoders.retire(id, std::time::Instant::now());
                            }
                            Control::RequestKeyframes => encoders.request_keyframes(),
                            Control::Codec(v) => encoders.set_codec(v),
                            Control::Rates(rates, fallback) => encoders.set_rates(rates, fallback),
                        }
                    }

                    // A frame for a window that was just forgotten is stale;
                    // encoding it would rebuild the session it just dropped.
                    let Some(encoded) = encoders.encode(&mut job.frame) else {
                        continue;
                    };

                    let header = lwfa_proto::FrameHeader {
                        window: job.frame.id,
                        width: job.frame.width,
                        height: job.frame.height,
                        format: encoded.format,
                        keyframe: encoded.keyframe,
                    };
                    // Addressed by window, because a frame goes only to the
                    // clients that asked for that window. See `FrameSink`.
                    sink.send_frame(job.frame.id, header.encode_with_payload(&encoded.bytes));
                }
            })?;

        Ok(Self {
            frames: frames_tx,
            control: control_tx,
            queued,
            queue_depth,
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
        self.queued.load(Ordering::Relaxed) < self.queue_depth
    }

    pub fn forget(&self, id: WindowId) {
        let _ = self.control.try_send(Control::Forget(id));
    }

    /// Tell the encoder this window is no longer being streamed.
    ///
    /// Not the same as [`EncodeWorker::forget`], which is for a window that has
    /// closed. See [`Encoders::retire`].
    pub fn retire(&self, id: WindowId) {
        let _ = self.control.try_send(Control::Retire(id));
    }

    pub fn request_keyframes(&self) {
        let _ = self.control.try_send(Control::RequestKeyframes);
    }

    /// Ask the encoder thread to re-divide the budget. See `bitrate`.
    pub fn set_rates(&self, rates: std::collections::HashMap<WindowId, u32>, fallback: u32) {
        let _ = self.control.try_send(Control::Rates(rates, fallback));
    }

    pub fn set_codec(&self, codec: Option<lwfa_proto::Codec>) {
        let _ = self
            .control
            .try_send(Control::Codec(codec));
    }
}
