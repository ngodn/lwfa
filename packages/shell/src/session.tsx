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
import type {
  PeerInfo,
  Permissions,
  SessionId,
  SessionMode,
  ToEngine,
  WindowId,
  WindowInfo,
} from "@lwfa/proto"
import type { Status } from "./connection.js"
import type { MoveTarget, Output, StripState } from "./strip.js"

/** Everything that changes while a session runs. */
export interface SessionState {
  status: Status
  statusDetail?: string | undefined
  output: Output
  windows: Map<WindowId, WindowInfo>
  strip: StripState
  /** The endpoint this shell is talking to, for display. */
  endpoint: string
  /**
   * What this session may do.
   *
   * Advisory: the shell uses it to grey out controls. The engine enforces it,
   * because a check that runs in the browser is a suggestion.
   */
  permissions: Permissions
  /** Which account is connected. "owner" for AUTH_PASS. */
  account: string
  /** This connection's own id, so it can find itself in `peers`. */
  session: SessionId
  /**
   * Whether this connection decides layout.
   *
   * Several devices can be attached to one session, but a window has exactly
   * one size, so exactly one of them chooses the arrangement and the rest are
   * told what it chose. A follower is not a spectator: it still sends input
   * and still receives every frame.
   */
  primary: boolean
  /** Everyone connected, including this session. */
  peers: PeerInfo[]
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
  /// Ends the process, not just the window. See `ToEngine::QuitApp`.
  quitApp: (id: WindowId) => void
  spawn: (command: string, terminal?: boolean) => void
  /**
   * Close a program running on the desktop, then launch it here.
   *
   * Only sent after the user has been asked. See `lib/alreadyRunning`.
   */
  closeAndSpawn: (command: string, terminal: boolean, pid: number, force: boolean) => void

  focusColumn: (delta: -1 | 1) => void
  focusInStack: (delta: -1 | 1) => void
  /** Pull the focused window into the column on its left. */
  consume: () => void
  /** Push the focused window out into a column of its own. */
  expel: () => void
  /**
   * Move a window to a chosen place. What a drag in arrange mode does.
   *
   * Unlike `consume` and `expel`, which step the focused window in a fixed
   * direction, this names its destination outright.
   */
  moveWindow: (id: WindowId, target: MoveTarget) => void
  /**
   * Send a window to a workspace without following it.
   *
   * Unlike `moveToWorkspace`, which is the keyboard command and follows.
   */
  sendToWorkspace: (id: WindowId, index: number) => void
  cycleWidth: () => void
  /** Set a named window's column to a chosen width preset. */
  setColumnWidth: (id: WindowId, preset: number) => void
  /** Fill the whole client viewport with the focused window, or go back. */
  toggleFullscreen: () => void
  /** Ask to become the connection that decides layout. */
  takeControl: () => void
  /**
   * Forget the stored password and return to the login screen.
   *
   * An action rather than a prop threaded down to the one panel that offers
   * it: the panel host renders panels without props, and passing this through
   * would mean every panel's type knowing about it.
   */
  signOut: () => void
  /** Disconnect another session. The owner's alone. */
  endSession: (session: SessionId) => void
  /** Change what a live session may do, without touching its account. */
  setSessionMode: (session: SessionId, mode: SessionMode) => void

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
