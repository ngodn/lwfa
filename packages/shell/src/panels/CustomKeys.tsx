/**
 * Adding keyboard buttons to the controller.
 *
 * # Why the controller needs these
 *
 * A controller has seventeen controls and a game often wants an eighteenth
 * thing that is not one of them: a quicksave, a console, a screenshot, a mod
 * menu, a photo mode. On a desk that is one key on the keyboard next to you.
 * From a tablet the keyboard is a separate surface that covers the game, so
 * reaching a single shortcut means closing the controller, opening the
 * keyboard, finding the key and going back.
 *
 * So a chord can be a button on the pad, sitting next to the controls it is
 * used with.
 *
 * # Why they are not in the default layout
 *
 * Because which one you want is entirely about the game. There is no chord
 * that belongs on a controller by default, and a default full of somebody
 * else's guesses is worse than an empty list. `DEFAULT_LAYOUT` stays a
 * controller; this is what you add on top.
 *
 * # Why a picker and not a capture box
 *
 * Capturing "press the keys you want" is faster and useless on the device this
 * is for: an iPad with no keyboard attached cannot press Alt. Toggles and a
 * list work everywhere, and the list is the same key set the on-screen
 * keyboard already defines rather than a second table to keep in step.
 */

import { memo, useMemo, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  EXTRA_KEYS,
  FUNCTION_ROW,
  MAIN_ROWS,
  MODIFIER_CODES,
  type ModifierId,
} from "@/keyboard/layout"
import { chordLabel, clampPad, type Pad } from "@/gamepad/model"
import { useGamepad, useSetPads } from "@/gamepad/store"
import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/panels/parts"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"

const MODIFIERS: { id: ModifierId; label: string }[] = [
  { id: "ctrl", label: "Ctrl" },
  { id: "shift", label: "Shift" },
  { id: "alt", label: "Alt" },
  { id: "super", label: "Super" },
]

/** Where a new button lands: middle of the play area, clear of everything. */
const DROP_X = 50
const DROP_Y = 62

export const CustomKeys = memo(function CustomKeys() {
  const { pads } = useGamepad()
  const setPads = useSetPads()
  const [held, setHeld] = useState<Set<ModifierId>>(() => new Set())
  const [code, setCode] = useState<number | null>(null)

  const custom = pads.filter((pad) => pad.kind === "key")

  /**
   * Every bindable key, once.
   *
   * Modifiers are filtered out: they are the toggles above, and a chord whose
   * key is Shift is a chord that does nothing.
   */
  const keys = useMemo(() => {
    const seen = new Set<number>()
    return [...MAIN_ROWS.flat(), ...FUNCTION_ROW, ...EXTRA_KEYS]
      .filter((key) => key.modifier === undefined)
      .filter((key) => (seen.has(key.code) ? false : (seen.add(key.code), true)))
  }, [])

  const chord =
    code === null
      ? null
      : [...MODIFIERS.filter((m) => held.has(m.id)).map((m) => MODIFIER_CODES[m.id]), code]

  const add = () => {
    if (!chord) return
    const pad: Pad = clampPad({
      // Time-based so two buttons with the same chord stay distinct, which the
      // layout needs because it keys on id.
      id: `key-${Date.now().toString(36)}`,
      kind: "key",
      face: "key",
      x: DROP_X,
      y: DROP_Y,
      size: 11,
      chord,
    })
    setPads([...pads, pad])
    setHeld(new Set())
    setCode(null)
  }

  return (
    <div className="space-y-3">
      {custom.length > 0 ? (
        <ul className="space-y-1.5">
          {custom.map((pad) => (
            <li key={pad.id} className="flex items-center gap-2">
              <span className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
                {pad.label ?? (pad.chord ? chordLabel(pad.chord) : "key")}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                aria-label={`Remove ${pad.chord ? chordLabel(pad.chord) : "button"}`}
                onClick={() => setPads(pads.filter((other) => other.id !== pad.id))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {MODIFIERS.map(({ id, label }) => (
          <Toggle
            key={id}
            size="sm"
            variant="outline"
            pressed={held.has(id)}
            onPressedChange={(on) =>
              setHeld((prev) => {
                const next = new Set(prev)
                if (on) next.add(id)
                else next.delete(id)
                return next
              })
            }
            className="h-7 px-2 text-xs"
          >
            {label}
          </Toggle>
        ))}
      </div>

      <div
        className="grid max-h-44 grid-cols-[repeat(auto-fill,minmax(2.6rem,1fr))] gap-1 overflow-y-auto rounded-md border p-1.5"
        role="listbox"
        aria-label="Key"
      >
        {keys.map((key) => (
          <button
            key={key.code}
            type="button"
            role="option"
            aria-selected={code === key.code}
            onClick={() => setCode(key.code === code ? null : key.code)}
            className={cn(
              "rounded px-1 py-1 text-[0.65rem] leading-tight",
              "border border-transparent hover:bg-accent",
              code === key.code && "border-primary bg-primary/15 font-medium",
            )}
          >
            {key.legend}
          </button>
        ))}
      </div>

      <FieldRow>
        <Field
          label={chord ? chordLabel(chord) : "Pick a key"}
          hint={chord ? "Lands in the middle; drag it in edit mode." : "Modifiers are optional."}
        />
        <Button size="sm" className="gap-1.5" disabled={!chord} onClick={add}>
          <Plus className="size-3.5" aria-hidden />
          Add
        </Button>
      </FieldRow>
    </div>
  )
})
