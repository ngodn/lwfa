/**
 * Virtual-mouse settings.
 *
 * The mouse itself is not here: it floats over the desktop as a surface you tap
 * through, like the gamepad. See `mouse/MouseOverlay` and `lib/mouse.ts`. This
 * panel is what the gear inside the dock opens.
 */

import { memo } from "react"
import { Mouse } from "lucide-react"

import { patchPrefs, usePrefs } from "@/lib/prefs"
import { setDock, useDock } from "@/lib/dock"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelGroup, PanelSection } from "@/panels/parts"
import { PlacementChoice, hapticHintProp } from "@/panels/placement"

function MousePanel() {
  const prefs = usePrefs()
  const dock = useDock()
  const hapticHint = hapticHintProp().hint

  return (
    <div className="space-y-[15px]">
      <PanelSection>
        <PanelGroup>
          <FieldRow>
            <Field label="Show the mouse" hint="A tap becomes a real click." />
            <Button
              size="sm"
              variant={dock === "mouse" ? "default" : "outline"}
              className="gap-1.5"
              aria-pressed={dock === "mouse"}
              onClick={() => setDock(dock === "mouse" ? "none" : "mouse")}
            >
              <Mouse className="size-3.5" aria-hidden />
              {dock === "mouse" ? "Hide" : "Show"}
            </Button>
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection
        title="Default button"
        description="Change it live from the buttons on the mouse surface."
      >
        <ToggleGroup
          type="single"
          value={prefs.mouse.defaultButton}
          onValueChange={(value) => {
            if (value === "left" || value === "right" || value === "middle") {
              patchPrefs("mouse", { defaultButton: value })
            }
          }}
          className="grid w-full grid-cols-3"
        >
          <ToggleGroupItem value="left">Left</ToggleGroupItem>
          <ToggleGroupItem value="right">Right</ToggleGroupItem>
          <ToggleGroupItem value="middle">Middle</ToggleGroupItem>
        </ToggleGroup>
      </PanelSection>

      <PanelSection
        title="Scrolling"
      >
        <PanelGroup>
          <FieldRow>
            <Field label="Scroll speed" hint="Matches the desktop by default." />
            <Slider
              className="w-[min(40%,150px)] shrink-0"
              min={0.1}
              max={1.5}
              step={0.05}
              value={[prefs.mouse.scrollSpeed]}
              onValueChange={(value) => patchPrefs("mouse", { scrollSpeed: value[0] ?? prefs.mouse.scrollSpeed })}
              aria-label="Scroll speed"
            />
          </FieldRow>
          <FieldRow>
            <Field label="Natural scrolling" hint="Contents follow your finger." />
            <Switch
              aria-label="Natural scrolling"
              checked={prefs.mouse.naturalScroll}
              onCheckedChange={(naturalScroll) => patchPrefs("mouse", { naturalScroll })}
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection
        title="Placement"
        description="Stacked reduces the desktop to make room for the mouse."
      >
        <PlacementChoice
          value={prefs.mouse.placement}
          onChange={(placement) => patchPrefs("mouse", { placement })}
          label="Mouse placement"
        />
      </PanelSection>

      <PanelSection title="Haptics" {...(hapticHint ? { description: hapticHint } : {})}>
        <PanelGroup>
          <FieldRow>
            <Field label="Vibrate on press" />
            <Switch
              aria-label="Vibrate on press"
              checked={prefs.mouse.haptics}
              onCheckedChange={(haptics) => patchPrefs("mouse", { haptics })}
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>
    </div>
  )
}

export default memo(MousePanel)
