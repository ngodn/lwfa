import { afterEach, beforeEach, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  send: vi.fn(),
  setDock: vi.fn(),
}))

// Run the real hook's polling effect without mounting the rest of the shell.
vi.mock("react", () => ({
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(current: T) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}))
vi.mock("@/session", () => ({
  useSessionActions: () => ({ send: harness.send }),
  useSessionState: () => ({ session: "test", status: "connected" }),
}))
vi.mock("@/lib/dock", () => ({ useDock: () => "gamepad", setDock: harness.setDock }))

import { usePhysicalGamepad } from "../src/gamepad/usePhysicalGamepad"

let cleanup: (() => void)[]
let events: EventTarget
let buttons: { pressed: boolean; value: number }[]
let doc: EventTarget & { visibilityState: string; hasFocus: () => boolean }
let pads: unknown[]

beforeEach(() => {
  vi.useFakeTimers()
  harness.effects.length = 0
  harness.send.mockClear()
  harness.setDock.mockClear()
  cleanup = []
  events = new EventTarget()
  doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true })
  vi.stubGlobal("document", doc)
  vi.stubGlobal("dispatchEvent", events.dispatchEvent.bind(events))
  buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  pads = [{ index: 0, mapping: "standard", buttons, axes: [0, 0, 0, 0] }]
  vi.stubGlobal("navigator", { getGamepads: () => pads })
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events))
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events))
  // Rendering is stalled, but timer tasks and incoming input can still run.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  usePhysicalGamepad()
  for (const effect of harness.effects) {
    const dispose = effect()
    if (dispose) cleanup.push(dispose)
  }
})

afterEach(() => {
  for (const dispose of cleanup.reverse()) dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("forwards repeated presses and releases while animation frames are stalled", () => {
  for (let i = 0; i < 3; i++) {
    buttons[0] = { pressed: true, value: 1 }
    vi.advanceTimersByTime(24)
    buttons[0] = { pressed: false, value: 0 }
    vi.advanceTimersByTime(24)
  }
  expect(harness.send.mock.calls.map(([message]) => message)).toEqual(
    Array.from({ length: 3 }, () => [
      { type: "gamepadButton", button: 0, pressed: true },
      { type: "gamepadButton", button: 0, pressed: false },
    ]).flat(),
  )
})

it("keeps the user's gamepad dock and shield open when a physical pad connects", () => {
  expect(harness.setDock).not.toHaveBeenCalled()
})

it("releases held input and stops polling when the last controller disconnects", () => {
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  pads = []
  events.dispatchEvent(Object.assign(new Event("gamepaddisconnected"), { gamepad: { index: 0 } }))
  expect(harness.send.mock.calls.map(([message]) => message)).toEqual([
    { type: "gamepadButton", button: 0, pressed: true },
    { type: "gamepadButton", button: 0, pressed: false },
  ])
  vi.advanceTimersByTime(24)
  expect(vi.getTimerCount()).toBe(0)
})

it("cancels polling and releases held input on cleanup", () => {
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  for (const dispose of cleanup.reverse()) dispose()
  cleanup = []
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 0, pressed: false })
  expect(vi.getTimerCount()).toBe(0)
  const count = harness.send.mock.calls.length
  vi.advanceTimersByTime(100)
  expect(harness.send).toHaveBeenCalledTimes(count)
})

it("releases the active controller immediately when another controller remains", () => {
  const second = { index: 1, mapping: "standard", buttons: [], axes: [] }
  pads.push(second)
  events.dispatchEvent(Object.assign(new Event("gamepadconnected"), { gamepad: second }))
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  pads[0] = null
  events.dispatchEvent(Object.assign(new Event("gamepaddisconnected"), { gamepad: { index: 0 } }))
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 0, pressed: false })
})


it("releases on blur, ignores stale input, and rearms each control independently", () => {
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  events.dispatchEvent(new Event("blur"))
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 0, pressed: false })
  harness.send.mockClear()
  vi.advanceTimersByTime(100)
  expect(harness.send).not.toHaveBeenCalled()
  events.dispatchEvent(new Event("focus"))
  vi.advanceTimersByTime(24)
  expect(harness.send).not.toHaveBeenCalled()
  // A stale B must not lock out a fresh shoulder press.
  buttons[4] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 4, pressed: true })
  buttons[0] = { pressed: false, value: 0 }
  vi.advanceTimersByTime(24)
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 0, pressed: true })
})

it("releases when hidden even without blur and does not replay a background press", () => {
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  doc.visibilityState = "hidden"
  doc.dispatchEvent(new Event("visibilitychange"))
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 0, pressed: false })
  harness.send.mockClear()
  buttons[4] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  doc.visibilityState = "visible"
  doc.dispatchEvent(new Event("visibilitychange"))
  vi.advanceTimersByTime(24)
  expect(harness.send).not.toHaveBeenCalled()
})

it("manual recovery clears a stale hold without blocking other buttons", () => {
  buttons[0] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  events.dispatchEvent(new Event("lwfa:reset-physical-gamepad"))
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 0, pressed: false })
  harness.send.mockClear()
  vi.advanceTimersByTime(24)
  expect(harness.send).not.toHaveBeenCalled()
  buttons[5] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  expect(harness.send).toHaveBeenLastCalledWith({ type: "gamepadButton", button: 5, pressed: true })
})

it("preserves an intentional long hold with an unchanged browser timestamp", () => {
  buttons[4] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(15_000)
  expect(harness.send.mock.calls.map(([m]) => m)).toEqual([
    { type: "gamepadButton", button: 4, pressed: true },
  ])
})

it("clears trigger travel and stick deflection, then rearms them at neutral", () => {
  const axes = [0.8, 0, 0, 0]
  pads = [{ index: 0, mapping: "standard", buttons, axes }]
  buttons[6] = { pressed: true, value: 1 }
  vi.advanceTimersByTime(24)
  events.dispatchEvent(new Event("lwfa:reset-physical-gamepad"))
  expect(harness.send.mock.calls.map(([m]) => m)).toEqual(expect.arrayContaining([
    { type: "gamepadButton", button: 6, pressed: false },
    { type: "gamepadAxis", axis: 4, value: 0 },
    { type: "gamepadAxis", axis: 0, value: 0 },
  ]))
  harness.send.mockClear()
  vi.advanceTimersByTime(24)
  expect(harness.send).not.toHaveBeenCalled()
  buttons[6] = { pressed: false, value: 0 }
  axes[0] = 0.03
  vi.advanceTimersByTime(24)
  buttons[6] = { pressed: true, value: 1 }
  axes[0] = 0.8
  vi.advanceTimersByTime(24)
  expect(harness.send.mock.calls.map(([m]) => m)).toEqual(expect.arrayContaining([
    { type: "gamepadButton", button: 6, pressed: true },
    { type: "gamepadAxis", axis: 4, value: 1 },
    { type: "gamepadAxis", axis: 0, value: 0.8 },
  ]))
})

it("removes lifecycle and reset listeners on unmount", () => {
  for (const dispose of cleanup.reverse()) dispose()
  cleanup = []
  harness.send.mockClear()
  for (const type of ["blur", "focus", "pagehide", "pageshow", "lwfa:reset-physical-gamepad"]) {
    events.dispatchEvent(new Event(type))
  }
  doc.dispatchEvent(new Event("visibilitychange"))
  vi.advanceTimersByTime(100)
  expect(harness.send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
