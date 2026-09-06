//! Xwayland needs a root coordinate space large enough for its app workspaces.
//! Its output view is independent of native Wayland's logical display size.
use crate::state::Lwfa;
use smithay::output::Output;
use smithay::reexports::wayland_protocols::xdg::xdg_output::zv1::server::{
    zxdg_output_manager_v1::{self, ZxdgOutputManagerV1},
    zxdg_output_v1::ZxdgOutputV1,
};
use smithay::reexports::wayland_server::protocol::wl_output::{self, WlOutput};
use smithay::reexports::wayland_server::{Client, DataInit, Dispatch, DisplayHandle, Resource};
use smithay::utils::{Logical, Rectangle, Size};
use smithay::wayland::output::{
    OutputHandler, OutputManagerState, OutputUserData, WlOutputData, XdgOutputUserData,
};
use smithay::xwayland::XWaylandClientData;

#[derive(Default)]
pub(crate) struct X11Outputs {
    outputs: Vec<WlOutput>,
    xdg_outputs: Vec<(ZxdgOutputV1, WlOutput)>,
    last_size: Option<Size<i32, Logical>>,
}
pub(crate) struct X11XdgOutput;

impl Lwfa {
    fn x11_root_size(&self) -> Size<i32, Logical> {
        let mut size = self.layout.output_size();
        for (id, window, _) in self.layout.placements_with_ids() {
            let Some(x11) = window.x11_surface() else {
                continue;
            };
            let actual = x11.geometry();
            let requested = self.layout.configured_rect(id).unwrap_or(actual);
            for rect in [actual, requested] {
                size = include_workspace(size, rect);
            }
        }
        (size.w.clamp(1, 32767), size.h.clamp(1, 32767)).into()
    }
    pub(crate) fn refresh_x11_outputs(&mut self, force: bool) {
        let size = self.x11_root_size();
        if !force && self.x11_outputs.last_size == Some(size) {
            return;
        }
        self.x11_outputs.last_size = Some(size);
        self.x11_outputs.outputs.retain(Resource::is_alive);
        self.x11_outputs
            .xdg_outputs
            .retain(|(xdg, output)| xdg.is_alive() && output.is_alive());
        // xdg-output v3 is committed by wl_output.done, so send it first.
        for (xdg, _) in &self.x11_outputs.xdg_outputs {
            xdg.logical_position(0, 0);
            xdg.logical_size(size.w, size.h);
            if xdg.version() < 3 {
                xdg.done();
            }
        }
        for output in &self.x11_outputs.outputs {
            output.mode(
                wl_output::Mode::Current | wl_output::Mode::Preferred,
                size.w,
                size.h,
                60_000,
            );
            if output.version() >= 2 {
                output.scale(1);
                output.done();
            }
        }
    }
}

impl OutputHandler for Lwfa {
    fn output_bound(&mut self, _output: Output, resource: WlOutput) {
        if resource
            .client()
            .is_some_and(|client| client.get_data::<XWaylandClientData>().is_some())
        {
            self.x11_outputs.outputs.push(resource);
            self.refresh_x11_outputs(true);
        }
    }
}

// Keep Smithay's normal output resources. Only Xwayland's logical output
// object is compositor-owned, so Smithay cannot overwrite it during resize.
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
        if client.get_data::<XWaylandClientData>().is_some() {
            if let zxdg_output_manager_v1::Request::GetXdgOutput { id, output } = request {
                let xdg = init.init(id, X11XdgOutput);
                if xdg.version() >= 2 {
                    xdg.name("lwfa-nested".into());
                    xdg.description("lwfa Xwayland workspace".into());
                }
                state.x11_outputs.xdg_outputs.push((xdg, output));
                state.refresh_x11_outputs(true);
            }
        } else {
            <OutputManagerState as Dispatch<ZxdgOutputManagerV1, (), Self>>::request(
                state, client, resource, request, data, dh, init,
            );
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
smithay::reexports::wayland_server::delegate_global_dispatch!(Lwfa: [WlOutput: WlOutputData] => OutputManagerState);
smithay::reexports::wayland_server::delegate_global_dispatch!(Lwfa: [ZxdgOutputManagerV1: ()] => OutputManagerState);
smithay::reexports::wayland_server::delegate_dispatch!(Lwfa: [WlOutput: OutputUserData] => OutputManagerState);
smithay::reexports::wayland_server::delegate_dispatch!(Lwfa: [ZxdgOutputV1: XdgOutputUserData] => OutputManagerState);

fn include_workspace(
    mut size: Size<i32, Logical>,
    rect: Rectangle<i32, Logical>,
) -> Size<i32, Logical> {
    size.w = size
        .w
        .max(rect.loc.x.saturating_add(rect.size.w))
        .clamp(1, 32767);
    size.h = size
        .h
        .max(rect.loc.y.saturating_add(rect.size.h))
        .clamp(1, 32767);
    size
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn x11_root_includes_scaled_apps_and_positions_without_resizing_native_output() {
        let native = Size::from((1000, 640));
        let first = include_workspace(native, Rectangle::from_size((2000, 1280).into()));
        assert_eq!(first, Size::from((2000, 1280)));
        let second = include_workspace(first, Rectangle::new((900, 0).into(), (1500, 960).into()));
        assert_eq!(second, Size::from((2400, 1280)));
        assert_eq!(native, Size::from((1000, 640)));
        let limit = include_workspace(
            native,
            Rectangle::new((i32::MAX, 0).into(), (2000, 1280).into()),
        );
        assert_eq!(limit.w, 32767);
    }
}
