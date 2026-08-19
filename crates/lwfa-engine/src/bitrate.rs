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
/// The ceiling is chosen for a LAN, where the link is worth tens of times
/// this and the budget is really bounded by what a browser can decode and a
/// tablet can spend. It is a *total* across windows, with the focused one
/// taking the larger share; see `allocate`. The floor is about where a
/// desktop at this size stops being readable. Below that the answer is a
/// smaller image, not fewer bits, which is a change this does not make.
pub const STEPS: [u32; 8] = [
    500_000,
    1_000_000,
    2_000_000,
    4_000_000,
    8_000_000,
    16_000_000,
    24_000_000,
    32_000_000,
];

/// Where a fresh connection starts.
///
/// Deliberately not the top. Starting high and being beaten down means the
/// first seconds of every session are the stuttering ones, and the first
/// seconds are when somebody decides whether this works.
const START: usize = 3;

/// How long the connection has to stay clear before trying more, once it has
/// ever pushed back.
///
/// Long enough that a quiet moment in a busy stream does not trigger a climb
/// that immediately has to be undone, since each attempt costs a keyframe.
/// Until the first drop the controller climbs much faster; see
/// [`Controller::climb_wait`].
const CLIMB_AFTER: Duration = Duration::from_secs(8);

/// The climb interval while the link has never pushed back.
///
/// A connection that has absorbed everything thrown at it so far deserves
/// optimism: this is TCP's slow start in spirit. On a clean LAN the budget
/// reaches the ceiling in under ten seconds instead of half a minute, which
/// is the difference between "the first minute looks bad" and nobody
/// noticing the ramp at all. The first genuine drop switches to the patient
/// schedule above.
const EAGER_CLIMB: Duration = Duration::from_secs(2);

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

/// How many of its own waits a link must stay quiet before the wait shrinks.
///
/// The backoff doubles per episode and, until this existed, only ever came
/// back through [`BACKOFF_RESET`]: five unbroken minutes with no congestion
/// at all. A link that hiccups every couple of minutes never gets five, so
/// the wait ratcheted to [`MAX_CLIMB_WAIT`] and stayed there for the session,
/// and a budget that had fallen to the floor took a quarter of an hour to
/// climb out. Observed doing exactly that: 24 Mbit/s down to 500 kbit/s in
/// two and a half minutes, then eleven minutes at or near the floor.
///
/// Three, not two, and measured against the wait itself rather than a fixed
/// period. Doubling fires on one episode; this needs three consecutive
/// climbs to have survived, so the two cannot cancel out and a link that
/// really does fail at a level still backs away from it.
const PATIENCE_DECAY: u32 = 3;

/// Probe delay above a connection's baseline that counts as congestion.
///
/// The probes ride the same stream as the frames, so this is time a byte
/// sent now would spend waiting behind ones already queued. 75ms is far
/// above jitter on any usable link and well below what a viewer feels as
/// lag; queueing that persists at this level only happens when the send
/// rate exceeds the path.
pub const QUEUE_DELAY_LIMIT: Duration = Duration::from_millis(75);

/// How long to wait after any change before considering another.
///
/// Both directions. A change costs a keyframe, and a keyframe is itself a
/// burst of traffic, so reacting to the congestion your own last change caused
/// is a feedback loop.
const SETTLE: Duration = Duration::from_secs(2);

/// How far to cut for a given amount of standing queue.
///
/// The rungs are a factor of two apart, so the number of them a queue justifies
/// is roughly how many times too fast we are, in doublings. A queue at the
/// limit is one rung; one eight times over is three.
///
/// Capped at three deliberately. This is a reaction to a measurement that is
/// noisy by nature, and the floor is only seven rungs below the ceiling: an
/// uncapped cut would land on the floor from a single bad sample, where the
/// ladder is meant to find the level the link can hold.
fn rungs_to_drop(queueing: Duration) -> usize {
    let limit = QUEUE_DELAY_LIMIT.as_micros().max(1);
    let over = queueing.as_micros() / limit;
    match over {
        0..=1 => 1,
        2..=3 => 2,
        _ => 3,
    }
}

/// How long a departed client's level is still worth resuming from.
///
/// Matched to the engine's own session grace (`state::SESSION_GRACE`, 45s) with
/// room to spare, because they answer the same question: within this long, a
/// connection arriving is the one that just left, coming back. Every reconnect
/// actually measured landed inside four seconds; the ones that took hours were
/// a different sitting entirely, and their link tells this one nothing.
const RESUME_WINDOW: Duration = Duration::from_secs(60);

/// The longest a single cut may wait for its own queue to drain.
///
/// Without a bound, a pathologically buffered path (a wifi access point with
/// seconds of queue, which is a real thing) would stall the controller
/// entirely.
const MAX_HOLD: Duration = Duration::from_secs(10);

/// What the connection looks like on one pass.
#[derive(Clone, Copy, Debug)]
pub struct Signal {
    /// Whether the link is behind, by either measure.
    pub congested: bool,
    /// How deep the queue is believed to be.
    ///
    /// Not used to decide anything, only to pace the deciding. A cut cannot
    /// show up in the measurement until the queue that already exists has
    /// drained, so a controller that cuts again before then is reacting to
    /// the same event twice. That is how a 5 Mbit/s link with three seconds
    /// of buffer in front of it walked the budget four steps past the level
    /// it should have stopped at.
    pub queueing: Duration,
}

impl Signal {
    /// A link with nothing wrong with it.
    pub fn clear() -> Self {
        Self { congested: false, queueing: Duration::ZERO }
    }

    /// A link that is behind, with no queue measurement to pace cuts by.
    pub fn congested() -> Self {
        Self { congested: true, queueing: Duration::ZERO }
    }

    /// The same, with the queue depth that was measured.
    pub fn with_queue(self, queueing: Duration) -> Self {
        Self { queueing, ..self }
    }
}

/// Tracks one connection's bitrate.
pub struct Controller {
    step: usize,
    /// The step the last client left behind, and when it left. See `attach`.
    departed: Option<(usize, Instant)>,
    changed_at: Instant,
    clear_since: Instant,
    /// How long to stay clear before climbing. Doubles once per episode of
    /// congestion.
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
    ///
    /// **Per episode, not per drop.** It used to double on every drop, which
    /// counted one event as many. Something else on the machine starting a
    /// download, Steam checking for updates, a backup, a game shader cache,
    /// congests the link for as long as it runs and walks the budget down
    /// several steps on the way. Doubling each time turned a ten-second
    /// download into a wait of two minutes per step, so recovering the seven
    /// steps it had just lost took a quarter of an hour on a link that was
    /// already fine. The stream stayed soft long after the cause had gone, and
    /// nothing in the logs said why.
    ///
    /// Halving it again on every climb was tried and is wrong: doubling on the
    /// way down and halving on the way up cancel out, and a link that fails
    /// repeatedly at the same level goes back to oscillating across it. Per
    /// episode is the whole fix. Confidence returns through `BACKOFF_RESET`,
    /// which is about the link being quiet rather than about the controller
    /// having got away with something.
    climb_wait: Duration,
    /// Whether the previous observation was congested, so the doubling above
    /// can fire on the edge rather than the whole episode.
    was_congested: bool,
    /// When congestion was last seen at all, as opposed to when the controller
    /// last acted. A climb resets `clear_since`, so that field can never
    /// measure a stretch longer than `climb_wait` and cannot answer "has this
    /// link been quiet for a long time".
    congested_at: Instant,
    /// How long to sit still after the last change.
    ///
    /// [`SETTLE`] plus however deep the queue was when the cut was made. See
    /// [`Signal::queueing`].
    hold: Duration,
}

impl Controller {
    pub fn new(now: Instant) -> Self {
        Self {
            step: START,
            departed: None,
            changed_at: now,
            clear_since: now,
            climb_wait: EAGER_CLIMB,
            was_congested: false,
            congested_at: now,
            hold: SETTLE,
        }
    }

    /// Bits per second to encode at.
    pub fn bitrate(&self) -> u32 {
        STEPS[self.step]
    }

    /// Somebody attached after a stretch with nobody connected.
    ///
    /// The controller otherwise has no idea a session ever ended, and two
    /// things go wrong because of it.
    ///
    /// The first is that an absence reads as good news. `clear_since` is only
    /// moved by congestion or by a climb, and neither happens while nothing is
    /// observed, so it ages for the whole disconnection and the first climb
    /// after a reconnect fires immediately on evidence nobody gathered. Seen
    /// in the journal: a session rejoined and stepped up 1.6 seconds later,
    /// against a `climb_wait` of sixteen.
    ///
    /// The second is that a budget beaten down by the link that *caused* the
    /// disconnection is inherited by the connection that replaces it. That
    /// used to cost sharpness alone; since the budget also paces capture it
    /// costs frame rate, and a session returning at the floor comes back at
    /// ten frames a second. So the step is floored back to where a brand new
    /// connection starts, on the grounds that a client nothing has measured is
    /// exactly as unknown as a first one and has earned neither more optimism
    /// nor less.
    ///
    /// A level the last client was holding is kept, but only while it is still
    /// evidence. It was gathered about a particular device on a particular
    /// link, and neither is known to be the one arriving now: a tablet coming
    /// straight back from a dropped socket is the same link measured seconds
    /// ago, where a phone opening the page the next morning shares nothing with
    /// it but a port number. So the level survives [`RESUME_WINDOW`] and not
    /// past it. See [`Controller::detach`].
    pub fn attach(&mut self, now: Instant) {
        self.step = match self.departed {
            // Exactly where it left, not raised to the start.
            //
            // Raising was wrong for the case that matters most: a device drops
            // *because* its link is struggling, and the link that beat the
            // budget down to 1 Mbit/s is the same one that comes back a second
            // later. Handing it four times the rate it had just failed to
            // sustain floods it again, and on a link that flaps the cycle
            // repeats for as long as the session lasts. It was measured doing
            // exactly that over a tethered mobile connection.
            Some((step, at)) if now.duration_since(at) <= RESUME_WINDOW => step,
            _ => START,
        };
        self.departed = None;
        self.clear_since = now;
        self.changed_at = now;
        self.hold = SETTLE;
        self.was_congested = false;
    }

    /// Everybody left.
    ///
    /// Records where the budget had got to, so a client that comes straight
    /// back does not have to rediscover a link it was using moments ago. See
    /// [`Controller::attach`].
    pub fn detach(&mut self, now: Instant) {
        self.departed = Some((self.step, now));
    }

    /// Report how the connection is doing, and get the new bitrate if it moved.
    ///
    /// `congested` means the engine had a frame ready and nowhere to put it.
    /// Returns `Some` only on a change, so the caller can rebuild the encoder
    /// exactly when it has to.
    pub fn observe(&mut self, signal: Signal, now: Instant) -> Option<u32> {
        let congested = signal.congested;
        // The start of an episode, not every observation inside one. See
        // `climb_wait`.
        let episode_started = congested && !self.was_congested;
        self.was_congested = congested;
        if congested {
            self.clear_since = now;
            self.congested_at = now;
        }

        if episode_started {
            // Wait longer before trying that level again, and never less than
            // the patient schedule: the first congestion is also what ends the
            // eager climb of a fresh connection.
            self.climb_wait = (self.climb_wait * 2).clamp(CLIMB_AFTER, MAX_CLIMB_WAIT);
        }

        // Nothing changes during the settling period, in either direction.
        if now.duration_since(self.changed_at) < self.hold {
            return None;
        }

        if congested && self.step > 0 {
            // Cut by as many rungs as the measurement justifies, not always by
            // one.
            //
            // Each cut rebuilds every encoder, because neither H.264 nor HEVC
            // can change bitrate mid-stream through this binding, and a
            // rebuild means a keyframe: the largest frame there is, sent onto
            // a link that is already drowning. Walking down one rung at a time
            // therefore answers congestion by adding data, once per rung.
            //
            // Measured on a tethered mobile connection: 32 Mbit/s to the floor
            // took eight cuts and ninety seconds, and paid a keyframe for each
            // one while the queue stood at seconds. Sizing the cut to the
            // queue makes that one cut, one keyframe, and arrives at a
            // survivable rate while the session is still worth using.
            self.step = self.step.saturating_sub(rungs_to_drop(signal.queueing));
            self.changed_at = now;
            // Wait out the queue that already exists before judging the cut,
            // or the same backlog is counted once per settling period and the
            // budget falls far past where it should have stopped.
            self.hold = SETTLE + signal.queueing.min(MAX_HOLD);
            return Some(self.bitrate());
        }

        // A long stretch with no trouble at all means the link is not the one
        // that was struggling earlier, so start being optimistic again.
        //
        // Measured from the last congestion rather than from the last climb.
        // Against `clear_since` this could never fire: a climb resets it, and
        // the wait between climbs is capped below this threshold, so the
        // condition was unreachable in exactly the situation it was written
        // for.
        if now.duration_since(self.congested_at) >= BACKOFF_RESET {
            self.climb_wait = EAGER_CLIMB;
        }

        let clear_for = now.duration_since(self.clear_since);
        if !congested && self.step + 1 < STEPS.len() && clear_for >= self.climb_wait {
            // Confidence has to return as well as leave. Checked here, at the
            // moment of a climb, so it can fire at most once per climb rather
            // than sixty times a second while the condition holds.
            //
            // Only ever shortens a wait that congestion lengthened. The floor
            // here is `CLIMB_AFTER`, which is *longer* than the eager schedule
            // a fresh link starts on, so without this guard the first climb of
            // every clean session promoted 2s to 8s and the ramp to the
            // ceiling took half a minute instead of eight seconds.
            if self.climb_wait > CLIMB_AFTER
                && now.duration_since(self.congested_at) >= self.climb_wait * PATIENCE_DECAY
            {
                self.climb_wait = (self.climb_wait / 2).max(CLIMB_AFTER);
            }
            self.step += 1;
            self.changed_at = now;
            // A climb adds no backlog, so it only owes the plain settle.
            self.hold = SETTLE;
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
        let after = controller.observe(Signal::congested(), at(base, 3)).expect("should have dropped");
        assert!(after < before, "{after} is not below {before}");
    }

    #[test]
    fn keeps_dropping_while_it_stays_congested() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let first = controller.observe(Signal::congested(), at(base, 3)).unwrap();
        let second = controller.observe(Signal::congested(), at(base, 6)).unwrap();
        assert!(second < first);
    }

    #[test]
    fn will_not_drop_below_the_floor() {
        // Below this the answer is a smaller image, not fewer bits.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..20 {
            controller.observe(Signal::congested(), at(base, i * 3));
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
        assert!(controller.observe(Signal::congested(), at(base, 3)).is_some());
        assert!(controller.observe(Signal::congested(), at(base, 4)).is_none());
    }

    #[test]
    fn climbs_back_when_the_connection_stays_clear() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let dropped = controller.observe(Signal::congested(), at(base, 3)).unwrap();
        // Clear from here on.
        let mut recovered = None;
        for i in 4..30 {
            if let Some(rate) = controller.observe(Signal::clear(), at(base, i)) {
                recovered = Some(rate);
                break;
            }
        }
        assert!(recovered.is_some_and(|rate| rate > dropped));
    }

    #[test]
    fn climbs_slower_than_it_drops_once_the_link_has_pushed_back() {
        // The standard asymmetry, but it begins at the first failure. A fresh
        // connection climbs eagerly, because a link that has absorbed
        // everything so far has earned optimism; one that has already pushed
        // back has not. Overshooting down costs a little sharpness;
        // overshooting up costs a stalled picture.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        controller.observe(Signal::congested(), at(base, 3)).expect("drops");

        // A second drop needs one settling period.
        let mut fell_again = None;
        for i in 4..40 {
            let mut probe = Controller::new(base);
            probe.observe(Signal::congested(), at(base, 3)).expect("drops");
            if probe.observe(Signal::congested(), at(base, i)).is_some() {
                fell_again = Some(i - 3);
                break;
            }
        }
        // A climb after that drop waits much longer than a settle.
        let mut rose = None;
        for i in 4..40 {
            if controller.observe(Signal::clear(), at(base, i)).is_some() {
                rose = Some(i - 3);
                break;
            }
        }
        assert!(
            fell_again.unwrap() < rose.unwrap(),
            "dropped again after {fell_again:?}s but climbed after {rose:?}s"
        );
    }

    #[test]
    fn a_fresh_connection_reaches_the_ceiling_quickly() {
        // The eager phase. On a clean link the whole ramp takes seconds, not
        // half a minute: the first minute is when somebody decides whether
        // this works at all.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..=30 {
            controller.observe(Signal::clear(), at(base, i));
        }
        assert_eq!(controller.bitrate(), STEPS[STEPS.len() - 1]);
    }

    #[test]
    fn one_bad_moment_restarts_the_climb() {
        // Otherwise a connection that hiccups every few seconds still ratchets
        // upwards, which is exactly the connection that cannot afford it.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        controller.observe(Signal::congested(), at(base, 3)).unwrap();

        for i in 4..10 {
            controller.observe(Signal::clear(), at(base, i));
        }
        // A single congested tick just before the climb would have happened.
        controller.observe(Signal::congested(), at(base, 10));
        // And now clear again, but the timer restarted, so nothing yet.
        assert!(controller.observe(Signal::clear(), at(base, 13)).is_none());
    }

    /// The oscillation seen in a real log: 8 to 16 Mbit/s, congested, back to
    /// 8, and returning to 16 nine seconds later, with every session rebuilt
    /// and a keyframe paid on each pass.
    #[test]
    fn does_not_climb_straight_back_into_the_level_that_just_failed() {
        let base = Instant::now();
        let mut controller = Controller::new(base);
        controller.observe(Signal::congested(), at(base, 3)).expect("drops");

        // Clear from here. The first climb must wait the full patient period
        // rather than the eager one a fresh connection gets.
        let mut climbed = None;
        for i in 4..20 {
            if controller.observe(Signal::clear(), at(base, i)).is_some() {
                climbed = Some(i);
                break;
            }
        }
        assert!(
            climbed.is_none_or(|secs| secs >= 3 + 8),
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
                if controller.observe(Signal::congested(), at(base, clock)).is_some() {
                    break;
                }
            }
            let dropped_at = clock;
            // Then stay clear until it climbs.
            loop {
                clock += 2;
                if controller.observe(Signal::clear(), at(base, clock)).is_some() {
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
    fn one_download_is_one_episode_not_seven() {
        // The case that prompted this: Steam checks for an update mid-session,
        // the link is busy for a few seconds, and the budget walks down several
        // steps on the way. Counting each step as its own failure made the
        // recovery take a quarter of an hour on a link that was already fine.
        let base = Instant::now();
        let mut controller = Controller::new(base);

        // Up to the ceiling on a clean link first.
        let mut clock = 0u64;
        while controller.bitrate() < STEPS[STEPS.len() - 1] {
            clock += 3;
            controller.observe(Signal::clear(), at(base, clock));
            assert!(clock < 200, "never reached the ceiling");
        }

        // Something else on the machine takes the link for twenty seconds.
        let download_start = clock;
        while clock < download_start + 20 {
            clock += 1;
            controller.observe(Signal::congested(), at(base, clock));
        }
        assert!(
            controller.bitrate() < STEPS[STEPS.len() - 1],
            "should have backed off during the download"
        );

        // It finishes. Time to climb all the way back.
        let recovery_start = clock;
        while controller.bitrate() < STEPS[STEPS.len() - 1] {
            clock += 1;
            controller.observe(Signal::clear(), at(base, clock));
            assert!(clock - recovery_start < 3600, "never recovered");
        }
        let recovery = clock - recovery_start;

        assert!(
            recovery < 180,
            "took {recovery}s to recover from one download; before the \
             per-episode fix this was about 840s"
        );
    }

    #[test]
    fn a_quiet_link_becomes_optimistic_even_while_climbing() {
        // `BACKOFF_RESET` used to be measured from the last climb, and a climb
        // resets that clock, so on a link that was climbing it could never be
        // reached: the wait between climbs is capped below the threshold.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;

        // Give it a bad enough time to reach the patient schedule.
        for _ in 0..4 {
            for _ in 0..8 {
                clock += 3;
                controller.observe(Signal::congested(), at(base, clock));
            }
            for _ in 0..40 {
                clock += 3;
                controller.observe(Signal::clear(), at(base, clock));
            }
        }

        // Then a long quiet stretch, with climbs happening throughout.
        let quiet_start = clock;
        while clock - quiet_start < BACKOFF_RESET.as_secs() + 60 {
            clock += 3;
            controller.observe(Signal::clear(), at(base, clock));
        }

        // Optimism restored means the next climb comes quickly rather than
        // after two minutes.
        let before = controller.bitrate();
        if before < STEPS[STEPS.len() - 1] {
            let waiting_from = clock;
            while controller.observe(Signal::clear(), at(base, clock)).is_none() {
                clock += 1;
                assert!(clock - waiting_from < 60, "still on the patient schedule");
            }
        }
    }

    #[test]
    fn a_gap_with_nobody_connected_does_not_throttle_the_session() {
        // A disconnect removes the client slot immediately while the session is
        // held for 45 seconds, so for that whole window there is nothing to
        // send to. Counting that as congestion drove the budget to the floor
        // and handed the returning client a session throttled by its own
        // absence. The engine now does not observe at all while nobody is
        // connected; this pins the consequence.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;

        while controller.bitrate() < STEPS[STEPS.len() - 1] {
            clock += 3;
            controller.observe(Signal::clear(), at(base, clock));
            assert!(clock < 200, "never reached the ceiling");
        }
        let before = controller.bitrate();

        // 45 seconds of grace with no client. The engine skips observing, so
        // the controller simply does not hear from anyone.
        clock += 45;

        // The client comes back and the link is fine.
        controller.observe(Signal::clear(), at(base, clock));
        assert_eq!(
            controller.bitrate(),
            before,
            "an absence should not have cost the session its budget"
        );
    }

    #[test]
    fn patience_comes_back_on_a_link_that_keeps_working() {
        // The eleven-minute recovery this was written for. The backoff used to
        // return only through BACKOFF_RESET's five unbroken clear minutes,
        // which a link that hiccups every couple of minutes never gets, so it
        // ratcheted to the ceiling and stayed there for the session.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;

        // Three separate episodes, because the doubling is per episode: one
        // long congested spell counts once, by design.
        for _ in 0..3 {
            clock += 3;
            controller.observe(Signal::congested(), at(base, clock));
            clock += 3;
            controller.observe(Signal::clear(), at(base, clock));
        }
        let patient = controller.climb_wait;
        assert!(patient > CLIMB_AFTER, "the bad spell should have cost patience");

        // Then a link that simply works, but never for the five unbroken
        // minutes BACKOFF_RESET wants.
        let start = clock;
        while controller.climb_wait >= patient {
            clock += 1;
            controller.observe(Signal::clear(), at(base, clock));
            assert!(
                clock - start < BACKOFF_RESET.as_secs(),
                "still fully patient after {}s, so only BACKOFF_RESET can save it",
                clock - start,
            );
        }
    }

    #[test]
    fn a_small_queue_costs_one_rung() {
        // The ordinary case, and the one the ladder was built for: back off a
        // little, measure again.
        assert_eq!(rungs_to_drop(QUEUE_DELAY_LIMIT), 1);
        assert_eq!(rungs_to_drop(Duration::from_millis(0)), 1);
    }

    #[test]
    fn a_queue_of_seconds_costs_three() {
        // Measured on a tethered mobile link: queueing of 723ms, 2827ms and
        // 2423ms while the budget walked down one rung at a time, paying a
        // keyframe per rung onto a link that was already drowning. One cut of
        // three answers that with one keyframe.
        assert_eq!(rungs_to_drop(Duration::from_millis(2906)), 3);
        assert_eq!(rungs_to_drop(Duration::from_millis(723)), 3);
    }

    #[test]
    fn a_single_bad_sample_cannot_reach_the_floor() {
        // The cut is a reaction to a noisy measurement, so it is capped. From
        // the ceiling, even an absurd reading lands mid-ladder, where the next
        // measurement can still say "too far" or "not far enough".
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..40 {
            controller.observe(Signal::clear(), at(base, i));
        }
        assert_eq!(controller.bitrate(), STEPS[STEPS.len() - 1]);

        let absurd = Signal::congested().with_queue(Duration::from_secs(30));
        controller.observe(absurd, at(base, 60));
        assert!(
            controller.bitrate() > STEPS[0],
            "one reading took it all the way to the floor",
        );
    }

    #[test]
    fn a_flapping_link_is_not_handed_back_more_than_it_could_hold() {
        // Measured: a tethered session was beaten to 1 Mbit/s, dropped,
        // reconnected two seconds later, and was handed 4 Mbit/s because the
        // start of the ladder was treated as a floor. The link that had just
        // failed to sustain 1 was then asked for 4, and the cycle repeated for
        // as long as the session lasted.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..30 {
            controller.observe(Signal::congested(), at(base, i * 3));
        }
        let beaten = controller.bitrate();
        assert!(beaten < STEPS[START], "{beaten} should be below the start");

        controller.detach(at(base, 100));
        controller.attach(at(base, 102));
        assert_eq!(
            controller.bitrate(),
            beaten,
            "a link that just proved what it can carry should be taken at its word",
        );
    }

    #[test]
    fn a_returning_client_does_not_inherit_the_floor() {
        // The link that beat the budget down is the one that dropped the
        // connection. Handing its verdict to whatever attaches next means the
        // new client starts at the floor, which since the budget also paces
        // capture is ten frames a second.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..20 {
            controller.observe(Signal::congested(), at(base, i * 3));
        }
        assert_eq!(controller.bitrate(), STEPS[0], "should be on the floor");

        controller.attach(at(base, 100));
        assert_eq!(
            controller.bitrate(),
            STEPS[START],
            "a client nothing has measured should start where a first one does",
        );
    }

    #[test]
    fn a_client_straight_back_does_not_cost_a_healthy_session_its_ceiling() {
        // The floor is a floor, not a reset. A session sitting at the top has
        // genuinely earned it, and knocking it back down on every reconnect
        // would make a flapping link permanently worse than a dead one. Every
        // reconnect actually measured came back within four seconds.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..40 {
            controller.observe(Signal::clear(), at(base, i));
        }
        let earned = controller.bitrate();
        assert!(earned > STEPS[START], "{earned} should be above the start");

        controller.detach(at(base, 40));
        controller.attach(at(base, 44));
        assert_eq!(controller.bitrate(), earned);
    }

    #[test]
    fn but_a_level_measured_an_hour_ago_is_not_measurement_of_this_link() {
        // The other half of the same rule. A level is evidence about the
        // device and link that produced it. Kept indefinitely, a tablet that
        // spent last night at the ceiling would hand that ceiling to a phone
        // on mobile data opening the page the next morning, and the first
        // thing that phone would experience is the engine discovering it.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..40 {
            controller.observe(Signal::clear(), at(base, i));
        }
        assert!(controller.bitrate() > STEPS[START]);

        controller.detach(at(base, 40));
        controller.attach(at(base, 40 + RESUME_WINDOW.as_secs() + 1));
        assert_eq!(
            controller.bitrate(),
            STEPS[START],
            "a link nothing recent has measured starts where a first one does",
        );
    }

    #[test]
    fn leaving_twice_does_not_resurrect_the_first_level() {
        // `attach` clears what it consumed, so a second attach with no
        // departure in between cannot reach back past it.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        for i in 1..40 {
            controller.observe(Signal::clear(), at(base, i));
        }
        controller.detach(at(base, 40));
        controller.attach(at(base, 41));
        let resumed = controller.bitrate();
        assert!(resumed > STEPS[START]);

        controller.attach(at(base, 42));
        assert_eq!(
            controller.bitrate(),
            STEPS[START],
            "the second attach had no departure of its own to resume from",
        );
    }

    #[test]
    fn time_with_nobody_connected_is_not_evidence_the_link_was_clear() {
        // `clear_since` only moves on congestion or on a climb, so an absence
        // ages it exactly like a good connection would. Observed: a session
        // rejoined and climbed 1.6 seconds later against a sixteen second
        // wait, on a link the engine had not measured once.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        // One episode, so the patient schedule is in force.
        controller.observe(Signal::congested(), at(base, 3));
        controller.observe(Signal::clear(), at(base, 4));

        // Nobody connected for a long while, then somebody arrives.
        controller.attach(at(base, 300));

        // The very next pass must not be enough to climb.
        assert!(
            controller.observe(Signal::clear(), at(base, 302)).is_none(),
            "climbed on a link it has watched for two seconds",
        );
    }

    #[test]
    fn a_returning_client_still_settles_before_anything_moves() {
        // Attaching is a change like any other: the opening burst of keyframes
        // is not evidence about the link, and reacting to it is the feedback
        // loop `SETTLE` exists to break.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        controller.attach(at(base, 10));
        assert!(
            controller.observe(Signal::congested(), at(base, 11)).is_none(),
            "cut inside the settling period",
        );
    }

    #[test]
    fn a_clean_link_keeps_its_eager_climb() {
        // The decay must never lengthen a wait. Its floor is CLIMB_AFTER,
        // which is longer than the eager schedule a fresh link starts on, so
        // an unguarded decay quadrupled the ramp on every clean session.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;
        let mut climbs = 0;
        while clock < 20 {
            clock += 1;
            if controller.observe(Signal::clear(), at(base, clock)).is_some() {
                climbs += 1;
            }
        }
        assert_eq!(
            controller.bitrate(),
            STEPS[STEPS.len() - 1],
            "a clean link should be at the ceiling within twenty seconds \
             ({climbs} climbs so far)",
        );
    }

    #[test]
    fn patience_still_grows_faster_than_it_decays() {
        // The decay must not cancel the doubling, or a link that fails
        // repeatedly at one level goes back to oscillating across it.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let mut clock = 0u64;
        let mut waits = Vec::new();

        for _ in 0..3 {
            loop {
                clock += 3;
                if controller.observe(Signal::congested(), at(base, clock)).is_some() {
                    break;
                }
            }
            let dropped_at = clock;
            loop {
                clock += 2;
                if controller.observe(Signal::clear(), at(base, clock)).is_some() {
                    break;
                }
                assert!(clock < 4000, "never climbed back");
            }
            waits.push(clock - dropped_at);
        }
        assert!(
            waits[1] > waits[0] && waits[2] > waits[1],
            "repeated failure should still cost patience: {waits:?}",
        );
    }

    #[test]
    fn one_backlog_is_cut_for_once_not_once_per_settle() {
        // A 5 Mbit/s path with three seconds of buffer in front of it. The
        // cut cannot show up in the measurement until that backlog drains, so
        // a controller on a fixed settle counts the same event again and
        // again and lands four steps below where it should have stopped.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let deep = Signal::congested().with_queue(Duration::from_secs(3));

        let mut cuts = 0;
        for secs in 1..=6 {
            if controller.observe(deep, at(base, secs)).is_some() {
                cuts += 1;
            }
        }
        assert_eq!(cuts, 1, "one backlog should cost one step, not {cuts}");
    }

    #[test]
    fn a_shallow_queue_is_still_cut_for_promptly() {
        // The hold must scale with the backlog, not replace the settle: a
        // link that is behind with nothing buffered still needs a quick
        // answer.
        let base = Instant::now();
        let mut controller = Controller::new(base);
        let shallow = Signal::congested().with_queue(Duration::from_millis(80));

        assert!(controller.observe(shallow, at(base, 3)).is_some());
        assert!(
            controller.observe(shallow, at(base, 6)).is_some(),
            "a shallow queue should not buy three seconds of grace",
        );
    }

    #[test]
    fn a_stale_window_is_not_judged_on_one_pass() {
        // The window open when a client connects started whenever the last one
        // left, so its first pass is already "a window old". Judging it means
        // judging the link on the single pass that lands in the opening burst
        // of keyframes.
        let base = Instant::now();
        let mut pressure = Pressure::new(base);
        assert!(
            !pressure.observe(true, at(base, 60)),
            "one full pass after a long gap is not congestion",
        );
    }

    #[test]
    fn a_busy_socket_is_not_a_congested_one() {
        // A socket carrying video is full a lot of the time by design. Only a
        // path refusing half of what the engine offers is evidence the budget
        // is too high.
        let base = Instant::now();
        let mut pressure = Pressure::new(base);
        let mut clock = 0u64;
        // Three passes in ten find the queue full, over several windows.
        for i in 0..600u64 {
            clock += 16;
            pressure.observe(i % 10 < 3, base + Duration::from_millis(clock));
        }
        assert!(
            !pressure.observe(false, base + Duration::from_millis(clock)),
            "a third full should not read as congestion",
        );
    }

    #[test]
    fn a_path_refusing_most_frames_is() {
        let base = Instant::now();
        let mut pressure = Pressure::new(base);
        let mut clock = 0u64;
        let mut verdict = false;
        for _ in 0..200u64 {
            clock += 16;
            verdict = pressure.observe(true, base + Duration::from_millis(clock));
        }
        assert!(verdict, "a path that is always full is congestion");
    }

    #[test]
    fn the_verdict_holds_steady_inside_a_window() {
        // Otherwise it flickers pass to pass and the budget follows it.
        let base = Instant::now();
        let mut pressure = Pressure::new(base);
        let mut clock = 0u64;
        for _ in 0..200u64 {
            clock += 16;
            pressure.observe(true, base + Duration::from_millis(clock));
        }
        // One clear pass must not undo a full window's worth of evidence.
        clock += 16;
        assert!(pressure.observe(false, base + Duration::from_millis(clock)));
    }

    #[test]
    fn the_queue_is_the_same_span_of_time_at_every_budget() {
        // The whole point: four frames meant 66ms at the ceiling and almost
        // nothing at the floor, so the delay the probe measured grew with the
        // bitrate and every climb refuted itself.
        for budget in STEPS {
            let drain = Duration::from_secs_f64(
                queue_bytes(budget) as f64 * 8.0 / f64::from(budget),
            );
            let off_by = drain.abs_diff(QUEUE_TARGET);
            assert!(
                off_by <= Duration::from_millis(1),
                "{budget} queues {drain:?} of video, not {QUEUE_TARGET:?}",
            );
        }
    }

    #[test]
    fn the_queue_stays_well_inside_the_delay_threshold() {
        // Otherwise the engine's own buffer eats the budget the threshold was
        // meant to give the network.
        assert!(
            QUEUE_TARGET * 2 < QUEUE_DELAY_LIMIT,
            "a full queue would read as congestion on its own",
        );
    }

    /// The compositor's tick, from `[render] tick_ms`. The pacing is polled on
    /// it, so it is the unit these thresholds are really measured in.
    const TICK: Duration = Duration::from_millis(16);

    #[test]
    fn a_small_budget_buys_fewer_frames_rather_than_worse_ones() {
        // 500 kbit/s over sixty frames is a kilobyte each, which is not a
        // desktop. Over ten frames it is six kilobytes each, which is.
        assert!(
            capture_interval(STEPS[0]) > TICK * 2,
            "the floor should be paced well below the tick rate",
        );
        assert!(capture_interval(500_000) > capture_interval(4_000_000));
    }

    #[test]
    fn a_healthy_budget_is_not_throttled_at_all() {
        // Where a normal session lives. The threshold has to fall *inside* one
        // tick, or the poll skips every other one and 60 fps becomes 30.
        for rate in [8_000_000, 16_000_000, 24_000_000, 32_000_000] {
            assert!(
                capture_interval(rate) < TICK,
                "{rate} would lose every other tick",
            );
        }
    }

    #[test]
    fn every_rate_lands_on_the_tick_it_should() {
        // The quantisation this is really about: with a 16ms poll, a threshold
        // must sit just under the tick that is meant to carry the frame, not
        // just over it.
        for rate in STEPS {
            let interval = capture_interval(rate);
            let fps = (rate / BITS_PER_FRAME).clamp(MIN_FPS, MAX_FPS);
            let ticks = (interval.as_micros() / TICK.as_micros()) + 1;
            let actual = 1_000_000.0 / (ticks as f64 * TICK.as_micros() as f64);
            assert!(
                actual >= f64::from(fps) * 0.9,
                "{rate} wanted {fps} fps but the tick grid gives {actual:.1}",
            );
        }
    }

    #[test]
    fn the_frame_rate_never_leaves_its_bounds() {
        let slowest = Duration::from_micros(1_000_000 * 3 / (4 * u64::from(MIN_FPS)));
        let fastest = Duration::from_micros(1_000_000 * 3 / (4 * u64::from(MAX_FPS)));
        for rate in [0, 1, 1_000, STEPS[0], u32::MAX] {
            let interval = capture_interval(rate);
            assert!(interval <= slowest, "{rate} paced slower than {MIN_FPS} fps");
            assert!(interval >= fastest, "{rate} paced faster than {MAX_FPS} fps");
        }
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
            controller.observe(Signal::congested(), at(base, clock));
        }
        // Now clear. It must come back within the ceiling, not exponentially
        // beyond it.
        let start = clock;
        let mut climbed = None;
        while clock < start + 400 {
            clock += 5;
            if controller.observe(Signal::clear(), at(base, clock)).is_some() {
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
            controller.observe(Signal::congested(), at(base, clock));
        }
        // A long clear stretch at the bottom, where no climb is pending yet.
        clock += 400;
        controller.observe(Signal::clear(), at(base, clock));

        // From here a climb should come at the base interval again.
        let start = clock;
        let mut climbed = None;
        while clock < start + 100 {
            clock += 2;
            if controller.observe(Signal::clear(), at(base, clock)).is_some() {
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
            controller.observe(Signal::clear(), last);
        }
        assert_eq!(controller.bitrate(), STEPS[STEPS.len() - 1]);
        assert!(controller.observe(Signal::clear(), last + Duration::from_secs(60)).is_none());
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

/// How long the send path is watched before judging how full it has been.
const PRESSURE_WINDOW: Duration = Duration::from_secs(1);

/// What share of that window must be full to count as congestion.
///
/// Three quarters. Half was tried and is too eager: a socket carrying video
/// is busy much of the time by design, and the burst of keyframes every
/// session opens with filled it for long enough to count as an episode of
/// congestion. That cost nothing visible but it quadrupled the ramp, because
/// one episode ends the eager climb, and the budget then took half a minute
/// to reach the ceiling instead of eight seconds. At three quarters the
/// engine really is being refused most of what it offers.
const PRESSURE_NUM: u32 = 3;
const PRESSURE_DEN: u32 = 4;

/// Passes a window needs before its verdict means anything.
///
/// A third of a second at the compositor's tick rate.
const MIN_PASSES: u32 = 20;

/// How often the send path has been full lately.
///
/// # Why a rate and not the flag itself
///
/// `can_accept_frame` is a snapshot taken sixty times a second, and at any
/// instant it is close to a coin toss: the queue fills and drains constantly
/// by design. Feeding the raw flag to the controller meant the budget moved on
/// whichever way the coin happened to land when the pass ran.
///
/// What matters is the *share* of passes that found nowhere to put a frame,
/// because that is the share of frames the link refused. When it is high, the
/// budget is above what the path can carry, and the fix is to encode smaller
/// frames rather than to send fewer of them. Without this the engine sat on a
/// 5 Mbit/s link with a 32 Mbit/s budget, filling the link exactly but at
/// sixteen frames a second, when the same bytes at a truthful budget buy
/// fifty.
pub struct Pressure {
    passes: u32,
    full: u32,
    since: Instant,
    verdict: bool,
}

impl Pressure {
    pub fn new(now: Instant) -> Self {
        Self {
            passes: 0,
            full: 0,
            since: now,
            verdict: false,
        }
    }

    /// Start a fresh window for a newly attached client.
    ///
    /// `MIN_PASSES` already stops the stale window a disconnection leaves open
    /// from being judged, so this changes no verdict. It exists so the first
    /// real window of a session is a whole window wide rather than whatever
    /// was left of the last one, which is the difference between the first
    /// judgement arriving after a second and after a few milliseconds.
    pub fn attach(&mut self, now: Instant) {
        self.passes = 0;
        self.full = 0;
        self.since = now;
        self.verdict = false;
    }

    /// Record one pass, and say whether the path has been full often enough.
    ///
    /// The verdict holds between windows rather than being recomputed per
    /// pass, so it cannot flicker within one.
    pub fn observe(&mut self, full: bool, now: Instant) -> bool {
        self.passes += 1;
        if full {
            self.full += 1;
        }
        if now.duration_since(self.since) >= PRESSURE_WINDOW {
            // A window holding almost no passes is a gap rather than evidence.
            // This only runs while somebody is connected, so the window open
            // when a client arrives began whenever the last one left, and
            // judging it would mean judging the link on a single pass: the
            // one during the burst of keyframes every session opens with.
            // That counted as an episode of congestion, which ends the eager
            // climb, so every session took half a minute to reach the ceiling
            // instead of eight seconds.
            self.verdict = self.passes >= MIN_PASSES
                && self.full * PRESSURE_DEN >= self.passes * PRESSURE_NUM;
            self.passes = 0;
            self.full = 0;
            self.since = now;
        }
        self.verdict
    }
}

/// How much video may sit in one client's queue, as a span of time.
///
/// The queue exists to keep the socket busy across a slow encode, so it needs
/// to be about a couple of frames. It must also stay well under
/// [`QUEUE_DELAY_LIMIT`], because the delay probe is queued behind exactly
/// this and its wait is what the budget reacts to. Thirty against seventy-five
/// leaves the threshold measuring the *network's* queue rather than the
/// engine's own.
const QUEUE_TARGET: Duration = Duration::from_millis(30);

/// How many bytes of video a client may have queued at this budget.
///
/// The old bound was a frame count, which meant a completely different span
/// of time at either end of the range: four frames is a few kilobytes at the
/// floor and a quarter of a megabyte at the ceiling. Since the delay probe
/// waits behind the queue, that made the measured delay grow with the
/// bitrate, so every climb manufactured the congestion that undid it.
pub fn queue_bytes(budget: u32) -> usize {
    let per_second = budget as u64 / 8;
    (per_second * QUEUE_TARGET.as_millis() as u64 / 1000) as usize
}

/// The most frames a second any window is captured at.
///
/// The compositor's own tick, so this is a statement about the ceiling rather
/// than a throttle.
pub const MAX_FPS: u32 = 60;

/// The fewest.
///
/// Below this the picture stops reading as motion and starts reading as a
/// series of stills, which is worse than a soft one.
pub const MIN_FPS: u32 = 10;

/// Bits a frame needs before it is a picture rather than a smear.
///
/// Roughly eight kilobytes, measured against the window sizes this actually
/// runs at (about 1200x900). It is a rule of thumb, not a law; the point is
/// only that there is *some* point below which more frames stop being the
/// right way to spend the budget.
const BITS_PER_FRAME: u32 = 65_536;

/// How often to capture a window allocated `rate` bits per second.
///
/// # Why the frame rate moves at all
///
/// Encoding at a fixed 60 fps means the bits per frame fall with the budget,
/// and quality falls with them. At the floor that produced a 1200x900 window
/// encoded at 500 kbit/s across sixty frames a second: about a kilobyte each,
/// which is not a readable desktop by any measure. The same 500 kbit/s across
/// ten frames is six kilobytes each, which is soft but legible, and legible
/// beats smooth when only one of them is available.
///
/// So the budget buys frames until a frame is worth having, and buys quality
/// after that. Above about 4 Mbit/s per window this comes out below the
/// compositor's tick and nothing changes at all, which is where a normal
/// session lives.
///
/// # Why it is short of the nominal interval
///
/// The caller polls this on the compositor's own ~16ms tick, so the value has
/// to be a threshold rather than a period. An exact 16.67ms for 60 fps would
/// be just *above* the tick, so every other tick would fail the test and the
/// frame rate would halve to 30. Three quarters of the period puts the
/// threshold safely inside the tick that ought to carry the frame, at every
/// rate rather than only at the top.
pub fn capture_interval(rate: u32) -> Duration {
    let fps = (rate / BITS_PER_FRAME).clamp(MIN_FPS, MAX_FPS);
    Duration::from_micros(1_000_000 * 3 / (4 * u64::from(fps)))
}

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
