#!/usr/bin/env node
/**
 * End-to-end check of audio capture.
 *
 * Connects as a headless shell, asks to hear the machine, and verifies that
 * real PCM arrives: the right rate, the right chunk size, at roughly real time,
 * and stopping when nobody is listening any more.
 *
 * It deliberately does not check that the audio contains anything: a silent
 * machine is a valid machine, and asserting on loudness would make this test
 * fail depending on whether music happened to be playing.
 *
 * Connects as a *follower* if another shell is already driving, which is
 * exactly what a check like this should be: it must not take the wheel from a
 * device somebody is using.
 *
 * Usage: node --experimental-strip-types scripts/e2e-audio.mjs [ws://host:port]
 */

import { readFileSync } from "node:fs"
import { decodeAudio, encode } from "../packages/proto/src/index.ts"

function authPass() {
  if (process.env.AUTH_PASS) return process.env.AUTH_PASS
  try {
    const file = readFileSync(new global.URL("../.env", import.meta.url), "utf8")
    for (const line of file.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const at = trimmed.indexOf("=")
      if (at === -1) continue
      if (trimmed.slice(0, at).trim() !== "AUTH_PASS") continue
      return trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, "")
    }
  } catch {
    // No .env is fine; the engine may have generated a token instead.
  }
  return ""
}

const TOKEN = authPass()
const URL =
  process.argv[2] ??
  `ws://127.0.0.1:6734${TOKEN ? `?token=${encodeURIComponent(TOKEN)}&device=audio-check` : ""}`

let failures = 0
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const socket = new WebSocket(URL)
socket.binaryType = "arraybuffer"

const chunks = []
let malformed = 0
let videoFrames = 0

socket.addEventListener("message", (event) => {
  if (!(event.data instanceof ArrayBuffer)) return
  const audio = decodeAudio(event.data)
  if (audio) {
    chunks.push({ at: Date.now(), header: audio.header, bytes: audio.payload.byteLength })
    return
  }
  // Not audio. Video shares this socket, and telling them apart by magic is
  // the thing being relied on, so count rather than ignore.
  if (event.data.byteLength >= 4) videoFrames++
  else malformed++
})

socket.addEventListener("error", (err) => {
  console.error("socket error:", err.message ?? err)
  process.exit(1)
})

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("close", () => reject(new Error("closed during handshake")), {
    once: true,
  })
})

console.log("audio end-to-end\n")

// Nothing should arrive before it is asked for.
await sleep(600)
check(chunks.length === 0, "silent until asked", `${chunks.length} chunks`)

socket.send(encode({ type: "setAudio", enabled: true, local: false }))
await sleep(1500)

const heard = chunks.length
check(heard > 0, "audio arrives once asked for", `${heard} chunks`)

if (heard > 0) {
  const { header } = chunks[0]
  check(header.sampleRate === 48000, "sample rate is 48kHz", `${header.sampleRate}`)
  check(header.channels === 2, "stereo", `${header.channels} channels`)
  check(header.frames === 960, "20ms chunks", `${header.frames} frames`)

  const consistent = chunks.every(
    (c) => c.bytes === c.header.frames * c.header.channels * 2,
  )
  check(consistent, "payload length matches the header")

  // Roughly real time. Not exactly, because the first chunk arrives whenever
  // capture starts, so this measures the interval between chunks rather than
  // the total.
  const span = chunks.at(-1).at - chunks[0].at
  const expected = (chunks.length - 1) * 20
  const drift = span === 0 ? 0 : Math.abs(span - expected) / expected
  check(drift < 0.35, "arrives at roughly real time", `${span}ms for ${expected}ms of audio`)
}

check(malformed === 0, "no malformed binary messages")

// The machine should have grown a private audio device, and should not be
// playing any of this aloud.
const { execSync } = await import("node:child_process")
const sinks = execSync("pactl list short sinks", { encoding: "utf8" })
check(sinks.includes("lwfa"), "a private audio sink exists for the session")
const modules = execSync("pactl list short modules", { encoding: "utf8" })
check(
  !modules.includes("module-loopback"),
  "nothing is looping session audio to the speakers",
)
console.log(`  note  ${videoFrames} video frame(s) seen on the same socket`)

// And it stops.
socket.send(encode({ type: "setAudio", enabled: false, local: false }))
await sleep(400)
const before = chunks.length
await sleep(800)
check(chunks.length === before, "stops when nobody is listening", `${chunks.length - before} after`)

socket.close()
console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
