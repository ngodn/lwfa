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


export type PadKind = "button" | "dpad" | "stick" | "trigger" | "key"

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
   * Unused. Stick clicks are separate buttons; see `DEFAULT_LAYOUT`.
   *
   * Kept so a layout saved before that change still parses rather than being
   * thrown away, taking the rest of someone's arrangement with it.
   *
   * A stick that cannot be clicked is missing a button every shooter binds to
   * sprint or crouch, so the press is part of the stick rather than a separate
   * control sitting under it where no thumb could reach.
   */
  clickCode?: number
  /**
   * For `kind: "key"`: a whole keyboard chord, **the key last**.
   *
   * `[56, 35]` is Alt+H: everything before the last entry is held around it.
   * Flat rather than `{ modifiers, code }` because the order it is sent in is
   * the order it is written in, and the reverse of that is the order it is
   * released in.
   *
   * These exist because a controller has seventeen controls and a game may
   * want an eighteenth thing that is not on one: a quicksave, a console, a
   * screenshot, a mod menu. None of them are in `DEFAULT_LAYOUT`, on purpose.
   * A default controller should be a controller; these are what somebody adds
   * when their particular game wants one.
   */
  chord?: number[]
  /** For `kind: "key"`: what to draw on it. Falls back to the chord's name. */
  label?: string
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
  | "key"

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

  // Left stick. No click binding: see the L3/R3 buttons below.
  {
    id: "lstick",
    kind: "stick",
    face: "lstick",
    x: 18, y: 78, size: 22,
    directions: [17, 32, 31, 30], // W D S A, for the keyboard mode
  },

  // Face cluster on the right, in the standard diamond.
  { id: "north", kind: "button", face: "north", x: 86, y: 40, size: 12, code: 19 }, // R
  { id: "west", kind: "button", face: "west", x: 77, y: 51, size: 12, code: 34 }, // G
  { id: "east", kind: "button", face: "east", x: 94, y: 51, size: 12, code: 48 }, // B
  { id: "south", kind: "button", face: "south", x: 86, y: 62, size: 12, code: 57 }, // Space

  // Right stick. No click binding, for the same reason.
  {
    id: "rstick",
    kind: "stick",
    face: "rstick",
    x: 80, y: 82, size: 22,
    directions: [103, 106, 108, 105],
  },

  // L3 and R3 as buttons of their own, not as clicks on the sticks.
  //
  // A physical stick can be pushed straight down without moving; a thumb on
  // glass cannot. Pressing to click and sliding to aim are the same gesture
  // here, so a stick-click binding either fires when you meant to aim or never
  // fires at all. Every shooter binds these to sprint and melee, so they get
  // real buttons, next to the shoulders where a spare finger already is.
  { id: "l3", kind: "button", face: "l3", x: 8, y: 41, size: 11, code: 46 }, // C, crouch
  { id: "r3", kind: "button", face: "r3", x: 92, y: 41, size: 11, code: 50 }, // M

  // Centre cluster.
  { id: "select", kind: "button", face: "select", x: 42, y: 12, size: 9, code: 15 }, // Tab
  { id: "guide", kind: "button", face: "guide", x: 50, y: 12, size: 9, code: 125 }, // Super
  { id: "start", kind: "button", face: "start", x: 58, y: 12, size: 9, code: 1 }, // Esc
]

/**
 * Where each face sits in the W3C standard gamepad mapping.
 *
 * That mapping is what the browser's own Gamepad API reports, what the engine
 * translates into Linux button codes, and therefore the one vocabulary shared
 * by a physical controller and this drawn one. A face with no entry here is
 * keyboard-only.
 */
export const FACE_TO_BUTTON: Partial<Record<PadFace, number>> = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
  l3: 10,
  r3: 11,
  guide: 16,
}

/** The four buttons a d-pad press maps to: up, right, down, left. */
export const DPAD_BUTTONS = [12, 15, 13, 14] as const

/**
 * The analog axis a shoulder trigger drives, alongside its button.
 *
 * A real trigger is a lever, and a game may read only how far it is pulled: a
 * racing game asks the axis how much throttle, never whether the button is
 * down. A drawn trigger is a tap, so it reports fully pulled or not at all,
 * but it has to report on the axis as well or those games see nothing happen.
 */
export const TRIGGER_AXES: Partial<Record<PadFace, number>> = {
  l2: 4,
  r2: 5,
}

/** The axis pair each stick drives: [x, y]. */
export const STICK_AXES: Partial<Record<PadFace, readonly [number, number]>> = {
  lstick: [0, 1],
  rstick: [2, 3],
}

/** Human-readable name for a chord, for a key pad with no label of its own. */
export function chordLabel(chord: readonly number[]): string {
  return chord.map((code) => KEY_NAMES[code] ?? `#${code}`).join("+")
}

/**
 * Names for the codes a chord is likely to contain.
 *
 * Deliberately not the whole evdev table: this is for drawing on a button the
 * size of a thumb, so it covers the modifiers, the letters and digits, the
 * function row and the keys people actually bind. Anything else shows its
 * number, which is still better than nothing and still editable.
 */
export const KEY_NAMES: Record<number, string> = {
  1: "Esc", 14: "Bksp", 15: "Tab", 28: "Enter", 29: "Ctrl", 42: "Shift",
  54: "RShift", 56: "Alt", 57: "Space", 97: "RCtrl", 100: "RAlt", 125: "Super",
  59: "F1", 60: "F2", 61: "F3", 62: "F4", 63: "F5", 64: "F6", 65: "F7",
  66: "F8", 67: "F9", 68: "F10", 87: "F11", 88: "F12",
  103: "Up", 105: "Left", 106: "Right", 108: "Down",
  102: "Home", 107: "End", 104: "PgUp", 109: "PgDn", 110: "Ins", 111: "Del",
  99: "PrtSc", 119: "Pause", 127: "Menu",
  2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
  12: "-", 13: "=", 26: "[", 27: "]", 39: ";", 40: "'", 41: "`", 43: "\\",
  51: ",", 52: ".", 53: "/",
  16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Y", 22: "U", 23: "I",
  24: "O", 25: "P", 30: "A", 31: "S", 32: "D", 33: "F", 34: "G", 35: "H",
  36: "J", 37: "K", 38: "L", 44: "Z", 45: "X", 46: "C", 47: "V", 48: "B",
  49: "N", 50: "M",
}

/** Clamp a pad to the play area, so a drag cannot lose it off an edge. */
export function clampPad(pad: Pad): Pad {
  return {
    ...pad,
    x: Math.min(97, Math.max(3, pad.x)),
    y: Math.min(97, Math.max(3, pad.y)),
    size: Math.min(40, Math.max(6, pad.size)),
  }
}
