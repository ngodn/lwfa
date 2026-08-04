/**
 * Short haptic taps, on the platforms that have any.
 *
 * # Why this is not just `navigator.vibrate`
 *
 * Because iOS has never implemented it. The Vibration API is absent from
 * Safari on every iOS version, so `navigator.vibrate?.(6)` on an iPad is a
 * no-op that reads like working code: the setting toggles, the call runs, the
 * optional-chain swallows it, and nothing ever buzzes. That is exactly how the
 * gamepad's "vibrate on press" shipped, and the only way to notice is to hold
 * the device.
 *
 * # What iOS does have
 *
 * A side effect. Safari 17.4 added `<input type="checkbox" switch>`, the
 * native-looking toggle, and toggling one plays a system haptic. Clicking a
 * hidden one from inside a real user gesture is therefore the only way to ask
 * iOS for a tap from the web, and it is what every library doing this uses.
 *
 * **Apple patched it in iOS 26.5.** On 26.5 and later there is no mechanism
 * at all, and this module degrades to doing nothing rather than pretending.
 * Nothing here can change that; it is not a bug to be found later.
 *
 * # Why a gesture is required
 *
 * The switch has to be clicked while the browser considers a user gesture to
 * be in progress, which is true inside `pointerdown` and `click` handlers and
 * false inside a timer or a socket callback. So this is only ever called from
 * an input handler, and a "test vibration" button works for the same reason.
 */

/** Milliseconds, for the platforms that take a duration. iOS ignores it. */
export type Strength = number

/**
 * A press: the shortest tap that still registers. Buttons and keys.
 *
 * Deliberately small. A controller whose every button thumps is worse than one
 * that does nothing, and on a stick it would fire continuously.
 */
export const TAP: Strength = 6

/** A slightly longer one, for a confirmation the user asked for. */
export const CONFIRM: Strength = 18

const canVibrate = (): boolean => typeof globalThis.navigator?.vibrate === "function"

let toggle: HTMLInputElement | null = null

/**
 * The hidden switch, created once and left in the document.
 *
 * It has to be laid out to be clickable, so it is one transparent pixel in a
 * corner rather than `display: none`, and it is `aria-hidden` with a negative
 * tab index so nothing can reach it by keyboard or screen reader.
 */
function iosToggle(): HTMLInputElement | null {
  if (toggle) return toggle
  const doc = globalThis.document
  if (!doc?.body) return null
  const input = doc.createElement("input")
  input.type = "checkbox"
  // Not in the HTML type definitions: it is Safari's own attribute, and the
  // whole mechanism depends on it. `setAttribute` rather than a cast.
  input.setAttribute("switch", "")
  input.setAttribute("aria-hidden", "true")
  input.tabIndex = -1
  input.style.cssText =
    "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;" +
    "pointer-events:none;z-index:-1;margin:0;padding:0;border:0"
  doc.body.appendChild(input)
  toggle = input
  return input
}

/**
 * What this device can actually do, for labelling the setting honestly.
 *
 * Not for deciding whether to call [`tap`], which is safe anywhere.
 *
 * `"switch"` is deliberately not called "supported". The attribute is still
 * there on iOS 26.5 and later, and still renders a toggle; it just no longer
 * plays anything. There is no way to feature-detect that, so the honest report
 * is "this is the only mechanism available and Apple may have removed it",
 * which is what the setting says.
 */
export type HapticSupport = "vibration" | "switch" | "none"

export function hapticSupport(): HapticSupport {
  if (canVibrate()) return "vibration"
  // Safari, including on iPadOS where the UA claims to be a Mac. The switch
  // attribute is the capability, so ask about the attribute.
  const doc = globalThis.document
  if (!doc) return "none"
  const probe = doc.createElement("input")
  probe.type = "checkbox"
  return "switch" in probe ? "switch" : "none"
}

/**
 * Play a short haptic, if the platform has one. Safe to call unconditionally.
 *
 * Must be reached from a user gesture; see the module comment.
 */
export function tap(strength: Strength = TAP): void {
  if (canVibrate()) {
    globalThis.navigator.vibrate?.(strength)
    return
  }
  // Toggling is what plays it, so this flips state every time rather than
  // driving it to a particular value. Nothing reads the checkbox.
  iosToggle()?.click()
}
