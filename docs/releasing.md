# Releasing

A release is one self-extracting file, `releases/lwfa-<version>.run`, holding
the engine, the built shell, the FFmpeg libraries the engine links, the deploy
templates and the installer.

## Cutting one

```sh
scripts/package-portable.sh          # build and package, in a container
gh release create v1.0.3 releases/lwfa-1.0.3.run
```

Version numbers come from the manifests, so bump those first. There are seven:
three `crates/*/Cargo.toml` and four `package.json`. `Cargo.lock` records the
three workspace members and needs refreshing with them; `pnpm-lock.yaml` does
not record an importer's own version and is untouched.

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
releases/lwfa-1.0.3.run --extract /tmp/check

# The glibc floor. Should be well under the oldest target.
objdump -T /tmp/check/lwfa-*/libexec/lwfa-engine | grep -oP 'GLIBC_\K[0-9.]+' | sort -V | tail -1

# Nothing unresolved but libdrm, on a distribution that is not this one.
docker run --rm -v /tmp/check/lwfa-1.0.3:/lwfa:ro debian:13 \
  sh -c 'ldd /lwfa/libexec/lwfa-engine | grep "not found"'
```

Then run the `.run` itself, without `--extract`. The two paths differ, and the
default one is what everybody uses.

## Tagging

Annotated, so the tag carries a date, an author and a message, and
`git describe` prefers it:

```sh
git tag -a v1.0.3
git push origin v1.0.3
```

Build the artifact from the tagged tree rather than from whatever is in the
working directory. The payload includes `README.md` and `install.sh`, so an
artifact built a commit early ships documentation that does not match the code
it is packaged with.
