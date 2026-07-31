/**
 * The shell.
 *
 * Owns layout policy and drives the engine. What it renders here is a control
 * surface, not the desktop: in milestone 3 the windows are still composited
 * natively and shown on the engine's own output. The browser starts compositing
 * window pixels in milestone 4, when per-surface streams arrive.
 *
 * So this page is deliberately a debug view of the strip. The chrome that will
 * eventually sit over the real windows is a later milestone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ToShell, WindowId, WindowInfo } from "@lwfa/proto"
import { Connection, type Status } from "./connection.js"
import {
  DEFAULT_CONFIG,
  EMPTY,
  type Output,
  type StripState,
  addWindow,
  columnWidth,
  focusLeft,
  focusRight,
  focusWindow,
  focusedWindow,
  layout,
  reflow,
  removeWindow,
} from "./strip.js"

/**
 * Spring for strip scrolling. Quick, with a touch of overshoot so it reads as
 * physical. The engine integrates it; this only names it.
 */
const SCROLL_SPRING = { stiffness: 220, damping: 26, mass: 1 }

const ENGINE_URL =
  new URLSearchParams(location.search).get("engine") ??
  `ws://${location.hostname || "localhost"}:9843`

export function App(): React.ReactElement {
  const [status, setStatus] = useState<Status>("connecting")
  const [statusDetail, setStatusDetail] = useState<string>()
  const [output, setOutput] = useState<Output>({ width: 0, height: 0 })
  const [windows, setWindows] = useState<Map<WindowId, WindowInfo>>(new Map())
  const [strip, setStrip] = useState<StripState>(EMPTY)

  const connection = useRef<Connection | null>(null)
  // Refs so the message handler, which is created once, always reads current
  // values instead of the ones captured when the socket opened.
  const stripRef = useRef(strip)
  const outputRef = useRef(output)
  stripRef.current = strip
  outputRef.current = output

  /** Push the current strip to the engine as a target plus a spring. */
  const push = useCallback((next: StripState, out: Output, animate = true) => {
    const windows = layout(next, out, DEFAULT_CONFIG)
    connection.current?.send({
      type: "setLayout",
      windows,
      animate: animate ? { spring: SCROLL_SPRING } : null,
    })
    const focused = focusedWindow(next)
    if (focused !== null) {
      connection.current?.send({ type: "focusWindow", id: focused })
    }
  }, [])

  const update = useCallback(
    (fn: (state: StripState, out: Output) => StripState, animate = true) => {
      const out = outputRef.current
      const next = fn(stripRef.current, out)
      stripRef.current = next
      setStrip(next)
      push(next, out, animate)
    },
    [push],
  )

  useEffect(() => {
    const handleMessage = (message: ToShell) => {
      switch (message.type) {
        case "hello": {
          const out = { width: message.output.width, height: message.output.height }
          outputRef.current = out
          setOutput(out)
          setWindows(new Map(message.windows.map((w) => [w.id, w])))

          // Rebuild the strip from the engine's view of the world rather than
          // trusting whatever this page had before. A reconnecting shell must
          // resync, not resurrect a stale layout.
          let next = message.windows.reduce(
            (state, w) => addWindow(state, w.id, out, DEFAULT_CONFIG),
            EMPTY,
          )
          if (message.focused !== null) {
            next = focusWindow(next, message.focused, out, DEFAULT_CONFIG)
          }
          stripRef.current = next
          setStrip(next)
          // No animation on resync: windows should appear in place, not fly in.
          push(next, out, false)
          break
        }

        case "outputChanged": {
          const out = { width: message.output.width, height: message.output.height }
          outputRef.current = out
          setOutput(out)
          update((state) => reflow(state, out, DEFAULT_CONFIG), false)
          break
        }

        case "windowOpened":
          setWindows((prev) => new Map(prev).set(message.window.id, message.window))
          update((state, out) => addWindow(state, message.window.id, out, DEFAULT_CONFIG))
          break

        case "windowChanged":
          setWindows((prev) => new Map(prev).set(message.window.id, message.window))
          break

        case "windowClosed":
          setWindows((prev) => {
            const next = new Map(prev)
            next.delete(message.id)
            return next
          })
          update((state, out) => removeWindow(state, message.id, out, DEFAULT_CONFIG))
          break

        case "focusChanged":
          // The engine tells us only about focus changes it did not get from
          // us (a click, or a window closing), so follow it.
          if (message.id !== null) {
            update((state, out) => focusWindow(state, message.id!, out, DEFAULT_CONFIG))
          }
          break

        case "keyBinding": {
          // Focus order is layout policy, which is why the engine forwards
          // these instead of acting on them.
          const { key } = message
          if (key === "h" || key === "Left") update(focusLeftAt)
          else if (key === "l" || key === "Right") update(focusRightAt)
          else if (key === "w") {
            const focused = focusedWindow(stripRef.current)
            if (focused !== null) connection.current?.send({ type: "closeWindow", id: focused })
          }
          break
        }
      }
    }

    const conn = new Connection(ENGINE_URL, {
      onMessage: handleMessage,
      onStatus: (s, detail) => {
        setStatus(s)
        setStatusDetail(detail)
      },
    })
    connection.current = conn
    conn.connect()
    return () => {
      conn.close()
      connection.current = null
    }
  }, [push, update])

  const width = output.width > 0 ? columnWidth(output, DEFAULT_CONFIG) : 0
  const placed = useMemo(
    () => (output.width > 0 ? layout(strip, output, DEFAULT_CONFIG) : []),
    [strip, output],
  )

  return (
    <main>
      <header>
        <h1>lwfa shell</h1>
        <p className={`status status-${status}`}>
          {status}
          {statusDetail ? `: ${statusDetail}` : ""} · <code>{ENGINE_URL}</code>
        </p>
      </header>

      <section>
        <h2>Viewport</h2>
        <p>
          {output.width} × {output.height} · column width {width} · offset{" "}
          {Math.round(strip.viewOffset)}
        </p>
      </section>

      <section>
        <h2>Strip ({strip.columns.length})</h2>
        <div className="controls">
          <button onClick={() => update(focusLeftAt)} disabled={strip.focus === 0}>
            ← focus left
          </button>
          <button
            onClick={() => update(focusRightAt)}
            disabled={strip.focus >= strip.columns.length - 1}
          >
            focus right →
          </button>
          <button onClick={() => connection.current?.send({ type: "spawn", command: "alacritty" })}>
            spawn terminal
          </button>
        </div>

        <ol className="columns">
          {strip.columns.map((id, index) => {
            const info = windows.get(id)
            const rect = placed[index]?.rect
            return (
              <li key={id} className={index === strip.focus ? "focused" : undefined}>
                <button className="pick" onClick={() => update((s, o) => focusWindow(s, id, o, DEFAULT_CONFIG))}>
                  <span className="id">w{id}</span>
                  <span className="title">{info?.title ?? info?.appId ?? "(untitled)"}</span>
                  {rect ? (
                    <span className="rect">
                      x {Math.round(rect.x)} · {Math.round(rect.width)}×{Math.round(rect.height)}
                    </span>
                  ) : null}
                </button>
                <button
                  className="close"
                  onClick={() => connection.current?.send({ type: "closeWindow", id })}
                  aria-label={`close window ${id}`}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ol>
        {strip.columns.length === 0 ? <p className="empty">No windows yet.</p> : null}
      </section>

      {/* A to-scale preview of where the engine has been told to put things.
          Useful for spotting a layout bug without switching workspaces. */}
      <section>
        <h2>Preview</h2>
        <div className="viewport" style={{ aspectRatio: `${output.width || 16} / ${output.height || 9}` }}>
          {placed.map((w, index) => (
            <div
              key={w.id}
              className={`preview-window${index === strip.focus ? " focused" : ""}`}
              style={{
                left: `${(w.rect.x / (output.width || 1)) * 100}%`,
                top: `${(w.rect.y / (output.height || 1)) * 100}%`,
                width: `${(w.rect.width / (output.width || 1)) * 100}%`,
                height: `${(w.rect.height / (output.height || 1)) * 100}%`,
              }}
            >
              w{w.id}
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

// Declared outside the component so `update` gets a stable reference.
const focusLeftAt = (state: StripState, out: Output) => focusLeft(state, out, DEFAULT_CONFIG)
const focusRightAt = (state: StripState, out: Output) => focusRight(state, out, DEFAULT_CONFIG)
