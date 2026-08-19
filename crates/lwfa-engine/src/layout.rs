//! Layout reconciliation.
//!
//! The scrollable strip used to live here. It now lives in the shell
//! (`packages/shell`), which is the point of milestone 3: the shell owns
//! *policy*, the engine owns *mechanism*. What is left is the mechanism.
//!
//! This module takes a declarative target from the shell and reconciles the
//! scene toward it, integrating springs for position. It has no opinion about
//! where windows should go.
//!
//! # Safe mode
//!
//! When no shell is connected there is still a compositor with windows in it,
//! so something has to place them. [`Mode::Safe`] shows the focused window
//! full-screen and nothing else.
//!
//! It is deliberately *not* a second strip implementation. Duplicating layout
//! policy in Rust is exactly the two-implementations-drifting problem the
//! spring parity work exists to avoid, and the duplicate would rot because
//! nobody would use it. Safe mode is a legible fallback that makes the
//! machine usable enough to start a shell, and it should stay that dumb.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use lwfa_proto::{SpringSpec, WindowId, WindowLayout};
use lwfa_spring::{Spring, SpringOptions};
use smithay::desktop::{Window, WindowSurface};
use smithay::utils::{Logical, Point, Rectangle, Size};

/// Who is deciding where windows go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// No shell connected. Focused window full-screen. See the module comment.
    Safe,
    /// A shell is driving.
    Shell,
}

/// A single animated scalar.
///
/// Position animates, size does not. See `WindowLayout` in `lwfa-proto` for
/// why: animating size means a `configure` every frame, and native apps do not
/// reflow.
#[derive(Debug, Clone, Copy)]
struct Animated {
    current: f64,
    target: f64,
    spring: Option<Spring>,
    started: Instant,
}

impl Animated {
    fn new(value: f64) -> Self {
        Self {
            current: value,
            target: value,
            spring: None,
            started: Instant::now(),
        }
    }

    fn snap_to(&mut self, target: f64) {
        self.current = target;
        self.target = target;
        self.spring = None;
    }

    /// Start (or redirect) a spring toward `target`.
    ///
    /// Any in-flight spring's current velocity is carried into the new one, so
    /// redirecting mid-flight stays C1 continuous rather than visibly
    /// restarting. `lwfa-spring` has a test pinning that property.
    ///
    /// `now` is passed in rather than read here so every window in a frame is
    /// sampled at exactly the same instant. Reading the clock per window would
    /// let two windows animating together drift apart by however long the loop
    /// over them takes, and would make this untestable without sleeping.
    fn animate_to(&mut self, target: f64, spec: SpringSpec, now: Instant) {
        if self.target == target && self.spring.is_some() {
            return; // already heading there; do not restart the clock
        }
        let velocity = self.velocity(now);
        if (target - self.current).abs() < f64::EPSILON && velocity == 0.0 {
            self.snap_to(target);
            return;
        }
        self.target = target;
        self.spring = Some(Spring::new(
            SpringOptions {
                stiffness: spec.stiffness,
                damping: spec.damping,
                mass: spec.mass,
                velocity,
                ..SpringOptions::default()
            },
            self.current,
            target,
        ));
        self.started = now;
    }

    fn velocity(&self, now: Instant) -> f64 {
        match &self.spring {
            Some(spring) => spring.velocity_at(elapsed_ms(self.started, now)),
            None => 0.0,
        }
    }

    /// Advance. Returns true while still animating.
    fn tick(&mut self, now: Instant) -> bool {
        let Some(spring) = &self.spring else {
            return false;
        };
        let state = spring.state_at(elapsed_ms(self.started, now));
        self.current = state.value;
        if state.done {
            self.spring = None;
            false
        } else {
            true
        }
    }
}

struct Tracked {
    window: Window,
    x: Animated,
    y: Animated,
    /// Last rectangle sent as a `configure`, so an unchanged layout does not
    /// re-configure every window on every message.
    ///
    /// The location half only matters for X11. An `xdg_toplevel` configure
    /// carries no position at all, and an X11 one carries both.
    sent: Option<Rectangle<i32, Logical>>,
    /// When that rectangle was sent, so a client that has not adopted it yet
    /// can be told apart from one that never will. See [`Layout::settling`].
    sent_at: Option<Instant>,
    z: i32,
    /// False when the shell omitted this window from the last `SetLayout`.
    visible: bool,
}

impl Tracked {
    /// Whether this rectangle is worth a `configure`.
    ///
    /// Wayland ignores the location, because `xdg_toplevel.configure` has no
    /// field for it: a client that moves but keeps its size has nothing new to
    /// be told, and telling it anyway would make every scroll a round of
    /// configures across every visible window.
    fn needs_configure(&self, rect: Rectangle<i32, Logical>) -> bool {
        match self.sent {
            None => true,
            Some(sent) if self.window.is_x11() => sent != rect,
            Some(sent) => sent.size != rect.size,
        }
    }

    /// Record what was asked for, and when.
    fn configured(&mut self, rect: Rectangle<i32, Logical>, now: Instant) {
        self.sent = Some(rect);
        self.sent_at = Some(now);
    }

    fn settling(&self, now: Instant, grace: Duration) -> bool {
        let asked = self.sent.zip(self.sent_at).map(|(r, at)| (r.size, at));
        still_settling(asked, self.window.geometry().size, now, grace)
    }
}

/// Whether a window is still on its way to a size it was asked for.
///
/// A client is not obliged to answer promptly, or at all. Some never reach the
/// exact size asked for, because they round to character cells or have a
/// minimum of their own, so this is deliberately not "wait until it matches":
/// it is a short window after the request during which the size a window
/// currently has is known to be provisional.
///
/// Free-standing because `Tracked` needs a real `Window`, which needs a Wayland
/// surface: the same reason the tests below cover `Animated` directly.
fn still_settling(
    asked: Option<(Size<i32, Logical>, Instant)>,
    actual: Size<i32, Logical>,
    now: Instant,
    grace: Duration,
) -> bool {
    let Some((wanted, at)) = asked else {
        return false; // never configured, so nothing is on its way
    };
    wanted != actual && now.duration_since(at) < grace
}

/// Reconciles shell-declared layout into positions the compositor can apply.
pub struct Layout {
    tracked: HashMap<WindowId, Tracked>,
    mode: Mode,
    output_size: Size<i32, Logical>,
}

/// A geometry the engine should send to a client as a `configure`.
///
/// Carries the *target* rectangle rather than the animated one. An X11 client
/// is told where it will come to rest, not where it is passing through, which
/// keeps a scroll from generating a configure per frame and leaves the client's
/// belief correct once the spring settles.
pub struct PendingConfigure {
    pub window: Window,
    pub rect: Rectangle<i32, Logical>,
}

impl Layout {
    pub fn new(output_size: Size<i32, Logical>) -> Self {
        Self {
            tracked: HashMap::new(),
            mode: Mode::Safe,
            output_size,
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    pub fn set_output_size(&mut self, size: Size<i32, Logical>) {
        self.output_size = size;
    }

    pub fn output_size(&self) -> Size<i32, Logical> {
        self.output_size
    }

    pub fn track(&mut self, id: WindowId, window: Window) {
        self.tracked.insert(
            id,
            Tracked {
                window,
                x: Animated::new(0.0),
                y: Animated::new(0.0),
                sent: None,
                sent_at: None,
                z: 0,
                // Hidden until something places it, so a window cannot flash at
                // the origin for one frame before the shell responds.
                visible: false,
            },
        );
    }

    pub fn forget(&mut self, id: WindowId) {
        self.tracked.remove(&id);
    }

    pub fn window(&self, id: WindowId) -> Option<&Window> {
        self.tracked.get(&id).map(|t| &t.window)
    }

    pub fn id_of(&self, window: &Window) -> Option<WindowId> {
        self.tracked
            .iter()
            .find(|(_, t)| &t.window == window)
            .map(|(id, _)| *id)
    }

    /// Look up by surface rather than by `Window`.
    ///
    /// Needed on destroy: by the time `toplevel_destroyed` fires the window may
    /// already be gone from the space, but the surface still identifies it.
    ///
    /// An X11 window has a `wl_surface` too, but only after Xwayland has
    /// associated one, so the lookup is by value rather than by reference.
    pub fn id_of_surface(
        &self,
        surface: &smithay::reexports::wayland_server::protocol::wl_surface::WlSurface,
    ) -> Option<WindowId> {
        self.tracked
            .iter()
            .find(|(_, t)| match t.window.underlying_surface() {
                WindowSurface::Wayland(toplevel) => toplevel.wl_surface() == surface,
                WindowSurface::X11(x11) => x11.wl_surface().as_ref() == Some(surface),
            })
            .map(|(id, _)| *id)
    }

    /// Every tracked window, regardless of visibility, in ascending id order.
    pub fn all_ids(&self) -> Vec<WindowId> {
        let mut ids: Vec<WindowId> = self.tracked.keys().copied().collect();
        ids.sort();
        ids
    }

    /// The visible window with the highest z, if any.
    pub fn topmost(&self) -> Option<WindowId> {
        self.tracked
            .iter()
            .filter(|(_, t)| t.visible)
            .max_by_key(|(id, t)| (t.z, id.0))
            .map(|(id, _)| *id)
    }

    /// Apply a layout from the shell.
    ///
    /// Total rather than incremental: windows absent from `windows` are hidden.
    /// A dropped message therefore cannot leave engine and shell disagreeing.
    ///
    /// Returns the configures the caller should send. Sizes are applied
    /// immediately; only position animates.
    pub fn apply(
        &mut self,
        windows: &[WindowLayout],
        animate: Option<SpringSpec>,
        now: Instant,
    ) -> Vec<PendingConfigure> {
        for tracked in self.tracked.values_mut() {
            tracked.visible = false;
        }

        let mut configures = Vec::new();

        for layout in windows {
            let Some(tracked) = self.tracked.get_mut(&layout.id) else {
                // A window the shell knows about but the engine has already
                // dropped. Races with a close; not worth warning about.
                continue;
            };

            tracked.visible = true;
            tracked.z = layout.z;

            match animate {
                Some(spec) => {
                    tracked.x.animate_to(layout.rect.x, spec, now);
                    tracked.y.animate_to(layout.rect.y, spec, now);
                }
                None => {
                    tracked.x.snap_to(layout.rect.x);
                    tracked.y.snap_to(layout.rect.y);
                }
            }

            let rect = Rectangle::new(
                (layout.rect.x.round() as i32, layout.rect.y.round() as i32).into(),
                (
                    (layout.rect.width.round() as i32).max(1),
                    (layout.rect.height.round() as i32).max(1),
                )
                    .into(),
            );
            if tracked.needs_configure(rect) {
                tracked.configured(rect, now);
                configures.push(PendingConfigure {
                    window: tracked.window.clone(),
                    rect,
                });
            }
        }

        configures
    }

    /// Place the focused window full-screen and hide everything else.
    ///
    /// See the module comment: this is a fallback, not a layout engine.
    pub fn apply_safe_mode(
        &mut self,
        focused: Option<WindowId>,
        now: Instant,
    ) -> Vec<PendingConfigure> {
        let size = self.output_size;
        let mut configures = Vec::new();

        for (id, tracked) in self.tracked.iter_mut() {
            let is_focused = Some(*id) == focused;
            tracked.visible = is_focused;
            tracked.z = 0;
            if !is_focused {
                continue;
            }
            tracked.x.snap_to(0.0);
            tracked.y.snap_to(0.0);
            let rect = Rectangle::new((0, 0).into(), size);
            if tracked.needs_configure(rect) {
                tracked.configured(rect, now);
                configures.push(PendingConfigure {
                    window: tracked.window.clone(),
                    rect,
                });
            }
        }

        configures
    }

    /// Advance all animations. Returns true while a redraw is still needed.
    ///
    /// One `now` for the whole frame, so windows animating together stay in
    /// lockstep regardless of how long iterating over them takes.
    pub fn tick(&mut self, now: Instant) -> bool {
        let mut animating = false;
        for tracked in self.tracked.values_mut() {
            // Not `||`, which would short-circuit and leave the second axis
            // un-ticked whenever the first was still moving.
            let x = tracked.x.tick(now);
            let y = tracked.y.tick(now);
            animating |= x | y;
        }
        animating
    }

    /// Visible windows with their current positions, in ascending z order.
    ///
    /// Rounded here, at the boundary with the scene, so the animation itself
    /// stays in floating point and does not accumulate rounding error.
    pub fn placements(&self) -> Vec<(Window, Point<i32, Logical>)> {
        let mut visible: Vec<&Tracked> = self.tracked.values().filter(|t| t.visible).collect();
        visible.sort_by_key(|t| t.z);
        visible
            .iter()
            .map(|t| {
                (
                    t.window.clone(),
                    Point::from((t.x.current.round() as i32, t.y.current.round() as i32)),
                )
            })
            .collect()
    }

    /// [`Self::placements`], with each window's id.
    ///
    /// The streaming path needs the id of every placed window, and looking each
    /// one up through [`Self::id_of`] is a linear scan inside a loop that is
    /// itself linear: quadratic per frame, growing with every open window. The
    /// map is keyed by id, so handing it out here costs nothing.
    pub fn placements_with_ids(&self) -> Vec<(WindowId, Window, Point<i32, Logical>)> {
        let mut visible: Vec<(WindowId, &Tracked)> = self
            .tracked
            .iter()
            .filter(|(_, t)| t.visible)
            .map(|(id, t)| (*id, t))
            .collect();
        visible.sort_by_key(|(_, t)| t.z);
        visible
            .into_iter()
            .map(|(id, t)| {
                (
                    id,
                    t.window.clone(),
                    Point::from((t.x.current.round() as i32, t.y.current.round() as i32)),
                )
            })
            .collect()
    }

    /// Whether this window is still on its way to the size it was last asked for.
    ///
    /// Streaming reads this to avoid encoding a frame at a size that is already
    /// on its way out. Every such frame costs a session rebuild now and another
    /// one moments later, because neither H.264 nor HEVC can change resolution
    /// mid-stream. See `state::stream_frames` and `SETTLE_GRACE`.
    pub fn settling(&self, id: WindowId, now: Instant, grace: Duration) -> bool {
        self.tracked
            .get(&id)
            .is_some_and(|tracked| tracked.settling(now, grace))
    }

    /// Windows the shell left out of the current layout.
    pub fn hidden(&self) -> Vec<Window> {
        self.tracked
            .values()
            .filter(|t| !t.visible)
            .map(|t| t.window.clone())
            .collect()
    }
}

fn elapsed_ms(since: Instant, now: Instant) -> f64 {
    now.saturating_duration_since(since).as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // `Tracked` needs a real `Window`, which needs a Wayland surface, so these
    // cover `Animated` directly. End-to-end placement is covered by the
    // integration check in scripts/dev-nested.sh.

    fn spec() -> SpringSpec {
        SpringSpec {
            stiffness: 220.0,
            damping: 26.0,
            mass: 1.0,
        }
    }

    /// A fixed instant plus offsets, so tests are deterministic and do not
    /// sleep. This is the payoff for passing `now` in rather than reading the
    /// clock inside `Animated`.
    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    fn size(w: i32, h: i32) -> Size<i32, Logical> {
        Size::from((w, h))
    }

    #[test]
    fn a_window_that_has_reached_its_size_is_not_settling() {
        let now = Instant::now();
        let asked = Some((size(1192, 860), now));
        assert!(!still_settling(
            asked,
            size(1192, 860),
            now,
            Duration::from_millis(250)
        ));
    }

    #[test]
    fn one_that_has_not_is() {
        // The measured case: a session joins, the output resizes, and for the
        // next 180ms the window is still the size it was. Encoding it there
        // built a 2560x1440 encoder that lived for thirty milliseconds.
        let now = Instant::now();
        let asked = Some((size(1192, 860), now));
        assert!(still_settling(
            asked,
            size(2560, 1440),
            at(now, 180),
            Duration::from_millis(250)
        ));
    }

    #[test]
    fn a_client_that_never_adopts_its_size_is_waited_on_only_briefly() {
        // A terminal rounding to character cells never matches exactly. It
        // must not hold its own picture hostage forever, so the grace, not the
        // match, is what ends the wait.
        let now = Instant::now();
        let asked = Some((size(1192, 860), now));
        let grace = Duration::from_millis(250);
        assert!(still_settling(asked, size(1190, 856), at(now, 249), grace));
        assert!(!still_settling(asked, size(1190, 856), at(now, 251), grace));
    }

    #[test]
    fn a_window_nobody_has_configured_is_not_settling() {
        // A window in its first moments has been asked for nothing, so there
        // is nothing to wait for and its first frame should not be delayed.
        assert!(!still_settling(
            None,
            size(800, 600),
            Instant::now(),
            Duration::from_millis(250)
        ));
    }

    #[test]
    fn snapping_lands_exactly_and_stops() {
        let now = Instant::now();
        let mut a = Animated::new(0.0);
        a.snap_to(619.0);
        assert_eq!(a.current, 619.0);
        assert!(!a.tick(now), "a snapped value should not be animating");
    }

    #[test]
    fn animating_starts_where_it_was() {
        let now = Instant::now();
        let mut a = Animated::new(100.0);
        a.animate_to(500.0, spec(), now);
        a.tick(now);
        assert_eq!(a.current, 100.0);
    }

    #[test]
    fn animating_to_the_current_value_does_not_start_a_spring() {
        let now = Instant::now();
        let mut a = Animated::new(42.0);
        a.animate_to(42.0, spec(), now);
        assert!(!a.tick(now));
        assert_eq!(a.current, 42.0);
    }

    #[test]
    fn redirecting_to_the_same_target_does_not_restart_the_clock() {
        // The shell re-sends its whole layout on every change. If an unchanged
        // window restarted its spring each time, a window would freeze in place
        // whenever anything else on screen moved.
        let now = Instant::now();
        let mut a = Animated::new(0.0);
        a.animate_to(500.0, spec(), now);
        let started = a.started;
        a.animate_to(500.0, spec(), at(now, 100));
        assert_eq!(a.started, started, "clock should not have restarted");
    }

    #[test]
    fn redirecting_elsewhere_carries_velocity() {
        // The property the scroll depends on: redirecting mid-flight stays C1
        // continuous instead of visibly restarting from a standstill.
        let now = Instant::now();
        let mut a = Animated::new(0.0);
        a.animate_to(500.0, spec(), now);

        // 80ms in, the spring is moving fast.
        let mid = at(now, 80);
        a.tick(mid);
        let velocity = a.velocity(mid);
        assert!(velocity > 1.0, "spring should be moving, got {velocity}");
        let position = a.current;

        a.animate_to(-100.0, spec(), mid);
        let redirected = a.spring.expect("redirect should have created a spring");
        assert!(
            (redirected.velocity_at(0.0) - velocity).abs() < 1e-9,
            "velocity should carry: {velocity} vs {}",
            redirected.velocity_at(0.0)
        );
        assert!(
            (redirected.value_at(0.0) - position).abs() < 1e-9,
            "position should carry: {position} vs {}",
            redirected.value_at(0.0)
        );
    }

    #[test]
    fn a_spring_eventually_settles_on_its_target() {
        let now = Instant::now();
        let mut a = Animated::new(0.0);
        a.animate_to(500.0, spec(), now);

        let settle = a
            .spring
            .expect("spring")
            .settle_time_ms(20_000.0, 4.0)
            .ceil() as u64;
        assert!(!a.tick(at(now, settle)), "should have stopped animating");
        assert_eq!(a.current, 500.0, "should land exactly on the target");
    }

    #[test]
    fn a_frame_samples_every_window_at_the_same_instant() {
        // Two values animating together must stay in lockstep. Reading the
        // clock per value would let them drift by however long the loop takes.
        let now = Instant::now();
        let mut a = Animated::new(0.0);
        let mut b = Animated::new(0.0);
        a.animate_to(500.0, spec(), now);
        b.animate_to(500.0, spec(), now);

        let frame = at(now, 50);
        a.tick(frame);
        b.tick(frame);
        assert_eq!(a.current, b.current);
    }
}
