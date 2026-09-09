export interface FullscreenHost {
  available(): boolean
  active(): boolean
  standalone(): boolean
  enter(): Promise<void>
  exit(): Promise<void>
  listen(changed: () => void): () => void
}

export interface ImmersiveState {
  mode: "off" | "fullscreen" | "standalone"
  pending: boolean
  navigation: boolean
  error: string | null
}

const initial: ImmersiveState = { mode: "off", pending: false, navigation: false, error: null }

/** Browser presentation only. Window layout and the connection remain mounted. */
export function createImmersive(host: FullscreenHost) {
  let state = initial
  let generation = 0
  const listeners = new Set<() => void>()
  const update = (patch: Partial<ImmersiveState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const changed = () => {
    if (state.mode === "fullscreen" && !host.active()) {
      generation++
      update(initial)
    }
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start() {
      const unlisten = host.listen(changed)
      return () => {
        unlisten()
        generation++
        if (state.mode === "fullscreen" && host.active()) void host.exit().catch(() => {})
        state = initial
      }
    },
    async toggle() {
      if (state.pending) return
      const token = ++generation
      if (state.mode === "standalone") { update(initial); return }
      if (state.mode === "fullscreen") {
        update({ pending: true, error: null })
        try {
          await host.exit()
          if (token === generation) update(initial)
        } catch {
          if (token === generation) update({ pending: false, error: "Could not exit fullscreen. Use the browser’s exit control." })
        }
        return
      }
      if (host.standalone()) {
        update({ mode: "standalone", navigation: false, error: null })
        return
      }
      if (!host.available()) {
        update({ error: "Browser fullscreen is unavailable here. Open lwfa in a supported browser or add it to your Home Screen." })
        return
      }
      update({ pending: true, error: null })
      try {
        // Call directly in the click handler, before any await, to retain activation.
        await host.enter()
        if (token !== generation) {
          // The shell can unmount while the browser is accepting the request.
          if (host.active()) await host.exit()
          return
        }
        if (!host.active()) throw new Error("Fullscreen was not entered")
        update({ mode: "fullscreen", pending: false, navigation: false })
      } catch {
        if (token === generation) update({ ...initial, error: "The browser could not enter fullscreen. Tap Immersive mode to try again." })
      }
    },
    toggleNavigation() {
      if (state.mode !== "off") update({ navigation: !state.navigation })
    },
    dismissError() { update({ error: null }) },
  }
}

export function browserFullscreen(): FullscreenHost {
  return {
    available: () => Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen),
    active: () => document.fullscreenElement === document.documentElement,
    standalone: () => matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    enter: () => document.documentElement.requestFullscreen({ navigationUI: "hide" }),
    exit: () => document.exitFullscreen(),
    listen(changed) {
      document.addEventListener("fullscreenchange", changed)
      return () => document.removeEventListener("fullscreenchange", changed)
    },
  }
}

export interface FloatingPosition { x: number; y: number }

/** Normalized positions survive rotation and smaller browser windows. */
export function boundedPosition(position: FloatingPosition): FloatingPosition {
  const bound = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5
  return { x: bound(position.x), y: bound(position.y) }
}
