# Host X11 socket replacement during focus testing

Investigated and repaired on 2026-09-08.

## Cause

The optional test in `crates/lwfa-engine/src/xfocus.rs` started Xvfb with
`-displayfd 1` in the host's mount and network namespaces. A separate process
and a dynamically selected display were insufficient isolation.

[X server argument handling](https://raw.githubusercontent.com/mirror/xserver/master/os/utils.c)
sets `nolock` for `-displayfd`.
[Display selection](https://raw.githubusercontent.com/mirror/xserver/master/os/connection.c)
then tries to bind consecutive display numbers.
[Hyprland](https://github.com/hyprwm/Hyprland/blob/main/src/xwayland/Server.cpp)
can use filesystem sockets `X0` and `X0_` without an abstract socket.
In that configuration, the test's Xvfb could claim display 0 and replace `X0`.
Killing Xvfb at test completion left the replacement socket refusing connections.

This was an error in our test setup. The test is excluded from release binaries.
Changing lwfa's rendering, controller handling, or installed version would not
restore the damaged host socket.

## Evidence

- Host and systemd user environments both retained `DISPLAY=:0`.
- Host `xprop -display :0 -root _NET_SUPPORTING_WM_CHECK` failed.
- Host Hyprland and its Xwayland process were still running.
- `X0_` accepted an X11 protocol handshake through that host server.
- lwfa's independent `:1` display accepted connections.
- The dead `X0` timestamp was September 6 at 16:36:19 local time. The saved
  agent transcript records the optional focus-test command at 16:36:19.295.
- In a disposable container with private `/tmp` and networking, the same Xvfb
  binary replaced an existing filesystem-only display-0 socket. The original
  server remained reachable through another link. After the test server exited,
  display 0 failed exactly as on the host. GLX was disabled in the reproducer
  because focus testing does not require GPU initialization.

## Recovery

The repair checked that both socket entries belonged to the current user,
that `X0` refused connections, and that `X0_` completed an X11 handshake with
peer credentials belonging to the host display process. It then atomically
replaced the dead entry with a hard link to the surviving socket, retaining a
rollback link until verification passed.

Both displays passed subsequent handshakes and all four process IDs remained
unchanged: Hyprland, host Xwayland, lwfa-engine, and lwfa Xwayland. Steam was
launched on host display `:0`; its main window and web helpers were observed
there. No compositor or service restart was needed.

This was a repair of the observed live session, not an automatic startup rule.
Do not apply it blindly when socket ownership or connectivity differs.

## Prevention and validation

The optional Rust tests now re-execute themselves through bubblewrap with:

- Private mount, network, PID, user, IPC, and UTS namespaces.
- Fresh `/tmp` and `/run`, a read-only view of the host files, and private
  `/dev` and `/proc` mounts.
- Explicit mounts for the test executable and Xvfb, including binaries built
  in temporary worktrees.
- Checks that mount and network namespaces differ from the caller's.
- A 30-second bound and no unsandboxed fallback if bubblewrap is unavailable.
- GLX disabled, since these are focus tests.

`preserves_existing_x11_server` creates a filesystem-only display 0 inside an
outer sandbox, then runs the actual focus test in its own sandbox. It checks
that the original socket inode, server process, focus, and ability to accept
a fresh X11 connection survive the test.

Both optional tests passed. Missing-bubblewrap and same-namespace checks failed
closed before starting Xvfb. Host Steam and both live X displays remained
reachable after testing.

```sh
LWFA_TEST_XVFB=/path/to/Xvfb cargo test -p lwfa-engine xfocus::tests -- --ignored
```

Bubblewrap is a test dependency only. This fix does not require users to
repackage or upgrade the running engine.
