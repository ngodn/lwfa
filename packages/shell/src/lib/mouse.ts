/**
 * The virtual mouse's live mode, while its surface is open.
 *
 * This is session state, not a preference: which button a tap fires right now,
 * whether hover-only is on, whether a drag is locked. It exists so the overlay
 * buttons and the window surface agree on what the next tap means without a
 * prop drilled through half the tree.
 *
 * # Nothing here touches the normal path
 *
 * The window surface only ever reads this when the mouse surface is the one on
 * screen (`dock === "mouse"`). With the surface closed these values are inert:
 * a tap is a touch exactly as it always was. Opening the surface calls
 * [`resetMouseMode`], so it always starts clean rather than resuming a stale
 * latch from last time.
 */

import { useSyncExternalStore } from "react"

import { getPrefs } from "./prefs"

export type MouseButton = "left" | "right" | "middle"

export interface MouseModeState {
  /** The button a tap on the window fires. Latched until changed. */
  button: MouseButton
  /** A tap moves the pointer without clicking, to wake hover states. */
  hover: boolean
  /** Armed: the next press latches its button down for a drag. */
  dragLock: boolean
  /**
   * A drag is currently latched down, waiting for the tap that ends it.
   *
   * Shared rather than held per window because a drag can start in one window
   * and finish over another (dragging a file onto a folder in a file manager
   * split across two columns).
   */
  dragActive: boolean
  /** The evdev button held down by an active drag, so its release matches. */
  dragButton: number
}

let state: MouseModeState = {
  button: "left",
  hover: false,
  dragLock: false,
  dragActive: false,
  dragButton: 0,
}
const listeners = new Set<() => void>()

function emit(next: MouseModeState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Latch the button a window-tap will fire. */
export function setButton(button: MouseButton): void {
  if (state.button !== button) emit({ ...state, button })
}

/** Turn hover-only (move without click) on or off. */
export function setHover(hover: boolean): void {
  if (state.hover !== hover) emit({ ...state, hover })
}

/** Arm or disarm drag-lock. */
export function setDragLock(dragLock: boolean): void {
  if (state.dragLock !== dragLock) emit({ ...state, dragLock })
}

/** A press latched down: a drag has begun and disarms the toggle. */
export function beginDrag(dragButton: number): void {
  emit({ ...state, dragActive: true, dragButton, dragLock: false })
}

/** The drag's holding button was released. */
export function endDrag(): void {
  if (state.dragActive) emit({ ...state, dragActive: false })
}

/**
 * Start the mouse surface from a clean slate.
 *
 * Called when the surface opens, so hover and drag-lock never carry over and
 * the button returns to the configured default. See the module note.
 */
export function resetMouseMode(): void {
  emit({
    button: getPrefs().mouse.defaultButton,
    hover: false,
    dragLock: false,
    dragActive: false,
    dragButton: 0,
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): MouseModeState => state

/** Subscribe to the live mode (for the overlay's own controls). */
export function useMouseMode(): MouseModeState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The latest mode, read outside React at the moment of a tap. */
export function getMouseMode(): MouseModeState {
  return state
}
