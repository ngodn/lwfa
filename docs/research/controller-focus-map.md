# Controller focus map

Investigated 2026-09-06 against commit `9a72dd0` (1.4.3). This is an
investigation, not another behavior change. No production service, BG3 process,
Steam prefix, or iPad setting was changed.

The previous recovery tests deliberately dispatched a blur event. They proved
that the old physical hook left input held after focus loss. They did not
reproduce or identify the cause of focus loss on the user's iPad. The uploaded
schema-1 recording has no focus history, so it cannot settle that question.

## Four different meanings of focus

| Focus domain | Owner | What it decides |
| --- | --- | --- |
| DOM element | Browser DOM and Radix | Which button/input receives keyboard navigation, visible through `document.activeElement` |
| Browser document/window | Browser | Whether the document owns focus, observed through `document.hasFocus()` and window focus/blur |
| Native gamepad input target | iPadOS/UIKit/WebKit | Which native view receives controller snapshots |
| Remote game window | lwfa, Smithay, Xwayland, game | Which Linux/Windows application receives keyboard focus and may choose to consume gamepad state |

Moving DOM focus between elements does not by itself mean the browser window
lost focus. Element blur is non-bubbling; the physical hook's window listener
is not a capture listener. A remote `focusWindow` message does not invoke DOM
`.focus()` or control UIKit focus.

WebKit's current iOS provider selects the page only when the native first
responder is WKContentView. Its synchronization timer can return without
publishing a snapshot if no eligible page is active. This supports the native
focus hypothesis, but is not proof of the exact installed Safari 26.6 behavior
or of what happened during the trace. Sources: [native target selection](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/Gamepad/ios/UIGamepadProviderIOS.mm),
[snapshot timer and view activation](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/Gamepad/UIGamepadProvider.cpp),
[WebKit tap/focus handling](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/ios/WKContentViewInteraction.mm).

## Shell inventory

Line numbers refer to the audited commit. Paths below are relative to the repo.

| Code | What touches focus or input ownership | Scope and trigger |
| --- | --- | --- |
| `packages/shell/src/Login.tsx:30` | Explicit password-input `.focus()` | Login mount/error; only explicit application `.focus()` found |
| `packages/shell/src/components/PanelHost.tsx:125` | Radix nonmodal Sheet autofocus on open | Opening any settings/rail panel |
| `packages/shell/src/components/PanelHost.tsx:134` | Cancels outside dismissal for rail interaction, including focus interaction | Keeps rail panel switches from racing with dismissal |
| `packages/shell/src/components/ui/sheet.tsx:58` | Passes through Radix Content; no open/close autofocus override | Shared panel implementation |
| `packages/shell/src/components/FileDialog.tsx:162` | Modal autofocus and focus trap | An application can request this dialog |
| `packages/shell/src/components/AlreadyRunning.tsx:42` | Modal autofocus and focus trap | An attempted launch requires an already-running-app decision |
| `packages/shell/src/components/ui/tabs.tsx:62`, `ui/toggle-group.tsx` | Radix keyboard/roving element focus | Settings controls and grouped panels |
| `packages/shell/src/components/NavRail.tsx:236` | Ordinary native button focus; opens panels, docks, or Escape action | User click/tap; no physical-gamepad navigation mapping |
| `packages/shell/src/WindowSurface.tsx:336` | Calls application callback `onFocus(id)` | Remote window selection, not a DOM focus event or `.focus()` call |
| `packages/shell/src/gamepad/GamepadOverlay.tsx:267`, `:677` | Prevents pointer defaults and captures pointers | Virtual touch controls; can suppress normal touch/default focus behavior |
| `packages/shell/src/keyboard/Keyboard.tsx:221`, `mouse/MouseOverlay.tsx` | Similar pointer-default suppression and capture | Virtual keyboard/mouse only |
| `packages/shell/src/components/InputDock.tsx:250`, `gamepad/shield.ts` | Overlay intercepts taps that would otherwise reach WindowSurface | Prevents accidental remote clicks/window focus changes; no native focus API |
| `packages/shell/src/lib/haptics.ts:61`, `:112` | Creates hidden switch and calls synthetic `.click()` | Virtual controls and shell Escape haptics; never called by physical polling |
| `packages/shell/src/panels/GamepadPanel.tsx:221`, `:286` | Synthetic download-anchor click | Saving trace/layout; trace recording has already stopped before its download |
| `packages/shell/src/panels/GamepadPanel.tsx:338`, `ClipboardPanel.tsx:204`, `components/FileDialog.tsx:332`, `:340` | Opens native file/folder picker | Explicit import/upload action; native browser/system UI can take input ownership |
| `packages/shell/src/lib/clipboard.ts:382`, `:406` | Browser clipboard read | Explicit clipboard flow; may involve browser permission UI |
| `packages/shell/src/lib/connections.ts:110`, `panels/SessionPanel.tsx:221`, `components/Crashed.tsx:99` | Navigation/reload | Switch connection, requested reload, or crash recovery |
| `packages/shell/src/App.tsx:1047` | Listens to window blur and sends `pointerLeave` | Reacts to focus loss; does not cause it. Engine clears pointer focus only |
| `packages/shell/src/gamepad/usePhysicalGamepad.ts:116` | Window blur/focus, hidden/visible, pagehide/pageshow, reset action | 1.4.3 recovery releases/suspends/rearms physical input; does not call focus/blur |
| `packages/shell/src/gamepad/recovery.ts:2` | Custom reset event and per-control neutral gating | Explicit recovery; does not change browser focus |
| `packages/shell/src/connection.ts:155` | Visibility/pageshow reconnect handling | Reacts to lifecycle changes; does not take focus |
| `packages/shell/src/lib/audio.ts:539` | Passive pointer/key/touch listeners unlock audio | No focus calls or event cancellation |
| `packages/shell/src/App.tsx:1113` | Starts/stops audio based on preferences/session | No direct focus changes |
| `packages/shell/src/lib/leader.ts` | Browser lock chooses active connection in a browser profile | Connection ownership, not DOM or remote keyboard focus |

The game surface is a non-focusable div/canvas, with no `tabIndex`. Selecting
BG3 remotely therefore does not establish a specific DOM focus target.
No application `.blur()`, browser fullscreen API, pointer-lock API, or
physical-button-to-shell-click path was found. Popover/select wrappers and the
dropdown dependency exist but have no active application usage in this tree.
CSS `focus-visible` rings and backdrop blur are styling, not focus controllers.

### Confirmed panel restoration gap

Installed `@radix-ui/react-dialog` 1.1.23 nonmodal content disables the focus
trap, but still enables mount autofocus and focus looping. On close it tries
to focus its Trigger and prevents the underlying FocusScope's fallback
restoration. PanelHost, FileDialog, and AlreadyRunning are controlled dialogs
without a Radix Trigger. No explicit restoration target is supplied by lwfa.
Modal dialogs likewise try the missing trigger on close.

The installed Dialog module's relevant locations are `dist/index.mjs:154`
(modal close), `:183` (nonmodal close), and `:220` (FocusScope), with
`@radix-ui/react-focus-scope` 1.1.16 handling mount autofocus. The official
[Dialog API](https://www.radix-ui.com/primitives/docs/components/dialog)
exposes `onOpenAutoFocus` and `onCloseAutoFocus` for this ownership.

This is a real DOM focus restoration gap. It is not proof that a panel makes
Safari lose native gamepad focus. Opening settings can move element focus
without firing window blur, as the browser probe below confirms.

## Remote engine inventory

| Code | What changes focus | Trigger or qualification |
| --- | --- | --- |
| `packages/shell/src/App.tsx:443`, `:460`, `:492` | Every `update` calls `push`, which sends current `focusWindow` | Even if the transition kept the same focus/state; layout and streams are sent together |
| `packages/shell/src/App.tsx:618`, `:639`, `:683`, `:736`, `:793`, `:852` | Initial/reconnect layout, viewport changes, window lifecycle and focus notifications feed layout updates | No evidence of a focus command on every video/audio frame |
| `packages/shell/src/strip.ts` | Computes focus after navigation, window add/remove, workspace/layout operations | Pure state; App turns results into wire commands |
| `packages/shell/src/components/ArrangeLayer.tsx:234`, `:353`, `panels/WindowsPanel.tsx:562`, `:577` | Explicit remote focus actions | Arrange mode and window selection |
| `crates/lwfa-engine/src/main.rs:1096` | Handles `FocusWindow` via `set_focus(..., false)` | No notification echo to shell |
| `crates/lwfa-engine/src/state.rs:1146` | Sets stored focus, activation, X11 stacking and seat keyboard target | Central remote focus setter |
| `crates/lwfa-engine/src/focus.rs:28`, `:91` | Dispatches enter/leave to Wayland or X11 focus target | Protocol-specific focus implementation |
| `crates/lwfa-engine/src/main.rs:1076`, `state.rs:1223` | Every layout schedules a deferred focus reassertion | 300 ms after layout bursts settle |
| `crates/lwfa-engine/src/state.rs:1482`, `:1517` | X11 reassertion clears seat focus to None, then restores it | Actual focus leave/enter even if selected window did not change |
| `crates/lwfa-engine/src/state.rs:1439`, `:1456`, `handlers/xwayland.rs:109` | Skips reassertion while qualifying X11 popup is considered open; popup unmap reschedules | Popup at least 16x16 and a qualifying map within five seconds |
| `crates/lwfa-engine/src/main.rs:113`, `state.rs:1407`, `xfocus.rs:65` | X focus guardian repairs None/PointerRoot focus | Once per second; leaves real X window focus alone |
| `crates/lwfa-engine/src/remote_input.rs:88`, `:231` | Remote mouse press/touch-down selects addressed window | Physical browser gamepad polling does not invoke these |
| `crates/lwfa-engine/src/remote_input.rs:150`, `:175` | Pointer leave clears pointer target; keys use current keyboard target | Pointer leave does not clear keyboard focus despite App's comment suggesting held-key cleanup |
| `crates/lwfa-engine/src/input.rs:588`, `:606` | Local mouse click selects window or clears seat focus on empty space | Empty-space path does not update stored `self.focused` |
| `crates/lwfa-engine/src/input.rs:161` | Local safe-mode keyboard cycles focus | When no shell owns layout |
| `crates/lwfa-engine/src/handlers/xdg_shell.rs:36`, `handlers/xwayland.rs:73` | New managed windows take focus | New Wayland toplevel or mapped managed X11 window |
| `crates/lwfa-engine/src/state.rs:578` | Closing focused window selects a remaining window | Window retirement |
| `crates/lwfa-engine/src/state.rs:1288`, `:1547` | Safe-mode fallback chooses focus if missing | Session grace expires |
| `crates/lwfa-engine/src/handlers/mod.rs:46` | Seat focus updates clipboard recipient | Consequence of keyboard focus, not separate gamepad focus logic |
| `crates/lwfa-engine/src/main.rs:1344`, `:1364`, `state.rs:1311` | Gamepad messages write uinput; device adoption/parking changes input ownership | Shared physical/virtual path; no focus setter |
| `crates/lwfa-engine/src/main.rs:1383`, `state.rs:845` | Stream configuration/suspension affects rendering | No direct focus setter; associated layout updates can schedule reassertion |

### Confirmed remote-focus concerns

1. The layout reassertion really does bounce X11 keyboard focus. Source comments
   record an earlier Steam-menu regression from this path. That history is not
   a fresh measurement in this audit. Popup guards reduce the issue but do not
   remove unnecessary focus leave/enter for ordinary layouts.
2. `main.rs:992-996` permits FocusWindow for every authenticated session,
   including view-only followers. `App.tsx:460-462` sends it outside the primary
   guard. Another connected shell can therefore change BG3 focus. This audit
   does not establish that another shell did so during the user's test.
3. Local empty-space clicks clear actual seat focus without clearing stored
   `self.focused`. Bookkeeping and actual focus can disagree until repaired.

All three affect remote BG3 focus. None can directly freeze the Gamepad API's
raw button snapshot on the iPad. Since on-screen input works and both sources
share the engine's gamepad path, these are weaker explanations for the full
physical-only symptom than a problem before that shared path.

## Browser probe and limits

A temporary probe in `target/focus-audit-probe.mjs` mounted the real physical
hook and PanelHost with simulated Gamepad API state. It used the existing
Chromium installation and a temporary loopback Vite server, with no engine
connection. Both browser and server closed after the run. Node was 24.15.0.

[Recorded observations](fixtures/controller-focus-browser-probe.json):

- Opening Gamepad Settings moved DOM focus from the opener to Close.
- Closing it left DOM focus on BODY instead of restoring the opener.
- A simulated physical LB press caused no DOM or window focus events.
- A text input and the haptics switch path caused ordinary element focus
  changes; the hidden switch did not become the active element.
- No non-capture window blur fired; document.hasFocus stayed true throughout.

This confirms DOM behavior in Chromium. It does not emulate UIKit, Safari's
native focus target, controller system navigation, native pickers, or the
user's physical 8BitDo device. It must not be reported as an iPad reproduction.

## Next investigation priorities, before a further fix

For the reported physical-only freeze, correlate browser window focus/lifecycle
with raw pad changes and forwarding mode. Schema 2 already records this;
schema 1 cannot answer it. Element focus alone is insufficient evidence.
Inspect real Safari native focus restoration around panel dismissal if window
focus changes there. Independently, the redundant X11 focus bounce and follower
focus permissions deserve focused regression checks before changing them.
Do not remove the X11 recovery blindly: it exists to recover real fullscreen
focus loss. Do not equate a harmless DOM focus change with the original bug.


## Follow-up fixes for 1.4.4

The user authorized fixes after reviewing this inventory. The audit above
records the old behavior at 9a72dd0; these changes supersede its identified
panel, follower, and X11 reassertion gaps.

- Controlled panels and dialogs now remember their previous DOM focus target.
  Closing restores it only while the closing overlay still owns focus and the
  page remains active. Outside clicks, replacement/queued dialogs and removed
  targets are handled without pulling focus away from the user's new target.
  Radix mount autofocus and modal trapping remain enabled.
- View-only FocusWindow messages are now rejected by the engine, even if that
  session is primary. Interactive followers retain deliberate window selection.
- Follower hello, server window/focus updates and output changes no longer send
  focus commands. Explicit user actions are separate from background resync.
  Permission changes on an existing connection take effect immediately.
- A deliberate focus change is sent to other authenticated sessions, excluding
  its sender. Repeated requests for the same selected window do not create
  notification loops. This keeps the primary from restoring stale selection
  after a follower uses another window.
- Layout repair no longer clears and restores an already-correct X11 keyboard
  target or raises that window unnecessarily. It checks actual X ownership,
  respects another real window or popup, and retains repair of missing seat
  focus and X11 None/PointerRoot states. X repair checks server acceptance.
- Local empty-space clicks now clear stored focus and activation through the
  central setter, so the guardian has no stale window to restore.

Regression evidence:

| Check | Before | After |
| --- | --- | --- |
| Actual PanelHost close in Chromium | BODY instead of opener | Opener restored; outside selection and modal handoffs preserved |
| Actual App follower hello in Chromium with intercepted engine | Sends focusWindow immediately | Background resync sends none; explicit interactive selection works |
| Engine permission function | Allows view-only focus command | Rejects view-only, retains interactive focus |
| Actual engine dispatch through shell queues | Other sessions receive no focus notification | Excludes sender/unauthenticated clients; updates others without duplicates |
| Actual Lwfa reassertion with Smithay X11 targets on isolated Xvfb | Repeated layout repairs cause FocusOut/FocusIn | Healthy game and popup focus retained; missing focus repaired |

Browser scripts: `scripts/e2e-focus-restoration.mjs` and
`scripts/e2e-follower-focus.mjs`. They use loopback fixture servers and do not
connect to production. PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE may point to
existing installations. The X11 tests require bubblewrap (`bwrap`) and Xvfb,
are ignored by default, and can run with:

```sh
LWFA_TEST_XVFB=/path/to/Xvfb cargo test -p lwfa-engine xfocus::tests -- --ignored
```

Correction (2026-09-08): starting a separate Xvfb process did not isolate its
socket paths. The September 6 run replaced the host's X11 socket, even though
the focus assertions passed. See [the incident and repair](host-x11-test-isolation.md).
The tests now re-execute inside private mount and network namespaces before
starting Xvfb, and fail if bubblewrap cannot establish isolation. A regression
test verifies that an existing filesystem-only X server keeps its socket and
accepts new connections after the focus test exits. The Xvfb package remains
under ignored target/, without installing system software. None of this
establishes an iPad-native reproduction of the original missing LB/RB taps.


Final validation: 657 JavaScript tests and 317 Rust workspace tests passed;
TypeScript checking and the 1.4.4 shell production build passed. Four optional
Rust tests are ignored in the default workspace run; the new isolated X11
focus regression was also run explicitly and passed. Browser regressions for
panel restoration and follower focus passed, including permission demotion
and restoration on the same socket. The remaining optional hardware tests
were not needed for these focus changes.
