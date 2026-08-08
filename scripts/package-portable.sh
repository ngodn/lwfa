#!/usr/bin/env bash
# Build a release that runs on more than the distribution it was built on.
#
#   scripts/package-portable.sh
#
# # The problem this solves
#
# A binary built on Arch requires Arch's glibc, and so does every library
# bundled beside it. On Debian 13 that is:
#
#   libm.so.6: version `GLIBC_2.43' not found (required by libavcodec.so.62)
#
# glibc is resolved by the host's loader and its symbol versions are a floor,
# not a preference, so no amount of bundling helps. What does help is building
# against an old glibc, because glibc is backward compatible: something built
# against 2.31 runs on 2.39, never the other way round.
#
# So the engine is compiled inside deploy/build/Dockerfile, on Debian 11, whose
# glibc is 2.31. That covers Debian 11+, Ubuntu 20.04+, Fedora 32+, RHEL 9+ and
# every rolling distribution.
#
# # Why the packaging step runs in there too
#
# Because the libraries to bundle have to be *that* container's, resolved by
# that container's loader. Collecting them on the host would gather Arch's
# copies and put the original problem straight back.
#
# # What is built outside
#
# The shell. It is a static bundle of HTML, JavaScript and CSS, and none of
# that depends on glibc, so it is built on the host with the toolchain that is
# already set up and copied in.
#
# # Why the build gets a network of its own
#
# Docker's bridge is 1500 bytes whatever the host can actually carry. Behind a
# VPN the route out is smaller (ExpressVPN's tun0 is 1350 here), so a container
# emits full-size segments that the tunnel cannot pass, and whether they get
# through depends on the far end noticing and shrinking. A CDN does; a single
# small web server may not, and then its packets vanish rather than erroring.
#
# That failed a release: apt and GitHub were fine while ffmpeg.org's TLS
# handshake got zero bytes back, which reads like an outage and is not one. The
# same fetch over a bridge at the tunnel's MTU succeeds.
#
# So the MTU of whatever carries the default route is measured, and if it is
# below 1500 the build runs on a bridge that matches. A machine with no tunnel
# measures 1500 and nothing changes. Setting `"mtu"` in /etc/docker/daemon.json
# is the machine-wide version of this, if you would rather fix it once.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="lwfa-build:bullseye"

command -v docker >/dev/null || { echo "docker is required for a portable build" >&2; exit 1; }

# The MTU of the interface traffic to the internet actually leaves by, or
# nothing if it cannot be worked out, in which case the build proceeds on
# Docker's own default and behaves exactly as it did before this existed.
#
# `ip route get` rather than `ip route show default`, which lies here. A VPN
# does not usually replace the default route; it adds 0.0.0.0/1 and
# 128.0.0.0/1 over the top, which are more specific and so win, leaving the
# real default pointing at the physical NIC. Reading that one measures 1500
# while every packet goes out over a 1350-byte tunnel. Asking for a route to a
# concrete address resolves the same way the kernel will; nothing is sent.
route_mtu() {
  command -v ip >/dev/null || return 1
  local dev
  dev=$(ip route get 1.1.1.1 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
  [ -n "$dev" ] || return 1
  cat "/sys/class/net/$dev/mtu" 2>/dev/null
}

NET_ARGS=()
MTU="$(route_mtu)"
if [ -n "$MTU" ] && [ "$MTU" -lt 1500 ] 2>/dev/null; then
  NET="lwfa-build-mtu$MTU"
  if ! docker network inspect "$NET" >/dev/null 2>&1; then
    docker network create --opt com.docker.network.driver.mtu="$MTU" "$NET" >/dev/null \
      || { echo "could not create a ${MTU}-byte docker network" >&2; exit 1; }
  fi
  NET_ARGS=(--network "$NET")
  echo "the route out carries $MTU bytes, so the build runs on a matching network"
fi

echo "building the shell on the host"
pnpm run build >/dev/null || { echo "shell build failed" >&2; exit 1; }

echo "building the image (cached after the first time)"
docker build "${NET_ARGS[@]}" -f deploy/build/Dockerfile -t "$IMAGE" deploy/build >/dev/null \
  || { echo "image build failed" >&2; exit 1; }

echo "building the engine and packaging inside it"
# The cargo registry is shared so a rebuild does not re-download the index.
# The engine goes to /tmp inside the container rather than /src/target, so the
# host's own build is left alone.
docker run --rm "${NET_ARGS[@]}" \
  -v "$ROOT:/src" \
  -v "$HOME/.cargo/registry:/root/.cargo/registry" \
  "$IMAGE" \
  sh -c '
    set -e
    cd /src
    cargo build -p lwfa-engine --release --target-dir /tmp/tgt
    LWFA_ENGINE=/tmp/tgt/release/lwfa-engine scripts/package.sh --no-build
  ' || { echo "portable build failed" >&2; exit 1; }

echo ""
echo "The .run in releases/ is now the portable one."
echo "Check what it needs with:"
echo "  objdump -T <extracted>/libexec/lwfa-engine | grep GLIBC_ | sort -u | tail -1"
