import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The port this dev server listens on.
 *
 * The same one the engine serves the built shell on in production, so the URL
 * you type does not change between development and production.
 */
const PAGE_PORT = Number(setting("SHELL_PORT", "6733"))

/**
 * Read a setting the same way the engine does: environment first, then `.env`.
 *
 * Kept deliberately small rather than pulling in a dotenv package. Vite has its
 * own `.env` handling, but it only exposes `VITE_`-prefixed variables to the
 * client and does not apply to this config file's own server options.
 */
function setting(key: string, fallback: string): string {
  if (process.env[key]) return process.env[key]
  try {
    const file = readFileSync(new URL("../../.env", import.meta.url), "utf8")
    for (const line of file.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const at = trimmed.indexOf("=")
      if (at === -1 || trimmed.slice(0, at).trim() !== key) continue
      return trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, "")
    }
  } catch {
    // No .env is fine; fall through to the default.
  }
  return fallback
}

/**
 * The hostname a reverse proxy serves this on, if any.
 *
 * Vite refuses requests whose `Host` header it does not recognise, which is a
 * DNS-rebinding defence and exactly right by default. Behind a proxy it means
 * the dev server answers "This host is not allowed" to every request, with the
 * shell nowhere in sight, so the name has to be declared.
 *
 * Unset for ordinary LAN development, where the host is an IP address.
 */
const PUBLIC_HOST = setting("SHELL_PUBLIC_HOST", "")

/**
 * Where the engine is, for this dev server to proxy `/engine` to.
 *
 * # Why a proxy rather than letting the page connect directly
 *
 * In production the engine serves the page and its own socket on one port, so
 * the shell reaches the socket at the page's own origin. Proxying `/engine`
 * here makes that true in development too, so `engineFor` has one shape
 * instead of a production one and a development one, and the mixed-content and
 * cross-origin questions never arise.
 *
 * # Why the engine is on a different port in development
 *
 * Because Vite is on the production one. `configs/defaults.toml` puts the
 * engine on 6733, which is what you type; while Vite is serving the page it
 * owns that, so the engine moves up one and this points at it. Run the engine
 * with `LWFA_SHELL_ADDR=127.0.0.1:6734` to match, which `scripts/dev-nested.sh`
 * does for you.
 */
const DEV_ENGINE = setting("LWFA_DEV_ENGINE", "127.0.0.1:6734")

/** `/engine` to the engine, WebSocket upgrades included. */
const proxy = {
  "/engine": {
    target: `http://${DEV_ENGINE}`,
    ws: true,
    // The engine reads its token from the query string and ignores the path,
    // but the path must still be a valid request-URI, so it is passed through
    // rather than rewritten away. See deploy/nginx-lwfa.conf for the same
    // reasoning in production.
    rewrite: (path: string) => path,
  },
}

export default defineConfig({
  resolve: {
    // "@/..." is what shadcn generates, and keeping it means components can be
    // pasted from the registry without rewriting every import.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [react(), tailwindcss()],
  server: {
    // Reachable from a phone or tablet on the LAN, which is the entire point
    // of the project. The engine's socket is gated by AUTH_PASS.
    host: true,
    port: PAGE_PORT,
    // Fail loudly rather than silently picking another port: the whole point
    // is that a bookmarked URL keeps working.
    strictPort: true,
    proxy,
    // Only the host list, deliberately.
    //
    // Pinning the hot-reload socket to the public host as well seemed to
    // follow, and it is wrong: the setting is static, but the page is reached
    // by more than one URL. Hardcoding the proxied one left hot reload broken
    // and the console full of `ERR_NAME_NOT_RESOLVED` whenever the shell was
    // opened directly on the LAN, which is the fallback you want working when
    // the proxied path is the thing that is misbehaving.
    //
    // Vite's default derives the socket from the page's own origin, which is
    // right for direct access. Through a TLS proxy it guesses the dev server's
    // port and fails, which costs a console warning and nothing else: hot
    // reload is a development nicety, and the shell itself is unaffected.
    ...(PUBLIC_HOST ? { allowedHosts: [PUBLIC_HOST] } : {}),
  },
  /**
   * The same address for a production build.
   *
   * Without this `vite preview` takes its own defaults, which are port 4173 and
   * localhost only: a bookmarked URL stops working and the tablet the whole
   * project exists for cannot reach it at all. The dev server and the built one
   * should differ in what they serve, not in where.
   */
  preview: {
    host: true,
    port: PAGE_PORT,
    strictPort: true,
    proxy,
    ...(PUBLIC_HOST ? { allowedHosts: [PUBLIC_HOST] } : {}),
  },
})
