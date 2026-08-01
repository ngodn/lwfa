//! Resolving a desktop entry's `Icon=` name to actual bytes.
//!
//! A `.desktop` file names an icon (`Icon=firefox`), not a path. Turning that
//! name into a file is the freedesktop icon theme lookup, and it is more
//! involved than it sounds: themes inherit from other themes, sizes live in
//! separate directories, the same icon exists as PNG at eight sizes and as one
//! SVG, and the whole chain ends at `hicolor` and then at `/usr/share/pixmaps`.
//!
//! On this machine, for example, `Yaru-blue` inherits `Yaru,Humanity,hicolor`,
//! `org.gnome.Nautilus` is an SVG under `scalable/apps` *and* a PNG under
//! `16x16@2x/apps`, and `Alacritty` is not in any theme at all: it is a bare
//! file in `/usr/share/pixmaps`. Any lookup that skips a step misses real
//! applications.
//!
//! # Why the bytes cross the wire
//!
//! The browser cannot read the machine's filesystem, so the icon has to be
//! transported. They are sent as data URIs in a message of their own, *after*
//! the application list, so the launcher paints immediately and fills in.
//!
//! SVG is preferred where it exists: it is usually smaller than a large PNG and
//! stays sharp at any size the shell chooses to draw it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lwfa_proto::AppIcon;

/// The size the shell draws icons at. Used to pick between PNG sizes.
const TARGET: u32 = 64;

/// Refuse anything larger. A few oversized icons should not turn the launcher's
/// first paint into a multi-megabyte download.
const MAX_BYTES: usize = 96 * 1024;

/// Resolve and encode icons for the given `(app id, icon name)` pairs.
///
/// Skips anything that cannot be found or read, so a missing icon costs the
/// launcher a coloured initial rather than an error.
pub fn resolve_all(wanted: &[(String, String)]) -> Vec<AppIcon> {
    let index = Index::build();

    // Many applications share an icon name, so each file is read once.
    let mut cache: HashMap<&str, Option<String>> = HashMap::new();
    let mut icons = Vec::new();
    for (id, name) in wanted {
        let encoded = cache
            .entry(name.as_str())
            .or_insert_with(|| index.lookup(name).and_then(|path| encode(&path)));
        if let Some(data) = encoded {
            icons.push(AppIcon {
                id: id.clone(),
                data: data.clone(),
            });
        }
    }
    icons
}

/// Every icon in the active theme chain, indexed by name.
///
/// # Why an index and not a search per name
///
/// The obvious implementation walks the theme directories looking for one name,
/// and it is unusably slow: the chain here is four themes, each with two dozen
/// size directories, each with a dozen context directories, so a single lookup
/// is thousands of `stat` calls. Times ninety-six applications, the launcher
/// simply never answers. Measured: the first version had not returned after
/// twenty seconds.
///
/// One traversal, building a map, turns that into one pass and ninety-six hash
/// lookups.
struct Index {
    /// Name to best-scoring file found for it.
    best: HashMap<String, (i64, PathBuf)>,
}

impl Index {
    fn build() -> Self {
        let mut best: HashMap<String, (i64, PathBuf)> = HashMap::new();
        let roots = search_roots();
        let themes = theme_chain();

        // Earlier themes win, so they are given a large bonus rather than being
        // checked first and short-circuited: one pass, and the scoring stays in
        // a single place.
        for (rank, theme) in themes.iter().enumerate() {
            let theme_bonus = (themes.len() - rank) as i64 * 10_000;
            for root in &roots {
                index_theme(&root.join(theme), theme_bonus, &mut best);
            }
        }

        // Not part of any theme, and the only home of several real
        // applications: Alacritty is a bare file here on this machine.
        for dir in ["/usr/share/pixmaps", "/usr/local/share/pixmaps"] {
            index_dir(Path::new(dir), 0, &mut best);
        }

        Self { best }
    }

    fn lookup(&self, name: &str) -> Option<PathBuf> {
        // An `Icon=` that is already a path is allowed by the spec, and is what
        // Steam writes for every game.
        let direct = Path::new(name);
        if direct.is_absolute() && direct.is_file() {
            return Some(direct.to_path_buf());
        }
        self.best.get(name).map(|(_, path)| path.clone())
    }
}

/// Index one theme directory: `<theme>/<size>/<context>/<name>.<ext>`.
fn index_theme(theme_dir: &Path, theme_bonus: i64, best: &mut HashMap<String, (i64, PathBuf)>) {
    let Ok(sizes) = std::fs::read_dir(theme_dir) else {
        return;
    };
    for size_entry in sizes.flatten() {
        let size_dir = size_entry.path();
        if !size_dir.is_dir() {
            continue;
        }
        let score = theme_bonus + score_of(&size_entry.file_name().to_string_lossy());
        // Contexts: apps, devices, mimetypes. Which one an icon is in does not
        // matter here, only that the name matches.
        let Ok(contexts) = std::fs::read_dir(&size_dir) else {
            continue;
        };
        for context in contexts.flatten() {
            index_dir(&context.path(), score, best);
        }
    }
}

/// Index the icon files directly inside one directory.
fn index_dir(dir: &Path, score: i64, best: &mut HashMap<String, (i64, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        // SVG beats a same-sized raster: smaller, and sharp at whatever size
        // the shell draws it.
        let bonus = match extension {
            "svg" => 40,
            "png" => 0,
            _ => continue,
        };
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let total = score + bonus;
        match best.get(name) {
            Some((existing, _)) if *existing >= total => {}
            _ => {
                best.insert(name.to_string(), (total, path));
            }
        }
    }
}

/// Where themes live, in precedence order.
fn search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join(".icons"));
        roots.push(home.join(".local/share/icons"));
    }
    let dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        roots.push(Path::new(dir).join("icons"));
    }
    roots
}

/// The themes to try, in order, ending at `hicolor`.
///
/// `hicolor` is the spec's mandated fallback and is where most applications
/// actually install, so it is always last rather than only when named.
fn theme_chain() -> Vec<String> {
    let mut chain = Vec::new();
    if let Some(current) = current_theme() {
        chain.push(current);
    }

    // Follow `Inherits=` one level, which covers every real theme; a cycle
    // would otherwise be an infinite loop for no practical gain.
    let roots = search_roots();
    if let Some(first) = chain.first().cloned() {
        for root in &roots {
            let index = root.join(&first).join("index.theme");
            let Ok(text) = std::fs::read_to_string(&index) else {
                continue;
            };
            for line in text.lines() {
                if let Some(list) = line.trim().strip_prefix("Inherits=") {
                    chain.extend(list.split(',').map(|t| t.trim().to_string()));
                    break;
                }
            }
            break;
        }
    }

    if !chain.iter().any(|t| t == "hicolor") {
        chain.push("hicolor".to_string());
    }
    chain
}

/// The user's icon theme, from GTK's settings.
///
/// Read from the config file rather than by asking a settings daemon: the
/// compositor may be the only thing running, and a `gsettings` subprocess per
/// launcher open would be silly.
fn current_theme() -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    for relative in ["gtk-4.0/settings.ini", "gtk-3.0/settings.ini"] {
        let Ok(text) = std::fs::read_to_string(home.join(".config").join(relative)) else {
            continue;
        };
        for line in text.lines() {
            if let Some(value) = line.trim().strip_prefix("gtk-icon-theme-name=") {
                let value = value.trim().trim_matches('"');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// How good a size directory is, higher being better.
///
/// `scalable` wins outright. Otherwise the closer to [`TARGET`] the better, and
/// bigger-than-target beats smaller, because downscaling looks fine and
/// upscaling does not.
fn score_of(dir_name: &str) -> i64 {
    if dir_name.starts_with("scalable") {
        return 1000;
    }
    let Some(size) = dir_name
        .split(['x', '@'])
        .next()
        .and_then(|n| n.parse::<i64>().ok())
    else {
        return -1000;
    };
    let target = TARGET as i64;
    if size >= target {
        500 - (size - target)
    } else {
        400 - (target - size) * 2
    }
}

/// Read a file and encode it as a `data:` URI.
fn encode(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        // The browser cannot render XPM, so sending it would be a broken image
        // rather than a fallback to the initial.
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// Standard base64, no padding shortcuts.
///
/// Hand-rolled rather than a dependency: it is fifteen lines, it is used in
/// exactly one place, and the alternative is a crate in the tree forever.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_bytes_above_ascii() {
        // PNG's magic number, which is exactly the kind of input this sees.
        assert_eq!(base64(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
    }

    #[test]
    fn scalable_beats_every_raster_size() {
        assert!(score_of("scalable") > score_of("512x512"));
        assert!(score_of("scalable") > score_of("64x64"));
    }

    #[test]
    fn the_target_size_wins_among_rasters() {
        let target = score_of("64x64");
        assert!(target > score_of("48x48"));
        assert!(target > score_of("128x128"));
        assert!(target > score_of("16x16"));
    }

    #[test]
    fn bigger_beats_smaller_when_both_miss() {
        // Downscaling looks fine; upscaling looks like a mistake.
        assert!(score_of("128x128") > score_of("32x32"));
    }

    #[test]
    fn scaled_directories_parse() {
        // "16x16@2x" must read as 16, not fail to parse and score -1000.
        assert!(score_of("16x16@2x") > -1000);
        assert_eq!(score_of("16x16@2x"), score_of("16x16"));
    }

    #[test]
    fn hicolor_is_always_last_in_the_chain() {
        let chain = theme_chain();
        assert_eq!(
            chain.last().map(String::as_str),
            Some("hicolor"),
            "the spec's fallback must always be reachable, got {chain:?}",
        );
    }
}
