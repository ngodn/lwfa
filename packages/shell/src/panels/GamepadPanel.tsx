/**
 * Gamepad settings: whether it is showing, how it looks, and the edit mode.
 *
 * The pad itself is drawn over the desktop by `GamepadOverlay`, not in here.
 * A controller inside a side panel would be unusable: it has to be over the
 * thing it is controlling, and it has to stay there after this panel closes.
 */

import { memo, useRef, useState } from "react"
import {
  ClipboardPaste,
  Copy,
  Download,
  Gamepad2,
  Pencil,
  RotateCcw,
  Upload,
} from "lucide-react"
import { patchPrefs, usePrefs, type GamepadSkin } from "@/lib/prefs"
import { DEFAULT_LAYOUT } from "@/gamepad/model"
import { backupFilename, makeBackup, readBackup } from "@/gamepad/backup"
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
          <Field label="Show the gamepad" hint="Drawn over the desktop." />
          <Switch
            checked={visible}
            onCheckedChange={(v) => setGamepad({ visible: v, editing: v ? editing : false })}
          />
        </FieldRow>
        <FieldRow>
          <Field
            label="Edit layout"
            hint="Drag the controls to rearrange them."
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
        <Backup />
      </PanelSection>

      <PanelSection
        title="Buttons"
        description="Changes button labels only."
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
          <Field label="Vibrate on press" />
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
            Turn the gamepad on to edit it.
          </p>
        ) : null}
      </PanelSection>
    </div>
  )
}

/**
 * Backup and restore: the whole controller, not only its arrangement.
 *
 * See `gamepad/backup.ts` for what "whole" means and why a file is offered
 * alongside the clipboard.
 */
const Backup = memo(function Backup() {
  const { pads } = useGamepad()
  const prefs = usePrefs()
  const [copied, setCopied] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const file = useRef<HTMLInputElement | null>(null)

  const bundle = () => makeBackup(pads, prefs.gamepad)

  const apply = (text: string) => {
    const result = readBackup(text)
    if (!result.ok) {
      setProblem(result.problem)
      setRestored(false)
      return
    }
    // Pads first: the store persists them, and a failure to write settings
    // afterwards should still leave the arrangement restored.
    setGamepad({ pads: result.backup.pads })
    patchPrefs("gamepad", result.backup.settings)
    setProblem(null)
    setRestored(true)
    setPasting(false)
    setPasted("")
    globalThis.setTimeout(() => setRestored(false), 2500)
  }

  return (
    <>
      <FieldRow>
        <Field
          label="Save a backup"
          hint="Layout, sizes, positions and every setting on this panel."
        />
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              const text = JSON.stringify(bundle(), null, 1)
              const url = URL.createObjectURL(
                new Blob([text], { type: "application/json" }),
              )
              const link = document.createElement("a")
              link.href = url
              link.download = backupFilename()
              link.click()
              // Revoked on the next tick rather than immediately: Safari has
              // not necessarily started reading the blob when `click` returns.
              globalThis.setTimeout(() => URL.revokeObjectURL(url), 10_000)
            }}
          >
            <Download className="size-3.5" aria-hidden />
            File
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(JSON.stringify(bundle(), null, 1))
                .then(() => {
                  setCopied(true)
                  globalThis.setTimeout(() => setCopied(false), 1500)
                })
                .catch(() => {})
            }}
          >
            <Copy className="size-3.5" aria-hidden />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </FieldRow>

      <FieldRow>
        <Field label="Restore" hint="Replaces the controller with a saved one." />
        <div className="flex gap-1.5">
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const chosen = event.target.files?.[0]
              // Cleared so choosing the same file twice fires again.
              event.target.value = ""
              if (!chosen) return
              void chosen
                .text()
                .then(apply)
                .catch(() => setProblem("That file could not be read."))
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => file.current?.click()}
          >
            <Upload className="size-3.5" aria-hidden />
            File
          </Button>
          <Button
            size="sm"
            variant={pasting ? "default" : "outline"}
            className="gap-1.5"
            aria-pressed={pasting}
            onClick={() => {
              setPasting((open) => !open)
              setProblem(null)
            }}
          >
            <ClipboardPaste className="size-3.5" aria-hidden />
            Paste
          </Button>
        </div>
      </FieldRow>

      {pasting ? (
        <div className="space-y-2">
          <textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="Paste a backup here"
            aria-label="Backup text"
            className="w-full rounded-md border bg-transparent p-2 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <Button
            size="sm"
            className="w-full"
            disabled={pasted.trim() === ""}
            onClick={() => apply(pasted)}
          >
            Restore from text
          </Button>
        </div>
      ) : null}

      {problem ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {restored ? (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          Controller restored.
        </p>
      ) : null}
    </>
  )
})

export default memo(GamepadPanel)
