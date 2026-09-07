//! Per-window logical workspace and physical capture density.
use crate::state::Lwfa;
use lwfa_proto::{ScalingMode, WindowId, WindowScaling};
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

pub(crate) fn bounded_density(size: Size<i32, Logical>, requested: f64) -> f64 {
    let w = f64::from(size.w.max(1));
    let h = f64::from(size.h.max(1));
    // Reserve a pixel for rounding up either dimension.
    requested
        .min(8191.0 / w)
        .min(8191.0 / h)
        .min((16_769_025.0 / (w * h)).sqrt())
}

pub(crate) fn resolved_scale(scaling: WindowScaling, x11: bool, display: f64) -> f64 {
    if scaling.mode == ScalingMode::Sharp && x11 {
        return 1.0;
    }
    scaling.scale.unwrap_or_else(|| {
        if scaling.mode == ScalingMode::Sharp && display.is_finite() {
            display.clamp(1.0, 2.0)
        } else {
            1.0
        }
    })
}

fn auto_scale_refresh_needed(
    scaling: WindowScaling,
    x11: bool,
    size: Size<i32, Logical>,
    previous_display_scale: f64,
    display_scale: f64,
) -> bool {
    if scaling.mode != ScalingMode::Sharp || scaling.scale.is_some() {
        return false;
    }
    let before = bounded_density(size, resolved_scale(scaling, x11, previous_display_scale));
    let after = bounded_density(size, resolved_scale(scaling, x11, display_scale));
    before != after
}

impl Lwfa {
    pub fn window_scaling(&self, id: WindowId) -> WindowScaling {
        self.scaling.get(&id).copied().unwrap_or_default()
    }
    pub fn effective_scale(&self, id: WindowId) -> f64 {
        let requested = resolved_scale(
            self.window_scaling(id),
            self.layout.window(id).is_some_and(|w| w.is_x11()),
            self.viewport_override.map(|v| v.2).unwrap_or(1.0),
        );
        let size = if self.window_scaling(id).mode == ScalingMode::Workspace {
            self.layout.preview_rect(id).map(|rect| rect.size)
        } else {
            self.layout.window(id).map(|window| window.geometry().size)
        };
        if self.layout.window(id).is_some_and(|w| w.is_x11())
            && self.window_scaling(id).mode == ScalingMode::Workspace
            && let (Some(base), Some(configured)) = (size, self.layout.workspace_rect_for(id, requested))
        {
            return (f64::from(configured.size.w) / f64::from(base.w.max(1)))
                .min(f64::from(configured.size.h) / f64::from(base.h.max(1)));
        }
        size.map(|size| bounded_density(size, requested))
            .unwrap_or(requested)
    }
    pub fn capture_density(&self, id: WindowId) -> f64 {
        if self.window_scaling(id).mode == ScalingMode::Sharp {
            self.effective_scale(id)
        } else {
            // An app can refuse a configure or enforce a larger minimum. Keep
            // its current buffer streamable without allocating beyond the cap.
            self.layout
                .window(id)
                .map(|window| bounded_density(window.geometry().size, 1.0))
                .unwrap_or(1.0)
        }
    }
    pub fn set_window_scaling(
        &mut self,
        id: WindowId,
        mut scaling: WindowScaling,
    ) -> Result<(), &'static str> {
        if !scaling.valid() {
            return Err("Choose a supported window scaling factor");
        }
        let Some(window) = self.layout.window(id) else {
            return Err("This window has closed");
        };
        if window.is_x11() && scaling.mode == ScalingMode::Sharp && scaling.scale != Some(1.0) {
            return Err(
                "Render density is unavailable for Xwayland windows. Use workspace scaling or run the app with native Wayland support.",
            );
        }
        if scaling.mode == ScalingMode::Workspace && scaling.scale.is_none() {
            scaling.scale = Some(1.0);
        }
        if self.window_scaling(id) == scaling {
            return Ok(());
        }
        self.scaling.insert(id, scaling);
        let factor = if scaling.mode == ScalingMode::Workspace {
            scaling.scale.unwrap_or(1.0)
        } else {
            1.0
        };
        let pending = self
            .layout
            .set_workspace_scale(id, factor, std::time::Instant::now());
        self.send_configures(pending.into_iter().collect());
        self.apply_window_density(id);
        self.reset_scaled_capture(id);
        self.report_window_changes(id);
        Ok(())
    }
    pub fn refresh_auto_scaling(&mut self, previous_display_scale: f64) {
        let display_scale = self.viewport_override.map(|v| v.2).unwrap_or(1.0);
        // A viewport resize need not change any window's capture density.
        // Actual window resizes already invalidate capture targets and encoder
        // sessions when their dimensions change.
        let ids: Vec<_> = self
            .scaling
            .iter()
            .filter_map(|(id, scaling)| {
                let window = self.layout.window(*id)?;
                auto_scale_refresh_needed(
                    *scaling, window.is_x11(), window.geometry().size,
                    previous_display_scale, display_scale,
                ).then_some(*id)
            })
            .collect();
        for id in ids {
            self.apply_window_density(id);
            self.reset_scaled_capture(id);
            self.report_window_changes(id);
        }
    }
    fn reset_scaled_capture(&mut self, id: WindowId) {
        self.capture.forget(id);
        if let Some(worker) = &self.encoders {
            worker.forget(id);
        }
    }
    /// Normalized browser positions stay valid even when the displayed frame
    /// belongs to the previous density. Older clients keep logical coordinates.
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
    fn scale_owner(&self, surface: &WlSurface) -> Option<WindowId> {
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
            .scale_owner(parent)
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
            .scale_owner(&surface)
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
    fn viewport_changes_rebuild_only_when_auto_capture_density_changes() {
        let auto = WindowScaling { mode: ScalingMode::Sharp, scale: None };
        let size = (1000, 640).into();
        // Repeated viewport resizes at the same DPR should keep the stream
        // alive. Moving to a denser display must still rebuild it once.
        let display_scales = [1.0, 1.0, 1.0, 1.5, 1.5, 2.0, 3.0, 2.0];
        let resets: Vec<_> = display_scales.windows(2)
            .filter(|pair| auto_scale_refresh_needed(auto, false, size, pair[0], pair[1]))
            .map(|pair| (pair[0], pair[1]))
            .collect();
        assert_eq!(resets, vec![(1.0, 1.5), (1.5, 2.0)]);
    }

    #[test]
    fn auto_density_caps_do_not_restart_unchanged_streams() {
        let auto = WindowScaling { mode: ScalingMode::Sharp, scale: None };
        assert!(!auto_scale_refresh_needed(auto, true, (1000, 640).into(), 1.0, 2.0));
        assert!(!auto_scale_refresh_needed(auto, false, (8000, 4000).into(), 1.0, 2.0));
        assert!(auto_scale_refresh_needed(auto, false, (1000, 640).into(), 2.0, 1.0));
        for scaling in [
            WindowScaling { mode: ScalingMode::Sharp, scale: Some(1.5) },
            WindowScaling { mode: ScalingMode::Workspace, scale: None },
        ] {
            assert!(!auto_scale_refresh_needed(scaling, false, (1000, 640).into(), 1.0, 2.0));
        }
    }

    #[test]
    fn exact_factors_and_auto_do_not_change_the_xwayland_client_scale() {
        for factor in [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] {
            let sharp = WindowScaling {
                mode: ScalingMode::Sharp,
                scale: Some(factor),
            };
            assert!(sharp.valid());
            assert_eq!(resolved_scale(sharp, false, 1.0), factor);
            assert_eq!(resolved_scale(sharp, true, 2.0), 1.0);
            assert_eq!(
                resolved_scale(
                    WindowScaling {
                        mode: ScalingMode::Workspace,
                        ..sharp
                    },
                    true,
                    2.0
                ),
                factor
            );
        }
        assert!(
            !WindowScaling {
                scale: Some(f64::NAN),
                ..Default::default()
            }
            .valid()
        );
        assert!(
            !WindowScaling {
                scale: Some(1.1),
                ..Default::default()
            }
            .valid()
        );
        assert_eq!(
            resolved_scale(
                WindowScaling {
                    scale: None,
                    ..Default::default()
                },
                false,
                3.0
            ),
            2.0
        );
    }
    #[test]
    fn unreasonable_capture_allocations_are_rejected() {
        assert!(valid_capture_size((2000, 1000).into()));
        assert!(!valid_capture_size((0, 1000).into()));
        assert!(!valid_capture_size((8193, 1000).into()));
        assert!(!valid_capture_size((8192, 8192).into()));
    }
}
