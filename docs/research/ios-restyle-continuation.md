# iPad restyle continuation

2026-09-12. Continues Claude Fable 5.1 session `e96f0c14-03e7-48cf-bb2d-ba6d76203e1d` (LWFA client iOS iPad app). The session completed the restyle and app version 0.2.0 (2); its final runtime-review agent stopped with HTTP 429. This pass finishes that review and validates the combined build. Claude's SwiftUI shell, brand tokens, Observation models, off-main Metal renderer, and pull-based audio architecture are retained.

## Findings corrected

- Audio ring reset discarded samples decoded after the reset but before the first render callback. A regression test produced zero rendered frames instead of 480. Reset now records a fixed discard boundary. Overflow also uses absolute boundaries so a concurrent render cannot cause excess skipping.
- Audio decoder output now passes through the playback control queue before checking mute/interruption/reset generation. Samples retired by a reset cannot enter the new playback generation.
- Non-planar JPEG/BGRA pixel buffers used plane dimensions, which return zero. They now use full-buffer dimensions. See [Apple's plane-width contract](https://developer.apple.com/documentation/corevideo/cvpixelbuffergetwidthofplane(_:_:)).
- VideoToolbox callback results use synchronized storage, and stale decode tickets cannot publish frames. Metal mailbox clearing retrieves its new epoch atomically. The synchronous decode contract is documented by [Apple](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsessiondecodeframe(_:samplebuffer:flags:infoflagsout:outputhandler:)).
- Color conversion now handles the actual normalized samples for 8-bit NV12 and 10-bit P010, including full/video range chroma centers. Portable tests check black, white, gray and BT.709 primary reconstruction. [Apple's 10-bit format description](https://developer.apple.com/documentation/accelerate/vimagecvimageformat/format/format420ypcbcr10biplanarvideorange).
- Virtual keyboard releases now use the modifiers captured when each key went down. Overlapping chords retain their shared modifiers until the last owner releases them. Regressions covered changing Shift while A is held and overlapping Shift+A/Shift+B.
- Session input release now invalidates local keyboard, mouse and gamepad holds. A canvas losing window focus releases UIKit state without cancelling the click that focuses another canvas. Mouse layout editing cannot scroll the game.
- Non-modal panels keep gameplay live. Each nested dialog/picker owns an independent input block; UIKit text editing notifications cover fields even with a hardware keyboard. Removing one block cannot resume gameplay while another remains. This uses [UITextField](https://developer.apple.com/documentation/uikit/uitextfield/textdidbegineditingnotification) and [UITextView](https://developer.apple.com/documentation/uikit/uitextview/textdidbegineditingnotification) editing notifications, not keyboard visibility.
- Navigation groups inherit any anchored member's zone and retain canonical tab order, while expanded buttons respect the user's rail order. Small visuals retain 44-point hit targets; the rail scrolls if its minimum arrangement cannot fit. [Apple button guidance](https://developer.apple.com/design/human-interface-guidelines/buttons).
- The geometry callback captures orientation as a value instead of reading actor-isolated view state from its Sendable transform. [Apple geometry API](https://developer.apple.com/documentation/swiftui/view/ongeometrychange(for:of:action:)). Deprecated trait callbacks use public trait registration.
- Saved-machine shortcuts use that machine's saved credential, rather than submitting a password currently typed for another address. HTTP requires the explicit switch. Login copy no longer promises an unimplemented default port or native one-tap-link flow.
- Tapping input docks no longer triggers the desktop gesture that dismisses an open panel.

## Validation

Commands from the repository root:

```bash
mise exec -- swift test --package-path clients/ios
mise exec -- node scripts/test-ios-layout.mjs
mise exec -- bash scripts/build-ios.sh
```

Results: 90 portable tests passed with zero failures. Canonical browser layout comparisons passed for geometry, resize drift, fullscreen requests, stacks, fit, workspaces, streams, orientation and persistence. The ARM64 release build completed with zero compiler warnings, and IPA verification confirmed version 0.2.0 (2) with resources intact. Linux unit tests do not execute UIKit, VideoToolbox, AVAudioEngine or Metal. An ARM64 SDK build verifies compilation and bundle resources, not device rendering or latency.

Device acceptance for this build: trusted HTTPS login and saved-machine reconnect; background/foreground and app relaunch; HEVC/H.264/JPEG output; audio starvation, interruption and route changes; keyboard overlapping chords; changing game focus with held input; modal and text-editor input isolation; all rail edges and compact sizing. Existing 0.1.0 device installation is not validation of this restyle.

No production engine, host display, Proton, USB, service or other-project configuration was changed.

## Login crash follow-up

The user's iPad produced four 0.2.0 (2) crashes with the same SIGABRT on `lwfa.audio.playback`. The exception stack enters `AUInterfaceBaseV3::SetFormat` through `AVAudioEngine.connect`, called by `AudioPlaybackWorker.start()`. The binary UUID matches the preserved Linux build exactly. A [redacted crash summary](fixtures/ios-login-audio-crash.json) retains the relevant evidence; original device reports stay outside the repository.

The source block and mixer connection both used packed/interleaved stereo float. The mixer connection now uses `AVAudioFormat(standardFormatWithSampleRate:channels:)`, while the source block keeps its explicitly declared interleaved format. Apple documents that [AVAudioSourceNode supports different block and output formats, including interleaving conversion](https://developer.apple.com/documentation/avfaudio/avaudiosourcenode/init(format:renderblock:)). This is a format-boundary correction, preserving the pull-based audio design and ring buffer.

The device disconnected during live logging, so the additional exception reason text was not captured. The crash stack identifies format setup as the failing operation; the corrected graph still requires installation and a successful device login to confirm resolution. Portable Linux tests cannot execute this AVAudioEngine connection and did not catch the crash.

## Canvas parity pass

2026-09-13, Claude Fable 5.1, after the Codex review pass above. The desktop canvas now follows `Desktop.tsx`, `WindowSurface.tsx` and `lib/motion.ts` instead of a generic aspect-fit surface:

- Window boxes use the browser chrome: `rounded-xl` (14.4pt) with a 1pt `white/10` ring and a soft shadow, the signal-orange `primary/70` ring plus a deeper shadow when focused, and no radius, ring or shadow when one window fills the output (`fillsOutput`). The ground under a window is `black/40` over the ink backdrop.
- Frames fill the placed box exactly, as the browser's `<canvas class="h-full w-full">` does, so the Metal viewport no longer letterboxes inside the box. The engine renders each window at the size the client asked for, so the only stretch is the moment after a resize.
- Motion matches `Motion.set`: position animates on the configured spring (stiffness 1000, damping 66, mass 1), size snaps, and a layout that arrives with a viewport change snaps everything into place. `NativeSession.layoutAnimated` carries that flag; reduced motion and the Appearance switch still disable movement.
- Placeholders are the browser's: "Off screen" for a window the engine is not streaming (`NativeSession.streamedWindows`), "This window has never drawn anything" for a blank window, "Waiting for pixels…" otherwise; "This workspace is empty." and "Waiting for the engine’s output size…" for the desktop itself.
- The rail is flush to its screen edge and full length, in the sidebar colour at 80% over glass with a hairline on the inner side, as in `NavRail.tsx`. The panel sheet starts where the rail ends.

Validation: 90 portable tests pass; the ARM64 release build and IPA check pass at 0.2.0 (2). Device rendering is still unverified.

## Device feedback, 2026-09-13

Screenshot from the iPad on 0.2.0 (2): the rail showed only faint button squares and no icons. Cause: the rail's glass was a `.background` inside a `GlassEffectContainer`, and the container composites its merged glass layer over sibling content, so the buttons sat under the material. The glass is now applied to the rail view itself, which keeps its content above the material. The rail also no longer extends under the status bar; the browser pads the whole shell by the safe area, so this matches.

Clipboard and file-chooser uploads only reached Files-app providers. Both now offer "Photos and videos" through the system photo picker (`PhotosPicker`, out of process, no photo-library permission prompt) next to Files and folders; picked items are copied into an `lwfa-upload-` folder that the uploader cleans up. Build 0.2.0 (3).

## Rail behaviour, 2026-09-13

Desk-check of the rail against `ShellChrome.tsx`, `NavRail.tsx` and `lib/dock.ts` after the user reported wrong button behaviour on build (2)/(3). Fixed in 0.2.0 (5):

- Taps did not reach the buttons on (2): the glass rectangle was composited above them (see above). Fixed in (3).
- The rail measured its own length starting from zero, so the first frame collapsed to the three-button tier inside a scroll view and re-laid out a frame later. The parent now passes the available length; the measurement only refines it.
- Only one input surface is open at a time, as in the browser's dock store: showing the gamepad hides the keyboard or mouse dock and vice versa. Before, both could stack.
- The Gamepad rail button is a panel button and reads selected only while its panel is open, not while the overlay is visible (`isActive` in NavRail.tsx). Dock buttons reflect their surface.
- Hiding the navigation in immersive mode closes the open panel, matching the browser's layout effect.

## Hit-testing and layering audit, 2026-09-13

Prompted by "something can sometimes be pressed". Every layer in `ShellView` was checked for what blocks and what passes touches. SwiftUI hit-tests anything that draws, including `Color.clear`, so a clear fill used as a layout filler silently swallows touches for everything beneath it. Fixed in 0.2.0 (7):

- Immersive mode: the logo-button layer had a full-screen `Color.clear`, so the whole desktop was dead to touch while immersive. Removed; only the logo button and the exit control take input.
- Virtual gamepad overlay: the play area also had a `Color.clear` filler, so taps in the gaps between pads never reached the game. Removed; gaps pass through unless the tap shield is on, as in `GamepadOverlay.tsx`.
- The audio-resume button moved to the top-leading corner; the gamepad and mouse toolbars own the top-trailing corner.
- Verified intentional layering: backdrop < rail spacer < desktop (with input view on top of each window, disabled while arranging) < overlay docks < panel scrim (never hit-testable) < panel sheet (`zIndex 2`, opaque) < rail (`zIndex 3`) < immersive controls (`zIndex 4`). Placeholders, rings and the closing badge are `allowsHitTesting(false)`.
- Performance: per-packet counters in `NativeSession` (frame, byte and audio tallies, touch tables, the send queue) are `@ObservationIgnored`; no view reads them, and a 60 Hz stream no longer pays observation tracking per frame.

## Panel open animation, 2026-09-13 (0.2.8)

Reported: pressing a rail button made "the rail animate" and broke the layout. Two causes removed in 0.2.0 (8): the shell applied an implicit animation to its whole subtree whenever the open panel changed, so unrelated views (the rail included) animated with it; and the panel's slide-in started at the screen edge and travelled under the glass rail, which refracted it on the way. The panel is now laid out in the region beside the rail and clipped there, and only the panel change itself is animated (500 ms open, 300 ms close), from the one place that sets it.

Versioning from here: every fix that ships to the iPad bumps the patch version (`CFBundleShortVersionString`, the number iPadOS shows in Settings), not only the build number. 0.2.8 is the first build under that rule; the build number keeps counting alongside.

## Animation and render-cost sweep (0.2.9)

Same class of defect as the panel case, swept across the app:

- The shell no longer carries implicit animations keyed on immersive state or navigation reveal; the rail animates only its own appearance, and is explicitly excluded (`.animation(nil, value: panel)`) from panel transactions.
- Window focus eases only the ring and shadow (`transition-shadow`); the box, size and position are outside that scope. Entering arrange mode is instant, as in the browser, where the scene transform is written as CSS variables without a transition.
- The busy status dot's pulse is scoped to the dot and driven from the tone, so it starts when the connection becomes busy rather than only if it was busy at first appearance.
- `NativeSession.audioNeedsResume` read the one-second diagnostics snapshot, which made the whole shell body re-evaluate every second. It now reads a flag written only when the audio worker's interrupted state changes.

Validation: 90 portable tests pass; release build 0.2.9 (9) verified.
