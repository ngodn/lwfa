//! XWayland: X11 clients in a Wayland compositor.
//!
//! Xwayland runs as a child process that speaks X11 to its clients and Wayland
//! to us. It is not a translation layer we can ignore, because X11 clients
//! expect a window manager to exist, so lwfa has to be one: reparenting,
//! stacking, focus, and the property round trips that go with them. Smithay's
//! `X11Wm` does the protocol; this module supplies the policy, which is the
//! same policy the Wayland side already has.
//!
//! Why bother, when most things are native Wayland now: Steam is X11, so
//! everything under Proton is X11, and so are older GTK2/Qt4 programs and any
//! Electron build without the ozone flags. Without this they do not fall back
//! gracefully, they fail to start.
//!
//! ## What is deliberately absent
//!
//! `resize_request` and `move_request` are no-ops, exactly as in `xdg_shell.rs`
//! and for exactly the same reason: under scrollable tiling windows do not
//! float, so a client asking to be dragged has nothing to be granted.
//!
//! Maximise and fullscreen requests are also refused. The shell owns column
//! width, and an X11 client that could take the whole strip on its own would be
//! deciding layout, which is the one thing the engine does not let anything do.
//!
//! ## Override-redirect
//!
//! Menus, tooltips and drag icons are `override-redirect`: X11 windows that
//! opt out of window management entirely and place themselves. They are mapped
//! where the client asked and are *not* given a `WindowId`, so the shell never
//! sees them and never lays them out.
//!
//! A remote frame is addressed by window id and these have none, so rather than
//! invent ids for them they are drawn into the frame of whichever window they
//! sit on top of. See `Lwfa::overlays_for`, which does the same for Wayland
//! popups.

use smithay::delegate_xwayland_shell;
use smithay::desktop::{Window, WindowSurface};
use smithay::utils::{Logical, Rectangle};
use smithay::wayland::xwayland_shell::{XWaylandShellHandler, XWaylandShellState};
use smithay::xwayland::xwm::{Reorder, ResizeEdge, WmWindowProperty, XwmId};
use smithay::xwayland::{X11Surface, X11Wm, XwmHandler};

use crate::layout::Mode;
use crate::state::Lwfa;
use lwfa_proto::ToShell;

impl XWaylandShellHandler for Lwfa {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }
}

impl XwmHandler for Lwfa {
    fn xwm_state(&mut self, _xwm: XwmId) -> &mut X11Wm {
        self.xwm
            .as_mut()
            .expect("xwm callback before the wm exists")
    }

    fn new_window(&mut self, _xwm: XwmId, _surface: X11Surface) {
        // X11 creates windows long before it maps them, and many are never
        // mapped at all. Announcing here would show the shell windows that do
        // not exist yet; `map_window_request` is the real event.
    }

    fn new_override_redirect_window(&mut self, _xwm: XwmId, _surface: X11Surface) {}

    /// The X11 equivalent of a toplevel appearing. Mirrors `new_toplevel`.
    fn map_window_request(&mut self, _xwm: XwmId, surface: X11Surface) {
        if let Err(err) = surface.set_mapped(true) {
            tracing::warn!("failed to map an X11 window: {err}");
            return;
        }

        let window = Window::new_x11_window(surface);
        let id = self.next_window_id();
        self.layout.track(id, window.clone());

        // Off-screen with no size yet, like the Wayland path: invisible until
        // something places it, so it cannot flash at the origin for a frame.
        self.space.map_element(window, (0, 0), false);

        match self.layout.mode() {
            Mode::Shell => {
                if let Some(info) = self.window_info(id) {
                    self.send_to_shell(ToShell::WindowOpened { window: info });
                }
                self.set_focus(Some(id), true);
            }
            Mode::Safe => {
                self.set_focus(Some(id), false);
                self.apply_safe_mode();
            }
        }
    }

    /// A menu or tooltip placing itself. See the module comment.
    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, surface: X11Surface) {
        let location = surface.geometry().loc;
        self.space
            .map_element(Window::new_x11_window(surface), location, true);
    }

    fn unmapped_window(&mut self, _xwm: XwmId, surface: X11Surface) {
        let was_popup = surface.is_override_redirect();
        self.drop_x11_window(&surface);
        if !was_popup
            && let Err(err) = surface.set_mapped(false)
        {
            tracing::warn!("failed to unmap an X11 window: {err}");
        }
        // A menu closing is the moment the focus re-assert has been waiting
        // for: it is refused while a popup is up, because bouncing focus is
        // what dismisses menus. See `Lwfa::reassert_focus`.
        if was_popup {
            self.schedule_reassert();
        }
    }

    fn destroyed_window(&mut self, _xwm: XwmId, surface: X11Surface) {
        // Usually already gone via `unmapped_window`; a client that dies
        // without unmapping arrives straight here.
        self.drop_x11_window(&surface);
    }

    /// What the client would like. Honoured only while nothing else has an
    /// opinion, which means: before the shell has placed it.
    fn configure_request(
        &mut self,
        _xwm: XwmId,
        surface: X11Surface,
        x: Option<i32>,
        y: Option<i32>,
        w: Option<u32>,
        h: Option<u32>,
        _reorder: Option<Reorder>,
    ) {
        // Once a window is tracked, its geometry belongs to the layout, and
        // granting this would let a client fight the strip.
        if self.id_of_x11(&surface).is_some() {
            let geometry = surface.geometry();
            let _ = surface.configure(geometry);
            return;
        }

        let mut geometry = surface.geometry();
        if let Some(x) = x {
            geometry.loc.x = x;
        }
        if let Some(y) = y {
            geometry.loc.y = y;
        }
        if let Some(w) = w {
            geometry.size.w = w as i32;
        }
        if let Some(h) = h {
            geometry.size.h = h as i32;
        }
        if let Err(err) = surface.configure(geometry) {
            tracing::warn!("failed to answer an X11 configure request: {err}");
        }
    }

    /// Xwayland telling us where an override-redirect window ended up. Managed
    /// windows are placed by the layout, so only the unmanaged ones move here.
    fn configure_notify(
        &mut self,
        _xwm: XwmId,
        surface: X11Surface,
        geometry: Rectangle<i32, Logical>,
        _above: Option<u32>,
    ) {
        if !surface.is_override_redirect() {
            return;
        }
        let Some(window) = self
            .space
            .elements()
            .find(|w| w.x11_surface() == Some(&surface))
            .cloned()
        else {
            return;
        };
        self.space.map_element(window, geometry.loc, false);
    }

    /// X11 renames arrive here rather than on a Wayland commit, which is where
    /// the equivalent is noticed for native clients.
    fn property_notify(&mut self, _xwm: XwmId, surface: X11Surface, property: WmWindowProperty) {
        if !matches!(property, WmWindowProperty::Title | WmWindowProperty::Class) {
            return;
        }
        if let Some(id) = self.id_of_x11(&surface) {
            self.report_window_changes(id);
        }
    }

    /// No-op: the shell owns window position. See the module comment.
    fn move_request(&mut self, _xwm: XwmId, _surface: X11Surface, _button: u32) {}

    /// No-op: the shell owns column width. See the module comment.
    fn resize_request(
        &mut self,
        _xwm: XwmId,
        _surface: X11Surface,
        _button: u32,
        _edges: ResizeEdge,
    ) {
    }

    /// Refused, and the client is told so. Silence would leave it waiting for a
    /// state change that is never coming.
    fn maximize_request(&mut self, _xwm: XwmId, surface: X11Surface) {
        let _ = surface.set_maximized(false);
    }

    /// Forwarded to the shell, which owns the arrangement, exactly as the
    /// Wayland path does. This used to refuse outright, so the fullscreen
    /// button in an X11 video player did nothing at all.
    fn fullscreen_request(&mut self, _xwm: XwmId, surface: X11Surface) {
        self.request_fullscreen_x11(&surface, true);
    }

    fn unmaximize_request(&mut self, _xwm: XwmId, surface: X11Surface) {
        let _ = surface.set_maximized(false);
    }

    fn unfullscreen_request(&mut self, _xwm: XwmId, surface: X11Surface) {
        self.request_fullscreen_x11(&surface, false);
    }

    /// Xwayland went away. Everything it owned goes with it, and the compositor
    /// carries on with its Wayland clients.
    fn disconnected(&mut self, _xwm: XwmId) {
        tracing::warn!("xwayland disconnected; X11 clients are gone");
        self.xwm = None;
        self.xdisplay = None;
        for id in self.x11_window_ids() {
            self.retire_window(id);
        }
    }
}

impl Lwfa {
    /// The id of a tracked X11 window, if the layout knows this surface.
    fn id_of_x11(&self, surface: &X11Surface) -> Option<lwfa_proto::WindowId> {
        self.layout.all_ids().into_iter().find(|id| {
            self.layout
                .window(*id)
                .is_some_and(|w| w.x11_surface() == Some(surface))
        })
    }

    fn x11_window_ids(&self) -> Vec<lwfa_proto::WindowId> {
        self.layout
            .all_ids()
            .into_iter()
            .filter(|id| {
                self.layout
                    .window(*id)
                    .is_some_and(|w| matches!(w.underlying_surface(), WindowSurface::X11(_)))
            })
            .collect()
    }

    /// Retire an X11 window, if it was one the shell knew about.
    ///
    /// Override-redirect windows are only in the space, never in the layout,
    /// so they are unmapped and nothing else.
    fn drop_x11_window(&mut self, surface: &X11Surface) {
        let mapped = self
            .space
            .elements()
            .find(|w| w.x11_surface() == Some(surface))
            .cloned();
        if let Some(window) = mapped {
            self.space.unmap_elem(&window);
        }

        if let Some(id) = self.id_of_x11(surface) {
            self.retire_window(id);
        }
    }
}

delegate_xwayland_shell!(Lwfa);
