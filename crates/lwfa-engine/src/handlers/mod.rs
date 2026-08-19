//! Wayland protocol handlers.
//!
//! Smithay's pattern: a per-protocol state struct lives on `Lwfa`, and the
//! protocol calls back through a handler trait. `delegate_*!` wires the
//! `Dispatch` impls.

mod compositor;
mod xdg_shell;
mod xwayland;

use std::os::unix::io::OwnedFd;

use smithay::input::{Seat, SeatHandler, SeatState};
use smithay::reexports::wayland_server::Resource;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::wayland::output::OutputHandler;
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::selection::{SelectionHandler, SelectionSource, SelectionTarget};
use smithay::wayland::selection::data_device::{
    ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
    request_data_device_client_selection, set_data_device_focus,
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
    /// Which history entry a compositor-owned selection stands for.
    ///
    /// Smithay hands it back verbatim in `send_selection`, and without it
    /// there would be no way to tell which of the offers we have made is
    /// the one being pasted.
    type SelectionUserData = crate::clipboard::Token;

    /// A client inside the session copied something.
    ///
    /// Read once, here, rather than left lazy. The programs that would
    /// answer a lazy offer are on the other side of a compositor boundary
    /// from the X11 client, the desktop and the tablet that might want to
    /// paste it, and by then this one may have exited. See `clipboard.rs`.
    fn new_selection(
        &mut self,
        ty: SelectionTarget,
        source: Option<SelectionSource>,
        _seat: Seat<Self>,
    ) {
        if ty != SelectionTarget::Clipboard {
            return;
        }
        // `None` is the selection being given up. Nothing to do: the
        // history keeps what it was, which is the point of a history.
        let Some(source) = source else { return };
        let offered = source.mime_types();
        let Some(mime) = crate::clipboard::best_mime(&offered) else {
            if offered.iter().any(|m| crate::clipboard::is_secret(m)) {
                tracing::debug!("a password manager's copy was left where it was");
            }
            return;
        };
        let Some(events) = self.events.clone() else {
            return;
        };

        // Deferred by one turn of the loop, and not out of caution: smithay
        // calls this handler *before* it stores the new selection, so asking
        // for it here would hand back the previous copy. Every clipboard
        // would run exactly one copy behind, which is the kind of bug that
        // looks like a race and is not one.
        self.loop_handle.insert_idle(move |state| {
            let Ok((reader, writer)) = std::io::pipe() else {
                tracing::warn!("no pipe for a clipboard read");
                return;
            };
            // The owner writes into `writer` when it receives the event this
            // posts, which goes out when the loop next flushes. Reading
            // happens on a thread, so a slow client cannot stall anything.
            if let Err(err) = request_data_device_client_selection(
                &state.seat,
                mime.clone(),
                writer.into(),
            ) {
                tracing::debug!("could not read the new selection: {err}");
                return;
            }
            crate::clipboard::read_offer(
                reader,
                mime,
                crate::clipboard::Where::Wayland,
                None,
                events,
            );
        });
    }

    /// A client wants to paste something the compositor owns.
    fn send_selection(
        &mut self,
        _ty: SelectionTarget,
        mime_type: String,
        fd: OwnedFd,
        _seat: Seat<Self>,
        user_data: &Self::SelectionUserData,
    ) {
        match self.clip_payload(user_data.0, &mime_type) {
            Some(payload) => crate::clipboard::write_offer(fd.into(), payload),
            // The entry aged out of the history between being offered and
            // being pasted. Dropping the fd is an empty paste, which is
            // better than a stall.
            None => tracing::debug!("nothing left to paste for entry {}", user_data.0),
        }
    }
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
