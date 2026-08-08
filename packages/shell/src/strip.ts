/**
 * The scrollable strip.
 *
 * lwfa's layout policy, following niri. Three nested levels:
 *
 * - **Workspaces** stack vertically. Each has its own strip.
 * - **Columns** sit on an infinite horizontal strip within a workspace.
 * - **Windows** stack vertically inside a column.
 *
 * Only the focused workspace is laid out. Everything else is simply absent from
 * the result, and because `SetLayout` is *total* the engine hides whatever it is
 * not told about. Workspaces therefore need no protocol support at all: they
 * fall out of a decision made back in milestone 3.
 *
 * # Everything here is a pure function
 *
 * No DOM, no clock, no `WebSocket`. State in, target geometry out. That matters
 * for three reasons:
 *
 * 1. The same code must produce the same layout under the local backend and the
 *    remote one, or the desktop looks different depending on where you sit.
 * 2. It is testable without a compositor or a browser.
 * 3. It can move to a worker later without restructuring.
 *
 * When text measurement arrives (window titles in an overview), it goes through
 * PreTeXt.js for the same reason: `getBoundingClientRect` would make this impure
 * and force a reflow per frame.
 *
 * # This module never animates
 *
 * It computes *target* geometry only. The engine integrates the springs at its
 * own refresh rate from parameters sent alongside. A shell that animated by
 * sending a rect per frame would bake its own scheduling jitter into the motion
 * and look different locally and remotely.
 */

import type { Rect, WindowId, WindowLayout } from "@lwfa/proto"

export interface Output {
  width: number
  height: number
}

// Layout defaults come from configs/defaults.toml, via a generated module, so
// the engine and the shell cannot disagree about them. See scripts/gen-config.mjs.
export { WIDTH_PRESETS } from "./generated/config.ts"
import {
  CENTRE_FOCUSED,
  DEFAULT_WIDTH,
  ORIENTATION,
  GAP,
  MIN_WIDTH,
  WIDTH_PRESETS,
} from "./generated/config.ts"

export type WidthPreset = 0 | 1 | 2 | 3

export interface StripConfig {
  /** Gap between columns, between stacked windows, and at the output edge. */
  gap: number
  /** Which preset a new column gets. */
  defaultWidth: WidthPreset
  /** Floor on column width, so a phone-width viewport stays usable. */
  minWidth: number
  /** Keep the focused column in the middle of the viewport. */
  centreFocused: boolean
  /** Which way the strip runs. `auto` follows the viewport's long axis. */
  orientation: OrientationPref
}

export const DEFAULT_CONFIG: StripConfig = {
  gap: GAP,
  defaultWidth: DEFAULT_WIDTH as WidthPreset,
  minWidth: MIN_WIDTH,
  centreFocused: CENTRE_FOCUSED,
  orientation: ORIENTATION,
}

/**
 * The machine's defaults with the device's layout preferences over them.
 *
 * Takes the three fields structurally rather than importing the preferences
 * module, so this file still depends on nothing. It exists because more than
 * one place needs the config the session is actually running under, and two
 * copies of this would drift: a panel measuring with the default orientation
 * while the strip ran vertically would answer questions about the wrong axis.
 */
export function configFrom(prefs: {
  orientation: OrientationPref
  centreFocused: boolean
  defaultWidth: number
}): StripConfig {
  return {
    ...DEFAULT_CONFIG,
    orientation: prefs.orientation,
    centreFocused: prefs.centreFocused,
    // Clamped, because a preferences blob written against a shorter preset
    // list can hold an index that no longer exists.
    defaultWidth: Math.min(
      Math.max(0, prefs.defaultWidth),
      WIDTH_PRESETS.length - 1,
    ) as WidthPreset,
  }
}

/** A vertical stack of windows sharing one slot on the strip. */
export interface Column {
  windows: WindowId[]
  /** Index into `windows`. Clamped by every operation here. */
  focus: number
  width: WidthPreset
  /**
   * Stream every window in this column while it has focus, not just the one.
   *
   * A column puts its windows on screen *together*, each taking an equal
   * slice. `Prefs.stream.pauseInactive` then freezes all but the focused one,
   * which is right across the strip and wrong inside a stack: the two windows
   * beside the one being typed in are visible, side by side with it, and
   * still. Stacking three terminals to watch three builds shows one build.
   *
   * So this is opt-in per column, and it only ever *widens* what streams.
   * There is deliberately no way to make a column stream less than the global
   * setting already allows: an earlier per-window pause toggle was removed for
   * making "why is this window frozen" a question with two answers in two
   * places, and this must not bring that back.
   *
   * Only the *focused* column's flag is read (see [`liveWindows`]), so the
   * extra cost is bounded by the largest stack rather than by how many columns
   * carry the flag. Marking every column on the strip cannot cost more than
   * marking one.
   *
   * Optional because the columns built before this existed had no opinion, and
   * absent is the same answer as false.
   */
  live?: boolean
}

export interface Workspace {
  columns: Column[]
  /** Index into `columns`. */
  focus: number
  /**
   * Divide the viewport among the columns exactly, and stop scrolling.
   *
   * # Why this exists
   *
   * The strip can already express a grid: two columns of two windows is a
   * 2x2, because a column of windows *is* a row of cells. What it could not
   * do was hold one. Width presets are fractions of the whole viewport and
   * take no account of the gaps, so two "halves" overflow by three gaps and
   * the strip scrolls; and `centreFocused` then slides the pair around every
   * time focus moves. The shape was reachable and would not sit still.
   *
   * Fitting solves both at once: every column takes the same share of what is
   * left after the gaps, and the offset is pinned. Four videos in two columns
   * become four quadrants that stay where they are put.
   *
   * # What it costs
   *
   * Per-column widths stop applying while it is on, because "each column
   * chooses its width" and "the columns exactly fill the screen" cannot both
   * be true. The presets are disabled rather than silently ignored.
   *
   * Held per workspace, like `fullscreen`, so a workspace can be a video wall
   * while the one next to it is a normal scrolling strip.
   */
  fit: boolean
  /**
   * How far this workspace has scrolled right, in logical pixels.
   *
   * Always a *target*. The engine holds in-between values while a spring runs;
   * this never holds a partially-scrolled position. Kept per workspace so
   * switching away and back returns you where you were.
   */
  viewOffset: number
  /**
   * The window filling the whole viewport, if any.
   *
   * Fullscreen is *not* a wider column. A column is a fraction of the strip and
   * still sits inside the gaps; fullscreen is the entire output, edge to edge,
   * with nothing else drawn. Cycling widths can never reach it, which is the
   * whole reason it is a separate piece of state rather than another preset:
   * a preset of 1.0 would still leave the gap, still leave neighbours peeking
   * in, and still scroll.
   *
   * Held per workspace, so switching away from a fullscreen video and back
   * returns to it, and dropped automatically when focus moves elsewhere, since
   * nothing else on the workspace is drawn while it is set.
   */
  fullscreen: WindowId | null
}

export interface StripState {
  workspaces: Workspace[]
  /** Index into `workspaces`. */
  focus: number
}

const emptyWorkspace = (): Workspace => ({
  columns: [],
  focus: 0,
  viewOffset: 0,
  fullscreen: null,
  fit: false,
})

/**
 * Workspaces are dynamic, niri-style: there is always exactly one empty one at
 * the end, so a new workspace is always one move away and none linger empty.
 */
export const EMPTY: StripState = { workspaces: [emptyWorkspace()], focus: 0 }

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Which way the strip runs.
 *
 * A scrollable strip has a *main* axis it scrolls along and a *cross* axis its
 * columns fill. Which is which depends on the shape of the viewport, and
 * getting it wrong is very visible: a horizontal strip on a phone held upright
 * gives every window a 390px-wide sliver of a 844px-tall screen, scrolling
 * sideways through a space that has no sideways.
 *
 * So the strip follows the long axis. In landscape it is a row of columns you
 * scroll left and right, which is niri. In portrait it is a stack of rows you
 * scroll up and down, which is every phone. The model is identical; only the
 * axis differs, so everything below works in main/cross terms and `layout`
 * transposes once at the end.
 */
export type Orientation = "horizontal" | "vertical"

/** What the user asked for, which may be "work it out from the viewport". */
export type OrientationPref = Orientation | "auto"

export function orientationOf(output: Output, config: StripConfig): Orientation {
  if (config.orientation !== "auto") return config.orientation
  return output.height > output.width ? "vertical" : "horizontal"
}

/** Viewport extent along the axis the strip scrolls. */
export function mainLength(output: Output, config: StripConfig): number {
  return orientationOf(output, config) === "horizontal" ? output.width : output.height
}

/** Viewport extent across the strip, which a column fills. */
export function crossLength(output: Output, config: StripConfig): number {
  return orientationOf(output, config) === "horizontal" ? output.height : output.width
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(index, 0), length - 1)
}

export function presetWidth(
  preset: WidthPreset,
  output: Output,
  config: StripConfig,
): number {
  return Math.max(Math.round(mainLength(output, config) * WIDTH_PRESETS[preset]!), config.minWidth)
}

/**
 * Extent of every column when the workspace is fitted.
 *
 * The gaps come out of the viewport *first*, so `count` columns and the
 * `count + 1` gaps around and between them add up to exactly the viewport and
 * the last column ends flush with its edge. This is the arithmetic the width
 * presets do not do: 50% of the viewport twice is three gaps too wide.
 *
 * Still floored at `minWidth`, so a workspace with more columns than can
 * honestly fit does not shrink them to slivers. Past that point the row is
 * wider than the screen and scrolling comes back on its own; see
 * [`fitsOnScreen`].
 */
export function fittedWidth(count: number, output: Output, config: StripConfig): number {
  if (count <= 0) return mainLength(output, config)
  const available = mainLength(output, config) - config.gap * (count + 1)
  return Math.max(Math.floor(available / count), config.minWidth)
}

/** Whether a fitted workspace's columns actually all fit. */
export function fitsOnScreen(count: number, output: Output, config: StripConfig): boolean {
  if (count <= 0) return true
  const width = fittedWidth(count, output, config)
  return config.gap * (count + 1) + width * count <= mainLength(output, config)
}

/**
 * The width every column takes, or `undefined` to use each column's preset.
 *
 * One value for the whole workspace rather than a per-column question,
 * because that is exactly what fitting means. Computed once by the callers
 * that walk the columns, so a strip of twenty does not recompute it twenty
 * times.
 */
function fitOverride(ws: Workspace, output: Output, config: StripConfig): number | undefined {
  return ws.fit ? fittedWidth(ws.columns.length, output, config) : undefined
}

export function columnWidth(
  column: Column,
  output: Output,
  config: StripConfig,
  /** Fitted width, when the workspace is fitted. */
  fitted?: number,
): number {
  return fitted ?? presetWidth(column.width, output, config)
}

/**
 * Extent available to a column across the strip, before any internal stacking.
 *
 * Full height in landscape, full width in portrait.
 */
export function columnHeight(output: Output, config: StripConfig): number {
  return Math.max(crossLength(output, config) - config.gap * 2, 1)
}

/**
 * Divide a column's rectangle among the windows sharing it.
 *
 * # Why this is not a stack of equal slices
 *
 * It was, and that is only ever right when a column is tall and narrow. Give
 * four windows a wide column and equal slices make four full-width bands a
 * quarter tall each, so anything with an aspect ratio (a video, a photo, a
 * document) fits itself to the height and wastes most of the width as black.
 * On a landscape tablet that is roughly two thirds of the picture thrown away,
 * and it is what a group of four videos actually looked like.
 *
 * # The rule, which is Hyprland's
 *
 * Split along whichever axis is longer, and recurse. Hyprland's dwindle
 * documents it as "the split is determined dynamically with the W/H ratio of
 * the parent node. If W > H, it's side-by-side. If H > W, it's top-and-bottom",
 * which is what keeps every cell roughly square instead of letting one
 * dimension collapse. Four windows in a wide column become quadrants; two
 * windows in a tall one still stack, because there the long axis is vertical.
 *
 * # Balanced rather than a spiral
 *
 * Dwindle splits whichever window has *focus*, so opening four in a row gives
 * a spiral and the arrangement depends on the order you built it in. Here the
 * window set is halved at each split instead, so a group of four is always
 * quadrants no matter how it was assembled. A group is a thing the user put
 * together deliberately; it should look the same tomorrow.
 *
 * The first half takes the near side, so window order reads down-then-across
 * in a wide column, matching the order the panel lists them in.
 *
 * Screen coordinates, not main/cross: the axis worth splitting is the longer
 * one on screen, and that is the same question in portrait and landscape.
 */
export function tile(box: Rect, count: number, gap: number): Rect[] {
  if (count <= 0) return []
  if (count <= 1) return [box]

  const first = Math.floor(count / 2)
  const rest = count - first

  if (box.width >= box.height) {
    // Floored, with the remainder going to the far side, so the halves add
    // back up to the whole and no column drifts a pixel narrow.
    const near = Math.max(Math.floor((box.width - gap) / 2), 1)
    const far = Math.max(box.width - near - gap, 1)
    return [
      ...tile({ ...box, width: near }, first, gap),
      ...tile({ ...box, x: box.x + near + gap, width: far }, rest, gap),
    ]
  }

  const near = Math.max(Math.floor((box.height - gap) / 2), 1)
  const far = Math.max(box.height - near - gap, 1)
  return [
    ...tile({ ...box, height: near }, first, gap),
    ...tile({ ...box, y: box.y + near + gap, height: far }, rest, gap),
  ]
}

/**
 * Where column `index` starts along the strip, before the view offset.
 *
 * That is an x in landscape and a y in portrait. Extents vary per column, so
 * this accumulates rather than multiplying.
 */
export function columnX(
  columns: Column[],
  index: number,
  output: Output,
  config: StripConfig,
  fitted?: number,
): number {
  let x = config.gap
  for (let i = 0; i < index && i < columns.length; i++) {
    x += columnWidth(columns[i]!, output, config, fitted) + config.gap
  }
  return x
}

export function currentWorkspace(state: StripState): Workspace {
  return state.workspaces[clampIndex(state.focus, state.workspaces.length)] ?? emptyWorkspace()
}

/**
 * Where the viewport should sit so the focused column is where you expect it.
 *
 * Two behaviours, chosen by `config.centreFocused`:
 *
 * **Centred** puts the focused column in the middle of the viewport. Focus
 * always lands in the same place, so moving along the strip is a predictable
 * motion rather than a scroll you have to read, and both neighbours peek in at
 * the edges so it is obvious there is more strip in each direction. That
 * matters most on a tablet, where there is no keyboard to tell you where you
 * are. niri calls this `center-focused-column` and it is the reason this
 * project follows niri's model in the first place.
 *
 * **Minimal** scrolls the least distance that makes the column fully visible,
 * and leaves it alone if it already is. That wastes no motion and suits a wide
 * display where three columns fit and re-centring for every focus change would
 * be a lot of movement for no information.
 */
export function targetOffset(state: StripState, output: Output, config: StripConfig): number {
  const ws = currentWorkspace(state)
  if (ws.columns.length === 0) return 0

  // A fitted workspace does not scroll: everything is on screen, so there is
  // nowhere to scroll to, and re-centring on focus would slide a grid that is
  // meant to stay still. Past the point where the columns stop fitting the
  // row is genuinely wider than the screen, and the usual rules below are the
  // right answer again.
  const fitted = fitOverride(ws, output, config)
  if (ws.fit && fitsOnScreen(ws.columns.length, output, config)) return 0

  const index = clampIndex(ws.focus, ws.columns.length)
  const column = ws.columns[index]!
  const width = columnWidth(column, output, config, fitted)
  const left = columnX(ws.columns, index, output, config, fitted) - config.gap
  const right = left + width + config.gap * 2

  // Wider than the viewport: pin the left edge, since no offset shows all of
  // it and centring would cut off both sides instead of one.
  if (right - left >= mainLength(output, config)) return left

  if (config.centreFocused) {
    // The column's own centre, placed at the viewport's centre. Deliberately
    // not clamped to the ends of the strip: letting the first and last columns
    // sit centred, with empty space beyond them, keeps the position of focus
    // constant. Clamping would make the ends behave differently from the
    // middle, which is exactly the unpredictability this avoids.
    return left + config.gap + width / 2 - mainLength(output, config) / 2
  }

  if (left < ws.viewOffset) return left
  if (right > ws.viewOffset + mainLength(output, config)) return right - mainLength(output, config)
  return ws.viewOffset
}

/**
 * Target geometry for the focused workspace.
 *
 * Windows on other workspaces are omitted entirely. `SetLayout` is total, so the
 * engine hides them, which is exactly what switching workspaces should do.
 */
export function layout(state: StripState, output: Output, config: StripConfig): WindowLayout[] {
  const ws = currentWorkspace(state)

  // Fullscreen short-circuits the whole strip: the output rect, no gap, and
  // nothing else emitted. Omitting the rest is what makes it fullscreen rather
  // than a very wide window with the strip still visible behind it, and it also
  // means the engine stops capturing them, which is the point on a tablet.
  if (ws.fullscreen !== null) {
    return [
      {
        id: ws.fullscreen,
        rect: { x: 0, y: 0, width: output.width, height: output.height },
        z: 0,
      },
    ]
  }

  const offset = ws.viewOffset
  const out: WindowLayout[] = []
  let z = 0

  // Everything above is in main/cross terms. This is the one place that turns
  // those into screen coordinates, so portrait is a transpose rather than a
  // second implementation of the layout.
  const vertical = orientationOf(output, config) === "vertical"
  // Computed once for the whole strip rather than per column: fitting is a
  // property of the workspace, not of any one column.
  const fitted = fitOverride(ws, output, config)
  const breadth = columnHeight(output, config)

  ws.columns.forEach((column, index) => {
    const extent = columnWidth(column, output, config, fitted)
    const along = columnX(ws.columns, index, output, config, fitted) - offset

    // The column's own rectangle, in screen coordinates, which `tile` then
    // divides among the windows sharing it. Handing it a screen rect rather
    // than main/cross extents is what lets it ask the one question that
    // matters, which axis is longer, without knowing about orientation.
    const box: Rect = vertical
      ? { x: config.gap, y: along, width: breadth, height: extent }
      : { x: along, y: config.gap, width: extent, height: breadth }

    const cells = tile(box, column.windows.length, config.gap)
    column.windows.forEach((id, at) => {
      const rect = cells[at]
      if (rect) out.push({ id, rect, z: z++ })
    })
  })

  return out
}

/**
 * The box that has to be on screen to see the whole strip at once.
 *
 * Under scrollable tiling the columns run off both ends of the viewport, so
 * "the desktop" and "what fits" are different rectangles. The viewport is the
 * right one to render at normal size. Arrange mode wants the other one: the
 * union of every window, which is the only view in which a strip can be
 * rearranged without dragging things past an edge you cannot see.
 *
 * The output is always included, so an empty workspace still has a shape and a
 * single narrow window does not blow up to fill a 4K display.
 */
export function stripBounds(placed: WindowLayout[], output: Output): Rect {
  let left = 0
  let top = 0
  let right = output.width
  let bottom = output.height

  for (const { rect } of placed) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Does this column intersect the viewport, and so deserve pixels? */
export function intersectsViewport(
  rect: Rect,
  output: Output,
  config: StripConfig,
): boolean {
  return orientationOf(output, config) === "vertical"
    ? rect.y + rect.height > 0 && rect.y < output.height
    : rect.x + rect.width > 0 && rect.x < output.width
}

/**
 * Which of these windows to ask the engine for pixels for.
 *
 * The rules live together because they interact. A window is a candidate when
 * the viewport can actually show it; the fullscreen window is one no matter
 * what, because during fullscreen every other window has already been dropped
 * by `layout`, so the one window being watched gets the entire budget.
 *
 * `pauseInactive` is the global lever (see `Prefs.stream.pauseInactive`):
 * when it is on, only the focused window streams and every other candidate
 * freezes on its last frame until it is focused again. The engine notices a
 * window leaving this list and tells its application to stop rendering, so
 * the saving is real, not cosmetic. When nothing is focused the candidates
 * all stream: a session with no focus yet must not open on a wall of stills.
 *
 * `live` is the per-column opt-out of that one rule, and the only thing that
 * can widen the list: the windows of a focused column marked `Column.live`.
 * See [`liveWindows`], which is what a caller should pass. It cannot narrow
 * anything, so a window frozen with an empty `live` stays frozen with a full
 * one, and every id in it still has to clear the viewport filter above.
 */
export function streamList(
  placed: WindowLayout[],
  output: Output,
  config: StripConfig,
  focused: WindowId | null,
  pauseInactive: boolean,
  fullscreen: WindowId | null,
  live: readonly WindowId[] = [],
): WindowId[] {
  return placed
    .filter(
      (w) => w.id === fullscreen || intersectsViewport(w.rect, output, config),
    )
    .filter(
      (w) =>
        !pauseInactive ||
        focused === null ||
        w.id === focused ||
        w.id === fullscreen ||
        live.includes(w.id),
    )
    .map((w) => w.id)
}

/**
 * The windows a live column adds to the stream list. See [`Column.live`].
 *
 * # A fitted workspace is live throughout
 *
 * Fitting puts every column on screen at once and stops the strip scrolling,
 * which is a statement that everything in it is meant to be watched: four
 * videos tiled into quadrants are four videos, not one video and three
 * stills. So fitting implies live for the whole workspace and there is no
 * second switch to find.
 *
 * That stays bounded for the same reason the mode does. Fitting only holds
 * what fits, and `streamList` still drops anything the viewport cannot show,
 * so a workspace with more columns than fit streams the ones on screen and no
 * more.
 *
 * Otherwise only the focused column is consulted, which is the whole reason
 * this is affordable: whatever the user has marked, at most one column can be
 * focused, so the extra encoder sessions are bounded by the tallest stack and
 * not by how liberally the flag has been handed out.
 *
 * A column of one is not a group, so its flag reads as nothing here. That
 * window is the focused one whenever the column is, and it therefore already
 * streams; honouring the flag would only mean this function could be used to
 * keep a single named window awake, which is exactly the per-window pause
 * control that was taken out of the windows panel. The flag is left on the
 * column rather than cleared, so a column that is stacked up again remembers
 * what it was told, the way it remembers its width.
 */
export function liveWindows(state: StripState): WindowId[] {
  const ws = currentWorkspace(state)
  if (ws.fit) return ws.columns.flatMap((column) => column.windows)
  const column = ws.columns[clampIndex(ws.focus, ws.columns.length)]
  if (!column?.live || column.windows.length < 2) return []
  return column.windows
}

// ---------------------------------------------------------------------------
// Transitions
//
// All pure. Each returns a new state and re-derives the view offset, so focus
// and offset can never disagree.
// ---------------------------------------------------------------------------

function withWorkspace(
  state: StripState,
  fn: (ws: Workspace) => Workspace,
): StripState {
  const index = clampIndex(state.focus, state.workspaces.length)
  const workspaces = state.workspaces.map((ws, i) => (i === index ? fn(ws) : ws))
  return { ...state, workspaces }
}

/**
 * Keep exactly one trailing empty workspace, and drop any others.
 *
 * Without this, closing the last window on a middle workspace leaves a hole you
 * have to scroll past forever.
 */
function normaliseWorkspaces(state: StripState): StripState {
  const nonEmpty = state.workspaces.filter((ws) => ws.columns.length > 0)
  const focused = state.workspaces[clampIndex(state.focus, state.workspaces.length)]

  const workspaces = [...nonEmpty, emptyWorkspace()]
  // Follow the workspace that had focus, if it survived; otherwise clamp.
  const kept = focused && focused.columns.length > 0 ? nonEmpty.indexOf(focused) : -1
  const focus = kept >= 0 ? kept : clampIndex(state.focus, workspaces.length)
  return { workspaces, focus: clampIndex(focus, workspaces.length) }
}

export function scrollFocusIntoView(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const offset = targetOffset(state, output, config)
  const focused = focusedWindow(state)
  return withWorkspace(state, (ws) => ({
    ...ws,
    viewOffset: offset,
    // Fullscreen belongs to whatever has focus. Every transition lands here, so
    // moving focus, closing the window, or pulling it into a stack all drop out
    // of fullscreen without each one having to remember to. Leaving it set
    // would be worse than a stale flag: nothing else on the workspace is drawn,
    // so focusing another window would look like the shell had frozen.
    fullscreen: ws.fullscreen !== null && ws.fullscreen === focused ? ws.fullscreen : null,
  }))
}

function settle(state: StripState, output: Output, config: StripConfig): StripState {
  return scrollFocusIntoView(normaliseWorkspaces(state), output, config)
}

/**
 * Add a window as a new column, immediately right of the focused one.
 *
 * niri inserts adjacent rather than appending, so a window you open while
 * reading something lands next to it instead of at the far end of the strip.
 */
export function addWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  if (findWindow(state, id)) return state

  const next = withWorkspace(state, (ws) => {
    const at = ws.columns.length === 0 ? 0 : clampIndex(ws.focus, ws.columns.length) + 1
    const columns = [...ws.columns]
    columns.splice(at, 0, { windows: [id], focus: 0, width: config.defaultWidth })
    return { ...ws, columns, focus: at }
  })
  return settle(next, output, config)
}

export function removeWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  const found = findWindow(state, id)
  if (!found) return state

  const workspaces = state.workspaces.map((ws, wsIndex) => {
    if (wsIndex !== found.workspace) return ws

    const columns = ws.columns
      .map((column, colIndex) => {
        if (colIndex !== found.column) return column
        const windows = column.windows.filter((w) => w !== id)
        // Removing a window above the focus shifts the rest up.
        const focus =
          found.row < column.focus ? column.focus - 1 : column.focus
        return { ...column, windows, focus: clampIndex(focus, windows.length) }
      })
      .filter((column) => column.windows.length > 0)

    // Same for columns: removing one to the left shifts the rest.
    let focus = ws.focus
    const columnEmptied = ws.columns[found.column]!.windows.length === 1
    if (columnEmptied && found.column < ws.focus) focus -= 1
    return { ...ws, columns, focus: clampIndex(focus, columns.length) }
  })

  return settle({ ...state, workspaces }, output, config)
}

export interface WindowLocation {
  workspace: number
  column: number
  row: number
}

export function findWindow(state: StripState, id: WindowId): WindowLocation | null {
  for (const [workspace, ws] of state.workspaces.entries()) {
    for (const [column, col] of ws.columns.entries()) {
      const row = col.windows.indexOf(id)
      if (row !== -1) return { workspace, column, row }
    }
  }
  return null
}

/** The focused window, or null if the focused workspace is empty. */
export function focusedWindow(state: StripState): WindowId | null {
  const ws = currentWorkspace(state)
  const column = ws.columns[clampIndex(ws.focus, ws.columns.length)]
  if (!column) return null
  return column.windows[clampIndex(column.focus, column.windows.length)] ?? null
}

export function focusWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  const found = findWindow(state, id)
  if (!found) return state

  const workspaces = state.workspaces.map((ws, wsIndex) =>
    wsIndex !== found.workspace
      ? ws
      : {
          ...ws,
          focus: found.column,
          columns: ws.columns.map((column, colIndex) =>
            colIndex === found.column ? { ...column, focus: found.row } : column,
          ),
        },
  )
  return scrollFocusIntoView(
    { ...state, workspaces, focus: found.workspace },
    output,
    config,
  )
}

function focusColumn(
  state: StripState,
  delta: number,
  output: Output,
  config: StripConfig,
): StripState {
  const next = withWorkspace(state, (ws) => ({
    ...ws,
    focus: clampIndex(ws.focus + delta, ws.columns.length),
  }))
  return scrollFocusIntoView(next, output, config)
}

export const focusLeft = (s: StripState, o: Output, c: StripConfig) => focusColumn(s, -1, o, c)
export const focusRight = (s: StripState, o: Output, c: StripConfig) => focusColumn(s, 1, o, c)

/** Move focus within the focused column's stack. */
function focusRow(state: StripState, delta: number): StripState {
  return withWorkspace(state, (ws) => ({
    ...ws,
    columns: ws.columns.map((column, i) =>
      i !== clampIndex(ws.focus, ws.columns.length)
        ? column
        : { ...column, focus: clampIndex(column.focus + delta, column.windows.length) },
    ),
  }))
}

export const focusUp = (s: StripState) => focusRow(s, -1)
export const focusDown = (s: StripState) => focusRow(s, 1)

/** Cycle the focused column between the width presets. */
export function cycleWidth(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const next = withWorkspace(state, (ws) => ({
    ...ws,
    columns: ws.columns.map((column, i) =>
      i !== clampIndex(ws.focus, ws.columns.length)
        ? column
        : { ...column, width: ((column.width + 1) % WIDTH_PRESETS.length) as WidthPreset },
    ),
  }))
  return scrollFocusIntoView(next, output, config)
}

/**
 * Set a named column's width outright.
 *
 * `cycleWidth` is the keyboard's operation: one key, one step, no way to name
 * a destination. A panel offering the presets as four buttons has a
 * destination, and reaching it by stepping would push a layout per step,
 * animating the column through every width in between on the way to the one
 * that was asked for.
 *
 * Named column rather than the focused one, so choosing a width for a window
 * in the list does not first have to focus it.
 */
export function setColumnWidth(
  state: StripState,
  id: WindowId,
  preset: number,
  output: Output,
  config: StripConfig,
): StripState {
  const where = findWindow(state, id)
  if (!where || where.workspace !== state.focus) return state

  const width = clampIndex(preset, WIDTH_PRESETS.length) as WidthPreset
  const ws0 = currentWorkspace(state)
  if (ws0.columns[where.column]?.width === width) return state

  const next = withWorkspace(state, (ws) => ({
    ...ws,
    columns: ws.columns.map((column, i) => (i === where.column ? { ...column, width } : column)),
  }))
  return scrollFocusIntoView(next, output, config)
}

/**
 * Mark a named window's column as streaming all of itself, or stop.
 *
 * Named rather than focused, and no re-settling afterwards, for the same
 * reasons as {@link setColumnWidth}: the control is a row in a list, so
 * choosing from it must not first move focus somewhere the user did not ask
 * for. Unlike a width this changes no geometry at all, so there is no offset
 * to re-derive and nothing to animate. Only the stream list changes, and the
 * caller re-sends that.
 *
 * Returns the same object when nothing would change, which is what stops a
 * toggle pressed twice from pushing two identical layouts at the engine.
 */
export function setColumnLive(state: StripState, id: WindowId, live: boolean): StripState {
  const where = findWindow(state, id)
  if (!where || where.workspace !== state.focus) return state
  const column = currentWorkspace(state).columns[where.column]
  if (!column || (column.live ?? false) === live) return state

  return withWorkspace(state, (ws) => ({
    ...ws,
    columns: ws.columns.map((c, i) => (i === where.column ? { ...c, live } : c)),
  }))
}

/**
 * Does this window cover the whole output, leaving nothing around it?
 *
 * Asked geometrically rather than by reading the fullscreen flag, because the
 * question the shell actually needs answered is "is any of the desktop visible
 * around this window". A window with nothing beside it has no corners to round,
 * no neighbours to distinguish itself from with a focus ring, and nothing for a
 * shadow to fall on. Whatever made it that size is beside the point.
 *
 * `>=` rather than `===`: a rect is rounded to whole pixels on its way here, so
 * a window that fills the output can arrive a pixel over.
 */
export function fillsOutput(rect: WindowLayout["rect"], output: Output): boolean {
  return (
    rect.x <= 0 &&
    rect.y <= 0 &&
    rect.width >= output.width &&
    rect.height >= output.height
  )
}

/** Is the focused workspace showing a window fullscreen? */
export function isFullscreen(state: StripState): boolean {
  return currentWorkspace(state).fullscreen !== null
}

/** The window the focused workspace is showing fullscreen, if any. */
export function fullscreenWindow(state: StripState): WindowId | null {
  return currentWorkspace(state).fullscreen
}

/**
 * Fill the viewport with the focused window, or go back to the strip.
 *
 * "Full viewport" means exactly that: the client's whole visible area, not the
 * widest preset. On a tablet that is the difference between a video with the
 * strip's gaps and neighbours around it and a video, so it deserves its own
 * control rather than being the last stop on a width cycle.
 */
/**
 * Put a named window fullscreen, or take it out, because it asked.
 *
 * Separate from `toggleFullscreen`, which acts on the focused window and flips
 * whatever state it is in. A client's request says both which window and which
 * direction, and honouring it as a toggle would turn a player asking to *enter*
 * fullscreen while already fullscreen into a request to leave.
 *
 * The window is focused as well. A video that has just filled the screen and
 * does not have the keyboard cannot be paused with the space bar, which is the
 * first thing anybody tries.
 */
export function setFullscreen(
  state: StripState,
  id: WindowId,
  fullscreen: boolean,
  output: Output,
  config: StripConfig,
): StripState {
  const where = findWindow(state, id)
  if (!where || where.workspace !== state.focus) return state

  const focused = fullscreen ? focusWindow(state, id, output, config) : state
  const next = withWorkspace(focused, (ws) => ({
    ...ws,
    fullscreen: fullscreen ? id : ws.fullscreen === id ? null : ws.fullscreen,
  }))
  return scrollFocusIntoView(next, output, config)
}

/**
 * Fit the focused workspace's columns to the screen, or go back to scrolling.
 *
 * Clears fullscreen on the way in. Fitting is a request to see everything at
 * once and fullscreen is a request to see one thing, so leaving it set would
 * mean pressing "fit to screen" and watching nothing happen, since `layout`
 * short-circuits on fullscreen before it reaches any of this.
 *
 * The offset is re-derived rather than assumed, because that is what turns
 * scrolling off going in and puts the strip back under the focused column
 * coming out.
 */
export function setFit(
  state: StripState,
  fit: boolean,
  output: Output,
  config: StripConfig,
): StripState {
  if (currentWorkspace(state).fit === fit) return state
  const next = withWorkspace(state, (ws) => ({
    ...ws,
    fit,
    fullscreen: fit ? null : ws.fullscreen,
  }))
  return scrollFocusIntoView(next, output, config)
}

/** Is the focused workspace fitted to the screen? */
export function isFitted(state: StripState): boolean {
  return currentWorkspace(state).fit
}

export function toggleFullscreen(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const focused = focusedWindow(state)
  if (focused === null) return state

  const next = withWorkspace(state, (ws) => ({
    ...ws,
    fullscreen: ws.fullscreen === focused ? null : focused,
  }))
  // Still settle the offset. Leaving fullscreen has to land on a strip that is
  // scrolled to the window you were just looking at, not wherever it was when
  // you entered.
  return scrollFocusIntoView(next, output, config)
}

/**
 * Pull the focused window into the column on its left, stacking it.
 *
 * niri calls this "consume". It is how a stack gets built without a separate
 * mode: you open windows normally and merge the ones that belong together.
 */
export function consumeIntoColumn(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const ws0 = currentWorkspace(state)
  const at0 = clampIndex(ws0.focus, ws0.columns.length)
  // Nothing to consume into. Returning the same object matters: callers use
  // identity to decide whether to re-push a layout.
  if (at0 === 0 || ws0.columns.length < 2) return state

  const next = withWorkspace(state, (ws) => {
    const at = clampIndex(ws.focus, ws.columns.length)
    const source = ws.columns[at]!
    const id = source.windows[clampIndex(source.focus, source.windows.length)]
    if (id === undefined) return ws

    const columns = ws.columns
      .map((column, i) => {
        if (i === at - 1) {
          return { ...column, windows: [...column.windows, id], focus: column.windows.length }
        }
        if (i === at) {
          const windows = column.windows.filter((w) => w !== id)
          return { ...column, windows, focus: clampIndex(column.focus, windows.length) }
        }
        return column
      })
      .filter((column) => column.windows.length > 0)

    return { ...ws, columns, focus: clampIndex(at - 1, columns.length) }
  })
  return settle(next, output, config)
}

/**
 * Push the focused window out of its stack into a column of its own.
 *
 * The inverse of {@link consumeIntoColumn}. niri calls it "expel".
 */
export function expelFromColumn(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const ws0 = currentWorkspace(state)
  const source0 = ws0.columns[clampIndex(ws0.focus, ws0.columns.length)]
  // A column of one is already expelled.
  if (!source0 || source0.windows.length < 2) return state

  const next = withWorkspace(state, (ws) => {
    const at = clampIndex(ws.focus, ws.columns.length)
    const source = ws.columns[at]!

    const id = source.windows[clampIndex(source.focus, source.windows.length)]
    if (id === undefined) return ws

    const remaining = source.windows.filter((w) => w !== id)
    const columns = [...ws.columns]
    columns[at] = {
      ...source,
      windows: remaining,
      focus: clampIndex(source.focus, remaining.length),
    }
    columns.splice(at + 1, 0, { windows: [id], focus: 0, width: source.width })

    return { ...ws, columns, focus: at + 1 }
  })
  return settle(next, output, config)
}

/**
 * Where a window is being put.
 *
 * Two shapes rather than one index, because "join that column" and "become a
 * column between those two" are genuinely different intents and collapsing
 * them into a number makes the off-by-one unresolvable: index 2 would have to
 * mean both "inside the third column" and "before the third column".
 *
 * They are the two things a drag can land on. A window dropped on a column
 * joins it; a window dropped in the gap between columns gets one of its own.
 */
export type MoveTarget =
  | { kind: "column"; index: number; row?: number }
  | { kind: "newColumn"; index: number }

/**
 * Move a window to a chosen place in the strip.
 *
 * The general form of `consumeIntoColumn` and `expelFromColumn`, which move
 * the focused window one step in a fixed direction. Those are right for a
 * keyboard, where there is nowhere to point. A drag knows exactly where it is
 * going, and expressing that as a run of consume and expel calls would make an
 * intermediate arrangement visible on every step and could not express "into
 * the third row of that column" at all.
 *
 * The moved window keeps focus, because you are looking at it and it is
 * inconceivable that moving something should focus something else.
 */
export function moveWindow(
  state: StripState,
  id: WindowId,
  target: MoveTarget,
  output: Output,
  config: StripConfig,
): StripState {
  const where = findWindow(state, id)
  if (!where || where.workspace !== state.focus) return state

  const next = withWorkspace(state, (ws) => {
    // Lift it out first, then drop it in. Doing it in this order means the
    // insertion index is expressed in terms of the strip the user is looking
    // at *after* the gap the window left has closed up, which is what makes a
    // drag land where the highlight was.
    const emptied = ws.columns
      .map((column) => {
        if (!column.windows.includes(id)) return column
        const windows = column.windows.filter((w) => w !== id)
        return { ...column, windows, focus: clampIndex(column.focus, windows.length) }
      })
      .filter((column) => column.windows.length > 0)

    // The width a new column inherits: the one it came from, so a window
    // dragged out of a half-width column does not jump to a third.
    const width = ws.columns.find((column) => column.windows.includes(id))?.width ?? 0

    if (target.kind === "newColumn") {
      const at = Math.max(0, Math.min(target.index, emptied.length))
      const columns = [...emptied]
      columns.splice(at, 0, { windows: [id], focus: 0, width })
      return { ...ws, columns, focus: at }
    }

    // Dropping onto a column that no longer exists, because lifting the window
    // out emptied it, means the window was the column. Put it back as its own
    // rather than losing it.
    if (emptied.length === 0) {
      return { ...ws, columns: [{ windows: [id], focus: 0, width }], focus: 0 }
    }

    const at = clampIndex(target.index, emptied.length)
    const column = emptied[at]!
    const row =
      target.row === undefined
        ? column.windows.length
        : Math.max(0, Math.min(target.row, column.windows.length))
    const windows = [...column.windows]
    windows.splice(row, 0, id)

    const columns = [...emptied]
    columns[at] = { ...column, windows, focus: row }
    return { ...ws, columns, focus: at }
  })

  // Moving a window while something is fullscreen would rearrange a strip
  // nobody can see. Clearing it shows the result of what was just done.
  const shown = withWorkspace(next, (ws) => ({ ...ws, fullscreen: null }))
  return settle(shown, output, config)
}

/** Switch workspace. Clamped, and the trailing empty one is always reachable. */
export function focusWorkspace(
  state: StripState,
  delta: number,
  output: Output,
  config: StripConfig,
): StripState {
  const focus = clampIndex(state.focus + delta, state.workspaces.length)
  return scrollFocusIntoView({ ...state, focus }, output, config)
}

/**
 * Move the focused window to another workspace, following it there.
 *
 * Done in one step rather than as remove-then-add. Removing normalises the
 * workspace list, and if that collapses the workspace being left, every later
 * index shifts and the window lands back where it started.
 */
export function moveToWorkspace(
  state: StripState,
  delta: number,
  output: Output,
  config: StripConfig,
): StripState {
  const id = focusedWindow(state)
  if (id === null) return state

  const from = clampIndex(state.focus, state.workspaces.length)
  const to = clampIndex(from + delta, state.workspaces.length)
  if (to === from) return state

  const workspaces = state.workspaces.map((ws, index) => {
    if (index === from) return detach(ws, id)
    if (index === to) return attach(ws, id, config)
    return ws
  })

  // Normalise once, at the end, when both sides are already correct.
  const moved = normaliseWorkspaces({ ...state, workspaces, focus: to })
  // Focus the workspace the window actually ended up on, since normalising may
  // have renumbered them.
  const landed = findWindow(moved, id)
  return scrollFocusIntoView(
    landed ? { ...moved, focus: landed.workspace } : moved,
    output,
    config,
  )
}

/**
 * Send a named window to a named workspace, and stay where you are.
 *
 * Two differences from `moveToWorkspace`, both deliberate.
 *
 * It names the window rather than acting on the focused one, because a drag
 * knows what it picked up and focusing something first just to move it would
 * be a visible flicker on the way to somewhere else.
 *
 * It does not follow the window. `moveToWorkspace` is a keyboard command, and
 * a keyboard has no way to say "and now show me that"; following is the only
 * way to see what happened. A drag onto a workspace chip is the opposite: you
 * are tidying, and being thrown onto another workspace on every flick would
 * make organising three windows into three separate journeys back.
 */
export function sendToWorkspace(
  state: StripState,
  id: WindowId,
  index: number,
  output: Output,
  config: StripConfig,
): StripState {
  const from = findWindow(state, id)
  if (!from) return state

  const to = clampIndex(index, state.workspaces.length)
  if (to === from.workspace) return state

  const workspaces = state.workspaces.map((ws, at) => {
    if (at === from.workspace) return detach(ws, id)
    if (at === to) return attach(ws, id, config)
    return ws
  })

  // Normalising can renumber workspaces, so where we were standing has to be
  // found again rather than assumed to still be `state.focus`.
  const staying = state.workspaces[clampIndex(state.focus, state.workspaces.length)]
  const moved = normaliseWorkspaces({ ...state, workspaces, focus: state.focus })
  const stillThere = staying ? moved.workspaces.indexOf(staying) : -1

  return scrollFocusIntoView(
    stillThere === -1 ? moved : { ...moved, focus: stillThere },
    output,
    config,
  )
}

/** Remove a window from a workspace, dropping any column it empties. */
function detach(ws: Workspace, id: WindowId): Workspace {
  const columns = ws.columns
    .map((column) => {
      if (!column.windows.includes(id)) return column
      const windows = column.windows.filter((w) => w !== id)
      return { ...column, windows, focus: clampIndex(column.focus, windows.length) }
    })
    .filter((column) => column.windows.length > 0)
  return { ...ws, columns, focus: clampIndex(ws.focus, columns.length) }
}

/** Add a window to a workspace as a new column beside its focus. */
function attach(ws: Workspace, id: WindowId, config: StripConfig): Workspace {
  const at = ws.columns.length === 0 ? 0 : clampIndex(ws.focus, ws.columns.length) + 1
  const columns = [...ws.columns]
  columns.splice(at, 0, { windows: [id], focus: 0, width: config.defaultWidth })
  return { ...ws, columns, focus: at }
}

/**
 * Re-derive the offset after the viewport changes.
 *
 * Column widths are fractions of the viewport, so they do change on resize.
 * What must not change is which windows exist, their order, or their stacking.
 */
export function reflow(state: StripState, output: Output, config: StripConfig): StripState {
  return scrollFocusIntoView(state, output, config)
}

/** Every window in the whole strip, across all workspaces. */
export function allWindows(state: StripState): WindowId[] {
  return state.workspaces.flatMap((ws) => ws.columns.flatMap((c) => c.windows))
}
