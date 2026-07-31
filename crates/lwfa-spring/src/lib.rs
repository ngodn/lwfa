//! Spring integrator for lwfa.
//!
//! This is a deliberate, line-by-line port of Motion's spring solver
//! (`motion-dom` 12.43.0, `dist/es/animation/generators/spring.mjs`).
//!
//! Why a port and not "something spring-shaped": lwfa renders the same shell
//! through two backends. Locally the engine composites app surfaces natively on
//! the GPU; remotely the browser composites decoded frames in the DOM. The shell
//! sends animation *intents* (target state + spring parameters), and each backend
//! integrates the spring itself at its own refresh rate. If the two integrators
//! disagree, the same window animation looks different depending on where the
//! user is sitting. So they have to agree, and the way to guarantee that is to
//! share one closed-form solution and test it across the language boundary.
//!
//! Motion is the reference because the shell already uses it for chrome
//! (panels, launcher, notifications). Matching it means a window animation and a
//! panel animation with the same parameters land on the same curve.
//!
//! Time is in **milliseconds** throughout, matching Motion. Velocities on the
//! public API are in **units per second**, also matching Motion.
//!
//! Not yet ported: `findSpring`, the Newton-iteration resolver for the
//! `duration` + `bounce` form. [`SpringOptions::from_visual_duration`] covers the
//! ergonomic case with a closed form. See docs/architecture.md.

#![forbid(unsafe_code)]

use std::f64::consts::PI;

/// Motion's `springDefaults`.
const DEFAULT_STIFFNESS: f64 = 100.0;
const DEFAULT_DAMPING: f64 = 10.0;
const DEFAULT_MASS: f64 = 1.0;
const DEFAULT_VELOCITY: f64 = 0.0;

const REST_SPEED_GRANULAR: f64 = 0.01;
const REST_SPEED_DEFAULT: f64 = 2.0;
const REST_DELTA_GRANULAR: f64 = 0.005;
const REST_DELTA_DEFAULT: f64 = 0.5;

const MIN_DAMPING: f64 = 0.05;
const MAX_DAMPING: f64 = 1.0;

/// Motion caps `sinh`/`cosh` arguments here so overdamped springs cannot
/// overflow to infinity at large `t`.
const OVERDAMPED_FREQ_CAP: f64 = 300.0;

/// A displacement smaller than this counts as "granular" (opacity, scale) and
/// gets tighter rest thresholds than a pixel-scale move.
const GRANULAR_SCALE: f64 = 5.0;

fn clamp(min: f64, max: f64, v: f64) -> f64 {
    v.max(min).min(max)
}

/// Physics parameters for a spring.
///
/// Defaults match Motion: stiffness 100, damping 10, mass 1, velocity 0. Note
/// that <https://motion.dev/docs/react-transitions> documents `stiffness` as
/// defaulting to 1; the shipped source says 100. The source wins.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringOptions {
    pub stiffness: f64,
    pub damping: f64,
    pub mass: f64,
    /// Initial velocity, in units per second.
    pub velocity: f64,
    /// Override the "close enough in speed" threshold. `None` picks Motion's
    /// scale-dependent default.
    pub rest_speed: Option<f64>,
    /// Override the "close enough in distance" threshold. `None` picks Motion's
    /// scale-dependent default.
    pub rest_delta: Option<f64>,
}

impl Default for SpringOptions {
    fn default() -> Self {
        Self {
            stiffness: DEFAULT_STIFFNESS,
            damping: DEFAULT_DAMPING,
            mass: DEFAULT_MASS,
            velocity: DEFAULT_VELOCITY,
            rest_speed: None,
            rest_delta: None,
        }
    }
}

impl SpringOptions {
    /// Motion's `visualDuration` + `bounce` form.
    ///
    /// `visual_duration_s` is roughly how long the move *looks* like it takes,
    /// in seconds, ignoring the long tail of the settle. `bounce` runs 0 (no
    /// overshoot) to 1 (very bouncy).
    ///
    /// This is the closed form Motion uses when `visualDuration` is supplied, so
    /// it is exact rather than an approximation of `findSpring`.
    pub fn from_visual_duration(visual_duration_s: f64, bounce: f64) -> Self {
        let root = (2.0 * PI) / (visual_duration_s * 1.2);
        let stiffness = root * root;
        let damping = 2.0 * clamp(MIN_DAMPING, MAX_DAMPING, 1.0 - bounce) * stiffness.sqrt();
        Self {
            stiffness,
            damping,
            mass: DEFAULT_MASS,
            ..Default::default()
        }
    }
}

/// Which analytic branch of the damped harmonic oscillator applies, with its
/// per-spring coefficients precomputed.
#[derive(Clone, Copy, Debug)]
enum Solver {
    /// `damping_ratio < 1`
    Under {
        angular_freq: f64,
        a: f64,
        sin_coeff: f64,
        cos_coeff: f64,
    },
    /// `damping_ratio == 1`
    Critical { c: f64 },
    /// `damping_ratio > 1`
    ///
    /// Motion's intermediate `P` only feeds the two coefficients below, and its
    /// position formula uses the unfactored numerator, so `P` is not stored.
    /// Keeping Motion's exact expression order matters more than factoring it,
    /// because the parity test compares against Motion at 1e-9.
    Over {
        damped_angular_freq: f64,
        sinh_coeff: f64,
        cosh_coeff: f64,
    },
}

/// The value and settle state of a spring at some point in time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringState {
    /// Snapped exactly to the target once `done` is true, matching Motion.
    pub value: f64,
    pub done: bool,
}

/// A solved spring. Construction does the trigonometry once; sampling is cheap.
///
/// Sampling is by absolute time rather than by delta, so a backend that drops
/// frames still lands on the same curve as one that does not.
#[derive(Clone, Copy, Debug)]
pub struct Spring {
    target: f64,
    initial_delta: f64,
    /// Units per millisecond, sign-flipped. Motion stores velocity as
    /// `-velocity / 1000` because its solution is written as
    /// `target - envelope * (...)`.
    initial_velocity: f64,
    damping_ratio: f64,
    /// Radians per millisecond.
    undamped_angular_freq: f64,
    rest_speed: f64,
    rest_delta: f64,
    solver: Solver,
}

impl Spring {
    /// Solve a spring travelling from `from` to `to`.
    pub fn new(options: SpringOptions, from: f64, to: f64) -> Self {
        let SpringOptions {
            stiffness,
            damping,
            mass,
            velocity,
            rest_speed,
            rest_delta,
        } = options;

        let initial_velocity = -velocity / 1000.0;
        let damping_ratio = damping / (2.0 * (stiffness * mass).sqrt());
        let initial_delta = to - from;
        let undamped_angular_freq = (stiffness / mass).sqrt() / 1000.0;

        let is_granular = initial_delta.abs() < GRANULAR_SCALE;
        let rest_speed = rest_speed.filter(|v| *v != 0.0).unwrap_or(if is_granular {
            REST_SPEED_GRANULAR
        } else {
            REST_SPEED_DEFAULT
        });
        let rest_delta = rest_delta.filter(|v| *v != 0.0).unwrap_or(if is_granular {
            REST_DELTA_GRANULAR
        } else {
            REST_DELTA_DEFAULT
        });

        let solver = if damping_ratio < 1.0 {
            let angular_freq = undamped_angular_freq * (1.0 - damping_ratio * damping_ratio).sqrt();
            let a = (initial_velocity + damping_ratio * undamped_angular_freq * initial_delta)
                / angular_freq;
            Solver::Under {
                angular_freq,
                a,
                sin_coeff: damping_ratio * undamped_angular_freq * a + initial_delta * angular_freq,
                cos_coeff: damping_ratio * undamped_angular_freq * initial_delta - a * angular_freq,
            }
        } else if damping_ratio == 1.0 {
            Solver::Critical {
                c: initial_velocity + undamped_angular_freq * initial_delta,
            }
        } else {
            let damped_angular_freq =
                undamped_angular_freq * (damping_ratio * damping_ratio - 1.0).sqrt();
            let p = (initial_velocity + damping_ratio * undamped_angular_freq * initial_delta)
                / damped_angular_freq;
            Solver::Over {
                damped_angular_freq,
                sinh_coeff: damping_ratio * undamped_angular_freq * p
                    - initial_delta * damped_angular_freq,
                cosh_coeff: damping_ratio * undamped_angular_freq * initial_delta
                    - p * damped_angular_freq,
            }
        };

        Self {
            target: to,
            initial_delta,
            initial_velocity,
            damping_ratio,
            undamped_angular_freq,
            rest_speed,
            rest_delta,
            solver,
        }
    }

    /// Where the spring is at `t_ms`, unclamped. Use [`Spring::state_at`] for the
    /// value a backend should actually paint.
    pub fn value_at(&self, t_ms: f64) -> f64 {
        let envelope = (-self.damping_ratio * self.undamped_angular_freq * t_ms).exp();
        match self.solver {
            Solver::Under {
                angular_freq, a, ..
            } => {
                self.target
                    - envelope
                        * (a * (angular_freq * t_ms).sin()
                            + self.initial_delta * (angular_freq * t_ms).cos())
            }
            Solver::Critical { c } => self.target - envelope * (self.initial_delta + c * t_ms),
            Solver::Over {
                damped_angular_freq,
                ..
            } => {
                let freq_for_t = (damped_angular_freq * t_ms).min(OVERDAMPED_FREQ_CAP);
                self.target
                    - (envelope
                        * ((self.initial_velocity
                            + self.damping_ratio
                                * self.undamped_angular_freq
                                * self.initial_delta)
                            * freq_for_t.sinh()
                            + damped_angular_freq * self.initial_delta * freq_for_t.cosh()))
                        / damped_angular_freq
            }
        }
    }

    /// Velocity at `t_ms`, in units per second.
    pub fn velocity_at(&self, t_ms: f64) -> f64 {
        let envelope = (-self.damping_ratio * self.undamped_angular_freq * t_ms).exp();
        let per_ms = match self.solver {
            Solver::Under {
                angular_freq,
                sin_coeff,
                cos_coeff,
                ..
            } => {
                envelope
                    * (sin_coeff * (angular_freq * t_ms).sin()
                        + cos_coeff * (angular_freq * t_ms).cos())
            }
            Solver::Critical { c } => {
                envelope * (self.undamped_angular_freq * c * t_ms - self.initial_velocity)
            }
            Solver::Over {
                damped_angular_freq,
                sinh_coeff,
                cosh_coeff,
                ..
            } => {
                let freq_for_t = (damped_angular_freq * t_ms).min(OVERDAMPED_FREQ_CAP);
                envelope * (sinh_coeff * freq_for_t.sinh() + cosh_coeff * freq_for_t.cosh())
            }
        };
        per_ms * 1000.0
    }

    /// Value plus settle state at `t_ms`. Once settled the value snaps exactly to
    /// the target, so a backend never paints a window at 99.97% of its position
    /// forever.
    pub fn state_at(&self, t_ms: f64) -> SpringState {
        let current = self.value_at(t_ms);
        let done = self.velocity_at(t_ms).abs() <= self.rest_speed
            && (self.target - current).abs() <= self.rest_delta;
        SpringState {
            value: if done { self.target } else { current },
            done,
        }
    }

    /// Conservative estimate of when the spring settles, in milliseconds.
    ///
    /// Sampled rather than solved: the trig term makes the rest condition
    /// non-monotonic, so there is no clean closed form. Motion samples too. The
    /// result is rounded up to the next `step_ms`, and capped at `max_ms`.
    ///
    /// Backends use this to schedule how long to keep animating, so erring long
    /// is safe and erring short is not.
    pub fn settle_time_ms(&self, max_ms: f64, step_ms: f64) -> f64 {
        let mut t = 0.0;
        while t < max_ms {
            if self.state_at(t).done {
                return t;
            }
            t += step_ms;
        }
        max_ms
    }

    pub fn target(&self) -> f64 {
        self.target
    }

    pub fn damping_ratio(&self) -> f64 {
        self.damping_ratio
    }
}

#[cfg(test)]
// Exact float comparison is deliberate here. The snap-to-target behaviour in
// `state_at` is an exact-equality guarantee (a settled window must land on its
// target, not near it), and the damping-ratio branch boundary is chosen by an
// exact `== 1.0` to mirror Motion. Testing those with a tolerance would test
// something weaker than the code promises.
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) {
        let eps = 1e-9 * a.abs().max(b.abs()).max(1.0);
        assert!((a - b).abs() <= eps, "expected {a} ~= {b}");
    }

    #[test]
    fn starts_at_origin() {
        let s = Spring::new(SpringOptions::default(), 0.0, 100.0);
        close(s.value_at(0.0), 0.0);
    }

    #[test]
    fn supplied_velocity_is_the_initial_rate_of_change() {
        // Motion stores velocity negated and per-millisecond, so it is not
        // obvious that the public units/second value comes back out as the
        // actual initial slope. It does, and the strip layout depends on it.
        for velocity in [0.0, 500.0, -500.0, 2400.0] {
            let s = Spring::new(
                SpringOptions {
                    velocity,
                    ..Default::default()
                },
                0.0,
                100.0,
            );
            close(s.velocity_at(0.0), velocity);

            // Cross-check against a finite difference of the position curve,
            // so this tests the solution rather than restating the formula.
            let h = 1e-6;
            let slope_per_ms = (s.value_at(h) - s.value_at(0.0)) / h;
            let eps = 1e-3 * velocity.abs().max(1.0);
            assert!(
                (slope_per_ms * 1000.0 - velocity).abs() <= eps,
                "finite-difference slope {} should approximate {velocity}",
                slope_per_ms * 1000.0
            );
        }
    }

    #[test]
    fn interrupting_a_spring_preserves_position_and_velocity() {
        // This is the property the scrollable strip relies on: redirecting a
        // scroll mid-flight must stay C1 continuous, or the animation visibly
        // restarts. It is also how a released touch flick will hand its
        // momentum to the settle animation.
        let first = Spring::new(SpringOptions::default(), 0.0, 100.0);

        for t in [1.0, 50.0, 200.0, 400.0] {
            let position = first.value_at(t);
            let velocity = first.velocity_at(t);

            let second = Spring::new(
                SpringOptions {
                    velocity,
                    ..Default::default()
                },
                position,
                300.0,
            );

            close(second.value_at(0.0), position);
            close(second.velocity_at(0.0), velocity);
        }
    }

    #[test]
    fn converges_on_target() {
        for opts in [
            SpringOptions::default(),
            SpringOptions {
                damping: 20.0,
                ..Default::default()
            },
            SpringOptions {
                damping: 40.0,
                ..Default::default()
            },
        ] {
            let s = Spring::new(opts, 0.0, 100.0);
            close(s.value_at(60_000.0), 100.0);
        }
    }

    #[test]
    fn branches_are_selected_by_damping_ratio() {
        // stiffness 100, mass 1 => critical damping is 2*sqrt(100) = 20.
        let under = Spring::new(SpringOptions::default(), 0.0, 100.0);
        assert!(under.damping_ratio() < 1.0);

        let critical = Spring::new(
            SpringOptions {
                damping: 20.0,
                ..Default::default()
            },
            0.0,
            100.0,
        );
        assert_eq!(critical.damping_ratio(), 1.0);

        let over = Spring::new(
            SpringOptions {
                damping: 40.0,
                ..Default::default()
            },
            0.0,
            100.0,
        );
        assert!(over.damping_ratio() > 1.0);
    }

    #[test]
    fn underdamped_overshoots_and_critical_does_not() {
        let under = Spring::new(SpringOptions::default(), 0.0, 100.0);
        let overshot = (0..2000).any(|ms| under.value_at(ms as f64) > 100.0);
        assert!(overshot, "underdamped spring should overshoot its target");

        let critical = Spring::new(
            SpringOptions {
                damping: 20.0,
                ..Default::default()
            },
            0.0,
            100.0,
        );
        let overshot = (0..2000).any(|ms| critical.value_at(ms as f64) > 100.0 + 1e-9);
        assert!(!overshot, "critically damped spring should not overshoot");
    }

    #[test]
    fn settles_and_snaps_to_target() {
        let s = Spring::new(SpringOptions::default(), 0.0, 100.0);
        let t = s.settle_time_ms(20_000.0, 4.0);
        assert!(t < 20_000.0, "spring should settle within the cap");
        let state = s.state_at(t);
        assert!(state.done);
        assert_eq!(state.value, 100.0);
    }

    #[test]
    fn granular_moves_get_tighter_thresholds() {
        // A delta below GRANULAR_SCALE picks the tight thresholds, so an opacity
        // fade has to land within 0.005 rather than the 0.5 a pixel move gets.
        let opacity = Spring::new(SpringOptions::default(), 0.0, 1.0);
        let settled_at = opacity.settle_time_ms(20_000.0, 4.0);
        assert!((1.0 - opacity.value_at(settled_at)).abs() <= REST_DELTA_GRANULAR);
        assert!(opacity.velocity_at(settled_at).abs() <= REST_SPEED_GRANULAR);
    }

    #[test]
    fn rest_thresholds_are_absolute_not_relative() {
        // Same spring parameters, so the same decay rate. The 500px slide still
        // takes longer to settle than the 1px move, because the thresholds are
        // fixed magnitudes rather than fractions of the distance travelled.
        // Worth locking in: it means settle time depends on how far a window
        // moves, which is what the engine schedules animations against.
        let short = Spring::new(SpringOptions::default(), 0.0, 1.0);
        let long = Spring::new(SpringOptions::default(), 0.0, 500.0);
        assert!(
            long.settle_time_ms(20_000.0, 4.0) > short.settle_time_ms(20_000.0, 4.0),
            "a longer move should take longer to settle under absolute thresholds"
        );
    }

    #[test]
    fn overdamped_stays_finite_at_long_t() {
        // Without the sinh/cosh cap this overflows to NaN.
        let s = Spring::new(
            SpringOptions {
                damping: 80.0,
                ..Default::default()
            },
            0.0,
            100.0,
        );
        assert!(s.value_at(1_000_000.0).is_finite());
    }

    #[test]
    fn visual_duration_is_less_bouncy_as_bounce_drops() {
        let bouncy = Spring::new(SpringOptions::from_visual_duration(0.3, 0.6), 0.0, 100.0);
        let flat = Spring::new(SpringOptions::from_visual_duration(0.3, 0.0), 0.0, 100.0);
        assert!(bouncy.damping_ratio() < flat.damping_ratio());
    }
}
