/**
 * The keyboard surface itself.
 *
 * Rendered in the dock across the bottom of the viewport, not in a side panel.
 * See `lib/dock.ts` for why that distinction matters more than it looks.
 *
 * # Two modes, because one finger cannot hold three keys
 *
 * **Normal** is what a keyboard does: press, the key goes down and comes back
 * up. Modifiers latch for exactly one keypress, so tapping Shift then `a` sends
 * `A` and the Shift releases itself, which is what a one-finger user means.
 *
 * **Combo** keeps the modifiers held until you press them again. That is the
 * mode for what a latch cannot express: holding Ctrl across three different
 * keys, or holding Ctrl+Alt while hunting for F2. Nothing is sent until a
 * non-modifier is pressed, and what *will* be sent is shown as it is built, so
 * `Ctrl + Alt + ...` is visible before committing to it.
 *
 * # Why the keys are keycodes
 *
 * See `keyboard/layout.ts`: the remote machine owns the keymap, so this sends
 * physical keys and lets the far end decide what they mean.
 */

import { tap as haptic } from "@/lib/haptics"
import { memo, useCallback, useMemo, useState } from "react"
import { CornerDownLeft, Zap } from "lucide-react"
import { useSessionActions } from "@/session"
import { usePrefSection } from "@/lib/prefs"
import {
  COMBOS,
  EXTRA_KEYS,
  FUNCTION_ROW,
  MAIN_ROWS,
  MODIFIER_CODES,
  type Combo,
  type KeyDef,
  type ModifierId,
} from "@/keyboard/layout"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const MODIFIER_ORDER: ModifierId[] = ["ctrl", "alt", "shift", "super"]

export const Keyboard = memo(function Keyboard() {
  const actions = useSessionActions()
  const keyboardPrefs = usePrefSection("keyboard")
  const [held, setHeld] = useState<Set<ModifierId>>(() => new Set())
  const [sticky, setSticky] = useState(false)
  const [extras, setExtras] = useState(false)

  const buzz = useCallback(() => {
    if (keyboardPrefs.haptics) haptic(8)
  }, [keyboardPrefs.haptics])

  /** Press and release one key, wrapped in whatever modifiers are held. */
  const tap = useCallback(
    (code: number, modifiers: ModifierId[]) => {
      // Down in order, up in reverse. A client watching modifier state then
      // sees a sequence it could have got from real hardware; releasing out of
      // order leaves some applications convinced Ctrl is still down.
      for (const modifier of modifiers) {
        actions.send({ type: "key", key: MODIFIER_CODES[modifier], pressed: true })
      }
      actions.send({ type: "key", key: code, pressed: true })
      actions.send({ type: "key", key: code, pressed: false })
      for (const modifier of [...modifiers].reverse()) {
        actions.send({ type: "key", key: MODIFIER_CODES[modifier], pressed: false })
      }
    },
    [actions],
  )

  const press = useCallback(
    (key: KeyDef) => {
      buzz()
      const modifier = key.modifier
      if (modifier) {
        setHeld((prev) => {
          const next = new Set(prev)
          if (next.has(modifier)) next.delete(modifier)
          else next.add(modifier)
          return next
        })
        return
      }
      const modifiers = MODIFIER_ORDER.filter((m) => held.has(m))
      tap(key.code, modifiers)
      // In combo mode the modifiers stay down until tapped off. That is the
      // entire difference between the two modes.
      if (!sticky && modifiers.length > 0) setHeld(new Set())
    },
    [buzz, held, sticky, tap],
  )

  const fire = useCallback(
    (combo: Combo) => {
      buzz()
      tap(combo.code, combo.modifiers)
    },
    [buzz, tap],
  )

  const pending = useMemo(
    () => MODIFIER_ORDER.filter((m) => held.has(m)).map(labelOf).join(" + "),
    [held],
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant={sticky ? "default" : "outline"}
          className="h-8 gap-1.5"
          onClick={() => {
            setSticky((v) => !v)
            setHeld(new Set())
          }}
          aria-pressed={sticky}
          title="Keep modifiers held until tapped again"
        >
          <Zap className="size-3.5" aria-hidden />
          {sticky ? "Combo" : "Normal"}
        </Button>
        <Button
          size="sm"
          variant={extras ? "secondary" : "outline"}
          className="h-8"
          onClick={() => setExtras((v) => !v)}
          aria-pressed={extras}
          title="Insert, Home, Page Up and other full-size keys"
        >
          More keys
        </Button>
        {held.size > 0 ? (
          <button
            className="rounded-md bg-primary/15 px-2 py-1 font-mono text-xs text-primary"
            onClick={() => setHeld(new Set())}
            aria-label="Clear held modifiers"
          >
            {pending} + ...
          </button>
        ) : null}
        <div className="ml-auto flex gap-1 overflow-x-auto">
          {COMBOS.slice(0, 6).map((combo) => (
            <button
              key={combo.label}
              onClick={() => fire(combo)}
              title={combo.hint}
              className="shrink-0 rounded-md border bg-card px-2 py-1 font-mono text-[10px] active:bg-accent"
            >
              {combo.label}
            </button>
          ))}
        </div>
      </div>

      {/* Escape and the function row are always here, never behind a toggle.
          Escape is the single most-pressed key on a machine running vim, a
          terminal, or anything with a dialog, and a keyboard that makes you
          find a switch before you can press it fails at its one job. The row
          costs the same height as the number row below it.
          
          What *is* behind the toggle is the full-size tail: Insert, Home, Page
          Up, Print Screen, Scroll Lock. Those are the keys you go a week
          without touching. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <KeyRow keys={FUNCTION_ROW} held={held} onPress={press} />
        {MAIN_ROWS.map((row, index) => (
          <KeyRow key={index} keys={row} held={held} onPress={press} />
        ))}
        {extras ? <KeyRow keys={EXTRA_KEYS} held={held} onPress={press} /> : null}
      </div>
    </div>
  )
})

const KeyRow = memo(function KeyRow({
  keys,
  held,
  onPress,
}: {
  keys: KeyDef[]
  held: Set<ModifierId>
  onPress: (key: KeyDef) => void
}) {
  return (
    // A size container, so a key's legend can be sized from the key rather than
    // from a fixed number of pixels. The rows share the dock's height between
    // them, which means a key is a different size on a phone, on a tablet, and
    // on a dock the user has dragged taller, while `text-xs` was the same 12px
    // in all three: shrunken on the tablet, cramped on the phone.
    <div className="flex min-h-0 flex-1 gap-1" style={{ containerType: "size" }}>
      {keys.map((key) => (
        <Key key={`${key.code}-${key.legend}`} def={key} held={held} onPress={onPress} />
      ))}
    </div>
  )
})

const Key = memo(function Key({
  def,
  held,
  onPress,
}: {
  def: KeyDef
  held: Set<ModifierId>
  onPress: (key: KeyDef) => void
}) {
  const latched = def.modifier ? held.has(def.modifier) : false
  const shift = held.has("shift")
  const legend = shift ? (def.shifted ?? def.legend.toUpperCase()) : def.legend

  return (
    <button
      // `onPointerDown`, not `onClick`: a keyboard should respond when the
      // finger lands, not when it lifts. That difference is what separates
      // feeling like a keyboard from feeling like a web page.
      onPointerDown={(event) => {
        event.preventDefault()
        onPress(def)
      }}
      style={{ flexGrow: def.width ?? 1, flexBasis: 0, containerType: "size" }}
      aria-label={def.legend}
      aria-pressed={def.modifier ? latched : undefined}
      className={cn(
        // `tabular-nums` so the number row's digits are all the same width and
        // the row does not look hand-set; `tracking-tight` because a legend is
        // one word on a small surface, not running text.
        "min-h-0 min-w-0 rounded-md border bg-background font-medium tracking-tight tabular-nums select-none",
        "transition-colors active:bg-accent active:scale-95",
        // Guarded, because a `hover:` style on a touch surface sticks after a
        // tap and leaves a trail of keys looking pressed.
        "[@media(hover:hover)]:hover:bg-accent",
        latched && "border-primary bg-primary/15 text-primary",
      )}
    >
      <span
        className="grid size-full place-items-center overflow-hidden"
        style={{ fontSize: legendSize(legend) }}
      >
        {def.legend === "Enter" ? (
          <CornerDownLeft className="size-[1.3em]" aria-hidden />
        ) : (
          legend
        )}
      </span>
    </button>
  )
})

/**
 * How big a key's legend is, measured against the key it sits on.
 *
 * A physical keycap's letter is roughly half the height of the cap, and every
 * software keyboard worth copying follows it: the letter *is* the key, and the
 * words on the modifiers are labels for it. A fixed 12px was neither, being
 * cramped on a phone and lost on a tablet, where the same 12px sits on a key
 * three times the width.
 *
 * Two limits, whichever is smaller. Height gives a letter its share of the cap.
 * Width is what a word needs: `Shift` has to fit across its key, and its key is
 * wide, so on a tablet it is the height that binds and on a phone the width.
 * Each key is its own container, so both are the real key rather than the row.
 *
 * Clamped at both ends rather than left purely proportional: below about 9px a
 * legend stops being readable at arm's length whatever the key is doing, and
 * above about 22px a letter starts to look like a headline.
 */
function legendSize(legend: string): string {
  const chars = Math.max(legend.length, 1)
  // 0.55em per character, with a little of the key left either side.
  const forWidth = (95 / (0.55 * chars)).toFixed(1)
  const forHeight = chars <= 1 ? 48 : 40
  return `clamp(9px, min(${forHeight}cqh, ${forWidth}cqw), 22px)`
}

function labelOf(id: ModifierId): string {
  return id === "ctrl" ? "Ctrl" : id === "alt" ? "Alt" : id === "shift" ? "Shift" : "Super"
}
