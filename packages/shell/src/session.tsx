/**
 * What the panels are allowed to know about the live session.
 *
 * # Two contexts, not one
 *
 * `SessionState` changes constantly: a window opens, focus moves, the strip
 * scrolls. `SessionActions` never changes at all. Merging them would mean every
 * component that only wants to *call* something re-renders every time anything
 * *is* something, which for a keyboard holding two hundred key buttons is a lot
 * of wasted work for a cursor blink somewhere else.
 *
 * Neither context reaches the desktop. `Desktop` takes props and is memoised,
 * so none of this can cause a window surface to re-render.
 */

import { createContext, use } from "react"
import type { ToEngine, WindowId, WindowInfo } from "@lwfa/proto"
import type { Status } from "./connection.js"
import type { Output, StripState } from "./strip.js"

/** Everything that changes while a session runs. */
export interface SessionState {
  status: Status
  statusDetail?: string | undefined
  output: Output
  windows: Map<WindowId, WindowInfo>
  strip: StripState
  /** The endpoint this shell is talking to, for display. */
  endpoint: string
}

/**
 * Everything a panel can do. Stable for the lifetime of the connection.
 *
 * Deliberately not "send whatever you like": each of these is a named
 * operation, so a panel cannot invent protocol traffic and the set of things
 * the UI can ask for stays readable in one place.
 */
export interface SessionActions {
  /** Raw escape hatch, for input surfaces that synthesise events. */
  send: (message: ToEngine) => void

  focusWindow: (id: WindowId) => void
  closeWindow: (id: WindowId) => void
  spawn: (command: string) => void

  focusColumn: (delta: -1 | 1) => void
  focusInStack: (delta: -1 | 1) => void
  /** Pull the focused window into the column on its left. */
  consume: () => void
  /** Push the focused window out into a column of its own. */
  expel: () => void
  cycleWidth: () => void

  focusWorkspace: (index: number) => void
  moveToWorkspace: (delta: -1 | 1) => void
}

const StateContext = createContext<SessionState | null>(null)
const ActionsContext = createContext<SessionActions | null>(null)

export const SessionStateProvider = StateContext.Provider
export const SessionActionsProvider = ActionsContext.Provider

/**
 * Throws rather than returning null.
 *
 * A panel rendered outside the session is a wiring mistake, and silently
 * handing it an empty session would turn that into a blank panel nobody can
 * explain.
 */
export function useSessionState(): SessionState {
  const value = use(StateContext)
  if (!value) throw new Error("useSessionState outside a session")
  return value
}

export function useSessionActions(): SessionActions {
  const value = use(ActionsContext)
  if (!value) throw new Error("useSessionActions outside a session")
  return value
}
