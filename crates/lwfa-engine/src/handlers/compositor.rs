use smithay::backend::renderer::utils::on_commit_buffer_handler;
use smithay::reexports::wayland_server::Client;
use smithay::reexports::wayland_server::protocol::{wl_buffer, wl_surface::WlSurface};
use smithay::wayland::buffer::BufferHandler;
use smithay::wayland::compositor::{
    CompositorClientState, CompositorHandler, CompositorState, get_parent, is_sync_subsurface,
};
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::shm::{ShmHandler, ShmState};
use smithay::xwayland::XWaylandClientData;
use smithay::{delegate_compositor, delegate_shm};

use super::xdg_shell;
use crate::state::{ClientState, Lwfa};

impl CompositorHandler for Lwfa {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        // Xwayland is not one of our clients. Smithay creates it during
        // `XWayland::spawn` and attaches `XWaylandClientData`, so it never
        // passes through the listener that installs `ClientState`.
        if let Some(xwayland) = client.get_data::<XWaylandClientData>() {
            return &xwayland.compositor_state;
        }
        &client
            .get_data::<ClientState>()
            .expect("client was inserted with ClientState")
            .compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);

        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            // Matched through `wl_surface()` rather than `toplevel()` so that
            // X11 windows are found too: an X11 window has a `wl_surface` once
            // Xwayland has associated one, and without this it would never
            // commit its buffer and would stay blank forever.
            if let Some(window) = self
                .space
                .elements()
                .find(|w| w.wl_surface().as_deref() == Some(&root))
            {
                window.on_commit();
            }
        }

        xdg_shell::handle_commit(&mut self.popups, &self.space, surface);

        // Titles change over a window's life, so this is checked per commit
        // and diffed rather than assumed fixed at map time.
        if let Some(id) = self.layout.id_of_surface(surface) {
            self.report_window_changes(id);
        }
    }
}

impl BufferHandler for Lwfa {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for Lwfa {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

delegate_compositor!(Lwfa);
delegate_shm!(Lwfa);
