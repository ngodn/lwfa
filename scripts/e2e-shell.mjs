#!/usr/bin/env node
/**
 * End-to-end check of the shell protocol.
 *
 * Connects to a running engine as a headless shell, drives the real strip
 * layout from `packages/shell`, and asserts the engine does what it is told.
 *
 * Deliberately not a browser test. What needs proving here is the protocol
 * loop and the layout policy, and both are pure logic; putting a browser in the
 * way would make this slower and flakier without testing anything extra.
 * Rendering is verified separately by screenshotting the compositor.
 *
 * Usage: node scripts/e2e-shell.mjs [ws://host:port]
 * Exits non-zero on the first failed expectation.
 */

import {
  DEFAULT_CONFIG,
  EMPTY,
  addWindow,
  focusLeft,
  focusRight,
  focusedWindow,
  layout,
  removeWindow,
} from "../packages/shell/src/strip.ts"
import { PROTOCOL_VERSION, decodeToShell, encode } from "../packages/proto/src/index.ts"

const URL = process.argv[2] ?? "ws://127.0.0.1:9843"
const TIMEOUT_MS = 15_000

let failures = 0
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}

const socket = new WebSocket(URL)
const inbox = []
const waiters = []

socket.addEventListener("message", (event) => {
  let message
  try {
    message = decodeToShell(event.data)
  } catch (err) {
    console.log(`  FAIL  engine sent something undecodable: ${err.message}`)
    failures++
    return
  }
  inbox.push(message)
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(message)) {
      waiters[i].resolve(message)
      waiters.splice(i, 1)
    }
  }
})

/** Wait for a message matching `match`, checking anything already received. */
function expect(match, what) {
  const existing = inbox.find(match)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${what}`))
    }, TIMEOUT_MS)
    waiters.push({
      match,
      resolve: (m) => {
        clearTimeout(timer)
        resolve(m)
      },
    })
  })
}

const send = (message) => socket.send(encode(message))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${URL}`)))
  })

  // --- handshake -----------------------------------------------------------
  const hello = await expect((m) => m.type === "hello", "hello")
  check(hello.protocolVersion === PROTOCOL_VERSION, "engine speaks our protocol version",
    `engine ${hello.protocolVersion}, shell ${PROTOCOL_VERSION}`)
  check(hello.output.width > 0 && hello.output.height > 0, "hello carries a real viewport",
    `${hello.output.width}x${hello.output.height}`)

  const output = { width: hello.output.width, height: hello.output.height }
  let strip = hello.windows.reduce((s, w) => addWindow(s, w.id, output, DEFAULT_CONFIG), EMPTY)
  check(hello.windows.length >= 1, "engine already had at least one window", `${hello.windows.length}`)

  const push = (animate = true) => {
    send({
      type: "setLayout",
      windows: layout(strip, output, DEFAULT_CONFIG),
      animate: animate ? { spring: { stiffness: 220, damping: 26, mass: 1 } } : null,
    })
  }
  push(false)

  // --- the engine obeys layout --------------------------------------------
  // Nothing echoes a layout back, so this is verified by consequence: spawn a
  // window, and the engine must report it and accept placement without error.
  const before = strip.columns.length
  send({ type: "spawn", command: process.env.LWFA_TERMINAL ?? "alacritty" })

  const opened = await expect((m) => m.type === "windowOpened", "windowOpened after spawn")
  check(true, "spawn produced a window", `w${opened.window.id}`)

  strip = addWindow(strip, opened.window.id, output, DEFAULT_CONFIG)
  check(strip.columns.length === before + 1, "shell tracked the new column",
    `${before} -> ${strip.columns.length}`)
  check(focusedWindow(strip) === opened.window.id, "new window took focus")
  push()

  // The strip should have scrolled to reveal the new column.
  const placed = layout(strip, output, DEFAULT_CONFIG)
  check(placed.length === strip.columns.length, "every column is in the layout")
  const last = placed[placed.length - 1]
  check(
    last.rect.x + last.rect.width <= output.width - DEFAULT_CONFIG.gap + 1,
    "focused column is fully on screen",
    `right edge ${Math.round(last.rect.x + last.rect.width)} vs viewport ${output.width}`,
  )
  if (placed.length > 1) {
    check(placed[0].rect.x < placed[1].rect.x, "columns are ordered left to right")
  }

  // --- titles reach the shell ---------------------------------------------
  const named = await expect(
    (m) => m.type === "windowChanged" && (m.window.title || m.window.appId),
    "windowChanged carrying a title or appId",
  ).catch(() => null)
  check(named !== null, "engine reports window titles",
    named ? `${named.window.appId ?? "?"} / ${named.window.title ?? "?"}` : "none arrived")

  // --- focus round trip ----------------------------------------------------
  if (strip.columns.length >= 2) {
    strip = focusLeft(strip, output, DEFAULT_CONFIG)
    const target = focusedWindow(strip)
    send({ type: "focusWindow", id: target })
    push()
    await sleep(300)
    // The engine must not echo a focus it was told to make, or the shell would
    // loop. Nothing arriving is the pass condition here.
    const echoed = inbox.filter((m) => m.type === "focusChanged" && m.id === target)
    check(echoed.length === 0, "engine does not echo shell-initiated focus",
      `${echoed.length} echoes`)

    strip = focusRight(strip, output, DEFAULT_CONFIG)
    push()
  }

  // --- closing -------------------------------------------------------------
  const victim = opened.window.id
  send({ type: "closeWindow", id: victim })
  const closed = await expect(
    (m) => m.type === "windowClosed" && m.id === victim,
    `windowClosed for w${victim}`,
  ).catch(() => null)
  check(closed !== null, "closeWindow actually closes the window")

  if (closed) {
    strip = removeWindow(strip, victim, output, DEFAULT_CONFIG)
    check(!strip.columns.includes(victim), "shell dropped the closed column")
    push()
  }

  // --- the engine is still alive ------------------------------------------
  send({ type: "setLayout", windows: layout(strip, output, DEFAULT_CONFIG), animate: null })
  await sleep(200)
  check(socket.readyState === WebSocket.OPEN, "connection survived the whole exchange")

  socket.close()
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(`\nERROR: ${err.message}`)
    process.exit(1)
  })
