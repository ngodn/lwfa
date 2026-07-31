import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: {
    // Reachable from a phone or tablet on the LAN, which is the entire point
    // of the project. The engine's own socket is still localhost-only until
    // milestone 7 adds auth.
    host: true,
    port: 5173,
  },
})
