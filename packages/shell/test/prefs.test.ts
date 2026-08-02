/**
 * Preference hydration and edge resolution.
 *
 * Preferences are the one piece of state that outlives the code: they sit in
 * `localStorage` across releases, and during development they can be written by
 * a newer module than the one reading them. So the interesting cases here are
 * all the ones where the stored blob is *not* what this version expects.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveEdge } from "../src/lib/prefs"

const STORAGE_KEY = "lwfa.prefs"

/** A `localStorage` good enough for the module under test. */
function fakeStorage(seed?: unknown) {
  const map = new Map<string, string>()
  if (seed !== undefined) map.set(STORAGE_KEY, JSON.stringify(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

/** Import a fresh copy of the module against a given stored blob. */
async function hydrateWith(seed: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    value: fakeStorage(seed),
    configurable: true,
  })
  // Preferences are read once, at import, so the module registry has to be
  // dropped between cases or every case would see the first one's storage.
  vi.resetModules()
  const fresh = await import("../src/lib/prefs")
  return fresh.getPrefs()
}

describe("resolveEdge", () => {
  it("passes a real edge through unchanged", () => {
    expect(resolveEdge("left", false)).toBe("left")
    expect(resolveEdge("right", true)).toBe("right")
    expect(resolveEdge("top", false)).toBe("top")
    expect(resolveEdge("bottom", true)).toBe("bottom")
  })

  it("follows the viewport when asked to work it out", () => {
    expect(resolveEdge("auto", false)).toBe("left")
    expect(resolveEdge("auto", true)).toBe("bottom")
  })

  it("treats an unrecognised value as auto rather than returning it", () => {
    // The failure this guards against: `"auto"` reaching a component old enough
    // to hand it straight to a sheet as a side. A side is a direction, `"auto"`
    // is not one, and the panel positions itself off-screen. Anything we do not
    // recognise has to become a direction here, not downstream.
    for (const junk of ["", "AUTO", "centre", "left ", "1", "undefined"]) {
      expect(resolveEdge(junk, false)).toBe("left")
      expect(resolveEdge(junk, true)).toBe("bottom")
    }
  })
})

describe("hydrate", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it("keeps a stored edge", async () => {
    const prefs = await hydrateWith({ nav: { edge: "top" } })
    expect(prefs.nav.edge).toBe("top")
  })

  it("keeps auto, which is a legitimate preference and not a fallback", async () => {
    const prefs = await hydrateWith({ nav: { edge: "auto" } })
    expect(prefs.nav.edge).toBe("auto")
  })

  it("discards an edge it does not recognise", async () => {
    const prefs = await hydrateWith({ nav: { edge: "diagonal" } })
    expect(["left", "right", "top", "bottom", "auto"]).toContain(prefs.nav.edge)
  })

  it("survives a blob with the wrong shape entirely", async () => {
    const prefs = await hydrateWith({ nav: 7 })
    expect(prefs.nav.order.length).toBeGreaterThan(0)
  })
})
