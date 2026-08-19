# Running lwfa

lwfa runs nested inside whatever compositor you are already using, as an
ordinary window. Starting it cannot take down the session you were working in.

```sh
pnpm run build                # the shell, once
cargo run -p lwfa-engine      # serves it, and the protocol, on 6733
```

For development you want Vite instead, for hot reload. It takes 6733 and
proxies `/engine` back to the engine, so the engine moves up one:

```sh
scripts/dev-nested.sh                              # sets this up for you
pnpm --filter @lwfa/shell dev                      # http://localhost:6733

# or by hand:
LWFA_SHELL_ADDR=127.0.0.1:6734 cargo run -p lwfa-engine
```

## A release build

```sh
pnpm run build             # the shell, into packages/shell/dist
pnpm run engine:release    # the engine, optimised (fat LTO)
./target/release/lwfa-engine   # serves both, on one port
```

To package that into an installable file instead, see
[releasing.md](releasing.md).

## Safe mode

Until a shell connects, the engine runs in **safe mode**: focused window
full-screen, and that is all. Safe mode is deliberately not a layout engine, so
that layout policy exists in exactly one place. See
`crates/lwfa-engine/src/layout.rs`.

## Keyboard shortcuts

| Bind | Handled by | Action |
|---|---|---|
| `Alt+Return` | engine | spawn a terminal |
| `Alt+Q` | engine | quit |
| `Alt+H` / `Alt+Left` | shell | focus the column to the left |
| `Alt+L` / `Alt+Right` | shell | focus the column to the right |
| `Alt+K` / `Alt+Up` | shell | focus up within a column's stack |
| `Alt+J` / `Alt+Down` | shell | focus down within a column's stack |
| `Alt+Shift+H` | shell | consume: pull this window into the column on its left |
| `Alt+Shift+L` | shell | expel: push this window out into its own column |
| `Alt+Shift+K` / `Alt+Shift+J` | shell | move this window to the workspace above/below |
| `Alt+1` … `Alt+3` | shell | jump to a workspace |
| `Alt+4` | shell | cycle the focused column's width (⅓, ½, ⅔, 90%) |
| `Alt+F` | shell | toggle fullscreen for the focused window |
| `Alt+W` | shell | close the focused window |

Alt rather than Super, because the host compositor sees keys first and usually
has Super bound. All of the above is layout policy, so the engine forwards
those keys to the shell rather than acting on them itself.

## Scrollable tiling

Layout follows [niri](https://github.com/niri-wm/niri): windows live in columns
on an infinite strip, a column can hold a vertical stack, and workspaces stack
vertically. The strip runs along the viewport's long axis, so it is a row of
columns on a monitor and a stack of rows on a phone held upright.

Workspaces need no protocol support at all, because `SetLayout` is total: the
shell omits the windows on other workspaces and the engine hides whatever it is
not told about.

## Next

- [Configuration](configuration.md): the config file, and every environment
  variable
- [Reaching it from another device](remote-access.md)
- [The shell](shell.md): the navigation rail, on-screen input, audio, clipboard
