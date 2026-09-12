# Native iPad build toolchain on Linux

Checked 2026-09-12. The user requires local Linux builds, without a remote Mac or CI build service.

## Decision

Use the existing Swift 6.3.3 compiler with **xtool 1.19.2** and an Apple SDK extracted locally from the user's Xcode download. xtool provides a Linux path for building SwiftPM packages into iOS apps, packaging, signing, and device installation. The earlier experimental `swift-sdk-darwin` project is archived and directs users to xtool. [xtool](https://github.com/xtool-org/xtool), [predecessor](https://github.com/kabiroberai/swift-sdk-darwin).

This is an alternative build system. It does not run Xcode or an iOS simulator on Linux. The supplied Xcode 26.6 archive has now been imported, and an ARM64 iOS probe importing SwiftUI, MetalKit, and GameController passes on Linux after the compiler-header correction described below. The initial native app also compiled and packaged as an unsigned ARM64 IPA. The expanded parity implementation is being checked separately; neither SDK imports nor packaging establish a device test.

## Why Darling is not the build prerequisite

Darling's own compatibility list says the Xcode GUI does not work and UIKit is not implemented. Its documented compiler examples demonstrate command-line programs, not a current SwiftUI iPad app. Installing Darling therefore would not establish a working iPad build environment. [Compatibility list](https://docs.darlinghq.org/known-nonfunctional-software.html), [compiler examples](https://docs.darlinghq.org/what-to-try.html).

The linked Baeldung article is from March 2024 and includes kernel-module installation commands. Current Darling uses a userspace server. Its launcher still requires effective UID 0 and manages Linux namespaces, so merely extracting it into a user directory is insufficient. No Darling package, kernel module, or system launcher was installed for this task. [Requested article](https://www.baeldung.com/linux/xcode), [current upstream description](https://github.com/darlinghq/darling), [launcher source](https://github.com/darlinghq/darling/blob/master/src/startup/darling.c).

Darling's latest release inspected was `v0.1.20260608`. Official assets contain source and Debian packages. Arch community packages exist, but they are unnecessary for the selected cross-compilation route. [Release](https://github.com/darlinghq/darling/releases/tag/v0.1.20260608), [Arch package](https://aur.archlinux.org/packages/darling-bin).

## Local setup and evidence

Initial read-only checks found:

| Component | Result |
| --- | --- |
| Host | Omarchy 4.0.0, Arch family, x86_64 |
| Version manager | mise, Swift 6.3.3 selected |
| Swift target | `x86_64-unknown-linux-gnu` |
| Apple Swift SDK | None in `swift sdk list` |
| Mach-O linker | `/usr/bin/ld64.lld`, LLD 22.1.8 |
| Device helpers | `usbmuxd` and `ideviceinfo` present |
| Xcode archive | No matching archive in Downloads/Uploads top-level |

`scripts/setup-ios-toolchain.sh` downloads the pinned upstream AppImage, verifies its SHA-256, and extracts it so FUSE is unnecessary. It installs only beneath the user's data directory and adds `~/.local/bin/lwfa-xtool`, leaving any existing `xtool` command intact. It does not authenticate with Apple or read credentials.

Initial tool installation check, before importing the Xcode archive:

```text
lwfa-xtool --version
xtool 1.19.2

lwfa-xtool sdk status
Not installed
```

The x86_64 release digest is `41c5adcfab3d8d65fba3db0b5885ae16cf9851560da724781be38e523fe4e3e7`. The script also pins the aarch64 release digest, although that architecture was not tested. [Release assets](https://github.com/xtool-org/xtool/releases/tag/1.19.2).

## Apple SDK setup

Download Xcode 26.x through [Apple Developer Downloads](https://developer.apple.com/download/all/?q=Xcode), using the user's browser for Apple login and the download agreement. Then run:

```bash
mise exec -- bash scripts/setup-ios-toolchain.sh --sdk /path/to/Xcode.xip
```

Upstream's current Linux guide specifies Swift 6.3 and Xcode 26. The dedicated `sdk install` command does not require signing authentication. It extracts the SDK and Swift resource directories, creates SwiftPM target metadata for `arm64-apple-ios`, and includes a Linux Mach-O toolset. It needs more than the iPhoneOS headers alone. [Linux guide](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Documentation/xtool.docc/Installation-Linux.md), [SDK command](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Sources/XToolSupport/SDKCommand.swift), [SDK builder](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Sources/XToolSupport/SDKBuilder.swift).

For a prepared app package, run `lwfa-xtool dev build --configuration release --ipa` from its directory. This creates an unsigned package by default. Signing and installing on an ordinary iPad is a separate step requiring Apple provisioning credentials and device setup. Keep those credentials out of the repository and chat. [Build command source](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Sources/XToolSupport/DevCommand.swift).

## Native implementation implications

Expose the app as an automatic SwiftPM library product containing the SwiftUI `@main` entry point. xtool creates the executable wrapper itself. When the package also exports a core library, set `product: LWFA` explicitly in `xtool.yml` along with `version: 1`, `bundleID`, and `infoPath`. An executable product will not satisfy xtool's library selection. [Planner](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Sources/PackLib/Planner.swift), [packer](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Sources/PackLib/Packer.swift).

Avoid assuming Xcode build phases or asset compilation run automatically. Keep protocol decoding and state transitions in a library that can be tested directly on Linux; validate SwiftUI, GameController, VideoToolbox, and Metal code against the supplied Apple SDK and on the device. Linux-only tests do not prove those native APIs compile or behave correctly. [Bundle configuration](https://github.com/xtool-org/xtool/blob/4208c77c8128568f8b938d0c67d2f4bdcf04e100/Documentation/xtool.docc/Control.md).

## Clang header correction after SDK installation

The first native build failed while importing SIMD intrinsic headers. SHA-256 comparison identified the exact mismatch: the generated SDK's `usr/lib/swift/clang/include/arm_neon.h` matched the host's `/usr/lib/clang/22/include/arm_neon.h`, while the selected Swift 6.3.3 toolchain embeds Clang 21. xtool had selected the distro `clang` command when copying builtin headers. This was a toolchain-selection failure, not evidence of a broken Apple SDK. The upstream fix uses host Clang resource headers to avoid Apple-versus-Linux intrinsic differences, but still needs the correct compiler selected. [Upstream change](https://github.com/xtool-org/xtool/pull/215), [related copying fix](https://github.com/xtool-org/xtool/pull/255).

The setup script now derives the selected Swift installation from `swift -print-target-info` and prepends its sibling compiler directory only during SDK installation. For existing installations, it compares the generated SDK's builtin headers with that compiler's resources, preserves any mismatching directory beside the replacement, and copies the matching headers. It does not change Swift, system Clang, framework headers, or other system files.

On this host, the original directory is preserved as `include.lwfa-original`. Later script repairs use uniquely named `include.lwfa-backup-*` directories. A separate `-Xcc -resource-dir` flag was insufficient for nested framework imports, which is why the generated SDK resource directory is repaired directly.

Validation used a fresh module cache, Swift 6.3.3, `-target arm64-apple-ios17.0`, iPhoneOS26.5.sdk, and the SDK's Apple Swift resource directory. The probe imported `MetalKit`, `GameController`, and `SwiftUI`. It exited 0 with no diagnostics after the header replacement. A second setup run confirmed matching headers without changing them.

## Existing sideloading project

The earlier account-based Linux setup lives at `~/development/ipadprom1-11inch-kernel/utm/`. Read-only inspection found its `tools/sideloader-cli-x86_64-linux-gnu` and `tools/libplist-compat/libplist-2.0.so.3`. `install --help` exited 0 when launched with that compatibility directory on `LD_LIBRARY_PATH`.

The old `scripts/install-apps.sh` defaults to UTM and StikDebug and prefixes each IPA argument with its own project path. Do not reuse those defaults for lwfa. `scripts/install-ios.sh` targets the lwfa IPA explicitly and scopes the old libplist ABI to the signer process. No credentials or pairing records were inspected, no Apple authentication was attempted, and no iPad app was installed during this check. Current account validity remains unverified. [Sideloader usage](https://github.com/Dadoum/Sideloader#how-to-use-the-cli-to-install).

## Full native bundle validation

The expanded native client built successfully on 2026-09-12 with Swift 6.3.3 and the extracted iPhoneOS26.5 SDK. The app targets ARM64 iOS 17 or newer. `scripts/build-ios.sh` completed the release build, packaged the IPA and ran `scripts/check-ios-ipa.py`.

- Artifact: `clients/ios/xtool/LWFA.ipa`, 7,609,137 bytes.
- Version: native app 0.1.0, build 1.
- SHA-256: `fce62e49b44953b3004357ba68a2ef922c3cfae4ab8e473a6df47baabec06fcf`.
- ZIP integrity, application identifier, ARM64 Mach-O executable, iPad support, indirect-pointer flag, layout policy resource, logo and Opus license passed validation.
- Dynamic imports point only to system libraries/frameworks. libopus is compiled into the app.
- The portable Swift suite passed 50 tests, and canonical layout comparison tests passed after the final source changes.

The IPA remains unsigned. No signing, installation, Metal rendering, UIKit interaction or audio playback has been tested on the physical iPad. The production Rust engine, host display configuration and running service were not changed.

## Sideloading login crash and installer change

The first user-run install on 2026-09-12 failed at 21:01:35 in the old Sideloader binary, PID 1378264. The installed application had not launched. The crash was SIGSEGV in `server.appleaccount.AppleAccount.login`, binary offset `0x152a72`. The faulting instruction dereferenced RAX immediately after `Plist.fromXml`; RAX was zero. Restricted inspection classified the 190-byte parser input as HTML, not an XML plist. The response itself and authentication memory were not printed or saved. The existing libplist compatibility library was correctly loaded. There was no contemporaneous OOM event, and about 36 GiB of memory was available.

This confirms an unchecked parser result in the old login implementation. It does not establish why the response was HTML or whether the credentials were accepted. Upstream source similarly parses the first authentication response as a plist without checking the parser result. [Login implementation](https://github.com/Dadoum/Sideloader/blob/main/source/server/appleaccount.d).

`scripts/install-ios.sh` now uses the already installed xtool 1.19.2. It checks the existing IPA, checks saved-login status, prompts for password-mode login when needed, then calls `xtool install --usb`. That command provisions and signs through `IntegratedInstaller`; it is not merely a signed-IPA copier. No app rebuild or production backend update is required. `--login` requests fresh authentication, and `--check` performs only tool/bundle preflight. [xtool installer](https://github.com/xtool-org/xtool/blob/1.19.2/Sources/XToolSupport/InstallCommand.swift), [authentication command](https://github.com/xtool-org/xtool/blob/1.19.2/Sources/XToolSupport/AuthCommand.swift).

Validation: bundle preflight and shell syntax passed. A mock xtool under a terminal verified first login, saved-login reuse, forced login, correct USB/device/path arguments, and stopping before installation after login failure. Real Apple authentication and device installation require the user to run the command again and remain unverified. Extracted temporary core files were deleted. The old Sideloader installation and system libraries were left unchanged.


## USB installation interruption, 2026-09-12

The user subsequently completed xtool authentication, provisioning, signing, and packaging. Installation failed at `[Connecting] 66%` with `noDevice`. Device installation is still unverified.

Read-only host checks found:

- The iPad enumerated as `05ac:12ab`, SuperSpeed 5 Gbit/s, on port `2-9.2` behind an ASMedia ASM1074 hub. This identifies USB topology; it does not establish whether the hub is external or built into the computer.
- Between 21:09:46 and 21:09:59, the kernel logged repeated resets of the same device, followed by disconnection at 21:10:00. Further attempts also reset.
- At 21:12:12, usbmuxd failed to set USB configuration 4 with errno 71 (`EPROTO`). At 21:13:15, it removed another device connection when the kernel reset it.
- At 21:13:36, the iPad was present in USB sysfs with configuration 4 and runtime power state `active`, but xtool and libimobiledevice could not find a usable device. The iPad power-control setting was `on`, so device autosuspend was already disabled.
- Repeated reads from 21:13:57 through 21:14:09 still saw the USB device while libimobiledevice listed none. Physical enumeration alone therefore does not establish a working installation connection.

The failure is below IPA signing. Cable/hub integrity, USB configuration handling, and device state remain candidates. A controlled port/cable comparison is needed before blaming a particular component. The kernel documents EPROTO as a protocol/no-response error that commonly accompanies hardware, firmware, cable, or disconnection problems. [Kernel USB error documentation](https://docs.kernel.org/driver-api/usb/error-codes.html).

The `apple-mfi-fastcharge` prefix identifies the bound USB device driver and is not proof that it initiated the reset. Upstream source does not contain a direct USB reset call. No USB drivers, power settings, system services, or pairing records were changed during this investigation. [Driver source](https://github.com/torvalds/linux/blob/master/drivers/usb/misc/apple-mfi-fastcharge.c).
