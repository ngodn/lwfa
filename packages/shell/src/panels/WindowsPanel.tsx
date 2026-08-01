/**
 * Workspaces and window arrangement.
 *
 * # Two ways to do the same thing
 *
 * The list is precise and boring: every window, with buttons for the operations
 * the strip supports. It works with a mouse, with a keyboard, and with a screen
 * reader, and it is unambiguous about what each button does.
 *
 * The **arrange** view is the one for a tablet. Under scrollable tiling the
 * windows on screen run off the viewport edges, so dragging one directly means
 * grabbing a target that is half off-screen and dropping it somewhere
 * ambiguous. Arrange lays the same columns out as separated cards that never
 * overlap, so a finger has a whole card to grab and an obvious gap to drop
 * into. It is not a second layout model, just a different way of touching the
 * one that already exists.
 */

import { memo, useCallback, useMemo, useState } from "react"
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronUp,
  Columns3,
  LayoutGrid,
  List,
  Maximize2,
  Plus,
  X,
} from "lucide-react"
import type { WindowId, WindowInfo } from "@lwfa/proto"
import { useSessionActions, useSessionState } from "@/session"
import { currentWorkspace, focusedWindow } from "@/strip"
import { patchPrefs, usePrefs } from "@/lib/prefs"
import { WIDTH_PRESETS } from "@/strip"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

/** Column width labels, derived so a new preset needs no edit here. */
const widthLabel = (preset: number) =>
  `${Math.round((WIDTH_PRESETS[preset] ?? 0) * 100)}%`

function WindowsPanel() {
  const { strip } = useSessionState()
  const actions = useSessionActions()
  const [view, setView] = useState<"list" | "arrange">("arrange")

  const workspace = currentWorkspace(strip)
  const focused = focusedWindow(strip)

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="Workspace">
        <div className="flex flex-wrap items-center gap-1.5">
          {strip.workspaces.map((ws, index) => (
            <Button
              key={index}
              size="sm"
              variant={index === strip.focus ? "default" : "outline"}
              onClick={() => actions.focusWorkspace(index)}
              className="h-9 min-w-9 px-2"
            >
              {index + 1}
              {ws.columns.length > 0 ? (
                <span className="ml-1 text-[10px] opacity-70">{ws.columns.length}</span>
              ) : null}
            </Button>
          ))}
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5"
            disabled={focused === null || strip.focus === 0}
            onClick={() => actions.moveToWorkspace(-1)}
          >
            <ChevronUp className="size-3.5" aria-hidden />
            Move up
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5"
            disabled={focused === null || strip.focus >= strip.workspaces.length - 1}
            onClick={() => actions.moveToWorkspace(1)}
          >
            <ChevronDown className="size-3.5" aria-hidden />
            Move down
          </Button>
        </div>
      </PanelSection>

      <PanelSection title="Focused window">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={actions.cycleWidth}>
            <Columns3 className="size-3.5" aria-hidden />
            Width
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={actions.consume}>
            <ArrowLeftToLine className="size-3.5" aria-hidden />
            Stack left
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={actions.expel}>
            <ArrowRightToLine className="size-3.5" aria-hidden />
            Own column
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={focused === null}
            onClick={() => focused !== null && actions.closeWindow(focused)}
          >
            <X className="size-3.5" aria-hidden />
            Close
          </Button>
        </div>
      </PanelSection>

      <PanelSection
        title="Strip"
        description="How the strip behaves on this device. Stored per device, because a phone and a monitor do not want the same thing."
      >
        <StripSettings />
      </PanelSection>

      <PanelSection title="Layout">
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => v && setView(v as "list" | "arrange")}
          variant="outline"
          className="w-full"
        >
          <ToggleGroupItem value="arrange" className="flex-1 gap-1.5">
            <LayoutGrid className="size-3.5" aria-hidden />
            Arrange
          </ToggleGroupItem>
          <ToggleGroupItem value="list" className="flex-1 gap-1.5">
            <List className="size-3.5" aria-hidden />
            List
          </ToggleGroupItem>
        </ToggleGroup>

        {workspace.columns.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">This workspace is empty.</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 gap-1.5"
              onClick={() => actions.spawn("alacritty")}
            >
              <Plus className="size-3.5" aria-hidden />
              Open a terminal
            </Button>
          </div>
        ) : view === "arrange" ? (
          <ArrangeView focused={focused} />
        ) : (
          <ListView focused={focused} />
        )}
      </PanelSection>
    </div>
  )
}

const ORIENTATIONS = [
  { value: "auto", label: "Auto" },
  { value: "horizontal", label: "Rows" },
  { value: "vertical", label: "Columns" },
] as const

const StripSettings = memo(function StripSettings() {
  const { layout: prefs } = usePrefs()
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Field
          label="Direction"
          hint="Auto follows the viewport's long axis: side by side in landscape, stacked in portrait."
        />
        <ToggleGroup
          type="single"
          value={prefs.orientation}
          onValueChange={(v) =>
            v && patchPrefs("layout", { orientation: v as typeof prefs.orientation })
          }
          variant="outline"
          className="w-full"
        >
          {ORIENTATIONS.map(({ value, label }) => (
            <ToggleGroupItem key={value} value={value} className="flex-1">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="space-y-1.5">
        <Field label="New window size" hint="How much of the viewport an application gets when it opens." />
        <ToggleGroup
          type="single"
          value={String(prefs.defaultWidth)}
          onValueChange={(v) => v && patchPrefs("layout", { defaultWidth: Number(v) })}
          variant="outline"
          className="w-full"
        >
          {WIDTH_PRESETS.map((fraction, index) => (
            <ToggleGroupItem key={index} value={String(index)} className="flex-1">
              {Math.round(fraction * 100)}%
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <FieldRow>
        <Field
          label="Keep focus centred"
          hint="Focus always lands in the same place, so moving along the strip is predictable."
        />
        <Switch
          checked={prefs.centreFocused}
          onCheckedChange={(centreFocused) => patchPrefs("layout", { centreFocused })}
        />
      </FieldRow>
    </div>
  )
})

/**
 * Columns as separated cards, reorderable by dragging.
 *
 * Pointer events, not HTML drag and drop: the latter does not fire on touch at
 * all, which would make this useless on exactly the devices it exists for.
 * `setPointerCapture` means a drag that strays outside the card still delivers
 * its move and its release.
 */
const ArrangeView = memo(function ArrangeView({ focused }: { focused: WindowId | null }) {
  const { strip, windows } = useSessionState()
  const actions = useSessionActions()
  const workspace = currentWorkspace(strip)

  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  // Where a drop would land, resolved from the pointer's position over the
  // list. Cheap, and it needs no measurement cache to invalidate.
  const onMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const list = event.currentTarget.closest("[data-arrange]")
    if (!list) return
    const cards = [...list.querySelectorAll<HTMLElement>("[data-column]")]
    const index = cards.findIndex((card) => {
      const box = card.getBoundingClientRect()
      return event.clientY < box.top + box.height / 2
    })
    setOver(index === -1 ? cards.length : index)
  }, [])

  const commit = useCallback(() => {
    // Expressed with the operations the strip already has rather than a new
    // "move column to index". Adding one would put layout policy in the shell
    // *and* in `strip.ts`, which is the duplication this project keeps avoiding.
    if (dragging !== null && over !== null && over !== dragging) {
      const first = workspace.columns[dragging]?.windows[0]
      if (first !== undefined) {
        actions.focusWindow(first)
        const steps = over > dragging ? over - dragging - 1 : over - dragging
        for (let i = 0; i < Math.abs(steps); i++) {
          if (steps > 0) actions.expel()
          else actions.consume()
        }
      }
    }
    setDragging(null)
    setOver(null)
  }, [dragging, over, workspace.columns, actions])

  return (
    <ol data-arrange className="space-y-2">
      {workspace.columns.map((column, index) => (
        <li
          key={index}
          data-column
          className={cn(
            "rounded-lg border bg-card p-2 transition-opacity",
            index === workspace.focus && "ring-1 ring-primary",
            dragging === index && "opacity-50",
            over === index && dragging !== null && dragging !== index && "border-t-2 border-t-primary",
          )}
          // Without this the browser scrolls the panel instead of dragging.
          style={{ touchAction: "none" }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(index)
            setOver(index)
          }}
          onPointerMove={(event) => {
            if (dragging !== null) onMove(event)
          }}
          onPointerUp={commit}
          onPointerCancel={commit}
        >
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {widthLabel(column.width)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Column {index + 1} · {column.windows.length} window
              {column.windows.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-1">
            {column.windows.map((id, row) => (
              <WindowRow
                key={id}
                id={id}
                title={titleOf(windows.get(id), id)}
                focused={id === focused}
                stacked={row === column.focus && column.windows.length > 1}
              />
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
})

const ListView = memo(function ListView({ focused }: { focused: WindowId | null }) {
  const { strip, windows } = useSessionState()
  const workspace = currentWorkspace(strip)
  const rows = useMemo(
    () => workspace.columns.flatMap((column) => column.windows),
    [workspace.columns],
  )
  return (
    <ul className="divide-y rounded-lg border">
      {rows.map((id) => (
        <li key={id} className="p-1">
          <WindowRow id={id} title={titleOf(windows.get(id), id)} focused={id === focused} />
        </li>
      ))}
    </ul>
  )
})

const WindowRow = memo(function WindowRow({
  id,
  title,
  focused,
  stacked,
}: {
  id: WindowId
  title: string
  focused: boolean
  stacked?: boolean
}) {
  const actions = useSessionActions()
  return (
    <div className={cn("flex items-center gap-1 rounded-md px-1", focused && "bg-accent")}>
      <button
        className="min-w-0 flex-1 truncate py-2 text-left text-sm"
        onClick={() => actions.focusWindow(id)}
      >
        {title}
        {stacked ? <span className="ml-1.5 text-[10px] text-muted-foreground">top</span> : null}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={`Cycle the width of ${title}`}
        onClick={() => {
          actions.focusWindow(id)
          actions.cycleWidth()
        }}
      >
        <Maximize2 className="size-3.5" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Close ${title}`}
        onClick={() => actions.closeWindow(id)}
      >
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
})

function titleOf(info: WindowInfo | undefined, id: WindowId): string {
  return info?.title || info?.appId || `Window ${id}`
}

export default memo(WindowsPanel)
