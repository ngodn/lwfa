/**
 * Recovering from a crash without turning one bug into a reload loop.
 *
 * The shell used to unmount its whole tree on any uncaught throw, leaving bare
 * `<body>`: white on a light theme, black on a dark one, with the reason gone.
 * Reloading fixes it, and reloading is nearly free because the desktop lives in
 * the engine.
 *
 * Reloading *unconditionally* is the trap. Anything that also throws on the way
 * back up gives an endless loop, and on a tablet that is a page you have to
 * force-quit: no way to read the error, no way to reach the setting that caused
 * it. So the decision is "reload, up to a point".
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  LIMIT,
  WINDOW_MS,
  clearCrashes,
  crashCount,
  noteCrashToReport,
  onCrash,
  takeCrashToReport,
} from "../src/lib/crashLoop"

/** A `sessionStorage` that lives in a variable. */
function fakeStore(): Storage & { failing?: boolean } {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage
}

let store: Storage
const T0 = 1_000_000

beforeEach(() => {
  store = fakeStore()
})

describe("the common case", () => {
  it("reloads on the first crash", () => {
    // A one-off. Nobody should ever see an error screen for this.
    expect(onCrash(store, T0)).toBe("reload")
  })

  it("keeps reloading up to the limit", () => {
    for (let i = 0; i < LIMIT; i++) {
      expect(onCrash(store, T0 + i * 1000), `crash ${i + 1}`).toBe("reload")
    }
  })
})

describe("a loop", () => {
  it("stops once it has crashed too often in quick succession", () => {
    for (let i = 0; i < LIMIT; i++) onCrash(store, T0 + i * 1000)
    expect(onCrash(store, T0 + LIMIT * 1000)).toBe("stop")
  })

  it("stays stopped", () => {
    // Otherwise the next crash reloads again and the loop resumes.
    for (let i = 0; i <= LIMIT; i++) onCrash(store, T0 + i * 1000)
    expect(onCrash(store, T0 + 10_000)).toBe("stop")
  })
})

describe("forgetting", () => {
  it("does not count crashes from long ago", () => {
    // A crash this morning must not make this afternoon's first one look like
    // a loop.
    for (let i = 0; i < LIMIT; i++) onCrash(store, T0 + i * 1000)
    expect(onCrash(store, T0 + WINDOW_MS + 10_000)).toBe("reload")
  })

  it("forgets outright when the shell has clearly survived", () => {
    for (let i = 0; i < LIMIT; i++) onCrash(store, T0 + i * 1000)
    clearCrashes(store)
    expect(crashCount(store, T0 + LIMIT * 1000)).toBe(0)
    expect(onCrash(store, T0 + LIMIT * 1000)).toBe("reload")
  })
})

describe("storage that will not cooperate", () => {
  it("stops rather than reloads when it cannot remember", () => {
    // Without a count there is no way to detect a loop, and an unreadable
    // message beats a page that reloads forever.
    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
      removeItem: () => {},
    } as unknown as Storage
    expect(onCrash(readOnly, T0)).toBe("stop")
  })

  it("treats unparseable history as no history", () => {
    store.setItem("lwfa.crashes", "not json at all")
    expect(onCrash(store, T0)).toBe("reload")
  })

  it("ignores entries that are not timestamps", () => {
    store.setItem("lwfa.crashes", JSON.stringify(["yesterday", null, {}]))
    expect(crashCount(store, T0)).toBe(0)
  })

  it("survives clearing when storage refuses", () => {
    const stubborn = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("nope")
      },
    } as unknown as Storage
    expect(() => clearCrashes(stubborn)).not.toThrow()
  })
})

describe("counting", () => {
  it("reports how many are being held against it", () => {
    onCrash(store, T0)
    onCrash(store, T0 + 500)
    expect(crashCount(store, T0 + 1000)).toBe(2)
  })

  it("counts only what is still inside the window", () => {
    onCrash(store, T0)
    onCrash(store, T0 + WINDOW_MS + 1000)
    expect(crashCount(store, T0 + WINDOW_MS + 1000)).toBe(1)
  })
})

describe("telling the engine what happened", () => {
  // The reason this exists: a reloading shell closes its socket cleanly, and
  // that is exactly what a deliberate reload looks like from the engine. The
  // shell's own log is in memory and dies with the page. So the failure a user
  // actually notices, the session that "came back strange", used to leave no
  // record anywhere at all.

  it("keeps the message for the next page load", () => {
    noteCrashToReport(store, "Cannot read properties of undefined")
    expect(takeCrashToReport(store)).toBe("Cannot read properties of undefined")
  })

  it("reports it once and not again", () => {
    // Taken, not read. Left in place it would be sent again on every
    // reconnect for the rest of the session, and a crash that happened once
    // would look like a crash that keeps happening.
    noteCrashToReport(store, "boom")
    expect(takeCrashToReport(store)).toBe("boom")
    expect(takeCrashToReport(store)).toBeNull()
  })

  it("says nothing when nothing crashed", () => {
    expect(takeCrashToReport(store)).toBeNull()
  })

  it("truncates, because a React error carries a component stack", () => {
    noteCrashToReport(store, "x".repeat(5000))
    expect(takeCrashToReport(store)?.length).toBe(300)
  })

  it("survives storage that refuses to write", () => {
    // Private browsing, or a full quota. Losing the report is acceptable;
    // throwing inside the crash handler is not, because the handler is the
    // thing standing between one bug and a blank page.
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
      removeItem: () => {},
    } as unknown as Storage
    expect(() => noteCrashToReport(broken, "boom")).not.toThrow()
    expect(takeCrashToReport(broken)).toBeNull()
  })

  it("is not disturbed by the crash count sharing the same storage", () => {
    noteCrashToReport(store, "boom")
    onCrash(store, T0)
    clearCrashes(store)
    expect(takeCrashToReport(store)).toBe("boom")
    expect(crashCount(store, T0)).toBe(0)
  })
})
