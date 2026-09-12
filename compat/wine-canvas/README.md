# Wine canvas compatibility

This component targets **GE-Proton11-6-x86_64**, with separate patches for Wine's
virtual monitor cache, fullscreen configuration, presentation rectangle and
cursor clipping. It does not replace system Wine or the installed GE runtime.
The source manifest pins the exact upstream revisions, inputs, prepared source
files and original runtime libraries.

The changes are enabled only with both nested-session settings:

```sh
WINE_CANVAS_FOLLOW_HOST=1
WINE_CANVAS_DPI_SAFE=1
```

The registered compatibility tool routes host launches to the verified original
GE installation. Inside lwfa it routes to a private copy containing the patched
components. This applies to Proton and the Wine/wineserver entry points used by
helper launchers. A host launch never uses the rebuilt libraries merely with the
flags disabled.

## Build the components

The builder requires Python 3.12+, Bash, GCC with 32-bit support, make, patch,
autoconf, bison, flex, pkg-config, readelf, nm and Wine's matching 32/64-bit
X11/font development libraries. Vulkan generation also needs the Python modules
used by the pinned GE generator. Missing requirements appear in the retained
configure/build logs. The builder does not install system packages.

```sh
python3 compat/wine-canvas/build.py \
  --base "$HOME/.local/share/Steam/compatibilitytools.d/GE-Proton11-6-x86_64" \
  --work target/wine-canvas-build \
  --output target/wine-canvas-artifact
```

Both output directories must be new. An optional `--cache` directory can hold
the pinned source archives. `--prepare-only` checks the complete preparation and
source hashes without compiling. On a distro with a different 32-bit pkg-config
layout, set `LWFA_WINE_PKG_CONFIG_LIBDIR32` to that layout. A private development
library directory can be passed with `--lib32-dir /absolute/path`. Both builds
require XInput2, libXi and XRender; a missing input library must fail the build
instead of creating a driver that can loop while attempting fullscreen clipping.
The runtime environment must also provide these matching architecture libraries.

The builder verifies the original GE files, prepares exact upstream sources,
checks 151 prepared source/header hashes, applies patches without fuzz, builds
both Unix architectures and wineserver, and checks Unix export names against
the original libraries. Matching exports verifies that interface only, not optional
library feature parity. Both configure feature inventories are retained. PE DLLs, Wine loaders and the original runtime remain
unchanged. The output contains `payload/` and a generated `manifest.json` for
registration and packaging, plus the pinned source manifest, patches, preparation
script and build recipe. No Wine prefix or live service is touched.

GE's preparation sequence has six known rejected patches in unrelated modules.
The sanitized preparer records those exact paths and rejects any other failure.
No rejected hunk affects the replacement components or server protocol. The
prepared source hashes provide an additional check before our patches apply.

The direct `build.py` recipe builds for the current host. Its manifest says
`kind: host` and `portable: false`; that artifact is for local packaging.

## Build for distribution

Use the SDK wrapper for release artifacts:

```sh
python3 compat/wine-canvas/build-sdk.py \
  --base "$HOME/.local/share/Steam/compatibilitytools.d/GE-Proton11-6-x86_64" \
  --work target/wine-canvas-sdk-build \
  --output target/wine-canvas-sdk-artifact
```

Docker downloads the exact Steam Runtime 4 SDK pinned by GE-Proton11-6. The
immutable image digest is recorded in `sdk.json`; the initial compressed download
is about 2.34 GB. This build uses the SDK's matching 32-bit and 64-bit development
libraries, and does not install packages on the host. The original GE directory
is mounted read-only, and build files are owned by the invoking user.

Only a build executed inside that pinned SDK produces `kind: steam-runtime-sdk`
and `portable: true`. The artifact records the image digest, image ID, SDK release,
compiler version and configure inventories, and rejects a GLIBC requirement above
the original GE components. It targets GE's Steam Runtime environment, not an
arbitrary standalone Wine environment. Run the same rendering, input, mode and
host-routing tests on the resulting payload before publishing it.

Publish the matching prepared Wine source archive beside the installer:

```sh
python3 compat/wine-canvas/export-source.py \
  --work target/wine-canvas-sdk-build \
  --artifact target/wine-canvas-sdk-artifact \
  --output releases/lwfa-1.5.5-wine-source.tar.gz
```

The archive includes the prepared source, recipe, patches and license. Its file
index hashes every regular file and records symlinks; `source-archive.json` in
the artifact records both the archive hash and that index hash.

Staging's Git patch application is isolated from the surrounding checkout. Without
that isolation, building below another Git repository can silently skip staging
patches. Prepared source hashes catch the difference before compilation.

## Package and register

For a local package:

```sh
LWFA_WINE_CANVAS_ARTIFACT="$(pwd)/target/wine-canvas-artifact" \
  scripts/package.sh
```

`--no-build` is supported by the package script when the engine and shell are
already built. The portable packaging path requires both architectures and an
artifact marked `kind: steam-runtime-sdk`, `portable: true`.

Installation registers the separate **lwfa GE-Proton 11-6 (Canvas)** Steam
compatibility tool (`lwfa-GE-Proton11-6-x86_64-canvas` directory). Restart Steam to discover it, then select that tool for the
games that should use it. Installation does not edit Steam's per-game choices.
The original GE tool remains available and is used by this tool for host launches.

### Install without a separate GE installation

The manager can assemble a self-contained tool from the exact reviewed original
archive and the packaged patch artifact:

```sh
python3 manage.py install --bundle artifact --steam-root "$HOME/.local/share/Steam" --download-base
```

For an offline installation, replace `--download-base` with
`--base-archive /path/to/GE-Proton11-6-x86_64.tar.gz`. Both paths check the pinned
archive size and SHA-256. Download URLs are built into the manager, not accepted
from callers. `--cache /path` selects the download cache.

Each managed tool keeps its original GE tree in `.original/` and its patched
tree in `.runtime/`. Host launches use that original snapshot; existing external
GE tools are untouched. The tool name includes a fingerprint of the archive,
patch artifact and launcher. Reinstalling the same verified artifact reuses it;
a changed artifact registers beside the previous version. The installer never
switches Steam's per-game selection or restarts Steam.

The old install command without either archive option retains external-GE
routing for compatibility with existing installations. No legacy registration
is migrated or replaced automatically. Source distribution requirements still
apply to a full offline bundle; the existing prepared Wine source archive does
not cover every component of GE's complete runtime.

`status --steam-root PATH --json` returns a `tools` array with the tool `path`,
`name`, `baseTool`, `selfContained` and `activePids`. Install supports `--json`
with `path` and `name`; remove supports it with `removed`. Errors go to stderr
with a nonzero exit status. Status does not verify all runtime files; installation
and nested launch perform the manifest checks.

Removal refuses tools observed in use through executable, command-line or
mapped-library paths. This is a process snapshot, not an exclusion lock shared
with arbitrary Wine launches. Stop using a tool before removing it. Non-dumpable
unrelated user services may hide their memory maps, so status is not a complete
inventory of every process on the machine.

A registered tool keeps its own artifact/runtime snapshot and survives lwfa
uninstallation. Before replacing that snapshot, close applications using it,
remove its registration with `manage.py remove --tool ...`, then register the
new artifact. Do not combine a running prefix/server from one runtime with a
second runtime. Host and nested launches sharing an already-running Wine
session also share that session's display state.

## Existing Wine sessions and Protontricks

The dedicated tool checks the selected prefix's active wineserver before
launching either runtime. If another runtime already owns that prefix, it stops
with an error identifying the prefix and process. Close the game's applications
and Protontricks instances, wait for their server to exit, then launch again.
The check does not stop processes, alter prefixes or change the original GE tool.

Wine identifies a Linux server by the prefix directory's device and inode,
using `/tmp/.wine-UID/server-DEV-INODE/lock`. The launcher queries that existing
lock with `F_GETLK` and compares the owner's executable to the selected server.
It does not connect to the Wine socket. This is a startup check, not a lock
shared with all Wine installations: another unwrapped Wine process can still
start between the check and launch. Do not launch the same prefix concurrently
through different runtimes. Direct launches outside this tool are not guarded.
See Wine's [server lock implementation](https://github.com/wine-mirror/wine/blob/master/server/request.c)
and [client server-directory calculation](https://github.com/wine-mirror/wine/blob/master/dlls/ntdll/unix/server.c).

Protontricks executes `files/bin/wine` and `files/bin/wineserver` directly.
These front doors are native ELF launchers so Winetricks can inspect their
architecture. Routing also translates Protontricks' runtime and library path
environment variables, while preserving application arguments exactly.
The original GE runtime is used on the host, including when patched files are
missing or no longer match an updated GE installation. The private runtime is
selected only when both `WINE_CANVAS_FOLLOW_HOST=1` and `WINE_CANVAS_DPI_SAFE=1`
are present. Steam discovery and game selection remain explicit user actions.

## Validation

The investigation uses disposable prefixes and isolated compositor instances.
The checks cover native and retained DXVK buffers, physical and virtual monitor
sizes, Win32 client sizes, visible corner pixels, edge input, DPI transitions,
explicit lower modes and multiple Wine processes. Passing the passive DPI probe
alone is insufficient: the investigation found separate presentation, origin
and cursor-clip failures after that probe passed.

The earlier GE11-5 candidates and logs remain under ignored `target/` paths for
comparison. Current GE11-6 runtime results and any remaining limitations belong
in `docs/research/canvas-sizing-upstream.md`. This README does not claim an
untested portable build or every Proton version is supported.

Upstream source:
[GE-Proton11-6](https://github.com/GloriousEggroll/proton-ge-custom/tree/GE-Proton11-6),
[Wine revision](https://github.com/ValveSoftware/wine/tree/9358696fe9a2261329f4a83aa6a65fd436106154),
[Wine staging revision](https://github.com/wine-staging/wine-staging/tree/6cc805ea57132eeaf44764e9213823c9b8d0d300).
The patches retain Wine's existing LGPL licensing; distribute the matching
source and build instructions alongside distributed replacement components.
