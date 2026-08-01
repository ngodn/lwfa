import { readFileSync } from "node:fs"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

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

export default defineConfig({
  plugins: [react()],
  server: {
    // Reachable from a phone or tablet on the LAN, which is the entire point
    // of the project. The engine's socket is gated by AUTH_PASS.
    host: true,
    port: Number(setting("SHELL_PORT", "6733")),
    // Fail loudly rather than silently picking another port: the whole point
    // is that a bookmarked URL keeps working.
    strictPort: true,
  },
})
