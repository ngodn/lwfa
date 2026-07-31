use smithay::backend::renderer::utils::on_commit_buffer_handler;
use smithay::reexports::wayland_server::Client;
use smithay::reexports::wayland_server::protocol::{wl_buffer, wl_surface::WlSurface};
use smithay::wayland::buffer::BufferHandler;
use smithay::wayland::compositor::{
    CompositorClientState, CompositorHandler, CompositorState, get_parent, is_sync_subsurface,
};
use smithay::wayland::shm::{ShmHandler, ShmState};
use smithay::{delegate_compositor, delegate_shm};

use super::xdg_shell;
use crate::state::{ClientState, Lwfa};

impl CompositorHandler for Lwfa {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
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
            if let Some(window) = self
                .space
                .elements()
                .find(|w| w.toplevel().is_some_and(|t| t.wl_surface() == &root))
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
