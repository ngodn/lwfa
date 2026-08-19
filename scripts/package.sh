#!/usr/bin/env bash
# Build a self-extracting lwfa installer: releases/lwfa-<version>.run
#
#   scripts/package.sh            # build everything, then package
#   scripts/package.sh --no-build # package what is already built
#
# # Why a .run and not an AppImage
#
# Because the installer is inherently interactive. It asks about the port, the
# workspace, TLS, autostart and a password, and an AppImage has no install-time
# hook to ask any of that from. A self-extracting archive is a shell script
# with a tarball stapled to the end: it unpacks, then runs install.sh, which is
# exactly the shape needed.
#
# # Why libraries are bundled at all
#
# `ffmpeg-next` links the system FFmpeg, so the binary needs libavcodec.so.63
# and friends. That soname is current on Arch and wrong nearly everywhere
# else: Debian stable, Ubuntu LTS and Fedora all ship different majors. A
# binary built here and copied there fails at load with a message about a
# missing library, before any of lwfa's own error handling runs.
#
# So the FFmpeg family and its dependency closure travel with the binary.
#
# # Why not *all* of them
#
# Because some libraries must be the host's or nothing works. The graphics
# driver is the obvious one: a bundled libEGL cannot talk to the kernel module
# on the target machine. The same goes for libdrm, libva and libcuda. glibc,
# libstdc++ and libgcc are excluded for the opposite reason: they are older on
# the build machine than the target as often as not, and mixing them with the
# host's loader is how "symbol not found" happens.
#
# Happily, the libraries that most need to come from the host are already not
# our problem: libwayland-client, libEGL and libcuda are all opened at runtime
# by name rather than linked, so they never appear in the closure. That is what
# makes bundling the rest safe.
#
# # What bundling does NOT solve, and this is the important part
#
# glibc. Every bundled library still *requires* symbols from the glibc it was
# compiled against, and that requirement travels with it. Building here and
# running on Debian 13 gives, verified in a container:
#
#   libm.so.6: version `GLIBC_2.43' not found (required by libavcodec.so.62)
#
# There is no bundling trick that fixes this. The only real answer is to build
# against the oldest glibc you intend to support, which means building in a
# container based on an older distribution, not on this machine.
#
# So: **this .run targets the distribution it was built on and others with a
# glibc at least as new.** Built on Arch, it runs on Arch and on other rolling
# distributions; it does not run on Debian stable or Ubuntu LTS. Those need to
# build from source, which is documented, or wait for a build made in an older
# container.
#
# That is a real limit and it is stated rather than papered over, because the
# failure mode otherwise is a download that dies at exec with a message about
# libm, which tells the user nothing about what to do next.
#
# Verified in a clean archlinux:base container with only libva, libx11,
# libxext, libdrm and ocl-icd added: zero unresolved libraries, and the binary
# runs to the expected "no Wayland socket" failure rather than a loader error.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' crates/lwfa-engine/Cargo.toml | head -1)"
[ -n "$VERSION" ] || { echo "could not read the version from Cargo.toml" >&2; exit 1; }

STAGE="$ROOT/target/package/lwfa-$VERSION"
OUT="$ROOT/releases/lwfa-$VERSION.run"

# Libraries that must come from the machine lwfa runs on, not this one.
#
# Two reasons, and they pull in opposite directions:
#
#   - Driver-coupled. A bundled libEGL or libdrm cannot talk to the target's
#     kernel modules. These have to be the host's.
#   - Core runtime. glibc, libstdc++ and libgcc must match the loader that is
#     actually running the process, which is the host's.
#
# Everything else is fair game, and the FFmpeg family is the reason any of this
# exists.
EXCLUDE='^(ld-linux.*|libc|libm|libdl|libpthread|librt|libresolv|libutil|libnsl|libanl|libstdc\+\+|libgcc_s|libGL|libGLX|libGLdispatch|libOpenGL|libGLESv2|libEGL|libdrm|libgbm|libva|libva-drm|libva-x11|libva-glx|libOpenCL|libcuda|libnvidia.*|libnvcuvid|libsystemd|libudev|libdbus-1|libwayland.*|libX11|libX11-xcb|libxcb|libxcb-.*|libXau|libXdmcp|libXext|libXfixes|libxshmfence)$'

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  say "building the shell"
  pnpm run build >/dev/null || { echo "shell build failed" >&2; exit 1; }
  say "building the engine (release, fat LTO, this takes a minute)"
  cargo build -p lwfa-engine --release || { echo "engine build failed" >&2; exit 1; }
fi

# LWFA_ENGINE lets the portable build point at a binary compiled elsewhere,
# without writing over the host's own target directory. See
# scripts/package-portable.sh.
ENGINE="${LWFA_ENGINE:-$ROOT/target/release/lwfa-engine}"
DIST="$ROOT/packages/shell/dist"
[ -x "$ENGINE" ] || { echo "no $ENGINE; run without --no-build" >&2; exit 1; }
[ -f "$DIST/index.html" ] || { echo "no built shell at $DIST" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/share/lwfa/shell" "$STAGE/deploy"

mkdir -p "$STAGE/libexec"
cp "$ENGINE" "$STAGE/libexec/lwfa-engine"
cp -r "$DIST/." "$STAGE/share/lwfa/shell/"
cp "$ROOT/install.sh" "$STAGE/install.sh"
cp "$ROOT/configs/defaults.toml" "$STAGE/share/lwfa/defaults.toml"
cp -r "$ROOT/deploy/." "$STAGE/deploy/" 2>/dev/null
rm -rf "$STAGE/deploy/local" "$STAGE/deploy/docker/certs"
cp "$ROOT/README.md" "$STAGE/README.md" 2>/dev/null
cp "$ROOT/LICENSE" "$STAGE/LICENSE" 2>/dev/null

say "collecting libraries"
COPIED=0
SKIPPED=0
while read -r lib; do
  [ -f "$lib" ] || continue
  base="$(basename "$lib")"
  # Match on the soname without its version, so libavcodec.so.62 is tested as
  # "libavcodec" and the exclude list stays readable.
  stem="${base%%.so*}"
  if printf '%s' "$stem" | grep -qE "$EXCLUDE"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  cp -L "$lib" "$STAGE/lib/$base" 2>/dev/null && COPIED=$((COPIED + 1))
done < <(ldd "$ENGINE" | grep -oP '=> \K[^ ]+' | sort -u)
say "  bundled $COPIED, left $SKIPPED to the host"

# Point the binary at the bundled libraries, relative to itself.
#
# $ORIGIN is resolved by the loader at run time, so the bundle works from
# wherever it is unpacked without a wrapper and without LD_LIBRARY_PATH.
#
# RPATH rather than a launcher script on purpose: whatever path the installer
# records in the systemd unit gets executed directly, and a binary that only
# works when invoked through a wrapper is a trap for exactly that case.
#
# RUNPATH (the default) would apply only to this binary's own direct
# dependencies and not to what *those* load in turn, which is how a bundle
# half-resolves and fails deep inside FFmpeg. --force-rpath makes it
# inheritable.
if command -v patchelf >/dev/null 2>&1; then
  patchelf --force-rpath --set-rpath '$ORIGIN/../lib' "$STAGE/libexec/lwfa-engine"
  # The bundled libraries need it too, for the same reason: libavcodec loading
  # libx264 must find the bundled one rather than the host's.
  for lib in "$STAGE"/lib/*.so*; do
    [ -f "$lib" ] && patchelf --force-rpath --set-rpath '$ORIGIN' "$lib" 2>/dev/null
  done
  say "  set RPATH to \$ORIGIN/../lib"
else
  echo "patchelf not found; install it, or the bundle will only work through a wrapper" >&2
  exit 1
fi

# A thin front door, so `bin/lwfa-engine` exists where people look for it.
ln -sf ../libexec/lwfa-engine "$STAGE/bin/lwfa-engine"
chmod +x "$STAGE/libexec/lwfa-engine" "$STAGE/install.sh"

# install.sh looks for the engine beside itself, so give it one.
ln -sf libexec/lwfa-engine "$STAGE/lwfa-engine"

SIZE="$(du -sh "$STAGE" | cut -f1)"
say "  staged $SIZE at $STAGE"

# ---------------------------------------------------------------------------
# Wrap
# ---------------------------------------------------------------------------
# A .run is a shell script with a compressed tarball appended. The header finds
# where the payload starts by counting its own lines, which is why the marker
# below must stay the last line of the script half.
mkdir -p "$ROOT/releases"
PAYLOAD="$ROOT/target/package/payload.tar.gz"
tar czf "$PAYLOAD" -C "$(dirname "$STAGE")" "$(basename "$STAGE")"

cat > "$OUT" <<'HEADER'
#!/usr/bin/env bash
# lwfa, self-extracting installer.
#
#   ./lwfa-x.y.z.run              # unpack to a temporary directory and install
#   ./lwfa-x.y.z.run --extract D  # unpack to D and stop, so you can read it first
#   ./lwfa-x.y.z.run --help       # this
#
# Everything after the __PAYLOAD__ marker is a gzipped tar archive. Nothing is
# run as root: the installer asks for privilege only for the one udev rule, and
# only through pkexec, where you see the prompt.
set -uo pipefail

TARGET=""
PASSTHROUGH=()
while [ $# -gt 0 ]; do
  case "$1" in
    --extract) TARGET="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

# The payload starts on the line after the marker.
SKIP=$(awk '/^__PAYLOAD__$/ { print NR + 1; exit 0 }' "$0")
if [ -z "$SKIP" ]; then
  echo "this archive is corrupt: no payload marker" >&2
  exit 1
fi

if [ -n "$TARGET" ]; then
  mkdir -p "$TARGET" || exit 1
  tail -n +"$SKIP" "$0" | tar xz -C "$TARGET" || exit 1
  echo "extracted to $TARGET"
  echo "run the installer with: $TARGET/lwfa-*/install.sh"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lwfa-unpack-XXXXXX")" || exit 1
# Left behind on failure would be a surprise; removed on success is expected.
trap 'rm -rf "$WORK"' EXIT
tail -n +"$SKIP" "$0" | tar xz -C "$WORK" || exit 1

# -mindepth 1 matters: the temporary directory is itself named lwfa-XXXXXX, so
# without it find returns the start directory and the payload is never entered.
DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'lwfa-*' | head -1)"
if [ -z "$DIR" ]; then
  echo "this archive is corrupt: no payload directory" >&2
  exit 1
fi

echo "Unpacked to $DIR"
echo "The files are removed when this finishes; use --extract to keep them."
echo ""
exec "$DIR/install.sh" ${PASSTHROUGH+"${PASSTHROUGH[@]}"}
__PAYLOAD__
HEADER

cat "$PAYLOAD" >> "$OUT"
chmod +x "$OUT"
rm -f "$PAYLOAD"

say ""
say "wrote $OUT ($(du -h "$OUT" | cut -f1))"
say "check it with: $OUT --extract /tmp/lwfa-check"
