//! Giving a spawned process its signals back.
//!
//! # Why this is needed
//!
//! The engine watches for `SIGTERM` and `SIGINT` through a `signalfd`, so it
//! can shut down as an ordinary loop event rather than being stopped where it
//! stands. See `init_signals` in `main.rs`. The price of a `signalfd` is that
//! the signals it reads have to be *blocked* process-wide, or the default
//! disposition takes them first.
//!
//! `execve` resets handlers but **keeps the signal mask**. So every process the
//! engine starts inherited a mask with `SIGTERM` and `SIGINT` blocked, and
//! carried it for its whole life. Measured on a running session: Xwayland,
//! the private `dbus-daemon`, `xdg-desktop-portal`, the terminal and every
//! application launched from the shell all had `SigBlk: 0000000000004002`.
//!
//! What that broke is not subtle:
//!
//! * Quitting an application did nothing. The engine sent `SIGTERM`, logged
//!   that it had, and the application ignored it, because a blocked signal is
//!   held pending rather than delivered. Steam was the case that showed it:
//!   asked to quit, it stayed, went on holding `~/.steam/steam.pipe`, and went
//!   on keeping the machine's own copy from starting.
//! * `PR_SET_PDEATHSIG` could not work either. `portal::dies_with_us` asks the
//!   kernel to deliver `SIGTERM` when the engine dies, which a child with
//!   `SIGTERM` blocked will not act on.
//!
//! # The fix
//!
//! Clear the mask in the child, between `fork` and `exec`, which is the one
//! moment it can be done without disturbing the engine's own.

use std::process::Command;

/// Hand a child the default signal mask.
///
/// Call on every `Command` the engine spawns. It costs one syscall in the child
/// and nothing in the parent.
pub fn unblock_signals(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: between `fork` and `exec` only async-signal-safe work is allowed.
    // `sigemptyset` and `pthread_sigmask` are both on the list, allocate
    // nothing, and take no lock.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(|| {
            let mut empty: libc::sigset_t = std::mem::zeroed();
            if libc::sigemptyset(&mut empty) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}
