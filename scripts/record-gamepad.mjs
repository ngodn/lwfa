#!/usr/bin/env node
// Passive evdev trace for correlation with the browser's controller recording.
import fs from "node:fs"
import { endianness } from "node:os"
import { pathToFileURL } from "node:url"

const EVENT_BYTES = 24
const MAX_EVENTS = 100_000

export function limits(seconds = "30", count = "50000") {
  const duration = Number(seconds)
  const maxEvents = Number(count)
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 120) throw new Error("Duration must be 0.1 to 120 seconds")
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_EVENTS) throw new Error("Event limit must be 1 to 100000")
  return { duration, maxEvents }
}

/** Parse the 64-bit little-endian Linux input_event ABI, retaining edge times. */
export function decodeEvents(bytes, observedMonotonicUs, remaining) {
  if (bytes.length % EVENT_BYTES) throw new Error("Partial input_event record")
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > MAX_EVENTS) throw new Error("Invalid remaining event capacity")
  const events = []
  for (let at = 0; at < bytes.length && events.length < remaining; at += EVENT_BYTES) {
    const seconds = bytes.readBigInt64LE(at)
    const micros = bytes.readBigInt64LE(at + 8)
    events.push({
      kernelTimeUs: (seconds * 1_000_000n + micros).toString(),
      observedMonotonicUs: String(observedMonotonicUs),
      type: bytes.readUInt16LE(at + 16),
      code: bytes.readUInt16LE(at + 18),
      value: bytes.readInt32LE(at + 20),
    })
  }
  return events
}

export function validateDeviceName(name) {
  if (name.trim() !== "lwfa virtual controller") throw new Error("Refusing to record a device other than lwfa virtual controller")
}

async function main() {
  const [device, seconds, count, extra] = process.argv.slice(2)
  if (!device || extra || !/^\/dev\/input\/event\d+$/.test(device)) throw new Error("Usage: node scripts/record-gamepad.mjs /dev/input/eventN [seconds=30] [maxEvents=50000]")
  if (process.platform !== "linux" || endianness() !== "LE" || !["x64", "arm64"].includes(process.arch)) throw new Error("This recorder supports little-endian 64-bit Linux x64/arm64 only")
  const { duration, maxEvents } = limits(seconds, count)
  validateDeviceName(fs.readFileSync(`/sys/class/input/${device.split("/").at(-1)}/device/name`, "utf8"))
  if (!fs.lstatSync(device).isCharacterDevice()) throw new Error("Expected an actual evdev character device")
  const fd = fs.openSync(device, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  let reason = "duration"
  let interrupted = false
  const interrupt = () => { interrupted = true }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  try {
    // Validate the opened handle too, before reading any possible input.
    const stat = fs.fstatSync(fd, { bigint: true })
    const major = ((stat.rdev >> 8n) & 0xfffn) | ((stat.rdev >> 32n) & 0xfffff000n)
    const minor = (stat.rdev & 0xffn) | ((stat.rdev >> 12n) & 0xffffff00n)
    validateDeviceName(fs.readFileSync(`/sys/dev/char/${major}:${minor}/device/name`, "utf8"))
    const start = process.hrtime.bigint()
    const startedAt = new Date().toISOString()
    const deadline = start + BigInt(Math.round(duration * 1e9))
    const events = []
    const buffer = Buffer.alloc(EVENT_BYTES * 128)
    console.error(`Recording ${device} for up to ${duration}s or ${maxEvents} events. Ctrl-C saves early.`)
    while (!interrupted && process.hrtime.bigint() < deadline && events.length < maxEvents) {
      let size
      try { size = fs.readSync(fd, buffer) } catch (error) {
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
          await new Promise((resolve) => setTimeout(resolve, 4))
          continue
        }
        if (error.code === "ENODEV") { reason = "disconnected"; break }
        throw error
      }
      if (!size) { reason = "eof"; break }
      events.push(...decodeEvents(buffer.subarray(0, size), process.hrtime.bigint() / 1000n, maxEvents - events.length))
    }
    if (interrupted) reason = "interrupted"
    else if (events.length === maxEvents) reason = "eventLimit"
    console.log(JSON.stringify({
      version: 1, device, name: "lwfa virtual controller", startedAt,
      startedMonotonicUs: (start / 1000n).toString(),
      endedMonotonicUs: (process.hrtime.bigint() / 1000n).toString(),
      kernelClock: "evdev default CLOCK_REALTIME (no clock-changing ioctl)",
      requestedSeconds: duration, maxEvents, reason,
      synDropped: events.filter((event) => event.type === 0 && event.code === 3).length,
      events,
    }))
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    fs.closeSync(fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
