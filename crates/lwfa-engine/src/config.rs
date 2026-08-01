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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Net {
    pub shell_addr: String,
    pub shell_port: u16,
}

impl Default for Net {
    fn default() -> Self {
        Self {
            shell_addr: "127.0.0.1:6734".to_string(),
            shell_port: 6733,
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
}

impl Default for Window {
    fn default() -> Self {
        Self {
            app_id: APP_ID.to_string(),
            title: WINDOW_TITLE.to_string(),
            width: 1280.0,
            height: 800.0,
            backdrop: [0.06, 0.06, 0.08, 1.0],
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
}

impl Default for Stream {
    fn default() -> Self {
        Self {
            max_h264_sessions: 8,
            gop: 120,
            jpeg_quality: 70,
            encoder_queue_depth: 2,
            max_frames_in_flight: 4,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Render {
    pub tick_ms: u64,
    pub redraw_stall_ms: u64,
}

impl Default for Render {
    fn default() -> Self {
        Self {
            tick_ms: 16,
            redraw_stall_ms: 50,
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

    /// Which terminal to spawn. `LWFA_TERMINAL` wins, as it always did.
    pub fn terminal(&self) -> String {
        crate::auth::setting("LWFA_TERMINAL").unwrap_or_else(|| self.session.terminal.clone())
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
        assert_eq!(parsed.net.shell_port, Net::default().shell_port);
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
            parsed.net.shell_port, 6733,
            "untouched sections are default"
        );
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
        assert_eq!(config.net.shell_port, 6733);
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
