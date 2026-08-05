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

import { Suspense, lazy, memo, useCallback, useEffect, useRef } from "react"
import { GripHorizontal, Settings2, X } from "lucide-react"
import { setDock, useDock } from "@/lib/dock"
import { usePrefSection } from "@/lib/prefs"
import { setGamepad, useGamepad, useSetPads } from "@/gamepad/store"
import { useSessionActions, useSessionState } from "@/session"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const Keyboard = lazy(() =>
  import("@/keyboard/Keyboard").then((m) => ({ default: m.Keyboard })),
)
const GamepadOverlay = lazy(() =>
  import("@/gamepad/GamepadOverlay").then((m) => ({ default: m.GamepadOverlay })),
)

/** Fractions of the content area's height. */
/**
 * A 44px touch target on a button that does not look 44px.
 *
 * These sit in the corner of a running game, so they are drawn small on
 * purpose. Small drawn is fine; small to hit is not, and 44px is the floor
 * every touch guideline agrees on. The pseudo-element grows the hit area
 * without growing the furniture.
 */
const HIT_AREA = "relative after:absolute after:-inset-1.5 after:content-['']"

const MIN_FRACTION = 0.2
const MAX_FRACTION = 0.75
const DEFAULT_FRACTION = 0.42

export interface InputDockProps {
  /** Opens the settings panel for whichever surface is docked. */
  onOpenSettings: (surface: "keyboard" | "gamepad") => void
}

export const InputDock = memo(function InputDock({ onOpenSettings }: InputDockProps) {
  const dock = useDock()
  const gamepadPrefs = usePrefSection("gamepad")
  const keyboardPrefs = usePrefSection("keyboard")
  const gamepad = useGamepad()
  const setPads = useSetPads()
  const actions = useSessionActions()
  // Only the id, and only for the controller effect below: a reconnect gets
  // a fresh session, and the engine needs `setGamepad` said again to it.
  const { session } = useSessionState()
  const root = useRef<HTMLDivElement | null>(null)

  // Whether the pad drives a controller or a keyboard.
  //
  // A controller is right for anything built for one, which is most modern
  // games and everything Steam knows about. Keyboard stays because emulators
  // and older titles often only understand keys, and because a controller
  // needs `/dev/uinput`, which not every machine grants.
  const controllerMode = gamepadPrefs.mode !== "keyboard"

  const onKey = useCallback(
    (code: number, pressed: boolean) => actions.send({ type: "key", key: code, pressed }),
    [actions],
  )

  const onButton = useCallback(
    (button: number, pressed: boolean) =>
      actions.send({ type: "gamepadButton", button, pressed }),
    [actions],
  )

  const onAxis = useCallback(
    (axis: number, value: number) => actions.send({ type: "gamepadAxis", axis, value }),
    [actions],
  )

  // Attach a real controller for as long as the pad is on screen.
  //
  // The device the engine creates is visible to the whole machine, which is
  // exactly what makes Steam find it, so it must not outlive the thing holding
  // it: a session advertising a controller nobody is touching confuses games
  // about how many players are present.
  const padOpen = dock === "gamepad"
  useEffect(() => {
    if (!padOpen || !controllerMode) return
    // `session` is a dependency on purpose: a connection blip comes back as a
    // new session, and a controller announced to the dead one is a controller
    // the engine no longer associates with this client. Without the re-send,
    // every press after a reconnect was silently dropped until the pad was
    // toggled off and on by hand. The disable on cleanup is a no-op to an
    // engine that has already parked the pad, so re-running is safe.
    actions.send({ type: "setGamepad", enabled: true })
    return () => actions.send({ type: "setGamepad", enabled: false })
  }, [padOpen, controllerMode, actions, session])

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

  // Overlay or stacked, per surface. See `Prefs.gamepad.placement`.
  //
  // This used to be `isGamepad`: the controller always floated and the
  // keyboard always displaced, which are the right defaults and the wrong
  // rules. Held upright there is height to spare and a controller below the
  // game beats thumbs on top of it; held in landscape a keyboard that takes
  // 42% of the height leaves a letterbox to read.
  const floating =
    (isGamepad ? gamepadPrefs.placement : keyboardPrefs.placement) === "overlay"

  return (
    <div
      ref={root}
      className={cn(
        // `pb-safe` here, not on the shell root: the desktop itself runs
        // edge to edge under the home indicator, but a docked keyboard's
        // bottom row must sit above it or the space bar is half swipe-bar.
        "z-20 flex flex-col pb-safe",
        // Stacked: a row of its own, in flow, and the desktop shrinks.
        !floating && "relative shrink-0 border-t border-border bg-card/95 backdrop-blur-xl",
        // A floating controller covers the whole area, because its pads are
        // scattered to the corners rather than gathered into a strip.
        // `pointer-events-none` so taps between them still reach the window
        // behind, and each pad turns them back on for itself.
        floating && isGamepad && "pointer-events-none absolute inset-0",
        // A floating keyboard is still a strip along the bottom; it just sits
        // over the desktop instead of pushing it up. It keeps its pointer
        // events, since a key with none would do nothing.
        floating &&
          !isGamepad &&
          "absolute inset-x-0 bottom-0 border-t border-border bg-card/85 backdrop-blur-xl",
      )}
      style={
        // A floating controller is the one case with no height of its own.
        floating && isGamepad
          ? undefined
          : ({ "--dock": DEFAULT_FRACTION, height: "calc(var(--dock) * 100%)" } as React.CSSProperties)
      }
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-1 px-2 py-1",
          // Over a game this is a card sitting in the corner of the picture,
          // so it gets the pads' own treatment instead: small, dark, barely
          // there, and faded to whatever the pads are faded to. It is the
          // controller's furniture, not the shell's.
          isGamepad &&
            "pointer-events-auto self-end gap-0 rounded-bl-md border-b border-l border-white/20 bg-black/45 px-0.5 py-0.5 backdrop-blur-sm",
        )}
        // Matching the pads exactly, rather than a fixed value that would be
        // the wrong amount of visible at either end of the opacity slider.
        style={isGamepad ? { opacity: gamepadPrefs.opacity } : undefined}
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
            className={cn("text-xs", HIT_AREA, isGamepad ? "h-8 px-2.5 text-white/90" : "h-8")}
            aria-pressed={gamepad.editing}
            onClick={() => setGamepad({ editing: !gamepad.editing })}
          >
            {gamepad.editing ? "Done" : "Edit"}
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className={cn(HIT_AREA, isGamepad ? "size-8 text-white/90" : "size-8")}
          aria-label="Settings"
          onClick={() => onOpenSettings(dock)}
        >
          <Settings2 className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={cn(HIT_AREA, isGamepad ? "size-8 text-white/90" : "size-8")}
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
              skin={gamepadPrefs.skin}
              opacity={gamepadPrefs.opacity}
              haptics={gamepadPrefs.haptics}
              editing={gamepad.editing}
              onChange={setPads}
              onKey={onKey}
              {...(controllerMode ? { onButton, onAxis } : {})}
            />
          ) : (
            <Keyboard />
          )}
        </Suspense>
      </div>
    </div>
  )
})
