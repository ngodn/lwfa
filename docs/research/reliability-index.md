# Reliability investigation index

Read this file before resuming the reliability goal.

## Established findings

- Production is the user's daily driver. Never restart it for testing or kill processes by a broad name match. Root owns isolated dev-engine lifetimes.
- Always pin the dev shell directory and compare served asset hashes to the checkout build. A successful build does not prove the running engine serves it.
- The 8 ms controller timer passed mocked-browser-to-evdev tests, but the user still reports failure on iPad after 1.4.1. The controller issue is unresolved. Normal timed presses now also passed disposable GE-Proton XInput, but batch-compressed pulses can disappear there despite evdev success.
- Historical cellular measurements show relayed transport and large variable RTT. Improve adaptation without changing the user's VPN or network configuration.
- Controller failures previously occurred at different layers: enumeration/player slot, uinput, container visibility, focus and XInput. Verify live in order. An evdev pass is not a Proton-game pass.
- JPEG fallback needs actual-byte pacing; a video FPS floor alone exceeded the chosen budget on ordinary scrolling text. The fix passes a live limited-connection test. CPU readback must discard speculative prefetch when entering this pacing mode while preserving static damage.

## Rejected approaches and known traps

- Do not assume faster polling fixes transitions Safari never exposes.
- The reproduced 10 px black bands were draw-damage coordinates, fixed by element-local damage. Do not revive historical crop/fill guesses; live 16-case evidence is indexed below.
- Do not run installers against the real home directory.
- Do not replace genuine touch with clicks to hide input bugs.
- Difficult block noise exceeds low H.264 targets in standalone FFmpeg too. Ineffective NVENC tuning experiments were removed; do not present codec entropy limits as a demonstrated lost-option bug.

## Artifacts

| File | Purpose |
|---|---|
| [Status](reliability-status.md) | Current scope, proof and remaining work |
| [Live BG3 check](reliability-controller-live.md) | Actual 1.4.2 physical-only complaint, kernel/XInput comparison and pending browser trace |
| [Controller engine/Proton investigation](reliability-controller-engine.md) | Actual GE-Proton11-5 configuration, input pipeline and sampling limits |
| [Helper wrappers](reliability-helpers.md) | lwfa root resolution, CLI verification and wrapper smoke tests |
| [Controller brief](../controller-input.md) | Previous input changes and limits of browser-to-kernel evidence |
| [Audio investigation](reliability-audio.md) | Audio lifecycle fixes and actual browser waveform evidence |
| [Adaptation investigation](reliability-adaptation.md) | Recovery and encoder rebuild fixes, real TCP throttle tests and remaining rate limits |
| [Rendering investigation](reliability-rendering.md) | 10px band reproduction/fix and stale decoder lifetime regressions |

History source: `~/.claude/projects/-home-eins0fx-development-lwfa`. Read targeted records with `rg` and `jq`; do not dump full transcripts or credentials.
