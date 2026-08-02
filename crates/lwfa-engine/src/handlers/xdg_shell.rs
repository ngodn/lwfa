//! xdg-shell: how clients get windows on screen.
//!
//! Note what is *absent*: `move_request` and `resize_request` are deliberate
//! no-ops. Under scrollable tiling windows do not float, so a client asking to
//! be dragged or resized by its own titlebar has nothing to be granted. That
//! removes the interactive move and resize grabs entirely, which is most of
//! what a floating compositor spends its xdg-shell code on.
//!
//! Since milestone 3 this module also reports window lifecycle to the shell. It
//! decides nothing about placement; it registers the window, tells the shell,
//! and waits for a layout to come back.

use smithay::delegate_xdg_shell;
use smithay::desktop::{
    PopupKind, PopupManager, Space, Window, find_popup_root_surface, get_popup_toplevel_coords,
};
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::reexports::wayland_server::protocol::{wl_seat, wl_surface::WlSurface};
use smithay::utils::Serial;
use smithay::wayland::compositor::with_states;
use smithay::wayland::shell::xdg::{
    PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
    XdgToplevelSurfaceData,
};

use crate::layout::Mode;
use crate::state::Lwfa;
use lwfa_proto::ToShell;
use smithay::reexports::wayland_server::protocol::wl_output;

impl XdgShellHandler for Lwfa {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let window = Window::new_wayland_window(surface.clone());
        let id = self.next_window_id();
        self.layout.track(id, window.clone());

        surface.with_pending_state(|state| {
            state.states.set(xdg_toplevel::State::Activated);
        });

        // Mapped off-screen with no size yet. The window stays invisible until
        // something places it, so it cannot flash at the origin for a frame
        // while the shell is deciding.
        self.space.map_element(window, (0, 0), false);

        match self.layout.mode() {
            Mode::Shell => {
                if let Some(info) = self.window_info(id) {
                    self.send_to_shell(ToShell::WindowOpened { window: info });
                }
                // No placement here. The shell replies with a SetLayout.
                self.set_focus(Some(id), true);
            }
            Mode::Safe => {
                self.set_focus(Some(id), false);
                self.apply_safe_mode();
            }
        }
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        let Some(id) = self.layout.id_of_surface(surface.wl_surface()).or_else(|| {
            self.space
                .elements()
                .find(|w| w.toplevel().is_some_and(|t| t == &surface))
                .and_then(|w| self.layout.id_of(w))
        }) else {
            return;
        };

        self.retire_window(id);
    }

    fn new_popup(&mut self, surface: PopupSurface, _positioner: PositionerState) {
        self.unconstrain_popup(&surface);
        if let Err(err) = self.popups.track_popup(PopupKind::Xdg(surface)) {
            tracing::warn!("failed to track popup: {err}");
        }
    }

    fn reposition_request(
        &mut self,
        surface: PopupSurface,
        positioner: PositionerState,
        token: u32,
    ) {
        surface.with_pending_state(|state| {
            state.geometry = positioner.get_geometry();
            state.positioner = positioner;
        });
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
    }

    /// No-op: the shell owns window position. See the module comment.
    fn move_request(&mut self, _surface: ToplevelSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
    }

    /// No-op: the shell owns column width. Client-driven resize arrives later
    /// as a request to change the column's preset width, not as a free drag.
    fn resize_request(
        &mut self,
        _surface: ToplevelSurface,
        _seat: wl_seat::WlSeat,
        _serial: Serial,
        _edges: xdg_toplevel::ResizeEdge,
    ) {
    }

    /// A client asking to be fullscreen. This is the video player's button.
    ///
    /// Forwarded rather than granted here. The shell owns the arrangement, so a
    /// window put fullscreen by the engine alone would be moved straight back
    /// to its column width by the next layout. The shell decides, and the size
    /// it sends is what the client is eventually configured with; the
    /// fullscreen *state* is set alongside that size in `send_configures`.
    ///
    /// Nothing is sent to the client here on purpose. It has already been told
    /// a size, and answering twice, once now and once when the shell replies,
    /// makes a player flicker between layouts.
    fn fullscreen_request(
        &mut self,
        surface: ToplevelSurface,
        _output: Option<wl_output::WlOutput>,
    ) {
        self.request_fullscreen(&surface, true);
    }

    /// The same in reverse: leaving fullscreen from inside the application.
    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        self.request_fullscreen(&surface, false);
    }

    fn grab(&mut self, _surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        // Popup grabs are not implemented yet. Menus still appear; they just
        // do not dismiss on outside click.
    }
}

delegate_xdg_shell!(Lwfa);

/// Send the initial configure once a surface has committed, and keep popups in
/// step. Called from the compositor handler's `commit`.
pub fn handle_commit(popups: &mut PopupManager, space: &Space<Window>, surface: &WlSurface) {
    if let Some(window) = space
        .elements()
        .find(|w| w.toplevel().is_some_and(|t| t.wl_surface() == surface))
        .cloned()
    {
        let initial_configure_sent = with_states(surface, |states| {
            states
                .data_map
                .get::<XdgToplevelSurfaceData>()
                .map(|d| d.lock().unwrap().initial_configure_sent)
                .unwrap_or(false)
        });

        if !initial_configure_sent {
            if let Some(toplevel) = window.toplevel() {
                toplevel.send_configure();
            }
        }
    }

    popups.commit(surface);
    if let Some(popup) = popups.find_popup(surface) {
        match popup {
            PopupKind::Xdg(ref xdg) => {
                if !xdg.is_initial_configure_sent() {
                    // The initial configure is always allowed, so this cannot
                    // fail in practice.
                    let _ = xdg.send_configure();
                }
            }
            PopupKind::InputMethod(_) => {}
        }
    }
}

impl Lwfa {
    fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else {
            return;
        };
        let Some(window) = self
            .space
            .elements()
            .find(|w| w.toplevel().is_some_and(|t| t.wl_surface() == &root))
        else {
            return;
        };
        let Some(output) = self.space.outputs().next() else {
            return;
        };
        let (Some(output_geo), Some(window_geo)) = (
            self.space.output_geometry(output),
            self.space.element_geometry(window),
        ) else {
            return;
        };

        // The positioner's target is relative to the parent's geometry.
        let mut target = output_geo;
        target.loc -= get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        target.loc -= window_geo.loc;

        popup.with_pending_state(|state| {
            state.geometry = state.positioner.get_unconstrained_geometry(target);
        });
    }
}
