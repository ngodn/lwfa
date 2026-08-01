//! The shell protocol.
//!
//! The wire format between the lwfa engine and its shell. The shell owns layout
//! *policy* (where windows go, how the strip scrolls, what focus means); the
//! engine owns *mechanism* (surfaces, configure, input, rendering).
//!
//! The same shell speaks this protocol whether it is running locally against
//! the native backend or remotely in a browser, which is the whole point. See
//! docs/architecture.md section 3.
//!
//! # Two rules this format exists to enforce
//!
//! **The shell never sends frames, only intents.** [`SetLayout`] carries a
//! target and optionally a [`SpringSpec`]; the engine integrates the spring
//! itself at its own refresh rate. A shell pushing a new rect every frame would
//! bake its own network jitter into the animation, and would look different
//! locally and remotely. See [`Animation`].
//!
//! **The shell never sends pixels.** It describes state and the backend
//! realises it. In v0 that state is geometry and stacking only; the wider
//! appearance vocabulary (corner radius, blur, shadow) lands in milestone 5,
//! when both backends can implement it. See [`WindowLayout`].
//!
//! # Encoding
//!
//! JSON, newline-free, one message per WebSocket text frame. Enums are
//! internally tagged on `type` and every field is camelCase, so the TypeScript
//! side in `packages/proto` maps over without a translation layer.
//!
//! JSON rather than a binary format because v0 is small, debuggable matters
//! more than compact right now, and a human can read the traffic in devtools.
//! Per-surface video is a separate transport and will not come through here.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Bumped on any breaking change to the message shapes below.
///
/// The engine sends this in [`ToShell::Hello`] and the shell is expected to
/// refuse to drive a version it does not understand, rather than silently
/// mislaying windows.
pub const PROTOCOL_VERSION: u32 = 0;

/// Engine-assigned window handle. Stable for the lifetime of the window.
///
/// Deliberately not the Wayland surface id: the shell must not be able to
/// address Wayland objects directly, so that a remote shell has exactly the
/// same authority as a local one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WindowId(pub u64);

impl std::fmt::Display for WindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "w{}", self.0)
    }
}

/// The viewport the shell is laying out into.
///
/// Logical pixels. `scale` is reported so a remote shell rendering on a 2x
/// display knows what it is dealing with, but all geometry in this protocol is
/// logical and the engine handles scaling.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub width: i32,
    pub height: i32,
    pub scale: f64,
}

/// A rectangle in logical pixels, output-local.
///
/// Floating point because animated positions land between pixels; the engine
/// rounds at the point it maps into the scene.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the engine knows about a window that the shell might want to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowInfo {
    pub id: WindowId,
    /// From `xdg_toplevel.set_app_id`. Absent until the client sets it.
    pub app_id: Option<String>,
    /// From `xdg_toplevel.set_title`. Changes over a window's life.
    pub title: Option<String>,
}

/// Spring parameters for an animation intent.
///
/// These are Motion's physics parameters and are integrated by
/// `lwfa-spring`, which the engine and the browser backend share. Sending
/// parameters rather than positions is what keeps the two in step. See
/// docs/architecture.md section 5.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpringSpec {
    pub stiffness: f64,
    pub damping: f64,
    pub mass: f64,
}

impl Default for SpringSpec {
    /// Motion's defaults, matching `lwfa_spring::SpringOptions::default`.
    fn default() -> Self {
        Self {
            stiffness: 100.0,
            damping: 10.0,
            mass: 1.0,
        }
    }
}

/// How a layout change should be reached.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Animation {
    pub spring: SpringSpec,
}

/// Where a window should be, and how it should get there.
///
/// # Position animates, size does not
///
/// The engine springs `rect.x` and `rect.y` toward their targets, but applies
/// `rect.width` and `rect.height` immediately as a single `configure`.
///
/// This is deliberate. Animating size means sending a `configure` every frame,
/// and native apps handle repeated resize badly (they do not reflow, they
/// re-layout from scratch). Scrollable tiling is chosen partly to make resize
/// rare; animating it would give that back. Smooth resize needs a crossfade of
/// old and new buffers, which is a later milestone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLayout {
    pub id: WindowId,
    pub rect: Rect,
    /// Stacking order, ascending. Ties broken by position in the message.
    pub z: i32,
    // NOTE: the appearance vocabulary (cornerRadius, opacity, blurBehind,
    // shadow, transform) belongs here and lands in milestone 5, once both the
    // native and browser backends can realise it identically. Adding it before
    // then would mean a protocol field only one backend honours.
}

/// Keyboard modifier state at the time of a key press.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Modifiers {
    pub alt: bool,
    pub ctrl: bool,
    pub shift: bool,
    /// The Super/Windows/Command key.
    pub logo: bool,
}

/// Engine to shell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ToShell {
    /// First message on every connection. The shell should check
    /// `protocolVersion` against [`PROTOCOL_VERSION`] before driving anything.
    ///
    /// Carries the full current state, not just a version, so a shell that
    /// reconnects after a crash resyncs without a separate query.
    #[serde(rename_all = "camelCase")]
    Hello {
        protocol_version: u32,
        output: Output,
        windows: Vec<WindowInfo>,
        focused: Option<WindowId>,
    },
    #[serde(rename_all = "camelCase")]
    OutputChanged { output: Output },
    #[serde(rename_all = "camelCase")]
    WindowOpened { window: WindowInfo },
    /// Title or app_id changed. Windows are long-lived and rename themselves.
    #[serde(rename_all = "camelCase")]
    WindowChanged { window: WindowInfo },
    #[serde(rename_all = "camelCase")]
    WindowClosed { id: WindowId },
    /// Focus moved for a reason the shell did not initiate, such as a click or
    /// a window closing.
    #[serde(rename_all = "camelCase")]
    FocusChanged { id: Option<WindowId> },

    /// A modified key the engine did not claim for itself.
    ///
    /// "Focus the column to the left" is layout policy, so it belongs to the
    /// shell, not here. The engine only keeps binds that are not policy at all
    /// (quit, spawn) and forwards the rest.
    ///
    /// `key` is an xkb keysym name such as `"h"`, `"Left"` or `"Return"`.
    #[serde(rename_all = "camelCase")]
    KeyBinding { key: String, modifiers: Modifiers },
}

/// A pointer button, using Linux evdev numbering (`BTN_LEFT` = 0x110).
///
/// evdev rather than the browser's 0/1/2, because that is what Wayland clients
/// receive and what `wl_pointer` documents. Translating once in the shell is
/// better than every consumer guessing.
pub type ButtonCode = u32;

/// A key, using Linux evdev numbering (`KEY_A` = 30).
///
/// The browser reports `KeyboardEvent.code`, a physical-key name like `"KeyA"`.
/// The shell maps that to evdev here rather than sending the string, because
/// the engine would otherwise need the same table plus a parser, and because
/// evdev codes are what xkb actually consumes (as `code + 8`).
///
/// Deliberately not `KeyboardEvent.key`: that is the *character produced*,
/// which already has the layout and modifiers applied. Sending it would apply
/// the layout twice, so a Dvorak user typing on a remote machine set to QWERTY
/// would get nonsense.
pub type KeyCode = u32;

/// Shell to engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ToEngine {
    /// The complete desired layout. Windows absent from `windows` are hidden.
    ///
    /// Declarative and total rather than incremental: the shell sends what it
    /// wants the world to look like and the engine reconciles. That means a
    /// dropped message cannot leave the two disagreeing, which matters a lot
    /// more once this is going over a mobile network.
    #[serde(rename_all = "camelCase")]
    SetLayout {
        windows: Vec<WindowLayout>,
        /// Absent means apply immediately, with no animation.
        animate: Option<Animation>,
    },
    #[serde(rename_all = "camelCase")]
    FocusWindow { id: WindowId },
    #[serde(rename_all = "camelCase")]
    CloseWindow { id: WindowId },
    /// Launch a program. The engine sets `WAYLAND_DISPLAY` to its own socket.
    #[serde(rename_all = "camelCase")]
    Spawn { command: String },

    /// Pointer moved within a window.
    ///
    /// # Why coordinates are window-relative
    ///
    /// `x` and `y` are logical pixels from the window's top-left, not from the
    /// output's. During a spring animation the engine's actual window position
    /// differs from the target the shell last computed, so output-relative
    /// coordinates would land the click wherever the window *was going to be*
    /// rather than where it is. Naming the window removes the ambiguity
    /// entirely, and the engine already knows where it put things.
    #[serde(rename_all = "camelCase")]
    PointerMotion { window: WindowId, x: f64, y: f64 },

    /// Pointer button pressed or released, on the window last moved over.
    #[serde(rename_all = "camelCase")]
    PointerButton { button: ButtonCode, pressed: bool },

    /// Scroll. Values are logical pixels, positive right and down.
    #[serde(rename_all = "camelCase")]
    PointerAxis { horizontal: f64, vertical: f64 },

    /// The pointer left the shell's window area entirely.
    #[serde(rename_all = "camelCase")]
    PointerLeave,

    /// Key pressed or released. Goes to whatever has keyboard focus.
    #[serde(rename_all = "camelCase")]
    Key { key: KeyCode, pressed: bool },

    /// A finger touched down. `id` distinguishes simultaneous fingers.
    ///
    /// Touch is first-class rather than synthesised into pointer events,
    /// because `wl_touch` exists and clients that support it handle multi-touch
    /// properly. Faking a pointer would throw away every finger but one.
    #[serde(rename_all = "camelCase")]
    TouchDown {
        window: WindowId,
        id: i32,
        x: f64,
        y: f64,
    },

    #[serde(rename_all = "camelCase")]
    TouchMotion {
        window: WindowId,
        id: i32,
        x: f64,
        y: f64,
    },

    #[serde(rename_all = "camelCase")]
    TouchUp { id: i32 },

    /// Which windows the shell wants pixels for.
    ///
    /// Total, like `SetLayout`: windows not listed stop streaming. A shell that
    /// composites locally (the native backend) asks for none; a browser asks
    /// for the ones its viewport can actually show.
    ///
    /// This is what bounds the encoder budget. Only columns intersecting the
    /// viewport need streaming, so cost scales with viewport width rather than
    /// with how many windows are open. See docs/architecture.md section 2.3.
    #[serde(rename_all = "camelCase")]
    SetStreams { windows: Vec<WindowId> },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(value).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn messages_survive_a_roundtrip() {
        let hello = ToShell::Hello {
            protocol_version: PROTOCOL_VERSION,
            output: Output {
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
            windows: vec![WindowInfo {
                id: WindowId(1),
                app_id: Some("Alacritty".into()),
                title: None,
            }],
            focused: Some(WindowId(1)),
        };
        assert_eq!(roundtrip(&hello), hello);

        let layout = ToEngine::SetLayout {
            windows: vec![WindowLayout {
                id: WindowId(7),
                rect: Rect {
                    x: 12.5,
                    y: 12.0,
                    width: 960.0,
                    height: 1056.0,
                },
                z: 3,
            }],
            animate: Some(Animation {
                spring: SpringSpec::default(),
            }),
        };
        assert_eq!(roundtrip(&layout), layout);
    }

    #[test]
    fn enums_are_tagged_on_type_in_camel_case() {
        // The TypeScript side discriminates on this exact field and these exact
        // values, so pin them rather than leaving them to serde's defaults.
        let json = serde_json::to_string(&ToShell::WindowClosed { id: WindowId(4) }).unwrap();
        assert_eq!(json, r#"{"type":"windowClosed","id":4}"#);

        let json = serde_json::to_string(&ToEngine::FocusWindow { id: WindowId(4) }).unwrap();
        assert_eq!(json, r#"{"type":"focusWindow","id":4}"#);
    }

    #[test]
    fn window_id_is_a_bare_number_on_the_wire() {
        // Transparent, so the shell can use it as an object key and a Map key
        // without unwrapping.
        assert_eq!(serde_json::to_string(&WindowId(42)).unwrap(), "42");
    }

    #[test]
    fn fields_are_camel_case() {
        let json = serde_json::to_string(&WindowInfo {
            id: WindowId(1),
            app_id: Some("foo".into()),
            title: None,
        })
        .unwrap();
        assert!(json.contains("\"appId\""), "got {json}");
        assert!(!json.contains("app_id"), "got {json}");
    }

    #[test]
    fn absent_animation_is_distinguishable_from_a_default_one() {
        // "apply immediately" and "animate with default springs" are different
        // instructions, so null must not silently become a default.
        let immediate = ToEngine::SetLayout {
            windows: vec![],
            animate: None,
        };
        let json = serde_json::to_string(&immediate).unwrap();
        assert!(json.contains("\"animate\":null"), "got {json}");
        assert_eq!(roundtrip(&immediate), immediate);
    }

    #[test]
    fn unknown_message_types_are_rejected_not_ignored() {
        // A shell speaking a newer protocol must fail loudly here rather than
        // have its instruction silently dropped.
        let err = serde_json::from_str::<ToEngine>(r#"{"type":"teleportWindow","id":1}"#);
        assert!(err.is_err());
    }
}

// ---------------------------------------------------------------------------
// Binary frame transport
//
// Window pixels do not go through the JSON messages above. They travel as
// WebSocket *binary* frames with the fixed-size header below, on the same
// socket: text frames are control, binary frames are pixels.
//
// One socket rather than two because the ordering between "this window now
// exists" and "here are its pixels" matters, and two sockets would need
// resequencing to get it.
// ---------------------------------------------------------------------------

/// Identifies an lwfa binary frame. Guards against a stray binary message being
/// interpreted as pixel data.
pub const FRAME_MAGIC: [u8; 4] = *b"LWFA";

/// Bumped when the header layout changes. Independent of [`PROTOCOL_VERSION`]
/// so the pixel format can evolve without a control-plane break.
pub const FRAME_VERSION: u8 = 0;

/// Bytes before the payload.
pub const FRAME_HEADER_LEN: usize = 24;

/// How a frame's payload is encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum FrameFormat {
    /// Baseline JPEG.
    ///
    /// Every frame is compressed whole, so a static window costs as much as a
    /// moving one. Kept as the fallback for when no hardware encoder session is
    /// available: the dev GPU allows 8 concurrent NVENC sessions, and a ninth
    /// streaming window has to degrade rather than go blank.
    Jpeg = 0,

    /// H.264, Annex B, baseline-compatible.
    ///
    /// The normal path. Inter-frame prediction means an idle window costs
    /// almost nothing, which is what makes streaming several windows over a
    /// mobile connection plausible at all. Measured on this hardware at 3.7 KB
    /// per frame against JPEG's 30.5 KB for the same 631x1366 window.
    ///
    /// Annex B with SPS/PPS repeated on every keyframe, rather than AVCC with
    /// an out-of-band `description`. That is what lets a browser attach
    /// mid-stream and start decoding at the next keyframe without the engine
    /// having to remember what each client has seen.
    H264 = 1,
}

impl FrameFormat {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Jpeg),
            1 => Some(Self::H264),
            _ => None,
        }
    }

    /// True when a decoder can start from this frame alone.
    pub fn is_self_contained(self) -> bool {
        matches!(self, Self::Jpeg)
    }
}

/// Fixed-size header on every binary frame. Little-endian.
///
/// Layout:
/// ```text
/// 0..4    magic "LWFA"
/// 4       version
/// 5       format
/// 6       flags           bit 0 = keyframe
/// 7       reserved (zero)
/// 8..16   window id       u64
/// 16..20  width           u32
/// 20..24  height          u32
/// 24..    payload
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub window: WindowId,
    pub width: u32,
    pub height: u32,
    pub format: FrameFormat,
    /// A decoder can start here. Always true for JPEG; true for H.264 IDRs.
    ///
    /// Without this the browser cannot tell when it is safe to begin decoding
    /// a stream it joined partway through, and feeding a decoder delta frames
    /// with no reference produces either errors or garbage.
    pub keyframe: bool,
}

/// Bit 0 of the flags byte.
const FLAG_KEYFRAME: u8 = 1 << 0;

impl FrameHeader {
    /// Serialise the header into a buffer sized for the payload that follows.
    pub fn encode_with_payload(&self, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
        out.extend_from_slice(&FRAME_MAGIC);
        out.push(FRAME_VERSION);
        out.push(self.format as u8);
        out.push(if self.keyframe { FLAG_KEYFRAME } else { 0 });
        out.push(0); // reserved
        out.extend_from_slice(&self.window.0.to_le_bytes());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// Parse a header and return it alongside the payload.
    ///
    /// Returns `None` rather than a partial result on anything unexpected, so a
    /// malformed frame is dropped rather than rendered as garbage.
    pub fn decode(bytes: &[u8]) -> Option<(Self, &[u8])> {
        if bytes.len() < FRAME_HEADER_LEN {
            return None;
        }
        if bytes[0..4] != FRAME_MAGIC || bytes[4] != FRAME_VERSION {
            return None;
        }
        let format = FrameFormat::from_u8(bytes[5])?;
        let keyframe = bytes[6] & FLAG_KEYFRAME != 0;
        let window = WindowId(u64::from_le_bytes(bytes[8..16].try_into().ok()?));
        let width = u32::from_le_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_le_bytes(bytes[20..24].try_into().ok()?);
        // A zero-sized frame is meaningless and would divide by zero downstream.
        if width == 0 || height == 0 {
            return None;
        }
        Some((
            Self {
                window,
                width,
                height,
                format,
                keyframe,
            },
            &bytes[FRAME_HEADER_LEN..],
        ))
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    fn header() -> FrameHeader {
        FrameHeader {
            window: WindowId(7),
            width: 1261,
            height: 1390,
            format: FrameFormat::H264,
            keyframe: true,
        }
    }

    #[test]
    fn header_roundtrips_with_its_payload() {
        let payload = b"\xff\xd8\xff\xe0 pretend jpeg";
        let bytes = header().encode_with_payload(payload);
        assert_eq!(bytes.len(), FRAME_HEADER_LEN + payload.len());

        let (decoded, rest) = FrameHeader::decode(&bytes).expect("should decode");
        assert_eq!(decoded, header());
        assert_eq!(rest, payload);
    }

    #[test]
    fn header_is_exactly_the_documented_size() {
        // The TypeScript side slices at this offset, so it is part of the wire
        // contract rather than an implementation detail.
        assert_eq!(header().encode_with_payload(&[]).len(), FRAME_HEADER_LEN);
    }

    #[test]
    fn rejects_a_foreign_binary_message() {
        assert!(FrameHeader::decode(b"this is not a frame at all, honestly").is_none());
    }

    #[test]
    fn rejects_a_future_version() {
        let mut bytes = header().encode_with_payload(b"x");
        bytes[4] = FRAME_VERSION + 1;
        assert!(FrameHeader::decode(&bytes).is_none());
    }

    #[test]
    fn rejects_an_unknown_format() {
        let mut bytes = header().encode_with_payload(b"x");
        bytes[5] = 99;
        assert!(FrameHeader::decode(&bytes).is_none());
    }

    #[test]
    fn rejects_a_truncated_header() {
        let bytes = header().encode_with_payload(b"payload");
        for len in 0..FRAME_HEADER_LEN {
            assert!(
                FrameHeader::decode(&bytes[..len]).is_none(),
                "{len} bytes should not decode"
            );
        }
    }

    #[test]
    fn rejects_zero_dimensions() {
        // Would divide by zero when scaling in the browser.
        let bytes = FrameHeader {
            width: 0,
            ..header()
        }
        .encode_with_payload(b"x");
        assert!(FrameHeader::decode(&bytes).is_none());
    }

    #[test]
    fn the_keyframe_flag_survives_a_roundtrip() {
        // The browser gates decoding on this. If it were dropped, a stream
        // joined mid-flight would never start.
        for keyframe in [true, false] {
            let bytes = FrameHeader {
                keyframe,
                ..header()
            }
            .encode_with_payload(b"x");
            let (decoded, _) = FrameHeader::decode(&bytes).expect("should decode");
            assert_eq!(decoded.keyframe, keyframe);
        }
    }

    #[test]
    fn both_formats_roundtrip() {
        for format in [FrameFormat::Jpeg, FrameFormat::H264] {
            let bytes = FrameHeader { format, ..header() }.encode_with_payload(b"x");
            let (decoded, _) = FrameHeader::decode(&bytes).expect("should decode");
            assert_eq!(decoded.format, format);
        }
    }

    #[test]
    fn only_jpeg_is_self_contained() {
        // H.264 deltas need a reference frame; JPEG never does. This is what
        // decides whether the fallback path can skip keyframe bookkeeping.
        assert!(FrameFormat::Jpeg.is_self_contained());
        assert!(!FrameFormat::H264.is_self_contained());
    }

    #[test]
    fn accepts_an_empty_payload() {
        let bytes = header().encode_with_payload(&[]);
        let (_, payload) = FrameHeader::decode(&bytes).expect("should decode");
        assert!(payload.is_empty());
    }
}
