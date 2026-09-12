# Playing games through lwfa

Steam is X11, so everything under Proton is X11. Xwayland starts with the engine
and those windows land in the strip like any other. Games are played through the
[on-screen controller](shell.md#input), which the machine sees as a real
`/dev/uinput` device rather than as a web page pretending.

Three details make it reliable in practice.

- `[gamepad] persistent = true` creates the virtual controller at engine startup
  and never destroys it. Proton runs games in a container where controller
  hotplug is unreliable; a pad that exists before the game launches is found
  like real hardware, because that is what real hardware does.
- Wine decides whether a game is foreground from X input focus, and SDL games
  deliberately drop controller input in the background. The engine re-asserts
  focus after layout changes and runs a once-a-second guardian that repairs X
  focus if it points at nothing, so a fullscreen toggle cannot leave the pad
  unheard.
- Disable **Steam Input** for the game (Properties → Controller), while the game
  is closed. Steam otherwise grabs the pad and re-emits its own, with forwarding
  gated on its idea of the foreground window.

## X11 clients by hand

Xwayland gets its own display, so `DISPLAY` inside lwfa is *not* the host's.
Clients spawned by the engine inherit the right one automatically. To launch one
by hand, take the display number the engine logs:

```
xwayland ready on DISPLAY=:1
```

```sh
WAYLAND_DISPLAY= DISPLAY=:1 xterm     # forced onto X11
```

Unsetting `WAYLAND_DISPLAY` is what forces a dual-backend program down the X11
path; clearing `DISPLAY` instead forces the opposite. X11 windows use `WM_CLASS`
as the app id.

Interactive move, resize, maximise and fullscreen grabs are refused on both
backends for the same reason: the shell owns layout. Override-redirect windows
(menus, tooltips) render locally but are not yet composited into a remote shell,
the same gap Wayland popups have.


## Gaming components

Open **Gamepad → Proton**, **LSFG**, or **Framegen**. The session owner manages
components and per-game profiles. Changes apply on the next game launch.

## Managed Proton

Click **Install** in the Proton tab. lwfa obtains the verified GE-Proton11-6
base and matching Canvas patch together. There is no separate manual GE install.
The original GE download is about 509 MiB, plus a small Canvas artifact download
when it is not included in the installer.

When your games are closed, restart Steam and select the newly registered
**lwfa … (Canvas …)** tool in the game's **Properties → Compatibility**.
An installation creates a versioned tool instead of replacing a running runtime.
Host launches use its original GE runtime; launches inside lwfa use its patched
runtime. Installing a component does not change Steam selections or restart it.

## LSFG

Install your purchased **Lossless Scaling** through Steam, then install the
component in lwfa's LSFG tab. The manager checks the required shaders in your
DLL before enabling a profile. lwfa does not distribute Lossless Scaling's DLL.

Select a game, enable LSFG, choose its multiplier and motion detail, and save.
Copy the displayed launch option into **Steam → game Properties → General**.
Use that wrapper for the game instead of another LSFG wrapper.

The managed provider is the MIT-licensed **lsfg-vk 1.0.0**. It has a separate
config and Vulkan layer from an existing Decky installation. It uses SDR and FIFO
presentation. It is not an integration of lsfg-vk 2.0's different API and licence.

For the current 60 FPS stream, start with a stable in-game 30 FPS limit and 2×
generation. Prefer a game's built-in limiter. This release does not automatically
cap a game or provide a negotiated 120 FPS stream. Generated frames can improve
motion smoothness, but they do not provide the input response of the same number
of genuinely rendered frames, and interpolation can produce artifacts.

## Framegen

**lwfa Framegen is experimental.** It manages **OptiScaler 0.9.4** for compatible
Windows games. Select the integration the game actually supports and an output
backend, save, and use the displayed Steam launch option. The default pairing
is DLSS frame generation input with FSR output; this is not compatible with every
game. Native NVIDIA upscaling remains available where the game supports it.

The host needs Bubblewrap with overlay support and a 7-Zip extractor. The
manager checks these before use. Existing graphics injectors such as `dxgi.dll`
cause the launch to stop with an explanation. It does not overwrite existing
game DLLs or remove mod directories. A separate UE4SS `dwmapi.dll` is preserved.
An already-running Wine prefix must be closed before an isolated launch.

The injected files are visible in a private mount namespace. Files written beside
the executable stay in a persistent private overlay; they are not copied back to
the shared game directory when Framegen is turned off. Normal prefix-based saves
remain in the game's Wine prefix. Keep this distinction in mind for games or mods
that save alongside their executable.

Steam Input and game compatibility require testing with the chosen integration.
Use only one frame-generation provider. The wrapper disables competing LSFG layers
when Framegen is selected; it does not change Steam Input settings or disable all
overlays. Turning lwfa's profile off stops applying its overrides, and does not
remove an independently configured mod or native frame-generation setting.

## Storage and troubleshooting

Profiles, downloaded components, and private overlays live in
`$XDG_DATA_HOME/lwfa-gaming`, normally `~/.local/share/lwfa-gaming`.
This is separate from the engine installation and survives lwfa upgrades.
The same Steam launch option passes host launches through unchanged.

Gaming management needs Python 3.11 or newer. GE installation also needs Python's
tar extraction filters, available in updated Python 3.11 releases and later.
Downloads are pinned by digest and published atomically after validation.
If a connection drops during installation, reconnect and refresh component status
before retrying. The operation can continue after the browser disconnects.

The engine logs `window capture paths` every five seconds for active windows.
These records include GPU-direct frames, CPU readbacks/copies and bytes,
captured FPS, and GPU interop failures. Source snapshots are sampled compositor
observations, not a count of real versus generated game frames.

To build an offline package, set `LWFA_GE_BASE_ARCHIVE` to the verified original
GE archive when running `scripts/package.sh` or `scripts/package-portable.sh`.
The packager includes both that archive and the matching Canvas artifact.

## Next

- [The shell](shell.md), for editing the controller layout
- [Streaming](streaming.md)
