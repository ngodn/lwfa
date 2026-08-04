/**
 * Where the shell looks for the engine.
 *
 * Small, and worth pinning: getting this wrong over TLS produces a page that
 * loads perfectly and never connects, with a mixed-content refusal that some
 * browsers report only in the console and iOS Safari barely reports at all.
 */

import { describe, expect, it } from "vitest"
import { ENGINE_PATH, engineFor, engineOverride } from "../src/lib/engineUrl"

describe("engineFor", () => {
  it("uses the page's own origin over plain HTTP", () => {
    // One port serves the page and the socket, so the port the page came from
    // is the port the socket is on. There is no second one to guess.
    expect(
      engineFor({ protocol: "http:", hostname: "192.168.1.51", host: "192.168.1.51:6733" }),
    ).toBe(`ws://192.168.1.51:6733${ENGINE_PATH}`)
  })

  it("uses the page's own origin over TLS", () => {
    // Not `wss://host:6734`: that is a second port needing a second
    // certificate. One origin, one cert, one thing to configure.
    expect(
      engineFor({
        protocol: "https:",
        hostname: "lwfa.example",
        host: "lwfa.example",
      }),
    ).toBe(`wss://lwfa.example${ENGINE_PATH}`)
  })

  it("keeps a non-standard port when the page has one", () => {
    expect(
      engineFor({ protocol: "https:", hostname: "lwfa.example", host: "lwfa.example:8443" }),
    ).toBe(`wss://lwfa.example:8443${ENGINE_PATH}`)
  })

  it("never produces a plaintext socket from a secure page", () => {
    // The whole point. A browser blocks that as mixed content, silently.
    for (const host of ["a.example", "b.example:8443", "127.0.0.1"]) {
      const url = engineFor({ protocol: "https:", hostname: host.split(":")[0]!, host })
      expect(url.startsWith("wss://")).toBe(true)
    }
  })

  it("falls back to localhost when there is no hostname", () => {
    // `file://` and some embedded webviews report an empty hostname.
    expect(engineFor({ protocol: "file:", hostname: "", host: "" })).toBe(
      `ws://localhost${ENGINE_PATH}`,
    )
  })
})

/**
 * `?engine=` is what makes lwfa developable from inside lwfa.
 *
 * The engine is a compositor, so restarting it closes every application running
 * in it, including the editor. A second engine on its own ports, with the same
 * page pointed at it, is the way to exercise a rebuilt engine without ending
 * the session doing the work. That only holds if the override actually wins.
 */
describe("pointing the page at another engine", () => {
  const page = { protocol: "http:", hostname: "localhost", host: "localhost:6733" }

  it("uses the engine named in the query", () => {
    expect(engineFor(page, "?engine=ws://localhost:6744")).toBe("ws://localhost:6744")
  })

  it("wins over the same-origin TLS path too", () => {
    // Otherwise a development page served over TLS could not reach a second
    // engine at all, since the proxy only knows about the first.
    const secure = { protocol: "https:", hostname: "lwfa.ts.net", host: "lwfa.ts.net" }
    expect(engineFor(secure, "?engine=ws://localhost:6744")).toBe("ws://localhost:6744")
    expect(engineFor(secure, "")).toBe(`wss://lwfa.ts.net${ENGINE_PATH}`)
  })

  it("falls back when there is no override", () => {
    expect(engineFor(page, "?other=1")).toBe(`ws://localhost:6733${ENGINE_PATH}`)
    expect(engineFor(page, undefined)).toBe(`ws://localhost:6733${ENGINE_PATH}`)
  })

  it("ignores anything that is not a websocket url", () => {
    // A bad value would otherwise reach `new WebSocket` and throw during the
    // connect, which looks like the shell simply never connecting.
    expect(engineOverride("?engine=http://localhost:6744")).toBeNull()
    expect(engineOverride("?engine=javascript:alert(1)")).toBeNull()
    expect(engineOverride("?engine=not a url")).toBeNull()
    expect(engineOverride("?engine=")).toBeNull()
  })

  it("accepts both websocket schemes", () => {
    expect(engineOverride("?engine=ws://a:1")).toBe("ws://a:1")
    expect(engineOverride("?engine=wss://a/engine")).toBe("wss://a/engine")
  })
})
