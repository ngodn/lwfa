//! Settings, loaded from `configs/defaults.toml`.
//!
//! # Why a file, when these were all `const`
//!
//! Because a constant is only honest while nobody needs to change it. The
//! workspace lwfa's own window should land on is not a property of the code, it
//! is a property of the machine it runs on, and the same goes for which port to
//! serve on, which terminal to spawn, and how many NVENC sessions the card
//! allows. Those were spread across six modules as `const` declarations with no
//! single place to look.
//!
//! # What is *not* here
//!
//! Constants that are facts rather than choices stay in the code: the xkb
//! keycode offset, the protocol version, the frame header layout. Making those
//! configurable would invite someone to set them wrong.
//!
//! Secrets are not here either. This file is committed; `AUTH_PASS` lives in
//! `.env`. See `auth.rs`.
//!
//! # Failure is not fatal
//!
//! A missing file, a missing section, a missing key and a syntactically broken
//! file all fall back to the built-in defaults, with a warning for the ones
//! that look like mistakes. The engine has to start when its config is wrong,
//! because the editor you would fix it in may be running inside it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

/// The app id lwfa reports to a host compositor.
///
/// Also the default `[window].app_id`. Duplicated as a constant because the
/// window is created before anything could usefully react to a bad value, and
/// because a host's window rules match on this exact string.
pub const APP_ID: &str = "lwfa";
pub const WINDOW_TITLE: &str = "lwfa";

/// Where to look for the config, relative to the repository root.
const CONFIG_PATH: &str = "configs/defaults.toml";

/// Everything the engine reads out of `defaults.toml`.
///
/// `#[serde(default)]` on every container, so a file containing one section is
/// as valid as a complete one. `deny_unknown_fields` so a typo is reported
/// rather than silently ignored, which is the failure mode that wastes an
/// afternoon.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub net: Net,
    pub host: Host,
    pub window: Window,
    pub session: Session,
    pub stream: Stream,
    pub render: Render,
    /// Parsed but unused by the engine: layout is the shell's business. Present
    /// so `deny_unknown_fields` does not reject a perfectly good file.
    #[allow(dead_code)]
    pub layout: toml::Table,
    pub audio: Audio,
    pub gamepad: Gamepad,
    /// Also the shell's, for the same reason.
    ///
    /// The engine does integrate springs, but with the parameters the shell
    /// hands it in `SetLayout`, so that one description of a move drives both
    /// the local and the remote path. Reading this section here as well would
    /// be a second source of truth for the same thing.
    #[allow(dead_code)]
    pub animation: toml::Table,
}

/// Capturing what the machine is playing. See `audio.rs`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Audio {
    /// Which PulseAudio/PipeWire source to record.
    ///
    /// Empty means the default sink's monitor, which is "whatever you would
    /// hear sitting at this machine" and is what nearly everyone wants. Name a
    /// source explicitly to capture something else, such as a null sink that
    /// only the applications you care about are routed to.
    pub device: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Gamepad {
    /// Create the virtual controller at startup and keep it forever.
    ///
    /// Proton runs games inside a container with no udev, and controller
    /// hotplug detection there is unreliable: a pad that appears *after* a
    /// game launches is often never seen. Real hardware is plugged in before
    /// the game starts; a persistent pad behaves the same, so launch order
    /// stops mattering. The cost is a machine that always advertises one
    /// idle controller, which on a personal machine is a fair trade and on a
    /// shared one might not be; hence a switch.
    pub persistent: bool,
}

impl Default for Gamepad {
    fn default() -> Self {
        Self { persistent: false }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Net {
    pub shell_addr: String,
    pub shell_dir: String,
}

impl Default for Net {
    fn default() -> Self {
        Self {
            shell_addr: "127.0.0.1:6733".to_string(),
            shell_dir: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Host {
    pub workspace: u32,
    pub fullscreen: bool,
    pub silent: bool,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            workspace: 10,
            fullscreen: true,
            silent: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Window {
    pub app_id: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub backdrop: [f32; 4],
    pub preview: bool,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            app_id: APP_ID.to_string(),
            title: WINDOW_TITLE.to_string(),
            width: 1280.0,
            height: 800.0,
            backdrop: [0.06, 0.06, 0.08, 1.0],
            preview: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Session {
    pub terminal: String,
    pub autostart_terminal: bool,
    pub xwayland: bool,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            terminal: "alacritty".to_string(),
            autostart_terminal: true,
            xwayland: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Stream {
    pub max_h264_sessions: usize,
    pub gop: u32,
    pub jpeg_quality: u8,
    pub encoder_queue_depth: usize,
    pub max_frames_in_flight: usize,
    pub gpu_direct: bool,
}

impl Default for Stream {
    fn default() -> Self {
        Self {
            max_h264_sessions: 8,
            gop: 120,
            jpeg_quality: 70,
            encoder_queue_depth: 2,
            max_frames_in_flight: 4,
            gpu_direct: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Render {
    pub tick_ms: u64,
    pub redraw_stall_ms: u64,
    pub min_present_ms: u64,
}

impl Default for Render {
    fn default() -> Self {
        Self {
            tick_ms: 16,
            redraw_stall_ms: 50,
            min_present_ms: 4,
        }
    }
}

impl Render {
    pub fn tick(&self) -> Duration {
        Duration::from_millis(self.tick_ms)
    }

    pub fn redraw_stall(&self) -> Duration {
        Duration::from_millis(self.redraw_stall_ms)
    }

    pub fn min_present(&self) -> Duration {
        Duration::from_millis(self.min_present_ms)
    }
}

impl Config {
    /// Load the config, falling back to defaults for anything missing.
    ///
    /// Never returns an error. See the module comment: a compositor that
    /// refuses to start because its config has a typo is a compositor you
    /// cannot fix from inside.
    pub fn load() -> Self {
        let Some(path) = config_path() else {
            tracing::debug!("no {CONFIG_PATH} found, using built-in defaults");
            return Self::default();
        };
        Self::load_from(&path)
    }

    fn load_from(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) => {
                tracing::warn!("could not read {}: {err}. Using defaults.", path.display());
                return Self::default();
            }
        };
        match toml::from_str(&text) {
            Ok(config) => {
                tracing::debug!("loaded config from {}", path.display());
                config
            }
            Err(err) => {
                // Loud, because a typo here silently changes behaviour and the
                // symptom shows up somewhere unrelated.
                tracing::warn!("{} is not valid: {err}. Using defaults.", path.display());
                Self::default()
            }
        }
    }

    /// The engine's listen address, honouring environment and `.env` overrides.
    pub fn shell_addr(&self) -> String {
        crate::auth::setting("LWFA_SHELL_ADDR").unwrap_or_else(|| self.net.shell_addr.clone())
    }

    /// Where the built shell lives, if it can be found.
    ///
    /// `LWFA_SHELL_DIR` names it outright, then `[net] shell_dir`, then the
    /// places it actually ends up: `packages/shell/dist` somewhere above the
    /// binary or the working directory, which covers `cargo run` from anywhere
    /// in the tree, and `share/lwfa/shell` beside an installed binary or under
    /// the usual prefixes.
    ///
    /// `None` is not an error. The engine serves the protocol either way, and a
    /// developer running Vite for hot reload has no `dist/` and does not want
    /// one. It is logged once at startup so a *production* run missing its
    /// page says so plainly rather than answering 404 forever.
    pub fn shell_dir(&self) -> Option<PathBuf> {
        if let Some(named) = crate::auth::setting("LWFA_SHELL_DIR").or_else(|| {
            Some(self.net.shell_dir.clone()).filter(|configured| !configured.is_empty())
        }) {
            let path = PathBuf::from(named);
            if path.join("index.html").is_file() {
                return Some(path);
            }
            tracing::warn!(
                "the configured shell directory {} has no index.html in it",
                path.display()
            );
            return None;
        }

        let starts = [
            std::env::current_dir().ok(),
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
        ];
        for start in starts.into_iter().flatten() {
            for dir in start.ancestors() {
                for relative in ["packages/shell/dist", "share/lwfa/shell", "shell"] {
                    let candidate = dir.join(relative);
                    if candidate.join("index.html").is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        for prefix in ["/usr/share/lwfa/shell", "/usr/local/share/lwfa/shell"] {
            let candidate = PathBuf::from(prefix);
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// Which terminal to spawn. `LWFA_TERMINAL` wins, as it always did.
    ///
    /// # Why this falls back rather than trusting the setting
    ///
    /// The default is `alacritty`, and a fresh machine very often does not
    /// have it. What used to happen then was one `failed to spawn alacritty`
    /// line in a log nobody is reading, an empty desktop, and an `Alt+Return`
    /// that silently does nothing. That is a bad first five minutes, and the
    /// cause is invisible from the only place the user is looking.
    ///
    /// So a configured terminal that is not installed falls through to one
    /// that is. The list is ordered by what a machine running lwfa is likely
    /// to have, Wayland-native first, ending at `xterm` because it is the one
    /// thing that is nearly always present once X11 is.
    ///
    /// If none of them exist the configured name is returned unchanged, so the
    /// failure names what was actually asked for rather than the last thing
    /// tried.
    ///
    /// Deliberately silent. It is called on every spawn and once per startup
    /// check, and an earlier version logged the fallback from in here, which
    /// printed the same warning three times before the session had opened
    /// anything. Reporting belongs at startup, where it happens once; see
    /// [`Self::terminal_report`].
    pub fn terminal(&self) -> String {
        let configured = self.configured_terminal();
        // Only the program name is checked: the setting may carry arguments,
        // and `foo --bar` is not the name of anything on PATH.
        let program = program_name(&configured);
        if program.is_empty() || on_path(program) {
            return configured;
        }
        FALLBACK_TERMINALS
            .iter()
            .find(|name| on_path(name))
            .map(|found| (*found).to_string())
            .unwrap_or(configured)
    }

    /// What was asked for, before any fallback.
    fn configured_terminal(&self) -> String {
        crate::auth::setting("LWFA_TERMINAL").unwrap_or_else(|| self.session.terminal.clone())
    }

    /// What to say about the terminal at startup, if anything.
    ///
    /// `None` when the configured terminal exists, which is the ordinary case
    /// and not worth a line. Otherwise the message, already worded for the
    /// person reading the log, and whether it is bad enough to be a warning.
    pub fn terminal_report(&self) -> Option<(String, bool)> {
        let configured = self.configured_terminal();
        let program = program_name(&configured);
        if program.is_empty() || on_path(program) {
            return None;
        }
        let chosen = self.terminal();
        if on_path(program_name(&chosen)) {
            Some((
                format!("{program} is not installed, so {chosen} is used instead"),
                false,
            ))
        } else {
            Some((
                format!(
                    "no terminal emulator found ({program} is not installed, and neither \
                     is any fallback), so the session starts empty and Alt+Return will do \
                     nothing. Install one, or set [session] terminal."
                ),
                true,
            ))
        }
    }

    /// Is a terminal available at all?
    pub fn terminal_available(&self) -> bool {
        on_path(program_name(&self.terminal()))
    }

    /// Whether to open a terminal at startup. `LWFA_NO_AUTOSTART` forces off.
    pub fn autostart_terminal(&self) -> bool {
        std::env::var_os("LWFA_NO_AUTOSTART").is_none() && self.session.autostart_terminal
    }

    /// Whether to run Xwayland. `LWFA_NO_XWAYLAND` forces off.
    pub fn xwayland(&self) -> bool {
        std::env::var_os("LWFA_NO_XWAYLAND").is_none() && self.session.xwayland
    }
}

/// Terminals to fall back to when the configured one is not installed.
///
/// Wayland-native first, since lwfa is a Wayland compositor and an X11
/// terminal costs an Xwayland round trip. `xterm` is last and deliberate: it
/// is nearly always present once X11 is, so it is the difference between a
/// working `Alt+Return` and a dead one.
const FALLBACK_TERMINALS: &[&str] = &[
    "alacritty",
    "foot",
    "kitty",
    "ghostty",
    "wezterm",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
];

/// The program a command line names, ignoring its arguments.
fn program_name(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or_default()
}

/// Is this program on `PATH` and executable?
///
/// Written out rather than shelling out to `which`, which would be a process
/// spawn to answer a question about whether a process can be spawned.
fn on_path(program: &str) -> bool {
    if program.is_empty() {
        return false;
    }
    // An explicit path is checked directly; PATH does not apply to it.
    if program.contains('/') {
        return is_executable(Path::new(program));
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_executable(&dir.join(program)))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Find `configs/defaults.toml`.
///
/// `LWFA_CONFIG` names it outright. Otherwise walk up from the executable and
/// from the working directory, which between them cover `cargo run` from
/// anywhere in the tree and an installed binary sitting next to its configs.
fn config_path() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("LWFA_CONFIG") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
        tracing::warn!(
            "LWFA_CONFIG points at {}, which is not a readable file",
            path.display()
        );
        return None;
    }

    let starts = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf)),
    ];

    for start in starts.into_iter().flatten() {
        for dir in start.ancestors() {
            let candidate = dir.join(CONFIG_PATH);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_is_all_defaults() {
        let parsed: Config = toml::from_str("").expect("an empty file is valid");
        assert_eq!(parsed.net.shell_addr, Net::default().shell_addr);
        assert_eq!(parsed.host.workspace, Host::default().workspace);
        assert_eq!(parsed.stream.gop, Stream::default().gop);
    }

    #[test]
    fn a_partial_section_keeps_the_other_defaults() {
        // The case that matters: someone sets one value and expects the rest to
        // keep working rather than dropping to zero.
        let parsed: Config = toml::from_str("[host]\nworkspace = 4\n").expect("valid");
        assert_eq!(parsed.host.workspace, 4);
        assert!(parsed.host.fullscreen, "unset keys keep their default");
        assert_eq!(
            parsed.net.shell_addr,
            "127.0.0.1:6733",
            "untouched sections are default"
        );
    }

    #[test]
    fn a_configured_terminal_that_exists_is_used_unchanged() {
        let config = Config {
            session: Session {
                terminal: "xterm".to_string(),
                ..Session::default()
            },
            ..Config::default()
        };
        // Present on essentially every machine with X11, including this one.
        assert_eq!(config.terminal(), "xterm");
    }

    #[test]
    fn a_missing_terminal_falls_back_to_one_that_exists() {
        let config = Config {
            session: Session {
                terminal: "definitely-not-a-terminal-xyzzy".to_string(),
                ..Session::default()
            },
            ..Config::default()
        };
        let chosen = config.terminal();
        assert_ne!(chosen, "definitely-not-a-terminal-xyzzy");
        assert!(
            FALLBACK_TERMINALS.contains(&chosen.as_str()),
            "fell back to something not on the list: {chosen}"
        );
        assert!(config.terminal_available());
    }

    #[test]
    fn arguments_do_not_stop_the_program_being_found() {
        // The setting may carry arguments; `xterm -e foo` is not a filename.
        let config = Config {
            session: Session {
                terminal: "xterm -class lwfa".to_string(),
                ..Session::default()
            },
            ..Config::default()
        };
        assert_eq!(config.terminal(), "xterm -class lwfa");
    }

    #[test]
    fn on_path_understands_the_shapes_a_setting_can_take() {
        assert!(on_path("sh"));
        assert!(on_path("/bin/sh"));
        assert!(!on_path(""));
        assert!(!on_path("definitely-not-a-program-xyzzy"));
        // A directory is not a program, however executable its bits look.
        assert!(!on_path("/usr/bin"));
        assert!(!on_path("/etc/hostname"));
    }

    #[test]
    fn a_typo_is_rejected_rather_than_ignored() {
        // Silently ignoring this is the failure mode that wastes an afternoon:
        // the setting appears to be applied and is not.
        let err = toml::from_str::<Config>("[host]\nworkspce = 4\n")
            .expect_err("an unknown key must not parse");
        assert!(
            err.to_string().contains("workspce"),
            "the error should name the offending key, got: {err}"
        );
    }

    #[test]
    fn a_broken_file_falls_back_instead_of_failing() {
        let dir = std::env::temp_dir().join("lwfa-config-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("broken.toml");
        std::fs::write(&path, "this is not toml = = =").expect("write");

        let config = Config::load_from(&path);
        assert_eq!(config.net.shell_addr, "127.0.0.1:6733");
        let _ = std::fs::remove_file(&path);
    }

    /// The committed file has to actually parse, or every run silently drops to
    /// defaults and nobody notices until a setting does nothing.
    #[test]
    fn the_shipped_defaults_parse() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(CONFIG_PATH);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()));
        let parsed: Config = toml::from_str(&text)
            .unwrap_or_else(|err| panic!("{} does not parse: {err}", path.display()));

        // Spot-check that values arrive, so a rename cannot quietly turn the
        // file into a no-op that still parses.
        assert_eq!(parsed.window.app_id, APP_ID);
        assert!(parsed.host.workspace > 0);
        assert!(parsed.stream.max_h264_sessions > 0);
        assert!(!parsed.net.shell_addr.is_empty());
    }
}
