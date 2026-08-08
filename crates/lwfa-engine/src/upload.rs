//! The upload channel: file bytes from the client device to this machine.
//!
//! # Why a channel of its own
//!
//! The session WebSocket carries video, audio and input, all of which are
//! latency-sensitive. A 100MB file queued behind (or in front of) them
//! would either stutter the stream or starve the upload, and TCP gives no
//! way to prioritise within one connection. So uploads ride a *separate*
//! WebSocket to the same port, one per open dialog: the kernel schedules
//! the two connections independently and neither can block the other.
//!
//! # Authentication
//!
//! The connection presents a ticket, not the session password. The ticket
//! is minted by the engine when a dialog opens, travels to the shell inside
//! [`lwfa_proto::ToShell::FileChooser`] over the already-authenticated
//! session socket, and dies with the dialog. So the password never appears
//! in an upload URL, and a leaked ticket authorises exactly one thing:
//! sending files to one dialog that a human is looking at.
//!
//! # The wire
//!
//! Text frames are [`lwfa_proto::ToEngine`] / [`lwfa_proto::ToShell`]
//! messages; binary frames are raw file bytes. Strictly sequential per
//! connection: `uploadBegin`, then the bytes, then `uploadEnd`, then the
//! next file. The engine answers `uploadBegin` with `uploadOffset`, which
//! is zero for a fresh file and the surviving byte count for a resumed one;
//! acknowledges progress with `uploadProgress` as bytes reach the disk; and
//! closes each file with `uploadDone` after the size and the SHA-256 both
//! match, the file is flushed, and it has been moved into place.
//!
//! # Where files live
//!
//! In flight: `~/Uploads/.partial/<request>/<file id>`, which is what makes
//! resume possible and what the compositor deletes when a dialog ends.
//! Finished: `~/Uploads`, renamed rather than copied (same filesystem by
//! construction), with collisions renamed `photo-2.jpg` style. A folder
//! upload gets one uniquified root and keeps its shape underneath.
//!
//! # Threading
//!
//! Each upload connection runs on its own thread, blocking reads and
//! blocking writes: the disk applying backpressure to the socket is TCP
//! doing its job. The compositor only hears about *finished* files, over
//! the same calloop channel the shell events use. Everything the two sides
//! share sits in [`Gates`], which the compositor owns the lifecycle of.

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::Digest;

/// Everything the accept thread and the upload threads share, keyed by
/// dialog request id. The compositor inserts a gate when a dialog opens and
/// removes it when the dialog ends, so the map is also the authorisation
/// list: no gate, no connection.
pub type Gates = Arc<Mutex<HashMap<u64, Gate>>>;

/// One dialog's upload state.
pub struct Gate {
    /// The credential the connection must present.
    pub ticket: String,
    /// Set by the compositor when the dialog ends. Upload threads poll it
    /// and stop; the compositor deletes the files.
    pub cancelled: Arc<AtomicBool>,
    /// Where partial files accumulate, `~/Uploads/.partial/<request>`.
    pub partial_dir: PathBuf,
    /// Folder-name mapping, so every file of one uploaded folder lands
    /// under the same uniquified root instead of `photos` and `photos-2`
    /// each getting half.
    pub roots: HashMap<String, PathBuf>,
    /// Whether a connection is currently attached. One per dialog: the
    /// shell uploads sequentially, so a second connection is a bug or a
    /// replay, and either way it is refused.
    pub attached: bool,
}

/// A finished upload, reported to the compositor.
///
/// Only finished ones: the compositor answers the portal with whole files
/// or not at all, and progress is the upload connection's own business.
#[derive(Debug)]
pub struct Finished {
    pub request: u64,
    /// The final resting place, inside `~/Uploads`.
    pub path: PathBuf,
    /// The uniquified top-level folder, when this file arrived as part of
    /// one. What a directory-mode dialog answers with.
    pub root: Option<PathBuf>,
}

/// How often written-byte counts are reported back, at most.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// The read timeout, which is also how often a quiet connection notices the
/// dialog was cancelled underneath it.
const READ_TIMEOUT: Duration = Duration::from_millis(500);

/// An upload connection that sends nothing for this long is dead. Generous:
/// a client mid-backoff after a network flap reconnects fresh rather than
/// resuming the old socket.
const IDLE_LIMIT: Duration = Duration::from_secs(60);

/// Serve one upload connection. Runs on its own `lwfa-upload` thread.
///
/// `stream` is a fresh TCP connection whose request head named `/upload`;
/// the WebSocket handshake happens here so a stalled client cannot hold up
/// the accept loop.
pub fn serve(
    stream: TcpStream,
    gates: Gates,
    events: smithay::reexports::calloop::channel::Sender<crate::shell::ShellEvent>,
) {
    let Some((socket, request, cancelled)) = handshake(stream, &gates) else {
        return;
    };
    let outcome = pump(socket, request, &gates, &cancelled, &events);
    if let Err(reason) = outcome {
        tracing::debug!("upload connection for dialog {request} ended: {reason}");
    }
    if let Some(gate) = gates.lock().unwrap().get_mut(&request) {
        gate.attached = false;
    }
}

/// Validate the ticket and upgrade the socket, or say nothing to a stranger.
// The large Err is tungstenite's own callback contract: the error variant
// carries the HTTP response to send. Not worth boxing what the API dictates.
#[allow(clippy::result_large_err)]
fn handshake(
    stream: TcpStream,
    gates: &Gates,
) -> Option<(tungstenite::WebSocket<TcpStream>, u64, Arc<AtomicBool>)> {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let mut admitted: Option<(u64, Arc<AtomicBool>)> = None;
    let accepted = tungstenite::accept_hdr(
        stream,
        |request: &tungstenite::handshake::server::Request, response| {
            let uri = request.uri().to_string();
            let claim = crate::auth::param_from_query(&uri, "request")
                .and_then(|r| r.parse::<u64>().ok())
                .zip(crate::auth::param_from_query(&uri, "ticket"));
            let mut gates = gates.lock().unwrap();
            let allowed = claim.and_then(|(id, ticket)| {
                let gate = gates.get_mut(&id)?;
                // Constant-time, same as the session password. A ticket is
                // short-lived, but timing oracles are free to avoid.
                if !crate::auth::token_matches(&gate.ticket, &ticket) {
                    return None;
                }
                if gate.attached || gate.cancelled.load(Ordering::Relaxed) {
                    return None;
                }
                gate.attached = true;
                Some((id, Arc::clone(&gate.cancelled)))
            });
            match allowed {
                Some(entry) => {
                    admitted = Some(entry);
                    Ok(response)
                }
                None => Err(tungstenite::http::Response::builder()
                    .status(tungstenite::http::StatusCode::UNAUTHORIZED)
                    .body(Some("missing or invalid upload ticket".to_string()))
                    .expect("static response should build")),
            }
        },
    );

    let socket = match accepted {
        Ok(socket) => socket,
        Err(err) => {
            // Expected whenever a stale dialog's shell reconnects late.
            tracing::debug!("rejected an upload connection: {err}");
            return None;
        }
    };
    let _ = socket.get_ref().set_read_timeout(Some(READ_TIMEOUT));
    let (request, cancelled) = admitted?;
    Some((socket, request, cancelled))
}

/// One file mid-transfer.
struct InFlight {
    id: String,
    file: std::fs::File,
    partial: PathBuf,
    /// The destination name and folder path, decided at `begin` so a bad
    /// announcement fails before any bytes move.
    name: String,
    rel: Vec<String>,
    announced: u64,
    written: u64,
    hasher: sha2::Sha256,
    last_progress: Instant,
    last_acked: u64,
}

/// Read messages until the connection ends, the dialog is cancelled, or the
/// client goes quiet for [`IDLE_LIMIT`].
fn pump(
    mut socket: tungstenite::WebSocket<TcpStream>,
    request: u64,
    gates: &Gates,
    cancelled: &AtomicBool,
    events: &smithay::reexports::calloop::channel::Sender<crate::shell::ShellEvent>,
) -> Result<(), String> {
    let mut current: Option<InFlight> = None;
    let mut last_heard = Instant::now();

    loop {
        if cancelled.load(Ordering::Relaxed) {
            // The compositor deletes the partial directory; just stop.
            let _ = socket.close(None);
            return Ok(());
        }
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(err))
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if last_heard.elapsed() > IDLE_LIMIT {
                    return Err("idle too long".into());
                }
                continue;
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return Ok(());
            }
            Err(err) => return Err(err.to_string()),
        };
        last_heard = Instant::now();

        match message {
            tungstenite::Message::Text(text) => {
                match serde_json::from_str::<lwfa_proto::ToEngine>(&text) {
                    Ok(lwfa_proto::ToEngine::UploadBegin {
                        request: claimed,
                        file,
                        name,
                        rel,
                        size,
                    }) if claimed == request => {
                        current = begin(&mut socket, request, gates, file, name, rel, size)?;
                    }
                    Ok(lwfa_proto::ToEngine::UploadEnd {
                        request: claimed,
                        file,
                        sha256,
                    }) if claimed == request => {
                        finish(
                            &mut socket,
                            request,
                            gates,
                            events,
                            current.take(),
                            &file,
                            &sha256,
                        )?;
                    }
                    Ok(_) | Err(_) => {
                        // Anything else on this channel is a client bug. Said
                        // out loud rather than ignored, because a silently
                        // dropped `uploadEnd` is an upload stuck at 100%.
                        return Err(format!("unexpected message: {text}"));
                    }
                }
            }
            tungstenite::Message::Binary(bytes) => {
                let Some(flight) = current.as_mut() else {
                    return Err("bytes with no announced file".into());
                };
                receive_chunk(&mut socket, request, flight, &bytes)?;
            }
            tungstenite::Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
}

/// Open (or reopen) the partial file and answer with the resume offset.
fn begin(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    request: u64,
    gates: &Gates,
    id: String,
    name: String,
    rel: Vec<String>,
    size: u64,
) -> Result<Option<InFlight>, String> {
    // The id names a file on this disk, so it is held to characters that
    // cannot mean anything to a path. The client generates opaque ids; one
    // that fails this was not generated by our client.
    let clean_id: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if clean_id.is_empty() || clean_id != id {
        return Err("unusable file id".into());
    }
    let Some(name) = sanitise_component(&name) else {
        return Err("unusable file name".into());
    };
    let rel: Option<Vec<String>> = rel.iter().map(|c| sanitise_component(c)).collect();
    let Some(rel) = rel else {
        return Err("unusable folder path".into());
    };
    if rel.len() > 32 {
        return Err("folder nested implausibly deep".into());
    }

    let partial_dir = {
        let gates = gates.lock().unwrap();
        let Some(gate) = gates.get(&request) else {
            return Err("dialog gone".into());
        };
        gate.partial_dir.clone()
    };
    std::fs::create_dir_all(&partial_dir)
        .map_err(|err| format!("could not create the partial directory: {err}"))?;

    // Refuse what cannot fit before any bytes move. The margin keeps the
    // upload from being the thing that runs the disk to zero.
    if let Some(free) = free_space(&partial_dir) {
        const MARGIN: u64 = 256 * 1024 * 1024;
        if size.saturating_add(MARGIN) > free {
            send(
                socket,
                &lwfa_proto::ToShell::UploadDone {
                    request,
                    file: clean_id,
                    name: String::new(),
                    ok: false,
                    error: Some("not enough space on the machine".to_string()),
                },
            )?;
            return Ok(None);
        }
    }

    let partial = partial_dir.join(&clean_id);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(&partial)
        .map_err(|err| format!("could not open the partial file: {err}"))?;

    // Whatever survived an earlier attempt is the resume offset, and it has
    // to be re-hashed: the checksum covers the whole file, not this
    // connection's share of it.
    let mut offset = file
        .metadata()
        .map_err(|err| format!("could not stat the partial file: {err}"))?
        .len();
    let mut hasher = sha2::Sha256::new();
    if offset > size {
        // The client re-picked a smaller file under the same id. Whatever
        // this is, resuming it would be corruption; start over.
        file.set_len(0)
            .and_then(|()| file.seek(std::io::SeekFrom::Start(0)).map(|_| ()))
            .map_err(|err| format!("could not reset the partial file: {err}"))?;
        offset = 0;
    } else if offset > 0 {
        file.seek(std::io::SeekFrom::Start(0))
            .map_err(|err| format!("could not rewind the partial file: {err}"))?;
        let mut reader = std::io::BufReader::new(&mut file);
        let mut buf = vec![0u8; 256 * 1024];
        let mut left = offset;
        while left > 0 {
            let take = buf.len().min(left as usize);
            reader
                .read_exact(&mut buf[..take])
                .map_err(|err| format!("could not re-hash the partial file: {err}"))?;
            hasher.update(&buf[..take]);
            left -= take as u64;
        }
        file.seek(std::io::SeekFrom::End(0))
            .map_err(|err| format!("could not seek the partial file: {err}"))?;
    }

    send(
        socket,
        &lwfa_proto::ToShell::UploadOffset {
            request,
            file: clean_id.clone(),
            offset,
        },
    )?;

    Ok(Some(InFlight {
        id: clean_id,
        file,
        partial,
        name,
        rel,
        announced: size,
        written: offset,
        hasher,
        last_progress: Instant::now(),
        last_acked: offset,
    }))
}

/// One binary chunk: to disk, into the hash, and periodically acknowledged.
fn receive_chunk(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    request: u64,
    flight: &mut InFlight,
    bytes: &[u8],
) -> Result<(), String> {
    if flight.written + bytes.len() as u64 > flight.announced {
        return Err("more bytes than announced".into());
    }
    flight
        .file
        .write_all(bytes)
        .map_err(|err| format!("write to {} failed: {err}", flight.partial.display()))?;
    flight.hasher.update(bytes);
    flight.written += bytes.len() as u64;

    // Acknowledged on a clock, not per chunk: an ack per 256KB chunk on a
    // fast LAN would be thousands of tiny frames saying nothing new.
    if flight.last_progress.elapsed() >= PROGRESS_EVERY && flight.written != flight.last_acked {
        flight.last_progress = Instant::now();
        flight.last_acked = flight.written;
        send(
            socket,
            &lwfa_proto::ToShell::UploadProgress {
                request,
                file: flight.id.clone(),
                written: flight.written,
            },
        )?;
    }
    Ok(())
}

/// Verify, flush, and move into place; then tell both sides.
fn finish(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    request: u64,
    gates: &Gates,
    events: &smithay::reexports::calloop::channel::Sender<crate::shell::ShellEvent>,
    current: Option<InFlight>,
    id: &str,
    claimed_sha: &str,
) -> Result<(), String> {
    let Some(flight) = current else {
        return Err("end with no announced file".into());
    };
    if flight.id != id {
        return Err("end for a different file than announced".into());
    }

    let fail = |socket: &mut tungstenite::WebSocket<TcpStream>, error: String| {
        let _ = std::fs::remove_file(&flight.partial);
        send(
            socket,
            &lwfa_proto::ToShell::UploadDone {
                request,
                file: flight.id.clone(),
                name: String::new(),
                ok: false,
                error: Some(error),
            },
        )
    };

    if flight.written != flight.announced {
        return fail(
            socket,
            format!("received {} of {} bytes", flight.written, flight.announced),
        );
    }
    let digest: String = flight
        .hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if !digest.eq_ignore_ascii_case(claimed_sha) {
        return fail(socket, "checksum mismatch".to_string());
    }
    // Flushed all the way down before anyone is told "ok". An ack that the
    // page cache heard is not an ack.
    if let Err(err) = flight.file.sync_all() {
        return fail(socket, format!("could not flush: {err}"));
    }
    drop(flight.file);

    // Decide the destination under the gates lock, so two files of the same
    // folder agree on the root and two same-named files cannot race one
    // final path.
    let (path, root) = {
        let mut gates = gates.lock().unwrap();
        let Some(gate) = gates.get_mut(&request) else {
            let _ = std::fs::remove_file(&flight.partial);
            return Err("dialog gone".into());
        };
        let uploads = match uploads_dir() {
            Ok(dir) => dir,
            Err(err) => {
                return fail(socket, format!("no uploads directory: {err}"));
            }
        };
        match flight.rel.split_first() {
            None => (unique_path(&uploads, &flight.name), None),
            Some((top, inner)) => {
                let root = gate
                    .roots
                    .entry(top.clone())
                    .or_insert_with(|| unique_path(&uploads, top))
                    .clone();
                let dir = inner.iter().fold(root.clone(), |dir, part| dir.join(part));
                (unique_path(&dir, &flight.name), Some(root))
            }
        }
    };
    if let Some(parent) = path.parent()
        && let Err(err) = std::fs::create_dir_all(parent)
    {
        return fail(socket, format!("could not create the folder: {err}"));
    }
    if let Err(err) = std::fs::rename(&flight.partial, &path) {
        return fail(socket, format!("could not move into place: {err}"));
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    send(
        socket,
        &lwfa_proto::ToShell::UploadDone {
            request,
            file: flight.id.clone(),
            name: name.clone(),
            ok: true,
            error: None,
        },
    )?;
    // The compositor folds it into the dialog's eventual answer. If the
    // dialog died in the moment between the rename and this landing, the
    // compositor deletes the file instead; nothing leaks either way.
    let _ = events.send(crate::shell::ShellEvent::Uploaded(Finished {
        request,
        path,
        root,
    }));
    Ok(())
}

fn send(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    message: &lwfa_proto::ToShell,
) -> Result<(), String> {
    let json = serde_json::to_string(message).map_err(|err| err.to_string())?;
    socket
        .send(tungstenite::Message::Text(json.into()))
        .map_err(|err| err.to_string())
}

/// One path component the client suggested, reduced to something harmless.
///
/// The client names files; this side decides paths. Stripping each name to
/// its final component makes `../../.bashrc` just a strange filename, and
/// refusing dot-names keeps an upload from hiding itself.
fn sanitise_component(name: &str) -> Option<String> {
    let clean = Path::new(name).file_name()?.to_string_lossy().into_owned();
    if clean.is_empty() || clean == "." || clean == ".." {
        return None;
    }
    Some(clean)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Where uploads land: `~/Uploads`, created on first use.
pub fn uploads_dir() -> std::io::Result<PathBuf> {
    let dir = home_dir().join("Uploads");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Where a dialog's partial files accumulate.
pub fn partial_dir(request: u64) -> PathBuf {
    home_dir()
        .join("Uploads/.partial")
        .join(request.to_string())
}

/// Remove leftovers from engines that did not get to clean up.
///
/// Called once at startup: no engine is running, so no partial is resumable,
/// and a crashed session's half-files should not sit in a hidden directory
/// forever.
pub fn sweep_stale_partials() {
    let base = home_dir().join("Uploads/.partial");
    if base.exists()
        && let Err(err) = std::fs::remove_dir_all(&base)
    {
        tracing::debug!("could not sweep stale partial uploads: {err}");
    }
}

/// A path in `dir` for `name` that does not collide with anything present.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, Some(ext)),
        _ => (name, None),
    };
    for n in 2.. {
        let candidate = match ext {
            Some(ext) => dir.join(format!("{stem}-{n}.{ext}")),
            None => dir.join(format!("{stem}-{n}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("the loop above returns")
}

/// Free bytes on the filesystem holding `path`, if the kernel will say.
fn free_space(path: &Path) -> Option<u64> {
    let stat = rustix::fs::statvfs(path).ok()?;
    Some(stat.f_bavail.saturating_mul(stat.f_frsize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_becomes_a_filename_or_nothing() {
        assert_eq!(sanitise_component("../../.bashrc"), Some(".bashrc".into()));
        assert_eq!(sanitise_component("a/b/c.txt"), Some("c.txt".into()));
        assert_eq!(sanitise_component(".."), None);
        assert_eq!(sanitise_component("."), None);
        assert_eq!(sanitise_component(""), None);
        assert_eq!(sanitise_component("plain.txt"), Some("plain.txt".into()));
    }

    #[test]
    fn unique_path_counts_up_before_the_extension() {
        let dir = std::env::temp_dir().join(format!("lwfa-upload-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "photo.jpg");
        assert_eq!(first.file_name().unwrap(), "photo.jpg");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "photo.jpg");
        assert_eq!(second.file_name().unwrap(), "photo-2.jpg");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
