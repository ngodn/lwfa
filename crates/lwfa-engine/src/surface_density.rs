//! Surface scale negotiation and bounded capture sizes.
use crate::state::Lwfa;
use lwfa_proto::WindowId;
use smithay::desktop::{PopupManager, find_popup_root_surface};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Physical, Size, Transform};
use smithay::wayland::compositor::{
    TraversalAction, get_parent, send_surface_state, with_states, with_surface_tree_downward,
};
use smithay::wayland::fractional_scale::{FractionalScaleHandler, with_fractional_scale};
use smithay::wayland::seat::WaylandFocus;

/// Bound each capture before any texture or readback allocation. At most 64 MiB
/// of RGBA per target, and no dimension beyond a common encoder limit.
pub(crate) fn valid_capture_size(size: Size<i32, Physical>) -> bool {
    size.w > 0
        && size.h > 0
        && size.w <= 8192
        && size.h <= 8192
        && i64::from(size.w) * i64::from(size.h) <= 16_777_216
}

pub(crate) fn bounded_density(size: Size<i32, Logical>) -> f64 {
    let w = f64::from(size.w.max(1));
    let h = f64::from(size.h.max(1));
    // Reserve a pixel for rounding up either dimension.
    1.0_f64
        .min(8191.0 / w)
        .min(8191.0 / h)
        .min((16_769_025.0 / (w * h)).sqrt())
}

impl Lwfa {
    /// Capture at logical size. An app can refuse a configure or enforce a
    /// larger minimum, so bound its buffer before texture/readback allocation.
    pub fn capture_density(&self, id: WindowId) -> f64 {
        self.layout
            .window(id)
            .map(|window| bounded_density(window.geometry().size))
            .unwrap_or(1.0)
    }
    /// Normalized browser positions stay valid even when the displayed frame
    /// belongs to the previous window size. Older clients keep logical coordinates.
    pub fn input_coordinates(
        &self,
        id: WindowId,
        x: f64,
        y: f64,
        normalized: bool,
    ) -> Option<(f64, f64)> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        if !normalized {
            return Some((x, y));
        }
        let size = self.layout.window(id)?.geometry().size;
        let projected = (x * f64::from(size.w), y * f64::from(size.h));
        (projected.0.is_finite() && projected.1.is_finite()).then_some(projected)
    }
    fn surface_owner(&self, surface: &WlSurface) -> Option<WindowId> {
        let mut root = surface.clone();
        while let Some(parent) = get_parent(&root) {
            root = parent;
        }
        if let Some(id) = self.layout.id_of_surface(&root) {
            return Some(id);
        }
        let popup = self.popups.find_popup(&root)?;
        let root = find_popup_root_surface(&popup).ok()?;
        self.layout.id_of_surface(&root)
    }
    pub fn inherit_surface_density(&self, surface: &WlSurface, parent: &WlSurface) {
        let density = self
            .surface_owner(parent)
            .map(|id| self.capture_density(id))
            .unwrap_or(1.0);
        apply_density(surface, density);
    }
    pub fn apply_window_density(&self, id: WindowId) {
        let Some(window) = self.layout.window(id) else {
            return;
        };
        if window.is_x11() {
            return;
        }
        let Some(surface) = window.wl_surface() else {
            return;
        };
        let density = self.capture_density(id);
        apply_density(&surface, density);
        for (popup, _) in PopupManager::popups_for_surface(&surface) {
            apply_density(popup.wl_surface(), density);
        }
    }
}

fn apply_density(surface: &WlSurface, density: f64) {
    with_surface_tree_downward(
        surface,
        (),
        |_, _, _| TraversalAction::DoChildren(()),
        |surface, data, _| {
            send_surface_state(
                surface,
                data,
                density.ceil().max(1.0) as i32,
                Transform::Normal,
            );
            with_fractional_scale(data, |state| state.set_preferred_scale(density));
        },
        |_, _, _| true,
    );
}

impl FractionalScaleHandler for Lwfa {
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        let density = self
            .surface_owner(&surface)
            .map(|id| self.capture_density(id))
            .unwrap_or(1.0);
        with_states(&surface, |data| {
            with_fractional_scale(data, |state| state.set_preferred_scale(density))
        });
    }
}
smithay::delegate_fractional_scale!(Lwfa);
smithay::delegate_viewporter!(Lwfa);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_windows_capture_at_logical_size() {
        for size in [(1324, 838), (1920, 1080), (2560, 1440), (3840, 2160)] {
            assert_eq!(bounded_density(size.into()), 1.0);
        }
    }

    #[test]
    fn oversized_windows_stay_within_capture_allocation_limits() {
        for size in [
            (8192, 8192),
            (16384, 1000),
            (1000, 16384),
            (i32::MAX, i32::MAX),
        ] {
            let logical: Size<i32, Logical> = size.into();
            let density = bounded_density(logical);
            assert!(density > 0.0 && density < 1.0);
            assert!(valid_capture_size(
                logical.to_f64().to_physical(density).to_i32_round()
            ));
        }
    }

    #[test]
    fn unreasonable_capture_allocations_are_rejected() {
        assert!(valid_capture_size((2000, 1000).into()));
        assert!(!valid_capture_size((0, 1000).into()));
        assert!(!valid_capture_size((8193, 1000).into()));
        assert!(!valid_capture_size((8192, 8192).into()));
    }
}
