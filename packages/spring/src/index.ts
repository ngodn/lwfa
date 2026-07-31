/**
 * Spring integrator for lwfa.
 *
 * The TypeScript half of a cross-language parity contract. `crates/lwfa-spring`
 * is the other half, and `test/parity.test.ts` checks that the two agree, and
 * that both agree with upstream `motion-dom`.
 *
 * Read the header of `crates/lwfa-spring/src/lib.rs` for why this exists in two
 * languages. Short version: the engine integrates springs natively for the
 * local GPU path, the browser integrates them for the remote path, and the same
 * window animation has to look the same on both.
 *
 * Ported from `motion-dom` 12.43.0,
 * `dist/es/animation/generators/spring.mjs`.
 *
 * Time is in **milliseconds**. Public velocities are in **units per second**.
 * Both match Motion.
 *
 * Kept structurally parallel to the Rust file on purpose. When you change one,
 * change the other, and the parity test will tell you if you forgot.
 */

/** Motion's `springDefaults`. */
const DEFAULT_STIFFNESS = 100
const DEFAULT_DAMPING = 10
const DEFAULT_MASS = 1
const DEFAULT_VELOCITY = 0

const REST_SPEED_GRANULAR = 0.01
const REST_SPEED_DEFAULT = 2
const REST_DELTA_GRANULAR = 0.005
const REST_DELTA_DEFAULT = 0.5

const MIN_DAMPING = 0.05
const MAX_DAMPING = 1

/**
 * Motion caps `sinh`/`cosh` arguments here so overdamped springs cannot
 * overflow to Infinity at large `t`.
 */
const OVERDAMPED_FREQ_CAP = 300

/**
 * A displacement smaller than this counts as "granular" (opacity, scale) and
 * gets tighter rest thresholds than a pixel-scale move.
 */
const GRANULAR_SCALE = 5

const clamp = (min: number, max: number, v: number): number =>
  Math.min(Math.max(v, min), max)

export interface SpringOptions {
  stiffness?: number
  damping?: number
  mass?: number
  /** Initial velocity, in units per second. */
  velocity?: number
  /** Overrides Motion's scale-dependent default when set to a non-zero value. */
  restSpeed?: number
  /** Overrides Motion's scale-dependent default when set to a non-zero value. */
  restDelta?: number
}

export interface SpringState {
  /** Snapped exactly to the target once `done` is true, matching Motion. */
  value: number
  done: boolean
}

/**
 * Motion's `visualDuration` + `bounce` form.
 *
 * `visualDurationS` is roughly how long the move *looks* like it takes, in
 * seconds, ignoring the long tail of the settle. `bounce` runs 0 (no overshoot)
 * to 1 (very bouncy).
 *
 * This is the closed form Motion uses when `visualDuration` is supplied, so it
 * is exact rather than an approximation of `findSpring`.
 */
export function fromVisualDuration(
  visualDurationS: number,
  bounce = 0.3,
): SpringOptions {
  const root = (2 * Math.PI) / (visualDurationS * 1.2)
  const stiffness = root * root
  const damping = 2 * clamp(MIN_DAMPING, MAX_DAMPING, 1 - bounce) * Math.sqrt(stiffness)
  return { stiffness, damping, mass: DEFAULT_MASS }
}

type Solver =
  | {
      kind: "under"
      angularFreq: number
      a: number
      sinCoeff: number
      cosCoeff: number
    }
  | { kind: "critical"; c: number }
  | {
      kind: "over"
      dampedAngularFreq: number
      sinhCoeff: number
      coshCoeff: number
    }

/**
 * A solved spring. Construction does the trigonometry once; sampling is cheap.
 *
 * Sampling is by absolute time rather than by delta, so a backend that drops
 * frames still lands on the same curve as one that does not.
 */
export class Spring {
  readonly target: number
  readonly dampingRatio: number

  readonly #initialDelta: number
  /**
   * Units per millisecond, sign-flipped. Motion stores velocity as
   * `-velocity / 1000` because its solution is written as
   * `target - envelope * (...)`.
   */
  readonly #initialVelocity: number
  /** Radians per millisecond. */
  readonly #undampedAngularFreq: number
  readonly #restSpeed: number
  readonly #restDelta: number
  readonly #solver: Solver

  constructor(options: SpringOptions, from: number, to: number) {
    const stiffness = options.stiffness ?? DEFAULT_STIFFNESS
    const damping = options.damping ?? DEFAULT_DAMPING
    const mass = options.mass ?? DEFAULT_MASS
    const velocity = options.velocity ?? DEFAULT_VELOCITY

    const initialVelocity = -velocity / 1000
    const dampingRatio = damping / (2 * Math.sqrt(stiffness * mass))
    const initialDelta = to - from
    const undampedAngularFreq = Math.sqrt(stiffness / mass) / 1000

    // Motion uses `restSpeed || (restSpeed = default)`, so an explicit 0 falls
    // back to the default too. Mirrored here rather than "fixed", because the
    // Rust side mirrors it as well and parity beats tidiness.
    const isGranular = Math.abs(initialDelta) < GRANULAR_SCALE
    const restSpeed =
      options.restSpeed || (isGranular ? REST_SPEED_GRANULAR : REST_SPEED_DEFAULT)
    const restDelta =
      options.restDelta || (isGranular ? REST_DELTA_GRANULAR : REST_DELTA_DEFAULT)

    let solver: Solver
    if (dampingRatio < 1) {
      const angularFreq =
        undampedAngularFreq * Math.sqrt(1 - dampingRatio * dampingRatio)
      const a =
        (initialVelocity + dampingRatio * undampedAngularFreq * initialDelta) /
        angularFreq
      solver = {
        kind: "under",
        angularFreq,
        a,
        sinCoeff: dampingRatio * undampedAngularFreq * a + initialDelta * angularFreq,
        cosCoeff: dampingRatio * undampedAngularFreq * initialDelta - a * angularFreq,
      }
    } else if (dampingRatio === 1) {
      solver = {
        kind: "critical",
        c: initialVelocity + undampedAngularFreq * initialDelta,
      }
    } else {
      const dampedAngularFreq =
        undampedAngularFreq * Math.sqrt(dampingRatio * dampingRatio - 1)
      const p =
        (initialVelocity + dampingRatio * undampedAngularFreq * initialDelta) /
        dampedAngularFreq
      solver = {
        kind: "over",
        dampedAngularFreq,
        sinhCoeff:
          dampingRatio * undampedAngularFreq * p - initialDelta * dampedAngularFreq,
        coshCoeff:
          dampingRatio * undampedAngularFreq * initialDelta - p * dampedAngularFreq,
      }
    }

    this.target = to
    this.dampingRatio = dampingRatio
    this.#initialDelta = initialDelta
    this.#initialVelocity = initialVelocity
    this.#undampedAngularFreq = undampedAngularFreq
    this.#restSpeed = restSpeed
    this.#restDelta = restDelta
    this.#solver = solver
  }

  /**
   * Where the spring is at `tMs`, unclamped. Use {@link Spring.stateAt} for the
   * value a backend should actually paint.
   */
  valueAt(tMs: number): number {
    const s = this.#solver
    const envelope = Math.exp(-this.dampingRatio * this.#undampedAngularFreq * tMs)

    switch (s.kind) {
      case "under":
        return (
          this.target -
          envelope *
            (s.a * Math.sin(s.angularFreq * tMs) +
              this.#initialDelta * Math.cos(s.angularFreq * tMs))
        )
      case "critical":
        return this.target - envelope * (this.#initialDelta + s.c * tMs)
      case "over": {
        const freqForT = Math.min(s.dampedAngularFreq * tMs, OVERDAMPED_FREQ_CAP)
        return (
          this.target -
          (envelope *
            ((this.#initialVelocity +
              this.dampingRatio * this.#undampedAngularFreq * this.#initialDelta) *
              Math.sinh(freqForT) +
              s.dampedAngularFreq * this.#initialDelta * Math.cosh(freqForT))) /
            s.dampedAngularFreq
        )
      }
    }
  }

  /** Velocity at `tMs`, in units per second. */
  velocityAt(tMs: number): number {
    const s = this.#solver
    const envelope = Math.exp(-this.dampingRatio * this.#undampedAngularFreq * tMs)

    let perMs: number
    switch (s.kind) {
      case "under":
        perMs =
          envelope *
          (s.sinCoeff * Math.sin(s.angularFreq * tMs) +
            s.cosCoeff * Math.cos(s.angularFreq * tMs))
        break
      case "critical":
        perMs =
          envelope *
          (this.#undampedAngularFreq * s.c * tMs - this.#initialVelocity)
        break
      case "over": {
        const freqForT = Math.min(s.dampedAngularFreq * tMs, OVERDAMPED_FREQ_CAP)
        perMs =
          envelope *
          (s.sinhCoeff * Math.sinh(freqForT) + s.coshCoeff * Math.cosh(freqForT))
        break
      }
    }
    return perMs * 1000
  }

  /**
   * Value plus settle state at `tMs`. Once settled the value snaps exactly to
   * the target, so a backend never paints a window at 99.97% of its position
   * forever.
   */
  stateAt(tMs: number): SpringState {
    const current = this.valueAt(tMs)
    const done =
      Math.abs(this.velocityAt(tMs)) <= this.#restSpeed &&
      Math.abs(this.target - current) <= this.#restDelta
    return { value: done ? this.target : current, done }
  }

  /**
   * Conservative estimate of when the spring settles, in milliseconds.
   *
   * Sampled rather than solved: the trig term makes the rest condition
   * non-monotonic, so there is no clean closed form. Motion samples too. The
   * result is rounded up to the next `stepMs`, and capped at `maxMs`.
   *
   * Backends use this to schedule how long to keep animating, so erring long is
   * safe and erring short is not.
   */
  settleTimeMs(maxMs = 30_000, stepMs = 4): number {
    let t = 0
    while (t < maxMs) {
      if (this.stateAt(t).done) return t
      t += stepMs
    }
    return maxMs
  }
}
