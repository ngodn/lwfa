/**
 * Driving the engine's controller from a physical gamepad on the client.
 *
 * The browser has no "a button changed" event, only a list you poll, so this
 * reads `navigator.getGamepads` on every animation frame, diffs it, and sends
 * what moved down the same wire the on-screen pad uses (see `physical.ts` and
 * `diffGamepad`). The engine already keeps a persistent virtual controller and
 * binds it to whoever sends input, so there is nothing to announce and no
 * lifecycle to manage: sending a button is enough.
 *
 * One controller (player one) for now: the first pad reporting the W3C standard
 * mapping. When one is connected the on-screen pad auto-hides, since you would
 * not use both, and comes back when the controller goes.
 */

import { useEffect, useRef } from "react"

import { setDock, useDock } from "@/lib/dock"
import { useSessionActions, useSessionState } from "@/session"
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
  const dock = useDock()

  // The handlers and the frame loop read these through refs, so they are bound
  // once and never need the effect to re-run when a value changes.
  const send = useRef(actions.send)
  send.current = actions.send
  const dockNow = useRef(dock)
  dockNow.current = dock
  const live = useRef(status === "connected")
  live.current = status === "connected"

  /** Which pad we drive and its last sent state; whether we hid the pad. */
  const pollState = useRef<PollState>(IDLE)
  const hid = useRef(false)
  const connected = useRef(new Set<number>())
  const raf = useRef(0)

  // A reconnect is a fresh controller on the engine side, so forget the
  // baseline: the next frame then re-sends whatever is currently held rather
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

    const step = () => {
      if (connected.current.size === 0) {
        raf.current = 0
        return
      }
      raf.current = requestAnimationFrame(step)
      if (!live.current) return
      const { messages, state } = pollStep(navigator.getGamepads?.() ?? [], pollState.current)
      for (const message of messages) send.current(message)
      pollState.current = state
    }

    const ensureLoop = () => {
      if (raf.current === 0) raf.current = requestAnimationFrame(step)
    }

    const autoHide = () => {
      if (dockNow.current === "gamepad") {
        hid.current = true
        setDock("none")
      }
    }

    const onConnect = (event: GamepadEvent) => {
      connected.current.add(event.gamepad.index)
      autoHide()
      ensureLoop()
    }

    const onDisconnect = (event: GamepadEvent) => {
      connected.current.delete(event.gamepad.index)
      if (connected.current.size > 0) return
      release()
      // Put the on-screen pad back, but only if nothing else took the surface
      // meanwhile, so a keyboard the user opened is left alone.
      if (hid.current) {
        hid.current = false
        if (dockNow.current === "none") setDock("gamepad")
      }
    }

    globalThis.addEventListener("gamepadconnected", onConnect)
    globalThis.addEventListener("gamepaddisconnected", onDisconnect)

    // A pad paired before this mounted never fires `gamepadconnected` here, so
    // pick up anything already present.
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad) connected.current.add(pad.index)
    }
    if (connected.current.size > 0) {
      autoHide()
      ensureLoop()
    }

    return () => {
      globalThis.removeEventListener("gamepadconnected", onConnect)
      globalThis.removeEventListener("gamepaddisconnected", onDisconnect)
      if (raf.current !== 0) {
        cancelAnimationFrame(raf.current)
        raf.current = 0
      }
      release()
    }
    // Mount once: every changing value is read through a ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
