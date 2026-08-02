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

/// `/usr/share/pixmaps`, which is outside the theme system but is where several
/// real applications keep their only icon.
const PIXMAP_SCORE: i64 = 0;

/// An installed theme that the active one does not inherit from. Below
/// everything else, so it can only fill a gap. See `Index::build`.
const FOREIGN_THEME_SCORE: i64 = -1_000_000;

/// How long a built index is trusted before it is thrown away.
///
/// Rebuilding walks every size and context directory of every installed theme,
/// which is thousands of `stat` calls. Doing that per request is why the shell
/// had to remember failures for a day rather than simply asking again. Keeping
/// the index means a repeat request is a handful of hash lookups, so the shell
/// is free to re-ask often and an application installed five minutes ago turns
/// up without anyone clearing anything.
const INDEX_TTL: std::time::Duration = std::time::Duration::from_secs(300);

thread_local! {
    /// The index, and when it was built.
    ///
    /// Thread-local rather than a global with a lock: icon resolution happens
    /// on the event loop thread and nowhere else, so a mutex would be paying
    /// for contention that cannot occur.
    static INDEX: std::cell::RefCell<Option<(std::time::Instant, std::rc::Rc<Index>)>> =
        const { std::cell::RefCell::new(None) };
}

/// The current index, rebuilt only when there is not a fresh one.
fn index() -> std::rc::Rc<Index> {
    INDEX.with(|cell| {
        let mut slot = cell.borrow_mut();
        if let Some((built, index)) = slot.as_ref() {
            if built.elapsed() < INDEX_TTL {
                return std::rc::Rc::clone(index);
            }
        }
        let started = std::time::Instant::now();
        let index = std::rc::Rc::new(Index::build());
        tracing::debug!(
            "indexed {} icon names in {:.0}ms",
            index.best.len(),
            started.elapsed().as_secs_f64() * 1000.0
        );
        *slot = Some((std::time::Instant::now(), std::rc::Rc::clone(&index)));
        index
    })
}

/// Resolve and encode icons for the given `(app id, icon name)` pairs.
///
/// Skips anything that cannot be found or read, so a missing icon costs the
/// launcher a coloured initial rather than an error.
pub fn resolve_all(wanted: &[(String, String)]) -> Vec<AppIcon> {
    let index = index();

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
            index_dir(Path::new(dir), PIXMAP_SCORE, &mut best);
        }

        // Last resort: every other installed theme.
        //
        // The specification says to search the current theme, its parents, and
        // then `hicolor`, and by that rule a name the chain does not provide
        // simply has no icon. In practice that leaves real applications blank:
        // with `Yaru-blue` active, `printer` lives only in `AdwaitaLegacy` and
        // `network-wired` only in `breeze`, so Print Settings and the Avahi
        // browsers had nothing to draw.
        //
        // Scored below everything above, so this can only ever fill a gap: any
        // theme in the real chain, and even a bare pixmap, still wins. The
        // worst case is an icon drawn in the wrong style, which is better than
        // a blank square.
        for root in &roots {
            let Ok(entries) = std::fs::read_dir(root) else {
                continue;
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() || themes.iter().any(|t| dir.ends_with(t)) {
                    continue;
                }
                index_theme(&dir, FOREIGN_THEME_SCORE, &mut best);
            }
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
///
/// # Why a raster icon is re-encoded rather than sent as it is
///
/// Applications ship enormous icons. VS Code's is a 215 KB PNG in
/// `/usr/share/pixmaps`, Zed's is 512 by 512 and 164 KB, and the launcher draws
/// both at 64 pixels. Sending ninety-six of those is megabytes over a phone
/// connection for pictures nobody can see the detail in.
///
/// This used to be handled by refusing anything over a size limit, which is
/// how VS Code and Zed came to have no icon at all: found, read, and silently
/// dropped for being too big. Scaling is the answer the limit was reaching
/// for. A 512-pixel icon becomes a couple of kilobytes, and the ones that used
/// to vanish now arrive.
///
/// SVG is passed through untouched: it is already small, it is sharp at any
/// size, and rasterising it here would throw that away.
fn encode(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }

    match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => {
            // Still bounded: an SVG can contain an embedded bitmap, and one of
            // those has no business being an icon.
            if bytes.len() > MAX_BYTES {
                return None;
            }
            Some(format!("data:image/svg+xml;base64,{}", base64(&bytes)))
        }
        Some("png") | Some("jpg") | Some("jpeg") => {
            let png = shrink(&bytes).unwrap_or(bytes);
            Some(format!("data:image/png;base64,{}", base64(&png)))
        }
        // The browser cannot render XPM, so sending it would be a broken image
        // rather than a fallback to the initial. Only a handful of X11-era
        // applications still ship one, xterm among them.
        _ => None,
    }
}

/// Decode, scale to the size the launcher draws at, and re-encode as PNG.
///
/// Returns `None` when the image cannot be decoded or is already small enough
/// to be worth leaving alone, in which case the caller sends the original.
fn shrink(bytes: &[u8]) -> Option<Vec<u8>> {
    // A cap on what is worth decoding at all. Beyond this it is not an icon,
    // and decoding it would cost more than the launcher gains.
    const DECODE_LIMIT: usize = 8 * 1024 * 1024;
    if bytes.len() > DECODE_LIMIT {
        return None;
    }

    let image = image::load_from_memory(bytes).ok()?;
    let (width, height) = (image::GenericImageView::width(&image), image::GenericImageView::height(&image));

    // Already the right size and already small: re-encoding would only lose a
    // little quality for nothing.
    if width <= TARGET && height <= TARGET && bytes.len() <= MAX_BYTES {
        return None;
    }

    // `Lanczos3` rather than nearest: an icon halved by a rough filter looks
    // visibly worse than the same icon at half the size, and this runs once
    // per application at startup, not per frame.
    let scaled = if width > TARGET || height > TARGET {
        image.resize(TARGET, TARGET, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };

    let mut out = Vec::new();
    scaled
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
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
    /// VS Code and Zed had no icon in the launcher. Both were found, read, and
    /// then dropped for being over a size limit: 215 KB and 164 KB against a
    /// 96 KB cap, for pictures drawn at 64 pixels.
    #[test]
    fn an_oversized_icon_is_scaled_rather_than_dropped() {
        let big = image::RgbaImage::from_fn(512, 512, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(big)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode the fixture");

        let scaled = super::shrink(&png).expect("should have been scaled");
        let decoded = image::load_from_memory(&scaled).expect("valid png out");
        assert!(
            image::GenericImageView::width(&decoded) <= super::TARGET,
            "still {} wide",
            image::GenericImageView::width(&decoded)
        );
        assert!(
            scaled.len() < png.len(),
            "scaling made it bigger: {} -> {}",
            png.len(),
            scaled.len()
        );
    }

    #[test]
    fn a_small_icon_is_left_exactly_as_it_is() {
        // Re-encoding a 48-pixel icon costs a little quality and saves nothing.
        let small = image::RgbaImage::from_pixel(48, 48, image::Rgba([10, 20, 30, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(small)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode the fixture");
        assert!(super::shrink(&png).is_none());
    }

    #[test]
    fn something_that_is_not_an_image_is_refused_quietly() {
        assert!(super::shrink(b"not a png at all").is_none());
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
