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
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="lwfa-build:bullseye"

command -v docker >/dev/null || { echo "docker is required for a portable build" >&2; exit 1; }

echo "building the shell on the host"
pnpm run build >/dev/null || { echo "shell build failed" >&2; exit 1; }

echo "building the image (cached after the first time)"
docker build -f deploy/build/Dockerfile -t "$IMAGE" deploy/build >/dev/null \
  || { echo "image build failed" >&2; exit 1; }

echo "building the engine and packaging inside it"
# The cargo registry is shared so a rebuild does not re-download the index.
# The engine goes to /tmp inside the container rather than /src/target, so the
# host's own build is left alone.
docker run --rm \
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
