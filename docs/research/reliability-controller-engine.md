# Controller delivery after the browser

Date: 2026-09-06. Initial investigation was read-only. A subsequent authorized probe used a disposable Wine prefix and injected input only through the separate development engine on port 6734. No production engine, Steam settings, game prefix, registry, or launch options were changed.

## What is established locally

The user reports an M1 11-inch iPad on iPadOS 26, with failures over both Wi-Fi and USB-C Ethernet, while playing Baldur's Gate 3. This rules out treating a Wi-Fi-only explanation as sufficient.

- `~/.local/share/Steam/compatibilitytools.d/GE-Proton11-5-x86_64/version` identifies GE-Proton11-5. Steam `config/config.vdf` maps BG3 app 1086940 to that tool with priority 250. This confirms the approximate version the user remembered.
- Steam `logs/compat_log.txt` records the latest BG3 session starting at 13:10:03 and releasing at 13:13:21 on September 6. No BG3 executable or Wine game process was running when inspected. Actual runtime backend, loaded DLL overrides, and in-game controller state therefore could not be observed.
- Steam has both `/dev/input/event10` and `/dev/input/event25` open. Both devices identify as `lwfa virtual controller` and are readable by this user. Root identifies event10 as production and event25 as the separate development engine.
- Steam's controller log records the second device appearing at 13:20:43 and reserving controller slot 1. This is after the latest BG3 session closed and after the development engine was created for this investigation. It is a test-environment confounder, not evidence for the original bug.
- The latest BG3 controller log says the Steam mapping uses XInput false. That describes Steam's mapping, not which Windows API BG3 actually calls. It must not be used to conclude BG3 lacks Wine XInput access.

The production engine journal for that BG3 session records session 2 taking the
controller at 13:10:26 and releasing it when leaving at 13:13:17. No controller
reset or WebSocket disconnect was logged between those events. This narrows
that session's evidence; it does not establish that individual presses arrived.

### Additional rendering configuration

BG3's saved Steam launch option is `~/lsfg %command%`. That wrapper exports `DXVK_FRAME_RATE=60`, `DISABLE_VKBASALT=1`, and `LSFG_PROCESS=3060`, then executes the game command. Its lsfg-vk profile in `~/.config/lsfg-vk/conf.toml` sets multiplier 2, flow scale 0.5, performance mode false, HDR true, and experimental present mode mailbox.

The [lsfg-vk configuration documentation](https://github.com/PancakeTAS/lsfg-vk/wiki/Configuring-lsfg%E2%80%90vk) confirms that LSFG_PROCESS selects a profile. These settings establish an extra Vulkan frame-generation layer to record in a reproduction, not that the layer causes missed presses. Generated display frames also cannot establish the cadence at which the game reads input.

## Engine path and guarantees

`shell.rs::pump` reads all currently available WebSocket messages and sends each parsed `ToEngine` message to a calloop channel. `main.rs` handles that channel on the compositor event loop. After permission and session checks, `GamepadButton` calls `VirtualPad::button`, and `GamepadAxis` calls `VirtualPad::axis`.

Each button write includes its own `SYN_REPORT`; D-pad writes also include hat axes. Each analog write has its own report. There is no intentional coalescing of button edges in these functions. `VirtualPad::emit` reports write errors to the engine log. The kernel [uinput documentation](https://docs.kernel.org/input/uinput.html) and [input event documentation](https://docs.kernel.org/input/event-codes.html) describe the report boundaries this uses.

However, the protocol carries no original event time or held duration. If either socket delivery or compositor handling stalls, queued down and up messages can be written to uinput back-to-back when processing resumes. Ordered edges at evdev do not establish how long the pressed state existed for a polling consumer. Kernel timestamps here reflect injection time, because the uinput timestamps supplied by lwfa are zero.

The persistent-device and parked-session paths already handle previously found hotplug/reconnect failures. The targeted Claude history in session `ef875cde-ec11-4d4f-a5fa-04cbe13e475e` describes earlier orphaned sessions, fullscreen focus changes, and a clean restart restoring controller behavior. Those findings motivate checking runtime focus and device ownership, but are not new reproductions in this session.

## What Proton adds

[Proton's controller documentation](https://github.com/GloriousEggroll/proton-ge-custom/blob/master/docs/CONTROLLERS.md) describes the Wine API, winebus, SDL/evdev path. That controller path is separate from whether the game uses Wayland or Xwayland for windows. Foreground/overlay policy can still affect what a game sees. The older statement in `docs/gaming.md` that Steam being X11 forces every Proton game to X11 should not determine a modern game's backend without inspection.

The [GE-Proton11-5 tag](https://github.com/GloriousEggroll/proton-ge-custom/releases/tag/GE-Proton11-5) pins its Wine submodule to `36078f5f947532885a596dabbc7893c048133660`. The pinned [XInput implementation](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/xinput1_3/main.c) updates a cached current state and returns that snapshot from XInputGetState. It also zeros state while its Steam overlay event is signaled. Microsoft's [API contract](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputgetstate) likewise describes current state, not an event history.

Inference: if a full down/up transition occurs between a game's reads of current state, the game can miss the press even when evdev recorded both edges. This is a reason to extend the test seam past evdev, not a finding that lwfa currently compresses the user's presses. No hold extension, delayed release, polling-rate change, or Wine patch was applied.

A separate [July 2026 winebus patch report](https://list.winehq.org/hyperkitty/list/wine-gitlab@list.winehq.org/message/QKTH3TU3XONACKOEEELOWE2XGHOV6YAW/) describes an SDL axis-event backlog at high report rates. The pinned [bus_sdl.c](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/winebus.sys/bus_sdl.c) consumes one SDL event per wait cycle. The installed x86_64 winebus.so contains the SDL_WaitEventTimeout symbol string but no SDL_PollEvent string, consistent with that source. The report's 1 kHz multi-axis stress is not evidence that lwfa's browser polling, nominally 125 Hz, reaches the same failure. Presence of a related upstream bug does not justify changing this deployment.

## Red-capable tests to construct next

These are proposed tests, not results. The previous successful evdev E2E does not replace them.

| Hypothesis | Controlled trigger | Distinguishing observation |
| --- | --- | --- |
| Queued delivery compresses presses | Replay 8, 16, 24, 50, 100 ms button holds; then enqueue a known down/up pair in one burst on the isolated dev socket | Compare browser send time, kernel edge duration, and XInput state visibility. If evdev duration collapses only during bursts, locate the first queue adding the collapse |
| Wine/SDL cannot drain axis traffic | Four axes moving at 30, 60, 125 Hz, then neutral; log a button transition during motion | Compare kernel-neutral time with XInput-neutral time and button delay. Growing Wine-only lag distinguishes downstream backlog from network delay |
| Game snapshots miss valid short holds | Windows helper polling XInput at 1 ms, then 16/33 ms with a known phase, while evdev observes the same injection | Fast polling sees presses while slower polling loses known short holds. This proves the sampling mechanism for the helper, not BG3's actual behavior |
| Focus or overlay suppresses input | During a user-authorized game reproduction, passively record window backend/focus and relevant overlay state alongside evdev | Kernel state remains pressed while observed game/controller state is zero only during a focus/overlay change |
| Wrong device slot after development hotplug | Enumerate all four XInput slots and map a distinct dev-only gesture | The dev pad appears on another slot; never assume slot 0 or blame duplicate devices created by this investigation |

A standalone Windows helper should run under the installed GE-Proton11-5 in a disposable prefix, enumerate all four XInput slots, and passively log state and packet numbers. It should not rumble, grab evdev devices, install hooks, edit Steam settings, or use BG3's prefix. Merely reading the devices and states avoids disturbing production, but it still cannot prove BG3 consumes those states. Controlled injection must use root's isolated dev session after the rendering test releases it, never production event10. `winegcc` is present; a MinGW GCC cross compiler was not on PATH. Installed Zig 0.16.0, invoked with `mise exec`, provided the Windows cross compiler without changing project or global tool versions. The later authorized helper run is recorded below.

When BG3 is next running naturally, inspect only relevant process environment fields, executable paths, loaded XInput/winebus libraries, and input-device visibility through its mount namespace. A generic Wine helper outside the game's Proton container does not establish container visibility or game-specific Steam Input behavior.


## Subsequent isolated GE-Proton verification

After root released the development input slot, two reusable tools were added:

- `scripts/xinput-probe.c` and `scripts/xinput-probe.sh`: compile a C11 Windows PE executable, start the specified GE-Proton Wine binary directly with a fresh temporary prefix, enumerate all four XInput slots, and poll connected state with a requested 1 ms sleep. Missing slots are retried every 250 ms because repeated device enumeration itself adds latency. Output contains state changes, packet numbers, UTC microsecond timestamps, total polls, and maximum observed poll interval. The shell runner bounds runtime and cleans up only its own prefix's wineserver and temporary directory.
- `scripts/e2e-xinput.mjs`: launches that observer, opens a non-grabbing reader on the explicitly supplied dev evdev node, authenticates only to loopback port 6734, and sends controlled A-button pulses. It requires an explicit dev password, event node, and XInput slot. It checks that production/other slots do not acquire pressed buttons, then neutralizes and closes its dev socket.

Commands used:

```sh
PROTON_DIR=/home/eins0fx/.local/share/Steam/compatibilitytools.d/GE-Proton11-5-x86_64 \
  scripts/xinput-probe.sh 3 1

PROTON_DIR=/home/eins0fx/.local/share/Steam/compatibilitytools.d/GE-Proton11-5-x86_64 \
  DEV_AUTH_PASS="$DEV_AUTH_PASS" DEV_GAMEPAD_EVENT=/dev/input/event25 \
  DEV_XINPUT_SLOT=1 node scripts/e2e-xinput.mjs
```

DEV_AUTH_PASS is the temporary dev-engine credential, never the production .env credential. Event25 and slot1 were confirmed for this run, not hardcoded as universal identifiers.

The passive run saw neutral devices on slots 0 and 1, disconnected status 1167 on slots 2 and 3, and 2829 polls in 3 seconds with a maximum 2.043 ms interval after initialization. The pulse run completed 16976 polls in 18 seconds, maximum gap 2.726 ms:

| Requested hold | Injected presses | Presses at evdev | Pressed states observed at XInput slot 1 | Kernel held duration range |
| --- | ---: | ---: | ---: | --- |
| 100 ms | 10 | 10 | 10 | 99.508 to 100.740 ms |
| 8 ms | 10 | 10 | 10 | 4.888 to 8.274 ms |
| 16 ms | 10 | 10 | 10 | 15.198 to 16.769 ms |
| 24 ms | 10 | 10 | 10 | 23.281 to 24.434 ms |
| 50 ms | 10 | 10 | 10 | 49.906 to 53.476 ms |
| Batched down/up, no wait | 10 | 10 | 2 | 4 to 6 microseconds |

Every release also reached evdev. Slot 0 remained neutral. The helper exited, the disposable prefix was removed, the dev socket closed, and the controller slot was released to root before other live checks resumed.

This is an actual socket-to-kernel-to-GE-Proton observation: normal timed holds survived here, while already-batched transitions could disappear from XInput snapshots despite complete evdev edges. It demonstrates why the old evdev-only success did not close the investigation. It does not show that the user's ordinary iPad presses currently arrive batched. The count 2 of 10 is scheduling-dependent and should not become an exact regression expectation.

The helper uses the real installed GE-Proton Wine and XInput DLLs in its own prefix, outside BG3's Steam runtime container. It has no game foreground, Steam Input API integration, BG3 frame timing, or physical iPad sampling. Those remain separate layers to check during a real game reproduction.
