//! `GET /clip`: an entry's bytes, for a browser rather than for a program.
//!
//! # Why not over the session socket
//!
//! Same reason as `preview.rs`, only more so. A clipboard history holds
//! screenshots and whatever files somebody copied, and pushing those down
//! the session socket would stall the video for a panel that may never be
//! opened. A plain URL costs nothing until something asks for it: `<img
//! src>` fetches a thumbnail when a row scrolls into view, a download link
//! streams a 400MB file straight to disk, and neither touches the stream.
//!
//! # What may be read
//!
//! Only entries in the history, only with a live session's clipboard
//! ticket, and only while that session is connected: the ticket is minted
//! in the greeting and destroyed when the socket dies. That is the same
//! authority the panel already has, expressed as a URL because a browser
//! cannot put a WebSocket in an `<img>` tag.
//!
//! Paths are never taken from the request. The id names a history entry and
//! the engine decides what file that is, so there is no path to traverse.
//!
//! # Three shapes of answer
//!
//! - `?id=` alone: the bytes, inline, for a browser to display.
//! - `?id=&thumb=1`: a small JPEG of an image entry, made once and kept.
//!   A phone on a mobile connection should not pull a 12-megapixel
//!   screenshot to draw a row 80 pixels tall.
//! - `?id=&download=1`: the same bytes with a filename attached, so the
//!   browser saves rather than renders.

use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use crate::clipboard::{Served, Store};

const TIMEOUT: Duration = Duration::from_secs(60);

/// Bytes per copy from disk to socket. Same reasoning as `preview.rs`: big
/// enough to keep a download moving, small enough that a stalled client does
/// not pin a megabyte per thread.
const CHUNK: usize = 64 * 1024;

/// The longest edge of a thumbnail. Enough for a retina row, small enough
/// that twenty of them are cheaper than one of the originals.
const THUMB: u32 = 480;

/// Serve `GET /clip?channel=&ticket=&id=[&thumb=1][&download=1]`.
///
/// Runs on its own thread, one per request.
pub fn serve(mut stream: TcpStream, head: &[u8], gates: &crate::upload::Gates, store: &Store) {
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let Some((method, target)) = crate::http::request_line(head) else {
        let _ = simple(&mut stream, 400, "bad request");
        return;
    };
    if method != "GET" && method != "HEAD" {
        let _ = simple(&mut stream, 405, "method not allowed");
        return;
    }

    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let param = |name: &str| crate::auth::param_from_query(&format!("/?{query}"), name);

    // The ticket belongs to a live session's clipboard channel, and the
    // channel is removed when that session disconnects.
    let authorised = param("channel")
        .and_then(|c| c.parse::<u64>().ok())
        .zip(param("ticket"))
        .is_some_and(|(channel, ticket)| {
            gates
                .lock()
                .unwrap()
                .get(&channel)
                .is_some_and(|gate| crate::auth::token_matches(&gate.ticket, &ticket))
        });
    if !authorised {
        let _ = simple(&mut stream, 401, "missing or invalid clipboard ticket");
        return;
    }

    let Some(id) = param("id").and_then(|id| id.parse::<u64>().ok()) else {
        let _ = simple(&mut stream, 400, "no entry");
        return;
    };
    let Some(entry) = store.lock().unwrap().serve(id) else {
        // Aged out of the history, or never existed. The same answer either
        // way: there is nothing to show, and which of the two it was is not
        // the requester's business.
        let _ = simple(&mut stream, 404, "no such clipboard entry");
        return;
    };

    let with_body = method == "GET";
    let download = param("download").is_some();
    if param("thumb").is_some()
        && let Some(jpeg) = thumbnail(&entry)
    {
        let _ = send_bytes(&mut stream, &jpeg, "image/jpeg", None, with_body);
        return;
    }

    match entry {
        Served::Inline { mime, name, bytes } => {
            let filename = download.then_some(name);
            let _ = send_bytes(&mut stream, &bytes, &mime, filename.as_deref(), with_body);
        }
        Served::File { mime, name, path } => {
            let filename = download.then_some(name);
            if let Err(err) = send_file(&mut stream, &path, &mime, filename.as_deref(), with_body) {
                tracing::debug!("clipboard download of {} ended early: {err}", path.display());
            }
        }
    }
}

/// A small JPEG of an image entry, or `None` for anything that is not one.
///
/// Made on demand rather than at capture: most entries are never looked at
/// in a panel, and decoding every screenshot somebody copies would be work
/// done for nothing on the machine's own clipboard.
fn thumbnail(entry: &Served) -> Option<Vec<u8>> {
    // Beyond this it is not worth decoding to draw a row, and a hostile
    // "image" would otherwise be an easy way to spend all the memory.
    const DECODE_LIMIT: u64 = 64 * 1024 * 1024;

    let (mime, bytes) = match entry {
        Served::Inline { mime, bytes, .. } => (mime, std::borrow::Cow::Borrowed(bytes.as_slice())),
        Served::File { mime, path, .. } => {
            if std::fs::metadata(path).map_or(true, |meta| meta.len() > DECODE_LIMIT) {
                return None;
            }
            (mime, std::borrow::Cow::Owned(std::fs::read(path).ok()?))
        }
    };
    if !mime.starts_with("image/") {
        return None;
    }

    let image = image::load_from_memory(&bytes).ok()?;
    let scaled = image.resize(THUMB, THUMB, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    // JPEG, not PNG: a photograph shrunk to 480px is a third of the size as
    // JPEG, and this travels over the same mobile link as the video.
    image::DynamicImage::from(scaled.to_rgb8())
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .ok()?;
    Some(out)
}

fn send_bytes(
    stream: &mut TcpStream,
    bytes: &[u8],
    content_type: &str,
    filename: Option<&str>,
    with_body: bool,
) -> std::io::Result<()> {
    stream.write_all(headers(bytes.len() as u64, content_type, filename).as_bytes())?;
    if with_body {
        stream.write_all(bytes)?;
    }
    stream.flush()
}

fn send_file(
    stream: &mut TcpStream,
    path: &Path,
    content_type: &str,
    filename: Option<&str>,
    with_body: bool,
) -> std::io::Result<()> {
    let mut file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    stream.write_all(headers(total, content_type, filename).as_bytes())?;
    if !with_body {
        return stream.flush();
    }
    let mut buffer = vec![0u8; CHUNK];
    let mut left = total;
    while left > 0 {
        let want = CHUNK.min(left as usize);
        let read = std::io::Read::read(&mut file, &mut buffer[..want])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buffer[..read])?;
        left -= read as u64;
    }
    stream.flush()
}

fn headers(length: u64, content_type: &str, filename: Option<&str>) -> String {
    let disposition = match filename {
        // Quoted and stripped: the name comes from a file on the machine or
        // from an application's own clipboard, and a quote or a newline in
        // one would otherwise be a header the client never sees coming.
        Some(name) => format!(
            "Content-Disposition: attachment; filename=\"{}\"\r\n",
            sanitise(name)
        ),
        None => String::new(),
    };
    format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {length}\r\n\
         {disposition}\
         Cache-Control: private, max-age=31536000, immutable\r\n\
         Connection: close\r\n\r\n"
    )
}

/// A filename safe to put in a header, and safe for a browser to save.
fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\' && *c != '/')
        .take(120)
        .collect();
    if cleaned.trim().is_empty() {
        "clipboard".to_string()
    } else {
        cleaned
    }
}

fn simple(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        message.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(message.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_filename_cannot_smuggle_a_header() {
        // The name comes from whatever an application put on the clipboard,
        // so a newline in one would end the header and start another.
        assert_eq!(
            sanitise("evil\r\nX-Injected: yes\"\".txt"),
            "evilX-Injected: yes.txt"
        );
    }

    #[test]
    fn a_filename_cannot_name_a_directory() {
        assert_eq!(sanitise("../../etc/passwd"), "....etcpasswd");
    }

    #[test]
    fn a_nameless_file_still_gets_a_name() {
        assert_eq!(sanitise("   "), "clipboard");
    }

    #[test]
    fn a_download_says_so_and_a_preview_does_not() {
        assert!(headers(3, "text/plain", Some("a.txt")).contains("Content-Disposition"));
        assert!(!headers(3, "text/plain", None).contains("Content-Disposition"));
    }
}
