// Native clients execute the shell's layout policy in JavaScriptCore.
import { WINDOW_SPRING } from "../../packages/shell/src/generated/config.ts"
import * as strip from "../../packages/shell/src/strip.ts"
import { loadArrangement, restoreArrangement, type Arrangement } from "../../packages/shell/src/lib/arrangement.ts"

let state = strip.EMPTY
let output: strip.Output = { width: 1, height: 1 }
let config = strip.DEFAULT_CONFIG
let initialized = false
let saved: Arrangement | null = null
let aliases = new Map<string, number>()
let originals = new Map<number, string>()
let nextAlias = 1

function alias(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) throw Error("Invalid window identifier")
  let id = aliases.get(value)
  if (id === undefined) {
    if (!Number.isSafeInteger(nextAlias)) throw Error("Window identifier capacity exceeded")
    id = nextAlias++
    aliases.set(value, id)
    originals.set(id, value)
  }
  return id
}
function original(id: number | null | undefined): string | null {
  if (id == null) return null
  const value = originals.get(id)
  if (value === undefined) throw Error("Unknown window identifier")
  return value
}
function externalState() {
  return { ...state, workspaces: state.workspaces.map(ws => ({ ...ws,
    fullscreen: original(ws.fullscreen),
    ...(ws.fullscreenOverride === undefined ? {} : { fullscreenOverride: original(ws.fullscreenOverride) }),
    columns: ws.columns.map(column => ({ ...column, windows: column.windows.map(original) })),
  })) }
}
function snapshot() {
  const placed = strip.layout(state, output, config)
  const streams = (pause: boolean) => strip.streamList(placed, output, config, strip.focusedWindow(state), pause, strip.fullscreenWindow(state), strip.liveWindows(state)).map(original)
  return {
    state: externalState(), focused: original(strip.focusedWindow(state)), fullscreen: strip.isFullscreen(state),
    placed: placed.map(w => ({ ...w, id: original(w.id) })), streams: streams(false), activeStreams: streams(true),
    presets: strip.WIDTH_PRESETS, spring: WINDOW_SPRING, config, output,
    saved: { state, output, aliases: [...aliases] },
  }
}
function restore(value: any) {
  // Validate persisted state through the same parser used by browser sessions.
  const storage = { getItem: () => JSON.stringify(value) }
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage })
  const candidate = loadArrangement()
  delete (globalThis as any).sessionStorage
  if (!candidate || !Array.isArray(value.aliases)) return
  const pairs = value.aliases as unknown[]
  const restored = new Map<string, number>()
  const reverse = new Map<number, string>()
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return
    const [key, id] = pair
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || BigInt(key) > 18446744073709551615n || !Number.isSafeInteger(id) || id < 1 || id >= Number.MAX_SAFE_INTEGER || restored.has(key) || reverse.has(id)) return
    restored.set(key, id); reverse.set(id, key)
  }
  if (strip.allWindows(candidate.state).some(id => !reverse.has(id))) return
  aliases = restored; originals = reverse
  nextAlias = Math.max(0, ...reverse.keys()) + 1
  saved = candidate
}
function dimensions(value: any) {
  if (!Number.isFinite(value?.width) || !Number.isFinite(value?.height) || value.width < 1 || value.height < 1) throw Error("Invalid canvas dimensions")
  output = { width: value.width, height: value.height }
}
function action(name: string, args: any[]) {
  const n = (index: number) => { const value = Number(args[index]); if (!Number.isSafeInteger(value)) throw Error("Invalid layout index"); return value }
  const id = () => alias(args[0])
  switch (name) {
    case "focus": state = strip.focusWindow(state, id(), output, config); break
    case "focusLeft": state = strip.focusLeft(state, output, config); break
    case "focusRight": state = strip.focusRight(state, output, config); break
    case "focusUp": state = strip.focusUp(state); break
    case "focusDown": state = strip.focusDown(state); break
    case "cycleWidth": state = strip.cycleWidth(state, output, config); break
    case "width": state = strip.setColumnWidth(state, id(), n(1), output, config); break
    case "live": state = strip.setColumnLive(state, id(), args[1] === true); break
    case "fullscreen": state = strip.toggleFullscreen(state, output, config); break
    case "fullscreenRequest": state = strip.setFullscreen(state, id(), args[1] === true, output, config); break
    case "fit": state = strip.setFit(state, args[0] === true, output, config); break
    case "stack": state = strip.consumeIntoColumn(state, output, config); break
    case "unstack": state = strip.expelFromColumn(state, output, config); break
    case "workspace": state = strip.focusWorkspace(state, n(0) - state.focus, output, config); break
    case "moveWorkspace": state = strip.moveToWorkspace(state, n(0), output, config); break
    case "sendWorkspace": state = strip.sendToWorkspace(state, id(), n(1), output, config); break
    case "move": {
      const target = args[1]
      if (!target || !["column", "newColumn"].includes(target.kind) || !Number.isSafeInteger(Number(target.index)) || Number(target.index) < 0) throw Error("Invalid move target")
      const row = target.row == null ? undefined : Number(target.row)
      if (row !== undefined && (!Number.isSafeInteger(row) || row < 0)) throw Error("Invalid row")
      state = strip.moveWindow(state, id(), { kind: target.kind, index: Number(target.index), row }, output, config); break
    }
    default: throw Error(`Unknown layout action: ${name}`)
  }
}
export function dispatch(json: string): string {
  try {
    const message = JSON.parse(json)
    switch (message.type) {
      case "reset":
        state = strip.EMPTY; initialized = false; saved = null; aliases.clear(); originals.clear(); nextAlias = 1
        if (message.saved) restore(message.saved)
        break
      case "configure":
        config = strip.configFrom({ orientation: ["horizontal", "vertical"].includes(message.orientation) ? message.orientation : "auto", defaultWidth: message.defaultWidth, centreFocused: message.centreFocused === true })
        state = strip.reflow(state, output, config)
        break
      case "resize": dimensions(message.output); state = strip.reflow(state, output, config); break
      case "reconcile": {
        dimensions(message.output)
        const windows = message.windows.map((w: any) => ({ ...w, id: alias(w.id) }))
        const focused = message.focused == null ? null : alias(message.focused)
        const current = (message.current ?? []).map((w: any) => ({ ...w, id: alias(w.id) }))
        if (!initialized) {
          state = restoreArrangement(windows, focused, output, config, saved, current)
          initialized = true; saved = null
        } else {
          const live = new Set(windows.map((w: any) => w.id))
          for (const id of strip.allWindows(state)) if (!live.has(id)) state = strip.removeWindow(state, id, output, config)
          for (const w of windows) state = strip.addWindow(state, w.id, output, config)
          if (focused !== null && strip.focusedWindow(state) !== focused) state = strip.focusWindow(state, focused, output, config)
          state = strip.reflow(state, output, config)
        }
        break
      }
      case "action": action(message.name, message.args ?? []); break
      case "snapshot": break
      default: throw Error("Unknown layout message")
    }
    return JSON.stringify(snapshot())
  } catch (error) { return JSON.stringify({ error: String(error) }) }
}
