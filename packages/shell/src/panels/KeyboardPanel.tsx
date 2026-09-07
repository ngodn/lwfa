/**
 * Keyboard settings.
 *
 * The keyboard itself is not here: it docks across the bottom of the viewport,
 * because that is the only place a two-thumb reach works. See `lib/dock.ts`.
 * This panel is what the gear inside the dock opens.
 */

import { memo } from "react"
import { Keyboard as KeyboardIcon } from "lucide-react"
import { getPrefs, patchPrefs, usePrefs } from "@/lib/prefs"
import { setDock, useDock } from "@/lib/dock"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Field, FieldRow, PanelGroup, PanelSection } from "@/panels/parts"
import { PlacementChoice, hapticHintProp } from "@/panels/placement"

function KeyboardPanel() {
  const prefs = usePrefs()
  const dock = useDock()
  const hapticHint = hapticHintProp().hint

  return (
    <div className="space-y-[15px]">
      <PanelSection>
        <PanelGroup>
          <FieldRow>
            <Field label="Show the keyboard" />
            <Button
              size="sm"
              variant={dock === "keyboard" ? "default" : "outline"}
              className="gap-1.5"
              aria-pressed={dock === "keyboard"}
              onClick={() => setDock(dock === "keyboard" ? "none" : "keyboard")}
            >
              <KeyboardIcon className="size-3.5" aria-hidden />
              {dock === "keyboard" ? "Hide" : "Show"}
            </Button>
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection title="Keys">
        <PanelGroup>
          <FieldRow>
            <Field label="Show the Escape button" hint="A one-tap Escape button in the navigation bar." />
            <Switch
              aria-label="Show the Escape button"
              checked={!prefs.nav.hidden.includes("escape")}
              onCheckedChange={(show) => {
                // Written to the same `hidden` set the Settings panel edits, so
                // there is one source of truth and the two cannot disagree about
                // whether the button exists.
                const hidden = new Set(getPrefs().nav.hidden)
                if (show) hidden.delete("escape")
                else hidden.add("escape")
                patchPrefs("nav", { hidden: [...hidden] })
              }}
            />
          </FieldRow>
          <FieldRow>
            <Field label="Start in combo mode" hint="Holds modifiers until you tap them again." />
            <Switch
              aria-label="Start in combo mode"
              checked={prefs.keyboard.stickyModifiers}
              onCheckedChange={(stickyModifiers) =>
                patchPrefs("keyboard", { stickyModifiers })
              }
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection
        title="Placement"
        description="Stacked reduces the desktop to make room for the keyboard."
      >
        <PlacementChoice
          value={prefs.keyboard.placement}
          onChange={(placement) => patchPrefs("keyboard", { placement })}
          label="Keyboard placement"
        />
      </PanelSection>

      <PanelSection title="Haptics" {...(hapticHint ? { description: hapticHint } : {})}>
        <PanelGroup>
          <FieldRow>
            <Field label="Vibrate on press" />
            <Switch
              aria-label="Vibrate on press"
              checked={prefs.keyboard.haptics}
              onCheckedChange={(haptics) => patchPrefs("keyboard", { haptics })}
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>
    </div>
  )
}

export default memo(KeyboardPanel)
