//! The shell protocol.
//!
//! The wire format between the lwfa engine and its shell. The shell owns layout
//! *policy* (where windows go, how the strip scrolls, what focus means); the
//! engine owns *mechanism* (surfaces, configure, input, rendering).
//!
//! The same shell speaks this protocol whether it is running locally against
//! the native backend or remotely in a browser, which is the whole point. See
//! docs/architecture.md section 3.
//!
//! # Two rules this format exists to enforce
//!
//! **The shell never sends frames, only intents.** [`SetLayout`] carries a
//! target and optionally a [`SpringSpec`]; the engine integrates the spring
//! itself at its own refresh rate. A shell pushing a new rect every frame would
//! bake its own network jitter into the animation, and would look different
//! locally and remotely. See [`Animation`].
//!
//! **The shell never sends pixels.** It describes state and the backend
//! realises it. In v0 that state is geometry and stacking only; the wider
//! appearance vocabulary (corner radius, blur, shadow) lands in milestone 5,
//! when both backends can implement it. See [`WindowLayout`].
//!
//! # Encoding
//!
//! JSON, newline-free, one message per WebSocket text frame. Enums are
//! internally tagged on `type` and every field is camelCase, so the TypeScript
//! side in `packages/proto` maps over without a translation layer.
//!
//! JSON rather than a binary format because v0 is small, debuggable matters
//! more than compact right now, and a human can read the traffic in devtools.
//! Per-surface video is a separate transport and will not come through here.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Bumped on any breaking change to the message shapes below.
///
/// The engine sends this in [`ToShell::Hello`] and the shell is expected to
/// refuse to drive a version it does not understand, rather than silently
/// mislaying windows.
pub const PROTOCOL_VERSION: u32 = 0;

/// Engine-assigned window handle. Stable for the lifetime of the window.
///
/// Deliberately not the Wayland surface id: the shell must not be able to
/// address Wayland objects directly, so that a remote shell has exactly the
/// same authority as a local one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WindowId(pub u64);

impl std::fmt::Display for WindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "w{}", self.0)
    }
}

/// The viewport the shell is laying out into.
///
/// Logical pixels. `scale` is reported so a remote shell rendering on a 2x
/// display knows what it is dealing with, but all geometry in this protocol is
/// logical and the engine handles scaling.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub width: i32,
    pub height: i32,
    pub scale: f64,
}

/// A rectangle in logical pixels, output-local.
///
/// Floating point because animated positions land between pixels; the engine
/// rounds at the point it maps into the scene.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the engine knows about a window that the shell might want to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowInfo {
    pub id: WindowId,
    /// From `xdg_toplevel.set_app_id`. Absent until the client sets it.
    pub app_id: Option<String>,
    /// From `xdg_toplevel.set_title`. Changes over a window's life.
    pub title: Option<String>,
}

/// Spring parameters for an animation intent.
///
/// These are Motion's physics parameters and are integrated by
/// `lwfa-spring`, which the engine and the browser backend share. Sending
/// parameters rather than positions is what keeps the two in step. See
/// docs/architecture.md section 5.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpringSpec {
    pub stiffness: f64,
    pub damping: f64,
    pub mass: f64,
}

impl Default for SpringSpec {
    /// Motion's defaults, matching `lwfa_spring::SpringOptions::default`.
    fn default() -> Self {
        Self {
            stiffness: 100.0,
            damping: 10.0,
            mass: 1.0,
        }
    }
}

/// How a layout change should be reached.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Animation {
    pub spring: SpringSpec,
}

/// Where a window should be, and how it should get there.
///
/// # Position animates, size does not
///
/// The engine springs `rect.x` and `rect.y` toward their targets, but applies
/// `rect.width` and `rect.height` immediately as a single `configure`.
///
/// This is deliberate. Animating size means sending a `configure` every frame,
/// and native apps handle repeated resize badly (they do not reflow, they
/// re-layout from scratch). Scrollable tiling is chosen partly to make resize
/// rare; animating it would give that back. Smooth resize needs a crossfade of
/// old and new buffers, which is a later milestone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLayout {
    pub id: WindowId,
    pub rect: Rect,
    /// Stacking order, ascending. Ties broken by position in the message.
    pub z: i32,
    // NOTE: the appearance vocabulary (cornerRadius, opacity, blurBehind,
    // shadow, transform) belongs here and lands in milestone 5, once both the
    // native and browser backends can realise it identically. Adding it before
    // then would mean a protocol field only one backend honours.
}

/// Keyboard modifier state at the time of a key press.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Modifiers {
    pub alt: bool,
    pub ctrl: bool,
    pub shift: bool,
    /// The Super/Windows/Command key.
    pub logo: bool,
}

/// Engine to shell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ToShell {
    /// First message on every connection. The shell should check
    /// `protocolVersion` against [`PROTOCOL_VERSION`] before driving anything.
    ///
    /// Carries the full current state, not just a version, so a shell that
    /// reconnects after a crash resyncs without a separate query.
    #[serde(rename_all = "camelCase")]
    Hello {
        protocol_version: u32,
        output: Output,
        windows: Vec<WindowInfo>,
        focused: Option<WindowId>,
        /// What this session may do. Advisory for the shell, enforced by the
        /// engine; see [`Permissions`].
        permissions: Permissions,
        /// Which account this is, for the UI to show. "owner" for `AUTH_PASS`.
        account: String,
        /// This connection's own id, so it can find itself in `peers`.
        session: SessionId,
        /// Whether this connection drives layout. See [`ToShell::Role`].
        primary: bool,
        /// Everyone connected right now, including this session.
        peers: Vec<PeerInfo>,
    },
    #[serde(rename_all = "camelCase")]
    OutputChanged { output: Output },

    /// Whether this connection is now the one driving layout.
    ///
    /// # Why there is a driving connection at all
    ///
    /// Several devices can watch and use one session, but a window has exactly
    /// one size, so there is exactly one arrangement. If every connection
    /// pushed its own, two tablets with different screens would fight over
    /// every window, each resizing what the other had just placed, forever. So
    /// one connection owns layout and the rest follow it.
    ///
    /// A follower is not a spectator. It sends input, asks for the streams it
    /// needs, and receives every frame. It simply does not decide where windows
    /// go: it is told, with [`ToShell::Layout`]. Any session that may interact
    /// can take over with [`ToEngine::TakeControl`].
    #[serde(rename_all = "camelCase")]
    Role { primary: bool },

    /// The arrangement the primary connection chose, for everyone else.
    ///
    /// In the engine's output coordinates. A follower fits this into whatever
    /// viewport it has rather than recomputing it, because recomputing would
    /// produce a different arrangement for windows that can only have one size.
    #[serde(rename_all = "camelCase")]
    Layout {
        windows: Vec<WindowLayout>,
        output: Output,
    },

    /// Who is connected. Sent whenever that changes.
    #[serde(rename_all = "camelCase")]
    Peers { peers: Vec<PeerInfo> },
    #[serde(rename_all = "camelCase")]
    WindowOpened { window: WindowInfo },
    /// Title or app_id changed. Windows are long-lived and rename themselves.
    #[serde(rename_all = "camelCase")]
    WindowChanged { window: WindowInfo },
    #[serde(rename_all = "camelCase")]
    WindowClosed { id: WindowId },

    /// What the engine is running, so a shell can tell whether it is stale.
    ///
    /// Sent once, straight after [`ToShell::Hello`].
    ///
    /// A message of its own rather than a field on `Hello`, deliberately. The
    /// shell validates `Hello` strictly and rejects unknown fields, so adding
    /// one there would stop a shell built before this existed from decoding
    /// its own greeting at all. An unrecognised *message* is logged and
    /// ignored, which is the behaviour that matters here: the shells most in
    /// need of being told they are out of date are exactly the old ones.
    #[serde(rename_all = "camelCase")]
    EngineVersion { version: String },

    /// This window is being streamed and has drawn nothing.
    ///
    /// Sent once a window has been asked for and has produced no frame at all
    /// for several seconds, and again with `blank: false` if one ever arrives.
    ///
    /// The shell cannot work this out for itself: "no frames" and "an idle
    /// window whose picture has not changed" look identical from the far end,
    /// which is exactly why a window that never drew read as a broken stream.
    /// Seen in production on a game's splash window that was mapped, streamed,
    /// and never painted once.
    #[serde(rename_all = "camelCase")]
    WindowBlank { id: WindowId, blank: bool },
    /// Focus moved for a reason the shell did not initiate, such as a click or
    /// a window closing.
    #[serde(rename_all = "camelCase")]
    FocusChanged { id: Option<WindowId> },

    /// A modified key the engine did not claim for itself.
    ///
    /// "Focus the column to the left" is layout policy, so it belongs to the
    /// shell, not here. The engine only keeps binds that are not policy at all
    /// (quit, spawn) and forwards the rest.
    ///
    /// `key` is an xkb keysym name such as `"h"`, `"Left"` or `"Return"`.
    #[serde(rename_all = "camelCase")]
    KeyBinding { key: String, modifiers: Modifiers },

    /// Applications installed on the machine, in reply to [`ToEngine::ListApps`].
    ///
    /// Sent on request rather than in `Hello` because scanning the desktop
    /// entries touches the filesystem, and most sessions never open the
    /// launcher at all.
    #[serde(rename_all = "camelCase")]
    Apps { apps: Vec<AppEntry> },

    /// Icons for the applications, sent after [`ToShell::Apps`].
    ///
    /// Separate so the launcher paints its list immediately and fills icons in
    /// as they arrive: resolving a theme and reading a hundred files is not
    /// slow, but it is slower than showing the names.
    #[serde(rename_all = "camelCase")]
    AppIcons { icons: Vec<AppIcon> },

    /// The accounts on this machine, in reply to [`ToEngine::ListAccounts`].
    ///
    /// Never contains a password or a hash. Sent only to the owner; any other
    /// session gets `error` instead.
    #[serde(rename_all = "camelCase")]
    Accounts { accounts: Vec<AccountInfo> },

    /// Something the shell asked for did not happen, and why.
    ///
    /// Distinct from a dropped message: this is for requests with a visible
    /// result, so the UI can say "that name is taken" rather than leaving a
    /// dialog waiting for a reply that is never coming.
    #[serde(rename_all = "camelCase")]
    Error { request: String, message: String },

    /// A window is asking to be fullscreen, or asking to stop.
    ///
    /// Sent when the *client* asks, which is what happens when you press the
    /// fullscreen button inside a video player. The engine cannot grant it
    /// alone: the shell owns the arrangement and would put the window back at
    /// its column width with the next layout. So the request is forwarded, the
    /// shell decides, and the size it sends back is what the client is told.
    ///
    /// Distinct from lwfa's own fullscreen control, which the shell already
    /// knows about because it started there.
    #[serde(rename_all = "camelCase")]
    FullscreenRequest {
        window: WindowId,
        /// False is `unset_fullscreen`: the client asking to come back.
        fullscreen: bool,
    },

    /// The application asked for is already running outside this session.
    ///
    /// Sent instead of spawning. Applications that key "one instance" on their
    /// profile directory, which is every Electron application and both major
    /// browsers, do not start a second copy: the running one is handed the
    /// request over a socket in the profile and opens a window wherever *it*
    /// is. Since lwfa is a second session for the same user, that is the other
    /// screen, and the launch appears to do nothing at all.
    ///
    /// Reporting it is the only honest option: the engine cannot move a window
    /// between compositors, and starting a second copy on a shared profile
    /// risks corrupting it.
    AlreadyRunning {
        /// The command that was asked for, so it can be retried unchanged.
        command: String,
        /// Whether that command wanted a terminal, likewise.
        terminal: bool,
        /// What to call it. The binary's name, which is what people recognise.
        program: String,
        /// The process holding it, so closing it needs no second search.
        pid: u32,
    },

    /// An application asked the desktop for a file dialog; the shell is it.
    ///
    /// Sent to exactly one session, the one that may interact, because the
    /// dialog is input. The application is blocked on the answer the whole
    /// time, which is normal for it: file dialogs are modal in every desktop
    /// it has ever met.
    ///
    /// `ticket` authenticates the upload channel for this dialog and nothing
    /// else. The shell presents it when it opens the upload socket, so file
    /// bytes never ride the session socket and the session password never
    /// appears in an upload URL.
    #[serde(rename_all = "camelCase")]
    FileChooser {
        /// Echoed back in every message about this dialog.
        request: u64,
        mode: FileChooserMode,
        /// Whether several files may be chosen. Open mode only.
        multiple: bool,
        /// Whether the application wants a folder rather than files.
        directory: bool,
        /// The application's own title for the dialog, possibly empty.
        title: String,
        /// Who is asking, as the application identified itself to the portal.
        /// Possibly empty; the shell shows what it can.
        app_id: String,
        /// The label the application wants on the confirm button.
        accept_label: Option<String>,
        /// The name to prefill when saving.
        suggested_name: Option<String>,
        /// What the application says it can open. Advisory, for the picker's
        /// `accept` attribute and for filtering the browse pane; the engine
        /// does not enforce it, because the portal contract is that the user
        /// chooses and the application copes.
        filters: Vec<FileFilter>,
        /// The filenames a `saveFiles` dialog will write into the chosen
        /// folder. Empty in every other mode.
        names: Vec<String>,
        /// Starting points for the browse pane's sidebar. See [`Place`].
        places: Vec<Place>,
        /// One-shot credential for this dialog's upload channel.
        ticket: String,
    },

    /// The dialog is over without an answer from this shell.
    ///
    /// Sent when the application withdrew its own request, when the request
    /// expired with nobody answering, or when another session answered a
    /// dialog this one was showing. The shell closes the dialog and discards
    /// its local state; everything on the machine is already cleaned up.
    #[serde(rename_all = "camelCase")]
    FileChooserClosed { request: u64 },

    /// One directory of the machine's disk, for the dialog's browse pane.
    ///
    /// Errors travel inside rather than as [`ToShell::Error`], because the
    /// dialog shows them in place: "permission denied" belongs where the
    /// listing would have been, not in a global toast.
    #[serde(rename_all = "camelCase")]
    DirListing {
        request: u64,
        /// Canonicalised, so the shell can climb it segment by segment.
        path: String,
        entries: Vec<DirEntry>,
        /// Whether the listing was cut at the cap. The shell says so instead
        /// of silently showing most of a directory.
        truncated: bool,
        error: Option<String>,
    },

    /// Everything worth knowing about one path, for the dialog's details
    /// panel. The answer to [`ToEngine::StatPath`].
    #[serde(rename_all = "camelCase")]
    PathInfo {
        request: u64,
        /// Canonical, so it is what the properties actually describe.
        path: String,
        name: String,
        kind: PathKind,
        /// Bytes for a file. For a directory this is the size of the
        /// directory entry itself, which is not what anyone means by the
        /// size of a folder, so the shell shows `items` instead.
        size: u64,
        modified: Option<u64>,
        /// Creation time, where the filesystem records one. ext4 does,
        /// through statx; older ones and some network mounts do not.
        created: Option<u64>,
        accessed: Option<u64>,
        /// Permissions as `rwxr-xr-x`, the spelling everyone reads.
        mode: String,
        owner: String,
        group: String,
        /// The type a browser would need to render this, or empty when
        /// nothing can. What the preview tab keys off.
        mime: String,
        /// Where a symlink points, unresolved.
        target: Option<String>,
        /// How many entries a directory holds, when it could be counted.
        items: Option<u64>,
        error: Option<String>,
    },

    /// Upload channel only: the offset the engine already holds for a file.
    ///
    /// The answer to [`ToEngine::UploadBegin`]. Zero for a fresh file; after
    /// a dropped connection it is how much of the earlier attempt survived,
    /// and the client streams from there instead of starting over.
    #[serde(rename_all = "camelCase")]
    UploadOffset {
        request: u64,
        file: String,
        offset: u64,
    },

    /// Upload channel only: bytes confirmed written to the machine's disk.
    ///
    /// This is the progress bar's truth. Bytes handed to a socket are not
    /// progress, they are hope; a fast LAN used to read as "done" while the
    /// disk was still writing.
    #[serde(rename_all = "camelCase")]
    UploadProgress {
        request: u64,
        file: String,
        written: u64,
    },

    /// Upload channel only: the file is complete on disk, or it failed.
    ///
    /// `ok` means the byte count matched, the checksum matched, and the file
    /// was flushed and moved into place under `name`, which differs from the
    /// announced name whenever a collision was renamed. Anything less is
    /// `ok: false` with the reason, and nothing is left behind.
    #[serde(rename_all = "camelCase")]
    UploadDone {
        request: u64,
        file: String,
        name: String,
        ok: bool,
        error: Option<String>,
    },

    /// The answer to [`ToEngine::Ping`]. Carries nothing; arriving is the point.
    Pong,
}

/// Which question a file dialog is asking.
///
/// Open and save are different dialogs, not one dialog with a flag: opening
/// can take uploads from the client device, saving only makes sense against
/// the machine's own disk, and `saveFiles` is "pick a folder for these names"
/// rather than "pick a name".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChooserMode {
    Open,
    Save,
    SaveFiles,
}

/// One entry in a [`ToShell::DirListing`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirEntry {
    pub name: String,
    pub dir: bool,
    /// Bytes, and zero for directories.
    pub size: u64,
    /// Last modification, in whole seconds since the Unix epoch.
    ///
    /// `None` when the filesystem will not say, which is rare but real:
    /// some network mounts and some FUSE filesystems have no mtime. The
    /// dialog shows a dash rather than inventing a date, and sorts those
    /// entries last.
    ///
    /// Seconds rather than millis because a browser's `number` is exact
    /// only to 2^53, and because no file dialog has ever needed better.
    pub modified: Option<u64>,
}

/// What a path turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathKind {
    File,
    Dir,
    /// A symlink, with `target` saying where it points.
    Symlink,
    /// A socket, fifo, or device node. Nothing to preview.
    Other,
}

/// A named starting point in the machine's filesystem.
///
/// The sidebar of every file browser: home, and whichever of the XDG user
/// directories actually exist. Sent with the dialog rather than guessed by
/// the shell, because these are the machine's directories and only the
/// machine knows which of them are real or where the user moved them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Place {
    /// What to call it: "Home", "Documents", "Downloads".
    pub name: String,
    pub path: String,
}

/// One of the application's file filters, simplified for a browser.
///
/// The portal expresses filters as typed pairs of globs and MIME types; a
/// browser's `accept` attribute takes extensions and MIME types in one list.
/// `patterns` carries both shapes and the shell maps each to what `accept`
/// understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileFilter {
    /// The human name, such as "PNG and JPEG images".
    pub name: String,
    /// Globs like `*.png` and MIME types like `image/png`, mixed.
    pub patterns: Vec<String>,
}

/// A video codec the engine can encode and a client might decode.
///
/// Ordered by preference, best first, so a comparison is the whole choice:
/// HEVC is roughly a third fewer bits than H.264 for the same picture, which
/// over a phone connection decides whether the desktop is usable.
///
/// AV1 is deliberately absent. It compresses better still, but hardware decode
/// wants an A17 Pro or M3 and Apple ships no software fallback, and encoding
/// needs an Ada-generation card. Worth revisiting, not worth shipping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Codec {
    Hevc,
    H264,
}

impl Codec {
    /// Best first. The order is the preference.
    pub const ALL: [Codec; 2] = [Codec::Hevc, Codec::H264];

    /// The best codec every one of these clients can decode.
    ///
    /// A window is encoded once and fanned out, so a codec one client cannot
    /// read is a black window for that client. Encoding twice would mean a
    /// second NVENC session per window, and sessions are the budget the whole
    /// streaming path is measured against.
    ///
    /// `None` means JPEG: either nobody is connected, or somebody can decode
    /// nothing.
    pub fn best_for_all<'a>(clients: impl IntoIterator<Item = &'a [Codec]>) -> Option<Codec> {
        let clients: Vec<&[Codec]> = clients.into_iter().collect();
        if clients.is_empty() {
            return None;
        }
        Self::ALL
            .into_iter()
            .find(|codec| clients.iter().all(|client| client.contains(codec)))
    }
}

/// How many bits the session's sound deserves.
///
/// Derived on the ordering: `Auto < High < Medium < Low`, so "the most
/// constrained listener wins" is a plain `max`. `Auto` sorts first because
/// any explicit request beats the engine guessing.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum AudioQuality {
    /// Follow the same budget the video adapts on.
    #[default]
    Auto,
    /// 128 kbit/s Opus: transparent for desktop audio.
    High,
    /// 96 kbit/s.
    Medium,
    /// 64 kbit/s: clearly compressed on music, fine for interface sounds.
    Low,
}

impl AudioQuality {
    /// Bits per second, or `None` for [`AudioQuality::Auto`].
    pub fn bits(self) -> Option<i32> {
        match self {
            AudioQuality::Auto => None,
            AudioQuality::High => Some(128_000),
            AudioQuality::Medium => Some(96_000),
            AudioQuality::Low => Some(64_000),
        }
    }
}

/// One resolved application icon, as a `data:` URI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppIcon {
    /// The desktop entry id this belongs to.
    pub id: String,
    /// `data:image/svg+xml;base64,...` or `data:image/png;base64,...`.
    pub data: String,
}

/// One account, as the Access panel sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountInfo {
    pub id: i64,
    pub name: String,
    pub permissions: Permissions,
}

/// What a connected session is allowed to do.
///
/// Sent in `Hello` so the shell can grey out what it cannot use, but it is the
/// *engine* that enforces it. A permission checked only in the browser is not a
/// permission, it is a suggestion: anyone can open a socket and send whatever
/// they like.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub mode: SessionMode,
    /// Desktop entry ids this session may launch. `None` means all of them.
    pub allowed_apps: Option<Vec<String>>,
}

impl Permissions {
    /// Everything. What `AUTH_PASS` grants.
    pub fn owner() -> Self {
        Self {
            mode: SessionMode::Interact,
            allowed_apps: None,
        }
    }

    pub fn may_interact(&self) -> bool {
        self.mode == SessionMode::Interact
    }

    /// Whether this session may launch a given desktop entry.
    pub fn may_launch(&self, id: &str) -> bool {
        if !self.may_interact() {
            return false;
        }
        match &self.allowed_apps {
            None => true,
            Some(allowed) => allowed.iter().any(|a| a == id),
        }
    }
}

/// Buttons in the W3C standard gamepad mapping.
///
/// The order is fixed by that specification and is what every browser reports,
/// so it is also what the on-screen pad is built around. Named here so the
/// engine's mapping to Linux button codes reads as a translation rather than a
/// table of numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum GamepadButton {
    /// A on Xbox, Cross on PlayStation.
    South = 0,
    /// B on Xbox, Circle on PlayStation.
    East = 1,
    /// X on Xbox, Square on PlayStation.
    West = 2,
    /// Y on Xbox, Triangle on PlayStation.
    North = 3,
    /// LB / L1.
    LeftShoulder = 4,
    /// RB / R1.
    RightShoulder = 5,
    /// LT / L2. Reported as a button here and as an axis as well.
    LeftTrigger = 6,
    /// RT / R2.
    RightTrigger = 7,
    /// View / Share.
    Select = 8,
    /// Menu / Options.
    Start = 9,
    /// Left stick click. LS on Xbox, L3 on PlayStation.
    LeftStick = 10,
    /// Right stick click. RS on Xbox, R3 on PlayStation.
    RightStick = 11,
    DpadUp = 12,
    DpadDown = 13,
    DpadLeft = 14,
    DpadRight = 15,
    /// Guide, Xbox button, PS button.
    Guide = 16,
}

impl GamepadButton {
    /// The button at this index, or `None` for one this mapping does not have.
    pub fn from_index(index: u8) -> Option<Self> {
        use GamepadButton::*;
        Some(match index {
            0 => South,
            1 => East,
            2 => West,
            3 => North,
            4 => LeftShoulder,
            5 => RightShoulder,
            6 => LeftTrigger,
            7 => RightTrigger,
            8 => Select,
            9 => Start,
            10 => LeftStick,
            11 => RightStick,
            12 => DpadUp,
            13 => DpadDown,
            14 => DpadLeft,
            15 => DpadRight,
            16 => Guide,
            _ => return None,
        })
    }
}

/// Axes in the W3C standard gamepad mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum GamepadAxis {
    LeftX = 0,
    LeftY = 1,
    RightX = 2,
    RightY = 3,
    /// Not in the W3C axis list, which reports triggers as buttons. Carried
    /// separately so an analog trigger keeps its travel.
    LeftTrigger = 4,
    RightTrigger = 5,
}

impl GamepadAxis {
    pub fn from_index(index: u8) -> Option<Self> {
        use GamepadAxis::*;
        Some(match index {
            0 => LeftX,
            1 => LeftY,
            2 => RightX,
            3 => RightY,
            4 => LeftTrigger,
            5 => RightTrigger,
            _ => return None,
        })
    }
}

/// Identifies one connection, for the life of that connection.
pub type SessionId = u64;

/// One connected session, as shown to the others.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerInfo {
    pub id: SessionId,
    /// Which account it authenticated as. "owner" for `AUTH_PASS`.
    pub account: String,
    pub mode: SessionMode,
    /// Whether this is the connection currently driving layout.
    pub primary: bool,
    /// Best-effort description of the device, from its user agent.
    pub device: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionMode {
    /// Pixels only. Input and spawning are dropped by the engine.
    View,
    Interact,
}

/// One launchable application, from a freedesktop `.desktop` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppEntry {
    /// The desktop file's basename without its extension, e.g. `org.gnome.Nautilus`.
    pub id: String,
    pub name: String,
    /// `Comment=`, when the entry has one.
    pub description: Option<String>,
    /// `Exec=`, with the freedesktop field codes (%f, %U, ...) removed.
    pub exec: String,
    /// `Icon=`. A name, not a path: the shell has no icon theme, so this is
    /// only a hint for grouping and a fallback initial.
    pub icon: Option<String>,
    /// `Categories=`, split. Used to group the launcher.
    pub categories: Vec<String>,
    /// True when the entry asked for a terminal to be opened around it.
    pub terminal: bool,
}

/// A pointer button, using Linux evdev numbering (`BTN_LEFT` = 0x110).
///
/// evdev rather than the browser's 0/1/2, because that is what Wayland clients
/// receive and what `wl_pointer` documents. Translating once in the shell is
/// better than every consumer guessing.
pub type ButtonCode = u32;

/// A key, using Linux evdev numbering (`KEY_A` = 30).
///
/// The browser reports `KeyboardEvent.code`, a physical-key name like `"KeyA"`.
/// The shell maps that to evdev here rather than sending the string, because
/// the engine would otherwise need the same table plus a parser, and because
/// evdev codes are what xkb actually consumes (as `code + 8`).
///
/// Deliberately not `KeyboardEvent.key`: that is the *character produced*,
/// which already has the layout and modifiers applied. Sending it would apply
/// the layout twice, so a Dvorak user typing on a remote machine set to QWERTY
/// would get nonsense.
pub type KeyCode = u32;

/// Shell to engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ToEngine {
    /// The complete desired layout. Windows absent from `windows` are hidden.
    ///
    /// Declarative and total rather than incremental: the shell sends what it
    /// wants the world to look like and the engine reconciles. That means a
    /// dropped message cannot leave the two disagreeing, which matters a lot
    /// more once this is going over a mobile network.
    #[serde(rename_all = "camelCase")]
    SetLayout {
        windows: Vec<WindowLayout>,
        /// Absent means apply immediately, with no animation.
        animate: Option<Animation>,
    },
    #[serde(rename_all = "camelCase")]
    FocusWindow { id: WindowId },
    #[serde(rename_all = "camelCase")]
    CloseWindow { id: WindowId },
    /// End the process behind a window, not just the window.
    ///
    /// `CloseWindow` asks politely and the application decides, which is
    /// correct and is what a close button should do. It is not enough for
    /// applications that keep running with no windows open: anything built on
    /// GApplication, and Chromium-derived browsers, stay resident and keep
    /// their name on the session bus. lwfa shares that bus with the host, so a
    /// resident copy inside lwfa answers the host's next launch and opens the
    /// window in here, where the person at the desk cannot reach it.
    ///
    /// Separate from `CloseWindow` rather than a flag on it, because the two
    /// are different promises: one asks, one ends the process and whatever was
    /// unsaved in it.
    #[serde(rename_all = "camelCase")]
    QuitApp { id: WindowId },
    /// Launch a command line. The engine sets `WAYLAND_DISPLAY` to its own
    /// socket, splits the line into argv, and runs it.
    ///
    /// `terminal` mirrors the desktop entry's `Terminal=true`: the program
    /// writes to a tty and has no window, so the engine wraps it in one.
    /// Without that it runs, prints into the void, and never appears.
    #[serde(rename_all = "camelCase")]
    Spawn { command: String, terminal: bool },

    /// Close a program running outside this session, then launch it in here.
    ///
    /// The answer to [`ToShell::AlreadyRunning`], and only ever sent after
    /// somebody has been asked. `force` is the second attempt: the first sends
    /// a polite request to quit, which an application with unsaved work
    /// answers by opening a dialog on a screen nobody is looking at.
    CloseAndSpawn {
        command: String,
        terminal: bool,
        pid: u32,
        /// Kill outright rather than asking. Loses unsaved work.
        force: bool,
    },

    /// Tell the engine how much room the shell actually has.
    ///
    /// # Why the engine resizes rather than the shell scaling
    ///
    /// The alternative is what this used to do: the engine's output stays the
    /// size of the machine's display and the browser scales it to fit. That
    /// letterboxes, wastes the viewport, and makes every window the wrong
    /// physical size, because a 2560x1440 desktop shrunk into an iPad is a
    /// desktop with iPad-sized text rendered at half scale.
    ///
    /// Resizing the output instead means the strip lays out *for the device
    /// holding it*: a tablet gets tablet-shaped columns, a phone gets one
    /// column, and nothing is letterboxed. It is also the only version where
    /// "responsive" means anything, since `strip.ts` computes column widths
    /// from the output size.
    ///
    /// Answered with [`ToShell::OutputChanged`].
    #[serde(rename_all = "camelCase")]
    SetViewport {
        /// Logical pixels, i.e. CSS pixels, not device pixels.
        width: i32,
        height: i32,
        /// Device pixel ratio, so the engine can capture at native resolution.
        scale: f64,
    },

    /// Ask for the installed applications. Answered with [`ToShell::Apps`].
    ///
    /// Icons are *not* included: see [`ToEngine::RequestIcons`].
    #[serde(rename_all = "camelCase")]
    ListApps,

    /// Ask for icons, by desktop entry id.
    ///
    /// Separate from [`ToEngine::ListApps`] so the shell can ask only for the
    /// ones it does not already have. A full set is well over a megabyte, and
    /// re-sending it on every reconnect to a client that cached it last time is
    /// a megabyte of nothing.
    #[serde(rename_all = "camelCase")]
    RequestIcons { ids: Vec<String> },

    /// Account administration. All four require the owner; anything else is
    /// answered with [`ToShell::Error`] rather than silently ignored, because
    /// these have a visible result the UI is waiting on.
    #[serde(rename_all = "camelCase")]
    ListAccounts,
    #[serde(rename_all = "camelCase")]
    CreateAccount {
        name: String,
        password: String,
        permissions: Permissions,
    },
    #[serde(rename_all = "camelCase")]
    UpdateAccount {
        id: i64,
        permissions: Permissions,
        /// Only when it is being changed. `None` leaves the existing one.
        password: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteAccount { id: i64 },

    /// Pointer moved within a window.
    ///
    /// # Why coordinates are window-relative
    ///
    /// `x` and `y` are logical pixels from the window's top-left, not from the
    /// output's. During a spring animation the engine's actual window position
    /// differs from the target the shell last computed, so output-relative
    /// coordinates would land the click wherever the window *was going to be*
    /// rather than where it is. Naming the window removes the ambiguity
    /// entirely, and the engine already knows where it put things.
    #[serde(rename_all = "camelCase")]
    PointerMotion { window: WindowId, x: f64, y: f64 },

    /// Pointer button pressed or released, on the window last moved over.
    #[serde(rename_all = "camelCase")]
    PointerButton { button: ButtonCode, pressed: bool },

    /// Scroll. Values are logical pixels, positive right and down.
    #[serde(rename_all = "camelCase")]
    PointerAxis { horizontal: f64, vertical: f64 },

    /// The pointer left the shell's window area entirely.
    #[serde(rename_all = "camelCase")]
    PointerLeave,

    /// Key pressed or released. Goes to whatever has keyboard focus.
    #[serde(rename_all = "camelCase")]
    Key { key: KeyCode, pressed: bool },

    /// A finger touched down. `id` distinguishes simultaneous fingers.
    ///
    /// Touch is first-class rather than synthesised into pointer events,
    /// because `wl_touch` exists and clients that support it handle multi-touch
    /// properly. Faking a pointer would throw away every finger but one.
    #[serde(rename_all = "camelCase")]
    TouchDown {
        window: WindowId,
        id: i32,
        x: f64,
        y: f64,
    },

    #[serde(rename_all = "camelCase")]
    TouchMotion {
        window: WindowId,
        id: i32,
        x: f64,
        y: f64,
    },

    #[serde(rename_all = "camelCase")]
    TouchUp { id: i32 },

    /// Ask to become the connection that drives layout.
    ///
    /// Granted to any session that may interact. Deliberately not a
    /// negotiation: whoever asks last is holding the device the user is
    /// actually looking at, and a confirmation prompt on the other device would
    /// be answered by nobody when that device is a tablet in another room.
    #[serde(rename_all = "camelCase")]
    TakeControl,

    /// Disconnect another session. The owner's alone.
    ///
    /// Kicks the connection, not the account: whoever it was can log back in.
    /// This is the "who is on my desktop right now, and stop" control, which is
    /// a different question from what an account is permitted in general.
    #[serde(rename_all = "camelCase")]
    EndSession { session: SessionId },

    /// Change what a live session may do, without touching its account.
    ///
    /// For handing someone your desktop to look at and then taking the keys
    /// back, or the reverse, while they stay connected. Lasts only as long as
    /// the connection; the account's own permissions are unchanged. The owner's
    /// alone, and it cannot be used on yourself, because locking yourself out
    /// of your own machine from your own machine helps nobody.
    #[serde(rename_all = "camelCase")]
    SetSessionMode { session: SessionId, mode: SessionMode },

    /// Whether this connection wants to hear the machine.
    ///
    /// Per connection and off until asked for, like streams. Capturing costs a
    /// process and 1.5 Mbit/s per listener, so nobody pays for it until
    /// somebody is listening, and a device left open on a desk is not quietly
    /// broadcasting the room.
    /// Attach or detach the session's virtual game controller.
    ///
    /// The device is only created while a client is actually using the pad. It
    /// is visible to the *whole machine*, not just to lwfa, because that is
    /// what makes Steam and SDL find it, so leaving one attached would mean an
    /// idle session advertising a controller nobody is holding.
    #[serde(rename_all = "camelCase")]
    SetGamepad { enabled: bool },

    /// A controller button, in the W3C standard mapping.
    ///
    /// Indices rather than names, because that mapping is what the browser's
    /// Gamepad API reports and what the on-screen pad is already built around,
    /// so a physical controller and the drawn one speak the same language.
    /// See [`GamepadButton`].
    #[serde(rename_all = "camelCase")]
    GamepadButton { button: u8, pressed: bool },

    /// A controller axis, in the W3C standard mapping.
    ///
    /// Sticks run -1 to 1 and triggers 0 to 1. Analog, which is the thing the
    /// keyboard stand-ins could never express: walking slowly, steering
    /// partially, easing onto a throttle.
    #[serde(rename_all = "camelCase")]
    GamepadAxis { axis: u8, value: f64 },

    #[serde(rename_all = "camelCase")]
    SetAudio {
        /// Whether *this* connection wants to hear the machine.
        enabled: bool,
        /// Whether this connection can decode Opus.
        ///
        /// Per listener: the engine encodes each format exactly when some
        /// listener needs it and sends every client the one it can take, so
        /// one client answering "no" costs only itself the compression. The
        /// shell bundles a WASM decoder precisely so the answer is yes
        /// everywhere; "no" is for older shells and headless tools.
        #[serde(default)]
        opus: bool,
        /// Whether the machine should also play the session's audio aloud.
        ///
        /// Machine-wide, not per connection: there is one set of speakers, so
        /// the last session to express a preference wins. Off by default,
        /// because the reason to stream audio is usually that nobody is in the
        /// room, and a desktop talking to an empty room is a surprise.
        local: bool,
        /// How many bits the sound deserves.
        ///
        /// One capture is fanned out to everyone, so the *lowest* request
        /// among the listeners wins: a constrained device must not be flooded
        /// because another one asked for more. `Auto` follows the same budget
        /// the video adapts on.
        #[serde(default)]
        quality: AudioQuality,
    },

    /// Which windows the shell wants pixels for, and in what form.
    ///
    /// Total, like `SetLayout`: windows not listed stop streaming. A shell that
    /// composites locally (the native backend) asks for none; a browser asks
    /// for the ones its viewport can actually show.
    ///
    /// This is what bounds the encoder budget. Only columns intersecting the
    /// viewport need streaming, so cost scales with viewport width rather than
    /// with how many windows are open. See docs/architecture.md section 2.3.
    ///
    /// # Why the codec is the client's call
    ///
    /// `codecs` is what this client can actually decode, best first, and empty
    /// means it can decode nothing and needs JPEG.
    ///
    /// Asked of the browser rather than inferred here. WebCodecs
    /// `VideoDecoder` is only exposed in a *secure context*, so a browser on
    /// `http://192.168.1.x` — exactly how a tablet reaches this over a LAN —
    /// has no decoder at all, while the same browser on `http://localhost`
    /// does. And HEVC support is a property of the hardware, not the browser:
    /// two devices running the same Safari differ on it. Nothing here can see
    /// any of that, so the client states it.
    #[serde(rename_all = "camelCase")]
    SetStreams {
        windows: Vec<WindowId>,
        /// What this client can decode, best first. Empty means send JPEG.
        codecs: Vec<Codec>,
    },

    /// Ask for one directory of the machine's disk, while a dialog is open.
    ///
    /// Answered with [`ToShell::DirListing`]. Bound to an open request and
    /// refused otherwise: the shell has no business listing directories
    /// except while an application is asking it to choose from them. An
    /// empty path or `"~"` means the session's home.
    #[serde(rename_all = "camelCase")]
    ListDir { request: u64, path: String },

    /// The human answered a file dialog with these machine paths.
    ///
    /// Uploads are not listed here; the engine already knows what arrived on
    /// the dialog's upload channel and folds it into the answer itself, so a
    /// client cannot claim an upload that never happened.
    #[serde(rename_all = "camelCase")]
    FileChosen { request: u64, paths: Vec<String> },

    /// The human dismissed a file dialog.
    ///
    /// Everything uploaded under it is deleted before the application hears
    /// "cancelled": a dismissed dialog must leave nothing behind.
    #[serde(rename_all = "camelCase")]
    FileCancel { request: u64 },

    /// Ask about one path, for the dialog's details panel.
    ///
    /// Answered with [`ToShell::PathInfo`]. Bound to an open dialog, like
    /// [`ToEngine::ListDir`]: the shell may inspect what it is showing and
    /// nothing else.
    #[serde(rename_all = "camelCase")]
    StatPath { request: u64, path: String },

    /// Upload channel only: announce one file before its bytes.
    ///
    /// `file` is the client's own id for this file, stable across reconnects,
    /// which is what makes resuming possible. `rel` is the path inside a
    /// picked folder, empty for a plain file; the engine sanitises every
    /// component and decides the real destination alone. Answered with
    /// [`ToShell::UploadOffset`], after which the client streams raw binary
    /// frames from that offset and finishes with [`ToEngine::UploadEnd`].
    #[serde(rename_all = "camelCase")]
    UploadBegin {
        request: u64,
        file: String,
        name: String,
        rel: Vec<String>,
        size: u64,
    },

    /// Upload channel only: the announced bytes are all sent.
    ///
    /// `sha256` is the hex digest of the whole file, computed while reading
    /// it. The engine has been hashing what it wrote; the two agreeing is
    /// what `ok` in [`ToShell::UploadDone`] means. A truncated or corrupted
    /// transfer can be many things, but it can no longer be "ok".
    #[serde(rename_all = "camelCase")]
    UploadEnd {
        request: u64,
        file: String,
        sha256: String,
    },

    /// Is this connection actually alive? Answered with [`ToShell::Pong`].
    ///
    /// Exists for iPadOS. A home-screen web app that is backgrounded and
    /// resumed is frequently handed back a socket that looks open to
    /// JavaScript but delivers nothing, and WebKit never fires `close` on it
    /// (WebKit bug 247943). The WebSocket protocol's own ping/pong cannot be
    /// sent from browser JavaScript, so the shell asks at the application
    /// layer and treats silence as death. See `connection.ts`.
    Ping,

    /// The shell hit an error it could not continue from and is reloading.
    ///
    /// Sent on the connection *after* the reload, because the one that saw the
    /// crash is being torn down as the page goes away and cannot be relied on
    /// to flush anything.
    ///
    /// It exists because a reloading shell closes its socket cleanly, which is
    /// indistinguishable from somebody pressing reload, and the shell's own log
    /// is in memory and dies with the page. So the one failure a user actually
    /// notices, the session that "came back strange", left no evidence anywhere
    /// at all. Now it leaves a line in the engine's journal.
    #[serde(rename_all = "camelCase")]
    Crashed { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(value).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn messages_survive_a_roundtrip() {
        let hello = ToShell::Hello {
            permissions: Permissions::owner(),
            account: "owner".to_string(),
            session: 1,
            primary: true,
            peers: Vec::new(),
            protocol_version: PROTOCOL_VERSION,
            output: Output {
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
            windows: vec![WindowInfo {
                id: WindowId(1),
                app_id: Some("Alacritty".into()),
                title: None,
            }],
            focused: Some(WindowId(1)),
        };
        assert_eq!(roundtrip(&hello), hello);

        let layout = ToEngine::SetLayout {
            windows: vec![WindowLayout {
                id: WindowId(7),
                rect: Rect {
                    x: 12.5,
                    y: 12.0,
                    width: 960.0,
                    height: 1056.0,
                },
                z: 3,
            }],
            animate: Some(Animation {
                spring: SpringSpec::default(),
            }),
        };
        assert_eq!(roundtrip(&layout), layout);
    }

    #[test]
    fn enums_are_tagged_on_type_in_camel_case() {
        // The TypeScript side discriminates on this exact field and these exact
        // values, so pin them rather than leaving them to serde's defaults.
        let json = serde_json::to_string(&ToShell::WindowClosed { id: WindowId(4) }).unwrap();
        assert_eq!(json, r#"{"type":"windowClosed","id":4}"#);

        let json = serde_json::to_string(&ToEngine::FocusWindow { id: WindowId(4) }).unwrap();
        assert_eq!(json, r#"{"type":"focusWindow","id":4}"#);
    }

    #[test]
    fn window_id_is_a_bare_number_on_the_wire() {
        // Transparent, so the shell can use it as an object key and a Map key
        // without unwrapping.
        assert_eq!(serde_json::to_string(&WindowId(42)).unwrap(), "42");
    }

    #[test]
    fn fields_are_camel_case() {
        let json = serde_json::to_string(&WindowInfo {
            id: WindowId(1),
            app_id: Some("foo".into()),
            title: None,
        })
        .unwrap();
        assert!(json.contains("\"appId\""), "got {json}");
        assert!(!json.contains("app_id"), "got {json}");
    }

    #[test]
    fn absent_animation_is_distinguishable_from_a_default_one() {
        // "apply immediately" and "animate with default springs" are different
        // instructions, so null must not silently become a default.
        let immediate = ToEngine::SetLayout {
            windows: vec![],
            animate: None,
        };
        let json = serde_json::to_string(&immediate).unwrap();
        assert!(json.contains("\"animate\":null"), "got {json}");
        assert_eq!(roundtrip(&immediate), immediate);
    }

    #[test]
    fn unknown_message_types_are_rejected_not_ignored() {
        // A shell speaking a newer protocol must fail loudly here rather than
        // have its instruction silently dropped.
        let err = serde_json::from_str::<ToEngine>(r#"{"type":"teleportWindow","id":1}"#);
        assert!(err.is_err());
    }
}

// ---------------------------------------------------------------------------
// Binary frame transport
//
// Window pixels do not go through the JSON messages above. They travel as
// WebSocket *binary* frames with the fixed-size header below, on the same
// socket: text frames are control, binary frames are pixels.
//
// One socket rather than two because the ordering between "this window now
// exists" and "here are its pixels" matters, and two sockets would need
// resequencing to get it.
// ---------------------------------------------------------------------------

/// Identifies an lwfa binary frame. Guards against a stray binary message being
/// interpreted as pixel data.
pub const FRAME_MAGIC: [u8; 4] = *b"LWFA";

/// Bumped when the header layout changes. Independent of [`PROTOCOL_VERSION`]
/// so the pixel format can evolve without a control-plane break.
pub const FRAME_VERSION: u8 = 0;

/// Bytes before the payload.
pub const FRAME_HEADER_LEN: usize = 24;

/// Magic for an audio chunk, distinct from [`FRAME_MAGIC`].
///
/// Audio and video share one WebSocket, so a binary message has to say which
/// it is. A separate magic rather than a discriminator field inside the video
/// header, because the two carry genuinely different fields and pretending
/// otherwise would mean a header full of "meaningless for audio" holes.
pub const AUDIO_MAGIC: [u8; 4] = *b"LWFP";

/// Bytes before an audio payload.
pub const AUDIO_HEADER_LEN: usize = 16;

/// How an audio payload is encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum AudioFormat {
    /// Interleaved signed 16-bit little-endian samples.
    ///
    /// Uncompressed on purpose, for the same reason JPEG is the video
    /// fallback: `WebCodecs` is only exposed in a secure context, so a browser
    /// reaching this over plain HTTP has no `AudioDecoder` and could not play
    /// Opus at all. Stereo at 48kHz is 1.5 Mbit/s, which is nothing on a LAN
    /// and is the wrong answer over cellular; Opus is the upgrade, and it
    /// needs TLS first.
    Pcm16 = 0,

    /// Opus, one packet per frame, no container.
    ///
    /// Roughly 128 kbit/s against PCM's 1.5 Mbit/s for the same stereo at
    /// 48kHz: a twelvefold saving, and larger than the one HEVC gives on
    /// video. Transparent for desktop audio at that rate.
    ///
    /// Framed rather than streamed. Each message is exactly one Opus packet
    /// covering 20ms, which is what lets a client that joins late start
    /// decoding at the next message with nothing to resynchronise.
    ///
    /// Sent only to clients that said they can decode it; `AudioDecoder` is
    /// secure-context only, so a browser on plain HTTP still gets PCM.
    Opus = 1,
}

impl AudioFormat {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Pcm16),
            1 => Some(Self::Opus),
            _ => None,
        }
    }
}

/// Describes one chunk of audio on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioHeader {
    pub format: AudioFormat,
    pub channels: u8,
    pub sample_rate: u32,
    /// Sample frames in the payload, per channel.
    pub frames: u32,
}

impl AudioHeader {
    pub fn encode_with_payload(&self, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(AUDIO_HEADER_LEN + payload.len());
        out.extend_from_slice(&AUDIO_MAGIC);
        out.push(FRAME_VERSION);
        out.push(self.format as u8);
        out.push(self.channels);
        out.push(0); // reserved
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&self.frames.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// Parse a header and return it alongside the payload.
    ///
    /// `None` rather than a partial result, so a malformed chunk is dropped
    /// instead of played as noise, which through speakers is worse than
    /// silence.
    pub fn decode(bytes: &[u8]) -> Option<(Self, &[u8])> {
        if bytes.len() < AUDIO_HEADER_LEN {
            return None;
        }
        if bytes[0..4] != AUDIO_MAGIC || bytes[4] != FRAME_VERSION {
            return None;
        }
        let format = AudioFormat::from_u8(bytes[5])?;
        let channels = bytes[6];
        if channels == 0 || channels > 8 {
            return None;
        }
        let sample_rate = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
        let frames = u32::from_le_bytes(bytes[12..16].try_into().ok()?);
        if sample_rate == 0 || frames == 0 {
            return None;
        }
        Some((
            Self {
                format,
                channels,
                sample_rate,
                frames,
            },
            &bytes[AUDIO_HEADER_LEN..],
        ))
    }
}

/// How a frame's payload is encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum FrameFormat {
    /// Baseline JPEG.
    ///
    /// Every frame is compressed whole, so a static window costs as much as a
    /// moving one. Kept as the fallback for when no hardware encoder session is
    /// available: the dev GPU allows 8 concurrent NVENC sessions, and a ninth
    /// streaming window has to degrade rather than go blank.
    Jpeg = 0,

    /// H.264, Annex B, baseline-compatible.
    ///
    /// The normal path. Inter-frame prediction means an idle window costs
    /// almost nothing, which is what makes streaming several windows over a
    /// mobile connection plausible at all. Measured on this hardware at 3.7 KB
    /// per frame against JPEG's 30.5 KB for the same 631x1366 window.
    ///
    /// Annex B with SPS/PPS repeated on every keyframe, rather than AVCC with
    /// an out-of-band `description`. That is what lets a browser attach
    /// mid-stream and start decoding at the next keyframe without the engine
    /// having to remember what each client has seen.
    H264 = 1,

    /// HEVC, Annex B, Main profile.
    ///
    /// The same shape as H.264 above, including repeating parameter sets on
    /// every keyframe, and for the same reason. Roughly a third fewer bits for
    /// the same picture, which over a phone connection is what decides whether
    /// the desktop is usable. Sent only to clients that have said they can
    /// decode it; see [`Codec`].
    Hevc = 2,
}

impl FrameFormat {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Jpeg),
            1 => Some(Self::H264),
            2 => Some(Self::Hevc),
            _ => None,
        }
    }

    /// True when a decoder can start from this frame alone.
    pub fn is_self_contained(self) -> bool {
        matches!(self, Self::Jpeg)
    }
}

/// Fixed-size header on every binary frame. Little-endian.
///
/// Layout:
/// ```text
/// 0..4    magic "LWFA"
/// 4       version
/// 5       format
/// 6       flags           bit 0 = keyframe
/// 7       reserved (zero)
/// 8..16   window id       u64
/// 16..20  width           u32
/// 20..24  height          u32
/// 24..    payload
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub window: WindowId,
    pub width: u32,
    pub height: u32,
    pub format: FrameFormat,
    /// A decoder can start here. Always true for JPEG; true for H.264 IDRs.
    ///
    /// Without this the browser cannot tell when it is safe to begin decoding
    /// a stream it joined partway through, and feeding a decoder delta frames
    /// with no reference produces either errors or garbage.
    pub keyframe: bool,
}

/// Bit 0 of the flags byte.
const FLAG_KEYFRAME: u8 = 1 << 0;

impl FrameHeader {
    /// Serialise the header into a buffer sized for the payload that follows.
    pub fn encode_with_payload(&self, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
        out.extend_from_slice(&FRAME_MAGIC);
        out.push(FRAME_VERSION);
        out.push(self.format as u8);
        out.push(if self.keyframe { FLAG_KEYFRAME } else { 0 });
        out.push(0); // reserved
        out.extend_from_slice(&self.window.0.to_le_bytes());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// Parse a header and return it alongside the payload.
    ///
    /// Returns `None` rather than a partial result on anything unexpected, so a
    /// malformed frame is dropped rather than rendered as garbage.
    pub fn decode(bytes: &[u8]) -> Option<(Self, &[u8])> {
        if bytes.len() < FRAME_HEADER_LEN {
            return None;
        }
        if bytes[0..4] != FRAME_MAGIC || bytes[4] != FRAME_VERSION {
            return None;
        }
        let format = FrameFormat::from_u8(bytes[5])?;
        let keyframe = bytes[6] & FLAG_KEYFRAME != 0;
        let window = WindowId(u64::from_le_bytes(bytes[8..16].try_into().ok()?));
        let width = u32::from_le_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_le_bytes(bytes[20..24].try_into().ok()?);
        // A zero-sized frame is meaningless and would divide by zero downstream.
        if width == 0 || height == 0 {
            return None;
        }
        Some((
            Self {
                window,
                width,
                height,
                format,
                keyframe,
            },
            &bytes[FRAME_HEADER_LEN..],
        ))
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    #[test]
    fn an_audio_chunk_round_trips() {
        let header = AudioHeader {
            format: AudioFormat::Pcm16,
            channels: 2,
            sample_rate: 48_000,
            frames: 480,
        };
        let payload: Vec<u8> = (0..480 * 2 * 2).map(|i| i as u8).collect();
        let bytes = header.encode_with_payload(&payload);
        assert_eq!(bytes.len(), AUDIO_HEADER_LEN + payload.len());

        let (decoded, body) = AudioHeader::decode(&bytes).expect("decodes");
        assert_eq!(decoded, header);
        assert_eq!(body, payload.as_slice());
    }

    #[test]
    fn audio_and_video_do_not_decode_as_each_other() {
        // They share a socket, so a mix-up would play pixels through the
        // speakers or paint sound onto the screen.
        let audio = AudioHeader {
            format: AudioFormat::Pcm16,
            channels: 2,
            sample_rate: 48_000,
            frames: 8,
        }
        .encode_with_payload(&[0; 32]);
        assert!(FrameHeader::decode(&audio).is_none());
        assert!(AudioHeader::decode(&audio).is_some());

        let video = header().encode_with_payload(&[1, 2, 3]);
        assert!(AudioHeader::decode(&video).is_none());
        assert!(FrameHeader::decode(&video).is_some());
    }

    #[test]
    fn an_implausible_audio_header_is_refused() {
        let mut bytes = AudioHeader {
            format: AudioFormat::Pcm16,
            channels: 2,
            sample_rate: 48_000,
            frames: 8,
        }
        .encode_with_payload(&[0; 32]);

        let good = bytes.clone();
        bytes[6] = 0; // no channels
        assert!(AudioHeader::decode(&bytes).is_none());

        bytes = good.clone();
        bytes[8..12].copy_from_slice(&0u32.to_le_bytes()); // no sample rate
        assert!(AudioHeader::decode(&bytes).is_none());

        bytes = good;
        bytes[5] = 99; // a format from the future
        assert!(AudioHeader::decode(&bytes).is_none());
    }

    fn header() -> FrameHeader {
        FrameHeader {
            window: WindowId(7),
            width: 1261,
            height: 1390,
            format: FrameFormat::H264,
            keyframe: true,
        }
    }

    #[test]
    fn header_roundtrips_with_its_payload() {
        let payload = b"\xff\xd8\xff\xe0 pretend jpeg";
        let bytes = header().encode_with_payload(payload);
        assert_eq!(bytes.len(), FRAME_HEADER_LEN + payload.len());

        let (decoded, rest) = FrameHeader::decode(&bytes).expect("should decode");
        assert_eq!(decoded, header());
        assert_eq!(rest, payload);
    }

    #[test]
    fn header_is_exactly_the_documented_size() {
        // The TypeScript side slices at this offset, so it is part of the wire
        // contract rather than an implementation detail.
        assert_eq!(header().encode_with_payload(&[]).len(), FRAME_HEADER_LEN);
    }

    #[test]
    fn rejects_a_foreign_binary_message() {
        assert!(FrameHeader::decode(b"this is not a frame at all, honestly").is_none());
    }

    #[test]
    fn rejects_a_future_version() {
        let mut bytes = header().encode_with_payload(b"x");
        bytes[4] = FRAME_VERSION + 1;
        assert!(FrameHeader::decode(&bytes).is_none());
    }

    #[test]
    fn rejects_an_unknown_format() {
        let mut bytes = header().encode_with_payload(b"x");
        bytes[5] = 99;
        assert!(FrameHeader::decode(&bytes).is_none());
    }

    #[test]
    fn rejects_a_truncated_header() {
        let bytes = header().encode_with_payload(b"payload");
        for len in 0..FRAME_HEADER_LEN {
            assert!(
                FrameHeader::decode(&bytes[..len]).is_none(),
                "{len} bytes should not decode"
            );
        }
    }

    #[test]
    fn rejects_zero_dimensions() {
        // Would divide by zero when scaling in the browser.
        let bytes = FrameHeader {
            width: 0,
            ..header()
        }
        .encode_with_payload(b"x");
        assert!(FrameHeader::decode(&bytes).is_none());
    }

    #[test]
    fn the_keyframe_flag_survives_a_roundtrip() {
        // The browser gates decoding on this. If it were dropped, a stream
        // joined mid-flight would never start.
        for keyframe in [true, false] {
            let bytes = FrameHeader {
                keyframe,
                ..header()
            }
            .encode_with_payload(b"x");
            let (decoded, _) = FrameHeader::decode(&bytes).expect("should decode");
            assert_eq!(decoded.keyframe, keyframe);
        }
    }

    #[test]
    fn both_formats_roundtrip() {
        for format in [FrameFormat::Jpeg, FrameFormat::H264] {
            let bytes = FrameHeader { format, ..header() }.encode_with_payload(b"x");
            let (decoded, _) = FrameHeader::decode(&bytes).expect("should decode");
            assert_eq!(decoded.format, format);
        }
    }

    #[test]
    fn only_jpeg_is_self_contained() {
        // H.264 deltas need a reference frame; JPEG never does. This is what
        // decides whether the fallback path can skip keyframe bookkeeping.
        assert!(FrameFormat::Jpeg.is_self_contained());
        assert!(!FrameFormat::H264.is_self_contained());
    }

    #[test]
    fn accepts_an_empty_payload() {
        let bytes = header().encode_with_payload(&[]);
        let (_, payload) = FrameHeader::decode(&bytes).expect("should decode");
        assert!(payload.is_empty());
    }
}
