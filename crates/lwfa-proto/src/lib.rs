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
