//! Finding programs that are running on the host rather than in here.
//!
//! # Why this exists
//!
//! Applications that key "one instance" on their profile directory do not start
//! a second copy when you launch them again. Chromium and everything built on
//! it keep a lock and a socket inside the user data directory; a second launch
//! connects to that socket, hands over its command line, and exits. The copy
//! that was already running opens the window, wherever *it* happens to be.
//!
//! lwfa is a second session for the same user, sharing one home directory, so
//! "wherever it happens to be" is the other screen. Launching VS Code from a
//! tablet raises a window on a monitor nobody is looking at, and from the
//! tablet nothing happens at all.
//!
//! Nothing can be done about that from this side. The engine cannot move a
//! window between compositors, and starting a second copy against a shared
//! profile risks corrupting it. What it can do is notice, say so, and offer to
//! close the other one.
//!
//! # Telling the two apart
//!
//! By the `WAYLAND_DISPLAY` a process was started with. Everything the engine
//! spawns is given this session's socket, so anything carrying a different one,
//! or none, belongs to the host. That is exact, unlike guessing from the
//! process tree, which loses track the moment an application re-execs or is
//! restarted by a service manager.

use std::ffi::OsStr;
use std::path::Path;

/// A process running outside this session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outsider {
    pub pid: u32,
    /// The binary's name, which is what a person recognises.
    pub program: String,
}

/// The name a command will actually run, with no path and no arguments.
///
/// `/usr/share/code/code --new-window` is `code`, which is both what shows in
/// a process list and what somebody would call it.
pub fn program_name(command: &str) -> Option<String> {
    let first = command.split_whitespace().next()?;
    let base = Path::new(first).file_name()?.to_str()?;
    (!base.is_empty()).then(|| base.to_string())
}

/// Was this process started against our session?
///
/// Reads a `/proc/<pid>/environ` payload: NUL-separated `KEY=VALUE`. Anything
/// without our socket is on the host, including a process with no
/// `WAYLAND_DISPLAY` at all, which is how an X11 application looks.
pub fn belongs_to_session(environ: &[u8], our_socket: &OsStr) -> bool {
    let wanted = our_socket.as_encoded_bytes();
    environ
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(b"WAYLAND_DISPLAY=".as_slice()))
        .any(|value| value == wanted)
}

/// Is this the process to talk to, rather than one of its helpers?
///
/// Chromium forks a renderer, a GPU process and several utilities, all sharing
/// the parent's name and every one of them carrying `--type=`. Signalling one
/// of those achieves nothing: the browser notices the crash and restarts it.
/// The one worth asking to quit is the one with no `--type=`.
pub fn is_main_process(cmdline: &[u8]) -> bool {
    !cmdline
        .split(|byte| *byte == 0)
        .any(|arg| arg.starts_with(b"--type="))
}

/// Find a running copy of `program` that is not part of this session.
///
/// Returns the lowest pid, which for an application that forks helpers is the
/// one that started first and therefore the one holding the profile lock.
pub fn find(program: &str, our_socket: &OsStr) -> Option<Outsider> {
    let mut found: Option<Outsider> = None;

    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        let dir = entry.path();

        // `comm` is the name the kernel knows, truncated to 15 bytes, so it is
        // compared against a name truncated the same way rather than being
        // trusted whole. `google-chrome-stable` is `google-chrome-s` here.
        let Ok(comm) = std::fs::read_to_string(dir.join("comm")) else {
            continue;
        };
        let comm = comm.trim_end();
        if comm.is_empty() || !program.as_bytes().starts_with(comm.as_bytes()) {
            continue;
        }

        let Ok(cmdline) = std::fs::read(dir.join("cmdline")) else {
            continue;
        };
        if !is_main_process(&cmdline) {
            continue;
        }

        // Unreadable environ means another user's process, which is not ours to
        // report on and not ours to close.
        let Ok(environ) = std::fs::read(dir.join("environ")) else {
            continue;
        };
        if belongs_to_session(&environ, our_socket) {
            continue;
        }

        if found.as_ref().is_none_or(|best| pid < best.pid) {
            found = Some(Outsider {
                pid,
                program: program.to_string(),
            });
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn environ(pairs: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for pair in pairs {
            out.extend_from_slice(pair.as_bytes());
            out.push(0);
        }
        out
    }

    fn cmdline(args: &[&str]) -> Vec<u8> {
        environ(args)
    }

    #[test]
    fn names_the_binary_without_its_path_or_arguments() {
        assert_eq!(program_name("/usr/share/code/code --new-window").as_deref(), Some("code"));
        assert_eq!(program_name("alacritty").as_deref(), Some("alacritty"));
        assert_eq!(program_name("/usr/bin/firefox").as_deref(), Some("firefox"));
        assert_eq!(program_name(""), None);
    }

    #[test]
    fn a_process_on_our_socket_is_ours() {
        let ours = OsString::from("wayland-2");
        assert!(belongs_to_session(
            &environ(&["HOME=/home/x", "WAYLAND_DISPLAY=wayland-2"]),
            &ours
        ));
    }

    #[test]
    fn a_process_on_the_hosts_socket_is_not() {
        // The whole point: same user, same home, different compositor.
        let ours = OsString::from("wayland-2");
        assert!(!belongs_to_session(
            &environ(&["WAYLAND_DISPLAY=wayland-1"]),
            &ours
        ));
    }

    #[test]
    fn a_process_with_no_wayland_display_is_not_ours() {
        // An X11 application, or anything started by a service manager.
        let ours = OsString::from("wayland-2");
        assert!(!belongs_to_session(&environ(&["HOME=/home/x"]), &ours));
        assert!(!belongs_to_session(&[], &ours));
    }

    #[test]
    fn does_not_match_a_socket_that_merely_starts_the_same() {
        // `wayland-2` and `wayland-20` are different compositors.
        let ours = OsString::from("wayland-2");
        assert!(!belongs_to_session(
            &environ(&["WAYLAND_DISPLAY=wayland-20"]),
            &ours
        ));
    }

    #[test]
    fn the_main_process_is_the_one_without_a_type() {
        assert!(is_main_process(&cmdline(&["/usr/share/code/code", "--new-window"])));
    }

    #[test]
    fn a_helper_process_is_not_worth_signalling() {
        // Chromium restarts these itself, so closing one changes nothing.
        assert!(!is_main_process(&cmdline(&[
            "/usr/share/code/code",
            "--type=renderer",
            "--lang=en-US"
        ])));
        assert!(!is_main_process(&cmdline(&["code", "--type=gpu-process"])));
    }

    #[test]
    fn an_empty_command_line_is_not_a_helper() {
        // A kernel thread has no command line at all. It will not match a
        // program name either, but this must not panic on the way there.
        assert!(is_main_process(&[]));
    }
}

/// Every process descended from `root`, including `root` itself.
///
/// # Why the tree and not the pid
///
/// The pid lwfa spawns is rarely the pid that owns the window. `steam` is a
/// shell script that execs a launcher that starts the client that starts
/// `steamwebhelper`, and the window belongs to the last of those. Asking
/// whether the spawned pid owns a window would answer "no" for a Steam sitting
/// there with its library open, which is the opposite of the truth and would
/// invite someone to quit it mid-download.
///
/// Reads `ppid` out of `/proc/<pid>/stat`. The field is the fourth, and the
/// second is the executable name in parentheses which may itself contain spaces
/// and parentheses, so the scan starts after the last `)` rather than splitting
/// the whole line.
pub fn descendants(root: u32) -> std::collections::HashSet<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return std::iter::once(root).collect();
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(after) = stat.rfind(')').map(|i| &stat[i + 1..]) else {
            continue;
        };
        // After the closing parenthesis: state, then ppid.
        let Some(ppid) = after
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }

    let mut found = std::collections::HashSet::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        if !found.insert(pid) {
            continue;
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    found
}

#[cfg(test)]
mod tree_tests {
    use super::descendants;

    #[test]
    fn a_process_is_its_own_descendant() {
        let me = std::process::id();
        assert!(descendants(me).contains(&me));
    }

    #[test]
    fn a_child_is_found_under_its_parent() {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 5"])
            .spawn();
        let Ok(mut child) = child else { return };
        let tree = descendants(std::process::id());
        assert!(tree.contains(&child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn an_unrelated_process_is_not_in_the_tree() {
        // Pid 1 is nobody's child but its own tree's root.
        assert!(!descendants(std::process::id()).contains(&1));
    }
}
