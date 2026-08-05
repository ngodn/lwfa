/**
 * The gamepad itself, drawn over the desktop.
 *
 * # Play and edit are two different renderers
 *
 * In **play** mode this is a handful of absolutely positioned buttons and
 * nothing else: no canvas, no graph library, no grid. That matters. The thing
 * behind these controls is a game, and a dot grid over it while you are trying
 * to see enemies is exactly the kind of "editor bleeding into the product" that
 * makes an overlay feel unfinished. It also keeps the play path free of a
 * library that has no business running while somebody is holding a jump button.
 *
 * In **edit** mode the same pads become React Flow nodes on a canvas with a dot
 * background, so they can be dragged and resized against a visible grid.
 *
 * Both read the same `Pad[]`, so what you arrange is exactly what you play.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  DPAD_BUTTONS,
  FACE_TO_BUTTON,
  SKIN_LABELS,
  STICK_AXES,
  chordLabel,
  TRIGGER_AXES,
  clampPad,
  type Pad,
} from "@/gamepad/model"
import { tap } from "@/lib/haptics"
import type { GamepadSkin } from "@/lib/prefs"
import { cn } from "@/lib/utils"

/**
 * What a control sends, in whichever language the session is speaking.
 *
 * A face means one thing to a controller and another to a keyboard, and the
 * layout carries both so switching modes needs no re-binding.
 */
interface Binding {
  /** evdev keycode, for the keyboard fallback. */
  key?: number | undefined
  /** W3C gamepad button index, when a controller is attached. */
  button?: number | undefined
  /** Analog axis to drive alongside the button. Triggers only. */
  axis?: number | undefined
  /**
   * A whole keyboard chord, key last. See `Pad.chord`.
   *
   * Held for as long as the button is, exactly like every other control here.
   *
   * It used to fire the whole thing on the press, pressing and releasing each
   * key in one synchronous block. That looked reasonable and did nothing at
   * all: the key was down for effectively zero milliseconds, and a game
   * sampling input once a frame never saw it. It also made holding
   * impossible, which games ask for constantly (crouch, sprint, aim).
   *
   * The worry that stopped this the first time was a stuck modifier when a
   * thumb slides off a button without a release. That is already handled for
   * every control by pointer capture plus `pointercancel`, both of which land
   * in `up`, so a chord is no more exposed than a face button.
   */
  chord?: number[] | undefined
}

export interface GamepadOverlayProps {
  pads: Pad[]
  skin: GamepadSkin
  opacity: number
  haptics: boolean
  editing: boolean
  onChange: (pads: Pad[]) => void
  /** Keyboard fallback, for the keyboard binding mode. */
  onKey: (code: number, pressed: boolean) => void
  /**
   * A controller button, by W3C index. See `FACE_TO_BUTTON`.
   *
   * Absent in keyboard mode, which is what makes this a fallback rather than a
   * second thing to keep in sync: the pads call whichever is provided.
   */
  onButton?: ((button: number, pressed: boolean) => void) | undefined
  /** A controller axis, -1 to 1. Absent in keyboard mode. */
  onAxis?: ((axis: number, value: number) => void) | undefined
}

export const GamepadOverlay = memo(function GamepadOverlay(props: GamepadOverlayProps) {
  return props.editing ? <EditCanvas {...props} /> : <PlaySurface {...props} />
})

/* ------------------------------------------------------------------ play -- */

const PlaySurface = memo(function PlaySurface({
  pads,
  skin,
  opacity,
  haptics,
  onKey,
  onButton,
  onAxis,
}: GamepadOverlayProps) {
  return (
    <PlayArea style={{ opacity }} aria-label="On-screen gamepad">
      {pads.map((pad) => (
        <PlayPad
          key={pad.id}
          pad={pad}
          skin={skin}
          haptics={haptics}
          onKey={onKey}
          onButton={onButton}
          onAxis={onAxis}
        />
      ))}
    </PlayArea>
  )
})

/**
 * The box the layout is arranged in, which is not always the whole screen.
 *
 * A pad's position is a percentage of each axis and its size a percentage of
 * the shorter one, so the two only agree while the box stays roughly the shape
 * the layout was arranged in. Hand the same arrangement a portrait phone and
 * the gaps between controls shrink with the width while the controls themselves
 * do not: the face cluster piles into the stick, Select lands on Start, and the
 * rightmost buttons hang off the edge. That is what "the pad is broken on a
 * phone" turned out to be.
 *
 * Making the box no taller than `MIN_ASPECT` fixes it without touching anyone's
 * saved layout. A landscape tablet, a desktop and an iPad in landscape are all
 * wider than that already and are unaffected; a phone in portrait gets a
 * controller-shaped band across the bottom, where the thumbs are, holding the
 * arrangement it had in landscape.
 *
 * Bottom, not centred: in portrait the top of the screen is the part of the
 * desktop you are actually looking at, and it is out of thumb reach anyway.
 */
const MIN_ASPECT = 16 / 9

const PlayArea = memo(function PlayArea({
  children,
  style,
  areaRef,
  interactive,
  ...rest
}: {
  children: React.ReactNode
  style?: React.CSSProperties
  /** The play area itself, for the editor, which measures it in pixels. */
  areaRef?: React.Ref<HTMLDivElement>
  interactive?: boolean
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    // The outer element is a size container so the inner one can be measured
    // against the screen; the inner one is the play area and is a size
    // container in turn, so `cqmin` on a pad means "of the box the layout was
    // arranged in" rather than "of the screen".
    <div
      className={cn("absolute inset-0 z-10 select-none", !interactive && "pointer-events-none")}
      style={{ ...style, containerType: "size" }}
    >
      <div
        ref={areaRef}
        className="absolute inset-x-0 bottom-0"
        style={{ height: `min(100cqh, ${100 / MIN_ASPECT}cqw)`, containerType: "size" }}
        {...rest}
      >
        {children}
      </div>
    </div>
  )
})

/**
 * Why every pad is a square that merely looks round.
 *
 * Hit testing respects `border-radius`. A round button in a square box is
 * therefore transparent at its four corners, and the overlay behind it passes
 * pointers through on purpose so the gaps between pads still reach the desktop.
 * Put those together and a thumb landing slightly off centre on X misses the
 * circle, falls through the corner, and clicks whatever the game is drawing
 * underneath: the button does nothing and the game reacts instead. On glass,
 * where nobody lands dead centre, that is most of the near misses.
 *
 * Measured rather than reasoned about: `elementFromPoint` at the centre of a
 * pad returns the pad, and six pixels into its own top-left corner returns the
 * window behind it.
 *
 * So the element that takes the pointer is the full square, and the circle is
 * an inert span drawn inside it. The pad's whole box belongs to the pad; only
 * the space genuinely between pads reaches the game.
 */
const PlayPad = memo(function PlayPad({
  pad,
  skin,
  haptics,
  onKey,
  onButton,
  onAxis,
}: {
  pad: Pad
  skin: GamepadSkin
  haptics: boolean
  onKey: (code: number, pressed: boolean) => void
  onButton?: ((button: number, pressed: boolean) => void) | undefined
  onAxis?: ((axis: number, value: number) => void) | undefined
}) {
  // What each active pointer is holding, so a finger that slides off still
  // releases it. Without this a lifted finger can leave a direction held and
  // the character walks into a wall forever.
  //
  // A binding rather than a keycode, because the same control means one thing
  // to a controller and another to a keyboard.
  const holding = useRef(new Map<number, Binding>())

  const buzz = useCallback(() => {
    if (haptics) tap()
  }, [haptics])

  /**
   * Send a binding, preferring the controller when one is attached.
   *
   * Not both: a game reading the pad *and* the keyboard would see every press
   * twice, which in a menu means skipping two items at a time.
   */
  const emit = useCallback(
    (binding: Binding, pressed: boolean) => {
      if (binding.chord !== undefined) {
        const chord = binding.chord
        // Modifiers down in order then the key, and on release the key first
        // then the modifiers in reverse. Anything watching modifier state sees
        // a sequence it could have got from real hardware, which is the same
        // ordering `keyboard/Keyboard.tsx` uses for the same reason.
        //
        // Held rather than fired, so a tap is a short press and a hold is a
        // hold. See `Binding.chord`.
        if (pressed) {
          for (const code of chord) onKey(code, true)
        } else {
          for (const code of [...chord].reverse()) onKey(code, false)
        }
        return
      }
      if (onButton && binding.button !== undefined) {
        onButton(binding.button, pressed)
        // A trigger also moves its axis. See `TRIGGER_AXES`.
        if (binding.axis !== undefined) onAxis?.(binding.axis, pressed ? 1 : 0)
      } else if (binding.key !== undefined) {
        onKey(binding.key, pressed)
      }
    },
    [onKey, onButton, onAxis],
  )

  const down = useCallback(
    (event: React.PointerEvent<HTMLElement>, binding: Binding) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      holding.current.set(event.pointerId, binding)
      buzz()
      emit(binding, true)
    },
    [buzz, emit],
  )

  const up = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const binding = holding.current.get(event.pointerId)
      if (binding === undefined) return
      holding.current.delete(event.pointerId)
      emit(binding, false)
    },
    [emit],
  )

  // Inset by half the pad, so a control near an edge stays fully reachable
  // rather than being half off-screen where a thumb cannot land on it.
  const style: React.CSSProperties = {
    left: `clamp(${pad.size / 2}cqmin, ${pad.x}%, calc(100% - ${pad.size / 2}cqmin))`,
    top: `clamp(${pad.size / 2}cqmin, ${pad.y}%, calc(100% - ${pad.size / 2}cqmin))`,
    width: `${pad.size}cqmin`,
    aspectRatio: "1",
    transform: "translate(-50%, -50%)",
    // Re-enabled per pad, so the gaps between them stay clickable by the game.
    pointerEvents: "auto",
    // Otherwise a drag on the pad scrolls or zooms the page instead of playing.
    touchAction: "none",
  }

  if (pad.kind === "stick" && pad.directions) {
    return <Stick pad={pad} style={style} haptics={haptics} onKey={onKey} onAxis={onAxis} />
  }

  if (pad.kind === "dpad" && pad.directions) {
    const [up_, right, down_, left] = pad.directions
    const [bUp, bRight, bDown, bLeft] = DPAD_BUTTONS
    return (
      <div className="absolute" style={style}>
        <div className="grid h-full w-full grid-cols-3 grid-rows-3">
          <span />
          <Segment onDown={(e) => down(e, { key: up_, button: bUp })} onUp={up} className="rounded-t-lg">▲</Segment>
          <span />
          <Segment onDown={(e) => down(e, { key: left, button: bLeft })} onUp={up} className="rounded-l-lg">◀</Segment>
          <span className="border border-white/10 bg-black/30" />
          <Segment onDown={(e) => down(e, { key: right, button: bRight })} onUp={up} className="rounded-r-lg">▶</Segment>
          <span />
          <Segment onDown={(e) => down(e, { key: down_, button: bDown })} onUp={up} className="rounded-b-lg">▼</Segment>
          <span />
        </div>
      </div>
    )
  }

  const label =
    pad.kind === "key"
      ? (pad.label ?? (pad.chord ? chordLabel(pad.chord) : "key"))
      : (SKIN_LABELS[skin]?.[pad.face] ?? pad.face)
  return (
    <button
      // Square, and deliberately unstyled: see the note on `PlayPad`. The
      // circle you see is the span inside, which takes no pointer events.
      className="group absolute grid place-items-center"
      style={style}
      onPointerDown={(event) =>
        down(
          event,
          pad.kind === "key"
            ? { chord: pad.chord ?? [] }
            : {
                key: pad.code,
                button: FACE_TO_BUTTON[pad.face],
                axis: TRIGGER_AXES[pad.face],
              },
        )
      }
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={String(label)}
    >
      <span
        // The type scales with the pad, because the pads scale with the
        // screen. At a fixed size "SELECT" is wider than the button holding it
        // on anything smaller than a tablet, and the centre cluster reads as
        // one smeared word. `overflow-hidden` is the guarantee: a label can no
        // longer paint outside the control it belongs to whatever it says.
        style={{ fontSize: `${labelSize(pad, String(label))}cqmin` }}
        className={cn(
          "pointer-events-none grid size-full place-items-center overflow-hidden",
          // No backdrop blur, and not for looks: a backdrop filter re-samples
          // whatever is behind it every time the backdrop changes, and behind
          // every pad is a live game pushing new frames continuously. With a
          // full layout that was ~15 blur passes per video frame on the
          // client's GPU, which read as stream lag the moment the overlay
          // turned on. A slightly darker flat fill keeps the pads legible.
          "border border-white/20 bg-black/50 text-white/90",
          "transition-transform group-active:scale-95 group-active:bg-white/25",
          pad.kind === "trigger" ? "rounded-lg" : "rounded-full",
          // A chord's name is several characters, not one glyph, so it needs
          // room to be legible at thumb size.
          pad.kind === "key" && "rounded-lg px-1 leading-tight break-all",
        )}
      >
        {label}
      </span>
    </button>
  )
})


/**
 * Type size for a pad's label, in `cqmin`, so it scales with the pad.
 *
 * A fixed size only ever suits one screen. The face buttons carry a single
 * glyph and want to be as large as the control allows; `SELECT`, `OPTIONS` and
 * a chord's name are words, and a word set at glyph size is wider than the
 * circle around it, which is why the centre cluster used to read as one smeared
 * label. Long labels get proportionally less, from the width the word needs.
 */
function labelSize(pad: Pad, label: string): string {
  const base = pad.kind === "trigger" || pad.kind === "key" ? 0.3 : 0.34
  // 0.68em is about the width of an upper-case character in this face, which
  // is what these labels are; leave a little of the circle either side.
  const forWidth = 0.9 / (0.68 * Math.max(label.length, 1))
  return (pad.size * Math.min(base, forWidth)).toFixed(2)
}

/**
 * An analog thumbstick.
 *
 * # Analog on a keyboard transport
 *
 * The stick reports a direction and a magnitude; the wire carries key presses.
 * So the circle is quantised into eight directions and the keys for the
 * current one are held down, with a dead zone in the middle so resting a thumb
 * does not walk the character into a wall. Diagonals hold two keys at once,
 * which is exactly what WASD does on a real keyboard.
 *
 * The nub is moved with a transform written straight to the DOM. Putting its
 * position in React state would re-render on every pointermove of a thumb that
 * never stops moving, which is the one place in this UI that genuinely cannot
 * afford it.
 *
 * There is no click-to-press: see `onPointerUp`.
 */
/**
 * How much of the analog response is curved rather than linear. See `track`.
 *
 * 0 is the old straight-line response, 1 a pure square that feels dead around
 * centre. A bit over half keeps the top of the range honest while giving the
 * slow half most of the thumb's travel.
 */
const EXPO = 0.55

/**
 * How far a stick's zero may move to meet the thumb, as a share of its radius.
 *
 * A real stick is already centred when your thumb arrives, because it is in a
 * cup and sprung. A drawn one is wherever the thumb landed, so measuring from
 * the *drawn* centre means every grab starts with a deflection nobody asked
 * for: put a thumb down slightly high and the character walks forward before
 * you have moved. Taking the touch point as zero fixes that.
 *
 * It is clamped rather than free so that full travel stays reachable in every
 * direction: grab the very edge of the ring and an unclamped origin would
 * leave no room to push further that way.
 */
const RECENTRE = 0.45

const Stick = memo(function Stick({
  pad,
  style,
  haptics,
  onKey,
  onAxis,
}: {
  pad: Pad
  style: React.CSSProperties
  haptics: boolean
  onKey: (code: number, pressed: boolean) => void
  onAxis?: ((axis: number, value: number) => void) | undefined
}) {
  const nub = useRef<HTMLSpanElement | null>(null)
  const held = useRef<Set<number>>(new Set())
  const moved = useRef(false)

  /**
   * The geometry of the grab in progress, measured once when it starts.
   *
   * `cx`/`cy` are the recentred zero (see [`RECENTRE`]); `ox`/`oy` are where
   * that sits relative to the drawn centre, which is what the nub is
   * positioned against.
   */
  const grabbed = useRef<{
    radius: number
    cx: number
    cy: number
    ox: number
    oy: number
  } | null>(null)

  const axes = STICK_AXES[pad.face]
  /** True when this stick reports a real position rather than four keys. */
  const analog = onAxis !== undefined && axes !== undefined

  // Axis sends are coalesced, not fired per pointer move. A tablet delivers
  // pointermove at up to 120Hz and each move used to send two messages, so
  // steering with one thumb was ~240 messages per second up the same socket
  // the video comes down, every one of them waking the engine's event loop.
  // A game cannot read the stick faster than once per frame anyway, so the
  // latest position sits here and one animation frame ships it, and only the
  // axes that moved enough to matter. A thumb resting in the dead zone now
  // costs nothing instead of re-sending centre forever.
  const pending = useRef<[number, number] | null>(null)
  const sent = useRef<[number, number]>([0, 0])
  const raf = useRef(0)

  const flush = useCallback(() => {
    raf.current = 0
    const next = pending.current
    if (next === null || axes === undefined) return
    pending.current = null
    // Under 1/64 of travel is below anything a game reacts to, and well
    // under the dead zone every game applies on top.
    const step = 1 / 64
    if (Math.abs(next[0] - sent.current[0]) >= step) {
      sent.current[0] = next[0]
      onAxis?.(axes[0], next[0])
    }
    if (Math.abs(next[1] - sent.current[1]) >= step) {
      sent.current[1] = next[1]
      onAxis?.(axes[1], next[1])
    }
  }, [onAxis, axes])

  const queue = useCallback(
    (x: number, y: number) => {
      pending.current = [x, y]
      if (raf.current === 0) raf.current = requestAnimationFrame(flush)
    },
    [flush],
  )

  // A frame queued by a stick that is being unmounted must not fire.
  useEffect(() => {
    return () => {
      if (raf.current !== 0) cancelAnimationFrame(raf.current)
    }
  }, [])

  /** Measure the stick and choose this grab's zero. See [`RECENTRE`]. */
  const grab = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const radius = box.width / 2
    const bx = box.left + radius
    const by = box.top + radius
    let ox = event.clientX - bx
    let oy = event.clientY - by
    const away = Math.hypot(ox, oy)
    const limit = radius * RECENTRE
    if (away > limit && away > 0) {
      ox = (ox / away) * limit
      oy = (oy / away) * limit
    }
    grabbed.current = { radius, cx: bx + ox, cy: by + oy, ox, oy }
  }, [])

  const release = useCallback(() => {
    grabbed.current = null
    if (raf.current !== 0) {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
    pending.current = null
    if (analog && axes) {
      // Centre it, immediately and unconditionally rather than through the
      // queue: a stick left pushed is a character that keeps walking.
      onAxis?.(axes[0], 0)
      onAxis?.(axes[1], 0)
      sent.current = [0, 0]
    }
    for (const code of held.current) onKey(code, false)
    held.current.clear()
    nub.current?.style.setProperty("transform", "translate(-50%, -50%)")
  }, [onKey, onAxis, analog, axes])

  /** Hold exactly the keys the current direction implies, and no others. */
  const apply = useCallback(
    (wanted: Set<number>) => {
      for (const code of held.current) {
        if (!wanted.has(code)) onKey(code, false)
      }
      for (const code of wanted) {
        if (!held.current.has(code)) onKey(code, true)
      }
      held.current = wanted
    },
    [onKey],
  )

  const track = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Geometry is read once per grab, in `grab`, not once per move. A tablet
      // delivers pointermove at 120Hz and `getBoundingClientRect` forces a
      // layout flush, so measuring here put a synchronous reflow between every
      // frame of a thumb drag and the video decoding beside it.
      const origin = grabbed.current
      if (!origin) return
      const { radius, cx, cy } = origin
      let dx = event.clientX - cx
      let dy = event.clientY - cy
      const distance = Math.hypot(dx, dy)

      // Clamp travel to the rim, so it reads as a physical stick rather than
      // a dot that can be dragged across the screen.
      if (distance > radius) {
        dx = (dx / distance) * radius
        dy = (dy / distance) * radius
      }

      // The nub is drawn against the *drawn* centre, so it carries the
      // recentring offset too, and is clamped again: a grab near the rim plus
      // a full push that way would otherwise put it outside its own ring.
      let px = origin.ox + dx
      let py = origin.oy + dy
      const drawn = Math.hypot(px, py)
      if (drawn > radius) {
        px = (px / drawn) * radius
        py = (py / drawn) * radius
      }
      nub.current?.style.setProperty(
        "transform",
        `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`,
      )

      if (analog && axes) {
        // The whole point of a controller: how far, not merely which way.
        //
        // Nearly no dead zone, on purpose. A physical stick needs one to hide
        // sensor noise and spring slack; a finger on glass has neither, and
        // touch muscle memory expects feedback from the first millimetre of
        // movement. This used to match the key mapping's quarter-travel zone
        // and the stick felt like it ignored the first part of every push,
        // doubly so because games apply their own dead zone on top. 5% is
        // just enough that a resting thumb's tremor reads as centred.
        const dead = 0.05
        const nx = dx / radius
        const ny = dy / radius
        const magnitude = Math.hypot(nx, ny)
        if (magnitude > dead) {
          moved.current = true
          // Rescale so the stick still reaches 1.0 at the rim rather than
          // starting at 0.25 the moment it leaves the dead zone.
          const linear = (magnitude - dead) / (1 - dead)
          // Then bend it, because linear travel is the reason a drawn stick
          // feels twitchy next to a real one.
          //
          // A physical stick has a spring whose force rises with travel and a
          // thumb braced in a cup, so small deflections are easy to hold
          // steady. A thumb sliding on glass has neither, and the arc it
          // travels is a couple of centimetres end to end, so half of a walk
          // speed and half of a sprint are a few millimetres apart. Squaring
          // part of the response spends more of that arc on the slow half,
          // which is where aiming and creeping live, and still reaches 1.0 at
          // the rim so nothing is lost at the top.
          //
          // `EXPO` is the share that is curved: 0 would be the old linear
          // response, 1 a pure square that feels dead near centre.
          const shaped = linear * (1 - EXPO + EXPO * linear)
          const scale = shaped / magnitude
          queue(
            Math.max(-1, Math.min(1, nx * scale)),
            Math.max(-1, Math.min(1, ny * scale)),
          )
        } else {
          queue(0, 0)
        }
        return
      }

      const [up, right, down, left] = pad.directions!
      const wanted = new Set<number>()
      // A quarter of the travel. Below that a resting thumb sends nothing.
      if (distance > radius * 0.25) {
        moved.current = true
        // 22.5 degrees either side of each axis, so diagonals hold two keys.
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI
        if (angle > -157.5 && angle < -22.5) wanted.add(up)
        if (angle > 22.5 && angle < 157.5) wanted.add(down)
        if (angle > -67.5 && angle < 67.5) wanted.add(right)
        if (angle > 112.5 || angle < -112.5) wanted.add(left)
      }
      apply(wanted)
    },
    [apply, pad.directions, analog, axes, queue],
  )

  return (
    <div
      // Square for the same reason the buttons are; see `PlayPad`. A stick
      // matters more still: a thumb rolling out to the rim leaves the circle
      // before it leaves the box, so the corners are exactly where a hard push
      // lands.
      className="absolute grid place-items-center"
      style={style}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        moved.current = false
        if (haptics) tap()
        grab(event)
        track(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) track(event)
      }}
      onPointerUp={(event) => {
        // No click-to-press here. A thumb on glass cannot push straight down
        // without sliding, so pressing and aiming are the same gesture and the
        // binding either misfired or never fired. L3 and R3 are their own
        // buttons; see `DEFAULT_LAYOUT`.
        release()
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={release}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={pad.face === "lstick" ? "Left stick" : "Right stick"}
    >
      {/* Flat fill, no backdrop blur: see the note on the button span. */}
      <span className="pointer-events-none absolute inset-0 rounded-full border border-white/20 bg-black/40" />
      <span
        ref={nub}
        className="pointer-events-none absolute top-1/2 left-1/2 size-[45%] rounded-full border border-white/30 bg-white/25"
        style={{ transform: "translate(-50%, -50%)" }}
      />
    </div>
  )
})

function Segment({
  children,
  className,
  onDown,
  onUp,
}: {
  children: React.ReactNode
  className?: string
  onDown: (event: React.PointerEvent<HTMLElement>) => void
  onUp: (event: React.PointerEvent<HTMLElement>) => void
}) {
  return (
    <button
      className={cn(
        "grid place-items-center border border-white/20 bg-black/50 text-[10px] text-white/80",
        "active:bg-white/25",
        className,
      )}
      style={{ touchAction: "none" }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ edit -- */

type PadNode = Node<{ pad: Pad; skin: GamepadSkin; px: number }, "pad">

/**
 * Edit and play must agree to the pixel.
 *
 * Play positions a pad by its *centre*, as a percentage of the area, and sizes
 * it in `cqmin`. React Flow positions a node by its *top-left*, in pixels. Get
 * that conversion wrong and the editor becomes a lie: you arrange a controller,
 * press Done, and everything has moved. So the measured box is the single
 * source of truth and both directions of the conversion live here, next to each
 * other, rather than being re-derived at each call site.
 */
function toPixels(pad: Pad, w: number, h: number) {
  const px = (pad.size * Math.min(w, h)) / 100
  return {
    px,
    x: (pad.x / 100) * w - px / 2,
    y: (pad.y / 100) * h - px / 2,
  }
}

function toPercent(x: number, y: number, px: number, w: number, h: number) {
  return {
    x: ((x + px / 2) / w) * 100,
    y: ((y + px / 2) / h) * 100,
  }
}

const EditCanvas = memo(function EditCanvas({ pads, skin, onChange }: GamepadOverlayProps) {
  const box = useRef<HTMLDivElement | null>(null)
  // In state, not a ref: the nodes cannot be positioned until the box has been
  // measured, so the first render genuinely has to happen again once it has.
  // Only edit mode pays for this, and edit mode is not a hot path.
  const [area, setArea] = useState<{ w: number; h: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setArea({ w: rect.width, h: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * Where the pads are, derived from the layout.
   *
   * Recomputed only when the layout or the box changes, *not* on every render:
   * see `nodes` below for why that distinction is the whole difference between
   * a smooth drag and a stuttering one.
   */
  const derived = useMemo<PadNode[]>(() => {
    if (!area) return []
    return pads.map((pad) => {
      const { x, y, px } = toPixels(pad, area.w, area.h)
      return {
        id: pad.id,
        type: "pad" as const,
        position: { x, y },
        data: { pad, skin, px },
        // Dragging and resizing are the point; connecting them is meaningless.
        connectable: false,
        deletable: false,
      }
    })
  }, [pads, skin, area])

  /**
   * The nodes React Flow is actually driving.
   *
   * React Flow's `nodes` prop is controlled, and a controlled `nodes` without
   * `onNodesChange` cannot move: the library works out the dragged position,
   * the next render hands it the old one back, and the pad fights the pointer
   * the whole way. It looks like lag and it is really the node being reset
   * sixty times a second.
   *
   * So the positions live here and React Flow is allowed to update them, which
   * is the pattern its documentation asks for. The layout is only written back
   * to preferences when the drag ends; a write per pointer move would mean
   * serialising to `localStorage` on every frame.
   */
  const [nodes, setNodes] = useState<PadNode[]>(derived)

  // Adopt a new layout, but never mid-drag: replacing the nodes while the
  // pointer is down is the same fight in a different disguise.
  const dragging = useRef(false)
  useEffect(() => {
    if (dragging.current) return
    setNodes(derived)
  }, [derived])

  const onNodesChange = useCallback((changes: NodeChange<PadNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const onNodeDragStart = useCallback(() => {
    dragging.current = true
  }, [])

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      dragging.current = false
      if (!area) return
      onChange(
        pads.map((pad) => {
          if (pad.id !== node.id) return pad
          const { px } = toPixels(pad, area.w, area.h)
          return clampPad({ ...pad, ...toPercent(node.position.x, node.position.y, px, area.w, area.h) })
        }),
      )
    },
    [onChange, pads, area],
  )

  /** Resize from the corner handle, keeping the pad's centre where it was. */
  const resize = useCallback(
    (id: string, deltaPx: number) => {
      if (!area) return
      onChange(
        pads.map((pad) =>
          pad.id === id
            ? clampPad({ ...pad, size: pad.size + (deltaPx / Math.min(area.w, area.h)) * 100 })
            : pad,
        ),
      )
    },
    [onChange, pads, area],
  )

  return (
    // The same box play uses, so what you arrange is what you get.
    <PlayArea areaRef={box} interactive>
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        // A layout editor is not a diagram: panning and zooming the canvas
        // would move the pads relative to the game behind them, which is
        // exactly the thing being positioned. The viewport stays 1:1 so a
        // node's pixel position means the same thing as the play surface's.
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesConnectable={false}
        elementsSelectable
        // Spread rather than passed as `undefined`: this repo runs with
        // `exactOptionalPropertyTypes`, under which an explicit `undefined` is
        // not the same as an absent prop.
        {...(area ? { nodeExtent: [[0, 0], [area.w, area.h]] as [[number, number], [number, number]] } : {})}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
        onNodeClick={(_, node) => setSelected(node.id)}
        onPaneClick={() => setSelected(null)}
      >
        {/* The dots exist only here. See the module comment: a grid over a
            running game is an editor leaking into the product. */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} className="opacity-60" />
      </ReactFlow>
      <ResizeBar selected={selected} pads={pads} onResize={resize} />
    </PlayArea>
  )
})

/**
 * Resizing, as a pair of buttons rather than a drag handle.
 *
 * A corner handle on a circular pad is fiddly with a mouse and genuinely hard
 * with a finger, which is the input this editor is for. Two large buttons hit
 * the same requirement, work on a touchscreen, and are reachable by keyboard.
 */
const ResizeBar = memo(function ResizeBar({
  selected,
  pads,
  onResize,
}: {
  selected: string | null
  pads: Pad[]
  onResize: (id: string, deltaPx: number) => void
}) {
  const pad = pads.find((p) => p.id === selected)
  if (!pad) {
    return (
      <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-primary/70">
        Drag a control to move it. Tap one to resize.
      </p>
    )
  }
  return (
    <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border bg-card/95 p-1 backdrop-blur-md">
        <span className="px-2 text-xs text-muted-foreground">{pad.id}</span>
        <button
          className="size-8 rounded-md border text-lg leading-none active:bg-accent"
          onClick={() => onResize(pad.id, -16)}
          aria-label={`Make ${pad.id} smaller`}
        >
          &minus;
        </button>
        <button
          className="size-8 rounded-md border text-lg leading-none active:bg-accent"
          onClick={() => onResize(pad.id, 16)}
          aria-label={`Make ${pad.id} bigger`}
        >
          +
        </button>
      </div>
    </div>
  )
})

/**
 * No `backdrop-blur` here, and none on the playing pads either.
 *
 * A backdrop filter has to re-read and re-blur whatever is behind it whenever
 * either one changes, and behind these controls is a live video of the
 * desktop. This editor learned it first: a full-frame blur per pointer move
 * made dragging a pad feel like it was stepping rather than following. Play
 * mode kept its blur for a while on the theory that a pad which sits still
 * pays for the blur once. It does not: the *video* changes every frame, so
 * every pad was re-blurred every frame, and turning the overlay on visibly
 * lagged the stream.
 */
const PadNodeView = memo(function PadNodeView({ data }: NodeProps<PadNode>) {
  const { pad, skin, px } = data
  const label =
    pad.kind === "dpad"
      ? "\u271b"
      : pad.kind === "stick"
        ? "\u25c9"
        : pad.kind === "key"
          ? (pad.label ?? (pad.chord ? chordLabel(pad.chord) : "key"))
          : (SKIN_LABELS[skin]?.[pad.face] ?? pad.face)
  return (
    <div
      className={cn(
        "grid place-items-center border-2 border-dashed border-primary/70 bg-primary/25",
        "text-xs text-primary",
        pad.kind === "trigger" ? "rounded-lg" : "rounded-full",
      )}
      style={{ width: px, height: px }}
    >
      {label}
    </div>
  )
})

const NODE_TYPES = { pad: PadNodeView }
