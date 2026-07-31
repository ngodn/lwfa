//! Compositor state.
//!
//! Smithay's protocol modules each keep a state struct here and call back into
//! a handler trait implemented on this type. See `handlers/`.

use std::ffi::OsString;
use std::sync::Arc;

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

use crate::layout::Strip;

pub struct Lwfa {
    pub start_time: std::time::Instant,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,

    /// Smithay's 2D plane. The strip decides positions; the space just holds
    /// what was decided so rendering and hit-testing can use it.
    pub space: Space<Window>,
    /// The scrollable strip. This is lwfa's actual layout state.
    pub strip: Strip,
    pub loop_signal: LoopSignal,

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
            strip: Strip::new((0, 0).into()),
            space: Space::default(),
            loop_signal,
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

    /// Push the strip's computed geometry into the space.
    ///
    /// The strip is the single source of truth for where windows go. This is
    /// the only place that is translated into `Space` mappings, which keeps the
    /// layout testable without a compositor and mirrors how the shell will
    /// later dictate geometry over the shell protocol.
    pub fn apply_layout(&mut self) {
        for (window, location) in self.strip.positions() {
            self.space.map_element(window, location, false);
        }
    }

    /// Advance the scroll animation. Returns true while a redraw is still
    /// needed.
    pub fn tick_animations(&mut self) -> bool {
        let animating = self.strip.tick();
        if animating {
            self.apply_layout();
        }
        animating
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
