//! Stable Xwayland display, independent of streamed window workspaces.
use crate::state::Lwfa;
use smithay::reexports::wayland_protocols::xdg::xdg_output::zv1::server::{
    zxdg_output_manager_v1::{self, ZxdgOutputManagerV1},
    zxdg_output_v1::ZxdgOutputV1,
};
use smithay::reexports::wayland_server::protocol::{
    wl_output::{self, WlOutput},
    wl_surface::WlSurface,
};
use smithay::reexports::wayland_server::{
    Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
};
use smithay::utils::{Logical, Size};
use smithay::wayland::output::{
    OutputHandler, OutputManagerState, OutputUserData, WlOutputData, XdgOutputUserData,
};
use smithay::xwayland::XWaylandClientData;

#[derive(Default)]
pub(crate) struct X11Outputs {
    size: Option<Size<i32, Logical>>,
    outputs: Vec<WlOutput>,
    surfaces: Vec<WlSurface>,
}
pub(crate) struct X11Output;
pub(crate) struct X11XdgOutput;

impl X11Outputs {
    pub fn enter(&mut self, surface: &WlSurface) {
        if !surface
            .client()
            .is_some_and(|c| c.get_data::<XWaylandClientData>().is_some())
        {
            return;
        }
        self.outputs.retain(Resource::is_alive);
        self.surfaces.retain(Resource::is_alive);
        for output in &self.outputs {
            if output.client() == surface.client() {
                surface.enter(output);
            }
        }
        self.surfaces.push(surface.clone());
    }
}

impl OutputHandler for Lwfa {}

// Own Xwayland's wl_output resources from bind time. Registering them with
// Smithay first would leak native viewport mode changes before an override.
impl GlobalDispatch<WlOutput, WlOutputData> for Lwfa {
    fn bind(
        state: &mut Self,
        dh: &DisplayHandle,
        client: &Client,
        resource: New<WlOutput>,
        global_data: &WlOutputData,
        init: &mut DataInit<'_, Self>,
    ) {
        if client.get_data::<XWaylandClientData>().is_none() {
            <OutputManagerState as GlobalDispatch<WlOutput, WlOutputData, Self>>::bind(
                state,
                dh,
                client,
                resource,
                global_data,
                init,
            );
            return;
        }
        let size = *state.x11_outputs.size.get_or_insert_with(|| {
            display_size(
                state.viewport_override
                    .map(|(w, h, _)| (w, h).into())
                    .unwrap_or_else(|| state.layout.output_size()),
                state.config.session.xwayland_resolution,
            )
        });
        state.layout.set_x11_output_size(size);
        let output = init.init(resource, X11Output);
        output.geometry(
            0,
            0,
            0,
            0,
            wl_output::Subpixel::Unknown,
            "lwfa".into(),
            "Xwayland".into(),
            wl_output::Transform::Normal,
        );
        output.mode(
            wl_output::Mode::Current | wl_output::Mode::Preferred,
            size.w,
            size.h,
            60_000,
        );
        if output.version() >= 4 {
            output.name("lwfa-nested".into());
            output.description("lwfa Xwayland display".into());
        }
        if output.version() >= 2 {
            output.scale(1);
            output.done();
        }
        state.x11_outputs.surfaces.retain(Resource::is_alive);
        for surface in &state.x11_outputs.surfaces {
            if surface.client().as_ref() == Some(client) {
                surface.enter(&output);
            }
        }
        state.x11_outputs.outputs.retain(Resource::is_alive);
        state.x11_outputs.outputs.push(output);
    }
}

impl Dispatch<WlOutput, X11Output> for Lwfa {
    fn request(
        _state: &mut Self,
        _client: &Client,
        _resource: &WlOutput,
        _request: wl_output::Request,
        _data: &X11Output,
        _dh: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
    }
}

impl Dispatch<ZxdgOutputManagerV1, ()> for Lwfa {
    fn request(
        state: &mut Self,
        client: &Client,
        resource: &ZxdgOutputManagerV1,
        request: zxdg_output_manager_v1::Request,
        data: &(),
        dh: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if client.get_data::<XWaylandClientData>().is_none() {
            <OutputManagerState as Dispatch<ZxdgOutputManagerV1, (), Self>>::request(
                state, client, resource, request, data, dh, init,
            );
            return;
        }
        if let zxdg_output_manager_v1::Request::GetXdgOutput { id, output } = request {
            let xdg = init.init(id, X11XdgOutput);
            let size = state
                .x11_outputs
                .size
                .expect("wl_output was bound before xdg-output");
            if xdg.version() >= 2 {
                xdg.name("lwfa-nested".into());
                xdg.description("lwfa Xwayland display".into());
            }
            xdg.logical_position(0, 0);
            xdg.logical_size(size.w, size.h);
            if xdg.version() < 3 {
                xdg.done();
            }
            if output.version() >= 2 {
                output.done();
            }
        }
    }
}
impl Dispatch<ZxdgOutputV1, X11XdgOutput> for Lwfa {
    fn request(
        _state: &mut Self,
        _client: &Client,
        _resource: &ZxdgOutputV1,
        _request: smithay::reexports::wayland_protocols::xdg::xdg_output::zv1::server::zxdg_output_v1::Request,
        _data: &X11XdgOutput,
        _dh: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
    }
}
smithay::reexports::wayland_server::delegate_global_dispatch!(Lwfa: [ZxdgOutputManagerV1: ()] => OutputManagerState);
smithay::reexports::wayland_server::delegate_dispatch!(Lwfa: [WlOutput: OutputUserData] => OutputManagerState);
smithay::reexports::wayland_server::delegate_dispatch!(Lwfa: [ZxdgOutputV1: XdgOutputUserData] => OutputManagerState);

fn display_size(fallback: Size<i32, Logical>, configured: Option<[u32; 2]>) -> Size<i32, Logical> {
    if let Some([w, h]) = configured {
        if (1..=8192).contains(&w) && (1..=8192).contains(&h) {
            return (w as i32, h as i32).into();
        }
        tracing::warn!(
            "session.xwayland_resolution requires two dimensions between 1 and 8192; using startup display size"
        );
    }
    (fallback.w.clamp(1, 8192), fallback.h.clamp(1, 8192)).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_resolution_defaults_to_startup_and_accepts_an_explicit_reserve() {
        let initial = (1319, 839).into();
        assert_eq!(display_size(initial, None), initial);
        assert_eq!(
            display_size(initial, Some([3840, 2160])),
            (3840, 2160).into()
        );
        assert_eq!(display_size(initial, Some([0, 2160])), initial);
        assert_eq!(display_size(initial, Some([8193, 2160])), initial);
    }
}
