import type { WindowId, WindowInfo, WindowLayout } from "@lwfa/proto"
import {
  EMPTY, WIDTH_PRESETS, addWindow, allWindows, focusWindow, focusedWindow,
  layout, removeWindow, setFullscreen,
  type Output, type StripConfig, type StripState,
} from "../strip.js"

export interface Arrangement {
  state: StripState
  output: Output
}

const KEY = "lwfa.arrangement.v1"

function validState(value: unknown): value is StripState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<StripState>
  const index = (n: unknown, length: number) => Number.isInteger(n) && Number(n) >= 0 && Number(n) < Math.max(1, length)
  if (!Array.isArray(state.workspaces) || state.workspaces.length === 0 ||
    !index(state.focus, state.workspaces.length)) return false
  const ids = new Set<number>()
  return state.workspaces.every((ws) => {
    if (!ws || !Array.isArray(ws.columns) || !index(ws.focus, ws.columns.length) ||
      !Number.isFinite(ws.viewOffset) || typeof ws.fit !== "boolean" ||
      !(ws.fullscreen === null || Number.isInteger(ws.fullscreen)) ||
      !(ws.fullscreenOverride === undefined || Number.isInteger(ws.fullscreenOverride))) return false
    if (!ws.columns.every((column) => {
      if (!column || !Array.isArray(column.windows) || column.windows.length === 0 ||
        !index(column.focus, column.windows.length) || !index(column.width, WIDTH_PRESETS.length) ||
        !(column.live === undefined || typeof column.live === "boolean")) return false
      return column.windows.every((id) => {
        if (!Number.isSafeInteger(id) || id < 0 || ids.has(id)) return false
        ids.add(id)
        return true
      })
    })) return false
    if (ws.fullscreenOverride !== undefined &&
      ws.columns[ws.focus]?.windows[ws.columns[ws.focus]!.focus] !== ws.fullscreenOverride) return false
    return ws.fullscreen === null || ws.columns.some((column) => column.windows.includes(ws.fullscreen!))
  })
}

export function loadArrangement(): Arrangement | null {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(KEY) ?? "null")
    if (value && validState(value.state) && Number.isFinite(value.output?.width) &&
      Number.isFinite(value.output?.height) && value.output.width > 0 && value.output.height > 0) return value
  } catch { /* Storage can be unavailable in a private browser session. */ }
  return null
}

export function saveArrangement(state: StripState, output: Output): void {
  try { globalThis.sessionStorage?.setItem(KEY, JSON.stringify({ state, output })) }
  catch { /* Keep the live layout usable when browser storage is unavailable. */ }
}

/** Reconcile a browser arrangement with the engine's current windows. */
export function restoreArrangement(
  windows: WindowInfo[],
  focused: WindowId | null,
  output: Output,
  config: StripConfig,
  saved: Arrangement | null,
  current: WindowLayout[] | null,
): StripState {
  const live = new Set(windows.map((w) => w.id))
  const comparable = (items: WindowLayout[]) => items.filter((item) => live.has(item.id))
    .map(({ id, rect, z }) => [id, rect.x, rect.y, rect.width, rect.height, z])
    .sort((a, b) => a[0]! - b[0]!)
  // A cached tab must not overwrite a layout another device changed, or an
  // engine that restarted and reused window IDs. Compare against its snapshot.
  if (saved && current && current.length > 0 && saved.output.width === output.width &&
    saved.output.height === output.height &&
    JSON.stringify(comparable(layout(saved.state, output, config))) === JSON.stringify(comparable(current))) {
    let next = saved.state
    for (const id of allWindows(next)) {
      if (!live.has(id)) next = removeWindow(next, id, output, config)
    }
    for (const w of windows) next = addWindow(next, w.id, output, config)
    if (focused !== null && focusedWindow(next) !== focused) next = focusWindow(next, focused, output, config)
    return next
  }
  let next = windows.reduce((state, w) => addWindow(state, w.id, output, config), EMPTY)
  if (focused !== null) next = focusWindow(next, focused, output, config)
  for (const w of windows) {
    if (w.fullscreen) next = setFullscreen(next, w.id, true, output, config)
  }
  return next
}
