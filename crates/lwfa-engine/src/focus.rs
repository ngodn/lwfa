//! What the keyboard is pointed at.
//!
//! A `wl_surface` is enough for every native client, and it was all this used
//! to be. X11 is not: giving an X11 window's `wl_surface` keyboard focus makes
//! Xwayland deliver the events, but nothing tells the *X server* which window
//! is focused, so `_NET_ACTIVE_WINDOW` stays `0x0` and the client discards
//! every key as being for somebody else. The window looks focused and answers
//! nothing.
//!
//! Smithay implements `KeyboardTarget` for `X11Surface` precisely to close
//! that gap: entering it issues `SetInputFocus`, sends `WM_TAKE_FOCUS` to
//! clients that ask for it, and *then* forwards to the `wl_surface`. This enum
//! exists so the seat can hold that implementation instead of the bare surface.
//!
//! Pointer and touch focus stay on `WlSurface`. Xwayland resolves those from
//! the surface itself, so there is nothing extra to tell the X server.

use smithay::input::Seat;
use smithay::input::keyboard::{KeyboardTarget, KeysymHandle, ModifiersState};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{IsAlive, Serial};
use smithay::wayland::seat::WaylandFocus;
use smithay::xwayland::X11Surface;

use crate::state::Lwfa;

#[derive(Debug, Clone, PartialEq)]
pub enum KeyboardFocus {
    Wayland(WlSurface),
    X11(X11Surface),
}

impl KeyboardFocus {
    /// Build a focus target from a window, picking the variant that matches
    /// what the window actually is.
    pub fn of(window: &smithay::desktop::Window) -> Option<Self> {
        match window.underlying_surface() {
            smithay::desktop::WindowSurface::Wayland(toplevel) => {
                Some(Self::Wayland(toplevel.wl_surface().clone()))
            }
            smithay::desktop::WindowSurface::X11(x11) => Some(Self::X11(x11.clone())),
        }
    }
}

impl IsAlive for KeyboardFocus {
    fn alive(&self) -> bool {
        match self {
            Self::Wayland(surface) => surface.alive(),
            Self::X11(surface) => surface.alive(),
        }
    }
}

impl WaylandFocus for KeyboardFocus {
    fn wl_surface(&self) -> Option<std::borrow::Cow<'_, WlSurface>> {
        match self {
            Self::Wayland(surface) => Some(std::borrow::Cow::Borrowed(surface)),
            Self::X11(surface) => surface.wl_surface().map(std::borrow::Cow::Owned),
        }
    }
}

/// Forward every method to whichever surface is behind the enum.
///
/// Written out rather than generated: the trait is small, and a macro here
/// would hide the one thing worth seeing, which is that both arms really do go
/// to Smithay's own implementations.
macro_rules! forward {
    ($self:ident, $method:ident ( $($arg:expr),* $(,)? )) => {
        match $self {
            KeyboardFocus::Wayland(surface) => KeyboardTarget::$method(surface, $($arg),*),
            KeyboardFocus::X11(surface) => KeyboardTarget::$method(surface, $($arg),*),
        }
    };
}

impl KeyboardTarget<Lwfa> for KeyboardFocus {
    fn enter(
        &self,
        seat: &Seat<Lwfa>,
        data: &mut Lwfa,
        keys: Vec<KeysymHandle<'_>>,
        serial: Serial,
    ) {
        forward!(self, enter(seat, data, keys, serial))
    }

    fn leave(&self, seat: &Seat<Lwfa>, data: &mut Lwfa, serial: Serial) {
        forward!(self, leave(seat, data, serial))
    }

    fn key(
        &self,
        seat: &Seat<Lwfa>,
        data: &mut Lwfa,
        key: KeysymHandle<'_>,
        state: smithay::backend::input::KeyState,
        serial: Serial,
        time: u32,
    ) {
        forward!(self, key(seat, data, key, state, serial, time))
    }

    fn modifiers(
        &self,
        seat: &Seat<Lwfa>,
        data: &mut Lwfa,
        modifiers: ModifiersState,
        serial: Serial,
    ) {
        forward!(self, modifiers(seat, data, modifiers, serial))
    }
}
