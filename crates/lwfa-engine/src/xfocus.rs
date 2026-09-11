//! The X focus guardian: input focus must never point at nothing.
//!
//! # The failure this exists for
//!
//! X keyboard focus and the XWM's active-window property both matter to Wine
//! foreground handling. This fallback repairs only missing keyboard focus;
//! the XWM publishes the active application from focus events. During window
//! churn (a launcher spawning and killing windows, a
//! session reconnecting), the X server's input focus can end up on the void:
//! `GetInputFocus` returns `None`, no window anywhere is focused, and the
//! compositor's own bookkeeping still names a focused window it believes is
//! fine. Caught live, twice: the game dead to a working controller, and one
//! manual `SetInputFocus` bringing it back instantly.
//!
//! # Why a separate X connection
//!
//! Smithay's WM only issues `SetInputFocus` from the keyboard *enter*
//! handler, and offers no way to ask the server what focus currently is. A
//! tiny client connection of our own can ask and repair directly, which is
//! precisely what the manual fix did.
//!
//! # What it will never do
//!
//! Fight a real window. The guardian repairs only the two void states
//! (`None` and `PointerRoot`); a menu, a popup, or any actual window holding
//! focus is left alone.

use x11rb::protocol::xproto::{ConnectionExt as _, InputFocus};
use x11rb::rust_connection::RustConnection;

/// `GetInputFocus` special values: nothing and pointer-root.
const FOCUS_NONE: u32 = 0;
const FOCUS_POINTER_ROOT: u32 = 1;

pub struct Guardian {
    display: String,
    conn: Option<RustConnection>,
}

impl Guardian {
    pub fn new(display_number: u32) -> Self {
        Self {
            display: format!(":{display_number}"),
            conn: None,
        }
    }

    fn conn(&mut self) -> Option<&RustConnection> {
        if self.conn.is_none() {
            match RustConnection::connect(Some(&self.display)) {
                Ok((conn, _)) => self.conn = Some(conn),
                Err(err) => {
                    tracing::debug!("focus guardian cannot reach {}: {err}", self.display);
                    return None;
                }
            }
        }
        self.conn.as_ref()
    }

    fn focus(&mut self) -> Option<u32> {
        let conn = self.conn()?;
        let focus = conn
            .get_input_focus()
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.focus);
        if focus.is_none() {
            // A dead connection (Xwayland restarted); rebuilt next tick.
            self.conn = None;
        }
        focus
    }

    /// A layout repair may restore this target only if no other X window
    /// owns focus. Fail closed when the server cannot be queried.
    pub fn may_reassert(&mut self, expected: u32) -> bool {
        self.focus()
            .is_some_and(|focus| focus == expected || is_void(focus))
    }

    /// Point the input focus at `expected` if it currently points at nothing.
    /// Returns true only after the X server accepts the repair.
    pub fn ensure(&mut self, expected: u32) -> bool {
        if !self.focus().is_some_and(is_void) {
            return false;
        }
        let Some(conn) = self.conn() else {
            return false;
        };
        let repaired = conn
            .set_input_focus(InputFocus::PARENT, expected, x11rb::CURRENT_TIME)
            .ok()
            .and_then(|cookie| cookie.check().ok())
            .is_some();
        if repaired {
            tracing::info!("X input focus was on nothing; repaired to 0x{expected:x}");
        } else {
            // Queueing a request is not success: an unmapped or destroyed
            // target can be rejected by the server with BadMatch/BadWindow.
            tracing::debug!("X input focus repair to 0x{expected:x} was rejected");
            self.conn = None;
        }
        repaired
    }
}

fn is_void(focus: u32) -> bool {
    matches!(focus, FOCUS_NONE | FOCUS_POINTER_ROOT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xproto::{CreateWindowAux, EventMask, WindowClass};

    struct Server(Child);

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn namespace(name: &str) -> PathBuf {
        std::fs::read_link(format!("/proc/self/ns/{name}")).unwrap()
    }

    fn xvfb_binary() -> PathBuf {
        let binary = std::env::var_os("LWFA_TEST_XVFB").unwrap_or_else(|| "Xvfb".into());
        let path = Path::new(&binary);
        if path.components().count() > 1 {
            return path.canonicalize().expect("resolve LWFA_TEST_XVFB");
        }
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(path))
            .find(|path| path.is_file())
            .expect("install Xvfb or set LWFA_TEST_XVFB")
            .canonicalize()
            .unwrap()
    }

    fn run_sandbox(test: &str) {
        // Xvfb -displayfd bypasses lock files and can replace a live host's
        // filesystem socket when that host has no abstract X socket. Isolate
        // both namespaces before starting any X server, including on failure.
        let mut child = Server(
            Command::new("bwrap")
                .args([
                    "--unshare-all",
                    "--die-with-parent",
                    "--new-session",
                    "--ro-bind",
                    "/",
                    "/",
                    "--tmpfs",
                    "/tmp",
                    "--tmpfs",
                    "/run",
                    "--dev",
                    "/dev",
                    "--proc",
                    "/proc",
                    "--ro-bind",
                ])
                .arg(std::env::current_exe().unwrap())
                .arg("/run/lwfa-x11-test")
                .arg("--ro-bind")
                .arg(xvfb_binary())
                .arg("/run/lwfa-Xvfb")
                .args([
                    "--chdir",
                    "/tmp",
                    "--unsetenv",
                    "DISPLAY",
                    "--unsetenv",
                    "WAYLAND_DISPLAY",
                    "--unsetenv",
                    "XAUTHORITY",
                    "--unsetenv",
                    "DBUS_SESSION_BUS_ADDRESS",
                    "--unsetenv",
                    "XDG_RUNTIME_DIR",
                    "--setenv",
                    "LWFA_TEST_XVFB",
                    "/run/lwfa-Xvfb",
                    "--setenv",
                    "LWFA_X11_TEST_PARENT_MNT",
                ])
                .arg(namespace("mnt"))
                .args(["--setenv", "LWFA_X11_TEST_PARENT_NET"])
                .arg(namespace("net"))
                .args([
                    "--",
                    "/run/lwfa-x11-test",
                    "--exact",
                    test,
                    "--ignored",
                    "--nocapture",
                ])
                .spawn()
                .expect("X11 tests require bubblewrap (bwrap); refusing an unsandboxed run"),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success(), "isolated X11 test failed: {status}");
                return;
            }
            assert!(Instant::now() < deadline, "isolated X11 test timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn enter_sandbox(test: &str) -> bool {
        match (
            std::env::var_os("LWFA_X11_TEST_PARENT_MNT"),
            std::env::var_os("LWFA_X11_TEST_PARENT_NET"),
        ) {
            (None, None) => {
                run_sandbox(test);
                true
            }
            (Some(mnt), Some(net)) => {
                assert_ne!(
                    namespace("mnt"),
                    PathBuf::from(mnt),
                    "mount namespace is shared"
                );
                assert_ne!(
                    namespace("net"),
                    PathBuf::from(net),
                    "network namespace is shared"
                );
                false
            }
            _ => panic!("incomplete X11 test sandbox environment"),
        }
    }

    #[test]
    #[ignore = "requires Xvfb and bubblewrap; checks display isolation"]
    fn preserves_existing_x11_server() {
        use std::os::unix::fs::MetadataExt;
        if enter_sandbox("xfocus::tests::preserves_existing_x11_server") {
            return;
        }
        // Reproduce Hyprland's filesystem-only listener inside an outer
        // sandbox. The focus test must leave this server and its socket alive.
        let mut host = Server(
            Command::new(xvfb_binary())
                .args([
                    ":0",
                    "-displayfd",
                    "1",
                    "-screen",
                    "0",
                    "320x240x24",
                    "-nolisten",
                    "tcp",
                    "-nolisten",
                    "local",
                    "-extension",
                    "GLX",
                ])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut display = String::new();
        BufReader::new(host.0.stdout.take().unwrap())
            .read_line(&mut display)
            .unwrap();
        assert_eq!(display.trim(), "0");
        let path = "/tmp/.X11-unix/X0";
        let inode = std::fs::metadata(path).unwrap().ino();
        let (conn, _) = RustConnection::connect(Some(":0")).unwrap();
        let before = conn.get_input_focus().unwrap().reply().unwrap().focus;
        run_sandbox("xfocus::tests::repairs_void_focus_without_disturbing_real_windows");
        assert_eq!(std::fs::metadata(path).unwrap().ino(), inode);
        assert!(host.0.try_wait().unwrap().is_none());
        let (fresh, _) = RustConnection::connect(Some(":0")).unwrap();
        assert_eq!(
            fresh.get_input_focus().unwrap().reply().unwrap().focus,
            before
        );
    }

    #[test]
    #[ignore = "requires Xvfb and bubblewrap; creates its own isolated display"]
    fn repairs_void_focus_without_disturbing_real_windows() {
        if enter_sandbox("xfocus::tests::repairs_void_focus_without_disturbing_real_windows") {
            return;
        }
        // Never connect to DISPLAY: this test changes focus only on its own
        // headless X server, including when run from an active game session.
        let binary = std::env::var_os("LWFA_TEST_XVFB").unwrap_or_else(|| "Xvfb".into());
        let mut server = Server(
            Command::new(binary)
                .args([
                    "-displayfd",
                    "1",
                    "-screen",
                    "0",
                    "320x240x24",
                    "-nolisten",
                    "tcp",
                    "-extension",
                    "GLX",
                ])
                .stdout(Stdio::piped())
                .spawn()
                .expect("start isolated Xvfb"),
        );
        let mut display = String::new();
        BufReader::new(server.0.stdout.take().unwrap())
            .read_line(&mut display)
            .unwrap();
        let display: u32 = display.trim().parse().expect("Xvfb display number");
        let (conn, screen) = RustConnection::connect(Some(&format!(":{display}"))).unwrap();
        let conn = std::sync::Arc::new(conn);
        let screen = &conn.setup().roots[screen];
        let create_window = || {
            let id = conn.generate_id().unwrap();
            conn.create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                id,
                screen.root,
                0,
                0,
                100,
                100,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new().event_mask(EventMask::FOCUS_CHANGE),
            )
            .unwrap()
            .check()
            .unwrap();
            id
        };
        let game = create_window();
        let popup = create_window();
        let unmapped = create_window();
        for id in [game, popup] {
            conn.map_window(id).unwrap().check().unwrap();
        }
        // Exercise the real delayed-reassert call site with Smithay's X11
        // keyboard target, without starting a renderer or a production engine.
        let mut event_loop = smithay::reexports::calloop::EventLoop::try_new().unwrap();
        let wl_display = smithay::reexports::wayland_server::Display::new().unwrap();
        let mut state = crate::state::Lwfa::without_listener(&mut event_loop, wl_display);
        let atoms = smithay::xwayland::xwm::Atoms::new(&conn)
            .unwrap()
            .reply()
            .unwrap();
        let surface = smithay::xwayland::X11Surface::new(
            None,
            game,
            false,
            std::sync::Arc::downgrade(&conn),
            atoms,
            smithay::utils::Rectangle::from_size((100, 100).into()),
        );
        let id = lwfa_proto::WindowId(1);
        state
            .layout
            .track(id, smithay::desktop::Window::new_x11_window(surface));
        state.xfocus = Some(Guardian::new(display));
        state.set_focus(Some(id), false);
        let mut guardian = Guardian::new(display);
        for missing in [FOCUS_NONE, FOCUS_POINTER_ROOT] {
            conn.set_input_focus(InputFocus::NONE, missing, x11rb::CURRENT_TIME)
                .unwrap()
                .check()
                .unwrap();
            assert!(guardian.may_reassert(game));
            state.reassert_focus();
            assert_eq!(conn.get_input_focus().unwrap().reply().unwrap().focus, game);
        }
        // A healthy game and a real popup keep focus, with no FocusOut or
        // FocusIn generated by repeated layout checks and guardian ticks.
        for owner in [game, popup] {
            conn.set_input_focus(InputFocus::NONE, owner, x11rb::CURRENT_TIME)
                .unwrap()
                .check()
                .unwrap();
            while conn.poll_for_event().unwrap().is_some() {}
            for _ in 0..20 {
                assert_eq!(guardian.may_reassert(game), owner == game);
                state.reassert_focus();
                assert!(!guardian.ensure(game));
            }
            assert_eq!(
                conn.get_input_focus().unwrap().reply().unwrap().focus,
                owner
            );
            while let Some(event) = conn.poll_for_event().unwrap() {
                assert!(!matches!(event, Event::FocusIn(_) | Event::FocusOut(_)));
            }
        }
        // A missing seat target is restored only after the real popup has
        // relinquished focus. Layout repair must not override its ownership.
        let keyboard = state.seat.get_keyboard().unwrap();
        keyboard.set_focus(
            &mut state,
            None,
            smithay::utils::SERIAL_COUNTER.next_serial(),
        );
        conn.set_input_focus(InputFocus::NONE, popup, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        state.reassert_focus();
        assert!(keyboard.current_focus().is_none());
        assert_eq!(
            conn.get_input_focus().unwrap().reply().unwrap().focus,
            popup
        );
        conn.set_input_focus(InputFocus::NONE, FOCUS_NONE, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        state.reassert_focus();
        assert!(keyboard.current_focus().is_some());
        assert_eq!(conn.get_input_focus().unwrap().reply().unwrap().focus, game);

        // The one-second guardian must respect the same menu handshake as
        // delayed layout repair, even before the menu has acquired focus.
        let popup_surface = smithay::xwayland::X11Surface::new(
            None,
            popup,
            true,
            std::sync::Arc::downgrade(&conn),
            atoms,
            smithay::utils::Rectangle::from_size((100, 100).into()),
        );
        let popup_window = smithay::desktop::Window::new_x11_window(popup_surface.clone());
        state.space.map_element(popup_window.clone(), (0, 0), true);
        state.note_popup_mapped(&popup_surface);
        conn.set_input_focus(InputFocus::NONE, FOCUS_NONE, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        state.guard_x_focus();
        assert_eq!(
            conn.get_input_focus().unwrap().reply().unwrap().focus,
            FOCUS_NONE,
            "periodic guardian interrupted a new popup's focus handshake"
        );
        std::thread::sleep(Duration::from_millis(5100));
        state.guard_x_focus();
        assert_eq!(conn.get_input_focus().unwrap().reply().unwrap().focus, game);
        conn.set_input_focus(InputFocus::NONE, popup, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        state.guard_x_focus();
        assert_eq!(
            conn.get_input_focus().unwrap().reply().unwrap().focus,
            popup
        );
        state.space.unmap_elem(&popup_window);

        // The server rejects focus on an unmapped window. A queued request
        // must not be reported as a successful repair, and retry must work.
        conn.set_input_focus(InputFocus::NONE, FOCUS_NONE, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        assert!(!guardian.ensure(unmapped));
        assert!(guardian.ensure(game));
        assert_eq!(conn.get_input_focus().unwrap().reply().unwrap().focus, game);

        // Clicking empty space intentionally clears compositor ownership as
        // well as seat focus. Neither repair path may resurrect the old game.
        state.set_focus(None, true);
        state.reassert_focus();
        state.guard_x_focus();
        assert!(state.focused().is_none());
        assert!(keyboard.current_focus().is_none());
        assert_eq!(
            conn.get_input_focus().unwrap().reply().unwrap().focus,
            FOCUS_NONE
        );
    }
}
