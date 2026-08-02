/**
 * Window motion: the spring the shell animates with.
 *
 * The parameters live in `configs/defaults.toml` and are generated into the
 * bundle, so they are editable without touching code, which also means they can
 * be edited into something nobody wanted. These pin the one property that was
 * asked for explicitly: windows slide, they do not bounce.
 */

import { describe, expect, it } from "vitest"
import { Spring } from "@lwfa/spring"
import { WINDOW_SPRING } from "../src/generated/config"

/** ζ = c / (2 √(k m)). Below 1 the spring overshoots and springs back. */
function dampingRatio(spec: { stiffness: number; damping: number; mass: number }): number {
  return spec.damping / (2 * Math.sqrt(spec.stiffness * spec.mass))
}

/** Sample a move at 120Hz until it settles, or give up. */
function trace(spec: typeof WINDOW_SPRING, from: number, to: number, velocity = 0): number[] {
  const spring = new Spring({ ...spec, velocity }, from, to)
  const out: number[] = []
  for (let t = 0; t <= 4000; t += 1000 / 120) {
    const { value, done } = spring.stateAt(t)
    out.push(value)
    if (done) break
  }
  return out
}

describe("the window spring", () => {
  it("is at or above critical damping, so a window never bounces", () => {
    expect(dampingRatio(WINDOW_SPRING)).toBeGreaterThanOrEqual(1)
  })

  it("never passes its target on the way there", () => {
    // The property the ratio is a proxy for, checked directly against the same
    // integrator the browser runs.
    const samples = trace(WINDOW_SPRING, 0, 1000)
    expect(samples.length).toBeGreaterThan(10)
    for (const value of samples) {
      expect(value).toBeLessThanOrEqual(1000 + 1e-6)
    }
    expect(samples.at(-1)).toBeCloseTo(1000, 6)
  })

  it("does not bounce when redirected mid-flight either", () => {
    // Redirecting carries the in-flight velocity into the new spring, which is
    // what keeps a change of mind smooth. It is also the one way an exactly
    // critically damped spring can still overshoot, which is why the configured
    // damping sits above critical rather than on it.
    const first = new Spring({ ...WINDOW_SPRING }, 0, 1000)
    const midway = 120 // ms in
    const carried = first.velocityAt(midway)
    expect(carried).toBeGreaterThan(0) // still moving, or this proves nothing

    for (const value of trace(WINDOW_SPRING, first.valueAt(midway), 1400, carried)) {
      expect(value).toBeLessThanOrEqual(1400 + 1e-6)
    }
  })

  it("settles quickly enough to feel like a response", () => {
    // A heavily overdamped spring has no bounce and also no life: it creeps.
    // Half a second from a full-viewport move is the budget.
    const samples = trace(WINDOW_SPRING, 0, 1000)
    const ms = (samples.length - 1) * (1000 / 120)
    expect(ms).toBeLessThan(500)
  })
})
