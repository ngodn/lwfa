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
// For `WlSurface::client`, used to find the process behind a window in
// `quit_app`.
use smithay::input::pointer::{AxisFrame, ButtonEvent, MotionEvent};
use smithay::reexports::wayland_server::Resource;
use smithay::utils::{Logical, Physical, Point, Rectangle, SERIAL_COUNTER, Size};
use std::cell::RefCell;

use crate::layout::Mode;
use crate::state::Lwfa;
use lwfa_proto::Modifiers;

#[derive(Default)]
struct PreviewInput {
    size: Option<Size<i32, Physical>>,
    window: Option<lwfa_proto::WindowId>,
    position: Option<Point<f64, Logical>>,
}

fn workspace_position(
    pos: Point<f64, Logical>,
    preview: Rectangle<i32, Logical>,
    actual: Size<i32, Logical>,
) -> Point<f64, Logical> {
    let origin = preview.loc.to_f64();
    origin + (pos - origin).downscale(crate::winit::preview_scale(preview.size, actual, 1.0))
}

#[cfg(test)]
mod preview_input_tests {
    use super::*;

    #[test]
    fn pointer_maps_to_app_pixels_without_scaling_the_windows_position() {
        assert_eq!(
            workspace_position(
                (700.0, 350.0).into(),
                Rectangle::new((200, 100).into(), (1000, 500).into()),
                (2000, 1000).into()
            ),
            (1200.0, 600.0).into()
        );
        assert_eq!(
            workspace_position(
                (700.0, 350.0).into(),
                Rectangle::new((200, 100).into(), (1000, 500).into()),
                (500, 250).into()
            ),
            (450.0, 225.0).into()
        );
    }

    #[test]
    fn drag_coordinates_continue_beyond_the_window_in_the_same_space() {
        assert_eq!(
            workspace_position(
                (120.0, 80.0).into(),
                Rectangle::new((200, 100).into(), (1000, 500).into()),
                (2000, 1000).into()
            ),
            (40.0, 60.0).into()
        );
    }

    #[test]
    fn pointer_uses_committed_dimensions_for_refused_and_anisotropic_resizes() {
        let rect = Rectangle::new((200, 100).into(), (1000, 500).into());
        assert_eq!(
            workspace_position((700.0, 350.0).into(), rect, (1000, 500).into()),
            (700.0, 350.0).into()
        );
        assert_eq!(
            workspace_position((700.0, 350.0).into(), rect, (1200, 800).into()),
            (800.0, 500.0).into()
        );
        // A terminal can round only its height to whole character cells.
        assert_eq!(
            workspace_position((700.0, 350.0).into(), rect, (1000, 504).into()),
            (700.0, 352.0).into()
        );
        // The same inverse projection applies outside a grabbed window.
        assert_eq!(
            workspace_position((100.0, 50.0).into(), rect, (1200, 800).into()),
            (80.0, 20.0).into()
        );
    }
}

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
/// How long to wait for a program to quit before saying it has not.
///
/// Long enough for an application to write its state and put a dialog up,
/// short enough that somebody holding a tablet does not conclude it is broken.
const GRACE: std::time::Duration = std::time::Duration::from_secs(8);

/// How often to look. Cheap: one `readdir` of `/proc` per tick.
const POLL: std::time::Duration = std::time::Duration::from_millis(400);

/// Where applications should start: the user's home.
fn session_home() -> std::path::PathBuf {
    spawn_dir_for(std::env::var_os("HOME"))
}

/// The pure half of [`session_home`].
///
/// `$HOME` when it names an absolute path, and the root otherwise. Root rather
/// than giving up and inheriting the engine's directory: somewhere that exists,
/// is boring, and is the same every time beats somewhere unpredictable.
fn spawn_dir_for(home: Option<std::ffi::OsString>) -> std::path::PathBuf {
    home.filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

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
    fn preview_motion(&mut self, pos: Point<f64, Logical>, time: u32) {
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let serial = SERIAL_COUNTER.next_serial();
        let previous = self
            .seat
            .user_data()
            .get::<RefCell<PreviewInput>>()
            .and_then(|state| state.borrow().window);
        // An implicit button grab keeps the original coordinate space
        // while dragging over neighbouring windows or empty space.
        let hit = if pointer.is_grabbed() {
            previous.and_then(|id| {
                self.layout
                    .window(id)
                    .cloned()
                    .zip(self.layout.preview_rect(id))
                    .map(|(window, rect)| (id, window, rect))
            })
        } else {
            self.layout
                .placements_with_ids()
                .into_iter()
                .rev()
                .find_map(|(id, window, _)| {
                    self.layout
                        .preview_rect(id)
                        .filter(|rect| rect.to_f64().contains(pos))
                        .map(|rect| (id, window, rect))
                })
        };
        let preview_position = pos;
        let (id, pos, under) = match hit {
            Some((id, window, rect)) => {
                let pos = workspace_position(pos, rect, window.geometry().size);
                (Some(id), pos, self.surface_in(&window, rect.loc, pos))
            }
            None => (None, pos, None),
        };
        self.seat
            .user_data()
            .insert_if_missing(|| RefCell::new(PreviewInput::default()));
        self.seat
            .user_data()
            .get::<RefCell<PreviewInput>>()
            .unwrap()
            .borrow_mut()
            .window = id;
        self.seat
            .user_data()
            .get::<RefCell<PreviewInput>>()
            .unwrap()
            .borrow_mut()
            .position = Some(preview_position);

        pointer.motion(
            self,
            under,
            &MotionEvent {
                location: pos,
                serial,
                time,
            },
        );
        pointer.frame(self);
    }

    pub(crate) fn set_preview_size(&self, size: Size<i32, Physical>) {
        self.seat
            .user_data()
            .insert_if_missing(|| RefCell::new(PreviewInput::default()));
        self.seat
            .user_data()
            .get::<RefCell<PreviewInput>>()
            .unwrap()
            .borrow_mut()
            .size = Some(size);
    }

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

    /// Whether a set of permissions allows running this command.
    ///
    /// `allowed_apps` holds desktop entry *ids*, but what arrives over the wire
    /// is the `Exec=` line the launcher read out of that entry, because that is
    /// what actually gets run. So the entries are resolved and the command is
    /// matched against the ones this account is allowed.
    ///
    /// Compared for equality, not by prefix: permitting `firefox` must not also
    /// permit `firefox; rm -rf ~`, which a `starts_with` check would wave
    /// straight through.
    pub fn may_spawn(permissions: &lwfa_proto::Permissions, command: &str) -> bool {
        let Some(allowed) = permissions.allowed_apps.as_ref() else {
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

    /// End the process behind a window.
    ///
    /// `request_close` asks and the application decides, which is what a close
    /// button should do. This is the other thing: for applications that stay
    /// resident with no windows open, it is the only way to give the host its
    /// single instance back without stopping the whole session. See
    /// `ToEngine::QuitApp`.
    ///
    /// SIGTERM, never SIGKILL. A resident application still gets to run its
    /// shutdown path and save what it has; the point is to end it, not to
    /// destroy it. An application that ignores SIGTERM is one the user can
    /// deal with by hand, which is better than lwfa deciding for them.
    pub fn quit_app(&self, id: lwfa_proto::WindowId, session: lwfa_proto::SessionId) {
        let Some(window) = self.layout.window(id) else {
            return;
        };
        let pid = match window.underlying_surface() {
            smithay::desktop::WindowSurface::Wayland(toplevel) => toplevel
                .wl_surface()
                .client()
                .and_then(|client| client.get_credentials(&self.display_handle).ok())
                .map(|creds| creds.pid),
            // X11 clients report it themselves through _NET_WM_PID, so it is a
            // claim rather than a kernel fact. Good enough here: the worst case
            // is a signal that does not land, not one that lands elsewhere,
            // because Xwayland only reports pids for its own clients.
            smithay::desktop::WindowSurface::X11(x11) => x11.pid().map(|pid| pid as i32),
        };

        let Some(pid) = pid else {
            tracing::warn!("no pid for window {id:?}; cannot quit it");
            self.send_to_session(
                session,
                lwfa_proto::ToShell::Error {
                    request: "quitApp".into(),
                    message: "could not find the process behind that window".into(),
                },
            );
            return;
        };

        // Through `rustix` for the same reason as `close_and_spawn`: this crate
        // denies unsafe code and one syscall is no reason for an exception.
        let sent = rustix::process::Pid::from_raw(pid)
            .ok_or_else(|| std::io::Error::other("not a valid pid"))
            .and_then(|pid| {
                rustix::process::kill_process(pid, rustix::process::Signal::TERM)
                    .map_err(Into::into)
            });

        match sent {
            Ok(()) => tracing::info!("sent SIGTERM to {pid}, the process behind window {id:?}"),
            Err(err) => {
                tracing::warn!("could not quit the process behind window {id:?}: {err}");
                self.send_to_session(
                    session,
                    lwfa_proto::ToShell::Error {
                        request: "quitApp".into(),
                        message: format!("could not quit that application: {err}"),
                    },
                );
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
    pub fn spawn(&mut self, command: &str, in_terminal: bool) {
        self.autostart_pending = false;
        if self.config.xwayland() {
            // A browser sends its viewport before launching an app. Hold an
            // early launch too, so no child can cache the host's monitor size
            // or start without this session's DISPLAY.
            if !self.x11_start_attempted {
                if self.primary.is_some() && self.viewport_override.is_none() {
                    self.pending_x11_spawns.push((command.to_owned(), in_terminal));
                    return;
                }
                crate::init_xwayland(self);
            }
            if self.x11_start_pending {
                self.pending_x11_spawns.push((command.to_owned(), in_terminal));
                return;
            }
        }
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

        // The separate Wine canvas compatibility tool reads these options.
        // Stock Wine ignores them. Scope them to nested applications so using
        // that same tool on the host keeps its ordinary display behavior.
        if self.resize_output.is_some() {
            cmd.env("WINE_CANVAS_FOLLOW_HOST", "1");
            cmd.env("WINE_CANVAS_DPI_SAFE", "1");
        }

        // Start where a login session would, not where the compositor was
        // launched from.
        //
        // A child inherits the parent's working directory, and the engine's is
        // wherever somebody happened to run it: a checkout, `/` under a systemd
        // unit, or whatever directory a terminal was sitting in. Every terminal
        // and every file dialog for the rest of the session then opens there,
        // which is confusing at best and leaks the path at worst.
        cmd.current_dir(session_home());

        // Point the application at the session's own audio device, so what it
        // plays goes to whoever is listening remotely rather than out of the
        // speakers of a machine nobody may be sitting at. See `sink.rs`.
        //
        // Only when that sink exists: without it the variable would name a
        // device that is not there and the application would get no audio at
        // all, which is worse than the machine making a noise.
        if self.audio_sink.available() {
            cmd.env("PULSE_SINK", crate::sink::SINK_NAME);
        }

        // The private portal bus, so this application's file dialogs open on
        // the connected device instead of on the host's physical display.
        // Without it the child inherits the host's session bus, asks the
        // host's portal, and the dialog appears on a screen nobody is looking
        // at while the application seems hung from the shell. GTK3 needs the
        // explicit opt-in; GTK4 spells the same request GDK_DEBUG=portals.
        if let Some(portal) = self.portal.as_ref() {
            cmd.env("DBUS_SESSION_BUS_ADDRESS", portal.address());
            cmd.env("GTK_USE_PORTAL", "1");
            cmd.env("GDK_DEBUG", "portals");
        }

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

        // Without this the child inherits the engine's blocked SIGTERM and can
        // never be asked to quit. See `crate::childsig`.
        crate::childsig::unblock_signals(&mut cmd);

        match cmd.spawn() {
            Ok(child) => {
                tracing::info!("spawned {command} as pid {}", child.id());
                // Remembered so an application that outlives its last window
                // can still be found. See `Lwfa::windowless`.
                if let Some(program) = crate::outside::program_name(&command) {
                    self.started.insert(child.id(), program);
                }
            }
            Err(err) => tracing::error!("failed to spawn {command}: {err}"),
        }
    }

    /// Is this command already running on the host? See `outside`.
    pub fn running_outside(&self, command: &str) -> Option<crate::outside::Outsider> {
        let program = crate::outside::program_name(command)?;
        crate::outside::find(&program, &self.socket_name)
    }

    /// Ask a program on the host to quit, then launch it in here once it has.
    ///
    /// Asking, not killing. An application with unsaved work answers a polite
    /// request by opening a dialog, and that dialog appears on the screen the
    /// application is on, which is the one nobody is looking at. So the process
    /// is watched rather than assumed dead, and if it is still there when the
    /// grace period ends the shell is told, so it can say what is happening and
    /// offer to insist.
    ///
    /// `force` is that insistence, and it loses unsaved work, so it is never
    /// the first thing tried.
    pub fn close_outside_then_spawn(
        &mut self,
        session: lwfa_proto::SessionId,
        command: String,
        terminal: bool,
        other: crate::outside::Outsider,
        force: bool,
    ) {
        let signal = if force {
            rustix::process::Signal::KILL
        } else {
            rustix::process::Signal::TERM
        };
        // Through `rustix` rather than a raw `kill`, because this crate denies
        // unsafe code and there is no reason to make an exception for one
        // syscall. The pid is re-checked against the program name immediately
        // before this, so a reused pid cannot be signalled by mistake.
        let sent = rustix::process::Pid::from_raw(other.pid as i32)
            .ok_or_else(|| std::io::Error::other("not a valid pid"))
            .and_then(|pid| rustix::process::kill_process(pid, signal).map_err(Into::into));

        if let Err(err) = sent {
            tracing::warn!("could not signal {} ({}): {err}", other.program, other.pid);
            self.send_to_session(
                session,
                lwfa_proto::ToShell::Error {
                    request: "closeAndSpawn".into(),
                    message: format!("could not close {}: {err}", other.program),
                },
            );
            return;
        }
        tracing::info!(
            "asked {} ({}) to quit so it can be opened in this session",
            other.program,
            other.pid
        );

        self.watch_for_exit(session, command, terminal, other, GRACE);
    }

    /// Poll until the program is gone, then spawn it here.
    ///
    /// A timer rather than a blocking wait: the process is not our child, so
    /// there is nothing to `waitpid` on, and blocking the event loop would
    /// freeze every window in the session while an application saves its work.
    fn watch_for_exit(
        &mut self,
        session: lwfa_proto::SessionId,
        command: String,
        terminal: bool,
        other: crate::outside::Outsider,
        left: std::time::Duration,
    ) {
        let handle = self.loop_handle.clone();
        let _ = handle.insert_source(
            smithay::reexports::calloop::timer::Timer::from_duration(POLL),
            move |_, _, data| {
                let state = &mut *data;
                let still_there = state
                    .running_outside(&command)
                    .is_some_and(|now| now.pid == other.pid);

                if !still_there {
                    tracing::info!("{} has gone; opening it here", other.program);
                    state.spawn(&command, terminal);
                    return smithay::reexports::calloop::timer::TimeoutAction::Drop;
                }

                match left.checked_sub(POLL) {
                    Some(remaining) if !remaining.is_zero() => {
                        state.watch_for_exit(
                            session,
                            command.clone(),
                            terminal,
                            other.clone(),
                            remaining,
                        );
                    }
                    _ => {
                        // Still running. Almost always because it is asking
                        // about unsaved work on a screen nobody can see, so the
                        // shell is told rather than left showing a spinner.
                        tracing::info!("{} did not quit within the grace period", other.program);
                        state.send_to_session(
                            session,
                            lwfa_proto::ToShell::AlreadyRunning {
                                command: command.clone(),
                                terminal,
                                program: other.program.clone(),
                                pid: other.pid,
                            },
                        );
                    }
                }
                smithay::reexports::calloop::timer::TimeoutAction::Drop
            },
        );
    }

    pub fn spawn_terminal(&mut self) {
        let terminal = self.config.terminal();
        self.spawn(&terminal, false);
    }

    pub(crate) fn finish_x11_start(&mut self) {
        self.x11_start_pending = false;
        for (command, terminal) in std::mem::take(&mut self.pending_x11_spawns) {
            self.spawn(&command, terminal);
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
                let output = self.layout.output_size();
                let host = self
                    .seat
                    .user_data()
                    .get::<RefCell<PreviewInput>>()
                    .and_then(|state| state.borrow().size)
                    .unwrap_or(output.to_physical(1));
                let fit = crate::winit::preview_fit(host, output);
                let pos = event
                    .position_transformed(host.to_logical(1))
                    .downscale(fit);
                self.preview_motion(pos, event.time_msec());
            }

            InputEvent::PointerButton { event, .. } => {
                let Some(pointer) = self.seat.get_pointer() else {
                    return;
                };
                let button_state = event.state();

                if ButtonState::Pressed == button_state && !pointer.is_grabbed() {
                    // Layout can change under a stationary host cursor.
                    let position = self
                        .seat
                        .user_data()
                        .get::<RefCell<PreviewInput>>()
                        .and_then(|state| state.borrow().position);
                    if let Some(pos) = position {
                        self.preview_motion(pos, event.time_msec());
                    }
                    let clicked = self
                        .seat
                        .user_data()
                        .get::<RefCell<PreviewInput>>()
                        .and_then(|state| state.borrow().window);

                    // Keep activation and stored focus aligned with the seat,
                    // including a click on empty space. Otherwise the guardian
                    // restores the old window after we deliberately cleared it.
                    self.set_focus(clicked, true);
                }

                let serial = SERIAL_COUNTER.next_serial();
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
                if button_state == ButtonState::Released && !pointer.is_grabbed() {
                    let position = self
                        .seat
                        .user_data()
                        .get::<RefCell<PreviewInput>>()
                        .and_then(|state| state.borrow().position);
                    if let Some(pos) = position {
                        self.preview_motion(pos, event.time_msec());
                    }
                }
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
mod spawn_dir_tests {
    use super::spawn_dir_for;
    use std::ffi::OsString;
    use std::path::PathBuf;

    /// A child inherits its parent's working directory, so without this every
    /// terminal opened wherever the engine happened to be started from: a
    /// checkout, or `/` under a systemd unit, or whatever directory somebody
    /// had `cd`ed to. A session's applications should start at home, the same
    /// as they would under any other desktop.
    #[test]
    fn uses_home_when_it_names_one() {
        assert_eq!(
            spawn_dir_for(Some(OsString::from("/home/someone"))),
            PathBuf::from("/home/someone")
        );
    }

    #[test]
    fn falls_back_to_the_root_when_home_is_unset() {
        // Rather than inheriting: somewhere that exists and is the same every
        // time beats somewhere unpredictable.
        assert_eq!(spawn_dir_for(None), PathBuf::from("/"));
    }

    #[test]
    fn refuses_an_empty_home() {
        assert_eq!(spawn_dir_for(Some(OsString::new())), PathBuf::from("/"));
    }

    #[test]
    fn refuses_a_relative_home() {
        // A relative `$HOME` would be resolved against the engine's own
        // directory, which is the thing being avoided.
        assert_eq!(
            spawn_dir_for(Some(OsString::from("somewhere"))),
            PathBuf::from("/")
        );
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
