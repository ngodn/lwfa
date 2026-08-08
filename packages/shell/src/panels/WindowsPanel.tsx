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
  Columns2,
  CornerDownRight,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Plus,
  Power,
  X,
} from "lucide-react"
import type { WindowId } from "@lwfa/proto"
import { useSessionActions, useSessionState } from "@/session"
import {
  configFrom,
  currentWorkspace,
  fitsOnScreen,
  focusedWindow,
  isFitted,
  isFullscreen,
} from "@/strip"
import { patchPrefs, usePrefs, usePrefSection } from "@/lib/prefs"
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
 * One column of the strip, with the windows stacked in it.
 *
 * The list is built from these rather than from a flat run of windows,
 * because the strip is a tree and the controls follow the tree: a width and
 * the live switch belong to a *column*, and everything else belongs to a
 * *window*. Flattening put both kinds on every row, so a stacked window
 * appeared to own its column's width, and changing it from one child silently
 * changed what the others were sitting in.
 */
interface ColumnGroup {
  index: number
  windows: WindowId[]
  width: number
  /** Whether the whole column streams while focused. See `Column.live`. */
  live: boolean
}

/**
 * Which row is expanded. Columns and windows share one slot, so opening
 * either closes the other, and the two id spaces cannot collide.
 */
type OpenKey = `col:${number}` | `win:${number}`

const columnKey = (index: number): OpenKey => `col:${index}`
const windowKey = (id: WindowId): OpenKey => `win:${id}`

function WindowsPanel() {
  const { strip, primary } = useSessionState()
  /**
   * Whether the global pause is on, which is what makes the per-column live
   * switch mean anything. Read here rather than in each row so the panel takes
   * one subscription instead of one per window.
   */
  const { pauseInactive } = usePrefSection("stream")

  const workspace = currentWorkspace(strip)
  const focused = focusedWindow(strip)

  const groups = useMemo<ColumnGroup[]>(
    () =>
      workspace.columns.map((column, index) => ({
        index,
        windows: column.windows,
        width: column.width,
        live: column.live === true,
      })),
    [workspace.columns],
  )

  // One row open at a time. Held here rather than in each row so opening one
  // closes the last without them having to know about each other.
  const [open, setOpen] = useState<OpenKey | null>(
    focused === null ? null : windowKey(focused),
  )
  const toggle = useCallback(
    (key: OpenKey) => setOpen((current) => (current === key ? null : key)),
    [],
  )
  // The focused window's actions are the ones about to be used, so its row
  // opens itself as focus moves: focusing from the list, from the desktop, or
  // from the keyboard all land with the right controls already showing.
  // Toggling still works; the next focus change simply reasserts it.
  useEffect(() => {
    setOpen(focused === null ? null : windowKey(focused))
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
          <FitToScreen columns={groups.length} />
        </PanelSection>

        <PanelSection title="Windows">
          {groups.length === 0 ? <NoWindows /> : null}
          {groups.length > 0 ? (
            <ul className="overflow-hidden rounded-lg border">
              {groups.map((group) => (
                <ColumnItem
                  key={group.index}
                  group={group}
                  focused={focused}
                  fullscreen={isFullscreen(strip)}
                  // A fitted workspace streams everything in it, so as far as
                  // the per-column switch is concerned nothing is paused.
                  // Passing the effective answer keeps one rule in one place
                  // instead of every control checking both flags.
                  paused={pauseInactive && !workspace.fit}
                  fitted={workspace.fit}
                  open={open}
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

/**
 * The fit switch: stop scrolling, divide the screen among the columns.
 *
 * Sits with the workspaces because that is what it belongs to, not to any
 * window in the list below.
 *
 * The hint carries the two things somebody needs to know before pressing it,
 * and both are consequences rather than descriptions: the per-column widths
 * stop applying, and every window starts streaming. The second is the one
 * that costs something, so it is said plainly rather than left to be
 * discovered as "why did the picture get softer".
 */
const FitToScreen = memo(function FitToScreen({ columns }: { columns: number }) {
  const { strip, output } = useSessionState()
  const actions = useSessionActions()
  const layoutPrefs = usePrefSection("layout")
  const fitted = isFitted(strip)
  // Measured under the config the session is actually running, because the
  // orientation decides which axis "fits" is about.
  const room = fitsOnScreen(columns, output, configFrom(layoutPrefs))

  return (
    <FieldRow>
      <Field
        label="Fit to screen"
        hint={
          columns === 0
            ? "Nothing open on this workspace"
            : !room && !fitted
              ? `${columns} columns will not fit; the strip keeps scrolling`
              : fitted
                ? "Columns share the screen and all of them stream"
                : "Columns keep their own width and the strip scrolls"
        }
      />
      <Switch
        checked={fitted}
        disabled={columns === 0}
        onCheckedChange={actions.setFit}
        aria-label="Fit to screen"
      />
    </FieldRow>
  )
})

/* ------------------------------------------------------------------- column */

/**
 * One column, and the windows stacked in it.
 *
 * # Why a column gets a row of its own
 *
 * The width presets and the live switch change the *column*. They used to be
 * drawn inside every window's expansion, which put a parent's settings on each
 * of its children: the second window of a stack appeared to have a width, and
 * changing it from there changed what its siblings were sitting in without
 * saying so. Group state belongs on the group, which is also what the ARIA
 * tree pattern asks for, so the column gets a header row and the windows sit
 * inside a `role="group"` beneath it.
 *
 * # Except when the column holds one window
 *
 * Then the column and the window are the same object, and giving them two
 * rows would double the length of the list for the common case (most columns
 * hold one window) to express a distinction nobody can act on: there are no
 * siblings to affect. So a solo column is one row, and its expansion carries
 * both sets of controls under headings that say which is which.
 */
const ColumnItem = memo(function ColumnItem({
  group,
  focused,
  fullscreen,
  paused,
  fitted,
  open,
  onToggle,
}: {
  group: ColumnGroup
  focused: WindowId | null
  fullscreen: boolean
  /** Whether inactive windows are frozen, after fit has had its say. */
  paused: boolean
  /** The workspace is fitted, so column widths are shared out. */
  fitted: boolean
  open: OpenKey | null
  onToggle: (key: OpenKey) => void
}) {
  const stacked = group.windows.length > 1
  const holdsFocus = focused !== null && group.windows.includes(focused)

  if (!stacked) {
    const only = group.windows[0]
    if (only === undefined) return null
    return (
      <WindowItem
        id={only}
        group={group}
        focused={only === focused}
        fullscreen={fullscreen && only === focused}
        paused={paused}
        fitted={fitted}
        open={open === windowKey(only)}
        onToggle={onToggle}
        // A column of one: the window's row is the column's row, so it
        // carries the column's controls too, under their own heading.
        solo
      />
    )
  }

  const key = columnKey(group.index)
  const isOpen = open === key

  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-stretch bg-muted/40">
        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2.5">
          <span
            aria-hidden
            className={cn(
              "w-1 self-stretch rounded-full",
              holdsFocus ? "bg-primary" : "bg-border",
            )}
          />
          <Columns2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {group.windows.length} windows
          </span>

          {/* Read without opening anything, because the whole point of the
            * header is to say what the column is. Hidden when the global
            * pause is off, since then it claims a distinction nobody is
            * making. */}
          {group.live && paused ? (
            <span
              className="flex shrink-0 items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary tabular-nums"
              aria-label={`All ${group.windows.length} windows in this column stream`}
            >
              <MonitorPlay className="size-3" aria-hidden />
              {group.windows.length}
            </span>
          ) : null}

          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
            {widthLabel(group.width)}
          </span>
        </div>

        <button
          type="button"
          aria-expanded={isOpen}
          aria-label={`Column settings, ${group.windows.length} windows`}
          onClick={() => onToggle(key)}
          className="grid min-h-11 w-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", isOpen && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>

      {isOpen ? (
        <div className="border-t bg-muted/30 px-2.5 py-2">
          <ColumnControls group={group} paused={paused} fitted={fitted} />
        </div>
      ) : null}

      {/* The windows themselves. A nested list rather than indentation alone,
        * so the containment is in the markup and not only in the spacing. */}
      <ul role="group" className="border-t">
        {group.windows.map((id) => (
          <WindowItem
            key={id}
            id={id}
            group={group}
            focused={id === focused}
            fullscreen={fullscreen && id === focused}
            paused={paused}
            fitted={fitted}
            open={open === windowKey(id)}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </li>
  )
})

/**
 * What a column is: how wide, and whether all of it streams.
 *
 * Shared by the column header's expansion and by a solo column's window row,
 * so the two cannot drift into offering different things.
 */
function ColumnControls({
  group,
  paused,
  fitted,
}: {
  group: ColumnGroup
  paused: boolean
  /** The workspace is fitted, so widths are shared out rather than chosen. */
  fitted: boolean
}) {
  const actions = useSessionActions()
  // Any window in the column names it; the transitions take a window and act
  // on whatever column it is in.
  const anchor = group.windows[0]
  if (anchor === undefined) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Disabled rather than hidden while fitted, and disabled rather than
        * left working: a width chosen here would be stored and ignored, so
        * the control would lie about what it did. Greyed out with the
        * selection still visible says "this is what it will go back to". */}
      <ToggleGroup
        type="single"
        value={String(group.width)}
        onValueChange={(value) => {
          if (value) actions.setColumnWidth(anchor, Number(value))
        }}
        variant="outline"
        disabled={fitted}
        aria-label={fitted ? "Column width, shared out while fitted" : "Column width"}
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

      {/* No per-window pause anywhere in this panel: whether inactive windows
        * stream is one global choice, in Settings under Stream. A per-row
        * toggle fought with it and made "why is this window frozen" a
        * two-place question.
        *
        * This is not that toggle coming back. It is per column, it can only
        * ever widen what the global choice allows, and it is disabled when
        * that choice is already "stream everything". See `Column.live`. */}
      <IconAction
        label={liveLabel(group, paused)}
        pressed={group.live && group.windows.length > 1 && paused}
        disabled={group.windows.length < 2 || !paused}
        onClick={() => actions.setColumnLive(anchor, !group.live)}
      >
        <MonitorPlay aria-hidden />
      </IconAction>
    </div>
  )
}

/* ------------------------------------------------------------------- window */

const WindowItem = memo(function WindowItem({
  id,
  group,
  focused,
  fullscreen,
  paused,
  fitted,
  open,
  solo,
  onToggle,
}: {
  id: WindowId
  group: ColumnGroup
  focused: boolean
  fullscreen: boolean
  paused: boolean
  fitted: boolean
  open: boolean
  /** The only window in its column, so this row stands for both. */
  solo?: boolean
  onToggle: (key: OpenKey) => void
}) {
  const { windows } = useSessionState()
  const actions = useSessionActions()
  const info = windows.get(id)

  // A window the engine has announced but not yet described. Shown as a shape
  // of the right size rather than as the word "Window 7", which looks like a
  // name and is not one.
  const unnamed = !info?.title && !info?.appId
  const title = info?.title || info?.appId || `Window ${id}`

  const act = useCallback(
    (run: () => void) => {
      actions.focusWindow(id)
      run()
    },
    [actions, id],
  )

  return (
    <li className={cn("border-b last:border-b-0", focused && "bg-accent/60")}>
      <div className="flex items-stretch">
        <button
          type="button"
          className={cn(
            "flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2.5 text-left",
            !solo && "pl-3",
          )}
          onClick={() => actions.focusWindow(id)}
        >
          {solo ? (
            <span
              aria-hidden
              className={cn("w-1 self-stretch rounded-full", focused ? "bg-primary" : "bg-border")}
            />
          ) : (
            <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}

          {unnamed ? (
            <span className="flex-1 py-0.5" aria-label="Waiting for this window to say what it is">
              <span className="block h-3 w-2/3 animate-pulse rounded bg-muted" />
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          )}

          {/* Only on a solo row, where this line is also the column's. A
            * stacked window has a header above it wearing this already. */}
          {solo ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {widthLabel(group.width)}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          aria-expanded={open}
          aria-label={`Actions for ${title}`}
          onClick={() => onToggle(windowKey(id))}
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
        * Dense lines rather than a stack of labelled sections: the grid of
        * labelled buttons and a workspace section made every expansion five
        * rows tall, which on a phone pushed the rest of the list off the
        * sheet. Icons carry the actions (with tooltips and labels for the
        * screen reader) and everything wraps, so a narrow sheet gets more
        * lines rather than clipped controls. Targets stay 44px throughout. */}
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
              disabled={group.index === 0}
              onClick={() => act(actions.consume)}
            >
              <ArrowLeftToLine aria-hidden />
            </IconAction>
            <IconAction
              label="Move into its own column"
              disabled={group.windows.length < 2}
              onClick={() => act(actions.expel)}
            >
              <ArrowRightToLine aria-hidden />
            </IconAction>
            <IconAction label="Close" danger onClick={() => actions.closeWindow(id)}>
              <X aria-hidden />
            </IconAction>
            <IconAction
              label="Quit the application"
              danger
              onClick={() => actions.quitApp(id)}
            >
              <Power aria-hidden />
            </IconAction>
          </div>

          <SendTo id={id} />

          {/* A solo column has no header row of its own, so its settings live
            * here, named, rather than looking like more window actions. */}
          {solo ? (
            <div className="space-y-1.5 border-t pt-1.5">
              <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Column
              </p>
              <ColumnControls group={group} paused={paused} fitted={fitted} />
            </div>
          ) : null}
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
 * What the live switch is offering, said in full.
 *
 * The button is an icon, so this text is the only explanation there is: it
 * goes to the tooltip and to the accessibility tree both. Every disabled
 * reason therefore says *why* rather than leaving a greyed-out icon to be
 * guessed at, and the counts are spelled out because "all of them" is not an
 * amount anybody can weigh against their connection.
 */
function liveLabel(group: ColumnGroup, paused: boolean): string {
  if (group.windows.length < 2) return "Nothing else shares this column"
  if (!paused) return "Every visible window already streams"
  if (group.live) return "Stream only the focused window of this column"
  return `Stream all ${group.windows.length} windows in this column`
}

/**
 * An icon-sized action with its label in a tooltip and on the accessibility
 * tree. Icon-only is what buys the compact row; the label is one hover (or
 * one screen-reader stop) away, and the icons are the same ones the old
 * labelled buttons wore, so nothing has to be relearned.
 *
 * `pressed` makes one a toggle rather than a command: it carries the state on
 * `aria-pressed` as well as in the fill, so the one control that has an on
 * position does not rely on colour alone to say which it is in.
 */
function IconAction({
  label,
  danger,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  disabled?: boolean
  pressed?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant={pressed ? "default" : "outline"}
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
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
