# Releasing

A release is one self-extracting file, `releases/lwfa-<version>.run`, holding
the engine, the built shell, the FFmpeg libraries the engine links, the deploy
templates and the installer.

## Cutting one

```sh
scripts/package-portable.sh          # build and package, in a container
gh release create v1.0.6 releases/lwfa-1.0.6.run
```

Version numbers come from the manifests, so bump those first. There are seven:
three `crates/*/Cargo.toml` and four `package.json`. `Cargo.lock` records the
three workspace members and needs refreshing with them; `pnpm-lock.yaml` does
not record an importer's own version and is untouched.

## If a download in the image build dies

Docker's bridge is 1500 bytes whatever the host can actually carry. Behind a
VPN the way out is smaller, so a container sends full-size segments the tunnel
cannot pass, and whether they arrive depends on the far end noticing and
backing off. A CDN does. A single small web server may not, and then its
packets disappear rather than erroring:

```
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to ffmpeg.org:443
```

That reads like an outage and is not one. It cost a release: apt and GitHub
were fine in the same build while ffmpeg.org's TLS handshake got zero bytes
back, and the same fetch over a bridge at the tunnel's MTU worked first time.

Two fixes, because the image build and the packaging step need different ones.

**Packaging** runs under `docker run`, which takes a named network, so
`package-portable.sh` measures the MTU of the interface traffic actually leaves
by and uses a bridge that matches. Note it asks `ip route get` rather than
reading the default route: a VPN usually leaves the default alone and adds
`0.0.0.0/1` and `128.0.0.0/1` over the top, so the default route names the
physical NIC and measures 1500 while nothing goes that way.

**The image build** cannot do that. BuildKit rejects a named network outright,
and a `docker-container` builder attached to one still fails, because it nests
its own bridge under the MTU it advertises: the RUN step prints 1350 and the
fetch dies anyway. So the Dockerfile fetches FFmpeg from GitHub, which is
behind a CDN that copes, and falls back to ffmpeg.org. Same tree either way,
since the release tarball is made from the tag.

Setting `"mtu"` in `/etc/docker/daemon.json` and restarting the daemon is the
machine-wide version, and the only single fix that covers both.

## Why it builds in a container

`scripts/package.sh` on its own produces a binary that runs on the machine that
built it and very little else. Every bundled library requires symbols from the
glibc it was compiled against, and glibc is resolved by the host's loader,
where symbol versions are a floor rather than a preference. Building on a
rolling distribution gives you something that fails on Debian stable before any
of lwfa's own error handling runs:

```
libm.so.6: version `GLIBC_2.43' not found (required by libavcodec.so.62)
```

No packaging trick fixes that. The compatibility runs one way, so the answer is
to build against an old glibc: `deploy/build/Dockerfile` is Debian 11, glibc
2.31, which covers Debian 11+, Ubuntu 20.04+, Fedora 32+, RHEL 9+ and every
rolling distribution.

The packaging step runs inside the container as well, because the libraries to
bundle have to be that container's. Collecting them on the host would put the
original problem straight back.

FFmpeg is built from source in the image rather than installed, because
`ffmpeg-next` needs FFmpeg 8 headers and no old distribution ships them. It is
configured with `--disable-everything` plus only what lwfa asks for, which is
why the artifact is a few megabytes instead of eighty: a distribution's FFmpeg
links every encoder it was configured with, and lwfa calls two of them.

`--enable-nvenc` needs only `nv-codec-headers`, not the CUDA toolkit, since
FFmpeg opens `libcuda` from the driver at run time. The build machine needs no
NVIDIA hardware, which is what makes this runnable in CI.

## What is not bundled, and why

The graphics stack. A bundled libEGL or libdrm cannot talk to the target's
kernel modules, so those have to be the host's, along with glibc, libstdc++ and
libgcc, which must match the loader running the process.

That costs less than it sounds. The libraries that most need to come from the
host are opened by name at run time rather than linked, so `libwayland-client`,
`libEGL` and `libcuda` never appear in the dependency closure at all. In
practice `libdrm` is the only library a machine still needs, and any machine
with working graphics has it.

`scripts/package.sh` holds the exclusion list and the reasoning for each entry.

## Checking one before publishing

The failure modes here are not caught by the test suite, because they are about
the artifact rather than the code. Worth running:

```sh
releases/lwfa-1.0.6.run --extract /tmp/check

# The glibc floor. Should be well under the oldest target.
objdump -T /tmp/check/lwfa-*/libexec/lwfa-engine | grep -oP 'GLIBC_\K[0-9.]+' | sort -V | tail -1

# Nothing unresolved but libdrm, on a distribution that is not this one.
docker run --rm -v /tmp/check/lwfa-1.0.6:/lwfa:ro debian:13 \
  sh -c 'ldd /lwfa/libexec/lwfa-engine | grep "not found"'
```

Then run the `.run` itself, without `--extract`. The two paths differ, and the
default one is what everybody uses.

## Tagging

Annotated, so the tag carries a date, an author and a message, and
`git describe` prefers it:

```sh
git tag -a v1.0.6
git push origin v1.0.6
```

Build the artifact from the tagged tree rather than from whatever is in the
working directory. The payload includes `README.md` and `install.sh`, so an
artifact built a commit early ships documentation that does not match the code
it is packaged with.
