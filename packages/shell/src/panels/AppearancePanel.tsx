/**
 * Appearance: light, dark, or follow the device, and how things move.
 */

import { memo } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { patchPrefs, setPrefs, usePrefs, type ThemeMode } from "@/lib/prefs"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"
import { Switch } from "@/components/ui/switch"

const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

function AppearancePanel() {
  const prefs = usePrefs()

  return (
    <div className="space-y-6 pt-2">
      <PanelSection
        title="Theme"
        description="System follows your device setting."
      >
        <ToggleGroup
          type="single"
          value={prefs.theme}
          // Radix fires with "" when you press the active item. Ignoring that
          // keeps a theme selected: there is no third state to fall into.
          onValueChange={(value) => value && setPrefs((p) => ({ ...p, theme: value as ThemeMode }))}
          variant="outline"
          className="w-full"
        >
          {MODES.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value} aria-label={label} className="flex-1 gap-2">
              <Icon className="size-4" aria-hidden />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      {/* Both of these are about how the desktop *moves*, which is what this
        * panel is for. "Animate windows" lived under Settings > Stream, where
        * it had nothing to do with the video stream or with anything else on
        * that tab; it is a look, and this is where looks are chosen. */}
      <PanelSection title="Movement">
        <FieldRow>
          <Field
            label="Animate windows"
            hint={prefs.motion.animate ? "Windows slide" : "Windows jump"}
          />
          <Switch
            checked={prefs.motion.animate}
            onCheckedChange={(animate) => patchPrefs("motion", { animate })}
            aria-label="Animate windows"
          />
        </FieldRow>
        <FieldRow>
          <Field
            label="Follow the engine's scroll"
            hint="Mirror the desktop's scroll position."
          />
          <Switch
            checked={prefs.followEngineScroll}
            onCheckedChange={(followEngineScroll) =>
              setPrefs((p) => ({ ...p, followEngineScroll }))
            }
          />
        </FieldRow>
      </PanelSection>

      <PanelSection
        title="Touch feedback"
        description="Vibrate when a control is pressed."
      >
        <FieldRow>
          <Label htmlFor="kb-haptics" className="font-normal">
            Keyboard
          </Label>
          <Switch
            id="kb-haptics"
            checked={prefs.keyboard.haptics}
            onCheckedChange={(haptics) => patchPrefs("keyboard", { haptics })}
          />
        </FieldRow>
        <FieldRow>
          <Label htmlFor="gp-haptics" className="font-normal">
            Gamepad
          </Label>
          <Switch
            id="gp-haptics"
            checked={prefs.gamepad.haptics}
            onCheckedChange={(haptics) => patchPrefs("gamepad", { haptics })}
          />
        </FieldRow>
      </PanelSection>
    </div>
  )
}

export default memo(AppearancePanel)
