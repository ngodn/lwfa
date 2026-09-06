/**
 * Driving the engine's controller from a physical gamepad on the client.
 *
 * The browser has no "a button changed" event, only a list you poll, so this
 * reads `navigator.getGamepads` on an 8 ms timer, diffs it, and sends
 * what moved down the same wire the on-screen pad uses (see `physical.ts` and
 * `diffGamepad`). The engine already keeps a persistent virtual controller and
 * binds it to whoever sends input, so there is nothing to announce and no
 * lifecycle to manage: sending a button is enough.
 *
 * One controller (player one) for now: the first pad reporting the W3C standard
 * mapping. Connecting it leaves the selected input surface alone: closing the
 * dock would disable its tap shield and reset the engine's held controller input.
 */

import { useEffect, useRef } from "react"

import { useSessionActions, useSessionState } from "@/session"
import { controllerTrace } from "@/gamepad/diagnostics"
import {
  IDLE,
  NEUTRAL,
  diffGamepad,
  pollStep,
  type PollState,
} from "@/gamepad/physical"

export function usePhysicalGamepad(): void {
  const actions = useSessionActions()
  const { session, status } = useSessionState()

  // The handlers and the polling loop read these through refs, so they are bound
  // once and never need the effect to re-run when a value changes.
  const send = useRef(actions.send)
  send.current = actions.send
  const live = useRef(status === "connected")
  live.current = status === "connected"

  /** Which pad we drive and its last sent state. */
  const pollState = useRef<PollState>(IDLE)
  const connected = useRef(new Set<number>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A reconnect is a fresh controller on the engine side, so forget the
  // baseline: the next poll then re-sends whatever is currently held rather
  // than only future changes. See the engine's `gamepad_for`.
  useEffect(() => {
    pollState.current = { ...pollState.current, last: NEUTRAL }
  }, [session])

  useEffect(() => {
    // Let go of everything the pad was holding. A disconnect mid-press must not
    // leave a button stuck down in the persistent controller.
    const release = () => {
      for (const message of diffGamepad(pollState.current.last, NEUTRAL)) send.current(message)
      pollState.current = IDLE
    }

    // Input must keep flowing when video rendering skips animation frames.
    // Timers still share the main thread and cannot recover transitions that
    // the browser never exposes, but do not wait for the next paint.
    const step = () => {
      if (connected.current.size === 0) {
        timer.current = null
        return
      }
      timer.current = setTimeout(step, 8)
      if (!live.current && !controllerTrace.recording) return
      const pads = navigator.getGamepads?.() ?? []
      if (!live.current) {
        if (controllerTrace.recording) controllerTrace.sample(performance.now(), pads, false, [])
        return
      }
      const { messages, state } = pollStep(pads, pollState.current)
      if (controllerTrace.recording) controllerTrace.sample(performance.now(), pads, true, messages)
      for (const message of messages) send.current(message)
      pollState.current = state
    }

    const ensureLoop = () => {
      if (timer.current === null) step()
    }

    const onConnect = (event: GamepadEvent) => {
      connected.current.add(event.gamepad.index)
      ensureLoop()
    }

    const onDisconnect = (event: GamepadEvent) => {
      connected.current.delete(event.gamepad.index)
      if (pollState.current.activeIndex === event.gamepad.index) release()
      if (connected.current.size > 0) return
      release()
    }

    globalThis.addEventListener("gamepadconnected", onConnect)
    globalThis.addEventListener("gamepaddisconnected", onDisconnect)

    // A pad paired before this mounted never fires `gamepadconnected` here, so
    // pick up anything already present.
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad) connected.current.add(pad.index)
    }
    if (connected.current.size > 0) {
      ensureLoop()
    }

    return () => {
      globalThis.removeEventListener("gamepadconnected", onConnect)
      globalThis.removeEventListener("gamepaddisconnected", onDisconnect)
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      release()
    }
    // Mount once: every changing value is read through a ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
