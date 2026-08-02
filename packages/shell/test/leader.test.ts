/**
 * One connection per browser, not one per tab.
 *
 * These exist because reasoning about the two-tab case is exactly what I got
 * wrong: two tabs share the browser id, so each looked to the engine like the
 * other reconnecting, and the two traded the session in a loop 290ms wide.
 * A rule that is only argued for on paper is a rule that will be wrong again,
 * so the cases are pinned here against a stand-in for the real lock manager.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { requestLeadership } from "../src/lib/leader"

/**
 * A Web Locks manager good enough to elect a leader.
 *
 * Grants an exclusive lock to the first asker and queues the rest, promoting
 * the next when the holder's promise settles, which is what the real one does.
 */
function fakeLocks() {
  const queue: { run: () => Promise<void> | void; start: () => void }[] = []
  let busy = false

  const pump = () => {
    if (busy) return
    const next = queue.shift()
    if (!next) return
    busy = true
    next.start()
    void Promise.resolve(next.run()).then(() => {
      busy = false
      pump()
    })
  }

  return {
    request(
      _name: string,
      options: { signal?: AbortSignal },
      callback: () => Promise<void> | void,
    ) {
      return new Promise<void>((resolve, reject) => {
        const entry = {
          run: callback,
          start: () => {},
        }
        if (options.signal) {
          options.signal.addEventListener(
            "abort",
            () => {
              const at = queue.indexOf(entry)
              if (at !== -1) queue.splice(at, 1)
              reject(new Error("aborted"))
            },
            { once: true },
          )
        }
        entry.start = () => resolve()
        queue.push(entry)
        pump()
      })
    },
  }
}

const withLocks = (locks: unknown) => {
  Object.defineProperty(globalThis, "navigator", {
    value: { locks },
    configurable: true,
  })
}

beforeEach(() => {
  withLocks(fakeLocks())
})

describe("leader election", () => {
  it("gives the connection to exactly one tab", async () => {
    const first = vi.fn()
    const second = vi.fn()

    const a = requestLeadership(first)
    const b = requestLeadership(second)
    await Promise.resolve()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    a.release()
    b.release()
  })

  it("promotes the waiting tab when the leader lets go", async () => {
    const first = vi.fn()
    const second = vi.fn()

    const a = requestLeadership(first)
    const b = requestLeadership(second)
    await Promise.resolve()
    expect(second).not.toHaveBeenCalled()

    // The leading tab closes.
    a.release()
    await Promise.resolve()
    await Promise.resolve()

    expect(second).toHaveBeenCalledTimes(1)
    b.release()
  })

  it("never runs the callback for a tab that gave up while waiting", async () => {
    // React mounts an effect, tears it down, and mounts it again in
    // development. The abandoned request must not connect later.
    const abandoned = vi.fn()
    const a = requestLeadership(() => {})
    const b = requestLeadership(abandoned)
    await Promise.resolve()

    b.release()
    a.release()
    await Promise.resolve()
    await Promise.resolve()

    expect(abandoned).not.toHaveBeenCalled()
  })

  it("leads immediately where the API does not exist", () => {
    // `navigator.locks` is secure-context only, so the shell over plain HTTP
    // on a LAN address has none. Refusing to connect would be worse than the
    // problem it prevents.
    withLocks(undefined)
    const granted = vi.fn()
    const lead = requestLeadership(granted)

    expect(granted).toHaveBeenCalledTimes(1)
    expect(lead.held).toBe(true)
    lead.release()
  })
})
