/**
 * Shell protocol parity: TypeScript against the Rust implementation.
 *
 * Same reasoning as the spring parity test. Two implementations of one wire
 * format drift silently, and the symptom here is not a crash but windows going
 * to the wrong place, or losing their titles, with no error logged anywhere.
 *
 * Direction 1 (Rust to TS): every fixture in `fixtures/proto/` is produced by
 * `cargo run -p lwfa-proto --bin gen-proto-fixtures` and must decode cleanly.
 *
 * Direction 2 (TS to Rust): each decoded message is re-encoded into
 * `fixtures/proto-from-ts/`, which `crates/lwfa-proto/tests/from_ts.rs` then
 * deserialises and compares against its own canonical values. `pnpm run
 * test:all` sequences the two.
 *
 * Both directions are needed. Direction 1 alone would pass if TS were
 * permissive; direction 2 alone would pass if TS emitted a shape Rust happens
 * to accept but never produces.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  PROTOCOL_VERSION,
  ProtocolError,
  decodeToEngine,
  decodeToShell,
  encode,
  type ToEngine,
  type ToShell,
} from "../src/index.js"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
const fixtureDir = `${repoRoot}fixtures/proto`
const outDir = `${repoRoot}fixtures/proto-from-ts`

function fixtures(direction: "to-shell" | "to-engine"): { name: string; json: string }[] {
  let names: string[]
  try {
    names = readdirSync(`${fixtureDir}/${direction}`).filter((f) => f.endsWith(".json"))
  } catch {
    throw new Error(
      `fixtures/proto/${direction} is missing. Run: cargo run -p lwfa-proto --bin gen-proto-fixtures`,
    )
  }
  if (names.length === 0) throw new Error(`no fixtures in fixtures/proto/${direction}`)
  return names.sort().map((name) => ({
    name: name.replace(/\.json$/, ""),
    json: readFileSync(`${fixtureDir}/${direction}/${name}`, "utf8"),
  }))
}

function emit(direction: string, name: string, message: ToShell | ToEngine): void {
  mkdirSync(`${outDir}/${direction}`, { recursive: true })
  writeFileSync(`${outDir}/${direction}/${name}.json`, encode(message))
}

const toShell = fixtures("to-shell")
const toEngine = fixtures("to-engine")

describe("protocol version", () => {
  it("matches the Rust constant", () => {
    // Read out of the Rust source rather than duplicated by hand, so bumping
    // one side without the other fails here instead of at runtime.
    const src = readFileSync(`${repoRoot}crates/lwfa-proto/src/lib.rs`, "utf8")
    const match = src.match(/pub const PROTOCOL_VERSION: u32 = (\d+);/)
    expect(match, "could not find PROTOCOL_VERSION in the Rust source").not.toBeNull()
    expect(PROTOCOL_VERSION).toBe(Number(match![1]))
  })
})

describe("engine to shell", () => {
  it.each(toShell)("decodes $name", ({ name, json }) => {
    const message = decodeToShell(json)

    // Re-encoding and decoding again must be a fixed point. Catches a decoder
    // that drops a field it never reads.
    expect(decodeToShell(encode(message))).toEqual(message)

    emit("to-shell", name, message)
  })

  it("decodes every field of hello rather than just the ones it reads", () => {
    const hello = decodeToShell(readFileSync(`${fixtureDir}/to-shell/hello.json`, "utf8"))
    expect(hello.type).toBe("hello")
    if (hello.type !== "hello") return
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(hello.output).toEqual({ width: 1920, height: 1080, scale: 1 })
    expect(hello.windows).toHaveLength(2)
    expect(hello.windows[0]).toEqual({
      id: 1,
      appId: "Alacritty",
      title: "~/development/lwfa",
    })
    // A window that has not set app_id or title yet is normal, not an error.
    expect(hello.windows[1]).toEqual({ id: 2, appId: null, title: null })
    expect(hello.focused).toBe(1)
  })

  it("distinguishes a cleared focus from a focused window", () => {
    const cleared = decodeToShell(readFileSync(`${fixtureDir}/to-shell/focus-cleared.json`, "utf8"))
    expect(cleared).toEqual({ type: "focusChanged", id: null })
  })
})

describe("shell to engine", () => {
  it.each(toEngine)("decodes $name", ({ name, json }) => {
    const message = decodeToEngine(json)
    expect(decodeToEngine(encode(message))).toEqual(message)
    emit("to-engine", name, message)
  })

  it("preserves fractional and negative coordinates", () => {
    // A column scrolled partly off the left edge is the normal steady state of
    // a strip, and animated positions land between pixels. Rounding either
    // here would show up as visible jitter.
    const layout = decodeToEngine(
      readFileSync(`${fixtureDir}/to-engine/set-layout-animated.json`, "utf8"),
    )
    expect(layout.type).toBe("setLayout")
    if (layout.type !== "setLayout") return
    expect(layout.windows[0]!.rect.x).toBe(-23.5)
    expect(layout.windows[0]!.z).toBe(0)
    expect(layout.animate).toEqual({ spring: { stiffness: 220, damping: 26, mass: 1 } })
  })

  it("keeps an absent animation distinct from a default one", () => {
    // "apply immediately" and "animate with default springs" are different
    // instructions and must not collapse into each other.
    const immediate = decodeToEngine(
      readFileSync(`${fixtureDir}/to-engine/set-layout-immediate.json`, "utf8"),
    )
    expect(immediate.type).toBe("setLayout")
    if (immediate.type !== "setLayout") return
    expect(immediate.animate).toBeNull()
  })
})

describe("strictness", () => {
  it("rejects unknown message types", () => {
    expect(() => decodeToEngine('{"type":"teleportWindow","id":1}')).toThrow(ProtocolError)
  })

  it("rejects unknown fields, matching deny_unknown_fields on the Rust side", () => {
    expect(() => decodeToEngine('{"type":"focusWindow","id":1,"bogus":2}')).toThrow(
      /unknown field "bogus"/,
    )
  })

  it("rejects a missing field rather than reading it as undefined", () => {
    // The failure this whole file exists to prevent: a renamed field decoding
    // to undefined and losing data silently.
    expect(() => decodeToShell('{"type":"windowOpened","window":{"id":1,"title":null}}')).toThrow(
      /appId/,
    )
  })

  it("rejects a wrong-typed field", () => {
    expect(() => decodeToEngine('{"type":"focusWindow","id":"1"}')).toThrow(/expected an integer|expected a finite number/)
  })

  it("rejects a non-integer window id", () => {
    expect(() => decodeToEngine('{"type":"focusWindow","id":1.5}')).toThrow(/expected an integer/)
  })

  it("rejects NaN and Infinity, which JSON cannot represent anyway", () => {
    expect(() => decodeToEngine('{"type":"setLayout","windows":[{"id":1,"rect":{"x":1e999,"y":0,"width":1,"height":1},"z":0}],"animate":null}')).toThrow(
      /finite/,
    )
  })

  it("reports where in the message the problem is", () => {
    // Error messages carry a path, because "expected a number" with no
    // location is useless when a layout has twenty windows in it.
    expect(() =>
      decodeToEngine(
        '{"type":"setLayout","windows":[{"id":1,"rect":{"x":0,"y":0,"width":1,"height":1},"z":0},{"id":2,"rect":{"x":"nope","y":0,"width":1,"height":1},"z":0}],"animate":null}',
      ),
    ).toThrow(/windows\[1\]\.rect\.x/)
  })

  it("rejects malformed JSON with a useful message", () => {
    expect(() => decodeToShell("{not json")).toThrow(/invalid JSON/)
  })
})
