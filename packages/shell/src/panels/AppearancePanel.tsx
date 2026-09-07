/**
 * Appearance: light, dark, or follow the device, and how things move.
 */

import { memo } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { patchPrefs, setPrefs, usePrefs, type ThemeMode } from "@/lib/prefs"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelGroup, PanelSection } from "@/panels/parts"
import { Switch } from "@/components/ui/switch"

const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

function AppearancePanel() {
  const prefs = usePrefs()

  return (
    <div className="space-y-[15px]">
      <PanelSection
        title="Theme"
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
      <PanelSection title="Motion">
        <PanelGroup>
          <FieldRow>
            <Field label="Animate window movement" />
            <Switch
              checked={prefs.motion.animate}
              onCheckedChange={(animate) => patchPrefs("motion", { animate })}
              aria-label="Animate window movement"
            />
          </FieldRow>
          <FieldRow>
            <Field label="Mirror the desktop's scroll" />
            <Switch
              aria-label="Mirror the desktop's scroll"
              checked={prefs.followEngineScroll}
              onCheckedChange={(followEngineScroll) =>
                setPrefs((p) => ({ ...p, followEngineScroll }))
              }
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection
        title="Haptics"
      >
        <PanelGroup>
          <FieldRow>
            <Label htmlFor="kb-haptics" className="text-[13.5px] font-medium">
              Keyboard
            </Label>
            <Switch
              id="kb-haptics"
              checked={prefs.keyboard.haptics}
              onCheckedChange={(haptics) => patchPrefs("keyboard", { haptics })}
            />
          </FieldRow>
          <FieldRow>
            <Label htmlFor="gp-haptics" className="text-[13.5px] font-medium">
              Gamepad
            </Label>
            <Switch
              id="gp-haptics"
              checked={prefs.gamepad.haptics}
              onCheckedChange={(haptics) => patchPrefs("gamepad", { haptics })}
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>
    </div>
  )
}

export default memo(AppearancePanel)
