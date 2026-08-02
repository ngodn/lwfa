/**
 * What happens when the shell throws.
 *
 * # Why this exists
 *
 * React unmounts the entire tree when a render or an effect throws and nothing
 * catches it. There was nothing catching it, so any single mistake anywhere
 * took the whole desktop with it, leaving bare `<body>`: white on a light
 * theme, black on a dark one. It also took the reason with it, so there was
 * nothing to report and nothing to fix.
 *
 * # Reload, but not blindly
 *
 * Reloading is nearly free here, because the desktop lives in the engine: the
 * windows, their contents and the arrangement all survive it, and the password
 * is already stored. So an ordinary one-off crash reloads on its own and
 * nobody ever sees this component.
 *
 * What it must not do is reload unconditionally. Anything that also throws on
 * the way back up gives an endless reload loop, with no way to read the error
 * and no way to reach the setting that would fix it. On a tablet that is a page
 * you have to force-quit. So after a few crashes in quick succession it stops
 * and shows the error instead. See `lib/crashLoop`.
 *
 * # What it does not catch
 *
 * Errors from event handlers, timers and promise callbacks. React does not
 * route those through boundaries and they unmount nothing, so they were never
 * the cause here. They are still worth seeing, which is `watchGlobalErrors`.
 */

import { Component, type ReactNode } from "react"
import { clearCrashes, crashCount, onCrash } from "@/lib/crashLoop"
import { log } from "@/lib/log"

/**
 * How long the shell has to run before past crashes stop counting.
 *
 * Without this, two crashes hours apart leave the next one one step away from
 * refusing to reload, having been perfectly fine in between.
 */
const SETTLED_AFTER_MS = 30_000

/** `sessionStorage`, or nothing where storage is disabled. */
function safeStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    // Private browsing with storage blocked entirely.
    return null
  }
}

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  /** True once it has crashed too often to keep reloading. */
  looping: boolean
}

export class Crashed extends Component<Props, State> {
  override state: State = { error: null, looping: false }
  #settled: ReturnType<typeof setTimeout> | undefined

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidMount(): void {
    this.#settled = globalThis.setTimeout(() => {
      const store = safeStore()
      if (store) clearCrashes(store)
    }, SETTLED_AFTER_MS)
  }

  override componentWillUnmount(): void {
    globalThis.clearTimeout(this.#settled)
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    // To the console for the stack, and to the session log so it can still be
    // read afterwards by somebody on a tablet with no developer tools.
    console.error("the shell crashed:", error, info.componentStack)
    log("error", `crashed: ${error instanceof Error ? error.message : String(error)}`)

    const store = safeStore()
    if (store && onCrash(store, Date.now()) === "reload") {
      globalThis.location.reload()
      return
    }
    // Either it keeps happening, or there is no storage to tell. Both mean
    // show the error rather than risk a loop.
    this.setState({ looping: true })
  }

  override render(): ReactNode {
    const { error, looping } = this.state
    if (!error) return this.props.children

    // Crashed once and about to reload. Deliberately almost nothing: putting an
    // error screen up for the fraction of a second before the page goes away
    // reads as a fault when the shell is in fact fixing itself.
    if (!looping) {
      return <div className="h-full w-full bg-backdrop" aria-busy="true" />
    }

    const store = safeStore()
    const count = store ? crashCount(store, Date.now()) : 0

    return (
      <div className="grid h-full w-full place-items-center bg-backdrop p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-destructive/40 bg-card p-5">
          <div className="space-y-1.5">
            <h1 className="text-base font-semibold">The shell keeps stopping</h1>
            <p className="text-sm text-muted-foreground">
              {count > 1
                ? `It restarted itself ${count - 1} time${count - 1 === 1 ? "" : "s"} and hit the same problem, so it has stopped trying.`
                : "It could not restart itself, so it has stopped rather than risk a reload loop."}{" "}
              The desktop is still running: reloading picks it up where it was.
            </p>
          </div>

          {/*
            * Shown outright, not behind a details toggle. On a device with no
            * developer tools this is the only record of what happened, and it
            * is the thing worth quoting when reporting it.
            */}
          <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>

          <div className="flex gap-2">
            <button
              type="button"
              className="h-11 flex-1 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
              onClick={() => {
                // Cleared first, or the reload lands with the count still over
                // the limit and stops again immediately.
                const s = safeStore()
                if (s) clearCrashes(s)
                globalThis.location.reload()
              }}
            >
              Reload
            </button>
            <button
              type="button"
              className="h-11 rounded-lg border px-4 text-sm"
              // Worth offering before a reload: the tree is rebuilt from
              // current state, and a passing inconsistency comes back without
              // losing the session at all.
              onClick={() => this.setState({ error: null, looping: false })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}

/**
 * Record errors React will not route through a boundary.
 *
 * These never took the page down, but they are how a stream quietly stops or a
 * message handler gives up, and until now they went only to a console nobody
 * on a tablet can open.
 */
export function watchGlobalErrors(): void {
  globalThis.addEventListener("error", (event) => {
    log("error", `uncaught: ${event.message}`)
  })
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason
    log("error", `unhandled: ${reason instanceof Error ? reason.message : String(reason)}`)
  })
}
