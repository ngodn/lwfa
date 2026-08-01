/**
 * Applies the theme to the document.
 *
 * Renders nothing. The class goes on `<html>` rather than a wrapper element
 * because Radix portals its overlays to `document.body`, and a wrapper would
 * leave every dialog, tooltip and dropdown outside the themed subtree and
 * therefore permanently light.
 */

import { useEffect } from "react"
import { usePrefs } from "@/lib/prefs"

/** The system's preference, watched so "system" follows it live. */
function prefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
}

export function ThemeProvider(): null {
  const { theme } = usePrefs()

  useEffect(() => {
    const root = document.documentElement

    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && prefersDark())
      root.classList.toggle("dark", dark)
      // So the browser paints form controls, scrollbars and the address bar to
      // match instead of flashing white behind a dark shell.
      root.style.colorScheme = dark ? "dark" : "light"
    }

    apply()
    if (theme !== "system") return

    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)")
    media?.addEventListener("change", apply)
    return () => media?.removeEventListener("change", apply)
  }, [theme])

  return null
}
