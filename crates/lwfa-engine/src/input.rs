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

/// Split a desktop entry's `Exec` into argv.
///
/// The freedesktop spec's quoting rules, which are *not* the shell's: double
/// quotes group, a backslash escapes the next character inside them, and there
/// is no globbing, no variable expansion and no operators. Handing this to a
/// shell instead would be both wrong and a way to turn a malformed `Exec` into
/// arbitrary code.
fn split_command_line(line: &str) -> Vec<String> {
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = line.chars();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                // So `""` is an empty argument rather than nothing at all.
                started = true;
            }
            '\\' if quoted => {
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                }
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    argv.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        argv.push(current);
    }
    argv
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

    /// Whether the connected session may run this command.
    ///
    /// `allowed_apps` holds desktop entry *ids*, but what arrives over the wire
    /// is the `Exec=` line the launcher read out of that entry, because that is
    /// what actually gets run. So the entries are resolved and the command is
    /// matched against the ones this account is allowed.
    ///
    /// Compared for equality, not by prefix: permitting `firefox` must not also
    /// permit `firefox; rm -rf ~`, which a `starts_with` check would wave
    /// straight through.
    pub fn may_spawn(&self, command: &str) -> bool {
        let Some(allowed) = self.permissions.allowed_apps.as_ref() else {
            return true; // None means every application.
        };
        if allowed.is_empty() {
            return false;
        }
        crate::apps::installed()
            .into_iter()
            .filter(|app| allowed.iter().any(|id| id == &app.id))
            .any(|app| app.exec == command)
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

    /// Launch a command line, in the compositor's own session.
    ///
    /// `command` is a *command line*, not a program name: a desktop entry's
    /// `Exec` is usually `code --open-url` or `libreoffice --math`, and 59 of
    /// the 139 entries on this machine carry arguments. Passing the whole
    /// string to `Command::new` asks the kernel for a binary literally called
    /// "code --open-url", which does not exist, so every application with a
    /// flag failed to start and only the bare ones worked.
    ///
    /// `in_terminal` reflects the entry's `Terminal=true`, which means the
    /// program writes to a tty and has no window of its own. Launching one
    /// without a terminal around it produces a process that runs, prints into
    /// the void, and never appears.
    pub fn spawn(&self, command: &str, in_terminal: bool) {
        let argv = split_command_line(command);
        let Some((program, args)) = argv.split_first() else {
            tracing::warn!("refusing to spawn an empty command");
            return;
        };

        let terminal = self.config.terminal();
        let mut cmd = if in_terminal {
            // `-e` is the one flag every terminal emulator agrees on.
            let mut wrapper = std::process::Command::new(&terminal);
            wrapper.arg("-e").arg(program).args(args);
            wrapper
        } else {
            let mut direct = std::process::Command::new(program);
            direct.args(args);
            direct
        };
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
            Ok(child) => tracing::info!("spawned {command} as pid {}", child.id()),
            Err(err) => tracing::error!("failed to spawn {command}: {err}"),
        }
    }

    pub fn spawn_terminal(&self) {
        self.spawn(&self.config.terminal(), false);
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

#[cfg(test)]
mod tests {
    use super::split_command_line;

    #[test]
    fn a_bare_program_is_one_argument() {
        assert_eq!(split_command_line("alacritty"), vec!["alacritty"]);
    }

    #[test]
    fn arguments_are_separated() {
        // The case that was broken: 59 of 139 entries on the dev machine look
        // like this, and passing the whole string to Command::new asked for a
        // binary named "code --open-url".
        assert_eq!(
            split_command_line("code --open-url"),
            vec!["code", "--open-url"],
        );
        assert_eq!(
            split_command_line("libreoffice --math"),
            vec!["libreoffice", "--math"],
        );
    }

    #[test]
    fn runs_of_whitespace_do_not_produce_empty_arguments() {
        assert_eq!(split_command_line("  foo   bar  "), vec!["foo", "bar"]);
    }

    #[test]
    fn quotes_group_and_are_removed() {
        // Real entry shape: kde-geo-uri-handler passes URL templates like this.
        assert_eq!(
            split_command_line(r#"handler --template "https://example.com/a b""#),
            vec!["handler", "--template", "https://example.com/a b"],
        );
    }

    #[test]
    fn a_backslash_escapes_inside_quotes() {
        assert_eq!(split_command_line(r#"prog "a\"b""#), vec!["prog", r#"a"b"#],);
    }

    #[test]
    fn an_empty_quoted_string_is_still_an_argument() {
        // Dropping it would silently shift every later positional argument.
        assert_eq!(split_command_line(r#"prog "" x"#), vec!["prog", "", "x"]);
    }

    #[test]
    fn an_empty_line_yields_nothing() {
        assert!(split_command_line("   ").is_empty());
    }
}
