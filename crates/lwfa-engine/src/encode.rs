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
    /// when it moved by at least a quarter. Without that, one window opening
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
    // The ladder's 32 -> 24 Mbit/s cut is exactly a quarter. Excluding the
    // boundary left that congestion response unapplied in every session.
    (f64::from(to) - f64::from(from)).abs() / f64::from(from.max(1)) >= crate::bitrate::DEADBAND
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
    fn a_rebuild_is_worth_it_at_the_deadband() {
        // The rule both callers share. A window opening shifts every other
        // window's share by a few percent, and rebuilding all of them for that
        // would cost a screen full of keyframes for no visible gain.
        assert!(!worth_rebuilding(1_000_000, 1_050_000));
        assert!(worth_rebuilding(1_000_000, 500_000));
        assert!(worth_rebuilding(500_000, 1_000_000));
        assert!(!worth_rebuilding(0, 0), "a rate of zero is not a division");
    }

    #[test]
    fn every_congestion_cut_on_the_bitrate_ladder_reaches_the_encoder() {
        for pair in crate::bitrate::STEPS.windows(2) {
            assert!(
                worth_rebuilding(pair[1], pair[0]),
                "the controller cut from {} to {}, but the encoder kept its old rate",
                pair[1], pair[0],
            );
        }
    }

    #[test]
    #[ignore = "requires NVENC; run alone with --ignored --test-threads=1"]
    fn hardware_codec_resize_and_recovery() {
        use std::process::Command;

        let output_dir = std::path::PathBuf::from(
            std::env::var_os("LWFA_CODEC_PROBE_DIR")
                .expect("set LWFA_CODEC_PROBE_DIR to an isolated probe directory"),
        );
        std::fs::create_dir_all(&output_dir).unwrap();
        let mut results = Vec::new();
        for (codec, format, extension) in [
            (lwfa_proto::Codec::H264, FrameFormat::H264, "h264"),
            (lwfa_proto::Codec::Hevc, FrameFormat::Hevc, "hevc"),
        ] {
            let mut encoders = Encoders::new(crate::config::Stream::default());
            assert!(encoders.available, "this diagnostic requires NVENC");
            encoders.set_codec(Some(codec));
            encoders.set_rates(HashMap::new(), 20_000_000);
            // Reuse the same window/session owner through both resizes.
            for (stage, (width, height)) in [(1000_u32, 640_u32), (4000, 3000), (1000, 640)]
                .into_iter().enumerate()
            {
                let rgba: Vec<u8> = (0..width as usize * height as usize)
                    .flat_map(|i| {
                        let x = i % width as usize;
                        let y = i / width as usize;
                        let gray = [40, 100, 160, 220][
                            usize::from(x >= width as usize / 2)
                                + 2 * usize::from(y >= height as usize / 2)
                        ];
                        [gray, gray, gray, 255]
                    }).collect();
                let mut captured = CapturedFrame::for_tests(WindowId(1), width, height, &rgba);
                for tick in 0..3 {
                    if tick == 2 { encoders.request_keyframes(); }
                    let encoded = encoders.encode(&mut captured).expect("immediate encoded frame");
                    assert_eq!(encoded.format, format, "hardware must not silently fall back");
                    if tick == 1 {
                        assert!(!encoded.keyframe, "verify recovery follows an inter frame");
                        continue;
                    }
                    assert!(encoded.keyframe, "resize and requested recovery must emit IDR");
                    // Decode only this packet, without preceding parameter sets or references.
                    let path = output_dir.join(format!("{extension}-{stage}-{tick}.{extension}"));
                    std::fs::write(&path, &encoded.bytes).unwrap();
                    let probe = Command::new("ffprobe").args([
                        "-v", "error", "-show_entries", "stream=codec_name,profile,level,width,height,pix_fmt",
                        "-of", "json",
                    ]).arg(&path).output().unwrap();
                    assert!(probe.status.success(), "{}", String::from_utf8_lossy(&probe.stderr));
                    let metadata: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
                    let stream = &metadata["streams"][0];
                    assert_eq!(stream["width"], width);
                    assert_eq!(stream["height"], height);
                    assert_eq!(stream["codec_name"], extension);
                    if codec == lwfa_proto::Codec::Hevc && width == 4000 {
                        assert!(stream["level"].as_u64().unwrap() > 153,
                            "large HEVC fixture must exercise an SPS above level 5.1");
                    }
                    let decoded = Command::new("ffmpeg").args([
                        "-v", "error", "-threads", "1", "-i",
                    ]).arg(&path).args([
                        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
                    ]).output().unwrap();
                    assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
                    assert_eq!(decoded.stdout.len(), width as usize * height as usize * 3);
                    let mut max_error = 0_u8;
                    // Include all four edges, so stale dimensions, pitch errors, and black strips fail.
                    for y in [2, height / 4, height * 3 / 4, height - 3] {
                        for x in [2, width / 4, width * 3 / 4, width - 3] {
                            let expected = [40_u8, 100, 160, 220][
                                usize::from(x >= width / 2) + 2 * usize::from(y >= height / 2)
                            ];
                            let offset = (y as usize * width as usize + x as usize) * 3;
                            for &channel in &decoded.stdout[offset..offset + 3] {
                                max_error = max_error.max(channel.abs_diff(expected));
                            }
                        }
                    }
                    assert!(max_error <= 10, "decoded quadrants/edges differ by {max_error}");
                    results.push(serde_json::json!({
                        "codec": extension, "stage": stage, "recovery": tick == 2,
                        "stream": stream, "bytes": encoded.bytes.len(), "maxChannelError": max_error,
                    }));
                }
            }
        }
        std::fs::write(output_dir.join("results.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        eprintln!("verified {} standalone hardware keyframes: {}", results.len(), output_dir.display());
    }

    #[test]
    #[ignore = "requires NVENC; run alone with --ignored --test-threads=1"]
    fn measure_motion_fixture_bitrates() {
        let (width, height) = (1000, 700);
        let mut rgba = vec![0_u8; width * height * 4];
        for noisy in [false, true] {
            for (codec, budget) in [(Some(lwfa_proto::Codec::H264), 500_000),
                (Some(lwfa_proto::Codec::H264), 2_000_000), (None, 500_000)] {
                let mut encoders = Encoders::new(crate::config::Stream::default());
                assert!(encoders.available, "this hardware diagnostic requires NVENC");
                encoders.set_codec(codec);
                encoders.set_rates(HashMap::from([(WindowId(1), budget)]), budget);
                let mut bits = 0_u64;
                for tick in 0..150_u32 {
                    for (pixel, bytes) in rgba.chunks_exact_mut(4).enumerate() {
                        let x = (pixel % width) as u32;
                        let y = (pixel / width) as u32;
                        if noisy {
                            // The difficult native-browser fixture, whose
                            // rate excess also reproduces in FFmpeg CLI.
                            let value = (x / 12 * 12 + tick).wrapping_mul(1_664_525)
                                ^ (y / 12 * 12 + tick).wrapping_mul(1_013_904_223);
                            bytes.copy_from_slice(&[value as u8, (value >> 8) as u8, (value >> 16) as u8, 255]);
                        } else {
                            // A scrolling page: fixed blue sidebar and toolbar,
                            // lines of dark glyph-like blocks on a light page.
                            let scroll = y + tick * 2;
                            let text = scroll % 28 >= 8 && scroll % 28 < 18
                                && x % 12 < 8 && (x / 12 + scroll / 28 * 5) % 11 < 8;
                            let color = if x < 160 || y < 48 { [35, 70, 115, 255] }
                                else if text { [45, 45, 45, 255] } else { [240, 240, 240, 255] };
                            bytes.copy_from_slice(&color);
                        }
                    }
                    let mut captured = CapturedFrame::for_tests(WindowId(1), width as u32, height as u32, &rgba);
                    let encoded = encoders.encode(&mut captured).expect("encoded frame");
                    assert_eq!(encoded.format, if codec.is_some() { FrameFormat::H264 } else { FrameFormat::Jpeg });
                    if tick >= 30 { bits += encoded.bytes.len() as u64 * 8; }
                }
                // A diagnostic, not a promise that an arbitrary noise image
                // fits a fixed resolution at every bitrate. These are 120
                // sampled frames at the encoder's nominal 60fps timebase.
                eprintln!("fixture={} codec={} budget={budget} nominal_60fps_bps={}",
                    if noisy { "block-noise" } else { "scrolling-desktop" },
                    if codec.is_some() { "h264" } else { "jpeg" }, bits / 2);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Running the encoder off the render loop
// ---------------------------------------------------------------------------

use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
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
    work: Arc<WorkQueue<Job>>,
    admission: Arc<Mutex<CaptureAdmission>>,
}

struct CaptureAdmission {
    windows: HashMap<WindowId, CaptureSlot>,
    generation: u64,
    codec: Option<lwfa_proto::Codec>,
    next_ticket: u64,
}

impl Default for CaptureAdmission {
    fn default() -> Self {
        Self {
            windows: HashMap::new(),
            generation: 0,
            codec: Some(lwfa_proto::Codec::H264),
            next_ticket: 0,
        }
    }
}

#[derive(Default)]
struct CaptureSlot {
    pending: bool,
    ticket: u64,
    generation: u64,
    jpeg: Option<(std::time::Instant, usize)>,
}

impl CaptureAdmission {
    fn prefetch(&self, id: WindowId) -> bool {
        self.codec.is_some() && self.windows.get(&id).is_none_or(|slot| slot.jpeg.is_none())
    }

    fn ready(&self, id: WindowId, rate: u32, now: std::time::Instant) -> bool {
        let Some(slot) = self.windows.get(&id) else {
            return true;
        };
        if slot.pending {
            return false;
        }
        let Some((sent, bytes)) = slot.jpeg else {
            return true;
        };
        // Reprice the last independent frame against the current allocation,
        // so recovery or a new split takes effect before another encode job.
        // There is no FPS floor: a large JPEG cannot fit a small budget merely
        // because the video codec's ten-fps floor says it should.
        now.saturating_duration_since(sent).as_secs_f64()
            >= bytes as f64 * 8.0 / f64::from(rate.max(1))
    }

    fn start(&mut self, id: WindowId) -> bool {
        let slot = self.windows.entry(id).or_default();
        if slot.pending {
            return false;
        }
        slot.pending = true;
        slot.ticket = self.next_ticket;
        self.next_ticket = self.next_ticket.wrapping_add(1);
        slot.generation = self.generation;
        true
    }

    fn current(&self, id: WindowId, ticket: u64) -> bool {
        self.windows.get(&id).is_some_and(|slot| slot.pending && slot.ticket == ticket)
    }

    fn finish(
        &mut self,
        id: WindowId,
        ticket: u64,
        encoded: Option<(FrameFormat, usize)>,
        now: std::time::Instant,
    ) {
        let Some(slot) = self.windows.get_mut(&id) else {
            return;
        };
        if !slot.pending || slot.ticket != ticket {
            return;
        }
        slot.pending = false;
        if slot.generation != self.generation {
            return;
        }
        if let Some((format, bytes)) = encoded {
            slot.jpeg = (format == FrameFormat::Jpeg).then_some((now, bytes));
        }
    }

    fn forget(&mut self, id: WindowId) {
        self.windows.remove(&id);
    }

    fn codec_changed(&mut self, codec: Option<lwfa_proto::Codec>) {
        if self.codec == codec {
            return;
        }
        self.codec = codec;
        self.generation = self.generation.wrapping_add(1);
        for slot in self.windows.values_mut() {
            slot.jpeg = None;
        }
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn large_jpegs_fit_their_byte_budget_instead_of_the_video_fps_floor() {
        let mut admission = CaptureAdmission::default();
        let base = Instant::now();
        let id = WindowId(1);
        let rate = 500_000;
        let bytes = 90_000;
        let mut sent = 0;
        for tick in 0..600 {
            let now = base + Duration::from_micros(tick * 16_667);
            if admission.ready(id, rate, now) {
                assert!(admission.start(id));
                admission.finish(
                    id,
                    admission.windows.get(&id).map_or(0, |slot| slot.ticket),
                    Some((FrameFormat::Jpeg, bytes)),
                    now,
                );
                sent += bytes;
            }
        }
        // Ten seconds of budget plus the first independent frame. There is
        // never a waiting image: each admitted capture is the current image.
        assert!(sent <= rate as usize * 10 / 8 + bytes, "sent {sent} bytes");
    }

    #[test]
    fn current_budget_changes_when_the_next_jpeg_can_be_captured() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        admission.start(id);
        admission.finish(
            id,
            admission.windows.get(&id).map_or(0, |slot| slot.ticket),
            Some((FrameFormat::Jpeg, 100_000)),
            now,
        );
        assert!(!admission.ready(id, 500_000, now + Duration::from_millis(300)));
        assert!(admission.ready(id, 4_000_000, now + Duration::from_millis(300)));
        assert!(!admission.ready(id, 250_000, now + Duration::from_secs(2)));
    }

    #[test]
    fn independent_jpeg_windows_use_their_allocations_without_banked_bursts() {
        let mut admission = CaptureAdmission::default();
        let base = Instant::now();
        let ids = [WindowId(1), WindowId(2)];
        let rates = crate::bitrate::allocate(1_000_000, &ids, None);
        let mut sent = 0;
        for tick in 0..600 {
            let now = base + Duration::from_micros(tick * 16_667);
            for id in ids {
                if admission.ready(id, rates[&id], now) {
                    admission.start(id);
                    admission.finish(
                        id,
                        admission.windows.get(&id).map_or(0, |slot| slot.ticket),
                        Some((FrameFormat::Jpeg, 90_000)),
                        now,
                    );
                    sent += 90_000;
                }
            }
        }
        assert!(sent <= 1_000_000 * 10 / 8 + 180_000);
        let later = base + Duration::from_secs(100);
        assert!(admission.ready(ids[0], rates[&ids[0]], later));
        admission.start(ids[0]);
        admission.finish(
            ids[0],
            admission.windows[&ids[0]].ticket,
            Some((FrameFormat::Jpeg, 90_000)),
            later,
        );
        assert!(!admission.ready(ids[0], rates[&ids[0]], later));
    }

    #[test]
    fn a_second_capture_waits_for_the_first_encode_without_blocking_other_windows() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        assert!(admission.start(id));
        assert!(!admission.start(id));
        assert!(!admission.ready(id, 32_000_000, now));
        assert!(admission.ready(WindowId(2), 500_000, now));
        admission.finish(
            id,
            admission.windows.get(&id).map_or(0, |slot| slot.ticket),
            None,
            now,
        );
        assert!(admission.ready(id, 32_000_000, now));
    }

    #[test]
    fn video_frames_are_not_throttled_by_jpeg_bytes() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        for format in [FrameFormat::H264, FrameFormat::Hevc] {
            admission.start(id);
            admission.finish(
                id,
                admission.windows.get(&id).map_or(0, |slot| slot.ticket),
                Some((format, 1_000_000)),
                now,
            );
            assert!(admission.ready(id, 500_000, now));
        }
    }

    #[test]
    fn jpeg_admission_does_not_prefetch_an_image_for_the_next_budget_interval() {
        let mut admission = CaptureAdmission::default();
        let id = WindowId(1);
        assert!(admission.prefetch(id));
        admission.start(id);
        admission.finish(id, admission.windows[&id].ticket,
            Some((FrameFormat::Jpeg, 100_000)), Instant::now());
        assert!(!admission.prefetch(id), "hardware fallback must also stop prefetch");
        admission.codec_changed(Some(lwfa_proto::Codec::Hevc));
        assert!(admission.prefetch(id));
        admission.codec_changed(None);
        assert!(!admission.prefetch(WindowId(2)), "explicit JPEG starts fresh on its first frame");
    }

    #[test]
    fn codec_changes_ignore_old_inflight_jpeg_measurements() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        admission.start(id);
        admission.codec_changed(Some(lwfa_proto::Codec::Hevc));
        admission.finish(
            id,
            admission.windows.get(&id).map_or(0, |slot| slot.ticket),
            Some((FrameFormat::Jpeg, 1_000_000)),
            now,
        );
        assert!(admission.ready(id, 500_000, now));
    }

    #[test]
    fn repeating_codec_negotiation_does_not_bypass_jpeg_pacing() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        admission.codec_changed(None);
        admission.start(id);
        admission.finish(
            id,
            admission.windows.get(&id).map_or(0, |slot| slot.ticket),
            Some((FrameFormat::Jpeg, 1_000_000)),
            now,
        );
        admission.codec_changed(None);
        assert!(!admission.ready(id, 500_000, now));
    }

    #[test]
    fn closing_a_window_removes_its_measurements_even_if_encode_finishes_late() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        admission.start(id);
        admission.forget(id);
        admission.finish(
            id,
            admission.windows.get(&id).map_or(0, |slot| slot.ticket),
            Some((FrameFormat::Jpeg, 1_000_000)),
            now,
        );
        assert!(admission.windows.is_empty());
    }

    #[test]
    fn changing_scale_rejects_queued_and_inflight_frames_even_after_readmission() {
        let mut admission = CaptureAdmission::default();
        let id = WindowId(1);
        admission.start(id);
        let stale = admission.windows[&id].ticket;
        assert!(admission.current(id, stale));
        admission.forget(id);
        assert!(!admission.current(id, stale));
        admission.start(id);
        assert!(!admission.current(id, stale));
        assert!(admission.current(id, admission.windows[&id].ticket));
    }

    #[test]
    fn retiring_and_readmitting_a_window_cannot_complete_the_new_job_with_old_bytes() {
        let mut admission = CaptureAdmission::default();
        let now = Instant::now();
        let id = WindowId(1);
        admission.start(id);
        let old = admission.windows[&id].ticket;
        admission.forget(id);
        admission.start(id);
        let current = admission.windows[&id].ticket;
        admission.finish(id, old, Some((FrameFormat::Jpeg, 1_000_000)), now);
        assert!(!admission.ready(id, 500_000, now));
        admission.finish(id, current, Some((FrameFormat::Jpeg, 10_000)), now);
        assert!(admission.ready(id, 500_000, now + Duration::from_millis(200)));
    }
}

struct Job {
    frame: CapturedFrame,
    ticket: u64,
}

enum Control {
    Forget(WindowId),
    Retire(WindowId),
    RequestKeyframes,
    Codec(Option<lwfa_proto::Codec>),
    Rates(std::collections::HashMap<WindowId, u32>, u32),
}

/// Controls describe desired state rather than a history. Closing many windows
/// must never overflow a message channel, and repeated rate updates need only
/// their latest value. Forget dominates retirement until the worker handles it.
#[derive(Default)]
struct Controls {
    windows: HashMap<WindowId, bool>,
    keyframes: bool,
    codec: Option<Option<lwfa_proto::Codec>>,
    rates: Option<(HashMap<WindowId, u32>, u32)>,
}

impl Controls {
    fn push(&mut self, control: Control) {
        match control {
            Control::Forget(id) => { self.windows.insert(id, true); }
            Control::Retire(id) => { self.windows.entry(id).or_insert(false); }
            Control::RequestKeyframes => self.keyframes = true,
            Control::Codec(codec) => self.codec = Some(codec),
            Control::Rates(rates, fallback) => self.rates = Some((rates, fallback)),
        }
    }

    fn is_empty(&self) -> bool {
        self.windows.is_empty() && !self.keyframes && self.codec.is_none() && self.rates.is_none()
    }

    fn apply(self, encoders: &mut Encoders) {
        for (id, forget) in self.windows {
            if forget { encoders.forget(id); } else { encoders.retire(id, std::time::Instant::now()); }
        }
        if let Some(codec) = self.codec { encoders.set_codec(codec); }
        if let Some((rates, fallback)) = self.rates { encoders.set_rates(rates, fallback); }
        if self.keyframes { encoders.request_keyframes(); }
    }
}

struct PendingWork<J> {
    frames: std::collections::VecDeque<J>,
    controls: Controls,
    closed: bool,
}

/// Both kinds of work wake the same waiter. Frames stay bounded, while control
/// updates are coalesced and cannot be dropped merely because encoding is busy.
struct WorkQueue<J> {
    pending: Mutex<PendingWork<J>>,
    ready: Condvar,
    queued: AtomicUsize,
    capacity: usize,
}

impl<J> WorkQueue<J> {
    fn new(capacity: usize) -> Self {
        Self {
            pending: Mutex::new(PendingWork { frames: Default::default(), controls: Default::default(), closed: false }),
            ready: Condvar::new(),
            queued: AtomicUsize::new(0),
            capacity,
        }
    }

    fn submit(&self, job: J) -> bool {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.closed || pending.frames.len() >= self.capacity { return false; }
        pending.frames.push_back(job);
        self.queued.fetch_add(1, Ordering::Relaxed);
        self.ready.notify_one();
        true
    }

    fn control(&self, control: Control) {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.closed { return; }
        pending.controls.push(control);
        self.ready.notify_one();
    }

    fn next(&self) -> Option<(Controls, Option<J>)> {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        while !pending.closed && pending.frames.is_empty() && pending.controls.is_empty() {
            pending = self.ready.wait(pending).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if pending.closed { return None; }
        let controls = std::mem::take(&mut pending.controls);
        let job = pending.frames.pop_front();
        if job.is_some() { self.queued.fetch_sub(1, Ordering::Relaxed); }
        Some((controls, job))
    }

    fn close(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.closed = true;
        pending.frames.clear();
        self.queued.store(0, Ordering::Relaxed);
        self.ready.notify_one();
    }
}

impl EncodeWorker {
    pub fn spawn(sink: FrameSink, config: crate::config::Stream) -> std::io::Result<Self> {
        let queue_depth = config.encoder_queue_depth.max(1);
        let work = Arc::new(WorkQueue::<Job>::new(queue_depth));
        let worker_work = Arc::clone(&work);
        let admission = Arc::new(Mutex::new(CaptureAdmission::default()));
        let worker_admission = Arc::clone(&admission);

        thread::Builder::new()
            .name("lwfa-encode".into())
            .spawn(move || {
                let mut encoders = Encoders::new(config);
                loop {
                    let Some((controls, job)) = worker_work.next() else {
                        return;
                    };
                    // Apply controls even if no new pixels arrive. All changes
                    // collected with a frame apply before encoding that frame.
                    controls.apply(&mut encoders);
                    let Some(mut job) = job else { continue; };

                    // A frame for a window that was just forgotten is stale;
                    // encoding it would rebuild the session it just dropped.
                    if worker_admission.lock().is_ok_and(|admission| !admission.current(job.frame.id, job.ticket)) {
                        continue;
                    }
                    let Some(encoded) = encoders.encode(&mut job.frame) else {
                        if let Ok(mut admission) = worker_admission.lock() {
                            admission.finish(job.frame.id, job.ticket, None, std::time::Instant::now());
                        }
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
                    let bytes = header.encode_with_payload(&encoded.bytes);
                    let size = bytes.len();
                    if let Ok(mut admission) = worker_admission.lock() {
                        // A scale change can invalidate a job while the GPU is
                        // encoding. Keep the check and queue handoff atomic with
                        // respect to forget(), so old pixels cannot reappear.
                        if !admission.current(job.frame.id, job.ticket) { continue; }
                        sink.send_frame(job.frame.id, bytes);
                        admission.finish(job.frame.id, job.ticket, Some((encoded.format, size)), std::time::Instant::now());
                    }
                }
            })?;

        Ok(Self {
            work,
            admission,
        })
    }

    /// Queue a frame, or drop it if the encoder is behind.
    ///
    /// Returns false when dropped, so the caller can leave the capture's damage
    /// state untouched and try again next frame rather than losing the update.
    pub fn submit(&self, frame: CapturedFrame) -> bool {
        let id = frame.id;
        let ticket = match self.admission.lock() {
            Ok(mut admission) => {
                if !admission.start(id) { return false; }
                admission.windows[&id].ticket
            }
            Err(_) => 0,
        };
        if self.work.submit(Job { frame, ticket }) {
            true
        } else {
            if let Ok(mut admission) = self.admission.lock() {
                admission.finish(id, ticket, None, std::time::Instant::now());
            }
            false
        }
    }

    /// Room for another frame without blocking.
    pub fn has_capacity(&self) -> bool {
        self.work.queued.load(Ordering::Relaxed) < self.work.capacity
    }

    /// Admit capture before it consumes damage or performs GPU readback.
    pub fn can_capture(&self, id: WindowId, rate: u32, now: std::time::Instant) -> bool {
        self.admission.lock().map(|admission| admission.ready(id, rate, now)).unwrap_or(true)
    }

    /// CPU video readback may pipeline across ticks. JPEG pacing must leave
    /// the next image on the surface until its byte budget admits capture.
    pub fn prefetch_capture(&self, id: WindowId) -> bool {
        self.admission.lock().map(|admission| admission.prefetch(id)).unwrap_or(true)
    }

    pub fn forget(&self, id: WindowId) {
        if let Ok(mut admission) = self.admission.lock() { admission.forget(id); }
        self.work.control(Control::Forget(id));
    }

    /// Tell the encoder this window is no longer being streamed.
    ///
    /// Not the same as [`EncodeWorker::forget`], which is for a window that has
    /// closed. See [`Encoders::retire`].
    pub fn retire(&self, id: WindowId) {
        if let Ok(mut admission) = self.admission.lock() { admission.forget(id); }
        self.work.control(Control::Retire(id));
    }

    pub fn request_keyframes(&self) {
        self.work.control(Control::RequestKeyframes);
    }

    /// Ask the encoder thread to re-divide the budget. See `bitrate`.
    pub fn set_rates(&self, rates: std::collections::HashMap<WindowId, u32>, fallback: u32) {
        self.work.control(Control::Rates(rates, fallback));
    }

    pub fn set_codec(&self, codec: Option<lwfa_proto::Codec>) {
        if let Ok(mut admission) = self.admission.lock() { admission.codec_changed(codec); }
        self.work.control(Control::Codec(codec));
    }
}

impl Drop for EncodeWorker {
    fn drop(&mut self) { self.work.close(); }
}

#[cfg(test)]
mod work_queue_tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    #[test]
    fn an_idle_worker_handles_forget_without_waiting_for_another_frame() {
        let work = Arc::new(WorkQueue::<u8>::new(1));
        let receiver = work.clone();
        let (ready_tx, ready_rx) = channel();
        let (done_tx, done_rx) = channel();
        let worker = thread::spawn(move || {
            let mut encoders = Encoders::default();
            let id = WindowId(42);
            encoders.fallback.insert(id, ());
            encoders.retire(id, std::time::Instant::now());
            ready_tx.send(()).unwrap();
            let (controls, frame) = receiver.next().expect("control wakes the worker");
            assert!(frame.is_none(), "no frame was submitted");
            controls.apply(&mut encoders);
            done_tx.send((encoders.fallback.is_empty(), encoders.retired.is_empty())).unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        work.control(Control::Forget(WindowId(42)));
        let cleaned = done_rx.recv_timeout(Duration::from_secs(2));
        work.close();
        worker.join().unwrap();
        assert_eq!(cleaned.unwrap(), (true, true));
    }

    #[test]
    fn a_full_frame_queue_cannot_drop_cleanup_and_control_bursts_are_coalesced() {
        let work = WorkQueue::new(1);
        assert!(work.submit(7));
        assert!(!work.submit(8), "frame queue stays bounded");
        for id in 0..64 {
            work.control(Control::Forget(WindowId(id)));
            work.control(Control::Retire(WindowId(id)));
        }
        for rate in 0..1000 {
            work.control(Control::Rates(HashMap::new(), rate));
            work.control(Control::RequestKeyframes);
            work.control(Control::Codec(None));
        }
        let (controls, frame) = work.next().unwrap();
        assert_eq!(frame, Some(7));
        assert_eq!(work.queued.load(Ordering::Relaxed), 0);
        assert_eq!(controls.windows.len(), 64, "no old 16-slot control limit");
        assert!(controls.windows.values().all(|forget| *forget));
        assert_eq!(controls.rates.unwrap().1, 999);
        assert_eq!(controls.codec, Some(None));
        assert!(controls.keyframes);
        assert!(work.submit(9));
    }

    #[test]
    fn shutting_down_wakes_a_worker_with_no_frames_or_controls() {
        let work = Arc::new(WorkQueue::<u8>::new(1));
        let receiver = work.clone();
        let (done_tx, done_rx) = channel();
        let worker = thread::spawn(move || { done_tx.send(receiver.next().is_none()).unwrap(); });
        work.close();
        assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        worker.join().unwrap();
        assert!(!work.submit(1));
    }
}
