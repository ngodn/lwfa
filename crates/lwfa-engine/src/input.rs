//! Input handling and keybinds.
//!
//! Binds use Alt rather than Super on purpose. In the nested backend the host
//! compositor (Hyprland here) sees keys first and has Super bound heavily, so
//! Super combinations would never reach us. The TTY backend will move these to
//! Super.

use smithay::backend::input::{
    AbsolutePositionEvent, Axis, AxisSource, ButtonState, Event, InputBackend, InputEvent,
    KeyState, KeyboardKeyEvent, PointerAxisEvent, PointerButtonEvent,
};
use smithay::input::keyboard::{FilterResult, keysyms};
use smithay::input::pointer::{AxisFrame, ButtonEvent, MotionEvent};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::SERIAL_COUNTER;

use crate::state::Lwfa;

/// A keybind resolved into something to do. Returned out of the keyboard filter
/// so the action runs outside the borrow the filter holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Quit,
    SpawnTerminal,
    FocusLeft,
    FocusRight,
    CloseWindow,
}

impl Lwfa {
    /// Give keyboard focus to the strip's focused column.
    pub fn focus_current_window(&mut self) {
        let serial = SERIAL_COUNTER.next_serial();
        let target = self
            .strip
            .focused_window()
            .and_then(|w| w.toplevel())
            .map(|t| t.wl_surface().clone());

        // Activated state drives the client's own focus styling, so it has to
        // track the strip rather than the pointer.
        for column in self.strip.columns() {
            let is_focused = column
                .window
                .toplevel()
                .map(|t| Some(t.wl_surface()) == target.as_ref())
                .unwrap_or(false);
            column.window.set_activated(is_focused);
            if let Some(toplevel) = column.window.toplevel() {
                toplevel.send_pending_configure();
            }
        }

        if let Some(window) = self.strip.focused_window().cloned() {
            self.space.raise_element(&window, false);
        }

        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, target, serial);
        }
    }

    fn run_action(&mut self, action: Action) {
        match action {
            Action::Quit => self.loop_signal.stop(),
            Action::SpawnTerminal => self.spawn_terminal(),
            Action::FocusLeft => {
                self.strip.focus_left();
                self.focus_current_window();
            }
            Action::FocusRight => {
                self.strip.focus_right();
                self.focus_current_window();
            }
            Action::CloseWindow => {
                if let Some(toplevel) = self.strip.focused_window().and_then(|w| w.toplevel()) {
                    toplevel.send_close();
                }
            }
        }
    }

    pub fn spawn_terminal(&self) {
        let terminal = std::env::var("LWFA_TERMINAL").unwrap_or_else(|_| "alacritty".to_string());
        match std::process::Command::new(&terminal)
            .env("WAYLAND_DISPLAY", &self.socket_name)
            .spawn()
        {
            Ok(_) => tracing::info!("spawned {terminal}"),
            Err(err) => {
                tracing::error!("failed to spawn {terminal}: {err}. Set LWFA_TERMINAL to override.")
            }
        }
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
                        let action = match handle.modified_sym().raw() {
                            keysyms::KEY_q | keysyms::KEY_Q => Action::Quit,
                            keysyms::KEY_Return => Action::SpawnTerminal,
                            keysyms::KEY_h | keysyms::KEY_Left => Action::FocusLeft,
                            keysyms::KEY_l | keysyms::KEY_Right => Action::FocusRight,
                            keysyms::KEY_w | keysyms::KEY_W => Action::CloseWindow,
                            _ => return FilterResult::Forward,
                        };
                        FilterResult::Intercept(action)
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
                    // Click to focus. The strip owns focus, so this moves the
                    // strip's focus rather than just handing the surface a
                    // keyboard focus the strip disagrees with.
                    let clicked = self
                        .space
                        .element_under(pointer.current_location())
                        .map(|(w, _)| w.clone());

                    if let Some(window) = clicked {
                        if self.strip.focus_window(&window) {
                            self.focus_current_window();
                        }
                    } else if let Some(keyboard) = self.seat.get_keyboard() {
                        keyboard.set_focus(self, Option::<WlSurface>::None, serial);
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
