# lwfa controller input: architecture and the physical-gamepad bug

## Fix attempt, 2026-09-06

The implementation now polls immediately on connection and then every 8 ms
using `setTimeout`, independent of animation frames. The rAF listings below
describe the original implementation. The dock/shield behaviour is unchanged.

A regression test runs the actual hook effect with animation callbacks stalled
and gamepad state changing every 24 ms. Before the change, three presses and
releases produced no messages; afterwards all six edges arrive. It also checks
release and timer cleanup on disconnect and unmount. Run it with:

```sh
mise exec node@24.15.0 -- pnpm exec vitest run packages/shell/test/usePhysicalGamepad.test.ts packages/shell/test/physicalGamepad.test.ts
```

Faster polling also exposed an analog filtering bug: changes below epsilon were
discarded relative to the previous sample, so slow motion could disappear
indefinitely. `pollStep` now retains the last transmitted analog values as its
baseline. Returning to zero always emits an update, even below epsilon.
Regression tests cover slow stick/trigger movement and the final trigger release.

Current [WebKit source](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Gamepad/UIGamepadProvider.cpp)
uses a separate gamepad sync timer with a 1/120-second interval. This supports
trying polling between render frames, but does not establish the behaviour of
the installed iPadOS version. The [Gamepad specification](https://www.w3.org/TR/gamepad/)
exposes this API on Window, so a worker cannot directly poll it.

This reproduces and fixes render-dependent sampling in a controlled test, not
the full Bluetooth/Safari failure on hardware. Timers still share the main
thread and cannot recover transitions Safari never exposes. Validate on the
iPad while streaming the same game, keeping the pad open and shield on, by
repeating quick face-button presses and slow stick/trigger sweeps. If presses
still drop, capture poll gaps and raw button state as described in section 11.

## Testing on a separate dev engine (leave production alone)

You do not have to test against the production engine. lwfa runs the engine as a
Wayland compositor, so you can spawn a second, throwaway one beside it and never
risk the daily driver.

- **Production** is the systemd user service `lwfa.service`, serving on port
  `6733` (fronted by the local HTTPS proxy on `:8443`). Never kill it. Find its
  PID with `systemctl --user show lwfa.service -p MainPID`, and kill dev
  instances by their own PID only. Never `pkill -f lwfa`; that would take
  production down too.

- **A dev engine**: `scripts/dev-nested.sh` builds `target/debug/lwfa-engine`
  and runs it nested in the host Hyprland session on its own workspace
  (`LWFA_DEV_WORKSPACE`, default 10; never workspace 3, which is for gaming). It
  listens on `127.0.0.1:6734` by default, so it never clashes with production's
  6733. Recommended throwaway settings:

  ```sh
  AUTH_PASS=lwfa-dev-smoke LWFA_NO_PREVIEW=1 LWFA_DEV_WORKSPACE=10 \
    scripts/dev-nested.sh
  ```

  `LWFA_NO_PREVIEW=1` keeps it off the host's swapchain. `AUTH_PASS` sets
  the password; the URL must use that same value. `LWFA_SHELL_TOKEN` is not
  read by the current engine.

- **Fastest way to exercise the controller** (no iPad, no production, no Vite):
  build the shell once, then let the dev engine serve it and open it on the dev
  machine with a controller plugged into that machine.

  ```sh
  pnpm run build            # build the shell the engine serves
  # then, in another terminal, the dev-nested command above
  # open http://127.0.0.1:6734/?token=lwfa-dev-smoke
  ```

  `dev-nested.sh` now defaults `LWFA_SHELL_DIR` to this checkout's
  `packages/shell/dist`. This matters: the first test run inherited installed
  configuration and served an older bundle despite a successful local build.
  Check that the served index references the same asset as the local build.

  `127.0.0.1` counts as a secure context, so **WebCodecs and the Gamepad API
  both work there**. That is enough to iterate on the whole press -> diff ->
  send -> uinput -> game pipeline and confirm button mapping. Watch the dev
  engine's log for the persistent-pad line and "session ... picked up a
  controller" to confirm the wire messages arrive.

  (`pnpm --filter @lwfa/shell dev` gives Vite hot-reload instead, but Vite wants
  port 6733, which production already holds, so prefer the built-shell path above
  unless you stop production or move Vite's port.)

- **The one thing the dev machine cannot fully reproduce**: the render-starvation
  timing is worst under real streaming load, so the final sign-off for the 8 ms
  timer fix still wants the iPad over HTTPS while a game streams (quick
  face-button mashing and slow stick/trigger sweeps, pad open, shield on).
  Reaching the dev engine from the iPad needs an HTTPS proxy pointed at 6734 (the
  `:8443` proxy points at 6733), which is separate setup. The functional path,
  though, is entirely testable on the dev machine.

## Browser-to-kernel validation, 2026-09-06

Ran Chromium against a separate dev engine on port 6734, with controlled
Gamepad API states feeding the real built shell, WebSocket and Linux uinput
controller. Read the dev controller's evdev node directly, without grabbing it.

- With animation callbacks stalled, 100 presses and 100 releases at 24 ms
  spacing all arrived in order at evdev.
- Slow stick and trigger sweeps reached near full travel and returned to zero.
- The test found a stuck-button bug when the active controller disconnected
  while another remained connected. The hook now releases it immediately;
  polling also releases old input when a pad disappears or another takes over.
  The same live test passes after the fix.
- The shell build and all 620 unit tests passed.

The repeatable check is `scripts/e2e-gamepad.mjs`. It needs Playwright with its
Chromium browser installed. `PLAYWRIGHT_MODULE` can point to an existing
`playwright-core/index.mjs`; omit it if `playwright` resolves normally. Read the
**dev engine's** startup log for its virtual controller event node. Do not pick
the production controller by name: both devices have the same name.

```sh
AUTH_PASS=lwfa-dev-smoke GAMEPAD_EVENT=/dev/input/event25 \
  PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  mise exec node@24.15.0 -- node scripts/e2e-gamepad.mjs
```

Replace `event25` with the node from that dev run. The script only connects to
localhost port 6734 and verifies the served asset matches the local build. It
suppresses native controller connection events in its browser context because
the dev engine's virtual output controller is also visible to a local browser;
only the injected client-controller events should drive this test.

This validates browser polling through kernel events. It does not exercise a
physical Bluetooth controller, iPad Safari, or prove a game's response under
real streaming load. The iPad validation described above still applies.

A self-contained brief for debugging why a **physical game controller** feels
laggy and drops button presses when used through lwfa. Everything needed to
reason about it is inline, so no repo access is required.

## 1. Context

- **Client**: iPad Pro M1 11-inch, Safari, running the lwfa web shell as a PWA.
- **Controller**: 8BitDo Ultimate 2 Wireless, paired to the iPad over Bluetooth
  (MFi/native), so iPadOS exposes it and Safari reports it through the **W3C
  Gamepad API** with the "standard" mapping.
- **lwfa**: a remote-desktop system. A Rust/Smithay nested Wayland compositor
  (the "engine") runs games on a Linux box and streams video to the browser
  shell (TypeScript/React). Input travels shell -> engine over a WebSocket.
- The engine turns gamepad messages into a real Linux **uinput virtual
  controller** that games read like any physical pad.

## 2. The bug

Using the **physical** controller:

- Button presses are **not detected smoothly**; pressing a button several times
  quickly is laggy and **randomly sometimes registers, sometimes not**.
- It is not a hard disconnect, more like dropped/aliased samples.
- The **on-screen touch gamepad works fine** for the same games (it is
  event-driven, see section 5), which is the key contrast.
- An earlier, separate issue: with no on-screen pad open there was also a
  "controller mapping goes away" symptom, caused by the game switching out of
  gamepad mode on a stray touch when the tap **shield** was not active. That is
  understood (keep the shield up). The remaining, harder bug is the dropped/
  laggy presses **even with the on-screen pad open and the shield on**.

## 3. End-to-end pipeline

```
8BitDo (BT) -> iPadOS -> Safari Gamepad API
   -> [shell] usePhysicalGamepad rAF poll -> diffGamepad -> actions.send(...)
   -> WebSocket -> [engine] ToEngine::GamepadButton / GamepadAxis
   -> VirtualPad (uinput) -> game reads a normal controller
```

The suspect stage is the **rAF poll in the shell**: the Gamepad API has no
"button changed" event, so state must be polled, and the poll currently runs on
`requestAnimationFrame`, which the browser throttles under load (video decode,
compositing). A fast press that goes down and up between two throttled frames is
never sampled, so it is dropped. Repeated fast presses alias badly. This matches
the symptom precisely and explains why the event-driven on-screen pad does not
have it.

## 4. Shell: the physical controller reader (new code, the likely culprit)

Two files. Both are new. The pure logic is unit-tested; the polling glue is
where the timing problem lives.

### 4a. `packages/shell/src/gamepad/physical.ts` (pure logic)

```ts
export type PadMessage =
  | { type: "gamepadButton"; button: number; pressed: boolean }
  | { type: "gamepadAxis"; axis: number; value: number }

export interface PadSnapshot {
  buttons: readonly { pressed: boolean; value: number }[]
  axes: readonly number[]
}

export interface DiffOptions {
  deadzone?: number  // default 0.12
  epsilon?: number   // default 0.02
}

const MAX_BUTTON = 16
const STICK_AXES = 4
const TRIGGER_AXIS: Record<number, number> = { 6: 4, 7: 5 }
const DEFAULT_DEADZONE = 0.12
const DEFAULT_EPSILON = 0.02

function dead(value: number, deadzone: number): number {
  return Math.abs(value) < deadzone ? 0 : value
}

// Only what changed between two snapshots. Buttons on a pressed-edge; triggers
// (6,7) also emit their analog axis (4,5); sticks (0..3) after a deadzone and
// only past epsilon. An unchanged pad produces nothing.
export function diffGamepad(prev, curr, options = {}): PadMessage[] {
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
    if (axis !== undefined && Math.abs(after.value - before.value) >= epsilon) {
      out.push({ type: "gamepadAxis", axis, value: after.value })
    }
  }
  for (let i = 0; i < STICK_AXES; i++) {
    const before = dead(prev.axes[i] ?? 0, deadzone)
    const after = dead(curr.axes[i] ?? 0, deadzone)
    if (Math.abs(after - before) >= epsilon) {
      out.push({ type: "gamepadAxis", axis: i, value: after })
    }
  }
  return out
}

export function snapshotOf(pad: Gamepad): PadSnapshot {
  return {
    buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
    axes: [...pad.axes],
  }
}

export const NEUTRAL: PadSnapshot = { buttons: [], axes: [] }

export interface PollState { activeIndex: number | null; last: PadSnapshot }
export const IDLE: PollState = { activeIndex: null, last: NEUTRAL }

// One frame: pick the first standard-mapping pad (player one), reset the
// baseline to neutral when the pad changes, diff, return messages + next state.
export function pollStep(pads, state, options = {}) {
  let pad: Gamepad | null = null
  for (const candidate of pads) {
    if (candidate && candidate.mapping === "standard") { pad = candidate; break }
  }
  if (!pad) return { messages: [], state }
  const baseline = state.activeIndex === pad.index ? state.last : NEUTRAL
  const current = snapshotOf(pad)
  return {
    messages: diffGamepad(baseline, current, options),
    state: { activeIndex: pad.index, last: current },
  }
}
```

Note the diff is **edge-triggered**: a button message is emitted only when
`pressed` changes between two sampled snapshots. If a press is never sampled in
the "down" state (because polling skipped that interval), no message is emitted
at all. There is no buffering of sub-sample transitions.

### 4b. `packages/shell/src/gamepad/usePhysicalGamepad.ts` (the poll loop)

```ts
export function usePhysicalGamepad(): void {
  const actions = useSessionActions()
  const { session, status } = useSessionState()
  const dock = useDock()

  const send = useRef(actions.send);         send.current = actions.send
  const dockNow = useRef(dock);              dockNow.current = dock
  const live = useRef(status === "connected"); live.current = status === "connected"

  const pollState = useRef<PollState>(IDLE)
  const hid = useRef(false)
  const connected = useRef(new Set<number>())
  const raf = useRef(0)

  useEffect(() => { pollState.current = { ...pollState.current, last: NEUTRAL } }, [session])

  useEffect(() => {
    const release = () => {
      for (const m of diffGamepad(pollState.current.last, NEUTRAL)) send.current(m)
      pollState.current = IDLE
    }
    const step = () => {
      if (connected.current.size === 0) { raf.current = 0; return }
      raf.current = requestAnimationFrame(step)          // <-- SAMPLING ON rAF
      if (!live.current) return
      const { messages, state } = pollStep(navigator.getGamepads?.() ?? [], pollState.current)
      for (const m of messages) send.current(m)
      pollState.current = state
    }
    const ensureLoop = () => { if (raf.current === 0) raf.current = requestAnimationFrame(step) }
    const autoHide = () => { if (dockNow.current === "gamepad") { hid.current = true; setDock("none") } }
    const onConnect = (e: GamepadEvent) => { connected.current.add(e.gamepad.index); autoHide(); ensureLoop() }
    const onDisconnect = (e: GamepadEvent) => {
      connected.current.delete(e.gamepad.index)
      if (connected.current.size > 0) return
      release()
      if (hid.current) { hid.current = false; if (dockNow.current === "none") setDock("gamepad") }
    }
    globalThis.addEventListener("gamepadconnected", onConnect)
    globalThis.addEventListener("gamepaddisconnected", onDisconnect)
    for (const pad of navigator.getGamepads?.() ?? []) if (pad) connected.current.add(pad.index)
    if (connected.current.size > 0) { autoHide(); ensureLoop() }
    return () => {
      globalThis.removeEventListener("gamepadconnected", onConnect)
      globalThis.removeEventListener("gamepaddisconnected", onDisconnect)
      if (raf.current !== 0) { cancelAnimationFrame(raf.current); raf.current = 0 }
      release()
    }
  }, [])
}
```

Mounted once per session in `packages/shell/src/components/ShellChrome.tsx`:
`usePhysicalGamepad()`.

**Known wrinkle already found:** `autoHide()` sets the dock to `"none"`, which
turns off the tap **shield** (the shield only runs while `dock === "gamepad"`).
That is being reworked (a "hide the on-screen buttons but keep the surface and
shield" toggle instead). It is not the cause of the dropped-press bug, which
reproduces with the on-screen pad open and shield on.

## 5. Shell: the on-screen pad (works, for contrast)

The on-screen gamepad (`packages/shell/src/gamepad/GamepadOverlay.tsx`) sends
the **same** wire messages, but from **touch events** (`pointerdown`/
`pointerup`), not from polling. In `controller` mode a face button's
`pointerdown` sends `{type:"gamepadButton", button, pressed:true}` immediately
and `pointerup` sends `pressed:false`. Because it is event-driven it never
aliases, which is why it is smooth while the polled physical path is not. This is
the strongest evidence the bug is in the **sampling**, not downstream.

## 6. Wire protocol and mapping

Messages the shell sends (`actions.send`, then straight to the WebSocket, no
batching or coalescing in between, verified):

- `{ type: "gamepadButton", button: number /*0..16*/, pressed: boolean }`
- `{ type: "gamepadAxis", axis: number /*0..5*/, value: number /*-1..1*/ }`
- `{ type: "setGamepad", enabled: boolean }` (only from the on-screen dock; the
  physical reader does not send it, and does not need to, see section 7)

W3C standard mapping, one to one with the engine's indices:

| Index | Button | Axis |
|---|---|---|
| 0-3 | South/East/West/North (A/B/X/Y) | - |
| 4/5 | L1/R1 bumpers | - |
| 6/7 | L2/R2 triggers (analog) | also axis 4/5 |
| 8/9 | Select/Start | - |
| 10/11 | L3/R3 stick clicks | - |
| 12-15 | D-pad up/down/left/right | - |
| 16 | Guide/Home | - |
| axes | - | 0/1 left stick X/Y, 2/3 right stick X/Y |

## 7. Engine side (Rust): the virtual controller lifecycle

Relevant handlers in `crates/lwfa-engine/src/main.rs`:

```rust
ToEngine::GamepadButton { button, pressed } => {
    let (Some(pad), Some(button)) = (
        state.gamepad_for(session),
        lwfa_proto::GamepadButton::from_index(button),
    ) else { return };
    pad.button(button, pressed);   // emits the uinput event
}
ToEngine::GamepadAxis { axis, value } => {
    let (Some(pad), Some(axis)) = (
        state.gamepad_for(session),
        lwfa_proto::GamepadAxis::from_index(axis),
    ) else { return };
    pad.axis(axis, value);
}
```

In `crates/lwfa-engine/src/state.rs`:

- `ensure_persistent_gamepad()` runs at engine startup and creates the uinput
  device (config `[gamepad] persistent = true`, the default), so a controller
  exists **before** any game launches (Proton only sees pads present at launch).
- `gamepad_for(session)` returns that pad, **binding it on demand** to any
  session that sends input, even one that never sent `setGamepad`. So the
  physical reader's messages reach the pad with no announcement needed.
- `park_gamepad` / `adopt_parked_gamepad` keep the device alive across
  reconnects and dock toggles (it is parked, not destroyed).

Implication: the engine does **not** require `setGamepad` for physical input to
work, and there is no obvious rate limit on `pad.button`. If the engine coalesces
or rate-limits button events it would be worth checking `VirtualPad::button` in
`crates/lwfa-engine/src/gamepad.rs`, but the leading suspicion is the shell
sampling, not here.

## 8. Ruled out / checked

- **Send path**: `actions.send` in `packages/shell/src/App.tsx` calls the
  connection's `send` directly. No coalescing, throttling, dedup, or batching of
  outbound gamepad messages was found. So messages that are *generated* are sent.
- **Engine lifecycle**: persistent pad + `gamepad_for` mean input is accepted
  without `setGamepad`; not a lifecycle gating problem.
- **Shield/focus**: the "mapping disappears" case is the game leaving gamepad
  mode on a stray touch; mitigated by the shield. Separate from the dropped-press
  bug.

## 9. Leading hypotheses (ranked)

1. **rAF sampling aliasing / starvation (most likely).** Polling on
   `requestAnimationFrame` under heavy video decode gives an irregular, sometimes
   low sample rate. Fast presses (down+up inside one skipped interval) are never
   sampled in the down state, so `diffGamepad` emits nothing. Explains laggy,
   random, worse-when-busy behaviour, and why the event-driven on-screen pad is
   fine.
2. **Sub-frame taps.** Even at a steady 60Hz, a tap shorter than ~16ms can be
   missed. Contributes to (1).
3. **`pressed` vs `value`.** Some controllers/browsers report a button's
   `value` reliably while `pressed` flickers. The diff keys on `pressed` only.
   Worth logging both on iOS Safari for the 8BitDo.
4. **Session baseline reset.** The `[session]` effect resets `last` to NEUTRAL.
   If `session` identity changes often it forces re-sends (not drops), but worth
   confirming it is stable.
5. **Engine `VirtualPad` event emission** (rate limit / missing SYN on rapid
   events). Lower likelihood; check `gamepad.rs`.

## 10. Suggested fixes (for the sampling hypothesis)

- **Poll on a fixed high-rate timer instead of / in addition to rAF.** e.g. a
  `setInterval`/`setTimeout` loop at ~4-8ms (125-250Hz), which keeps sampling
  even when rAF is throttled. Trade-off: timers also queue behind main-thread
  work, so consider a **Web Worker** driving the tick and posting back, or an
  `requestAnimationFrame` + `setInterval` hybrid (whichever fires, sample once,
  guard against double-processing the same frame).
- **Sample in a Web Worker** using `navigator.getGamepads()` if available there
  (support varies; verify on iOS Safari) to decouple from the render thread.
- **Consider `value`-based detection** as well as `pressed`, and lower the
  analog epsilon, if logging shows `pressed` flicker.
- **Do not gate the loop on `live`/rAF in a way that stops it** during momentary
  video stalls.
- Keep the diff edge-model, but sample often enough that edges are not skipped.

## 11. Diagnostics to run

- Log, on every poll on the iPad (Safari remote inspector), the timestamp delta
  between polls while a game streams. If deltas spike well past 16ms, that
  confirms rAF starvation.
- Log `getGamepads()[i].timestamp` (the Gamepad's own update time). If it
  advances faster than the poll runs, presses are being missed between polls.
- Log `buttons[i].pressed` and `buttons[i].value` together for a mashed button;
  see whether `value` catches presses that `pressed` misses.
- Compare: drive the same button from the on-screen pad (event-driven) vs the
  physical pad, in the same game, and confirm only the physical path drops.

## 12. File map

- `packages/shell/src/gamepad/physical.ts` - pure diff/pollStep (section 4a)
- `packages/shell/src/gamepad/usePhysicalGamepad.ts` - the rAF poll loop (4b)
- `packages/shell/src/components/ShellChrome.tsx` - mounts the hook
- `packages/shell/src/gamepad/GamepadOverlay.tsx` - on-screen pad (event-driven)
- `packages/shell/src/gamepad/model.ts` - layout + W3C mapping tables
- `packages/shell/src/components/InputDock.tsx` - dock chrome, `setGamepad` announce
- `packages/shell/src/App.tsx` - `actions.send` -> connection
- `crates/lwfa-engine/src/main.rs` - GamepadButton/GamepadAxis/SetGamepad handlers
- `crates/lwfa-engine/src/state.rs` - persistent pad, park/adopt, `gamepad_for`
- `crates/lwfa-engine/src/gamepad.rs` - `VirtualPad` (uinput device)
- `crates/lwfa-proto/src/lib.rs` - wire types, `GamepadButton`/`GamepadAxis` enums
```
