//! Compositor state.
//!
//! Smithay's protocol modules each keep a state struct here and call back into
//! a handler trait implemented on this type. See `handlers/`.
//!
//! Since milestone 3 this type is also the bridge to the shell: it assigns
//! stable [`WindowId`]s, reports lifecycle over the shell protocol, and applies
//! the layout that comes back. It holds no layout policy of its own beyond
//! safe mode. See `layout.rs`.

use std::ffi::OsString;
use std::sync::Arc;

use lwfa_proto::{Modifiers, PROTOCOL_VERSION, ToShell, WindowId, WindowInfo};
use smithay::desktop::{PopupManager, Space, Window, WindowSurface, WindowSurfaceType};
use smithay::input::{Seat, SeatState};
use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::{EventLoop, Interest, LoopHandle, LoopSignal, Mode, PostAction};
use smithay::reexports::wayland_server::backend::{ClientData, ClientId, DisconnectReason};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::{Display, DisplayHandle};
use smithay::utils::{Logical, Point};
use smithay::wayland::compositor::{CompositorClientState, CompositorState};
use smithay::wayland::output::OutputManagerState;
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::selection::data_device::DataDeviceState;
use smithay::wayland::shell::xdg::XdgShellState;
use smithay::wayland::shm::ShmState;
use smithay::wayland::socket::ListeningSocketSource;
use smithay::wayland::xwayland_shell::XWaylandShellState;
use smithay::xwayland::X11Wm;

use crate::capture::SurfaceCapture;
use crate::encode::EncodeWorker;

use crate::layout::{self, Layout};
use crate::shell::ShellLink;

pub struct Lwfa {
    pub start_time: std::time::Instant,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,

    /// Smithay's 2D plane. The layout decides positions; the space holds what
    /// was decided so rendering and hit-testing can use it.
    pub space: Space<Window>,
    /// Reconciles shell-declared layout. Holds no policy.
    pub layout: Layout,
    /// The shell connection, if any. `None` until the listener binds.
    pub shell: Option<ShellLink>,
    /// Per-surface capture. Only does work when something asks it to.
    pub capture: SurfaceCapture,
    /// Encoding runs on its own thread. Opening an NVENC session costs
    /// 90-160ms, which must not land in the render loop. See `encode.rs`.
    pub encoders: Option<EncodeWorker>,
    /// Windows the shell has asked for pixels of.
    ///
    /// Empty is the normal case for a local shell, which composites natively
    /// and needs no streams at all.
    pub streaming: std::collections::HashSet<WindowId>,
    pub loop_signal: LoopSignal,
    /// Kept because `X11Wm` registers its own event sources, and it is started
    /// from inside a callback where the loop itself is not reachable.
    pub loop_handle: LoopHandle<'static, CalloopData>,

    focused: Option<WindowId>,
    next_window_id: u64,
    /// Last `WindowInfo` reported to the shell, per window.
    ///
    /// Clients set their title and app id after mapping and change them later,
    /// so the engine has to notice and report. Diffing against this is what
    /// stops a `WindowChanged` being sent on every single commit.
    reported: std::collections::HashMap<WindowId, WindowInfo>,

    /// The X11 window manager, once Xwayland has started and handed us a
    /// privileged connection. `None` before that, and for the whole run if
    /// Xwayland is not installed.
    pub xwm: Option<X11Wm>,
    /// The X display number, for putting `DISPLAY` in a spawned client's
    /// environment. See `Lwfa::spawn`.
    pub xdisplay: Option<u32>,

    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub xwayland_shell_state: XWaylandShellState,
    pub shm_state: ShmState,
    pub seat_state: SeatState<Lwfa>,
    pub data_device_state: DataDeviceState,
    pub popups: PopupManager,

    /// Held to keep the `wl_output` and `xdg_output` globals alive. Nothing
    /// reads it; dropping it would unadvertise the protocols.
    #[allow(dead_code)]
    output_manager_state: OutputManagerState,

    pub seat: Seat<Self>,
}

impl Lwfa {
    pub fn new(event_loop: &mut EventLoop<'static, CalloopData>, display: Display<Self>) -> Self {
        let dh = display.handle();

        let compositor_state = CompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        // Advertised unconditionally, and only Xwayland can bind it. Creating
        // the global costs nothing if Xwayland never starts.
        let xwayland_shell_state = XWaylandShellState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, "lwfa");
        // Nested backend, so a keyboard and pointer are always present. The TTY
        // backend will need real hotplug tracking.
        seat.add_keyboard(Default::default(), 200, 25)
            .expect("failed to add keyboard to seat");
        seat.add_pointer();
        // Touch is advertised even though the nested backend has no
        // touchscreen: it exists for remote fingers. A client that sees no
        // wl_touch will never handle multi-touch, so this has to be present
        // before the first client connects, not added when an iPad appears.
        seat.add_touch();

        let socket_name = Self::init_wayland_listener(display, event_loop);
        let loop_signal = event_loop.get_signal();
        let loop_handle = event_loop.handle();

        Self {
            start_time: std::time::Instant::now(),
            display_handle: dh,
            // Real size arrives from the backend once the output exists.
            layout: Layout::new((0, 0).into()),
            shell: None,
            capture: SurfaceCapture::default(),
            encoders: None,
            streaming: std::collections::HashSet::new(),
            space: Space::default(),
            loop_signal,
            loop_handle,
            focused: None,
            next_window_id: 1,
            reported: std::collections::HashMap::new(),
            socket_name,
            xwm: None,
            xdisplay: None,
            compositor_state,
            xdg_shell_state,
            xwayland_shell_state,
            shm_state,
            output_manager_state,
            seat_state,
            data_device_state,
            popups: PopupManager::default(),
            seat,
        }
    }

    fn init_wayland_listener(
        display: Display<Lwfa>,
        event_loop: &mut EventLoop<'static, CalloopData>,
    ) -> OsString {
        let listening_socket =
            ListeningSocketSource::new_auto().expect("failed to bind a wayland socket");
        let socket_name = listening_socket.socket_name().to_os_string();
        let loop_handle = event_loop.handle();

        loop_handle
            .insert_source(listening_socket, move |client_stream, _, state| {
                if let Err(err) = state
                    .display_handle
                    .insert_client(client_stream, Arc::new(ClientState::default()))
                {
                    tracing::warn!("failed to accept a client: {err}");
                }
            })
            .expect("failed to init the wayland event source");

        loop_handle
            .insert_source(
                Generic::new(display, Interest::READ, Mode::Level),
                |_, display, state| {
                    // SAFETY: `dispatch_clients` requires that the `Display` is
                    // not dropped or moved out of while dispatching. The
                    // display is owned by this event source for the lifetime of
                    // the loop, and the only access is through this closure.
                    #[allow(unsafe_code)]
                    unsafe {
                        display.get_mut().dispatch_clients(state)?;
                    }
                    Ok(PostAction::Continue)
                },
            )
            .expect("failed to init the wayland display source");

        socket_name
    }

    // ---------------------------------------------------------------------
    // Window registry
    // ---------------------------------------------------------------------

    pub fn next_window_id(&mut self) -> WindowId {
        let id = WindowId(self.next_window_id);
        self.next_window_id += 1;
        id
    }

    pub fn focused(&self) -> Option<WindowId> {
        self.focused
    }

    /// Read the current title and app id straight off the window.
    ///
    /// Clients set these after mapping and change them later, so this is read
    /// on demand rather than cached and left stale.
    pub fn window_info(&self, id: WindowId) -> Option<WindowInfo> {
        let window = self.layout.window(id)?;
        let (app_id, title) = match window.underlying_surface() {
            WindowSurface::Wayland(toplevel) => {
                smithay::wayland::compositor::with_states(toplevel.wl_surface(), |states| {
                    let data = states
                        .data_map
                        .get::<smithay::wayland::shell::xdg::XdgToplevelSurfaceData>()
                        .map(|d| d.lock().unwrap());
                    match data {
                        Some(d) => (d.app_id.clone(), d.title.clone()),
                        None => (None, None),
                    }
                })
            }
            // WM_CLASS stands in for the app id. It is the closest X11 has, and
            // it is what desktop files have always matched on. Both come back
            // as empty strings rather than absent, so normalise to None and let
            // the shell show its placeholder.
            WindowSurface::X11(x11) => {
                let blank = |s: String| (!s.is_empty()).then_some(s);
                (blank(x11.class()), blank(x11.title()))
            }
        };
        Some(WindowInfo { id, app_id, title })
    }

    /// Report a title or app id change, but only when something actually
    /// changed. Called on every commit, which is far more often than a client
    /// renames itself.
    pub fn report_window_changes(&mut self, id: WindowId) {
        let Some(info) = self.window_info(id) else {
            return;
        };
        if self.reported.get(&id) == Some(&info) {
            return;
        }
        self.reported.insert(id, info.clone());
        self.send_to_shell(ToShell::WindowChanged { window: info });
    }

    pub fn forget_reported(&mut self, id: WindowId) {
        self.reported.remove(&id);
    }

    /// Drop every trace of a window that has gone away, and tell the shell.
    ///
    /// Shared by the Wayland and X11 destroy paths. Forgetting one of these
    /// places leaks in a way that is easy to miss: a stale capture keeps a
    /// texture alive, and a stale encoder session holds one of only eight NVENC
    /// slots. Safe to call twice, which matters because X11 reports both an
    /// unmap and a destroy for the same window.
    pub fn retire_window(&mut self, id: WindowId) {
        if let Some(window) = self.layout.window(id).cloned() {
            self.space.unmap_elem(&window);
        }
        self.layout.forget(id);
        self.forget_reported(id);
        self.capture.forget(id);
        self.streaming.remove(&id);
        if let Some(worker) = self.encoders.as_ref() {
            worker.forget(id);
        }

        if self.focused() == Some(id) {
            // Focus something else rather than leaving the seat pointing at a
            // window that no longer exists.
            let next = self.topmost_window_id();
            self.set_focus(next, true);
        }

        self.send_to_shell(ToShell::WindowClosed { id });

        if self.layout.mode() == layout::Mode::Safe {
            self.apply_safe_mode();
        }
    }

    pub fn send_to_shell(&self, message: ToShell) {
        if let Some(shell) = &self.shell {
            shell.send(message);
        }
    }

    /// Full current state, sent on every shell connection.
    pub fn hello(&self) -> ToShell {
        let size = self.layout.output_size();
        let mut windows: Vec<WindowInfo> = self
            .layout
            .placements()
            .iter()
            .filter_map(|(w, _)| self.layout.id_of(w))
            .filter_map(|id| self.window_info(id))
            .collect();

        // placements() only returns visible windows, and on a fresh connection
        // nothing is placed yet, so walk the registry for the rest.
        for id in self.all_window_ids() {
            if !windows.iter().any(|w| w.id == id) {
                if let Some(info) = self.window_info(id) {
                    windows.push(info);
                }
            }
        }
        windows.sort_by_key(|w| w.id);

        ToShell::Hello {
            protocol_version: PROTOCOL_VERSION,
            output: lwfa_proto::Output {
                width: size.w,
                height: size.h,
                scale: 1.0,
            },
            windows,
            focused: self.focused,
        }
    }

    fn all_window_ids(&self) -> Vec<WindowId> {
        self.layout.all_ids()
    }

    /// Something reasonable to focus after the focused window closes.
    pub fn topmost_window_id(&self) -> Option<WindowId> {
        self.layout
            .topmost()
            .or_else(|| self.layout.all_ids().last().copied())
    }

    pub fn forward_key_binding(&self, key: String, modifiers: Modifiers) {
        self.send_to_shell(ToShell::KeyBinding { key, modifiers });
    }

    // ---------------------------------------------------------------------
    // Focus
    // ---------------------------------------------------------------------

    /// Set keyboard focus, telling the shell only when it did not ask for this.
    ///
    /// `notify_shell` is false when the shell initiated the change, so a focus
    /// command does not echo back and start a loop.
    pub fn set_focus(&mut self, id: Option<WindowId>, notify_shell: bool) {
        self.focused = id;

        let target = id
            .and_then(|id| self.layout.window(id))
            .and_then(crate::focus::KeyboardFocus::of);

        // Activated state drives the client's own focus styling.
        for (window, _) in self.layout.placements() {
            // Compared through `target`, never `is_none() == is_none()`: an
            // X11 window has no `wl_surface` until Xwayland associates one, and
            // matching two absent surfaces would activate every window that had
            // not finished mapping.
            let is_focused = target
                .as_ref()
                .and_then(|t| t.wl_surface())
                .is_some_and(|t| window.wl_surface() == Some(t));
            window.set_activated(is_focused);
            match window.underlying_surface() {
                WindowSurface::Wayland(toplevel) => {
                    toplevel.send_pending_configure();
                }
                // `set_activated` already wrote the X11 property. There is no
                // second round trip to flush.
                WindowSurface::X11(_) => {}
            }
        }

        // X11 keeps its own stacking order, and a client that believes it is
        // behind something will not take input properly. Nothing to do for
        // Wayland, where the shell's z-order is the only order there is.
        let focused_x11 = id
            .and_then(|id| self.layout.window(id))
            .and_then(|w| w.x11_surface())
            .cloned();
        if let (Some(xwm), Some(x11)) = (self.xwm.as_mut(), focused_x11)
            && let Err(err) = xwm.raise_window(&x11)
        {
            tracing::warn!("failed to raise an X11 window: {err}");
        }

        if let Some(keyboard) = self.seat.get_keyboard() {
            let serial = smithay::utils::SERIAL_COUNTER.next_serial();
            keyboard.set_focus(self, target, serial);
        }

        if notify_shell {
            self.send_to_shell(ToShell::FocusChanged { id });
        }
    }

    // ---------------------------------------------------------------------
    // Layout
    // ---------------------------------------------------------------------

    /// Recompute placements and push them into the scene.
    pub fn apply_layout(&mut self) {
        for (window, location) in self.layout.placements() {
            self.space.map_element(window, location, false);
        }
        // Windows the shell left out are unmapped rather than moved off-screen,
        // so they stop being rendered and stop consuming a frame callback.
        for window in self.layout.hidden() {
            self.space.unmap_elem(&window);
        }
    }

    /// Place windows when no shell is connected. See `layout::Mode::Safe`.
    pub fn apply_safe_mode(&mut self) {
        let focused = self
            .focused
            .or_else(|| self.all_window_ids().first().copied());
        if self.focused != focused {
            self.set_focus(focused, true);
        }
        let configures = self.layout.apply_safe_mode(focused);
        self.send_configures(configures);
        self.apply_layout();
    }

    pub fn send_configures(&mut self, configures: Vec<layout::PendingConfigure>) {
        for configure in configures {
            match configure.window.underlying_surface() {
                WindowSurface::Wayland(toplevel) => {
                    toplevel.with_pending_state(|state| state.size = Some(configure.rect.size));
                    toplevel.send_pending_configure();
                }
                WindowSurface::X11(x11) => {
                    // X11 has no notion of a client that may decline, so this
                    // both asks and tells. Unlike xdg-shell it takes a
                    // position, which is what an override-redirect menu reads
                    // to work out where to put itself.
                    if let Err(err) = x11.configure(configure.rect) {
                        tracing::warn!("failed to configure an X11 window: {err}");
                    }
                }
            }
        }
    }

    /// Advance animations. Returns true while a redraw is still needed.
    pub fn tick_animations(&mut self) -> bool {
        let animating = self.layout.tick(std::time::Instant::now());
        if animating {
            self.apply_layout();
        }
        animating
    }

    /// Capture every visible window and write it out as a PNG.
    ///
    /// Debug only, driven by `LWFA_CAPTURE_DUMP`. This is how per-surface
    /// capture gets verified against what is actually on screen: if the
    /// channel order or the stride were wrong, it would be obvious here rather
    /// than showing up as garbled video three layers later.
    pub fn dump_captures(
        &mut self,
        renderer: &mut smithay::backend::renderer::gles::GlesRenderer,
        dir: &std::path::Path,
    ) {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        for (window, _) in self.layout.placements() {
            let Some(id) = self.layout.id_of(&window) else {
                continue;
            };
            let size = window.geometry().size.to_physical(1);
            let Some(frame) = self.capture.capture(renderer, id, &window, size) else {
                continue; // unchanged since last capture
            };
            let Some(png) = frame.to_png() else { continue };
            let path = dir.join(format!("window-{}.png", id.0));
            if let Err(err) = std::fs::write(&path, png) {
                tracing::warn!("could not write {}: {err}", path.display());
            } else {
                tracing::info!(
                    "captured {id} -> {} ({}x{})",
                    path.display(),
                    frame.width,
                    frame.height
                );
            }
        }
    }

    /// Capture the streaming windows and queue them for the shell.
    ///
    /// Three things keep this from dominating the frame:
    ///
    /// 1. Only windows the shell asked for are considered at all, which under
    ///    scrollable tiling means roughly "what fits in the viewport".
    /// 2. `SurfaceCapture` skips anything that has not committed, so idle
    ///    windows cost nothing.
    /// 3. Backpressure. If the socket is behind, frames are not captured in the
    ///    first place, so a slow link costs no GPU read-back rather than
    ///    building an unbounded queue.
    pub fn stream_frames(&mut self, renderer: &mut smithay::backend::renderer::gles::GlesRenderer) {
        if self.streaming.is_empty() {
            return;
        }
        let Some(shell) = self.shell.as_ref() else {
            return;
        };
        let Some(worker) = self.encoders.as_ref() else {
            return;
        };
        if !shell.can_accept_frame() || !worker.has_capacity() {
            return;
        }

        let targets: Vec<(WindowId, Window)> = self
            .layout
            .placements()
            .into_iter()
            .filter_map(|(window, _)| {
                let id = self.layout.id_of(&window)?;
                self.streaming.contains(&id).then_some((id, window))
            })
            .collect();

        for (id, window) in targets {
            // Re-checked per window: one large frame can fill either queue.
            let (Some(shell), Some(worker)) = (self.shell.as_ref(), self.encoders.as_ref()) else {
                return;
            };
            if !shell.can_accept_frame() || !worker.has_capacity() {
                return;
            }

            let size = window.geometry().size.to_physical(1);
            let profile = std::env::var_os("LWFA_PROFILE").is_some();
            let t0 = profile.then(std::time::Instant::now);

            let Some(frame) = self.capture.capture(renderer, id, &window, size) else {
                continue;
            };

            if let Some(t0) = t0 {
                tracing::info!(
                    "profile {id} {}x{}: capture+readback {:.2}ms",
                    frame.width,
                    frame.height,
                    t0.elapsed().as_secs_f64() * 1000.0,
                );
            }

            // Hand off. Encoding, and in particular opening an NVENC session,
            // happens on the encoder thread so a 160ms session build cannot
            // stall compositing.
            if let Some(worker) = self.encoders.as_ref() {
                if !worker.submit(frame) {
                    // Dropped because the encoder is behind. The capture's
                    // damage state was already advanced, so this update is
                    // lost; the next commit will produce another. Losing a
                    // frame under load is preferable to unbounded latency.
                    tracing::trace!("encoder busy, dropped a frame for {id}");
                    return;
                }
            }
        }
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.space
            .element_under(pos)
            .and_then(|(window, location)| {
                window
                    .surface_under(pos - location.to_f64(), WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + location).to_f64()))
            })
    }
}

/// The event loop's data type.
///
/// An alias, not a wrapper. `X11Wm::start_wm` requires the loop data to
/// implement `XwmHandler`, and Smithay's protocol handlers are all implemented
/// on `Lwfa`, so the two have to be the same type. The wrapper this replaces
/// held a second copy of `display_handle` and nothing else.
pub type CalloopData = Lwfa;

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
