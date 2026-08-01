/**
 * The on-screen gamepad's layout and what its controls send.
 *
 * # Why it sends keys
 *
 * The shell protocol carries keyboard, pointer and touch, not gamepad axes.
 * Adding a gamepad transport would mean a protocol change, a Wayland virtual
 * input device on the engine side, and a compositor that pretends to be an
 * evdev joystick. Meanwhile every emulator, every browser game and most native
 * Linux games are perfectly happy being driven from the keyboard, and that is
 * the path that already works end to end today.
 *
 * So each pad is bound to a keycode. When a real gamepad transport lands, the
 * binding becomes a union and the layout does not have to change.
 *
 * # Units
 *
 * Position is a percentage of the play area, so a layout survives a rotation or
 * a different device. Size is a percentage of the area's *smaller* side, which
 * is what keeps a thumb-sized button thumb-sized in both orientations.
 *
 * # Why the layout is data
 *
 * Because the right layout depends on the hands holding the device, the game
 * being played, and where the notch is. Anything hard-coded here would be wrong
 * for somebody. The editor writes this structure and preferences store it.
 */


export type PadKind = "button" | "dpad" | "stick" | "trigger"

/**
 * The controls a controller actually has.
 *
 * Taken from the W3C Gamepad API's "standard gamepad" mapping, which is the
 * layout every console pad since the DualShock has converged on and the one
 * browsers normalise to. Seventeen buttons and two analog sticks:
 *
 *   0-3    face cluster: south, east, west, north
 *   4,5    shoulder bumpers: L1, R1
 *   6,7    triggers: L2, R2
 *   8,9    select and start
 *   10,11  stick presses: L3, R3
 *   12-15  d-pad
 *   16     guide
 *
 * Anything missing from that list is a control somebody's game expects to
 * exist, which is why the first version of this file (four buttons, a d-pad and
 * two bumpers) was not a gamepad.
 */

export interface Pad {
  id: string
  kind: PadKind
  /** Face label. Skins reinterpret this: `south` is ✕ on PlayStation, A on Xbox. */
  face: PadFace
  /** Position in percent of the play area, so a layout survives a rotation. */
  x: number
  y: number
  /** Size in percent of the play area's smaller side (`cqmin`). */
  size: number
  /** evdev keycode this sends. A dpad or stick sends four; see `directions`. */
  code?: number
  /** For dpad and stick: up, right, down, left. */
  directions?: [number, number, number, number]
  /**
   * For a stick: the keycode its *click* sends, which is L3 or R3.
   *
   * A stick that cannot be clicked is missing a button every shooter binds to
   * sprint or crouch, so the press is part of the stick rather than a separate
   * control sitting under it where no thumb could reach.
   */
  clickCode?: number
}

export type PadFace =
  | "north"
  | "south"
  | "east"
  | "west"
  | "l1"
  | "r1"
  | "l2"
  | "r2"
  | "l3"
  | "r3"
  | "start"
  | "select"
  | "guide"
  | "dpad"
  | "lstick"
  | "rstick"

/** What each face is called, per skin. Purely visual; bindings do not change. */
export const SKIN_LABELS: Record<string, Partial<Record<PadFace, string>>> = {
  playstation: {
    north: "△", south: "✕", east: "○", west: "□",
    l1: "L1", r1: "R1", l2: "L2", r2: "R2", l3: "L3", r3: "R3",
    start: "OPTIONS", select: "SHARE", guide: "PS",
  },
  xbox: {
    north: "Y", south: "A", east: "B", west: "X",
    l1: "LB", r1: "RB", l2: "LT", r2: "RT", l3: "LS", r3: "RS",
    start: "MENU", select: "VIEW", guide: "XBOX",
  },
  neutral: {
    north: "N", south: "S", east: "E", west: "W",
    l1: "L1", r1: "R1", l2: "L2", r2: "R2", l3: "L3", r3: "R3",
    start: "START", select: "SELECT", guide: "HOME",
  },
}

/**
 * A sensible starting point: WASD on the left, the usual keyboard stand-ins for
 * face buttons on the right.
 *
 * Positioned low and at the edges, where thumbs are when a tablet is held in
 * two hands, and clear of the middle so the game stays visible.
 */
export const DEFAULT_LAYOUT: Pad[] = [
  // Shoulders and triggers, stacked in the top corners where index fingers
  // rest when a tablet is held in two hands.
  { id: "l2", kind: "trigger", face: "l2", x: 8, y: 9, size: 13, code: 42 }, // Shift
  { id: "l1", kind: "trigger", face: "l1", x: 8, y: 25, size: 13, code: 29 }, // Ctrl
  { id: "r2", kind: "trigger", face: "r2", x: 92, y: 9, size: 13, code: 18 }, // E
  { id: "r1", kind: "trigger", face: "r1", x: 92, y: 25, size: 13, code: 33 }, // F

  // D-pad above the left stick, as on a DualShock.
  { id: "dpad", kind: "dpad", face: "dpad", x: 15, y: 44, size: 22, directions: [103, 106, 108, 105] },

  // Left stick: WASD, clicking for L3.
  {
    id: "lstick",
    kind: "stick",
    face: "lstick",
    x: 18, y: 78, size: 26,
    directions: [17, 32, 31, 30], // W D S A
    clickCode: 46, // C, the usual crouch
  },

  // Face cluster on the right, in the standard diamond.
  { id: "north", kind: "button", face: "north", x: 86, y: 40, size: 12, code: 19 }, // R
  { id: "west", kind: "button", face: "west", x: 77, y: 51, size: 12, code: 34 }, // G
  { id: "east", kind: "button", face: "east", x: 94, y: 51, size: 12, code: 48 }, // B
  { id: "south", kind: "button", face: "south", x: 86, y: 62, size: 12, code: 57 }, // Space

  // Right stick: arrow keys, clicking for R3.
  {
    id: "rstick",
    kind: "stick",
    face: "rstick",
    x: 80, y: 82, size: 24,
    directions: [103, 106, 108, 105],
    clickCode: 50, // M
  },

  // Centre cluster.
  { id: "select", kind: "button", face: "select", x: 42, y: 12, size: 9, code: 15 }, // Tab
  { id: "guide", kind: "button", face: "guide", x: 50, y: 12, size: 9, code: 125 }, // Super
  { id: "start", kind: "button", face: "start", x: 58, y: 12, size: 9, code: 1 }, // Esc
]

/** Clamp a pad to the play area, so a drag cannot lose it off an edge. */
export function clampPad(pad: Pad): Pad {
  return {
    ...pad,
    x: Math.min(97, Math.max(3, pad.x)),
    y: Math.min(97, Math.max(3, pad.y)),
    size: Math.min(40, Math.max(6, pad.size)),
  }
}
