//! The clipboard, shared between this session, the host desktop, and the
//! devices watching.
//!
//! # Three clipboards, one history
//!
//! A copy can happen in three places, and until now none of them could see
//! the others. An application inside lwfa owns a `wl_data_source`; an X11
//! application under Xwayland owns the `CLIPBOARD` selection; the desktop
//! outside lwfa has its own selection entirely, because a nested compositor
//! is just another client and its clients' clipboards stop at its edge. A
//! tablet has a fourth, which no Wayland protocol will ever reach.
//!
//! This module is the hub. Whatever is copied anywhere is read once, stored
//! here, and offered back to the other places as a compositor-owned
//! selection. The history that falls out of that is not a side feature: it
//! is the same store, and showing it costs a panel rather than a subsystem.
//!
//! # Why the bytes are read eagerly
//!
//! A selection is normally lazy. The owner advertises types and hands over
//! bytes only when somebody pastes, which is right, and which is exactly
//! what cannot be forwarded: the application that owns it is on the wrong
//! side of a socket the pasting program cannot reach, and by the time
//! anyone pastes it may have exited. So a copy is read when it happens,
//! capped at [`MAX_ENTRY`], and anything larger is left alone rather than
//! half-carried.
//!
//! # Loops
//!
//! Mirroring in three directions invites an obvious disaster: setting the
//! host clipboard makes the host announce a change, which arrives here as a
//! copy, which is mirrored back. Every entry therefore carries a hash of
//! what it holds, and a capture whose hash matches what is already current
//! is dropped on arrival. The mirrors settle after one pass instead of
//! ringing.
//!
//! # What is not kept
//!
//! Nothing is written to a durable directory. Text lives in memory and
//! anything larger spills to `$XDG_RUNTIME_DIR/lwfa/clip`, which is a
//! tmpfs: an engine restart forgets the history and a reboot destroys it.
//! Clipboards carry passwords, and a password manager's copy is skipped
//! entirely (see [`is_secret`]). Files sent from a device are the one
//! exception, and only because they were already going to `~/Uploads` on
//! purpose; those are referenced where they lie rather than copied here.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lwfa_proto::{ClipItem, ClipKind, ClipOrigin, ToShell};

/// How many entries the history holds before the oldest is forgotten.
const MAX_ENTRIES: usize = 100;

/// The largest single copy worth carrying between clipboards.
///
/// Generous for text and screenshots, and short of the point where reading
/// a copy nobody will paste costs real memory. Anything above it is left
/// with its owner: the copy still works where it was made.
const MAX_ENTRY: u64 = 32 * 1024 * 1024;

/// Total spilled bytes before the oldest spill files are reclaimed.
const MAX_SPILL: u64 = 256 * 1024 * 1024;

/// How much of a text entry travels with its row in the panel.
///
/// Small on purpose: a page of twenty rows crosses a mobile connection, and
/// a copied log file is not a preview. Rows shorter than this carry all of
/// themselves, which is the common case and lets the panel put them on the
/// device clipboard without asking for anything.
const PREVIEW_CHARS: usize = 512;

/// Types worth taking, best first.
///
/// Order is a judgement about what somebody meant to copy. Images win over
/// the text that accompanies them, because an application offering both is
/// describing one picture two ways and the picture is the thing. `text/html`
/// is deliberately absent: it is offered alongside plain text by every
/// browser, and taking it would put markup on the tablet's clipboard.
const WANTED: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/svg+xml",
    "text/uri-list",
    "text/plain;charset=utf-8",
    "text/plain;charset=UTF-8",
    "UTF8_STRING",
    "text/plain",
    "STRING",
    "TEXT",
];

/// The marker password managers put on a selection they do not want kept.
///
/// A KDE convention that everything else adopted, including 1Password and
/// KeePassXC. Honouring it is the difference between a clipboard history
/// and a plaintext password file.
const SECRET_HINTS: &[&str] = &[
    "x-kde-passwordManagerHint",
    "application/x-nextcloud-talk",
    "x-kde-passwordmanagerhint",
];

/// Shared with the HTTP threads that serve entry bytes, so `GET /clip` can
/// answer without a round trip through the compositor.
pub type Store = Arc<Mutex<Clipboard>>;

pub fn store() -> Store {
    Arc::new(Mutex::new(Clipboard::new()))
}

/// A copy that happened somewhere, on its way into the history.
#[derive(Debug)]
pub struct Capture {
    pub from: Where,
    /// Which device sent it, when it came from one.
    pub device: Option<String>,
    /// The type `bytes` are in, chosen from what the source offered.
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// Which clipboard a copy came from.
///
/// Finer than [`ClipOrigin`], which is what the panel shows, because
/// mirroring needs to know precisely where *not* to send a copy back to.
/// A Wayland client that still owns its selection is also the one case
/// where the compositor deliberately does not take ownership: its own
/// clients can already read it from each other, and a lazy selection
/// answered by the program that made it is better than a copy of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Where {
    /// A Wayland client inside this session.
    Wayland,
    /// An X11 client under Xwayland.
    X11,
    /// The desktop outside lwfa.
    Desktop,
    /// A connected client device.
    Device,
}

impl Where {
    pub fn origin(self) -> ClipOrigin {
        match self {
            Self::Wayland | Self::X11 => ClipOrigin::Lwfa,
            Self::Desktop => ClipOrigin::Desktop,
            Self::Device => ClipOrigin::Device,
        }
    }
}

/// A file that arrived from a device and now lives in `~/Uploads`.
///
/// Kept apart from [`Capture`] because the bytes are already somewhere
/// real: copying them into the spill directory would double the disk cost
/// of every photo sent from a tablet for no gain.
#[derive(Debug)]
pub struct Arrival {
    pub device: Option<String>,
    pub path: PathBuf,
    pub mime: String,
    pub bytes: u64,
}

/// Where an entry's bytes actually are.
#[derive(Debug)]
enum Body {
    Text(Arc<str>),
    /// A file holding the bytes. `owned` files are ours to delete when the
    /// entry is evicted; a file in `~/Uploads` is not.
    File { path: PathBuf, owned: bool },
}

#[derive(Debug)]
struct Entry {
    item: ClipItem,
    /// Of the stored bytes, so a mirror cannot hand us back our own copy
    /// and have it read as a new one.
    hash: u64,
    /// What to advertise when this entry is the selection.
    mimes: Vec<String>,
    /// The files this entry names, for a `text/uri-list`.
    paths: Vec<PathBuf>,
    body: Body,
}

pub struct Clipboard {
    /// Newest first. The front is what is on the clipboard now.
    entries: VecDeque<Entry>,
    next_id: u64,
    spill: PathBuf,
    spilled: u64,
}

impl Clipboard {
    pub fn new() -> Self {
        let spill = spill_dir();
        // A stale directory from a previous run holds bytes nobody can
        // reach any more, since the ids that named them are gone.
        let _ = std::fs::remove_dir_all(&spill);
        Self {
            entries: VecDeque::new(),
            next_id: 1,
            spill,
            spilled: 0,
        }
    }

    /// Take a copy into the history, unless it is what we already hold.
    ///
    /// `None` means nothing changed and nothing should be mirrored: either
    /// the bytes are already current, or they were refused.
    pub fn capture(&mut self, capture: Capture) -> Option<ClipItem> {
        if capture.bytes.is_empty() || capture.bytes.len() as u64 > MAX_ENTRY {
            return None;
        }
        let hash = hash_of(&capture.bytes);
        if self.entries.front().is_some_and(|e| e.hash == hash) {
            return None;
        }

        let id = self.take_id();
        let mime = normalise(&capture.mime);
        let kind = kind_of(&mime);
        let (paths, body, preview, whole, bytes) = match kind {
            ClipKind::Text => {
                let text = String::from_utf8_lossy(&capture.bytes).into_owned();
                let (preview, whole) = shorten(&text);
                let bytes = text.len() as u64;
                (Vec::new(), Body::Text(text.into()), preview, whole, bytes)
            }
            ClipKind::Files => {
                let text = String::from_utf8_lossy(&capture.bytes).into_owned();
                let paths = paths_in(&text);
                // What the panel should show for files is how big they
                // are, not the length of the sentence naming them.
                let bytes = size_on_disk(&paths).unwrap_or(text.len() as u64);
                // One file that exists is served *as that file*, whatever
                // it holds: copying a PDF in a file manager and downloading
                // it on the tablet should produce the PDF, not the sentence
                // pointing at it. Several, or one that has since moved, and
                // the list itself is all there is.
                let body = match single(&paths) {
                    Some(only) if only.is_file() => Body::File {
                        path: only.clone(),
                        owned: false,
                    },
                    _ => Body::Text(text.into()),
                };
                let name = name_files(&paths);
                (paths, body, name, false, bytes)
            }
            ClipKind::Image => {
                let bytes = capture.bytes.len() as u64;
                let path = self.spill_to(id, &capture.bytes)?;
                (
                    Vec::new(),
                    Body::File { path, owned: true },
                    default_name(id, &mime),
                    false,
                    bytes,
                )
            }
        };

        let (width, height) = match kind {
            ClipKind::Image => measure(&capture.bytes),
            _ => (None, None),
        };

        let item = ClipItem {
            id,
            at: now_millis(),
            origin: capture.from.origin(),
            device: capture.device,
            kind,
            bytes,
            mime: match single(&paths) {
                Some(only) => crate::preview::mime_for(only).to_string(),
                None => mime.clone(),
            },
            preview,
            whole,
            width,
            height,
            path: single(&paths).map(|p| p.display().to_string()),
        };
        self.push(Entry {
            mimes: offered_for(kind, &mime),
            item: item.clone(),
            hash,
            paths,
            body,
        });
        Some(item)
    }

    /// Take a file that arrived from a device and now lives in `~/Uploads`.
    pub fn arrived(&mut self, arrival: Arrival) -> Option<ClipItem> {
        let id = self.take_id();
        // A file is a file whatever it holds. `kind_of` would call a PDF
        // text, because on a clipboard `application/pdf` would *be* a blob
        // of bytes rather than something sitting on the disk.
        let kind = if arrival.mime.starts_with("image/") {
            ClipKind::Image
        } else {
            ClipKind::Files
        };
        let name = arrival
            .path
            .file_name()
            .map_or_else(|| format!("file-{id}"), |n| n.to_string_lossy().into_owned());
        let uris = uri_list(std::slice::from_ref(&arrival.path));
        let (width, height) = match kind {
            ClipKind::Image => read_and_measure(&arrival.path),
            _ => (None, None),
        };

        let item = ClipItem {
            id,
            at: now_millis(),
            origin: ClipOrigin::Device,
            device: arrival.device,
            kind,
            bytes: arrival.bytes,
            mime: arrival.mime.clone(),
            preview: name,
            whole: false,
            width,
            height,
            path: Some(arrival.path.display().to_string()),
        };
        self.push(Entry {
            hash: hash_of(uris.as_bytes()),
            mimes: offered_for_file(&arrival.mime),
            item: item.clone(),
            paths: vec![arrival.path.clone()],
            body: Body::File {
                path: arrival.path,
                owned: false,
            },
        });
        Some(item)
    }

    /// Put an entry that is already here back on the clipboard.
    ///
    /// It keeps its id and moves to the front with a fresh timestamp, so
    /// one message covers both "this is new" and "this is current again".
    pub fn touch(&mut self, id: u64) -> Option<ClipItem> {
        let at = self.entries.iter().position(|e| e.item.id == id)?;
        let mut entry = self.entries.remove(at)?;
        entry.item.at = now_millis();
        let item = entry.item.clone();
        self.entries.push_front(entry);
        Some(item)
    }

    /// One page of history, oldest-bound by `before`.
    ///
    /// A cursor rather than an offset: ids descend with age, so an entry
    /// arriving between two pages cannot make a row repeat or vanish.
    pub fn page(&self, before: Option<u64>, limit: usize) -> (Vec<ClipItem>, bool) {
        let rest: Vec<&Entry> = match before {
            None => self.entries.iter().collect(),
            Some(cursor) => self
                .entries
                .iter()
                .skip_while(|e| e.item.id != cursor)
                .skip(1)
                .collect(),
        };
        let items = rest.iter().take(limit).map(|e| e.item.clone()).collect();
        (items, rest.len() > limit)
    }

    pub fn forget(&mut self, id: u64) -> bool {
        let Some(at) = self.entries.iter().position(|e| e.item.id == id) else {
            return false;
        };
        if let Some(entry) = self.entries.remove(at) {
            self.reclaim(&entry);
        }
        true
    }

    pub fn clear(&mut self) {
        while let Some(entry) = self.entries.pop_front() {
            self.reclaim(&entry);
        }
    }

    /// What the current entry should be advertised as, if there is one.
    pub fn current(&self) -> Option<(u64, Vec<String>)> {
        let entry = self.entries.front()?;
        Some((entry.item.id, entry.mimes.clone()))
    }

    /// The bytes to hand somebody pasting `mime` from entry `id`.
    ///
    /// Reads from wherever they are: memory for text, `~/Uploads` for a
    /// file from a device, the spill directory for anything else. A
    /// `text/uri-list` is composed rather than stored, so a photo sent from
    /// a tablet can be pasted into an image editor *and* dropped into a
    /// file manager without keeping two copies of it.
    pub fn bytes_for(&self, id: u64, mime: &str) -> Option<Vec<u8>> {
        let entry = self.entries.iter().find(|e| e.item.id == id)?;
        if mime == "text/uri-list" && !entry.paths.is_empty() {
            return Some(uri_list(&entry.paths).into_bytes());
        }
        if is_text(mime) && entry.item.kind != ClipKind::Text && !entry.paths.is_empty() {
            // Pasting a file into a text field should give its path, which
            // is what every file manager on this desktop already does.
            let joined = entry
                .paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("\n");
            return Some(joined.into_bytes());
        }
        match &entry.body {
            Body::Text(text) => Some(text.as_bytes().to_vec()),
            Body::File { path, .. } => std::fs::read(path).ok(),
        }
    }

    /// Where an entry's bytes live, for the HTTP route to stream from.
    ///
    /// Returns the text inline instead when that is all there is, because
    /// spilling a URL to disk so a socket can read it back is silly.
    pub fn serve(&self, id: u64) -> Option<Served> {
        let entry = self.entries.iter().find(|e| e.item.id == id)?;
        let name = download_name(&entry.item);
        match &entry.body {
            Body::Text(text) => Some(Served::Inline {
                mime: entry.item.mime.clone(),
                name,
                bytes: text.as_bytes().to_vec(),
            }),
            Body::File { path, .. } => Some(Served::File {
                mime: entry.item.mime.clone(),
                name,
                path: path.clone(),
            }),
        }
    }

    fn push(&mut self, entry: Entry) {
        self.entries.push_front(entry);
        while self.entries.len() > MAX_ENTRIES || self.spilled > MAX_SPILL {
            let Some(oldest) = self.entries.pop_back() else {
                break;
            };
            self.reclaim(&oldest);
        }
    }

    fn reclaim(&mut self, entry: &Entry) {
        if let Body::File { path, owned: true } = &entry.body {
            self.spilled = self.spilled.saturating_sub(entry.item.bytes);
            let _ = std::fs::remove_file(path);
        }
    }

    fn spill_to(&mut self, id: u64, bytes: &[u8]) -> Option<PathBuf> {
        if let Err(err) = std::fs::create_dir_all(&self.spill) {
            tracing::warn!("no clipboard spill directory: {err}");
            return None;
        }
        restrict(&self.spill);
        let path = self.spill.join(id.to_string());
        if let Err(err) = std::fs::write(&path, bytes) {
            tracing::warn!("could not hold a clipboard entry: {err}");
            return None;
        }
        restrict(&path);
        self.spilled += bytes.len() as u64;
        Some(path)
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

impl Default for Clipboard {
    fn default() -> Self {
        Self::new()
    }
}

/// How `GET /clip` should answer for an entry.
pub enum Served {
    Inline {
        mime: String,
        name: String,
        bytes: Vec<u8>,
    },
    File {
        mime: String,
        name: String,
        path: PathBuf,
    },
}

// ---------------------------------------------------------------------------
// Choosing what to take, and what to offer
// ---------------------------------------------------------------------------

/// The best type to take from what a source offered, if any is worth taking.
///
/// `None` for a selection nothing here understands, and for one a password
/// manager marked private.
pub fn best_mime(offered: &[String]) -> Option<String> {
    if offered.iter().any(|m| is_secret(m)) {
        return None;
    }
    WANTED
        .iter()
        .find(|wanted| offered.iter().any(|m| m == *wanted))
        .map(|wanted| (*wanted).to_string())
}

/// Whether a type is a password manager saying "do not keep this".
pub fn is_secret(mime: &str) -> bool {
    SECRET_HINTS.iter().any(|hint| mime.contains(hint))
}

/// What to advertise when the compositor owns the selection.
///
/// More types than were captured, all backed by the same bytes. X11
/// programs ask for `UTF8_STRING` and `STRING`, GTK asks for
/// `text/plain;charset=utf-8`, and a program that asks for the one type it
/// knows and is told no simply pastes nothing.
fn offered_for(kind: ClipKind, mime: &str) -> Vec<String> {
    let text = [
        "text/plain;charset=utf-8",
        "text/plain",
        "UTF8_STRING",
        "STRING",
        "TEXT",
    ];
    match kind {
        ClipKind::Text => text.iter().map(|m| (*m).to_string()).collect(),
        ClipKind::Image => vec![mime.to_string()],
        ClipKind::Files => std::iter::once("text/uri-list".to_string())
            .chain(text.iter().map(|m| (*m).to_string()))
            .collect(),
    }
}

/// What to advertise for something that exists as a file on the machine.
///
/// Its own type first, so pasting into an editor gets the picture or the
/// document rather than a path; then `text/uri-list`, so dropping it into a
/// file manager copies the file itself; then plain text, so a terminal gets
/// something it can act on. All three from one file on disk.
fn offered_for_file(mime: &str) -> Vec<String> {
    let mut offered = vec![mime.to_string()];
    for also in ["text/uri-list", "text/plain;charset=utf-8", "text/plain"] {
        if !offered.iter().any(|m| m == also) {
            offered.push(also.to_string());
        }
    }
    offered
}

/// The total size of the files an entry names, when they can all be read.
fn size_on_disk(paths: &[PathBuf]) -> Option<u64> {
    if paths.is_empty() {
        return None;
    }
    paths
        .iter()
        .map(|path| std::fs::metadata(path).ok().map(|meta| meta.len()))
        .sum()
}

fn kind_of(mime: &str) -> ClipKind {
    if mime.starts_with("image/") {
        ClipKind::Image
    } else if mime == "text/uri-list" {
        ClipKind::Files
    } else {
        ClipKind::Text
    }
}

fn is_text(mime: &str) -> bool {
    mime.starts_with("text/") || matches!(mime, "UTF8_STRING" | "STRING" | "TEXT")
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/// The start of a text entry, and whether that is all of it.
fn shorten(text: &str) -> (String, bool) {
    match text.char_indices().nth(PREVIEW_CHARS) {
        None => (text.to_string(), true),
        Some((at, _)) => (text[..at].to_string(), false),
    }
}

/// A name for the files an entry points at.
fn name_files(paths: &[PathBuf]) -> String {
    let first = paths
        .first()
        .and_then(|p| p.file_name())
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    match paths.len() {
        0 | 1 => first,
        n => format!("{first} and {} more", n - 1),
    }
}

/// What to call an image that only ever existed on a clipboard.
fn default_name(id: u64, mime: &str) -> String {
    format!("clipboard-{id}.{}", extension_for(mime))
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "text/uri-list" => "uri",
        _ if mime.starts_with("image/") => "png",
        _ => "txt",
    }
}

/// The filename a download should land under.
fn download_name(item: &ClipItem) -> String {
    match item.kind {
        ClipKind::Text => format!("clipboard-{}.txt", item.id),
        _ => {
            let name = item.preview.trim();
            if name.is_empty() || name.contains('/') {
                default_name(item.id, &item.mime)
            } else {
                name.to_string()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// URI lists
// ---------------------------------------------------------------------------

/// The paths a `text/uri-list` names, ignoring anything that is not a file.
///
/// Comment lines start with `#`, per RFC 2483, and remote URIs are dropped
/// rather than guessed at: `https://` on the clipboard is a link, and a
/// link is text.
fn paths_in(list: &str) -> Vec<PathBuf> {
    list.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.strip_prefix("file://"))
        .map(|rest| PathBuf::from(unescape(rest)))
        .collect()
}

fn uri_list(paths: &[PathBuf]) -> String {
    let mut out = String::new();
    for path in paths {
        out.push_str("file://");
        out.push_str(&escape(&path.display().to_string()));
        out.push_str("\r\n");
    }
    out
}

/// Percent-decode, leaving anything malformed exactly as it was.
fn unescape(text: &str) -> String {
    let raw = text.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut at = 0;
    while at < raw.len() {
        match (raw[at], raw.get(at + 1), raw.get(at + 2)) {
            (b'%', Some(hi), Some(lo)) => match (hex(*hi), hex(*lo)) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    at += 3;
                }
                _ => {
                    out.push(raw[at]);
                    at += 1;
                }
            },
            _ => {
                out.push(raw[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn single(paths: &[PathBuf]) -> Option<&PathBuf> {
    match paths {
        [only] => Some(only),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/// An image's pixel size, so the panel can reserve its space before the
/// thumbnail arrives and the row does not jump when it does.
fn measure(bytes: &[u8]) -> (Option<u32>, Option<u32>) {
    match image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format() {
        Ok(reader) => match reader.into_dimensions() {
            Ok((width, height)) => (Some(width), Some(height)),
            Err(_) => (None, None),
        },
        Err(_) => (None, None),
    }
}

/// The same, for a file, reading only as far as the header.
fn read_and_measure(path: &Path) -> (Option<u32>, Option<u32>) {
    let Ok(file) = std::fs::File::open(path) else {
        return (None, None);
    };
    let mut head = Vec::new();
    if std::io::BufReader::new(file)
        .take(64 * 1024)
        .read_to_end(&mut head)
        .is_err()
    {
        return (None, None);
    }
    measure(&head)
}

/// Identifies a copy by its contents alone.
///
/// Deliberately not by its type as well. The same copy comes back from the
/// host as `text/plain;charset=utf-8` after going out as `UTF8_STRING`,
/// because each clipboard names things its own way, and hashing the name
/// alongside the bytes would file one copy twice on every round trip.
fn hash_of(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// The one name for text, whatever a program called it.
///
/// X11 asks for `UTF8_STRING`, GTK for `text/plain;charset=utf-8`, and old
/// programs for `STRING`. They all mean the same bytes, and letting the
/// caller's spelling reach the panel would put `STRING` in a `Content-Type`
/// header where no browser would know what to do with it.
fn normalise(mime: &str) -> String {
    if is_text(mime) && !mime.starts_with("text/uri-list") {
        "text/plain;charset=utf-8".to_string()
    } else {
        mime.to_string()
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// `$XDG_RUNTIME_DIR/lwfa/clip`, which is a tmpfs on every system that sets
/// the variable. The fallback is the same shape under `/tmp`.
fn spill_dir() -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("lwfa/clip")
}

/// Owner-only. The spill directory holds whatever the user copied, and this
/// machine has other logins.
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    let mode = if meta.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

// ---------------------------------------------------------------------------
// The compositor's side
//
// Everything above is a store and knows nothing about Wayland. This is where
// a copy is read from whoever made it, and offered back to everyone else.
// ---------------------------------------------------------------------------

/// What a compositor-owned selection carries, so a paste can be answered.
///
/// Smithay hands this back verbatim in `send_selection`, which is the only
/// way to know *which* entry a program is asking to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token(pub u64);

/// Read a selection somebody offered, without stalling the compositor.
///
/// The program that owns a selection writes into a pipe when asked, and it
/// writes at its own pace: a slow one, or a malicious one, would freeze
/// every window on the desktop if the compositor waited on the read. So the
/// read happens on a thread of its own and the result arrives back through
/// the same channel the shell's events use.
///
/// The write end must already have been handed to the owner before this is
/// called, or the read sees end-of-file immediately.
pub fn read_offer(
    reader: std::io::PipeReader,
    mime: String,
    from: Where,
    device: Option<String>,
    events: calloop::channel::Sender<crate::shell::ShellEvent>,
) {
    let spawned = std::thread::Builder::new()
        .name("lwfa-clip-read".to_string())
        .spawn(move || {
            let mut bytes = Vec::new();
            // One more than the cap, so an oversized copy is recognised as
            // oversized rather than silently truncated to the limit.
            let mut limited = reader.take(MAX_ENTRY + 1);
            if let Err(err) = limited.read_to_end(&mut bytes) {
                tracing::debug!("clipboard read from {from:?} ended early: {err}");
                return;
            }
            if bytes.is_empty() {
                return;
            }
            let _ = events.send(crate::shell::ShellEvent::Clip(Capture {
                from,
                device,
                mime,
                bytes,
            }));
        });
    if let Err(err) = spawned {
        tracing::warn!("could not read a clipboard offer: {err}");
    }
}

/// Answer a paste by writing an entry's bytes into the pipe it asked for.
///
/// Also on a thread, and for the mirror-image reason: a pipe holds 64KB and
/// the program reading it may be busy, so writing a screenshot inline would
/// block the compositor until it caught up.
pub fn write_offer(mut writer: std::io::PipeWriter, bytes: Vec<u8>) {
    let spawned = std::thread::Builder::new()
        .name("lwfa-clip-write".to_string())
        .spawn(move || {
            // A program that asks for a paste and then goes away leaves a
            // broken pipe. Expected, not an error.
            if let Err(err) = writer.write_all(&bytes) {
                tracing::debug!("clipboard paste was not read to the end: {err}");
            }
        });
    if let Err(err) = spawned {
        tracing::warn!("could not answer a paste: {err}");
    }
}

impl crate::state::Lwfa {
    /// A copy arrived from somewhere. Keep it, and offer it everywhere else.
    pub fn clip_captured(&mut self, capture: Capture) {
        let from = capture.from;
        let Some(item) = self.clipboard.lock().unwrap().capture(capture) else {
            return;
        };
        self.clip_took(item, from);
    }

    /// A file finished arriving on a device's clipboard channel.
    pub fn clip_arrived(&mut self, arrival: Arrival) {
        let Some(item) = self.clipboard.lock().unwrap().arrived(arrival) else {
            return;
        };
        self.clip_took(item, Where::Device);
    }

    fn clip_took(&mut self, item: ClipItem, from: Where) {
        tracing::debug!(
            "clipboard: {:?} {} from {from:?} ({} bytes)",
            item.kind,
            item.mime,
            item.bytes
        );
        self.clip_offer(item.id, from);
        self.clip_tell(ToShell::ClipAdded { item });
    }

    /// Offer entry `id` to every clipboard except the one it came from.
    fn clip_offer(&mut self, id: u64, from: Where) {
        let mimes = {
            let board = self.clipboard.lock().unwrap();
            match board.current() {
                Some((current, mimes)) if current == id => mimes,
                // Something newer landed in the same breath. That copy is
                // the one being offered, so this one has nothing to do.
                _ => return,
            }
        };

        // Wayland clients inside the session. Skipped when one of them owns
        // the selection already: theirs is the original, and taking it over
        // would replace a lazy offer with our capped copy of it.
        if from != Where::Wayland {
            smithay::wayland::selection::data_device::set_data_device_selection(
                &self.display_handle,
                &self.seat,
                mimes.clone(),
                Token(id),
            );
        }

        // X11 clients. Xwayland is told we own `CLIPBOARD` now, and comes
        // back through `send_selection` when an X program pastes.
        if from != Where::X11
            && let Some(xwm) = self.xwm.as_mut()
            && let Err(err) = xwm.new_selection(
                smithay::wayland::selection::SelectionTarget::Clipboard,
                Some(mimes.clone()),
            )
        {
            tracing::warn!("could not offer the clipboard to X11: {err}");
        }

        // The desktop outside.
        if from != Where::Desktop && let Some(host) = self.host_clip.as_ref() {
            let bytes = self.clipboard.lock().unwrap().bytes_for(id, &mimes[0]);
            if let Some(bytes) = bytes {
                host.offer(mimes, bytes);
            }
        }
    }

    /// Tell every session that may use the clipboard.
    ///
    /// A view-only session is not one of them: it may not paste into the
    /// machine, and a history of everything the owner copies is exactly the
    /// thing not to hand somebody who was only lent a screen.
    fn clip_tell(&self, message: ToShell) {
        let sessions: Vec<lwfa_proto::SessionId> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.permissions.may_interact())
            .map(|(id, _)| *id)
            .collect();
        for session in sessions {
            self.send_to_session(session, message.clone());
        }
    }

    /// The bytes for a paste, whoever is asking.
    pub fn clip_bytes(&self, id: u64, mime: &str) -> Option<Vec<u8>> {
        self.clipboard.lock().unwrap().bytes_for(id, mime)
    }

    // -- what the shell asks for -------------------------------------------

    // -- the channel a device sends files on ------------------------------

    /// Give a session what it needs to use the clipboard.
    ///
    /// Two things the session socket cannot do: fetch an entry's bytes over
    /// HTTP, and send a file the other way. Both are authorised by one
    /// ticket, minted here and dying with the connection, so the account
    /// password never appears in a URL.
    ///
    /// A view-only session is given nothing and told nothing. It cannot
    /// paste into the machine, and a running list of everything the owner
    /// copies is the last thing to hand somebody lent a screen.
    pub fn clip_open(&mut self, session: lwfa_proto::SessionId) {
        if !self
            .sessions
            .get(&session)
            .is_some_and(|s| s.permissions.may_interact())
        {
            return;
        }
        // Called again when a session is granted the right it did not have
        // at connect, so any earlier channel goes first rather than being
        // orphaned in the gate map with nobody left to use it.
        self.clip_close(session);
        let Ok(ticket) = crate::auth::generate_token() else {
            tracing::warn!("could not mint a clipboard ticket for session {session}");
            return;
        };
        let channel = self.next_file_request;
        self.next_file_request += 1;
        self.upload_gates.lock().unwrap().insert(
            channel,
            crate::upload::Gate {
                ticket: ticket.clone(),
                cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                partial_dir: crate::upload::partial_dir(channel),
                roots: std::collections::HashMap::new(),
                attached: false,
            },
        );
        self.clip_channels.insert(session, channel);
        self.send_to_session(session, ToShell::ClipReady { channel, ticket });
    }

    /// The session went away. Its ticket stops working immediately.
    pub fn clip_close(&mut self, session: lwfa_proto::SessionId) {
        if let Some(channel) = self.clip_channels.remove(&session) {
            self.drop_file_gate(channel);
        }
    }

    /// Whether an upload was sent to a clipboard channel rather than a dialog.
    pub fn clip_is_channel(&self, request: u64) -> bool {
        self.clip_channels.values().any(|channel| *channel == request)
    }

    /// A file arrived from a device. It stays in `~/Uploads`, and goes on
    /// the clipboard so it can be pasted straight into something.
    pub fn clip_uploaded(&mut self, finished: crate::upload::Finished) {
        let device = self
            .clip_channels
            .iter()
            .find(|(_, channel)| **channel == finished.request)
            .and_then(|(session, _)| self.sessions.get(session))
            .map(|session| session.device.clone());
        let bytes = std::fs::metadata(&finished.path).map_or(0, |meta| meta.len());
        self.clip_arrived(Arrival {
            device,
            mime: crate::preview::mime_for(&finished.path).to_string(),
            path: finished.path,
            bytes,
        });
    }

    pub fn clip_page(&self, session: lwfa_proto::SessionId, request: u64, before: Option<u64>, limit: u32) {
        // A page nobody bounded would be the whole history in one message.
        let limit = (limit as usize).clamp(1, MAX_ENTRIES);
        let (items, more) = self.clipboard.lock().unwrap().page(before, limit);
        self.send_to_session(session, ToShell::ClipHistory { request, items, more });
    }

    pub fn clip_set_text(&mut self, session: lwfa_proto::SessionId, text: String) {
        let device = self.sessions.get(&session).map(|s| s.device.clone());
        self.clip_captured(Capture {
            from: Where::Device,
            device,
            mime: "text/plain;charset=utf-8".to_string(),
            bytes: text.into_bytes(),
        });
    }

    pub fn clip_use(&mut self, id: u64) {
        let Some(item) = self.clipboard.lock().unwrap().touch(id) else {
            return;
        };
        // No origin to skip: this is a fresh decision, and every clipboard
        // should end up holding it.
        self.clip_offer(id, Where::Device);
        self.clip_tell(ToShell::ClipAdded { item });
    }

    pub fn clip_forget(&mut self, id: u64) {
        if self.clipboard.lock().unwrap().forget(id) {
            self.clip_tell(ToShell::ClipDropped { id });
        }
    }

    pub fn clip_clear(&mut self) {
        self.clipboard.lock().unwrap().clear();
        // Stop offering what no longer exists. An X11 program that pastes
        // after this gets nothing, which is the honest answer.
        smithay::wayland::selection::data_device::clear_data_device_selection(
            &self.display_handle,
            &self.seat,
        );
        if let Some(xwm) = self.xwm.as_mut()
            && let Err(err) = xwm.new_selection(
                smithay::wayland::selection::SelectionTarget::Clipboard,
                None,
            )
        {
            tracing::debug!("could not withdraw the X11 clipboard: {err}");
        }
        if let Some(host) = self.host_clip.as_ref() {
            host.withdraw();
        }
        self.clip_tell(ToShell::ClipCleared);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(body: &str) -> Capture {
        Capture {
            from: Where::Wayland,
            device: None,
            mime: "text/plain;charset=utf-8".to_string(),
            bytes: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn an_image_beats_the_text_offered_alongside_it() {
        // Firefox offers both when you copy a picture. Taking the text
        // would put "the-cat.jpg" on the tablet instead of the cat.
        let offered = ["text/html", "text/plain", "image/png"].map(String::from);
        assert_eq!(best_mime(&offered).as_deref(), Some("image/png"));
    }

    #[test]
    fn a_password_managers_copy_is_not_taken_at_all() {
        let offered =
            ["text/plain;charset=utf-8", "x-kde-passwordManagerHint"].map(String::from);
        assert_eq!(best_mime(&offered), None);
    }

    #[test]
    fn a_selection_of_types_we_cannot_use_is_left_alone() {
        let offered = ["application/x-libreoffice-internal"].map(String::from);
        assert_eq!(best_mime(&offered), None);
    }

    #[test]
    fn the_same_copy_arriving_twice_is_ignored() {
        // The whole loop-breaking story in one assertion: mirroring an
        // entry to the host makes the host announce it back.
        let mut board = Clipboard::new();
        assert!(board.capture(text("hello")).is_some());
        assert!(board.capture(text("hello")).is_none());
        assert!(board.capture(text("goodbye")).is_some());
        // And the older one is not blocked by having been seen before: only
        // what is current counts, or a two-entry alternation would stall.
        assert!(board.capture(text("hello")).is_some());
    }

    #[test]
    fn short_text_carries_all_of_itself() {
        let mut board = Clipboard::new();
        let item = board.capture(text("a URL, say")).unwrap();
        assert!(item.whole);
        assert_eq!(item.preview, "a URL, say");
    }

    #[test]
    fn long_text_carries_a_prefix_and_says_so() {
        let mut board = Clipboard::new();
        let long = "x".repeat(PREVIEW_CHARS * 3);
        let item = board.capture(text(&long)).unwrap();
        assert!(!item.whole);
        assert_eq!(item.preview.chars().count(), PREVIEW_CHARS);
        assert_eq!(item.bytes, long.len() as u64);
    }

    #[test]
    fn a_prefix_never_splits_a_character() {
        let mut board = Clipboard::new();
        // Multi-byte throughout: a byte-wise cut here would panic.
        let item = board.capture(text(&"日".repeat(PREVIEW_CHARS + 10))).unwrap();
        assert_eq!(item.preview.chars().count(), PREVIEW_CHARS);
    }

    #[test]
    fn pages_walk_backwards_without_repeating_a_row() {
        let mut board = Clipboard::new();
        for n in 0..10 {
            board.capture(text(&format!("entry {n}"))).unwrap();
        }
        let (first, more) = board.page(None, 4);
        assert_eq!(first.len(), 4);
        assert!(more);
        let cursor = first.last().unwrap().id;
        let (second, more) = board.page(Some(cursor), 4);
        assert!(more);
        assert!(second.iter().all(|item| !first.iter().any(|f| f.id == item.id)));
        let (third, more) = board.page(Some(second.last().unwrap().id), 4);
        assert_eq!(third.len(), 2);
        assert!(!more);
    }

    #[test]
    fn a_page_taken_after_the_cursor_was_forgotten_is_empty_not_wrong() {
        // Better to show nothing and let the panel reload than to silently
        // restart from the newest row, which reads as duplicates.
        let mut board = Clipboard::new();
        board.capture(text("one")).unwrap();
        let gone = board.capture(text("two")).unwrap().id;
        board.forget(gone);
        let (items, more) = board.page(Some(gone), 10);
        assert!(items.is_empty());
        assert!(!more);
    }

    #[test]
    fn the_history_stops_growing() {
        let mut board = Clipboard::new();
        for n in 0..MAX_ENTRIES + 25 {
            board.capture(text(&format!("entry {n}"))).unwrap();
        }
        assert_eq!(board.entries.len(), MAX_ENTRIES);
        let (newest, _) = board.page(None, 1);
        assert_eq!(newest[0].preview, format!("entry {}", MAX_ENTRIES + 24));
    }

    #[test]
    fn using_an_old_entry_moves_it_to_the_front_and_keeps_its_id() {
        let mut board = Clipboard::new();
        let first = board.capture(text("one")).unwrap().id;
        board.capture(text("two")).unwrap();
        let again = board.touch(first).unwrap();
        assert_eq!(again.id, first);
        assert_eq!(board.page(None, 1).0[0].id, first);
        assert_eq!(board.current().unwrap().0, first);
    }

    #[test]
    fn an_oversized_copy_is_left_with_whoever_owns_it() {
        let mut board = Clipboard::new();
        let huge = Capture {
            from: Where::Wayland,
            device: None,
            mime: "image/png".to_string(),
            bytes: vec![0; MAX_ENTRY as usize + 1],
        };
        assert!(board.capture(huge).is_none());
    }

    #[test]
    fn a_file_list_reads_as_files_and_names_the_first() {
        let mut board = Clipboard::new();
        let item = board
            .capture(Capture {
                from: Where::Desktop,
                device: None,
                mime: "text/uri-list".to_string(),
                bytes: b"file:///home/user/a%20photo.png\r\nfile:///home/user/b.png\r\n".to_vec(),
            })
            .unwrap();
        assert_eq!(item.kind, ClipKind::Files);
        assert_eq!(item.preview, "a photo.png and 1 more");
        // Two files, so no single path to download.
        assert_eq!(item.path, None);
    }

    #[test]
    fn a_single_file_can_be_downloaded_and_pastes_as_its_path() {
        let mut board = Clipboard::new();
        let item = board
            .capture(Capture {
                from: Where::Desktop,
                device: None,
                mime: "text/uri-list".to_string(),
                bytes: b"file:///home/user/notes.md\r\n".to_vec(),
            })
            .unwrap();
        assert_eq!(item.path.as_deref(), Some("/home/user/notes.md"));
        let pasted = board.bytes_for(item.id, "text/plain").unwrap();
        assert_eq!(pasted, b"/home/user/notes.md");
    }

    #[test]
    fn a_document_sent_from_a_tablet_is_a_file_not_a_wall_of_text() {
        // `application/pdf` is not an image and not `text/uri-list`, and
        // classifying it by its own type alone would have made a PDF read
        // as a text entry whose preview was binary.
        let mut board = Clipboard::new();
        let item = board
            .arrived(Arrival {
                device: Some("iPad".to_string()),
                path: PathBuf::from("/home/user/Uploads/contract.pdf"),
                mime: "application/pdf".to_string(),
                bytes: 91_204,
            })
            .unwrap();
        assert_eq!(item.kind, ClipKind::Files);
        assert_eq!(item.preview, "contract.pdf");
        assert_eq!(item.bytes, 91_204);
    }

    #[test]
    fn a_file_from_a_tablet_pastes_as_itself_and_as_its_path() {
        let mut board = Clipboard::new();
        let item = board
            .arrived(Arrival {
                device: None,
                path: PathBuf::from("/home/user/Uploads/report.odt"),
                mime: "application/vnd.oasis.opendocument.text".to_string(),
                bytes: 4096,
            })
            .unwrap();
        let (_, offered) = board.current().unwrap();
        assert_eq!(offered.first().unwrap(), "application/vnd.oasis.opendocument.text");
        assert!(offered.iter().any(|m| m == "text/uri-list"));
        assert_eq!(
            board.bytes_for(item.id, "text/uri-list").unwrap(),
            b"file:///home/user/Uploads/report.odt\r\n"
        );
    }

    #[test]
    fn a_copied_file_of_any_type_is_served_as_that_file() {
        let dir = std::env::temp_dir().join("lwfa-clip-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("archive.zip");
        let contents = b"PK\x03\x04 not really an archive";
        std::fs::write(&file, contents).unwrap();

        let mut board = Clipboard::new();
        let item = board
            .capture(Capture {
                from: Where::Desktop,
                device: None,
                mime: "text/uri-list".to_string(),
                bytes: format!("file://{}\r\n", file.display()).into_bytes(),
            })
            .unwrap();
        assert_eq!(item.kind, ClipKind::Files);
        // The size of the file, not the length of the sentence naming it.
        assert_eq!(item.bytes, contents.len() as u64);
        match board.serve(item.id).unwrap() {
            Served::File { path, name, .. } => {
                assert_eq!(path, file);
                assert_eq!(name, "archive.zip");
            }
            Served::Inline { .. } => panic!("a real file should be served from disk"),
        }
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn a_uri_list_survives_a_round_trip_through_a_space() {
        let paths = vec![PathBuf::from("/home/user/a photo.png")];
        assert_eq!(paths_in(&uri_list(&paths)), paths);
    }

    #[test]
    fn a_comment_line_is_not_a_file() {
        let parsed = paths_in("# some comment\r\nfile:///tmp/x\r\n");
        assert_eq!(parsed, vec![PathBuf::from("/tmp/x")]);
    }

    #[test]
    fn a_web_link_in_a_uri_list_is_not_treated_as_a_file() {
        assert!(paths_in("https://example.com/x.png\r\n").is_empty());
    }

    #[test]
    fn owning_a_text_selection_offers_the_types_x11_asks_for() {
        let offered = offered_for(ClipKind::Text, "text/plain;charset=utf-8");
        for wanted in ["UTF8_STRING", "STRING", "TEXT", "text/plain"] {
            assert!(offered.iter().any(|m| m == wanted), "missing {wanted}");
        }
    }
}
