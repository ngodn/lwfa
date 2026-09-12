# lwfa for iPad

Native SwiftUI client for iPadOS 26 and later, built locally on Linux with Swift 6.3.3 and xtool. Current app version: 0.2.12 (12). It connects to lwfa 1.5.10 and later. The 1.5.11 release includes this IPA and the matching browser layout update.

The native client includes SwiftUI navigation and settings, column/workspace layouts, app launching, immersive view, physical and virtual controllers, on-screen keyboard and mouse controls, clipboard and file transfers, accounts/devices, and managed Proton/LSFG/Framegen settings. H.264/HEVC use VideoToolbox and Metal; audio uses AVAudioEngine. The feature inventory and remaining device checks are in [the parity audit](../../docs/research/ios-feature-parity.md).

## Build on Linux

From the repository root:

```bash
mise exec -- bash scripts/setup-ios-toolchain.sh --sdk /path/to/Xcode_26.6_Universal.xip
mise exec -- swift test --package-path clients/ios
mise exec -- node scripts/build-ios-layout.mjs
mise exec -- node scripts/test-ios-layout.mjs
mise exec -- bash scripts/build-ios.sh
```

Download the full Xcode 26.6 `.xip` from [Apple Developer Downloads](https://developer.apple.com/download/all/?q=Xcode). xtool extracts the SDK and supporting files on Linux. Xcode and Darling do not run during the build. Xcode 26.6 provides the iOS 26.5 SDK and Swift 6.3 framework interfaces. [Apple version table](https://developer.apple.com/xcode/system-requirements), [xtool Linux guide](https://github.com/xtool-org/xtool/blob/main/Documentation/xtool.docc/Installation-Linux.md).

The SDK installation is a one-time step. The helper installs in the user's home directory without changing the host desktop or production lwfa service. Keep the SDK and Apple credentials outside the repository.

The app package is `clients/ios/xtool/LWFA.ipa`. The build is unsigned by default. An unsigned IPA cannot run on a normal iPad until it is signed and provisioned.

## Install on an iPad

The wrapper signs and installs the existing IPA with xtool. It prompts for Apple account authentication in your terminal when no xtool login is saved:

```bash
bash scripts/install-ios.sh
```

Use `bash scripts/install-ios.sh --login` to authenticate again after an expired login. `--check` validates the bundle and tool without logging in or installing. `LWFA_IPAD_UDID` selects a specific USB device. No rebuild is needed to retry signing.

The previous Sideloader setup was found at `~/development/ipadprom1-11inch-kernel/utm/`, but its binary crashed in the Apple login response parser during the first installation attempt. The wrapper now uses xtool directly and does not load the old libplist workaround or modify that project. xtool's `install` command uses its integrated provision/sign/install flow for an existing IPA. [Installer source](https://github.com/xtool-org/xtool/blob/1.19.2/Sources/XToolSupport/InstallCommand.swift).

Authentication happens in your terminal. Do not paste passwords, private keys or verification codes into chat. The earlier 0.1.0 app was successfully signed and installed by the user. The current 0.2.0 build needs a fresh installation and device check.

Connect the unlocked iPad over USB, trust the computer when prompted, and enable Developer Mode if iPadOS requests it. Signing restrictions and provisioning expiry depend on the Apple account. See [xtool's first app guide](https://github.com/xtool-org/xtool/blob/main/Documentation/xtool.docc/First-app.tutorial).

## Runtime behavior

- Credentials are stored per server in iPad Keychain. HTTPS is the default. HTTP requires an explicit connection-form opt-in; normal certificate validation always applies to HTTPS.
- A first connection stays on the Connect screen until the engine accepts it. Failed attempts report network, certificate, or authentication errors. The initial session handshake has a 20-second deadline. Connecting and reconnecting can both be cancelled; automatic retries apply only to previously established sessions.
- Only the primary interactive session sizes the engine canvas. Canvas dimensions are logical points at scale 1. Metal uses the display's drawable pixel size separately. Workspaces, column sizes, stacks and fullscreen use the browser's canonical layout policy, compiled into a small JavaScriptCore resource. There is no WebView shell. Removed Sharper/More space features stay removed.
- Input is mapped through the placed window box; frames fill it exactly, as the browser canvas does, so the only stretch is the moment after a resize. Windows carry the browser chrome: rounded 14pt cards with a hairline ring and shadow, an orange ring when focused, none when one window fills the output. Position springs on the configured window spring and size snaps. Non-modal panels keep gameplay live. Text editing, confirmation dialogs, file pickers and modal sheets release and suspend gameplay input until all blockers close. Controller holds use GameController events, with explicit neutral releases on disconnect and app suspension.
- Auto video mode negotiates hardware-supported HEVC/H.264, then can fall back after a decoder failure. Explicit codec selections do not silently change to JPEG. The engine can still constrain codec negotiation when several clients share a session.
- VideoToolbox supplies NV12 frames to Metal through a CoreVideo texture cache. A frame-driven worker renders outside the main actor, retaining pixel buffers and texture wrappers until GPU completion. JPEG decoding uses CPU memory and a BGRA texture. Native APIs alone are not proof of lower latency; compare on the actual device.
- Audio negotiates Opus and also accepts 48 kHz stereo PCM. Pinned libopus 1.6.1 decodes on a serial CPU queue, with a five-packet input bound. An AVAudioSourceNode pulls from a PCM ring buffer with a 60 ms starting cushion. Beyond 150 ms queued, the consumer skips ahead toward that cushion. These are buffering policies, not measured end-to-end latency. The upstream license ships inside the app.
- Temporary foreground inactivity releases input without destroying the stream. Backgrounding closes the stream with a short UIKit background assertion for input release, preserving the workspace and authenticated session. Foregrounding reconnects with the same client identity. Relaunch restores the last authenticated server from Keychain and non-secret session metadata. Explicit disconnect cancels restoration; sign-out also removes that server's saved credentials.
- Audio session and graph changes use a serial control queue. The audio callback reads the ring without locks or allocation, refills its cushion after starvation, and the worker recovers a stopped engine after configuration changes. An interruption that needs user action exposes Resume audio instead of leaving an unexplained muted stream.

## Validation

Portable tests use the repository's Rust-generated protocol fixtures and cover malformed packets, Annex B framing, credentials containing reserved URL characters, input releases, canvas geometry, session restoration, and audio queue recovery. Linux tests exclude Apple framework implementations. The expanded app has passed a full ARM64 Apple SDK release build and IPA integrity/resource checks on Linux. The continuation validation and regression findings are recorded in [the review](../../docs/research/ios-restyle-continuation.md); canonical layout comparisons also run independently of SwiftUI. Physical-device testing is still required.

Device acceptance checks:

1. Connect through trusted HTTPS. Confirm an incorrect password fails cleanly.
2. Compare the selected window and all four pointer corners with the browser at the same usable canvas size, including rotation and immersive mode.
3. Test H.264 and HEVC, switching windows and resizing, including recovery after a connection stall.
4. Check audio after controller-only game launch, interruptions, Bluetooth route changes, and foreground resume.
5. Check rapid LB/RB presses, held buttons, both sticks, trigger travel, and controller disconnect. Native sheets and credential fields must not send game input.
6. Connect a second client. Confirm follower mode preserves the primary layout and takeover follows the server's focus.

Signing and physical-device testing remain separate from Linux tests and Apple SDK compilation. Check every feature against the parity inventory before treating this as a production replacement for the browser. In particular, real iPad touch gestures, controller mapping, Metal output, audio routes, and file-provider uploads have not yet been exercised on the device.

Research: [Linux toolchain](../../docs/research/ios-build-toolchain.md), [native media and protocol](../../docs/research/ios-native-client.md).
