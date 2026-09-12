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
  Plus,
  Pencil,
  RotateCcw,
  Upload,
} from "lucide-react"
import { patchPrefs, usePrefs, type GamepadSkin } from "@/lib/prefs"
import { DEFAULT_LAYOUT } from "@/gamepad/model"
import { backupFilename, makeBackup, readBackup } from "@/gamepad/backup"
import { setGamepad, useGamepad } from "@/gamepad/store"
import { controllerTrace } from "@/gamepad/diagnostics"
import { resetPhysicalGamepad } from "@/gamepad/recovery"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelGroup, PanelSection } from "@/panels/parts"
import { PlacementChoice, hapticHintProp } from "@/panels/placement"
import { CustomKeys } from "@/panels/CustomKeys"
import { setDock, useDock } from "@/lib/dock"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GamingPanel } from "@/panels/GamingPanel"

const SKINS: { value: GamepadSkin; label: string; sample: string }[] = [
  { value: "playstation", label: "PlayStation", sample: "△ ✕ ○ □" },
  { value: "xbox", label: "Xbox", sample: "Y A B X" },
  { value: "neutral", label: "Neutral", sample: "N S E W" },
]

function ControllerControls() {
  const prefs = usePrefs()
  const { editing } = useGamepad()
  const visible = useDock() === "gamepad"
  const hapticHint = hapticHintProp().hint

  return (
    <div className="space-y-[15px]">
      <PanelGroup>
        <FieldRow>
          <Field label="Show the gamepad" />
          <Switch
            checked={visible}
            onCheckedChange={(show) => {
              if (!show) setGamepad({ editing: false })
              setDock(show ? "gamepad" : "none")
            }}
            aria-label="Show the gamepad"
          />
        </FieldRow>
        <FieldRow>
          <Field label="Edit layout" hint={visible ? "Drag the controls to rearrange them." : "Turn the gamepad on first."} />
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
      </PanelGroup>

      <PanelSection title="Labels">
        <ToggleGroup
          type="single"
          value={prefs.gamepad.skin}
          onValueChange={(v) => v && patchPrefs("gamepad", { skin: v as GamepadSkin })}
          variant="outline"
          className="grid w-full grid-cols-3"
          aria-label="Gamepad button labels"
        >
          {SKINS.map(({ value, label, sample }) => (
            <ToggleGroupItem key={value} value={value} className="h-auto flex-col gap-0.5 px-1 py-2">
              <span className="text-xs">{label}</span>
              <span className="text-[10px] opacity-70">{sample}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      <PanelSection title="Opacity">
        <PanelGroup>
          <FieldRow>
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
            <span className="w-10 text-right text-[13px] tabular-nums text-muted-foreground">
              {Math.round(prefs.gamepad.opacity * 100)}%
            </span>
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection
        title="Placement"
        description="Stacked reduces the desktop to make room for the gamepad."
      >
        <PlacementChoice
          value={prefs.gamepad.placement}
          onChange={(placement) => patchPrefs("gamepad", { placement })}
          label="Gamepad placement"
        />
      </PanelSection>

      <PanelSection
        title="Stray taps"
      >
        <PanelGroup>
          <FieldRow>
            <Field
              label="Block taps outside the pads"
              hint={prefs.gamepad.placement === "overlay"
                ? "Overlay only, never while editing."
                : "Only applies to an overlay controller."}
            />
            <Switch
              checked={prefs.gamepad.shield}
              disabled={prefs.gamepad.placement !== "overlay"}
              onCheckedChange={(shield) => patchPrefs("gamepad", { shield })}
              aria-label="Block taps outside the pads"
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection title="Haptics" {...(hapticHint ? { description: hapticHint } : {})}>
        <PanelGroup>
          <FieldRow>
            <Field label="Vibrate on press" />
            <Switch
              checked={prefs.gamepad.haptics}
              onCheckedChange={(haptics) => patchPrefs("gamepad", { haptics })}
              aria-label="Vibrate on press"
            />
          </FieldRow>
        </PanelGroup>
      </PanelSection>

      <PanelSection title="Layout">
        <PanelGroup>
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[13.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              Keyboard buttons
              <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Plus className="size-3.5" aria-hidden /> Add a key
              </span>
            </summary>
            <div className="px-3 pb-3">
              <p className="mb-3 text-xs text-muted-foreground">A key or a chord as a button on the pad.</p>
              <CustomKeys />
            </div>
          </details>
          <Backup />
          <FieldRow>
            <Field label="Restore the default arrangement" />
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
        </PanelGroup>
      </PanelSection>

      <PanelSection title="Physical controller" description="Release the controller buttons before resetting.">
        <PanelGroup>
          <FieldRow>
            <Field label="Clear held input" />
            <Button variant="outline" size="sm" onClick={resetPhysicalGamepad} aria-label="Reset physical controller">
              Reset
            </Button>
          </FieldRow>
          <ControllerDiagnostics />
        </PanelGroup>
      </PanelSection>
    </div>
  )
}

function ControllerDiagnostics() {
  const [recording, setRecording] = useState(controllerTrace.recording)
  return (
    <FieldRow>
      <Field label="Record input" hint="Last 4,096 samples, about 33 seconds." />
      <Button variant="outline" size="sm" aria-label={recording ? "Stop and save recording" : "Record controller input"} onClick={() => {
        if (!recording) {
          controllerTrace.start()
          setRecording(true)
          return
        }
        const trace = { ...controllerTrace.stop(), browser: navigator.userAgent }
        setRecording(false)
        const url = URL.createObjectURL(new Blob([JSON.stringify(trace)], { type: "application/json" }))
        const link = document.createElement("a")
        link.href = url
        link.download = "lwfa-controller-trace.json"
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }}>
        {recording ? "Stop and save" : "Record"}
      </Button>
    </FieldRow>
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
          hint="Layout and controller settings."
        />
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
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
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
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
        <div className="space-y-2 px-3 pb-3">
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
        <p className="rounded-md border border-destructive/40 bg-destructive/10 m-3 p-2 text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {restored ? (
        <p className="rounded-md border border-dashed m-3 p-2 text-xs text-muted-foreground">
          Controller restored.
        </p>
      ) : null}
    </>
  )
})

function GamepadPanel() {
  return (
    <Tabs defaultValue="controller" className="gap-[15px]">
      <TabsList className="sticky top-0 z-10 w-full">
        <TabsTrigger value="controller" className="flex-1 px-2">Controller</TabsTrigger>
        <TabsTrigger value="proton" className="flex-1 px-2">Proton</TabsTrigger>
        <TabsTrigger value="lsfg" className="flex-1 px-2">LSFG</TabsTrigger>
        <TabsTrigger value="framegen" className="flex-1 px-2">Framegen</TabsTrigger>
      </TabsList>
      <TabsContent value="controller"><ControllerControls /></TabsContent>
      <TabsContent value="proton"><GamingPanel component="proton" /></TabsContent>
      <TabsContent value="lsfg"><GamingPanel component="lsfg" /></TabsContent>
      <TabsContent value="framegen"><GamingPanel component="framegen" /></TabsContent>
    </Tabs>
  )
}

export default memo(GamepadPanel)
