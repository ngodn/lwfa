/**
 * Workspaces, windows, and how they are laid out.
 *
 * # One list, not two views
 *
 * This panel used to offer "arrange" and "list" as a pair of toggled views,
 * because dragging a window directly is hard when half the strip is off the
 * edge of the screen. That problem is now solved where it actually occurs:
 * arrange mode zooms the desktop out and lets you drag the windows themselves.
 *
 * So the panel keeps one list, and the list shows *structure* rather than
 * hiding it: which windows share a column, which is focused, how wide each
 * column is. It is the precise, boring, keyboard-and-screen-reader path to the
 * same operations. Both exist on purpose, and neither is a worse copy of the
 * other.
 *
 * # Why a row expands instead of opening a menu
 *
 * The panel is a narrow sheet, usually on a tablet. A popover anchored to a
 * button inside it is cramped, can overflow the sheet's edge, and needs a
 * portal with its own stacking to escape the sheet's clipping. Expanding
 * inside the row gets the full width, gives every action a label and a target
 * a finger can hit, scrolls with the list, and cannot be positioned wrongly.
 * One row is open at a time, so the list never becomes a wall of controls.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  CornerDownRight,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Plus,
  X,
} from "lucide-react"
import type { WindowId } from "@lwfa/proto"
import { useSessionActions, useSessionState } from "@/session"
import { currentWorkspace, focusedWindow, isFullscreen } from "@/strip"
import { patchPrefs, usePrefs } from "@/lib/prefs"
import { WIDTH_PRESETS } from "@/strip"
import { setArrange } from "@/lib/arrange"
import { pendingKeys, usePendingPrefix } from "@/lib/pending"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

/** Column width labels, derived so a new preset needs no edit here. */
const widthLabel = (preset: number) => `${Math.round((WIDTH_PRESETS[preset] ?? 0) * 100)}%`

/**
 * A window, flattened out of the strip with the shape it came from attached.
 *
 * Built once for the whole list rather than looked up per row, so the list is
 * one pass over the columns however many windows there are.
 */
interface Row {
  id: WindowId
  column: number
  row: number
  /** How many windows share the column. */
  height: number
  width: number
  /** First of a column, so the list can show where each column begins. */
  heads: boolean
}

function WindowsPanel() {
  const { strip, primary } = useSessionState()

  const workspace = currentWorkspace(strip)
  const focused = focusedWindow(strip)

  const rows = useMemo<Row[]>(
    () =>
      workspace.columns.flatMap((column, index) =>
        column.windows.map((id, row) => ({
          id,
          column: index,
          row,
          height: column.windows.length,
          width: column.width,
          heads: row === 0,
        })),
      ),
    [workspace.columns],
  )

  // One row open at a time. Held here rather than in each row so opening one
  // closes the last without them having to know about each other.
  const [open, setOpen] = useState<WindowId | null>(focused)
  const toggle = useCallback(
    (id: WindowId) => setOpen((current) => (current === id ? null : id)),
    [],
  )
  // The focused window's actions are the ones about to be used, so its row
  // opens itself as focus moves: focusing from the list, from the desktop, or
  // from the keyboard all land with the right controls already showing.
  // Toggling still works; the next focus change simply reasserts it.
  useEffect(() => {
    setOpen(focused)
  }, [focused])

  return (
    /*
     * Flex with `gap`, not `space-y`.
     *
     * The fieldset below is `display: contents`, which exists so that
     * disabling it does not add a box to the layout. Tailwind's `space-y`
     * works by putting a margin on children, and a `contents` element
     * generates no box at all, so its margin is discarded: the sections inside
     * it ended up touching each other and touching the section after it.
     *
     * `gap` has no such problem. `display: contents` hoists the fieldset's
     * children into this flex container, so every block below is spaced by the
     * same rule whether or not it sits inside the fieldset.
     */
    <div className="flex flex-col gap-6 pt-2">
      {!primary ? <Following /> : null}

      <fieldset disabled={!primary} className="contents">
        {/* The thing most people opened this panel to do, so it comes first
          * and takes the full width. */}
        <Button
          size="lg"
          className="h-12 w-full justify-start gap-2.5 text-[0.95rem]"
          onClick={() => setArrange(true)}
        >
          <LayoutGrid className="size-5" aria-hidden />
          Arrange windows
        </Button>

        <PanelSection title="Workspaces">
          <Workspaces />
        </PanelSection>

        <PanelSection title="Windows">
          {rows.length === 0 ? <NoWindows /> : null}
          {rows.length > 0 ? (
            <ul className="overflow-hidden rounded-lg border">
              {rows.map((row) => (
                <WindowItem
                  key={row.id}
                  row={row}
                  focused={row.id === focused}
                  fullscreen={isFullscreen(strip) && row.id === focused}
                  open={open === row.id}
                  onToggle={toggle}
                />
              ))}
            </ul>
          ) : null}
          <Spawning />
        </PanelSection>
      </fieldset>

      {/* Preferences, not commands. Stored on this device and applied the
        * moment it starts driving, so there is no reason to lock somebody out
        * of setting them up while another device holds control. */}
      <PanelSection title="Layout" description="Saved on this device.">
        <StripSettings />
      </PanelSection>
    </div>
  )
}

/* --------------------------------------------------------------- workspaces */

const Workspaces = memo(function Workspaces() {
  const { strip } = useSessionState()
  const actions = useSessionActions()

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {strip.workspaces.map((ws, index) => {
          const count = ws.columns.reduce((n, column) => n + column.windows.length, 0)
          const here = index === strip.focus
          return (
            <button
              key={index}
              type="button"
              aria-current={here}
              aria-label={
                count === 0
                  ? `Workspace ${index + 1}, empty`
                  : `Workspace ${index + 1}, ${count} window${count === 1 ? "" : "s"}`
              }
              onClick={() => actions.focusWorkspace(index)}
              className={cn(
                "flex h-12 min-w-12 flex-col items-center justify-center gap-1 rounded-lg border px-3",
                "text-sm transition-colors",
                here
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-accent",
              )}
            >
              <span className="leading-none font-medium">{index + 1}</span>
              {/* Dots rather than a number: the useful question is "is there
                * anything over there", and a shape answers it without reading. */}
              <span className="flex h-1.5 items-center gap-0.5">
                {Array.from({ length: Math.min(count, 4) }, (_, dot) => (
                  <span
                    key={dot}
                    className={cn(
                      "size-1 rounded-full",
                      here ? "bg-primary-foreground/70" : "bg-muted-foreground/60",
                    )}
                  />
                ))}
                {count > 4 ? (
                  <span
                    className={cn(
                      "text-[9px] leading-none",
                      here ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    +
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------- window */

const WindowItem = memo(function WindowItem({
  row,
  focused,
  fullscreen,
  open,
  onToggle,
}: {
  row: Row
  focused: boolean
  fullscreen: boolean
  open: boolean
  onToggle: (id: WindowId) => void
}) {
  const { windows } = useSessionState()
  const actions = useSessionActions()
  const info = windows.get(row.id)

  // A window the engine has announced but not yet described. Shown as a shape
  // of the right size rather than as the word "Window 7", which looks like a
  // name and is not one.
  const unnamed = !info?.title && !info?.appId
  const title = info?.title || info?.appId || `Window ${row.id}`

  const act = useCallback(
    (run: () => void) => {
      actions.focusWindow(row.id)
      run()
    },
    [actions, row.id],
  )

  return (
    <li className={cn("border-b last:border-b-0", focused && "bg-accent/60")}>
      <div className="flex items-stretch">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2.5 text-left"
          onClick={() => actions.focusWindow(row.id)}
        >
          {/* Stacked windows are indented under the first of their column, so
            * the shape of the strip is readable without a second view. */}
          {row.heads ? (
            <span
              aria-hidden
              className={cn("w-1 self-stretch rounded-full", focused ? "bg-primary" : "bg-border")}
            />
          ) : (
            <CornerDownRight
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}

          {unnamed ? (
            <span className="flex-1 py-0.5" aria-label="Waiting for this window to say what it is">
              <span className="block h-3 w-2/3 animate-pulse rounded bg-muted" />
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          )}

          {row.heads ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {widthLabel(row.width)}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          aria-expanded={open}
          aria-label={`Actions for ${title}`}
          onClick={() => onToggle(row.id)}
          className="grid min-h-11 w-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>

      {/* Mounted only while open, so a list of twenty windows is not also
        * twenty hidden action panels.
        *
        * Two dense lines rather than the old stack of labelled sections: the
        * grid of labelled buttons, a width section and a workspace section
        * made every expansion five rows tall, which on a phone pushed the
        * rest of the list off the sheet. Icons carry the actions (with
        * tooltips and labels for the screen reader), the width presets sit on
        * the same line, and everything wraps, so a narrow sheet gets more
        * lines rather than clipped controls. Targets stay 44px throughout.
        *
        * No per-window pause here any more: whether inactive windows stream
        * is one global choice, in Settings under Stream. A per-row toggle
        * fought with it and made "why is this window frozen" a two-place
        * question. */}
      {open ? (
        <div className="space-y-1.5 border-t bg-muted/30 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <IconAction
              label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => act(actions.toggleFullscreen)}
            >
              {fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </IconAction>
            <IconAction
              label="Stack onto the column to the left"
              disabled={row.column === 0}
              onClick={() => act(actions.consume)}
            >
              <ArrowLeftToLine aria-hidden />
            </IconAction>
            <IconAction
              label="Move into its own column"
              disabled={row.height < 2}
              onClick={() => act(actions.expel)}
            >
              <ArrowRightToLine aria-hidden />
            </IconAction>
            <IconAction label="Close" danger onClick={() => actions.closeWindow(row.id)}>
              <X aria-hidden />
            </IconAction>

            <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-border" />

            <ToggleGroup
              type="single"
              value={String(row.width)}
              onValueChange={(value) => {
                if (value) actions.setColumnWidth(row.id, Number(value))
              }}
              variant="outline"
              aria-label="Column width"
              className="flex-1"
            >
              {WIDTH_PRESETS.map((fraction, index) => (
                <ToggleGroupItem
                  key={index}
                  value={String(index)}
                  className="h-11 min-w-10 flex-1 px-1 text-xs tabular-nums"
                  aria-label={`${Math.round(fraction * 100)}% wide`}
                >
                  {Math.round(fraction * 100)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <SendTo id={row.id} />
        </div>
      ) : null}
    </li>
  )
})

/** Move a window to another workspace, by name rather than by direction. */
const SendTo = memo(function SendTo({ id }: { id: WindowId }) {
  const { strip } = useSessionState()
  const actions = useSessionActions()

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="pr-1 text-xs text-muted-foreground">Send to</span>
      {strip.workspaces.map((_, index) => (
        <Button
          key={index}
          size="sm"
          variant="outline"
          className="h-11 min-w-11"
          disabled={index === strip.focus}
          aria-label={`Send to workspace ${index + 1}`}
          onClick={() => actions.sendToWorkspace(id, index)}
        >
          {index + 1}
        </Button>
      ))}
    </div>
  )
})

/**
 * An icon-sized action with its label in a tooltip and on the accessibility
 * tree. Icon-only is what buys the compact row; the label is one hover (or
 * one screen-reader stop) away, and the icons are the same ones the old
 * labelled buttons wore, so nothing has to be relearned.
 */
function IconAction({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="outline"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          className={cn(
            "size-11 shrink-0 [&>svg]:size-4",
            danger && "text-destructive hover:bg-destructive hover:text-destructive-foreground",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/* -------------------------------------------------------------------- empty */

const NoWindows = memo(function NoWindows() {
  const actions = useSessionActions()
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="text-sm text-muted-foreground">Nothing open on this workspace.</p>
      <Button
        variant="outline"
        className="mt-3 h-11 gap-1.5"
        onClick={() => actions.spawn("alacritty")}
      >
        <Plus className="size-3.5" aria-hidden />
        Open a terminal
      </Button>
    </div>
  )
})

/**
 * Applications asked for but not yet on screen.
 *
 * Without this, launching something means pressing a button and watching an
 * unchanged list until the window appears, which reads as the launch having
 * failed and gets it pressed again.
 */
const Spawning = memo(function Spawning() {
  const any = usePendingPrefix("launch:")
  if (!any) return null

  const waiting = pendingKeys("launch:").map((key) => {
    const command = key.slice("launch:".length)
    return (command.split(/\s+/)[0] ?? "").split("/").pop() || command
  })

  return (
    <ul className="space-y-1">
      {waiting.map((name) => (
        <li
          key={name}
          className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-2.5"
        >
          <span
            className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
            aria-hidden
          />
          <span className="truncate text-sm text-muted-foreground">Opening {name}…</span>
        </li>
      ))}
    </ul>
  )
})

/* ----------------------------------------------------------------- following */

/**
 * Shown when another device is deciding the arrangement.
 *
 * Names the device rather than saying "another session", because on a desk with
 * a laptop and a tablet on it, "the iPad is driving" is an answer and "another
 * session is driving" is a riddle.
 */
const Following = memo(function Following() {
  const { peers } = useSessionState()
  const actions = useSessionActions()
  const driver = peers.find((peer) => peer.primary)

  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
      <p className="text-sm">
        <span className="font-medium">
          {driver ? driver.device : "Another device"} is arranging the windows.
        </span>{" "}
        <span className="text-muted-foreground">You can still type, click and scroll.</span>
      </p>
      <Button className="h-11 w-full" onClick={actions.takeControl}>
        Arrange from this device
      </Button>
    </div>
  )
})

/* --------------------------------------------------------------- preferences */

const ORIENTATIONS = [
  { value: "auto", label: "Auto" },
  { value: "horizontal", label: "Rows" },
  { value: "vertical", label: "Columns" },
] as const

/**
 * Its own component so that changing a preference re-renders these three
 * controls and not the window list above them.
 */
const StripSettings = memo(function StripSettings() {
  const { layout: prefs } = usePrefs()
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Field label="Direction" hint="Auto follows the shape of the screen." />
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
            <ToggleGroupItem key={value} value={value} className="h-11 flex-1">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="space-y-1.5">
        <Field label="New window size" />
        <ToggleGroup
          type="single"
          value={String(prefs.defaultWidth)}
          onValueChange={(v) => v && patchPrefs("layout", { defaultWidth: Number(v) })}
          variant="outline"
          className="w-full"
        >
          {WIDTH_PRESETS.map((fraction, index) => (
            <ToggleGroupItem key={index} value={String(index)} className="h-11 flex-1">
              {Math.round(fraction * 100)}%
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <FieldRow>
        <Field label="Keep focus centred" />
        <Switch
          checked={prefs.centreFocused}
          onCheckedChange={(centreFocused) => patchPrefs("layout", { centreFocused })}
        />
      </FieldRow>
    </div>
  )
})

export default memo(WindowsPanel)
