# Reliability status, session 1, 2026-09-06

Goal: improve controller input, audio/video streaming, automatic quality adaptation,
and Wayland/Xwayland/Proton rendering, including black right/bottom strips.
Adapt the copied agent helper scripts for this repository.

## Architecture and test boundary

The TypeScript browser shell sends input and receives encoded media over WebSocket.
The Rust engine is a nested Smithay Wayland compositor with Xwayland, video encoding,
audio capture and persistent uinput controllers. Tests use a separate dev engine;
production stays running. Use TypeScript 5.9.3, mise Node 24.15.0 and Rust 1.95.0.

## Evidence

| Area | Current status | Evidence / limit |
|---|---|---|
| Physical controller | Still unresolved on user's iPad | 1.4.1 timer fixes did not resolve BG3 report; Wi-Fi and USB-C Ethernet both affected. GE-Proton11-5 confirmed, no current game process to inspect |
| Dock/input ownership | Automatic closure removed; manual closure verified | Connecting a physical pad previously closed the shield and reset its device. Unit regression and live browser-to-evdev assertions pass, including held A across manual dock closure |
| Controller diagnostics | Added opt-in local recording | Bounded 4,096 raw API polls, connection state, send-action messages; no engine acknowledgment claim. Unit and actual browser JSON-download tests pass |
| Audio | Browser lifecycle and decoder fixes verified | 10 regressions, actual Chromium scheduled/worklet waveform check; capture and iPad performance still separate |
| Auto adaptation | Recovery, rate cuts and JPEG pacing verified | Soft-ceiling recovery deadlock and ignored 32-to-24 Mbit cut. Live 1 Mbit/s limit cut budget; recovery from 0.5 to 2 Mbit/s in 45 seconds. Practical H.264 scrolling fits its target. JPEG recovery traffic fell from 271.85 to 41.95 Mbit over 45 seconds; actual-byte conformance passes on CPU readback |
| Black borders | Reproduced and fixed in actual Chrome | 10 px right/bottom damage-coordinate error corrected; 32 live cases across 4 sizes, Wayland/Xwayland, JPEG/H264, normal and CPU readback configurations all zero bands |
| Decoder output | Late/stale frames rejected | Async bitmap reorder, old window lifetime and resize output regressions pass |
| Helper wrappers | Adapted and smoke-tested | Both resolve lwfa, preserve prompt files, bound runtime, support overrides; installed CLI flags checked |
| Type checking | Fixed existing initial app-store shape | Initial snapshot now includes required windowless array; combined typecheck passes |

## Combined checks so far

The latest integration run passed 650 JavaScript tests across 38 files. Type
checking and the shell production build pass. All six browser-to-kernel
controller checks pass, including downloading the troubleshooting recording.
The final Rust workspace run passed 315 tests with three opt-in hardware tests
ignored (two kernel device tests and the NVENC measurement diagnostic). The
measurement diagnostic was run separately during the investigation. These
results include the CPU readback freshness adjustment. Production has not been restarted.

Repository-wide `cargo fmt --check` still reports formatting differences in
pre-existing code. A check of committed `audio.rs` independently reproduces the
format failure; unrelated files were not reformatted. `git diff --check` passes.

## Remaining validation

The code and automated investigation are complete for the reproduced defects
above. The original iPad/BG3 report remains unresolved. Testing the updated
build on that device, with the shield enabled and matching browser/kernel
recordings, is needed to locate the first failing layer. Do not infer an iPad
fix from the synthetic browser, evdev or disposable XInput results.

The new recording control exists in this checkout build; it is not yet in the
running installed shell. Production deployment is a separate step from these
dev tests. Low JPEG budgets now trade frame cadence for readable pixels; large
frames still burst. Difficult H.264 content and connections below the minimum
500 kbit/s video ladder plus audio remain limitations, documented in the
adaptation investigation.

Disposable GE-Proton11-5 tests observed all 10 normal presses at each 8/16/24/50/100 ms
hold. Batched down/up delivered all edges at evdev but only 2/10 down states were
observed by XInput; this is a demonstrated downstream sampling limit, not proof
of actual iPad timing. The read-only kernel recorder and browser recording can
now capture both sides during a real failure.

Live PCM capture also passed: 20 ms stereo 48 kHz chunks arrived at measured real time,
and capture stopped when disabled. The separate browser audio waveform test covers
playback. These are complementary checks, not a full physical audio test.

No production deployment or release has been performed for this goal.

Final cleanup: root terminated only dev PID 3103706, observed port 6734 close
and dev controller event25 disappear, and removed the private CPU-test config.
Production `lwfa.service` remained active with the original PID 2726522. No
installed config, application profile or game launch option was changed.

## Optimized review bundle, continuation 1

Previous goal turn: progress (code fixes, regression tests and live evidence).
This continuation confirmed BG3 is not running and production remains active.
It built the optimized engine successfully and staged it with the matching shell
at `target/reliability-review-retogn7q/`. The manifest hashes all 76 build files
and fingerprints source inputs, including uncommitted changes. This is a local
review build, not a published release or a version bump.

The staged engine and staged shell then passed all six controller E2E checks.
Root verified the file hashes again, terminated only dev PID 3166045, and
confirmed port 6734 and event25 were gone. Production remains PID 2726522.

The concrete installation under review is to back up and replace only:

- `~/.local/share/lwfa/libexec/lwfa-engine`, using the staged `bin/lwfa-engine`.
- `~/.local/share/lwfa/share/lwfa/shell`, using the staged `shell/`.

Then restart `lwfa.service`, verify health and served asset hashes, and reload
the iPad shell before collecting the real BG3 trace. Configuration, credentials,
Steam settings and game prefixes would remain untouched. A restart interrupts
the streaming session. It has not been authorized as an exception to the
controller brief's explicit production-preservation instruction, so no
installed file has been changed.

## Blocked audit, continuation 2

The actual-device validation blocker has persisted across three consecutive
goal turns: the main reliability pass, optimized-bundle preparation, and this
revalidation. Earlier turns made concrete progress on other requirements;
those independent tasks are now finished. No new iPad trace or restart
approval has arrived, and no BG3 process is running.

Current checks confirm all 76 staged build hashes match, the installed engine
is still different from the staged engine, production remains active with PID
2726522, and the dev listener/controller are absent. No background build or
test is being waited on. The current turn is a no-progress revalidation, not
a verified wait.

The goal is blocked, not complete. Resume after the user approves the concrete
backup/install/restart action and can reproduce on the iPad, or supplies a
real failure trace through another authorized test setup. Do not invent a
controller fix from the already-green synthetic tests.

## Preparing 1.4.2 for user testing

The user requested a commit and version bump and will run packaging and the
upgrade themselves. All workspace package and crate versions are now 1.4.2.
The earlier optimized review bundle predates this bump and must not be used
as the 1.4.2 package. Run `scripts/package.sh` with its default build step to
rebuild the engine and shell from the committed tree. Production remains
unchanged by the agent; the actual iPad/BG3 validation is still pending.

Post-bump validation: 650 JavaScript tests and 315 Rust tests pass; three
opt-in Rust hardware tests remain ignored. Type checking, shell build and
whitespace checks pass. All package/crate manifests and Cargo lock entries
agree on 1.4.2.
