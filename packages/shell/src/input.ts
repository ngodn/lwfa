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

import type { ButtonCode, KeyCode, Rect } from "@lwfa/proto"

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
export function windowPoint(
  event: { clientX: number; clientY: number },
  element: Element,
  rect: Rect,
): { x: number; y: number } | null {
  const box = element.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  return {
    x: ((event.clientX - box.left) / box.width) * rect.width,
    y: ((event.clientY - box.top) / box.height) * rect.height,
  }
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
 * Should this keydown be forwarded?
 *
 * Browser autorepeat is dropped: Wayland advertises a repeat rate to clients,
 * which generate their own repeats, so forwarding the browser's as well makes a
 * held key repeat two or three times over.
 */
export function shouldForwardKeydown(event: KeyboardEvent): boolean {
  return !isShellKey(event) && !event.repeat
}
