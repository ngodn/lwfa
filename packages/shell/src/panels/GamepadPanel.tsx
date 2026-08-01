/**
 * Gamepad settings: whether it is showing, how it looks, and the edit mode.
 *
 * The pad itself is drawn over the desktop by `GamepadOverlay`, not in here.
 * A controller inside a side panel would be unusable: it has to be over the
 * thing it is controlling, and it has to stay there after this panel closes.
 */

import { memo } from "react"
import { Gamepad2, Pencil, RotateCcw } from "lucide-react"
import { patchPrefs, usePrefs, type GamepadSkin } from "@/lib/prefs"
import { DEFAULT_LAYOUT } from "@/gamepad/model"
import { setGamepad, useGamepad } from "@/gamepad/store"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"

const SKINS: { value: GamepadSkin; label: string; sample: string }[] = [
  { value: "playstation", label: "PlayStation", sample: "△ ✕ ○ □" },
  { value: "xbox", label: "Xbox", sample: "Y A B X" },
  { value: "neutral", label: "Neutral", sample: "N S E W" },
]

function GamepadPanel() {
  const prefs = usePrefs()
  const { visible, editing } = useGamepad()

  return (
    <div className="space-y-6 pt-2">
      <PanelSection>
        <FieldRow>
          <Field label="Show the gamepad" hint="Drawn over the desktop, above every window." />
          <Switch
            checked={visible}
            onCheckedChange={(v) => setGamepad({ visible: v, editing: v ? editing : false })}
          />
        </FieldRow>
        <FieldRow>
          <Field
            label="Edit layout"
            hint="Drag the pads to rearrange them. The dot grid appears only while editing."
          />
          <Button
            size="sm"
            variant={editing ? "default" : "outline"}
            className="gap-1.5"
            disabled={!visible}
            aria-pressed={editing}
            onClick={() => setGamepad({ editing: !editing })}
          >
            <Pencil className="size-3.5" aria-hidden />
            {editing ? "Done" : "Edit"}
          </Button>
        </FieldRow>
      </PanelSection>

      <PanelSection
        title="Buttons"
        description="Labels only. What each control sends does not change with the skin."
      >
        <ToggleGroup
          type="single"
          value={prefs.gamepad.skin}
          onValueChange={(v) => v && patchPrefs("gamepad", { skin: v as GamepadSkin })}
          variant="outline"
          className="grid w-full grid-cols-3"
        >
          {SKINS.map(({ value, label, sample }) => (
            <ToggleGroupItem key={value} value={value} className="h-auto flex-col gap-0.5 py-2">
              <span className="text-xs">{label}</span>
              <span className="text-[10px] opacity-70">{sample}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      <PanelSection title="Opacity">
        <div className="flex items-center gap-3">
          <Slider
            value={[prefs.gamepad.opacity]}
            min={0.2}
            max={1}
            step={0.05}
            onValueChange={([opacity]) =>
              opacity !== undefined && patchPrefs("gamepad", { opacity })
            }
            className="flex-1"
            aria-label="Gamepad opacity"
          />
          <span className="w-10 text-right font-mono text-xs text-muted-foreground">
            {Math.round(prefs.gamepad.opacity * 100)}%
          </span>
        </div>
      </PanelSection>

      <PanelSection title="Feedback">
        <FieldRow>
          <Field label="Vibrate on press" hint="Ignored on devices with no vibration motor." />
          <Switch
            checked={prefs.gamepad.haptics}
            onCheckedChange={(haptics) => patchPrefs("gamepad", { haptics })}
          />
        </FieldRow>
      </PanelSection>

      <PanelSection title="Layout">
        <FieldRow>
          <Field
            label="Restore the default arrangement"
            hint="WASD on the left, face buttons on the right, triggers along the top."
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => setGamepad({ pads: DEFAULT_LAYOUT })}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </Button>
        </FieldRow>
        {!visible ? (
          <p className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <Gamepad2 className="size-4 shrink-0" aria-hidden />
            Switch the gamepad on to see and edit it.
          </p>
        ) : null}
      </PanelSection>
    </div>
  )
}

export default memo(GamepadPanel)
