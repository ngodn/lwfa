//! Input handling and keybinds.
//!
//! # Which binds live here
//!
//! Only ones that are not layout policy. Quit and spawn are engine concerns;
//! "focus the column to the left" is not, so it goes to the shell as a
//! [`ToShell::KeyBinding`] and the shell decides what it means. Keeping a
//! second opinion about focus order in Rust would be the same
//! two-implementations-drifting problem the spring parity work exists to avoid.
//!
//! When no shell is connected the engine falls back to cycling windows, so the
//! compositor is still usable enough to start one. See `layout::Mode::Safe`.
//!
//! # Why Alt and not Super
//!
//! In the nested backend the host compositor sees keys first and has Super
//! bound heavily, so Super combinations never reach us. The TTY backend will
//! move these to Super.

use smithay::backend::input::{
    AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputBackend, InputEvent,
    KeyState, KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent,
};
use smithay::input::keyboard::{FilterResult, keysyms};
use smithay::input::pointer::{AxisFrame, ButtonEvent, MotionEvent};
use smithay::utils::SERIAL_COUNTER;

use crate::layout::Mode;
use crate::state::Lwfa;
use lwfa_proto::Modifiers;

/// A keybind resolved into something to do. Returned out of the keyboard filter
/// so the action runs outside the borrow the filter holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Quit,
    SpawnTerminal,
    /// Not handled here. Handed to the shell, which owns layout policy.
    Forward {
        key: String,
        modifiers: Modifiers,
    },
}

/// xkb keysym to the name the protocol uses.
///
/// A small table rather than `xkb_keysym_get_name`, because only the keys the
/// shell can bind need to cross the wire, and an explicit list means an
/// unexpected keysym is dropped rather than sent as something unnameable.
fn keysym_name(raw: u32) -> Option<&'static str> {
    Some(match raw {
        keysyms::KEY_h | keysyms::KEY_H => "h",
        keysyms::KEY_j | keysyms::KEY_J => "j",
        keysyms::KEY_k | keysyms::KEY_K => "k",
        keysyms::KEY_l | keysyms::KEY_L => "l",
        keysyms::KEY_w | keysyms::KEY_W => "w",
        keysyms::KEY_Left => "Left",
        keysyms::KEY_Right => "Right",
        keysyms::KEY_Up => "Up",
        keysyms::KEY_Down => "Down",
        keysyms::KEY_1 => "1",
        keysyms::KEY_2 => "2",
        keysyms::KEY_3 => "3",
        keysyms::KEY_4 => "4",
        _ => return None,
    })
}

impl Lwfa {
    fn run_action(&mut self, action: Action) {
        match action {
            Action::Quit => self.loop_signal.stop(),
            Action::SpawnTerminal => self.spawn_terminal(),
            Action::Forward { key, modifiers } => {
                if self.layout.mode() == Mode::Shell {
                    self.forward_key_binding(key, modifiers);
                } else {
                    self.safe_mode_binding(&key);
                }
            }
        }
    }

    /// Minimal window cycling for when no shell is connected.
    ///
    /// Enough to reach a browser and start the shell, and no more. This is not
    /// a layout engine; see `layout::Mode::Safe`.
    fn safe_mode_binding(&mut self, key: &str) {
        let ids = self.layout.all_ids();
        if ids.is_empty() {
            return;
        }
        let current = self
            .focused()
            .and_then(|id| ids.iter().position(|x| *x == id))
            .unwrap_or(0);

        let next = match key {
            "h" | "Left" => current.checked_sub(1).unwrap_or(ids.len() - 1),
            "l" | "Right" => (current + 1) % ids.len(),
            "w" => {
                if let Some(id) = self.focused() {
                    self.request_close(id);
                }
                return;
            }
            _ => return,
        };

        self.set_focus(Some(ids[next]), true);
        self.apply_safe_mode();
    }

    /// Politely ask a window to close. The client decides whether to.
    pub fn request_close(&self, id: lwfa_proto::WindowId) {
        let Some(window) = self.layout.window(id) else {
            return;
        };
        match window.underlying_surface() {
            smithay::desktop::WindowSurface::Wayland(toplevel) => toplevel.send_close(),
            smithay::desktop::WindowSurface::X11(x11) => {
                if let Err(err) = x11.close() {
                    tracing::warn!("failed to close an X11 window: {err}");
                }
            }
        }
    }

    pub fn spawn(&self, command: &str) {
        let mut cmd = std::process::Command::new(command);
        cmd.env("WAYLAND_DISPLAY", &self.socket_name);

        // Set per-process rather than with `set_var`, which is unsafe in
        // edition 2024 and genuinely racy here: by the time Xwayland reports
        // ready, the encoder and shell threads are already running and could be
        // reading the environment.
        match self.xdisplay {
            Some(n) => {
                cmd.env("DISPLAY", format!(":{n}"));
            }
            // Explicitly cleared, not left inherited. Otherwise a client would
            // find the *host* compositor's X server and open its window there,
            // outside lwfa entirely.
            None => {
                cmd.env_remove("DISPLAY");
            }
        }

        match cmd.spawn() {
            Ok(_) => tracing::info!("spawned {command}"),
            Err(err) => tracing::error!("failed to spawn {command}: {err}"),
        }
    }

    pub fn spawn_terminal(&self) {
        let terminal = std::env::var("LWFA_TERMINAL").unwrap_or_else(|_| "alacritty".to_string());
        self.spawn(&terminal);
    }

    pub fn process_input_event<I: InputBackend>(&mut self, event: InputEvent<I>) {
        match event {
            InputEvent::Keyboard { event, .. } => {
                let serial = SERIAL_COUNTER.next_serial();
                let time = Event::time_msec(&event);
                let pressed = event.state() == KeyState::Pressed;

                let Some(keyboard) = self.seat.get_keyboard() else {
                    return;
                };

                // Returning Intercept swallows the key so the focused client
                // never sees a bind.
                let action = keyboard.input::<Action, _>(
                    self,
                    event.key_code(),
                    event.state(),
                    serial,
                    time,
                    |_, modifiers, handle| {
                        if !pressed || !modifiers.alt {
                            return FilterResult::Forward;
                        }
                        let raw = handle.modified_sym().raw();
                        match raw {
                            keysyms::KEY_q | keysyms::KEY_Q => {
                                FilterResult::Intercept(Action::Quit)
                            }
                            keysyms::KEY_Return => FilterResult::Intercept(Action::SpawnTerminal),
                            _ => match keysym_name(raw) {
                                Some(key) => FilterResult::Intercept(Action::Forward {
                                    key: key.to_string(),
                                    modifiers: Modifiers {
                                        alt: modifiers.alt,
                                        ctrl: modifiers.ctrl,
                                        shift: modifiers.shift,
                                        logo: modifiers.logo,
                                    },
                                }),
                                None => FilterResult::Forward,
                            },
                        }
                    },
                );

                if let Some(action) = action {
                    self.run_action(action);
                }
            }

            InputEvent::PointerMotionAbsolute { event, .. } => {
                let Some(output) = self.space.outputs().next() else {
                    return;
                };
                let Some(output_geo) = self.space.output_geometry(output) else {
                    return;
                };
                let pos = event.position_transformed(output_geo.size) + output_geo.loc.to_f64();
                let serial = SERIAL_COUNTER.next_serial();
                let Some(pointer) = self.seat.get_pointer() else {
                    return;
                };
                let under = self.surface_under(pos);

                pointer.motion(
                    self,
                    under,
                    &MotionEvent {
                        location: pos,
                        serial,
                        time: event.time_msec(),
                    },
                );
                pointer.frame(self);
            }

            InputEvent::PointerButton { event, .. } => {
                let Some(pointer) = self.seat.get_pointer() else {
                    return;
                };
                let serial = SERIAL_COUNTER.next_serial();
                let button_state = event.state();

                if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
                    let clicked = self
                        .space
                        .element_under(pointer.current_location())
                        .map(|(w, _)| w.clone())
                        .and_then(|w| self.layout.id_of(&w));

                    match clicked {
                        // Click to focus. The shell is told, because it did not
                        // initiate this and its own focus state would go stale.
                        Some(id) => self.set_focus(Some(id), true),
                        None => {
                            if let Some(keyboard) = self.seat.get_keyboard() {
                                keyboard.set_focus(
                                    self,
                                    Option::<crate::focus::KeyboardFocus>::None,
                                    serial,
                                );
                            }
                        }
                    }
                }

                pointer.button(
                    self,
                    &ButtonEvent {
                        button: event.button_code(),
                        state: button_state,
                        serial,
                        time: event.time_msec(),
                    },
                );
                pointer.frame(self);
            }

            InputEvent::PointerAxis { event, .. } => {
                let source = event.source();

                let horizontal = event.amount(Axis::Horizontal).unwrap_or_else(|| {
                    event.amount_v120(Axis::Horizontal).unwrap_or(0.0) * 15.0 / 120.0
                });
                let vertical = event.amount(Axis::Vertical).unwrap_or_else(|| {
                    event.amount_v120(Axis::Vertical).unwrap_or(0.0) * 15.0 / 120.0
                });

                let mut frame = AxisFrame::new(event.time_msec()).source(source);
                if horizontal != 0.0 {
                    frame = frame.value(Axis::Horizontal, horizontal);
                    if let Some(discrete) = event.amount_v120(Axis::Horizontal) {
                        frame = frame.v120(Axis::Horizontal, discrete as i32);
                    }
                }
                if vertical != 0.0 {
                    frame = frame.value(Axis::Vertical, vertical);
                    if let Some(discrete) = event.amount_v120(Axis::Vertical) {
                        frame = frame.v120(Axis::Vertical, discrete as i32);
                    }
                }
                if source == AxisSource::Finger {
                    if event.amount(Axis::Horizontal) == Some(0.0) {
                        frame = frame.stop(Axis::Horizontal);
                    }
                    if event.amount(Axis::Vertical) == Some(0.0) {
                        frame = frame.stop(Axis::Vertical);
                    }
                }

                let Some(pointer) = self.seat.get_pointer() else {
                    return;
                };
                pointer.axis(self, frame);
                pointer.frame(self);
            }

            _ => {}
        }
    }
}
