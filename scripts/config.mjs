/**
 * Read `configs/defaults.toml` from Node.
 *
 * The engine parses that file itself in `crates/lwfa-engine/src/config.rs`.
 * This is the other half: the shell, the dev scripts and the end-to-end checks
 * need the same numbers, and having them retype the values is exactly the drift
 * the file exists to prevent.
 *
 * Also usable from a shell script, which is why there is a CLI mode:
 *
 *   node scripts/config.mjs host.workspace     # -> 10
 *   node scripts/config.mjs net.shell_addr     # -> 127.0.0.1:6733
 *
 * Missing keys print nothing and exit non-zero, so `$(... || echo fallback)`
 * behaves the way a shell script author would expect.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parse } from "smol-toml"

export const CONFIG_PATH = fileURLToPath(new URL("../configs/defaults.toml", import.meta.url))

/**
 * The parsed config.
 *
 * Throws if the file is missing or malformed, which is the opposite of what the
 * engine does. That asymmetry is deliberate: the engine must still start with a
 * broken config because you may need it to fix the config, whereas a build step
 * that silently substituted defaults would bake wrong values into a bundle and
 * say nothing.
 */
export function readConfig() {
  return parse(readFileSync(CONFIG_PATH, "utf8"))
}

/** Look up a dotted path, e.g. `host.workspace`. Undefined if absent. */
export function get(config, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), config)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  if (!path) {
    console.error("usage: node scripts/config.mjs <dotted.key>")
    process.exit(2)
  }
  const value = get(readConfig(), path)
  if (value === undefined) {
    console.error(`${path} is not set in ${CONFIG_PATH}`)
    process.exit(1)
  }
  console.log(Array.isArray(value) ? value.join(" ") : String(value))
}
