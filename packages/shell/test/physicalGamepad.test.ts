/**
 * Turning a physical controller's changes into wire messages.
 *
 * The engine and protocol already carry `gamepadButton`/`gamepadAxis` and bind
 * a virtual pad on demand, so reading a real controller is just diffing frames
 * of the Gamepad API into those messages. This pins that diff: only what moved,
 * triggers on both a button and an axis, a deadzone on the sticks, and nothing
 * at all from a controller sitting still.
 */

import { describe, expect, it } from "vitest"
import { IDLE, diffGamepad, pollStep, snapshotOf, type PadSnapshot } from "../src/gamepad/physical"

/** Build a snapshot: `buttons` sets specific indices, the rest released. */
function snap(
  buttons: { i: number; pressed?: boolean; value?: number }[] = [],
  axes: number[] = [0, 0, 0, 0],
  length = 17,
): PadSnapshot {
  const arr = Array.from({ length }, () => ({ pressed: false, value: 0 }))
  for (const b of buttons) arr[b.i] = { pressed: b.pressed ?? false, value: b.value ?? 0 }
  return { buttons: arr, axes }
}

describe("diffGamepad", () => {
  it("sends nothing for a controller that did not change", () => {
    expect(diffGamepad(snap(), snap())).toEqual([])
    expect(diffGamepad(snap([{ i: 0, pressed: true }]), snap([{ i: 0, pressed: true }]))).toEqual(
      [],
    )
  })

  it("reports a face button press and release", () => {
    expect(diffGamepad(snap(), snap([{ i: 0, pressed: true }]))).toEqual([
      { type: "gamepadButton", button: 0, pressed: true },
    ])
    expect(diffGamepad(snap([{ i: 0, pressed: true }]), snap())).toEqual([
      { type: "gamepadButton", button: 0, pressed: false },
    ])
  })

  it("sends a trigger as both a button and its analog axis", () => {
    // Left trigger is button 6, and also drives axis 4 so a game reading only
    // the travel still sees it move.
    const pulled = diffGamepad(snap(), snap([{ i: 6, pressed: true, value: 1 }]))
    expect(pulled).toContainEqual({ type: "gamepadButton", button: 6, pressed: true })
    expect(pulled).toContainEqual({ type: "gamepadAxis", axis: 4, value: 1 })

    const released = diffGamepad(snap([{ i: 6, pressed: true, value: 1 }]), snap())
    expect(released).toContainEqual({ type: "gamepadButton", button: 6, pressed: false })
    expect(released).toContainEqual({ type: "gamepadAxis", axis: 4, value: 0 })
  })

  it("maps the right trigger to axis 5", () => {
    const pulled = diffGamepad(snap(), snap([{ i: 7, pressed: true, value: 0.8 }]))
    expect(pulled).toContainEqual({ type: "gamepadAxis", axis: 5, value: 0.8 })
  })

  it("reports a stick push and its return to centre", () => {
    expect(diffGamepad(snap([], [0, 0, 0, 0]), snap([], [0.7, 0, 0, 0]))).toEqual([
      { type: "gamepadAxis", axis: 0, value: 0.7 },
    ])
    expect(diffGamepad(snap([], [0.7, 0, 0, 0]), snap([], [0, 0, 0, 0]))).toEqual([
      { type: "gamepadAxis", axis: 0, value: 0 },
    ])
  })

  it("swallows drift inside the deadzone", () => {
    // 0.1 is inside the default 0.12 deadzone, so a resting thumb sends nothing.
    expect(diffGamepad(snap([], [0, 0, 0, 0]), snap([], [0.1, -0.09, 0, 0]))).toEqual([])
  })

  it("swallows an analog change smaller than epsilon", () => {
    // Past the deadzone, but a 0.005 wobble is below the 0.02 threshold.
    expect(diffGamepad(snap([], [0.5, 0, 0, 0]), snap([], [0.505, 0, 0, 0]))).toEqual([])
  })

  it("handles the guide button and ignores anything past index 16", () => {
    expect(diffGamepad(snap(), snap([{ i: 16, pressed: true }]))).toEqual([
      { type: "gamepadButton", button: 16, pressed: true },
    ])
    // A pad that reports more than 17 buttons: index 17 is outside the standard
    // mapping and must be dropped, not forwarded as a bogus button.
    const prev = snap([], [0, 0, 0, 0], 18)
    const curr = snap([{ i: 17, pressed: true }], [0, 0, 0, 0], 18)
    expect(diffGamepad(prev, curr)).toEqual([])
  })

  it("snapshotOf copies pressed, value and axes off a live Gamepad", () => {
    const live = {
      buttons: [
        { pressed: true, value: 1 },
        { pressed: false, value: 0 },
      ],
      axes: [0.25, -0.5],
    } as unknown as Gamepad
    expect(snapshotOf(live)).toEqual({
      buttons: [
        { pressed: true, value: 1 },
        { pressed: false, value: 0 },
      ],
      axes: [0.25, -0.5],
    })
  })
})

/** A fake live Gamepad for pollStep, standard mapping unless told otherwise. */
function gp(
  index: number,
  buttons: { i: number; pressed?: boolean; value?: number }[] = [],
  axes: number[] = [0, 0, 0, 0],
  mapping = "standard",
): Gamepad {
  const arr = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  for (const b of buttons) arr[b.i] = { pressed: b.pressed ?? false, value: b.value ?? 0 }
  return { index, mapping, buttons: arr, axes } as unknown as Gamepad
}

describe("pollStep", () => {
  it("does nothing and keeps state when no pad is present", () => {
    const result = pollStep([], IDLE)
    expect(result.messages).toEqual([])
    expect(result.state).toBe(IDLE)
  })

  it("sends the first pad's held state in full and remembers it", () => {
    const { messages, state } = pollStep([gp(0, [{ i: 0, pressed: true }])], IDLE)
    expect(messages).toContainEqual({ type: "gamepadButton", button: 0, pressed: true })
    expect(state.activeIndex).toBe(0)
    expect(state.last.buttons[0]?.pressed).toBe(true)
  })

  it("sends only the change on the next frame of the same pad", () => {
    const first = pollStep([gp(0, [{ i: 0, pressed: true }])], IDLE)
    const second = pollStep([gp(0, [{ i: 0, pressed: true }])], first.state)
    expect(second.messages).toEqual([])
  })

  it("skips a non-standard pad rather than mis-mapping it", () => {
    expect(pollStep([gp(0, [{ i: 0, pressed: true }], [0, 0, 0, 0], "")], IDLE).messages).toEqual(
      [],
    )
  })

  it("drives the first standard pad, past nulls and non-standard ones", () => {
    const pads = [null, gp(1, [], [0, 0, 0, 0], ""), gp(2, [{ i: 1, pressed: true }])]
    const { messages, state } = pollStep(pads, IDLE)
    expect(messages).toContainEqual({ type: "gamepadButton", button: 1, pressed: true })
    expect(state.activeIndex).toBe(2)
  })

  it("resets to neutral when a different controller takes over", () => {
    const first = pollStep([gp(0, [{ i: 0, pressed: true }])], IDLE)
    // A new pad at index 1 with a different button held: because the index
    // changed, its state is sent in full rather than diffed against pad 0.
    const second = pollStep([gp(1, [{ i: 3, pressed: true }])], first.state)
    expect(second.messages).toContainEqual({ type: "gamepadButton", button: 3, pressed: true })
    expect(second.state.activeIndex).toBe(1)
  })
})
