/**
 * Working out where the engine's socket is, from where the page came from.
 *
 * # Why this is not just `ws://host:6734`
 *
 * It was, and that breaks the moment the page is served over TLS: a browser
 * refuses a plaintext WebSocket from an HTTPS page as mixed content, silently,
 * with nothing in the interface to say why.
 *
 * TLS is not a nicety here. `VideoDecoder` and `AudioWorklet` are both
 * secure-context APIs, so a plain-HTTP page gets neither hardware video
 * decoding nor the low-latency audio path, and both fall back. Serving the
 * shell over HTTPS is how those turn on, so the socket has to follow.
 *
 * # Why the origin is always the page's own
 *
 * The engine serves this page and its own socket on one port, so the socket is
 * always reachable at the origin the page came from. There is no second port
 * to guess, nothing cross-origin to configure, and one certificate covers
 * both.
 *
 * In development Vite serves the page instead and proxies `/engine` back to
 * the engine, so the same rule holds there and this code has one shape rather
 * than a production one and a development one.
 *
 * # Pointing the page at a different engine
 *
 * `?engine=ws://host:port` overrides all of it, for when the page and the
 * engine are not on the same machine, or when a second engine is running.
 * Validated rather than passed straight through: a malformed value reaches
 * `new WebSocket` and throws during the connect, which shows up as the shell
 * never connecting and nothing to say why.
 */

/**
 * Path a reverse proxy forwards to the engine's socket over TLS.
 *
 * Under the shell's own origin rather than on a subdomain or port of its own,
 * so one certificate covers both and there is nothing cross-origin to
 * configure. A second TLS port would mean a second certificate and a second
 * thing to get wrong.
 */
export const ENGINE_PATH = "/engine"

/** Just enough of `Location` to decide, so this is testable without a DOM. */
export interface PageOrigin {
  protocol: string
  hostname: string
  /** Host with the port, as `location.host` gives it. */
  host: string
}

/**
 * Where to reach the engine.
 *
 * Two shapes:
 *
 * - **Overridden**, whatever `?engine=` names. See the header. This is how the
 *   page talks to an engine on another machine, or to a second one.
 * - **Same origin**, `/engine` on the host and port the page came from, with
 *   the scheme following the page's own so an HTTPS page never opens a
 *   plaintext socket.
 */
export function engineFor(page: PageOrigin, search?: string): string {
  const override = engineOverride(search)
  if (override) return override
  const scheme = page.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${page.host || page.hostname || "localhost"}${ENGINE_PATH}`
}

/**
 * The `?engine=` parameter, if it names a WebSocket the page may open.
 *
 * Anything that is not a `ws:` or `wss:` URL is ignored rather than passed on.
 * A malformed value would otherwise reach `new WebSocket` and throw during the
 * connect, which surfaces as the shell never connecting and no clue as to why.
 */
export function engineOverride(search: string | undefined): string | null {
  if (!search) return null
  const raw = new URLSearchParams(search).get("engine")
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "ws:" || url.protocol === "wss:" ? raw : null
  } catch {
    return null
  }
}
