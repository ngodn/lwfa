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

import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState } from "react"
import { GripHorizontal, Settings2, Shield, ShieldOff, X } from "lucide-react"
import { setDock, useDock } from "@/lib/dock"
import { patchPrefs, usePrefSection } from "@/lib/prefs"
import { setGamepad, useGamepad, useSetPads } from "@/gamepad/store"
import { shieldActive } from "@/gamepad/shield"
import { useSessionActions, useSessionState } from "@/session"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const Keyboard = lazy(() =>
  import("@/keyboard/Keyboard").then((m) => ({ default: m.Keyboard })),
)
const GamepadOverlay = lazy(() =>
  import("@/gamepad/GamepadOverlay").then((m) => ({ default: m.GamepadOverlay })),
)
const MouseOverlay = lazy(() =>
  import("@/mouse/MouseOverlay").then((m) => ({ default: m.MouseOverlay })),
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
  onOpenSettings: (surface: "keyboard" | "gamepad" | "mouse") => void
}

export const InputDock = memo(function InputDock({ onOpenSettings }: InputDockProps) {
  const dock = useDock()
  const gamepadPrefs = usePrefSection("gamepad")
  const keyboardPrefs = usePrefSection("keyboard")
  const mousePrefs = usePrefSection("mouse")
  // Arranging the mouse clusters. Local, and cleared whenever the mouse is not
  // the surface on screen, so it never lingers into another session.
  const [mouseEditing, setMouseEditing] = useState(false)
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

  // The virtual mouse's direct actions: the side buttons and the scroll strip
  // go straight to the seat, since a button or a wheel has no window of its
  // own (the click at a *point* travels through the window surface instead).
  const onPointerButton = useCallback(
    (button: number, pressed: boolean) => actions.send({ type: "pointerButton", button, pressed }),
    [actions],
  )

  const onPointerAxis = useCallback(
    (horizontal: number, vertical: number) =>
      actions.send({ type: "pointerAxis", horizontal, vertical }),
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

  // Leaving the mouse surface ends its edit mode.
  useEffect(() => {
    if (dock !== "mouse") setMouseEditing(false)
  }, [dock])

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
  const isMouse = dock === "mouse"
  // The gamepad and the mouse both float over the desktop with taps passing
  // through the gaps; the keyboard displaces it. This groups the two that share
  // that geometry and chrome, so the styling below stays one rule, not two.
  const floats = isGamepad || isMouse

  // Overlay or stacked, per surface. See `Prefs.gamepad.placement`.
  //
  // This used to be `isGamepad`: the controller always floated and the
  // keyboard always displaced, which are the right defaults and the wrong
  // rules. Held upright there is height to spare and a controller below the
  // game beats thumbs on top of it; held in landscape a keyboard that takes
  // 42% of the height leaves a letterbox to read.
  const floating =
    (isGamepad ? gamepadPrefs.placement : isMouse ? mousePrefs.placement : keyboardPrefs.placement) ===
    "overlay"

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
        // A floating controller or mouse covers the whole area, because its
        // controls are scattered to the edges rather than gathered into a
        // strip. `pointer-events-none` so taps between them still reach the
        // window behind, and each control turns them back on for itself. For
        // the mouse this pass-through is the whole point: the tap on the
        // window is the click.
        floating && floats && "pointer-events-none absolute inset-0",
        // A floating keyboard is still a strip along the bottom; it just sits
        // over the desktop instead of pushing it up. It keeps its pointer
        // events, since a key with none would do nothing.
        floating &&
          !floats &&
          "absolute inset-x-0 bottom-0 border-t border-border bg-card/85 backdrop-blur-xl",
      )}
      style={
        // A floating controller or mouse is the case with no height of its own.
        floating && floats
          ? undefined
          : ({ "--dock": DEFAULT_FRACTION, height: "calc(var(--dock) * 100%)" } as React.CSSProperties)
      }
    >
      {/*
       * The shield: everything the pads do not take, taken anyway.
       *
       * Only under a floating controller, because that is the only case where
       * the dock is over the window at all; stacked gives the controller its
       * own row and there is nothing behind it to protect.
       *
       * Never while editing. Dragging a pad is a pointer gesture over this
       * exact area, and a full-area sibling sitting under the editor is a
       * second thing wanting the same events. The editor is also the one time
       * a stray tap costs nothing, since the game is not being played.
       *
       * `z-0` keeps it under the pads (`z-10`), and the header opposite is
       * lifted above it. Everything outside this dock is untouched: the nav
       * rail is `z-30` and the arrange bar `z-40`, both above the dock's
       * `z-20`, so the way out of here is never behind the shield.
       */}
      {shieldActive({
        dock,
        placement: gamepadPrefs.placement,
        shield: gamepadPrefs.shield,
        editing: gamepad.editing,
      }) ? (
        <div
          className="pointer-events-auto absolute inset-0 z-0 touch-none select-none"
          aria-hidden
        />
      ) : null}

      <header
        className={cn(
          "flex shrink-0 items-center gap-1 px-2 py-1",
          // Above the shield, so the surface's own controls keep working while
          // everything around them is being swallowed.
          floats && "relative z-20",
          // Over the desktop this is a card sitting in the corner of the
          // picture, so it gets the controls' own treatment instead: small,
          // dark, barely there. It is the surface's furniture, not the shell's.
          floats &&
            "pointer-events-auto self-end gap-0 rounded-bl-md border-b border-l border-white/20 bg-black/45 px-0.5 py-0.5 backdrop-blur-sm",
        )}
        // Matching the pads exactly, rather than a fixed value that would be
        // the wrong amount of visible at either end of the opacity slider. The
        // mouse is not faded, so it keeps full opacity.
        style={isGamepad ? { opacity: gamepadPrefs.opacity } : undefined}
      >
        {floats ? null : (
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
        {isMouse ? (
          <Button
            size="sm"
            variant={mouseEditing ? "default" : "ghost"}
            className={cn("text-xs", HIT_AREA, "h-8 px-2.5 text-white/90")}
            aria-pressed={mouseEditing}
            onClick={() => setMouseEditing((value) => !value)}
          >
            {mouseEditing ? "Done" : "Edit"}
          </Button>
        ) : null}
        {/*
          * Next to Edit rather than buried in settings, because the moment you
          * want it is the moment it just cost you: a missed pad, the game
          * switching to mouse, and the controller going quiet mid-fight. A
          * setting you have to go and find is no use then.
          *
          * Hidden while editing, since the shield is off then anyway and a
          * control that claims to be on while doing nothing is a lie.
          */}
        {isGamepad && !gamepad.editing ? (
          <Button
            size="icon"
            variant={gamepadPrefs.shield ? "default" : "ghost"}
            className={cn(HIT_AREA, "size-8", gamepadPrefs.shield ? "" : "text-white/90")}
            aria-label={
              gamepadPrefs.shield
                ? "Let taps through to the window"
                : "Block taps outside the pads"
            }
            aria-pressed={gamepadPrefs.shield}
            title={
              gamepadPrefs.shield
                ? "Taps outside the pads are blocked"
                : "Taps outside the pads reach the window"
            }
            onClick={() => patchPrefs("gamepad", { shield: !gamepadPrefs.shield })}
          >
            {gamepadPrefs.shield ? (
              <Shield className="size-4" aria-hidden />
            ) : (
              <ShieldOff className="size-4" aria-hidden />
            )}
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className={cn(HIT_AREA, floats ? "size-8 text-white/90" : "size-8")}
          aria-label="Settings"
          onClick={() => onOpenSettings(dock)}
        >
          <Settings2 className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={cn(HIT_AREA, floats ? "size-8 text-white/90" : "size-8")}
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
          ) : isMouse ? (
            <MouseOverlay
              haptics={mousePrefs.haptics}
              scrollSpeed={mousePrefs.scrollSpeed}
              naturalScroll={mousePrefs.naturalScroll}
              editing={mouseEditing}
              positions={mousePrefs.positions}
              onButton={onPointerButton}
              onAxis={onPointerAxis}
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
