#!/usr/bin/env node
// Inject ONLY into an explicitly supplied separate development engine.
// Requires PROTON_DIR, DEV_AUTH_PASS, DEV_GAMEPAD_EVENT, DEV_XINPUT_SLOT.
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { waitForOpen } from "./websocket-open.mjs"

assert(process.env.DEV_AUTH_PASS, "DEV_AUTH_PASS is required")
assert(process.env.DEV_GAMEPAD_EVENT, "DEV_GAMEPAD_EVENT is required")
const targetSlot = Number(process.env.DEV_XINPUT_SLOT)
assert(Number.isInteger(targetSlot) && targetSlot >= 0 && targetSlot < 4, "DEV_XINPUT_SLOT must identify the isolated pad")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const states = []
const kernel = []
let ready = false
let done
let helperError
let fd
let timer
let socket
const helper = spawn("bash", [new URL("./xinput-probe.sh", import.meta.url).pathname, "18", "1"], {
  env: process.env, stdio: ["ignore", "pipe", "pipe"],
})
const exited = new Promise((resolve) => helper.once("exit", (code) => { helperError ??= code ? `probe exited ${code}` : undefined; resolve() }))
let text = ""
helper.stdout.on("data", (bytes) => {
  text += bytes
  for (;;) {
    const newline = text.indexOf("\n")
    if (newline < 0) break
    const line = text.slice(0, newline).trim()
    text = text.slice(newline + 1)
    if (!line.startsWith("{")) continue
    const message = JSON.parse(line)
    if (message.type === "state") states.push(message)
    if (message.type === "ready") ready = true
    if (message.type === "done") done = message
  }
})
helper.stderr.on("data", (bytes) => process.stderr.write(bytes))
const summaries = []
try {
  for (let i = 0; !ready && !helperError && i < 1200; i++) await sleep(50)
  assert(ready, helperError ?? "XInput probe did not become ready")
  assert(states.some((s) => s.slot === targetSlot && s.status === 0), "target XInput slot must be connected")
  fd = fs.openSync(process.env.DEV_GAMEPAD_EVENT, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  const buffer = Buffer.alloc(24 * 128)
  const drain = () => {
    for (;;) {
      let n
      try { n = fs.readSync(fd, buffer) } catch (error) { if (error.code === "EAGAIN") return; throw error }
      if (!n) return
      for (let i = 0; i < n; i += 24) {
        if (buffer.readUInt16LE(i + 16) === 1 && buffer.readUInt16LE(i + 18) === 304) {
          kernel.push({ time_us: Number(buffer.readBigInt64LE(i)) * 1e6 + Number(buffer.readBigInt64LE(i + 8)), pressed: buffer.readInt32LE(i + 20) === 1 })
        }
      }
    }
  }
  timer = setInterval(drain, 1)
  const url = new URL("ws://127.0.0.1:6734/")
  url.searchParams.set("token", process.env.DEV_AUTH_PASS)
  url.searchParams.set("device", "isolated-xinput-probe")
  socket = new WebSocket(url)
  let hello = false
  socket.addEventListener("message", ({ data }) => { if (typeof data === "string" && JSON.parse(data).type === "hello") hello = true })
  await waitForOpen(socket)
  for (let i = 0; !hello && i < 100; i++) await sleep(20)
  assert(hello, "dev handshake failed")
  const send = (message) => socket.send(JSON.stringify(message))
  send({ type: "setGamepad", enabled: true })
  await sleep(200)
  for (const hold of [100, 8, 16, 24, 50, 0]) {
    const firstKernel = kernel.length
    const firstState = states.length
    for (let i = 0; i < 10; i++) {
      send({ type: "gamepadButton", button: 0, pressed: true })
      if (hold) await sleep(hold)
      send({ type: "gamepadButton", button: 0, pressed: false })
      await sleep(50)
    }
    await sleep(200)
    drain()
    const edges = kernel.slice(firstKernel)
    const observed = states.slice(firstState)
    assert(observed.every((s) => s.slot === targetSlot || s.buttons === 0), "input changed on another slot")
    assert.equal(edges.filter((e) => e.pressed).length, 10, "every dev press reached evdev")
    assert.equal(edges.filter((e) => !e.pressed).length, 10, "every dev release reached evdev")
    const held = edges.filter((e) => e.pressed).map((e) => edges.find((r) => !r.pressed && r.time_us >= e.time_us).time_us - e.time_us)
    const seenDown = observed.filter((s) => s.slot === targetSlot && (s.buttons & 4096)).length
    if (hold === 100) assert.equal(seenDown, 10, "ordinary holds reached XInput")
    summaries.push({ hold_ms: hold, injected: 10, evdev_down: 10, xinput_down: seenDown, evdev_min_hold_us: Math.min(...held), evdev_max_hold_us: Math.max(...held) })
  }
  send({ type: "gamepadButton", button: 0, pressed: false })
  socket.close()
  await exited
  assert(!helperError, helperError)
  assert(done, "probe ended without summary")
  console.log(JSON.stringify({ slots: states.filter((s) => s.status === 0).map((s) => s.slot).filter((s, i, a) => a.indexOf(s) === i), summaries, polls: done.polls, max_gap_us: done.max_gap_us }, null, 2))
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "gamepadButton", button: 0, pressed: false }))
  socket?.close()
  clearInterval(timer)
  if (fd !== undefined) fs.closeSync(fd)
  if (helper.exitCode === null) helper.kill("SIGTERM")
  await exited
}
