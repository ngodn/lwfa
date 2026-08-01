//! Wayland protocol handlers.
//!
//! Smithay's pattern: a per-protocol state struct lives on `Lwfa`, and the
//! protocol calls back through a handler trait. `delegate_*!` wires the
//! `Dispatch` impls.

mod compositor;
mod xdg_shell;
mod xwayland;

use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::reexports::wayland_server::Resource;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::wayland::output::OutputHandler;
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::selection::SelectionHandler;
use smithay::wayland::selection::data_device::{
    ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
    set_data_device_focus,
};
use smithay::{delegate_data_device, delegate_output, delegate_seat};

use crate::focus::KeyboardFocus;
use crate::state::Lwfa;

impl SeatHandler for Lwfa {
    // Not `WlSurface`: an X11 window needs the X server told who has focus.
    // See `focus.rs`.
    type KeyboardFocus = KeyboardFocus;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Lwfa> {
        &mut self.seat_state
    }

    fn cursor_image(
        &mut self,
        _seat: &Seat<Self>,
        _image: smithay::input::pointer::CursorImageStatus,
    ) {
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&KeyboardFocus>) {
        let dh = &self.display_handle;
        let client = focused
            .and_then(|f| f.wl_surface())
            .and_then(|s| dh.get_client(s.id()).ok());
        set_data_device_focus(dh, seat, client);
    }
}

delegate_seat!(Lwfa);

impl SelectionHandler for Lwfa {
    type SelectionUserData = ();
}

impl DataDeviceHandler for Lwfa {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl ClientDndGrabHandler for Lwfa {}
impl ServerDndGrabHandler for Lwfa {}

delegate_data_device!(Lwfa);

impl OutputHandler for Lwfa {}
delegate_output!(Lwfa);
