# Configuring lwfa

Settings live in [`configs/defaults.toml`](../configs/defaults.toml): ports, the
terminal, Xwayland, encoder limits, render timings, layout defaults, the shared
animation spring, audio capture, the persistent gamepad, whether the desktop
outside shares the clipboard, and which workspace lwfa's own window should take
in a host compositor. It is commented, and it is the place to look before going
hunting for a constant.

## Precedence

Highest first: environment variables, then `.env` (gitignored, machine-local,
holds `AUTH_PASS`), then a config file, then built-ins.

Loading never fails. A missing or broken file falls back to defaults with a
warning, because a compositor you cannot start is a compositor you cannot fix
from inside. Unknown keys *are* rejected, so a typo is reported rather than
silently ignored.

The config file is looked for in four places, highest first:

| Where | For |
|---|---|
| `$LWFA_CONFIG` | an explicit answer, and a bad one is reported |
| `~/.config/lwfa/config.toml` | your own settings, and what an installer writes |
| `configs/defaults.toml` above the binary | a development checkout |
| `/etc/lwfa/config.toml` | machine-wide, overridable per user |

`$XDG_CONFIG_HOME` is honoured where set. The engine logs which file it used, so
a setting that appears to be ignored is one line away from an explanation.

Files do **not** merge. The first one found is the config, and every key it
omits falls through to the built-in default rather than to the file below it.
That keeps precedence to one rule instead of two, and it means a minimal
`config.toml` holding only what is specific to your machine is the right thing
to write.

The shell cannot read the file, since it runs in a browser, so
`scripts/gen-config.mjs` generates its layout and animation defaults from the
same source. That runs automatically from `dev`, `build`, `test` and
`typecheck`.

## Environment variables

- `LWFA_CONFIG`: path to a config file, overriding every other location
- `LWFA_TERMINAL`: which terminal to spawn (default `alacritty`, falling back to
  any of foot, kitty, ghostty, wezterm, gnome-terminal, konsole, xfce4-terminal
  or xterm that is actually installed)
- `LWFA_NO_AUTOSTART`: set to skip opening a terminal on launch
- `LWFA_NO_XWAYLAND`: set to skip starting Xwayland, so X11 clients cannot run
- `LWFA_NO_PREVIEW`: set to stop presenting to the nested host window. Do this
  when the window is parked on a hidden workspace and the session is only used
  remotely; presenting to a window the host never shows can block the engine
  (see `[window] preview` in the config for the full story)
- `LWFA_SHELL_ADDR`: where the engine listens, for both the page and the
  protocol (default `127.0.0.1:6733`; use `0.0.0.0:6733` to reach it from other
  devices). During development Vite serves the page on 6733, so the engine moves
  to `127.0.0.1:6734` and Vite proxies `/engine` back to it
- `LWFA_SHELL_DIR`: where the built shell is, when it is not in one of the usual
  places (`packages/shell/dist` above the binary, `share/lwfa/shell` beside it,
  or the system prefixes)
- `SHELL_PORT`: port for Vite's dev server (default `6733`)
- `AUTH_PASS`: the shared password. Read from `.env` if not in the environment. A
  temporary one is generated if neither is set, which breaks bookmarked URLs
- `LWFA_PROFILE`: log per-window capture timings
- `LWFA_HEARTBEAT`: log redraws and ticks per second, once a second. `0 redraws`
  with a healthy tick count is a hidden window behaving correctly; both at zero
  means the event loop has stopped
- `RUST_LOG=debug`: Smithay is chatty at `info`; `warn` is usually the useful
  level

## Next

- [Reaching it from another device](remote-access.md)
- [Accounts and permissions](accounts.md)
