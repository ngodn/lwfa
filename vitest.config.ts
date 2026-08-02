import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Same alias the shell's Vite config uses, so tests can import modules
      // that reach for generated config or components by their `@/` path.
      "@": fileURLToPath(new URL("./packages/shell/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
  },
})
