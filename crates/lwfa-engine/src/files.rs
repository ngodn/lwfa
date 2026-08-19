//! File dialog state: the compositor's half of the portal conversation.
//!
//! A dialog is born in `portal.rs` (an application asked), lives here as a
//! [`PendingFile`], is answered by a human through the shell, and dies by
//! answer, cancel, withdrawal, or expiry. This module owns that lifecycle
//! and the cleanup invariant that goes with it: a dialog that ends without
//! an answer leaves *nothing* behind on the machine, including everything
//! uploaded under it.
//!
//! # Surviving a reconnect
//!
//! Dialogs are not tied to a socket. When the session showing a dialog
//! disconnects, the dialog is orphaned rather than cancelled and a timer
//! starts; the next interactive session to connect (usually the same
//! browser a moment later) inherits it, complete with the original request
//! id and ticket, so an upload already in flight on the dialog's own
//! channel keeps running through the blip. Only the timer expiring cancels
//! for real. The application, blocked in its file dialog either way,
//! cannot tell any of this happened.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use lwfa_proto::ToShell;

use crate::portal::{FileReply, Kind};
use crate::state::Lwfa;

/// How long an unattended dialog waits for a shell before giving up.
///
/// Long enough to ride out a reconnect or a page reload, short enough that
/// an application asked on an empty desk is not blocked forever.
const ORPHAN_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

/// One open dialog.
pub struct PendingFile {
    /// Answered exactly once; consuming it is how the dialog ends.
    reply: futures_channel::oneshot::Sender<FileReply>,
    kind: Kind,
    directory: bool,
    /// The portal request handle, for matching a `Close` from the caller.
    handle: String,
    /// The filenames a `SaveFiles` dialog composes into the chosen folder.
    names: Vec<String>,
    /// The session currently showing the dialog, or `None` while orphaned.
    session: Option<lwfa_proto::SessionId>,
    /// The message that opens the dialog, kept verbatim so a reconnecting
    /// shell can be shown exactly what the first one was.
    message: ToShell,
    /// Files that finished uploading, in arrival order.
    uploads: Vec<crate::upload::Finished>,
    /// Ticking while no session is showing the dialog.
    expiry: Option<smithay::reexports::calloop::RegistrationToken>,
}

impl Lwfa {
    /// An application asked for a file dialog.
    ///
    /// Handed to the primary session if it may interact, else any session
    /// that may: the dialog is input, and a view-only session must not feed
    /// an application files. With nobody suitable connected the dialog is
    /// held orphaned until someone arrives or [`ORPHAN_GRACE`] runs out,
    /// which is what lets "open a file dialog, then walk over and pick up
    /// the tablet" work.
    pub fn file_request(&mut self, request: crate::portal::FileRequest) {
        let id = self.next_file_request;
        self.next_file_request += 1;

        let Ok(ticket) = crate::auth::generate_token() else {
            tracing::warn!("could not mint an upload ticket; cancelling the dialog");
            return; // Dropping `request.reply` is the cancel.
        };

        let message = ToShell::FileChooser {
            request: id,
            mode: match request.kind {
                Kind::Open => lwfa_proto::FileChooserMode::Open,
                Kind::Save => lwfa_proto::FileChooserMode::Save,
                Kind::SaveFiles => lwfa_proto::FileChooserMode::SaveFiles,
            },
            multiple: request.multiple,
            directory: request.directory,
            title: request.title,
            app_id: request.app_id,
            accept_label: request.accept_label,
            suggested_name: request.suggested_name,
            filters: request.filters,
            names: request.names.clone(),
            places: places(),
            ticket: ticket.clone(),
        };

        self.upload_gates.lock().unwrap().insert(
            id,
            crate::upload::Gate {
                ticket,
                cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                partial_dir: crate::upload::partial_dir(id),
                roots: std::collections::HashMap::new(),
                attached: false,
            },
        );

        let mut pending = PendingFile {
            reply: request.reply,
            kind: request.kind,
            directory: request.directory,
            handle: request.handle,
            names: request.names,
            session: None,
            message,
            uploads: Vec::new(),
            expiry: None,
        };

        match self.file_dialog_target() {
            Some(session) => {
                pending.session = Some(session);
                self.send_to_session(session, pending.message.clone());
            }
            None => {
                tracing::info!("file dialog {id} is waiting for a shell to connect");
                pending.expiry = self.schedule_file_expiry(id);
            }
        }
        self.pending_files.insert(id, pending);
    }

    /// Who should be shown a new or orphaned dialog right now.
    fn file_dialog_target(&self) -> Option<lwfa_proto::SessionId> {
        self.primary
            .filter(|id| {
                self.sessions
                    .get(id)
                    .is_some_and(|s| s.permissions.may_interact())
            })
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|(_, s)| s.permissions.may_interact())
                    .map(|(id, _)| *id)
            })
    }

    fn schedule_file_expiry(
        &mut self,
        id: u64,
    ) -> Option<smithay::reexports::calloop::RegistrationToken> {
        use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
        self.loop_handle
            .insert_source(Timer::from_duration(ORPHAN_GRACE), move |_, _, data| {
                data.expire_file_dialog(id);
                TimeoutAction::Drop
            })
            .ok()
    }

    fn expire_file_dialog(&mut self, id: u64) {
        // Only still-orphaned dialogs expire; adoption removes the timer,
        // but a timer that already fired cannot be removed, so re-check.
        if self
            .pending_files
            .get(&id)
            .is_some_and(|p| p.session.is_none())
        {
            tracing::info!("file dialog {id} expired with no shell to answer it");
            self.end_file_dialog(id, None);
        }
    }

    /// The caller withdrew its request (`Close` on the request object).
    pub fn file_close_by_handle(&mut self, handle: &str) {
        let Some((&id, _)) = self.pending_files.iter().find(|(_, p)| p.handle == handle) else {
            return;
        };
        tracing::info!("application withdrew file dialog {id}");
        self.end_file_dialog(id, None);
    }

    /// A session died. Its dialogs go dormant instead of dying with it.
    pub fn orphan_file_dialogs(&mut self, session: lwfa_proto::SessionId) {
        let orphaned: Vec<u64> = self
            .pending_files
            .iter()
            .filter(|(_, p)| p.session == Some(session))
            .map(|(id, _)| *id)
            .collect();
        for id in orphaned {
            if let Some(pending) = self.pending_files.get_mut(&id) {
                pending.session = None;
            }
            let timer = self.schedule_file_expiry(id);
            if let Some(pending) = self.pending_files.get_mut(&id) {
                pending.expiry = timer;
            }
            tracing::info!("file dialog {id} orphaned; holding for {ORPHAN_GRACE:?}");
        }
    }

    /// A session arrived; hand it every dialog nobody is showing.
    pub fn adopt_file_dialogs(&mut self, session: lwfa_proto::SessionId) {
        if !self
            .sessions
            .get(&session)
            .is_some_and(|s| s.permissions.may_interact())
        {
            return;
        }
        let orphans: Vec<u64> = self
            .pending_files
            .iter()
            .filter(|(_, p)| p.session.is_none())
            .map(|(id, _)| *id)
            .collect();
        for id in orphans {
            let message = {
                let Some(pending) = self.pending_files.get_mut(&id) else {
                    continue;
                };
                pending.session = Some(session);
                if let Some(token) = pending.expiry.take() {
                    self.loop_handle.remove(token);
                }
                pending.message.clone()
            };
            tracing::info!("file dialog {id} adopted by session {session}");
            self.send_to_session(session, message);
        }
    }

    /// One directory, for the dialog's browser. Errors travel in the reply.
    pub fn list_dir(&mut self, session: lwfa_proto::SessionId, request: u64, path: &str) {
        if !self.file_request_belongs(session, request) {
            return;
        }
        let path = if path.is_empty() || path == "~" {
            crate::upload::home_dir()
        } else {
            PathBuf::from(path)
        };

        let (canonical, entries, truncated, error) = match read_dir_sorted(&path) {
            Ok((entries, truncated)) => (
                std::fs::canonicalize(&path).unwrap_or(path),
                entries,
                truncated,
                None,
            ),
            Err(err) => (path, Vec::new(), false, Some(err.to_string())),
        };
        self.send_to_session(
            session,
            ToShell::DirListing {
                request,
                path: canonical.to_string_lossy().into_owned(),
                entries,
                truncated,
                error,
            },
        );
    }

    /// Everything worth knowing about one path, for the details panel.
    pub fn stat_path(&mut self, session: lwfa_proto::SessionId, request: u64, path: &str) {
        if !self.file_request_belongs(session, request) {
            return;
        }
        let info = describe_path(request, Path::new(path));
        self.send_to_session(session, info);
    }

    /// A file finished arriving on the dialog's upload channel.
    pub fn file_uploaded(&mut self, finished: crate::upload::Finished) {
        match self.pending_files.get_mut(&finished.request) {
            Some(pending) => pending.uploads.push(finished),
            None => {
                // The dialog ended in the moment the last chunk landed. The
                // answer has already been given without this file, so it
                // must not linger as a surprise in ~/Uploads.
                tracing::debug!(
                    "upload finished for a dialog that is gone; removing {}",
                    finished.path.display()
                );
                match finished.root {
                    Some(root) => {
                        let _ = std::fs::remove_dir_all(root);
                    }
                    None => {
                        let _ = std::fs::remove_file(&finished.path);
                    }
                }
            }
        }
    }

    /// The human answered: these machine paths, plus everything uploaded.
    pub fn file_chosen(
        &mut self,
        session: lwfa_proto::SessionId,
        request: u64,
        paths: Vec<String>,
    ) {
        if !self.file_request_belongs(session, request) {
            return;
        }
        let Some(pending) = self.pending_files.remove(&request) else {
            return;
        };
        self.drop_file_gate(request);

        let uris = compose_answer(&pending, &paths);
        if uris.is_empty() {
            // An empty answer is a cancel however it was meant, and a cancel
            // must not leave uploads behind.
            discard_uploads(&pending.uploads);
        }
        let _ = pending.reply.send(FileReply {
            cancelled: uris.is_empty(),
            uris,
        });
    }

    /// The human dismissed the dialog.
    pub fn file_cancel(&mut self, session: lwfa_proto::SessionId, request: u64) {
        if !self.file_request_belongs(session, request) {
            return;
        }
        self.end_file_dialog(request, None);
    }

    /// End a dialog without an answer, telling the shell showing it if any.
    ///
    /// The one funnel for every no-answer ending: cancel, withdrawal,
    /// expiry, engine shutdown. Uploads are deleted, the upload gate is
    /// closed (which stops any transfer mid-flight), and dropping the reply
    /// sender tells the portal "cancelled".
    fn end_file_dialog(&mut self, request: u64, but_not: Option<lwfa_proto::SessionId>) {
        let Some(pending) = self.pending_files.remove(&request) else {
            return;
        };
        if let Some(token) = pending.expiry {
            self.loop_handle.remove(token);
        }
        self.drop_file_gate(request);
        discard_uploads(&pending.uploads);
        if let Some(session) = pending.session.filter(|s| Some(*s) != but_not) {
            self.send_to_session(session, ToShell::FileChooserClosed { request });
        }
        let _ = pending.reply.send(FileReply {
            uris: Vec::new(),
            cancelled: true,
        });
    }

    /// Close the upload gate: refuse new connections, stop a live one, and
    /// remove the partial directory.
    pub(crate) fn drop_file_gate(&mut self, request: u64) {
        let gate = self.upload_gates.lock().unwrap().remove(&request);
        if let Some(gate) = gate {
            gate.cancelled.store(true, Ordering::Relaxed);
            let _ = std::fs::remove_dir_all(&gate.partial_dir);
        }
    }

    /// Whether this request exists and is being shown by this session.
    ///
    /// A stale or forged id is ignored rather than answered: the only party
    /// who could send one is a session that no longer owns the dialog.
    fn file_request_belongs(&self, session: lwfa_proto::SessionId, request: u64) -> bool {
        self.pending_files
            .get(&request)
            .is_some_and(|p| p.session == Some(session))
    }
}

/// Turn the human's selections into the portal's `file://` URIs.
fn compose_answer(pending: &PendingFile, paths: &[String]) -> Vec<String> {
    match pending.kind {
        Kind::Open => {
            let picked = paths.iter().map(|p| file_uri(Path::new(p)));
            if pending.directory {
                // Folder mode answers with folders: picked ones, and the
                // root of anything uploaded as a folder. An upload without
                // a folder shape has no place in this answer.
                let mut roots: Vec<&PathBuf> = Vec::new();
                for upload in &pending.uploads {
                    if let Some(root) = &upload.root
                        && !roots.contains(&root)
                    {
                        roots.push(root);
                    }
                }
                picked
                    .chain(roots.into_iter().map(|r| file_uri(r)))
                    .collect()
            } else {
                picked
                    .chain(pending.uploads.iter().map(|u| file_uri(&u.path)))
                    .collect()
            }
        }
        Kind::Save => {
            // The shell sends one composed path; the name in it is taken as
            // a name however it arrived. `../` typed into the name field
            // becomes a filename, not a step upward.
            let Some(first) = paths.first() else {
                return Vec::new();
            };
            let path = Path::new(first);
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                return Vec::new();
            };
            let parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
            vec![file_uri(&parent.join(name))]
        }
        Kind::SaveFiles => {
            // The shell picked a folder; the engine composes the announced
            // names into it, uniquified so nothing present is clobbered.
            let Some(dir) = paths.first() else {
                return Vec::new();
            };
            let dir = PathBuf::from(dir);
            pending
                .names
                .iter()
                .filter_map(|name| {
                    let clean = Path::new(name).file_name()?;
                    Some(file_uri(&crate::upload::unique_path(
                        &dir,
                        &clean.to_string_lossy(),
                    )))
                })
                .collect()
        }
    }
}

fn discard_uploads(uploads: &[crate::upload::Finished]) {
    for upload in uploads {
        match &upload.root {
            Some(root) => {
                let _ = std::fs::remove_dir_all(root);
            }
            None => {
                let _ = std::fs::remove_file(&upload.path);
            }
        }
    }
}

/// Describe one path for the details panel.
///
/// `symlink_metadata` first, so a link is reported as a link with its
/// target rather than silently as whatever it points at; the target's own
/// metadata then fills in size and times, which is what a person asking
/// about a link actually wants to know.
fn describe_path(request: u64, path: &Path) -> ToShell {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());

    let link = std::fs::symlink_metadata(path);
    let meta = std::fs::metadata(path);
    let (Ok(link), Ok(meta)) = (link, meta) else {
        let err = std::fs::metadata(path).err().map(|e| e.to_string());
        return ToShell::PathInfo {
            request,
            path: canonical.to_string_lossy().into_owned(),
            name,
            kind: lwfa_proto::PathKind::Other,
            size: 0,
            modified: None,
            created: None,
            accessed: None,
            mode: String::new(),
            owner: String::new(),
            group: String::new(),
            mime: String::new(),
            target: None,
            items: None,
            error: Some(err.unwrap_or_else(|| "cannot read this path".to_string())),
        };
    };

    let kind = if link.file_type().is_symlink() {
        lwfa_proto::PathKind::Symlink
    } else if meta.is_dir() {
        lwfa_proto::PathKind::Dir
    } else if meta.is_file() {
        lwfa_proto::PathKind::File
    } else {
        lwfa_proto::PathKind::Other
    };

    let stamp = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
    };

    // Counted rather than guessed, and only for a directory that can be
    // read: "42 items" is the only honest answer to "how big is a folder"
    // without walking the whole tree, which a properties panel must not do.
    let items = if meta.is_dir() {
        std::fs::read_dir(path)
            .ok()
            .map(|entries| entries.filter_map(Result::ok).count() as u64)
    } else {
        None
    };

    let mime = if meta.is_file() {
        match crate::preview::mime_for(&canonical) {
            "application/octet-stream" => String::new(),
            known => known.to_string(),
        }
    } else {
        String::new()
    };

    ToShell::PathInfo {
        request,
        path: canonical.to_string_lossy().into_owned(),
        name,
        kind,
        size: meta.len(),
        modified: stamp(meta.modified()),
        created: stamp(meta.created()),
        accessed: stamp(meta.accessed()),
        mode: rwx(meta.permissions().mode()),
        owner: user_name(meta.uid()).unwrap_or_else(|| meta.uid().to_string()),
        group: meta.gid().to_string(),
        mime,
        target: std::fs::read_link(path)
            .ok()
            .map(|t| t.to_string_lossy().into_owned()),
        items,
        error: None,
    }
}

/// Permission bits as `rwxr-xr-x`.
fn rwx(mode: u32) -> String {
    let bit = |shift: u32, flag: u32, ch: char| {
        if mode >> shift & flag != 0 { ch } else { '-' }
    };
    [
        bit(6, 0b100, 'r'),
        bit(6, 0b010, 'w'),
        bit(6, 0b001, 'x'),
        bit(3, 0b100, 'r'),
        bit(3, 0b010, 'w'),
        bit(3, 0b001, 'x'),
        bit(0, 0b100, 'r'),
        bit(0, 0b010, 'w'),
        bit(0, 0b001, 'x'),
    ]
    .into_iter()
    .collect()
}

/// A uid's login name, from `/etc/passwd`.
///
/// Read directly rather than through libc's `getpwuid`, which is not
/// thread-safe in its simple form and would pull NSS into a compositor for
/// one string. A uid with no entry keeps its number, which is honest.
fn user_name(uid: u32) -> Option<String> {
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    passwd.lines().find_map(|line| {
        let mut fields = line.split(':');
        let name = fields.next()?;
        let _password = fields.next()?;
        let id: u32 = fields.next()?.parse().ok()?;
        (id == uid).then(|| name.to_string())
    })
}

/// The sidebar's starting points: home, then whichever user directories
/// actually exist.
///
/// Read from `user-dirs.dirs` where the XDG spec puts it, because a
/// localised desktop calls them `Documentos` or `ドキュメント` and a
/// hardcoded English list would send people to folders that are not there.
/// Falls back to the English defaults when that file is absent, which is
/// what the spec says they are.
fn places() -> Vec<lwfa_proto::Place> {
    let home = crate::upload::home_dir();
    let mut places = vec![lwfa_proto::Place {
        name: "Home".to_string(),
        path: home.to_string_lossy().into_owned(),
    }];

    // XDG_DESKTOP_DIR="$HOME/Desktop" and friends, one per line.
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let declared: std::collections::HashMap<String, String> =
        std::fs::read_to_string(config.join("user-dirs.dirs"))
            .map(|text| {
                text.lines()
                    .filter_map(|line| {
                        let line = line.trim();
                        let rest = line.strip_prefix("XDG_")?.strip_suffix('"')?;
                        let (key, value) = rest.split_once("_DIR=\"")?;
                        Some((key.to_string(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();

    // Ordered the way a sidebar reads, not alphabetically.
    const WANTED: [(&str, &str); 6] = [
        ("DESKTOP", "Desktop"),
        ("DOCUMENTS", "Documents"),
        ("DOWNLOAD", "Downloads"),
        ("PICTURES", "Pictures"),
        ("MUSIC", "Music"),
        ("VIDEOS", "Videos"),
    ];
    for (key, label) in WANTED {
        let path = match declared.get(key) {
            // "$HOME/Documents" is the spec's own spelling.
            Some(raw) => PathBuf::from(
                raw.replace("$HOME/", &format!("{}/", home.to_string_lossy()))
                    .replace("$HOME", &home.to_string_lossy()),
            ),
            None => home.join(label),
        };
        if path.is_dir() {
            places.push(lwfa_proto::Place {
                name: label.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }

    // Where this feature's own uploads land, once there are any. Listed
    // last because it is lwfa's folder rather than one of the user's.
    let uploads = home.join("Uploads");
    if uploads.is_dir() {
        places.push(lwfa_proto::Place {
            name: "Uploads".to_string(),
            path: uploads.to_string_lossy().into_owned(),
        });
    }
    places
}

/// How many entries a listing may carry. Big enough for any directory a
/// human browses on purpose; small enough that `node_modules` cannot flood
/// the socket. The shell is told when the cap bites.
const LISTING_CAP: usize = 3000;

/// A directory, sorted the way a file browser reads: directories first,
/// then case-insensitive by name.
fn read_dir_sorted(path: &Path) -> std::io::Result<(Vec<lwfa_proto::DirEntry>, bool)> {
    let mut entries: Vec<lwfa_proto::DirEntry> = std::fs::read_dir(path)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = entry.metadata().ok()?;
            Some(lwfa_proto::DirEntry {
                name,
                dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                // Whole seconds: a browser number is only exact to 2^53,
                // and no file dialog has ever needed better than a second.
                // `None` rather than 0 where the filesystem will not say,
                // so the dialog can show a dash instead of 1970.
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let truncated = entries.len() > LISTING_CAP;
    entries.truncate(LISTING_CAP);
    Ok((entries, truncated))
}

/// `file://` URI for a local path, the shape portal replies carry.
///
/// Percent-encoded byte-wise: everything outside the unreserved set and `/`
/// is escaped, which is what makes a filename with spaces (or worse) survive
/// the trip through the application's URI parser.
fn file_uri(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut uri = String::from("file://");
    for &byte in path.as_os_str().as_bytes() {
        let plain =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/');
        if plain {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uri_escapes_the_awkward() {
        assert_eq!(
            file_uri(Path::new("/home/u/My File (1).png")),
            "file:///home/u/My%20File%20%281%29.png"
        );
        assert_eq!(
            file_uri(Path::new("/plain/path.txt")),
            "file:///plain/path.txt"
        );
    }
}
