# Installing lwfa on Linux

lwfa ships as a single self-extracting file that works on any glibc 2.31 or
newer distribution. This page covers the release installer, building from a
checkout, and what the installer writes to your machine.

## From a release

Download the latest from [Releases](https://github.com/ngodn/lwfa/releases):

```sh
chmod +x lwfa-*.run
./lwfa-*.run
```

It asks about the port, the workspace lwfa should take, TLS and autostart, then
prints a link with the password already in it.

To read the contents before running any of it, unpack without installing:

```sh
./lwfa-*.run --extract /tmp/lwfa
```

`--yes` takes every default. `--uninstall` undoes it, and asks separately
before removing the accounts database, since that is the one thing here you
cannot regenerate.

## From a checkout

```sh
pnpm run build && pnpm run engine:release
./install.sh
```

## Which machines the release runs on

Releases are built in a Debian 11 container, so they need **glibc 2.31 or
newer**: Debian 11+, Ubuntu 20.04+, Fedora 32+, RHEL 9+, and every rolling
distribution. Building against an old glibc is the only thing that works,
because glibc is backward compatible in one direction only, and no amount of
bundling changes that.

FFmpeg travels with the binary, so the version your distribution ships does not
matter. The graphics stack deliberately does not: a bundled libEGL or libdrm
cannot talk to your kernel modules, so `libdrm` is the one library you need,
and any machine with working graphics already has it.

`scripts/package-portable.sh` builds a release; `deploy/build/Dockerfile` and
`scripts/package.sh` record what is bundled and why. See
[releasing.md](releasing.md).

## What the installer writes

It looks first and writes second: distribution, host compositor, GPU, Xwayland,
audio, terminal, `/dev/uinput`, and any controller already plugged in. Then it
shows what it is about to write and asks.

| Path | Holds |
|---|---|
| `~/.config/lwfa/config.toml` | only what is specific to this machine |
| `~/.config/lwfa/env` | the generated password, mode 600 |
| `~/.config/systemd/user/lwfa.service` | a user service, not a system one |
| `~/.local/share/lwfa/` | the engine, the shell and the bundled libraries |
| `/etc/udev/rules.d/60-lwfa-uinput.rules` | access to `/dev/uinput`, only if needed |

Nothing else is touched. The config carries only the machine-specific values,
so it does not freeze today's defaults: anything it omits follows the built-in
default and keeps improving across upgrades.

Packages are never installed behind your back. When something is missing it
says so, prints the exact command for the distribution it found, and asks.

## The service

A user service rather than a system one, deliberately. A system unit has no
`XDG_RUNTIME_DIR`, starts before any session exists, and cannot express "after
this user's compositor came up", because the system manager has no
`graphical-session.target`.

```sh
systemctl --user start lwfa
journalctl --user -u lwfa -f
```

## Requirements

For a release, only a working graphics stack and glibc 2.31+. For building from
source, the versions pinned in `.mise.toml` and `rust-toolchain.toml`:

- Rust 1.95.0 (edition 2024)
- Node 24.15.0, pnpm 11

```sh
mise install
pnpm install
```

Hardware and system expectations, all of which degrade rather than fail:

- **NVIDIA + NVENC** for hardware video encoding. This is the only hardware
  encoder supported today; Intel and AMD fall back to JPEG, which works and
  costs bandwidth. VAAPI would cover both and is next on the list. Eight
  concurrent NVENC sessions is the consumer-card limit; the ninth window
  degrades to JPEG.
- **PipeWire or PulseAudio**, with `parec` on the path, for audio capture. No
  audio without it, nothing else affected.
- **`/dev/uinput` access** for the virtual controller. Without it the on-screen
  gamepad still works in keyboard mode, mapping pads to keys.

## Next

- [Running lwfa](running.md), and the keyboard shortcuts
- [Reaching it from another device](remote-access.md), including TLS
