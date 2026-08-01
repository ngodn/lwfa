#!/usr/bin/env node
/**
 * End-to-end check of per-surface streaming.
 *
 * Connects as a headless shell, asks for pixels, and verifies real frames
 * arrive and are decodable images of the right size. Also checks the two
 * properties the design depends on: that streams are per window (not one
 * screen capture), and that an idle window stops costing anything.
 *
 * Writes the first frame of each window to target/ so the pixels can be
 * eyeballed rather than only counted.
 *
 * Usage: node --experimental-strip-types scripts/e2e-stream.mjs [ws://host:port]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import {
  DEFAULT_CONFIG,
  EMPTY,
  addWindow,
  layout,
} from "../packages/shell/src/strip.ts"
import { FrameFormat, decodeFrame, decodeToShell, encode } from "../packages/proto/src/index.ts"

// The engine requires a token. Tests set LWFA_SHELL_TOKEN when launching it
// so both sides agree; see scripts/dev-nested.sh.
const TOKEN = process.env.LWFA_SHELL_TOKEN ?? ""
const URL =
  process.argv[2] ?? `ws://127.0.0.1:9843${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`
const OUT = new global.URL("../target/stream-frames", import.meta.url).pathname

let failures = 0
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const socket = new WebSocket(URL)
socket.binaryType = "arraybuffer"

let output = { width: 0, height: 0 }
let strip = EMPTY
/** windowId -> {count, bytes, first} */
const received = new Map()
let badFrames = 0

const send = (m) => socket.send(encode(m))

function push(streams = true) {
  const windows = layout(strip, output, DEFAULT_CONFIG)
  send({ type: "setLayout", windows, animate: null })
  send({ type: "setStreams", windows: streams ? windows.map((w) => w.id) : [] })
}

socket.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer) {
    const frame = decodeFrame(event.data)
    if (!frame) {
      badFrames++
      return
    }
    const entry =
      received.get(frame.header.window) ??
      { count: 0, bytes: 0, first: null, header: null, keyframes: 0 }
    entry.count++
    entry.bytes += frame.payload.byteLength
    entry.header = frame.header
    if (frame.header.keyframe) entry.keyframes++
    if (!entry.first) entry.first = Buffer.from(frame.payload)
    received.set(frame.header.window, entry)
    return
  }

  const m = decodeToShell(event.data)
  if (m.type === "hello") {
    output = { width: m.output.width, height: m.output.height }
    strip = m.windows.reduce((s, w) => addWindow(s, w.id, output, DEFAULT_CONFIG), EMPTY)
    push()
    // A second window, so "per surface" can actually be distinguished from
    // "one screen capture that happens to be window-shaped".
    send({ type: "spawn", command: process.env.LWFA_TERMINAL ?? "alacritty" })
  }
  if (m.type === "windowOpened") {
    strip = addWindow(strip, m.window.id, output, DEFAULT_CONFIG)
    push()
  }
})

async function main() {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${URL}`)))
  })

  await sleep(7000)

  check(received.size > 0, "frames arrived at all", `${received.size} window(s)`)
  check(badFrames === 0, "every binary frame decoded", `${badFrames} bad`)
  check(
    received.size >= 2,
    "streams are per window, not one screen capture",
    `distinct window ids: ${[...received.keys()].join(", ")}`,
  )

  mkdirSync(OUT, { recursive: true })
  for (const [id, entry] of received) {
    const fmt = entry.header.format
    if (fmt === FrameFormat.H264) {
      // Annex B start code. Proves the payload is a real elementary stream
      // rather than framing debris or an AVCC-boxed frame the browser could
      // not configure itself from.
      const p = entry.first
      const annexB =
        (p[0] === 0 && p[1] === 0 && p[2] === 1) ||
        (p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 1)
      check(annexB, `w${id} payload is Annex B H.264`, `first bytes ${[...p.subarray(0, 5)].join(" ")}`)

      // NAL type 7 is SPS. It must be present in the first keyframe or a
      // browser attaching mid-stream cannot configure its decoder.
      const hasSps = [...p.subarray(0, 64)].some((b, i, a) =>
        i >= 3 && a[i - 3] === 0 && a[i - 2] === 0 && a[i - 1] === 1 && (b & 0x1f) === 7,
      )
      check(hasSps, `w${id} first frame carries SPS`, hasSps ? "in-band" : "missing")
      check(entry.keyframes > 0, `w${id} sent at least one keyframe`, `${entry.keyframes}`)
    } else {
      const isJpeg = entry.first[0] === 0xff && entry.first[1] === 0xd8
      check(isJpeg, `w${id} payload is a JPEG (fallback path)`, `first bytes ${entry.first[0].toString(16)} ${entry.first[1].toString(16)}`)
    }

    const expected = layout(strip, output, DEFAULT_CONFIG).find((w) => w.id === id)
    if (expected) {
      check(
        entry.header.width === Math.round(expected.rect.width),
        `w${id} frame width matches the layout`,
        `frame ${entry.header.width} vs layout ${Math.round(expected.rect.width)}`,
      )
    }

    const ext = fmt === FrameFormat.H264 ? "h264" : "jpg"
    const path = `${OUT}/window-${id}.${ext}`
    writeFileSync(path, entry.first)
    const perFrame = entry.bytes / entry.count / 1024
    console.log(
      `        w${id}: ${fmt === FrameFormat.H264 ? "H.264" : "JPEG"}, ${entry.count} frames, ` +
        `${perFrame.toFixed(1)} KB/frame, ${entry.header.width}x${entry.header.height} -> ${path}`,
    )
  }

  // Idle windows must stop costing anything. Nothing is typing into these
  // terminals, so the damage tracking should have gone quiet.
  const before = [...received.values()].reduce((n, e) => n + e.count, 0)
  await sleep(3000)
  const after = [...received.values()].reduce((n, e) => n + e.count, 0)
  check(
    after - before <= 2,
    "idle windows stop being captured",
    `${after - before} frames in 3s while idle`,
  )

  // Turning streams off must actually stop the flow.
  push(false)
  await sleep(500)
  const quiet = [...received.values()].reduce((n, e) => n + e.count, 0)
  await sleep(2000)
  const stillQuiet = [...received.values()].reduce((n, e) => n + e.count, 0)
  check(stillQuiet === quiet, "setStreams:[] stops the stream", `${stillQuiet - quiet} frames after`)

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
