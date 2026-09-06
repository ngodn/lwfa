/**
 * Translating browser input into what a Wayland compositor expects.
 *
 * # Physical keys, not characters
 *
 * The map below is keyed on `KeyboardEvent.code`, the *physical* key, and
 * produces Linux evdev codes. It deliberately does not use `KeyboardEvent.key`,
 * which is the character the browser produced after applying the local keyboard
 * layout and modifiers.
 *
 * Sending the character would apply a layout twice. Someone on a Dvorak laptop
 * driving a machine configured for QWERTY would get nonsense, and dead keys and
 * compose sequences would break entirely. Sending the physical key lets the
 * compositor's own xkb configuration decide what it means, which is exactly
 * what happens for a keyboard plugged in locally.
 *
 * # Coordinates
 *
 * Window-relative logical pixels, derived from the element's own bounding box
 * so the maths is independent of whatever scale the scene is drawn at. See
 * `windowPoint`.
 */

import type { ButtonCode, KeyCode } from "@lwfa/proto"

/**
 * `KeyboardEvent.code` to Linux evdev keycode.
 *
 * Values are from `linux/input-event-codes.h`. The engine adds 8 to get an xkb
 * keycode, which is a fixed part of the X11/xkb protocol.
 */
const EVDEV_BY_CODE: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 86, F11: 87, F12: 88,
  IntlRo: 89, Convert: 92, KanaMode: 93, NonConvert: 94,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98,
  PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105,
  ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111,
  AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115,
  Pause: 119, IntlYen: 124, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
}

/** Linux `BTN_*` codes. Browser button numbers are not these. */
const EVDEV_BUTTONS: Readonly<Record<number, number>> = {
  0: 0x110, // BTN_LEFT
  1: 0x112, // BTN_MIDDLE  (browser 1 is middle, not right)
  2: 0x111, // BTN_RIGHT
  3: 0x113, // BTN_SIDE
  4: 0x114, // BTN_EXTRA
}

/** Null for a key with no evdev equivalent, which should be dropped. */
export function evdevFromCode(code: string): KeyCode | null {
  return EVDEV_BY_CODE[code] ?? null
}

export function evdevFromButton(button: number): ButtonCode | null {
  return EVDEV_BUTTONS[button] ?? null
}

/**
 * Convert a pointer event into window-relative logical pixels.
 *
 * Derived from the element's own `getBoundingClientRect()` rather than from the
 * scene's scale factor, so it stays correct however the scene is transformed,
 * including while a CSS animation is mid-flight.
 *
 * Returns null for a degenerate box, which happens for a window that has been
 * scrolled to zero width.
 */
/**
 * Where a pointer landed, in the window's own coordinates.
 *
 * # Why the content size and not the layout rectangle
 *
 * The obvious source for the scale is the rectangle the shell laid the window
 * out at, and it is wrong whenever the application has not taken that size.
 * A window's pixels arrive at whatever size the *client* chose to render: a
 * terminal resizes promptly, but a browser lags a resize by a frame or refuses
 * a size outright, and the shell paints whatever arrives stretched to fill the
 * box.
 *
 * Mapping through the layout rectangle then sends coordinates for a window
 * that is not the one on screen. Measured in practice: a 1192x814 image
 * stretched into an 1172x1122 box, so a click near the bottom of what the user
 * could see arrived roughly three hundred pixels above it. Large targets still
 * worked, which is what made it look intermittent rather than broken.
 *
 * `content` chooses the local coordinate space. The streaming surface now
 * uses layout pixels for gesture thresholds and normalizes the result before
 * sending it. The engine then maps that fraction into actual app geometry,
 * independently of frame resolution. Callers sending pixel coordinates must
 * still use the application's actual size, as in the example above.
 */
export function windowPoint(
  event: { clientX: number; clientY: number },
  element: Element,
  content: { width: number; height: number },
): { x: number; y: number } | null {
  const box = element.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  if (content.width <= 0 || content.height <= 0) return null
  return {
    x: ((event.clientX - box.left) / box.width) * content.width,
    y: ((event.clientY - box.top) / box.height) * content.height,
  }
}

/**
 * Snap a fullscreen pointer to the edge it is reaching, for edge-scroll panning.
 *
 * RTS and MOBA games pan the camera while the pointer rests against a screen
 * edge (moving the mouse to the edge in Dota moves the world). Two things stop
 * that working through the shell, and this fixes both:
 *
 * - The far edge must land *inside* the window, at `width - 1`, never at `width`.
 *   A motion at `width` is one pixel past the surface, which the engine reads as
 *   the pointer leaving the window (a motion with no surface under it is a
 *   leave), so the game stops scrolling instead of panning. Every value is
 *   clamped into `[0, width - 1] x [0, height - 1]` first.
 * - A pointer moved *fast* at the edge is only sampled every so often, so its
 *   last position falls short of the edge and the game never sees it arrive. Any
 *   point within `margin` of an edge is snapped onto it, so a fast flick, and
 *   the navbar-inset side you cannot travel past, both still reach the edge the
 *   game scrolls from.
 *
 * Corners snap on both axes, which pans diagonally. `parked` reports whether the
 * point was pinned to any edge.
 */
export function edgePark(
  point: { x: number; y: number },
  content: { width: number; height: number },
  margin: number,
): { x: number; y: number; parked: boolean } {
  const maxX = content.width - 1
  const maxY = content.height - 1
  let x = point.x < 0 ? 0 : point.x > maxX ? maxX : point.x
  let y = point.y < 0 ? 0 : point.y > maxY ? maxY : point.y
  let parked = false
  if (x <= margin) {
    x = 0
    parked = true
  } else if (x >= maxX - margin) {
    x = maxX
    parked = true
  }
  if (y <= margin) {
    y = 0
    parked = true
  } else if (y >= maxY - margin) {
    y = maxY
    parked = true
  }
  return { x, y, parked }
}

/**
 * Which fullscreen edge a leaving pointer was heading through.
 *
 * A pointer moved fast at an edge is sampled short of it and then leaves the
 * window, so the game never sees it arrive. The `pointerleave` event is the
 * signal, but its own coordinates are unreliable (they read `(0, 0)` when the
 * pointer leaves the viewport), so this works from `at`, the last position the
 * pointer actually held *inside* the window.
 *
 * It snaps only the single nearest edge's axis, keeping the other where the
 * pointer was, so the pan is pure up, down, left or right and never the phantom
 * up-left diagonal that trusting the event's `(0, 0)` produced. Returns null
 * when the last position was not within `reach` of any edge, which is an idle or
 * focus-loss leave rather than the pointer crossing out, and must not pan.
 */
export function edgeLeave(
  at: { x: number; y: number },
  content: { width: number; height: number },
  reach: number,
): { x: number; y: number } | null {
  const maxX = content.width - 1
  const maxY = content.height - 1
  const x = at.x < 0 ? 0 : at.x > maxX ? maxX : at.x
  const y = at.y < 0 ? 0 : at.y > maxY ? maxY : at.y
  const left = x
  const right = maxX - x
  const top = y
  const bottom = maxY - y
  const min = Math.min(left, right, top, bottom)
  if (min > reach) return null
  if (min === left) return { x: 0, y }
  if (min === right) return { x: maxX, y }
  if (min === top) return { x, y: 0 }
  return { x, y: maxY }
}

/**
 * Scroll deltas in logical pixels.
 *
 * `deltaMode` matters: browsers report lines or pages rather than pixels
 * depending on the device, and treating a line count as a pixel count makes the
 * wheel almost inert.
 */
export function wheelDelta(event: WheelEvent): { horizontal: number; vertical: number } {
  const LINE_HEIGHT = 16
  const PAGE_HEIGHT = 400
  const scale =
    event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? PAGE_HEIGHT : 1
  return { horizontal: event.deltaX * scale, vertical: event.deltaY * scale }
}

/**
 * Keys the shell keeps for itself rather than forwarding.
 *
 * Deliberately tiny. Every key swallowed here is one the user cannot send to
 * their application, and a remote desktop that eats Ctrl+W because the browser
 * wanted it is worse than useless. Only F11 (browser fullscreen) and F12
 * (devtools) are left alone, because taking those makes the page hard to
 * escape from.
 */
export function isShellKey(event: KeyboardEvent): boolean {
  return event.code === "F11" || event.code === "F12"
}

/**
 * Is the user typing into the shell's own UI rather than into the machine?
 *
 * Keys are captured on `window` because keyboard focus lives in the compositor
 * and no DOM element corresponds to it. That is right for the desktop and
 * catastrophic for the shell's own text fields: the capture-phase listener sees
 * the keystroke first, calls `preventDefault` so the browser never inserts the
 * character, and forwards it to whatever window has focus on the remote
 * machine. The search box stays empty, and what you typed is delivered
 * somewhere you were not looking.
 *
 * So: anything with a caret in it keeps its own keystrokes.
 *
 * Checked on the event target rather than `document.activeElement` because a
 * field inside a shadow root reports its host as the active element, and
 * because the target is what the event system already resolved.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag !== "INPUT") return false
  // Not every input takes text. A checkbox or a radio wants Space and the
  // arrow keys to behave like a control, not to insert anything, and swallowing
  // keys for those would make the rail's own switches deaf while adding
  // nothing.
  const type = (target as HTMLInputElement).type
  return !["checkbox", "radio", "button", "submit", "reset", "range"].includes(type)
}

/**
 * Should this keydown be forwarded?
 *
 * Browser autorepeat is dropped: Wayland advertises a repeat rate to clients,
 * which generate their own repeats, so forwarding the browser's as well makes a
 * held key repeat two or three times over.
 */
export function shouldForwardKeydown(event: KeyboardEvent): boolean {
  return !isShellKey(event) && !event.repeat && !isTextEntry(event.target)
}
