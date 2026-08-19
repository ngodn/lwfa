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

## Next

- [The shell](shell.md), for editing the controller layout
- [Streaming](streaming.md)
