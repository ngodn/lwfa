/**
 * The input dock: the keyboard or the gamepad, across the bottom.
 *
 * # Where and why
 *
 * Full width, along the bottom of the content area, with the desktop above it.
 * That is where an on-screen keyboard goes on every platform, and it is not a
 * stylistic choice: a two-thumb reach only works along the bottom.
 *
 * # Why the keyboard takes space and the gamepad does not
 *
 * The keyboard **shrinks** the desktop. The whole point of typing is watching
 * what you are typing into, and a keyboard that covers the bottom of the window
 * receiving the keystrokes hides the very line you are editing.
 *
 * The gamepad **floats** over it at reduced opacity. A game wants every pixel,
 * and its interesting parts are in the middle, not under your thumbs; shrinking
 * it to 58% to make room for two thumbsticks would be a worse trade than seeing
 * the pads faintly over the corners. Hence the opacity control, which would be
 * meaningless for a keyboard.
 *
 * # Resizable, because the right height depends on the job
 *
 * A keyboard wants enough height for five legible rows. A gamepad wants as much
 * as it can get, because the pads are positioned as percentages of it. Somebody
 * reading a log while typing wants neither. The grab handle along the top edge
 * sets it, and the height is written straight to a CSS variable rather than
 * held in state, so dragging it does not re-render the keyboard's ~70 buttons
 * on every pointer move.
 */

import { Suspense, lazy, memo, useCallback, useRef } from "react"
import { GripHorizontal, Settings2, X } from "lucide-react"
import { setDock, useDock } from "@/lib/dock"
import { usePrefs } from "@/lib/prefs"
import { setGamepad, useGamepad, useSetPads } from "@/gamepad/store"
import { useSessionActions } from "@/session"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const Keyboard = lazy(() =>
  import("@/keyboard/Keyboard").then((m) => ({ default: m.Keyboard })),
)
const GamepadOverlay = lazy(() =>
  import("@/gamepad/GamepadOverlay").then((m) => ({ default: m.GamepadOverlay })),
)

/** Fractions of the content area's height. */
const MIN_FRACTION = 0.2
const MAX_FRACTION = 0.75
const DEFAULT_FRACTION = 0.42

export interface InputDockProps {
  /** Opens the settings panel for whichever surface is docked. */
  onOpenSettings: (surface: "keyboard" | "gamepad") => void
}

export const InputDock = memo(function InputDock({ onOpenSettings }: InputDockProps) {
  const dock = useDock()
  const prefs = usePrefs()
  const gamepad = useGamepad()
  const setPads = useSetPads()
  const actions = useSessionActions()
  const root = useRef<HTMLDivElement | null>(null)

  const onKey = useCallback(
    (code: number, pressed: boolean) => actions.send({ type: "key", key: code, pressed }),
    [actions],
  )

  // Straight to the DOM. The alternative re-renders the whole keyboard on every
  // pointermove of the drag, which on a tablet is visibly janky.
  const onResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const element = root.current
    const parent = element?.parentElement
    if (!element || !parent) return
    event.currentTarget.setPointerCapture(event.pointerId)

    const area = parent.getBoundingClientRect()
    const move = (moveEvent: PointerEvent) => {
      const fraction = (area.bottom - moveEvent.clientY) / area.height
      const clamped = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction))
      element.style.setProperty("--dock", String(clamped))
    }
    const stop = () => {
      globalThis.removeEventListener("pointermove", move)
      globalThis.removeEventListener("pointerup", stop)
    }
    globalThis.addEventListener("pointermove", move)
    globalThis.addEventListener("pointerup", stop)
  }, [])

  if (dock === "none") return null

  const isGamepad = dock === "gamepad"

  return (
    <div
      ref={root}
      className={cn(
        "z-20 flex flex-col pb-safe",
        isGamepad
          // Floats: `pointer-events-none` so taps between the pads still reach
          // the window behind, and each pad turns them back on for itself.
          ? "pointer-events-none absolute inset-0"
          : "relative shrink-0 border-t border-border bg-card/95 backdrop-blur-xl",
      )}
      style={
        isGamepad
          ? undefined
          : ({ "--dock": DEFAULT_FRACTION, height: "calc(var(--dock) * 100%)" } as React.CSSProperties)
      }
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-1 px-2 py-1",
          // The gamepad's own layer ignores pointers; its header must not.
          isGamepad && "pointer-events-auto self-end rounded-bl-lg bg-card/80 backdrop-blur-md",
        )}
      >
        {isGamepad ? null : (
          <button
            onPointerDown={onResize}
            className="flex flex-1 cursor-ns-resize justify-center py-1 text-muted-foreground"
            style={{ touchAction: "none" }}
            aria-label="Resize the keyboard"
          >
            <GripHorizontal className="size-4" aria-hidden />
          </button>
        )}
        {isGamepad ? (
          <Button
            size="sm"
            variant={gamepad.editing ? "default" : "ghost"}
            className="h-7 text-xs"
            aria-pressed={gamepad.editing}
            onClick={() => setGamepad({ editing: !gamepad.editing })}
          >
            {gamepad.editing ? "Done" : "Edit"}
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Settings"
          onClick={() => onOpenSettings(dock)}
        >
          <Settings2 className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Hide"
          onClick={() => setDock("none")}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <Suspense fallback={null}>
          {isGamepad ? (
            <GamepadOverlay
              pads={gamepad.pads}
              skin={prefs.gamepad.skin}
              opacity={prefs.gamepad.opacity}
              haptics={prefs.gamepad.haptics}
              editing={gamepad.editing}
              onChange={setPads}
              onKey={onKey}
            />
          ) : (
            <Keyboard />
          )}
        </Suspense>
      </div>
    </div>
  )
})
