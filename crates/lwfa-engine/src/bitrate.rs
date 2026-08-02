//! Choosing how many bits to spend, from how the connection is coping.
//!
//! # Why not the usual answer
//!
//! Real-time video normally adapts with something like WebRTC's congestion
//! control, which watches packet loss and the delay between arrivals. Neither
//! is available here: lwfa streams over a WebSocket, so TCP has already hidden
//! the loss by retransmitting, and the arrival times a receiver sees are TCP's
//! rather than the network's.
//!
//! What TCP does give, and gives clearly, is backpressure. When the far end
//! cannot keep up the send buffer fills, and the engine already notices because
//! it refuses to encode a frame it has nowhere to put. That refusal was being
//! used as an on/off switch: stop capturing until it clears. It is a much
//! better signal than that. A connection that keeps filling is telling you the
//! bitrate is too high, and one that never fills is telling you there is room.
//!
//! # The shape of the controller
//!
//! Down fast, up slowly, which is the standard asymmetry for anything sharing a
//! link. Overshooting downwards costs a little sharpness for a second;
//! overshooting upwards costs a stalled picture, which is far more noticeable.
//!
//! Steps rather than a continuous value, because changing the bitrate means
//! rebuilding the encoder session, and that costs a keyframe. Continuous
//! control would rebuild constantly and spend more on keyframes than it saved.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use lwfa_proto::WindowId;

/// The rungs, in bits per second.
///
/// Spaced by roughly a half rather than evenly: perceived quality tracks the
/// logarithm of the bitrate, so even steps would be imperceptible at the top
/// and brutal at the bottom.
///
/// The ceiling is what the encoder used to be fixed at, and the floor is about
/// where a desktop at this size stops being readable. Below that the answer is
/// a smaller image, not fewer bits, which is a change this does not make.
pub const STEPS: [u32; 6] = [
    500_000,
    1_000_000,
    2_000_000,
    4_000_000,
    8_000_000,
    16_000_000,
];

/// Where a fresh connection starts.
///
/// Deliberately not the top. Starting high and being beaten down means the
/// first seconds of every session are the stuttering ones, and the first
/// seconds are when somebody decides whether this works.
const START: usize = 3;

/// How long the connection has to stay clear before trying more, at first.
///
/// Long enough that a quiet moment in a busy stream does not trigger a climb
/// that immediately has to be undone, since each attempt costs a keyframe.
const CLIMB_AFTER: Duration = Duration::from_secs(8);

/// The longest it will ever wait before trying again.
///
/// There has to be a ceiling, or a connection that was bad for a while would
/// stay throttled for the rest of the session after it recovered.
const MAX_CLIMB_WAIT: Duration = Duration::from_secs(120);

/// A clear stretch this long means the connection genuinely changed.
///
/// Resets the backoff, so an afternoon of congestion does not leave the
/// evening cautious.
const BACKOFF_RESET: Duration = Duration::from_secs(300);

/// How long to wait after any change before considering another.
///
/// Both directions. A change costs a keyframe, and a keyframe is itself a
/// burst of traffic, so reacting to the congestion your own last change caused
/// is a feedback loop.
const SETTLE: Duration = Duration::from_secs(2);

/// Tracks one connection's bitrate.
pub struct Controller {
    step: usize,
    changed_at: Instant,
    clear_since: Instant,
    /// How long to stay clear before climbing. Doubles on every drop.
    ///
    /// Without this the controller oscillates. It climbs a step, the extra
    /// bits congest the link, it drops back, waits the fixed period, and climbs
    /// into exactly the level that just failed. Observed doing precisely that:
    /// 8 to 16 Mbit/s, congested, back to 8, and returning to 16 nine seconds
    /// later, over and over, with every session rebuilt and a keyframe paid on
    /// each pass.
    ///
    /// Backing off is what TCP does after a loss for the same reason. A level
    /// that has just failed is evidence about the link, and trying it again
    /// immediately throws that evidence away.
    climb_wait: Duration,
}

impl Controller {
    pub fn new(now: Instant) -> Self {
        Self {
            step: START,
            changed_at: now,
            clear_since: now,
            climb_wait: CLIMB_AFTER,
        }
    }

    /// Bits per second to encode at.
    pub fn bitrate(&self) -> u32 {
        STEPS[self.step]
    }

    /// Report how the connection is doing, and get the new bitrate if it moved.
    ///
    /// `congested` means the engine had a frame ready and nowhere to put it.
    /// Returns `Some` only on a change, so the caller can rebuild the encoder
    /// exactly when it has to.
    pub fn observe(&mut self, congested: bool, now: Instant) -> Option<u32> {
        if congested {
            self.clear_since = now;
        }

        // Nothing changes during the settling period, in either direction.
        if now.duration_since(self.changed_at) < SETTLE {
            return None;
        }

        if congested && self.step > 0 {
            self.step -= 1;
            self.changed_at = now;
            // Wait longer before trying that level again. See `climb_wait`.
            self.climb_wait = (self.climb_wait * 2).min(MAX_CLIMB_WAIT);
            return Some(self.bitrate());
        }

        let clear_for = now.duration_since(self.clear_since);

        // A long stretch with no trouble at all means the link is not the one
        // that was struggling earlier, so start being optimistic again.
        if clear_for >= BACKOFF_RESET {
            self.climb_wait = CLIMB_AFTER;
        }

        if !congested && self.step + 1 < STEPS.len() && clear_for >= self.climb_wait {
            self.step += 1;
            self.changed_at = now;
            // Reset, so the next climb waits the full period again rather than
            // stepping up every tick once the timer has expired once.
            self.clear_since = now;
            return Some(self.bitrate());
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    #[test]
    fn starts_below_the_ceiling() {
        // Starting at the top means the first seconds of every session are the
        // stuttering ones, and those are the seconds people judge it by.
        let now = Instant::now();
        let controller = Controller::new(now);
        assert!(controller.bitrate() < STEPS[STEPS.len() - 1]);
        assert!(controller.bitrate() > STEPS[0]);
    }

    #[test]
    fn drops_when_the_connection_backs_up() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let before = controller.bitrate();
        let after = controller.observe(true, at(base, 3)).expect("should have dropped");
        assert!(after < before, "{after} is not below {before}");
    }

    #[test]
    fn keeps_dropping_while_it_stays_congested() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let first = controller.observe(true, at(base, 3)).unwrap();
        let second = controller.observe(true, at(base, 6)).unwrap();
        assert!(second < first);
    }

    #[test]
    fn will_not_drop_below_the_floor() {
        // Below this the answer is a smaller image, not fewer bits.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..20 {
            controller.observe(true, at(base, i * 3));
        }
        assert_eq!(controller.bitrate(), STEPS[0]);
    }

    #[test]
    fn does_not_react_twice_to_one_problem() {
        // A change costs a keyframe, which is itself a burst of traffic.
        // Reacting to the congestion caused by your own last change is a
        // feedback loop.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        assert!(controller.observe(true, at(base, 3)).is_some());
        assert!(controller.observe(true, at(base, 4)).is_none());
    }

    #[test]
    fn climbs_back_when_the_connection_stays_clear() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let dropped = controller.observe(true, at(base, 3)).unwrap();
        // Clear from here on.
        let mut recovered = None;
        for i in 4..30 {
            if let Some(rate) = controller.observe(false, at(base, i)) {
                recovered = Some(rate);
                break;
            }
        }
        assert!(recovered.is_some_and(|rate| rate > dropped));
    }

    #[test]
    fn climbs_slower_than_it_drops() {
        // The standard asymmetry. Overshooting down costs a little sharpness;
        // overshooting up costs a stalled picture.
        let base = Instant::now();
        let mut dropper = Controller::new(base);
        let mut climber = Controller::new(base);

        // One congested observation is enough to drop.
        let mut fell_at = None;
        for i in 1..40 {
            if dropper.observe(true, at(base, i)).is_some() {
                fell_at = Some(i);
                break;
            }
        }
        let mut rose_at = None;
        for i in 1..40 {
            if climber.observe(false, at(base, i)).is_some() {
                rose_at = Some(i);
                break;
            }
        }
        assert!(fell_at.unwrap() < rose_at.unwrap());
    }

    #[test]
    fn one_bad_moment_restarts_the_climb() {
        // Otherwise a connection that hiccups every few seconds still ratchets
        // upwards, which is exactly the connection that cannot afford it.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        controller.observe(true, at(base, 3)).unwrap();

        for i in 4..10 {
            controller.observe(false, at(base, i));
        }
        // A single congested tick just before the climb would have happened.
        controller.observe(true, at(base, 10));
        // And now clear again, but the timer restarted, so nothing yet.
        assert!(controller.observe(false, at(base, 13)).is_none());
    }

    /// The oscillation seen in a real log: 8 to 16 Mbit/s, congested, back to
    /// 8, and returning to 16 nine seconds later, with every session rebuilt
    /// and a keyframe paid on each pass.
    #[test]
    fn does_not_climb_straight_back_into_the_level_that_just_failed() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        controller.observe(true, at(base, 3)).expect("drops");

        // Clear from here. The first climb must not come as quickly as it
        // would have without a failure behind it.
        let mut climbed = None;
        for i in 4..20 {
            if controller.observe(false, at(base, i)).is_some() {
                climbed = Some(i);
                break;
            }
        }
        assert!(
            climbed.is_none_or(|secs| secs >= 3 + 16),
            "climbed back after only {climbed:?}s"
        );
    }

    #[test]
    fn waits_longer_after_each_failure() {
        let base = Instant::now();
        let mut controller = Controller::new(base);

        let mut waits = Vec::new();
        let mut clock = 0u64;
        for _ in 0..3 {
            // Congest until it drops.
            loop {
                clock += 3;
                if controller.observe(true, at(base, clock)).is_some() {
                    break;
                }
            }
            let dropped_at = clock;
            // Then stay clear until it climbs.
            loop {
                clock += 2;
                if controller.observe(false, at(base, clock)).is_some() {
                    break;
                }
                assert!(clock < 4000, "never climbed back");
            }
            waits.push(clock - dropped_at);
        }
        assert!(
            waits[1] > waits[0] && waits[2] > waits[1],
            "waits did not grow: {waits:?}"
        );
    }

    #[test]
    fn the_wait_has_a_ceiling() {
        // Otherwise a connection that was bad for a while stays throttled for
        // the rest of the session after it recovers.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;
        for _ in 0..12 {
            clock += 3;
            controller.observe(true, at(base, clock));
        }
        // Now clear. It must come back within the ceiling, not exponentially
        // beyond it.
        let start = clock;
        let mut climbed = None;
        while clock < start + 400 {
            clock += 5;
            if controller.observe(false, at(base, clock)).is_some() {
                climbed = Some(clock - start);
                break;
            }
        }
        assert!(climbed.is_some_and(|secs| secs <= 130), "took {climbed:?}s");
    }

    #[test]
    fn a_long_calm_stretch_makes_it_optimistic_again() {
        // An afternoon of congestion should not leave the evening cautious.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;
        for _ in 0..4 {
            clock += 3;
            controller.observe(true, at(base, clock));
        }
        // A long clear stretch at the bottom, where no climb is pending yet.
        clock += 400;
        controller.observe(false, at(base, clock));

        // From here a climb should come at the base interval again.
        let start = clock;
        let mut climbed = None;
        while clock < start + 100 {
            clock += 2;
            if controller.observe(false, at(base, clock)).is_some() {
                climbed = Some(clock - start);
                break;
            }
        }
        assert!(climbed.is_some_and(|secs| secs <= 20), "took {climbed:?}s");
    }

    #[test]
    fn stays_put_when_nothing_is_wrong_and_it_is_already_at_the_top() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut last = base;
        for i in 1..200 {
            last = at(base, i * 2);
            controller.observe(false, last);
        }
        assert_eq!(controller.bitrate(), STEPS[STEPS.len() - 1]);
        assert!(controller.observe(false, last + Duration::from_secs(60)).is_none());
    }
}

/* ------------------------------------------------------------- allocation -- */

/// The share of the budget the focused window gets, when there is more than one.
///
/// Modest on purpose. The temptation is something like 90/10, and it is wrong
/// twice over: a background window at a tenth of the budget is unreadable
/// enough to be worth nothing at all, and every focus change would then be a
/// large reshuffle, which costs a keyframe per window that moves. 55/45 keeps
/// the thing you are reading clearly better without making the rest useless.
const FOCUS_SHARE: f64 = 0.55;

/// Never starve a window below this.
///
/// A window at a few tens of kilobits is not a cheap window, it is a smear that
/// still costs bandwidth. With enough windows this floor can push the total
/// over budget, which is the right way round: exceeding it slightly beats
/// sending several streams nobody can read.
const FLOOR: u32 = 250_000;

/// How long focus has to hold before the budget follows it.
///
/// Changing a window's share rebuilds its encoder session, and a rebuild is a
/// keyframe. Clicking through four windows would otherwise be eight keyframes
/// in a second, all at the moment somebody is interacting, which is worse than
/// the problem this solves.
const FOCUS_SETTLE: Duration = Duration::from_millis(1500);

/// How much a window's share must move before its session is rebuilt.
///
/// Without a deadband, a window opening or closing changes every other window's
/// share by a few percent and rebuilds all of them for no visible gain.
pub const DEADBAND: f64 = 0.25;

/// Divide a total budget between the windows being streamed.
///
/// # Why a budget at all
///
/// Each window is encoded by its own NVENC session, and the rate given to a
/// session is that session's ceiling. Handing every one of them the same number
/// therefore multiplies it by however many windows are on screen: "4 Mbit/s"
/// with four visible columns is sixteen. The connection experiences the sum, so
/// the sum is what has to be controlled.
///
/// # Why unevenly
///
/// You are reading one of them. Under a constrained budget, spending equally
/// means making the window you are looking at worse in order to keep one you
/// are not looking at sharp. The saving is real only when a background window
/// is genuinely busy, which is the video-playing-in-the-next-column case, and
/// that is exactly when it matters most.
pub fn allocate(budget: u32, windows: &[WindowId], focused: Option<WindowId>) -> HashMap<WindowId, u32> {
    let mut out = HashMap::new();
    if windows.is_empty() {
        return out;
    }
    if windows.len() == 1 {
        out.insert(windows[0], budget.max(FLOOR));
        return out;
    }

    let focused = focused.filter(|id| windows.contains(id));
    let Some(focused) = focused else {
        // Nothing focused here, so nothing to prefer. An even split is the
        // honest answer rather than picking a window arbitrarily.
        let each = (budget / windows.len() as u32).max(FLOOR);
        for id in windows {
            out.insert(*id, each);
        }
        return out;
    };

    let front = ((budget as f64) * FOCUS_SHARE) as u32;
    let others = windows.len() as u32 - 1;
    let each = (budget.saturating_sub(front) / others.max(1)).max(FLOOR);

    for id in windows {
        out.insert(*id, if *id == focused { front.max(FLOOR) } else { each });
    }
    out
}

/// Holds focus still for a moment before the budget follows it.
///
/// See `FOCUS_SETTLE`. Kept separate from [`Controller`] because they answer
/// different questions: that one decides how much there is to spend, this one
/// decides who to spend it on.
pub struct Attention {
    settled: Option<WindowId>,
    pending: Option<WindowId>,
    since: Instant,
}

impl Attention {
    pub fn new(now: Instant) -> Self {
        Self { settled: None, pending: None, since: now }
    }

    /// Report where focus is now, and get where the budget should think it is.
    pub fn observe(&mut self, focused: Option<WindowId>, now: Instant) -> Option<WindowId> {
        if focused != self.pending {
            self.pending = focused;
            self.since = now;
        }
        if self.pending != self.settled && now.duration_since(self.since) >= FOCUS_SETTLE {
            self.settled = self.pending;
        }
        self.settled
    }
}

#[cfg(test)]
mod allocation_tests {
    use super::*;

    const A: WindowId = WindowId(1);
    const B: WindowId = WindowId(2);
    const C: WindowId = WindowId(3);

    #[test]
    fn one_window_gets_everything() {
        let out = allocate(4_000_000, &[A], Some(A));
        assert_eq!(out[&A], 4_000_000);
    }

    #[test]
    fn the_total_is_the_budget_not_the_per_window_rate() {
        // The bug this exists to fix: every session used to be handed the full
        // rate, so the connection saw it multiplied by the window count.
        let out = allocate(4_000_000, &[A, B, C], Some(A));
        let total: u32 = out.values().sum();
        assert!(total <= 4_000_000, "allocated {total} of a 4000000 budget");
    }

    #[test]
    fn the_focused_window_gets_the_larger_share() {
        let out = allocate(4_000_000, &[A, B], Some(A));
        assert!(out[&A] > out[&B], "{} is not above {}", out[&A], out[&B]);
    }

    #[test]
    fn the_others_are_still_worth_having() {
        // A background window at a tenth of the budget is a smear that still
        // costs bandwidth, which is the worst of both.
        let out = allocate(4_000_000, &[A, B], Some(A));
        assert!(out[&B] * 3 > out[&A], "background starved: {} vs {}", out[&B], out[&A]);
    }

    #[test]
    fn an_even_split_when_nothing_is_focused() {
        let out = allocate(3_000_000, &[A, B, C], None);
        assert_eq!(out[&A], out[&B]);
        assert_eq!(out[&B], out[&C]);
    }

    #[test]
    fn focus_on_a_window_that_is_not_streaming_is_ignored() {
        // The focused window can be scrolled off the viewport, in which case it
        // has no session and no share.
        let out = allocate(3_000_000, &[A, B], Some(C));
        assert_eq!(out[&A], out[&B]);
        assert!(!out.contains_key(&C));
    }

    #[test]
    fn nothing_falls_below_the_floor() {
        let many: Vec<WindowId> = (1..=8).map(WindowId).collect();
        let out = allocate(500_000, &many, Some(WindowId(1)));
        for (id, rate) in &out {
            assert!(*rate >= FLOOR, "window {id:?} got {rate}");
        }
    }

    #[test]
    fn every_streamed_window_is_given_something() {
        let out = allocate(4_000_000, &[A, B, C], Some(B));
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn no_windows_allocates_nothing() {
        assert!(allocate(4_000_000, &[], None).is_empty());
    }
}

#[cfg(test)]
mod attention_tests {
    use super::*;

    const A: WindowId = WindowId(1);
    const B: WindowId = WindowId(2);

    #[test]
    fn does_not_follow_focus_immediately() {
        // Every change rebuilds two sessions, and a rebuild is a keyframe.
        // Clicking through windows must not be a burst of them.
        let base = Instant::now();
        let mut attention = Attention::new(base);
        assert_eq!(attention.observe(Some(A), base), None);
        assert_eq!(attention.observe(Some(A), base + Duration::from_millis(500)), None);
    }

    #[test]
    fn follows_once_focus_has_held() {
        let base = Instant::now();
        let mut attention = Attention::new(base);
        attention.observe(Some(A), base);
        assert_eq!(attention.observe(Some(A), base + Duration::from_secs(2)), Some(A));
    }

    #[test]
    fn a_window_clicked_through_never_takes_the_budget() {
        // Four windows in a second: none of them should ever settle.
        let base = Instant::now();
        let mut attention = Attention::new(base);
        for (i, id) in [A, B, A, B].into_iter().enumerate() {
            let now = base + Duration::from_millis(200 * i as u64);
            assert_eq!(attention.observe(Some(id), now), None);
        }
    }

    #[test]
    fn keeps_the_last_settled_answer_while_a_new_one_is_pending() {
        // Otherwise the budget goes evenly split for a second and a half on
        // every focus change, which is a reshuffle of its own.
        let base = Instant::now();
        let mut attention = Attention::new(base);
        attention.observe(Some(A), base);
        attention.observe(Some(A), base + Duration::from_secs(2));
        assert_eq!(attention.observe(Some(B), base + Duration::from_secs(2)), Some(A));
    }
}
