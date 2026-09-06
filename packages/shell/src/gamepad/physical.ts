/**
 * Reading a physical controller through the browser's Gamepad API.
 *
 * The engine already exposes a persistent virtual controller and binds it to
 * whichever session sends input (see the engine's `gamepad_for` and
 * `ensure_persistent_gamepad`), and the wire already carries `gamepadButton`
 * and `gamepadAxis`. The on-screen pad drives that path in `controller` mode;
 * so does a real controller. All this file does is read `navigator.getGamepads`
 * and turn what changed into the same messages, so nothing on the engine or the
 * protocol has to change.
 *
 * The browser reports the W3C "standard" mapping, whose button and axis indices
 * are exactly the ones the engine expects (see `crates/lwfa-proto` and
 * `model.ts`), so the mapping is one to one. The single wrinkle is triggers:
 * the standard mapping reports them as analog buttons (indices 6 and 7), while a
 * game may read only their travel, so each is sent both as a button and on its
 * axis (4 and 5), the same thing the on-screen trigger does.
 */

/** A gamepad message, matching what `useSessionActions().send` accepts. */
export type PadMessage =
  | { type: "gamepadButton"; button: number; pressed: boolean }
  | { type: "gamepadAxis"; axis: number; value: number }

/** The part of a `Gamepad` this cares about, snapshotted so it can be diffed. */
export interface PadSnapshot {
  buttons: readonly { pressed: boolean; value: number }[]
  axes: readonly number[]
}

export interface DiffOptions {
  /** Stick travel below this reads as centred, so a resting thumb sends nothing. */
  deadzone?: number
  /** Smallest analog change worth sending, so a still stick does not flood. */
  epsilon?: number
}

/** The highest button index the standard mapping (and the engine) knows. */
const MAX_BUTTON = 16
/** The stick axes, 0..3. Triggers ride their own axes; see `TRIGGER_AXIS`. */
const STICK_AXES = 4
/** Which analog axis each trigger button also drives. */
const TRIGGER_AXIS: Record<number, number> = { 6: 4, 7: 5 }

const DEFAULT_DEADZONE = 0.12
const DEFAULT_EPSILON = 0.02

/** Centre a value that is inside the deadzone, so a resting stick reads as 0. */
function dead(value: number, deadzone: number): number {
  return Math.abs(value) < deadzone ? 0 : value
}

function analogChanged(before: number, after: number, epsilon: number): boolean {
  // Always deliver neutral, including the last tiny part of a trigger release.
  return Math.abs(after - before) >= epsilon || (after === 0 && before !== 0)
}

/**
 * The messages that carry a controller from `prev` to `curr`.
 *
 * Only what changed: a button whose pressed state flipped, a trigger whose
 * travel moved past `epsilon`, a stick axis whose deadzoned value moved past
 * `epsilon`. An unchanged controller produces nothing, which is what keeps a
 * held stick from sending sixty identical frames a second.
 *
 * `prev` is compared as raw values; the deadzone is applied to both sides here,
 * so a stick returning to centre sends one 0 and then nothing.
 */
export function diffGamepad(
  prev: PadSnapshot,
  curr: PadSnapshot,
  options: DiffOptions = {},
): PadMessage[] {
  const deadzone = options.deadzone ?? DEFAULT_DEADZONE
  const epsilon = options.epsilon ?? DEFAULT_EPSILON
  const out: PadMessage[] = []

  for (let i = 0; i <= MAX_BUTTON; i++) {
    const before = prev.buttons[i] ?? { pressed: false, value: 0 }
    const after = curr.buttons[i] ?? { pressed: false, value: 0 }
    if (after.pressed !== before.pressed) {
      out.push({ type: "gamepadButton", button: i, pressed: after.pressed })
    }
    const axis = TRIGGER_AXIS[i]
    if (axis !== undefined && analogChanged(before.value, after.value, epsilon)) {
      out.push({ type: "gamepadAxis", axis, value: after.value })
    }
  }

  for (let i = 0; i < STICK_AXES; i++) {
    const before = dead(prev.axes[i] ?? 0, deadzone)
    const after = dead(curr.axes[i] ?? 0, deadzone)
    if (analogChanged(before, after, epsilon)) {
      out.push({ type: "gamepadAxis", axis: i, value: after })
    }
  }

  return out
}

/** A plain, comparable snapshot of a live `Gamepad`. */
export function snapshotOf(pad: Gamepad): PadSnapshot {
  return {
    buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
    axes: [...pad.axes],
  }
}

/** A neutral snapshot: everything released and centred. Used on disconnect. */
export const NEUTRAL: PadSnapshot = { buttons: [], axes: [] }

/** What one frame of polling carries forward: which pad, and its last state. */
export interface PollState {
  /** The index of the pad being driven, or null when none has been seen. */
  activeIndex: number | null
  /** The last snapshot sent for that pad, to diff the next frame against. */
  last: PadSnapshot
}

/** The starting point for `pollStep`: no pad, neutral baseline. */
export const IDLE: PollState = { activeIndex: null, last: NEUTRAL }

/**
 * One frame of reading the gamepads: the messages to send and the next state.
 *
 * Player one is the first pad reporting the W3C standard mapping; a
 * non-standard pad is skipped rather than mis-mapped. When the driven pad
 * changes (or is seen for the first time) the baseline resets to neutral, so
 * the new controller's held state is sent in full rather than diffed against
 * the old one. Release the old controller before a handoff, or when no usable
 * pad remains, so its held input cannot stay stuck in the engine.
 */
export function pollStep(
  pads: readonly (Gamepad | null)[],
  state: PollState,
  options: DiffOptions = {},
): { messages: PadMessage[]; state: PollState } {
  let pad: Gamepad | null = null
  for (const candidate of pads) {
    if (candidate && candidate.mapping === "standard") {
      pad = candidate
      break
    }
  }
  if (!pad) return { messages: diffGamepad(state.last, NEUTRAL, options), state: IDLE }
  const baseline = state.activeIndex === pad.index ? state.last : NEUTRAL
  const current = snapshotOf(pad)
  const messages = diffGamepad(baseline, current, options)
  const sentAxes = new Set(messages.flatMap((message) =>
    message.type === "gamepadAxis" ? [message.axis] : [],
  ))
  // Compare analog input against what the engine received, not the previous
  // sample. Otherwise slow movement below epsilon disappears at high poll rates.
  const last: PadSnapshot = {
    buttons: current.buttons.map((button, index) => {
      const axis = TRIGGER_AXIS[index]
      return axis === undefined || sentAxes.has(axis)
        ? button
        : { ...button, value: baseline.buttons[index]?.value ?? 0 }
    }),
    axes: current.axes.map((value, axis) =>
      sentAxes.has(axis) ? value : baseline.axes[axis] ?? 0,
    ),
  }
  return {
    messages: state.activeIndex !== null && state.activeIndex !== pad.index
      ? [...diffGamepad(state.last, NEUTRAL, options), ...messages]
      : messages,
    state: { activeIndex: pad.index, last },
  }
}
