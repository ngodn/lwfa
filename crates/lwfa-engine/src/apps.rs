//! Finding the applications installed on the machine.
//!
//! Reads freedesktop `.desktop` entries, which is how every Linux desktop
//! decides what to put in its launcher. Nothing here is lwfa-specific: the same
//! files drive GNOME's overview, rofi and every application menu on the system,
//! so whatever the user has installed simply appears.
//!
//! # What is skipped, and why
//!
//! - `NoDisplay=true` and `Hidden=true` mean "this exists but is not for
//!   humans": MIME handlers, D-Bus activation stubs, uninstall helpers. Showing
//!   them makes the launcher a list of things that do nothing visible.
//! - `Type=` other than `Application` is a link or a directory entry, neither
//!   of which can be launched.
//! - Later directories in `XDG_DATA_DIRS` lose to earlier ones for the same id,
//!   which is the spec's own precedence rule and is what lets a user override a
//!   system entry by putting their own in `~/.local/share`.
//!
//! # Exec field codes
//!
//! `Exec=` may contain `%f`, `%U` and friends, meaning "the files the user
//! dropped on this". There are none here, and passing them through literally
//! makes programs open a file called `%U`, so they are stripped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lwfa_proto::AppEntry;

/// Where to look, in precedence order.
///
/// `XDG_DATA_HOME` first so a user's own entry wins, then `XDG_DATA_DIRS`, then
/// the defaults the spec mandates when those are unset.
fn search_paths() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Some(home) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        roots.push(PathBuf::from(home));
    } else if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".local/share"));
    }

    let dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    roots.extend(dirs.split(':').filter(|p| !p.is_empty()).map(PathBuf::from));

    roots
        .into_iter()
        .map(|root| root.join("applications"))
        .collect()
}

/// Every launchable application, sorted by name.
pub fn installed() -> Vec<AppEntry> {
    let mut found: HashMap<String, AppEntry> = HashMap::new();

    for dir in search_paths() {
        collect_from(&dir, &mut found, 0);
    }

    let mut apps: Vec<AppEntry> = found.into_values().collect();
    // Case-insensitive, because a launcher sorted with every capitalised name
    // first is not sorted in any way a human recognises.
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps
}

/// Walk one directory. Entries nest one level in some distributions.
fn collect_from(dir: &Path, found: &mut HashMap<String, AppEntry>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 2 {
                collect_from(&path, found, depth + 1);
            }
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // First writer wins: search_paths is already in precedence order.
        if found.contains_key(id) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(app) = parse(id, &text) {
            found.insert(app.id.clone(), app);
        }
    }
}

/// Parse one desktop entry, or `None` if it is not a launchable application.
///
/// Deliberately a small hand-rolled reader rather than a full INI parser: the
/// only section that matters is `[Desktop Entry]`, the only keys that matter
/// are seven of them, and localised variants (`Name[de]`) must be *ignored*
/// rather than merged, which most generic parsers get wrong by overwriting the
/// unlocalised value with whichever locale happened to come last.
pub fn parse(id: &str, text: &str) -> Option<AppEntry> {
    let mut in_entry = false;
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut exec: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut categories: Vec<String> = Vec::new();
    let mut terminal = false;

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // Later groups are actions ("Open a new window"), not the app.
            in_entry = line == "[Desktop Entry]";
            if !in_entry && name.is_some() {
                break;
            }
            continue;
        }
        if !in_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());

        match key {
            "Type" if value != "Application" => return None,
            "NoDisplay" | "Hidden" if value.eq_ignore_ascii_case("true") => return None,
            "Name" => name = Some(value.to_string()),
            "Comment" => description = Some(value.to_string()),
            "Exec" => exec = Some(strip_field_codes(value)),
            "Icon" => icon = Some(value.to_string()),
            "Terminal" => terminal = value.eq_ignore_ascii_case("true"),
            "Categories" => {
                categories = value
                    .split(';')
                    .filter(|c| !c.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            _ => {}
        }
    }

    let exec = exec?;
    if exec.is_empty() {
        return None;
    }

    Some(AppEntry {
        id: id.to_string(),
        name: name.unwrap_or_else(|| id.to_string()),
        description,
        exec,
        icon,
        categories,
        terminal,
    })
}

/// Remove the `%f`-style placeholders, and the `env`-ish prefixes that follow.
///
/// `%i`, `%c` and `%k` expand to the icon, name and path, and dropping them is
/// correct here because nothing is being passed in. `%%` is a literal percent.
fn strip_field_codes(exec: &str) -> String {
    let mut out = String::with_capacity(exec.len());
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            // Everything else is a field code with no value to substitute.
            Some(_) | None => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_normal_entry() {
        let app = parse(
            "org.example.Thing",
            "[Desktop Entry]\nType=Application\nName=Thing\nComment=Does things\n\
             Exec=thing --flag %U\nIcon=thing\nCategories=Utility;Development;\n",
        )
        .expect("should parse");
        assert_eq!(app.name, "Thing");
        assert_eq!(app.exec, "thing --flag", "field codes are stripped");
        assert_eq!(app.categories, vec!["Utility", "Development"]);
        assert!(!app.terminal);
    }

    #[test]
    fn skips_entries_not_meant_for_humans() {
        let hidden = "[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true\n";
        assert!(parse("x", hidden).is_none());
        let link = "[Desktop Entry]\nType=Link\nName=X\nURL=http://example.com\n";
        assert!(parse("x", link).is_none());
    }

    #[test]
    fn ignores_localised_names() {
        // The bug this guards: a naive parser takes the *last* Name= it sees,
        // so a German locale entry silently becomes every user's app name.
        let app = parse(
            "x",
            "[Desktop Entry]\nType=Application\nName=Files\nName[de]=Dateien\nExec=files\n",
        )
        .expect("should parse");
        assert_eq!(app.name, "Files");
    }

    #[test]
    fn stops_at_the_first_action_group() {
        let app = parse(
            "x",
            "[Desktop Entry]\nType=Application\nName=Browser\nExec=browser\n\n\
             [Desktop Action new-window]\nName=New Window\nExec=browser --new-window\n",
        )
        .expect("should parse");
        assert_eq!(app.name, "Browser");
        assert_eq!(app.exec, "browser", "the action's Exec must not win");
    }

    #[test]
    fn an_entry_with_no_exec_is_not_launchable() {
        assert!(parse("x", "[Desktop Entry]\nType=Application\nName=X\n").is_none());
    }

    #[test]
    fn keeps_a_literal_percent() {
        let app = parse(
            "x",
            "[Desktop Entry]\nType=Application\nName=X\nExec=x --at 50%%\n",
        )
        .expect("should parse");
        assert_eq!(app.exec, "x --at 50%");
    }
}
