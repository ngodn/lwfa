/**
 * The on-screen keyboard's layout, in evdev keycodes.
 *
 * # Why keycodes and not characters
 *
 * The compositor holds an xkb keymap and does the translation itself, exactly
 * as it does for a physical keyboard. Sending "A" would mean deciding here what
 * layout the remote machine has, which this side cannot know: the same physical
 * key is `q` on QWERTY and `a` on AZERTY. Sending the *key* and letting the far
 * end decide what it means is the only version that works for someone whose
 * remote machine is not configured like their tablet.
 *
 * The legends below are therefore only labels. They say what a US layout would
 * produce, and they are wrong for other layouts in exactly the way a printed
 * keycap is wrong when you remap it.
 *
 * Values are Linux `input-event-codes.h` numbers, the same ones the engine
 * already receives from the browser's `KeyboardEvent.code` mapping.
 */

export interface KeyDef {
  /** evdev keycode. */
  code: number
  /** What a US layout produces unshifted. */
  legend: string
  /** What it produces with shift, when that is not simply the upper case. */
  shifted?: string
  /** Relative width, 1 = a normal key. */
  width?: number
  /** Modifiers latch instead of firing, so a combo can be built one tap at a time. */
  modifier?: ModifierId
}

export type ModifierId = "shift" | "ctrl" | "alt" | "super"

export const MODIFIER_CODES: Record<ModifierId, number> = {
  shift: 42, // LEFTSHIFT
  ctrl: 29, // LEFTCTRL
  alt: 56, // LEFTALT
  super: 125, // LEFTMETA
}

const K = (code: number, legend: string, shifted?: string, width?: number): KeyDef => ({
  code,
  legend,
  ...(shifted !== undefined ? { shifted } : {}),
  ...(width !== undefined ? { width } : {}),
})

const MOD = (code: number, legend: string, modifier: ModifierId, width = 1.5): KeyDef => ({
  code,
  legend,
  width,
  modifier,
})

/** The main block, one array per row. */
export const MAIN_ROWS: KeyDef[][] = [
  [
    K(41, "`", "~"),
    K(2, "1", "!"),
    K(3, "2", "@"),
    K(4, "3", "#"),
    K(5, "4", "$"),
    K(6, "5", "%"),
    K(7, "6", "^"),
    K(8, "7", "&"),
    K(9, "8", "*"),
    K(10, "9", "("),
    K(11, "0", ")"),
    K(12, "-", "_"),
    K(13, "=", "+"),
    K(14, "Bksp", undefined, 2),
  ],
  [
    K(15, "Tab", undefined, 1.5),
    K(16, "q"),
    K(17, "w"),
    K(18, "e"),
    K(19, "r"),
    K(20, "t"),
    K(21, "y"),
    K(22, "u"),
    K(23, "i"),
    K(24, "o"),
    K(25, "p"),
    K(26, "[", "{"),
    K(27, "]", "}"),
    K(43, "\\", "|", 1.5),
  ],
  [
    K(58, "Caps", undefined, 1.75),
    K(30, "a"),
    K(31, "s"),
    K(32, "d"),
    K(33, "f"),
    K(34, "g"),
    K(35, "h"),
    K(36, "j"),
    K(37, "k"),
    K(38, "l"),
    K(39, ";", ":"),
    K(40, "'", '"'),
    K(28, "Enter", undefined, 2.25),
  ],
  [
    MOD(42, "Shift", "shift", 2.25),
    K(44, "z"),
    K(45, "x"),
    K(46, "c"),
    K(47, "v"),
    K(48, "b"),
    K(49, "n"),
    K(50, "m"),
    K(51, ",", "<"),
    K(52, ".", ">"),
    K(53, "/", "?"),
    K(103, "↑"),
    K(111, "Del"),
  ],
  [
    MOD(29, "Ctrl", "ctrl"),
    MOD(125, "Super", "super"),
    MOD(56, "Alt", "alt"),
    K(57, "Space", undefined, 6),
    K(105, "←"),
    K(108, "↓"),
    K(106, "→"),
  ],
]

/** Function keys and navigation, shown on wider viewports or on demand. */
export const FUNCTION_ROW: KeyDef[] = [
  K(1, "Esc"),
  K(59, "F1"),
  K(60, "F2"),
  K(61, "F3"),
  K(62, "F4"),
  K(63, "F5"),
  K(64, "F6"),
  K(65, "F7"),
  K(66, "F8"),
  K(67, "F9"),
  K(68, "F10"),
  K(87, "F11"),
  K(88, "F12"),
]

/**
 * The keys a full-size keyboard has and a laptop mostly does not.
 *
 * These are the ones behind the toggle, and they are the *right* ones to hide:
 * you go a week without pressing Scroll Lock and you press Escape forty times
 * an hour. Escape and the function row are always on screen for exactly that
 * reason; see `Keyboard.tsx`.
 */
export const EXTRA_KEYS: KeyDef[] = [
  K(110, "Ins"),
  K(102, "Home"),
  K(104, "PgUp"),
  K(107, "End"),
  K(109, "PgDn"),
  K(99, "PrtSc"),
  K(70, "ScrLk"),
  K(119, "Pause"),
  K(127, "Menu"),
  K(69, "NumLk"),
]

/**
 * Combos worth one tap.
 *
 * Not a substitute for the latch: these are the ones muscle memory expects to
 * be a single gesture, and building them a modifier at a time on a touchscreen
 * every time is genuinely worse than a button.
 */
export interface Combo {
  label: string
  hint: string
  modifiers: ModifierId[]
  code: number
}

export const COMBOS: Combo[] = [
  { label: "Ctrl C", hint: "Copy, or interrupt", modifiers: ["ctrl"], code: 46 },
  { label: "Ctrl V", hint: "Paste", modifiers: ["ctrl"], code: 47 },
  { label: "Ctrl X", hint: "Cut", modifiers: ["ctrl"], code: 45 },
  { label: "Ctrl Z", hint: "Undo", modifiers: ["ctrl"], code: 44 },
  { label: "Ctrl A", hint: "Select all", modifiers: ["ctrl"], code: 30 },
  { label: "Ctrl S", hint: "Save", modifiers: ["ctrl"], code: 31 },
  { label: "Ctrl W", hint: "Close", modifiers: ["ctrl"], code: 17 },
  { label: "Ctrl D", hint: "End of input", modifiers: ["ctrl"], code: 32 },
  { label: "Ctrl L", hint: "Clear", modifiers: ["ctrl"], code: 38 },
  { label: "Ctrl R", hint: "Reverse search", modifiers: ["ctrl"], code: 19 },
  { label: "Alt Tab", hint: "Switch window", modifiers: ["alt"], code: 15 },
  { label: "Alt F4", hint: "Quit", modifiers: ["alt"], code: 62 },
  { label: "Ctrl Alt Del", hint: "", modifiers: ["ctrl", "alt"], code: 111 },
  { label: "Ctrl Alt T", hint: "Terminal", modifiers: ["ctrl", "alt"], code: 20 },
]
