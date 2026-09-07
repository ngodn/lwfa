import { afterEach, describe, expect, it, vi } from "vitest"
import type { WindowInfo } from "@lwfa/proto"
import { loadArrangement, restoreArrangement, saveArrangement } from "../src/lib/arrangement.js"
import { EMPTY, DEFAULT_CONFIG, addWindow, allWindows, moveToWorkspace, setColumnWidth, setFullscreen, layout } from "../src/strip.js"

const output = { width: 1324, height: 838 }
const config = DEFAULT_CONFIG
const windows: WindowInfo[] = [{
  id: 7, appId: "steam_app_3764200", title: "RESIDENT EVIL requiem",
  fullscreen: false, scaling: { mode: "sharp", scale: 1 }, xwayland: true,
  effectiveScale: 1,
}]
const resized = () => setColumnWidth(addWindow(EMPTY, 7, output, config), 7, 1, output, config)

afterEach(() => vi.unstubAllGlobals())

describe("reconnecting arrangement", () => {
  it("keeps an existing game's chosen column width after a page reload", () => {
    const state = resized()
    const before = layout(state, output, config)
    const restored = restoreArrangement(windows, 7, output, config, { state, output }, before)
    expect(layout(restored, output, config)).toEqual(before)
  })

  it("rejects a cache when another device changed the engine arrangement", () => {
    const state = resized()
    const current = layout(addWindow(EMPTY, 7, output, config), output, config)
    expect(layout(restoreArrangement(windows, 7, output, config, { state, output }, current), output, config)).toEqual(current)
  })

  it("does not restore stale window IDs after the engine restarts", () => {
    const state = resized()
    const restored = restoreArrangement(windows, 7, output, config, { state, output }, [])
    expect(layout(restored, output, config)).not.toEqual(layout(state, output, config))
  })

  it("preserves hidden workspaces rather than reintroducing their windows", () => {
    let state = addWindow(resized(), 8, output, config)
    state = moveToWorkspace(state, 1, output, config)
    const currentWindows = [...windows, { ...windows[0]!, id: 8 }]
    const restored = restoreArrangement(currentWindows, 8, output, config, { state, output }, layout(state, output, config))
    expect(restored).toEqual(state)
  })

  it("removes a window closed during a disconnected interval", () => {
    const state = addWindow(resized(), 8, output, config)
    const restored = restoreArrangement(windows, 7, output, config, { state, output }, layout(state, output, config))
    expect(allWindows(restored)).toEqual([7])
    expect(restored.workspaces[0]!.columns[0]!.width).toBe(1)
  })

  it("retains fullscreen when connected to an older engine without a snapshot", () => {
    const restored = restoreArrangement([{ ...windows[0]!, fullscreen: true }], 7, output, config, { state: resized(), output }, null)
    expect(layout(restored, output, config)).toEqual(layout(setFullscreen(resized(), 7, true, output, config), output, config))
  })

  it("round trips a valid tab cache and rejects corrupt browser storage", () => {
    const entries = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    })
    const state = resized()
    saveArrangement(state, output)
    expect(loadArrangement()).toEqual({ state, output })
    entries.set("lwfa.arrangement.v1", JSON.stringify({ state: { ...state, focus: 900 }, output }))
    expect(loadArrangement()).toBeNull()
    entries.set("lwfa.arrangement.v1", "{broken")
    expect(loadArrangement()).toBeNull()
  })

  it("keeps working when browser storage is disabled", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("denied") },
      setItem: () => { throw new Error("denied") },
    })
    expect(loadArrangement()).toBeNull()
    expect(() => saveArrangement(resized(), output)).not.toThrow()
  })
})
