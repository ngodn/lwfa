//! Injecting input that arrived from a remote shell.
//!
//! A browser cannot produce libinput events, so these bypass the input backend
//! and go straight to the seat. From a Wayland client's point of view there is
//! no difference: it receives ordinary `wl_pointer`, `wl_keyboard` and
//! `wl_touch` events and cannot tell whether the finger was on this machine.
//!
//! # Coordinates
//!
//! Everything arrives window-relative and is converted to output coordinates
//! here, using where the engine has *actually* placed the window this frame.
//! The shell's own idea of the position can be ahead of the engine's while a
//! spring is still running, so trusting shell-supplied output coordinates would
//! land clicks where the window is heading rather than where it is.
//!
//! # Security
//!
//! This is remote control of the machine: whatever can reach the shell socket
//! can type into any window. The socket is localhost-only and unauthenticated,
//! and it must stay that way until real auth exists. See `shell.rs`.

use lwfa_proto::{ButtonCode, KeyCode, WindowId};
use smithay::backend::input::{ButtonState, KeyState};
use smithay::input::keyboard::{FilterResult, Keycode};
use smithay::input::pointer::{AxisFrame, ButtonEvent, MotionEvent};
use smithay::input::touch::{DownEvent, MotionEvent as TouchMotionEvent, UpEvent};
use smithay::utils::{Logical, Point, SERIAL_COUNTER};

use crate::state::Lwfa;

/// evdev keycodes are offset by 8 to become xkb keycodes.
///
/// This is a fixed part of the X11/xkb protocol, not a tunable.
const XKB_KEYCODE_OFFSET: u32 = 8;

impl Lwfa {
    /// Where a window-relative point lands in output coordinates.
    ///
    /// Uses the engine's current placement, not the shell's target. Returns
    /// `None` if the window is not currently placed, which happens when the
    /// shell sends input for something it has just scrolled off.
    fn window_point(&self, window: WindowId, x: f64, y: f64) -> Option<Point<f64, Logical>> {
        let target = self.layout.window(window)?;
        let (_, location) = self
            .layout
            .placements()
            .into_iter()
            .find(|(w, _)| w == target)?;
        Some(Point::from((location.x as f64 + x, location.y as f64 + y)))
    }

    pub fn remote_pointer_motion(&mut self, window: WindowId, x: f64, y: f64) {
        let Some(location) = self.window_point(window, x, y) else {
            return;
        };
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();
        let under = self.surface_under(location);

        pointer.motion(
            self,
            under,
            &MotionEvent {
                location,
                serial,
                time: self.millis(),
            },
        );
        pointer.frame(self);
    }

    pub fn remote_pointer_button(&mut self, button: ButtonCode, pressed: bool) {
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();

        // Clicking focuses, exactly as a local click does. Without this a
        // remote user could click a window and still type into another one.
        if pressed && !pointer.is_grabbed() {
            let clicked = self
                .space
                .element_under(pointer.current_location())
                .map(|(w, _)| w.clone())
                .and_then(|w| self.layout.id_of(&w));
            // One line per click. Cheap, off unless RUST_LOG asks for it, and
            // the only thing that answers "the click went to the wrong window".
            tracing::debug!(
                "click at ({:.0},{:.0}) -> window {:?}, focused was {:?}",
                pointer.current_location().x,
                pointer.current_location().y,
                clicked,
                self.focused(),
            );
            if let Some(id) = clicked {
                if self.focused() != Some(id) {
                    self.set_focus(Some(id), true);
                }
            }
        }

        pointer.button(
            self,
            &ButtonEvent {
                button,
                state: if pressed {
                    ButtonState::Pressed
                } else {
                    ButtonState::Released
                },
                serial,
                time: self.millis(),
            },
        );
        pointer.frame(self);
    }

    pub fn remote_pointer_axis(&mut self, horizontal: f64, vertical: f64) {
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let mut frame =
            AxisFrame::new(self.millis()).source(smithay::backend::input::AxisSource::Continuous);
        if horizontal != 0.0 {
            frame = frame.value(smithay::backend::input::Axis::Horizontal, horizontal);
        }
        if vertical != 0.0 {
            frame = frame.value(smithay::backend::input::Axis::Vertical, vertical);
        }
        pointer.axis(self, frame);
        pointer.frame(self);
    }

    pub fn remote_pointer_leave(&mut self) {
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();
        // Motion with no surface under it is how Wayland expresses a leave.
        pointer.motion(
            self,
            None,
            &MotionEvent {
                location: pointer.current_location(),
                serial,
                time: self.millis(),
            },
        );
        pointer.frame(self);
    }

    pub fn remote_key(&mut self, key: KeyCode, pressed: bool) {
        let Some(keyboard) = self.seat.get_keyboard() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();
        let time = self.millis();

        keyboard.input::<(), _>(
            self,
            Keycode::from(key + XKB_KEYCODE_OFFSET),
            if pressed {
                KeyState::Pressed
            } else {
                KeyState::Released
            },
            serial,
            time,
            // Forward everything. Engine-level binds are for the local
            // keyboard; a remote shell has its own UI for those, and
            // intercepting here would silently swallow keys the user meant for
            // their application.
            |_, _, _| FilterResult::Forward,
        );
    }

    pub fn remote_touch_down(&mut self, window: WindowId, id: i32, x: f64, y: f64) {
        let Some(location) = self.window_point(window, x, y) else {
            return;
        };
        let Some(touch) = self.seat.get_touch() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();
        let under = self.surface_under(location);
        let time = self.millis();

        // A touch is also a focus change, the same way a click is.
        if self.focused() != Some(window) {
            self.set_focus(Some(window), true);
        }

        touch.down(
            self,
            under,
            &DownEvent {
                slot: Some(id as u32).into(),
                location,
                serial,
                time,
            },
        );
        touch.frame(self);
    }

    pub fn remote_touch_motion(&mut self, window: WindowId, id: i32, x: f64, y: f64) {
        let Some(location) = self.window_point(window, x, y) else {
            return;
        };
        let Some(touch) = self.seat.get_touch() else {
            return;
        };
        let under = self.surface_under(location);
        let time = self.millis();

        touch.motion(
            self,
            under,
            &TouchMotionEvent {
                slot: Some(id as u32).into(),
                location,
                time,
            },
        );
        touch.frame(self);
    }

    pub fn remote_touch_up(&mut self, id: i32) {
        let Some(touch) = self.seat.get_touch() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();
        let time = self.millis();
        touch.up(
            self,
            &UpEvent {
                slot: Some(id as u32).into(),
                serial,
                time,
            },
        );
        touch.frame(self);
    }

    /// Milliseconds since start, which is what Wayland input events want.
    ///
    /// Clients use this for double-click detection and key repeat, so it has to
    /// be monotonic. It deliberately does not use the browser's timestamps:
    /// those come from a different clock and would jump.
    fn millis(&self) -> u32 {
        self.start_time.elapsed().as_millis() as u32
    }
}
