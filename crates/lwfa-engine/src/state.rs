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
use smithay::desktop::{PopupManager, Space, Window, WindowSurfaceType};
use smithay::input::{Seat, SeatState};
use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::{EventLoop, Interest, LoopSignal, Mode, PostAction};
use smithay::reexports::wayland_server::backend::{ClientData, ClientId, DisconnectReason};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::{Display, DisplayHandle};
use smithay::utils::{Logical, Point};
use smithay::wayland::compositor::{CompositorClientState, CompositorState};
use smithay::wayland::output::OutputManagerState;
use smithay::wayland::selection::data_device::DataDeviceState;
use smithay::wayland::shell::xdg::XdgShellState;
use smithay::wayland::shm::ShmState;
use smithay::wayland::socket::ListeningSocketSource;

use crate::capture::SurfaceCapture;
use crate::encode::Encoders;

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
    /// Per-window hardware encoders, with a JPEG fallback.
    pub encoders: Encoders,
    /// Windows the shell has asked for pixels of.
    ///
    /// Empty is the normal case for a local shell, which composites natively
    /// and needs no streams at all.
    pub streaming: std::collections::HashSet<WindowId>,
    pub loop_signal: LoopSignal,

    focused: Option<WindowId>,
    next_window_id: u64,
    /// Last `WindowInfo` reported to the shell, per window.
    ///
    /// Clients set their title and app id after mapping and change them later,
    /// so the engine has to notice and report. Diffing against this is what
    /// stops a `WindowChanged` being sent on every single commit.
    reported: std::collections::HashMap<WindowId, WindowInfo>,

    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
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
    pub fn new(event_loop: &mut EventLoop<CalloopData>, display: Display<Self>) -> Self {
        let dh = display.handle();

        let compositor_state = CompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
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

        let socket_name = Self::init_wayland_listener(display, event_loop);
        let loop_signal = event_loop.get_signal();

        Self {
            start_time: std::time::Instant::now(),
            display_handle: dh,
            // Real size arrives from the backend once the output exists.
            layout: Layout::new((0, 0).into()),
            shell: None,
            capture: SurfaceCapture::default(),
            encoders: Encoders::new(),
            streaming: std::collections::HashSet::new(),
            space: Space::default(),
            loop_signal,
            focused: None,
            next_window_id: 1,
            reported: std::collections::HashMap::new(),
            socket_name,
            compositor_state,
            xdg_shell_state,
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
        event_loop: &mut EventLoop<CalloopData>,
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
                        display.get_mut().dispatch_clients(&mut state.state)?;
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

    /// Read the current title and app id straight off the toplevel.
    ///
    /// Clients set these after mapping and change them later, so this is read
    /// on demand rather than cached and left stale.
    pub fn window_info(&self, id: WindowId) -> Option<WindowInfo> {
        let window = self.layout.window(id)?;
        let toplevel = window.toplevel()?;
        let (app_id, title) =
            smithay::wayland::compositor::with_states(toplevel.wl_surface(), |states| {
                let data = states
                    .data_map
                    .get::<smithay::wayland::shell::xdg::XdgToplevelSurfaceData>()
                    .map(|d| d.lock().unwrap());
                match data {
                    Some(d) => (d.app_id.clone(), d.title.clone()),
                    None => (None, None),
                }
            });
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
            .and_then(|w| w.toplevel())
            .map(|t| t.wl_surface().clone());

        // Activated state drives the client's own focus styling.
        for (window, _) in self.layout.placements() {
            let is_focused = window
                .toplevel()
                .map(|t| Some(t.wl_surface()) == target.as_ref())
                .unwrap_or(false);
            window.set_activated(is_focused);
            if let Some(toplevel) = window.toplevel() {
                toplevel.send_pending_configure();
            }
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
            if let Some(toplevel) = configure.window.toplevel() {
                toplevel.with_pending_state(|state| state.size = Some(configure.size));
                toplevel.send_pending_configure();
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
        if !shell.can_accept_frame() {
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
            // Re-checked per window: one large window can fill the queue.
            let Some(shell) = self.shell.as_ref() else {
                return;
            };
            if !shell.can_accept_frame() {
                return;
            }

            let size = window.geometry().size.to_physical(1);
            let Some(frame) = self.capture.capture(renderer, id, &window, size) else {
                continue;
            };
            let Some(encoded) = self.encoders.encode(&frame) else {
                continue;
            };

            let header = lwfa_proto::FrameHeader {
                window: id,
                width: frame.width,
                height: frame.height,
                format: encoded.format,
                keyframe: encoded.keyframe,
            };
            if let Some(shell) = self.shell.as_ref() {
                shell.send_frame(header.encode_with_payload(&encoded.bytes));
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

pub struct CalloopData {
    pub state: Lwfa,
    pub display_handle: DisplayHandle,
}

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
