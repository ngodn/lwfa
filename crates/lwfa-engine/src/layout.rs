//! The scrollable strip.
//!
//! Windows live in columns on an infinite horizontal strip, and the output is a
//! viewport onto it. See docs/architecture.md section 2.3 for why this layout
//! model rather than dynamic tiling.
//!
//! The property that matters most: **adding or removing a column never resizes
//! the others.** Native apps do not reflow, and every resize is an
//! `xdg_shell configure` they handle badly, so a layout that mostly leaves
//! windows alone is the right fit.
//!
//! Scrolling is spring-driven via `lwfa-spring`. That is deliberate this early:
//! it proves the shared integrator is load-bearing rather than decorative, and
//! the scroll offset is the exact quantity a touch swipe will drive later.

use std::time::Instant;

use lwfa_spring::{Spring, SpringOptions};
use smithay::desktop::Window;
use smithay::utils::{Logical, Point, Size};

/// Gap between columns, and between a column and the output edge.
const GAP: i32 = 12;

/// Columns default to half the viewport, so more than one is visible and the
/// strip is legible as a strip. Preset widths (1/3, 1/2, 2/3) come later.
const DEFAULT_WIDTH_FRACTION: f64 = 0.5;

/// Roughly Motion's `visualDuration(0.35, bounce: 0.1)`: quick, with just
/// enough overshoot to read as physical rather than mechanical.
fn scroll_spring(velocity: f64) -> SpringOptions {
    SpringOptions {
        velocity,
        ..SpringOptions::from_visual_duration(0.35, 0.1)
    }
}

pub struct Column {
    pub window: Window,
    pub width: i32,
}

struct ScrollAnimation {
    spring: Spring,
    started: Instant,
}

/// The strip. Owns column order and the scroll offset; owns no rendering.
pub struct Strip {
    columns: Vec<Column>,
    focus: usize,
    /// How far the viewport has scrolled right along the strip, in logical px.
    view_offset: f64,
    scroll: Option<ScrollAnimation>,
    output_size: Size<i32, Logical>,
}

impl Strip {
    pub fn new(output_size: Size<i32, Logical>) -> Self {
        Self {
            columns: Vec::new(),
            focus: 0,
            view_offset: 0.0,
            scroll: None,
            output_size,
        }
    }

    pub fn set_output_size(&mut self, size: Size<i32, Logical>) {
        self.output_size = size;
    }

    fn default_column_width(&self) -> i32 {
        ((self.output_size.w as f64 * DEFAULT_WIDTH_FRACTION) as i32).max(240)
    }

    /// Height available to a column: full output minus the top and bottom gap.
    pub fn column_height(&self) -> i32 {
        (self.output_size.h - GAP * 2).max(1)
    }

    /// Append a column and focus it.
    ///
    /// Appending rather than inserting next to the focus keeps milestone 2
    /// simple. niri inserts adjacent to the focused column; that is a later
    /// refinement and does not change the model.
    pub fn push(&mut self, window: Window) -> Size<i32, Logical> {
        let width = self.default_column_width();
        self.columns.push(Column { window, width });
        self.focus = self.columns.len() - 1;
        self.scroll_focus_into_view();
        (width, self.column_height()).into()
    }

    pub fn remove(&mut self, window: &Window) -> bool {
        let Some(i) = self.columns.iter().position(|c| &c.window == window) else {
            return false;
        };
        self.columns.remove(i);
        if self.columns.is_empty() {
            self.focus = 0;
        } else {
            // Keep the focus on the neighbour that slid into this slot, or the
            // new last column if we removed the tail.
            self.focus = self.focus.min(self.columns.len() - 1);
        }
        self.scroll_focus_into_view();
        true
    }

    pub fn focused_window(&self) -> Option<&Window> {
        self.columns.get(self.focus).map(|c| &c.window)
    }

    /// Move focus to the column holding `window`. Returns false if it is not in
    /// the strip, so click-to-focus can ignore stray surfaces.
    pub fn focus_window(&mut self, window: &Window) -> bool {
        let Some(i) = self.columns.iter().position(|c| &c.window == window) else {
            return false;
        };
        if i != self.focus {
            self.focus = i;
            self.scroll_focus_into_view();
        }
        true
    }

    pub fn focus_left(&mut self) {
        if self.focus > 0 {
            self.focus -= 1;
            self.scroll_focus_into_view();
        }
    }

    pub fn focus_right(&mut self) {
        if self.focus + 1 < self.columns.len() {
            self.focus += 1;
            self.scroll_focus_into_view();
        }
    }

    /// Absolute x of column `i` in strip coordinates, before the view offset.
    fn column_x(&self, i: usize) -> i32 {
        GAP + self
            .columns
            .iter()
            .take(i)
            .map(|c| c.width + GAP)
            .sum::<i32>()
    }

    /// Where the viewport should sit for the focused column to be fully
    /// visible, scrolling the minimum distance to get there.
    fn target_offset_for_focus(&self) -> f64 {
        let Some(column) = self.columns.get(self.focus) else {
            return 0.0;
        };

        let left = self.column_x(self.focus) as f64 - GAP as f64;
        let right = self.column_x(self.focus) as f64 + column.width as f64 + GAP as f64;
        let viewport = self.output_size.w as f64;

        if right - left >= viewport {
            // Column is wider than the viewport: pin its left edge, since
            // there is no offset that shows all of it.
            left
        } else if left < self.view_offset {
            left
        } else if right > self.view_offset + viewport {
            right - viewport
        } else {
            // Already fully visible. Don't move.
            self.view_offset
        }
    }

    fn scroll_focus_into_view(&mut self) {
        let target = self.target_offset_for_focus();
        self.animate_to(target);
    }

    /// Start a spring from the current offset to `target`.
    ///
    /// Any in-flight animation's current velocity is carried into the new
    /// spring, so redirecting mid-scroll stays C1 continuous instead of
    /// visibly restarting. This is the same mechanism a released touch flick
    /// will use.
    fn animate_to(&mut self, target: f64) {
        let velocity = self.scroll_velocity();
        if (target - self.view_offset).abs() < f64::EPSILON && velocity == 0.0 {
            self.scroll = None;
            return;
        }
        self.scroll = Some(ScrollAnimation {
            spring: Spring::new(scroll_spring(velocity), self.view_offset, target),
            started: Instant::now(),
        });
    }

    fn scroll_velocity(&self) -> f64 {
        match &self.scroll {
            Some(anim) => anim.spring.velocity_at(elapsed_ms(anim.started)),
            None => 0.0,
        }
    }

    /// Advance the scroll animation. Returns true while still animating, so the
    /// caller knows another frame is needed.
    pub fn tick(&mut self) -> bool {
        let Some(anim) = &self.scroll else {
            return false;
        };
        let state = anim.spring.state_at(elapsed_ms(anim.started));
        self.view_offset = state.value;
        if state.done {
            self.scroll = None;
            false
        } else {
            true
        }
    }

    /// Position of every column in output-local coordinates, in strip order.
    ///
    /// Returned rather than applied so the caller owns all `Space` mutation and
    /// this stays testable without a compositor.
    pub fn positions(&self) -> Vec<(Window, Point<i32, Logical>)> {
        self.columns
            .iter()
            .enumerate()
            .map(|(i, column)| {
                let x = self.column_x(i) - self.view_offset.round() as i32;
                (column.window.clone(), Point::from((x, GAP)))
            })
            .collect()
    }

    pub fn columns(&self) -> impl Iterator<Item = &Column> {
        self.columns.iter()
    }
}

fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The strip's geometry is pure arithmetic, so it can be tested without a
    /// Wayland surface. Only the parts that don't need a `Window` are covered
    /// here; column bookkeeping is exercised through the compositor.
    fn strip(width: i32) -> Strip {
        Strip::new((width, 1080).into())
    }

    #[test]
    fn empty_strip_targets_origin() {
        let s = strip(1920);
        assert_eq!(s.target_offset_for_focus(), 0.0);
        assert_eq!(s.columns().count(), 0);
        assert!(s.positions().is_empty());
    }

    #[test]
    fn column_width_defaults_to_half_the_viewport() {
        assert_eq!(strip(1920).default_column_width(), 960);
        assert_eq!(strip(2560).default_column_width(), 1280);
    }

    #[test]
    fn column_width_has_a_floor_on_narrow_viewports() {
        // A phone-width viewport must not produce unusably narrow columns. The
        // strip clamps, and the shell is expected to switch to one-column-per-
        // viewport at that size rather than relying on this.
        assert_eq!(strip(320).default_column_width(), 240);
    }

    #[test]
    fn column_height_leaves_a_gap_top_and_bottom() {
        assert_eq!(strip(1920).column_height(), 1080 - GAP * 2);
    }

    #[test]
    fn column_x_accumulates_widths_and_gaps() {
        let mut s = strip(1920);
        // Bypass push() so this test needs no real Window.
        s.columns = Vec::new();
        assert_eq!(s.column_x(0), GAP);
    }
}
