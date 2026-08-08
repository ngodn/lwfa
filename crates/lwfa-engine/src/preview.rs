//! Serving one file to the dialog, so a human can see what they are picking.
//!
//! # Why HTTP and not the protocol
//!
//! The obvious route would be to read the file and send it as a message.
//! That is wrong for anything large: the browser would hold the whole file
//! in memory as a blob before showing a frame of it, and a blob URL cannot
//! answer range requests, so seeking a two-hour video would mean
//! downloading a two-hour video first.
//!
//! A plain URL costs nothing instead. `<img src>`, `<video src>` and an
//! `<iframe>` for a PDF each fetch what they need, when they need it, and
//! the browser's own cache and media stack do the work. Range support here
//! is what turns a `<video>` into a seekable one.
//!
//! # What may be read
//!
//! Only while a file dialog is open, only with that dialog's ticket, and
//! only a regular file the dialog could have listed anyway. That is the
//! same authority the dialog already grants: a human is looking at a
//! chooser and about to hand one of these files to an application. It
//! stops being true the moment the dialog closes, because the gate goes
//! with it.
//!
//! Symlinks are followed by `canonicalize` and then re-checked, so a link
//! is only ever served as whatever it actually points at.

use std::io::{Read, Seek, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bytes per copy from disk to socket. Big enough to keep a video fed,
/// small enough that a stalled client does not pin a megabyte per thread.
const CHUNK: usize = 64 * 1024;

const TIMEOUT: Duration = Duration::from_secs(30);

/// Serve `GET /preview?request=&ticket=&path=`. Runs on its own thread.
pub fn serve(mut stream: TcpStream, head: &[u8], gates: &crate::upload::Gates) {
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let Some((method, target)) = super::http::request_line(head) else {
        let _ = simple(&mut stream, 400, "bad request");
        return;
    };
    if method != "GET" && method != "HEAD" {
        let _ = simple(&mut stream, 405, "method not allowed");
        return;
    }

    // The ticket is the dialog's, and the dialog must still be open: the
    // gate is removed the moment it is answered or dismissed.
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let authorised = crate::auth::param_from_query(&format!("/?{query}"), "request")
        .and_then(|r| r.parse::<u64>().ok())
        .zip(crate::auth::param_from_query(
            &format!("/?{query}"),
            "ticket",
        ))
        .is_some_and(|(id, ticket)| {
            gates
                .lock()
                .unwrap()
                .get(&id)
                .is_some_and(|gate| crate::auth::token_matches(&gate.ticket, &ticket))
        });
    if !authorised {
        let _ = simple(&mut stream, 401, "missing or invalid preview ticket");
        return;
    }

    let Some(raw) = crate::auth::param_from_query(&format!("/?{query}"), "path") else {
        let _ = simple(&mut stream, 400, "no path");
        return;
    };
    // Resolved, then re-checked: a symlink is served as its target or not
    // at all, and a directory is never a preview.
    let Ok(path) = std::fs::canonicalize(PathBuf::from(&raw)) else {
        let _ = simple(&mut stream, 404, "not found");
        return;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        let _ = simple(&mut stream, 404, "not found");
        return;
    };
    if !meta.is_file() {
        let _ = simple(&mut stream, 415, "not a file");
        return;
    }

    let total = meta.len();
    let range = parse_range(head, total);
    let with_body = method == "GET";
    if let Err(err) = send_file(&mut stream, &path, total, range, mime_for(&path), with_body) {
        tracing::debug!("preview of {} ended early: {err}", path.display());
    }
}

/// The byte range a client asked for, clamped to the file.
///
/// Only the single-range `bytes=start-end` form, which is what every media
/// element sends. A multi-range request is answered with the whole file,
/// which is legal and which no browser will ask of a video.
fn parse_range(head: &[u8], total: u64) -> Option<(u64, u64)> {
    let text = std::str::from_utf8(head).ok()?;
    let line = text
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("range:"))?;
    let spec = line.split_once('=')?.1.trim();
    if spec.contains(',') {
        return None;
    }
    let (from, to) = spec.split_once('-')?;
    let (start, end) = match (from.trim(), to.trim()) {
        // "bytes=-500": the last 500 bytes.
        ("", tail) => {
            let tail: u64 = tail.parse().ok()?;
            (total.saturating_sub(tail), total.saturating_sub(1))
        }
        (head_bytes, "") => (head_bytes.parse().ok()?, total.saturating_sub(1)),
        (head_bytes, tail) => (head_bytes.parse().ok()?, tail.parse().ok()?),
    };
    if total == 0 || start >= total {
        return None;
    }
    Some((start, end.min(total.saturating_sub(1))))
}

fn send_file(
    stream: &mut TcpStream,
    path: &Path,
    total: u64,
    range: Option<(u64, u64)>,
    content_type: &str,
    with_body: bool,
) -> std::io::Result<()> {
    let mut file = std::fs::File::open(path)?;
    let (status, start, length) = match range {
        Some((start, end)) => (206, start, end - start + 1),
        None => (200, 0, total),
    };

    let mut head = format!(
        "HTTP/1.1 {status} {}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {length}\r\n\
         Accept-Ranges: bytes\r\n",
        if status == 206 {
            "Partial Content"
        } else {
            "OK"
        },
    );
    if let Some((from, to)) = range {
        head.push_str(&format!("Content-Range: bytes {from}-{to}/{total}\r\n"));
    }
    // Never sniffed, never framed, never cached: this is somebody's private
    // file being shown once inside a dialog.
    head.push_str("X-Content-Type-Options: nosniff\r\n");
    head.push_str("Cache-Control: private, no-store\r\n");
    head.push_str("Content-Security-Policy: sandbox\r\n");
    // Readable cross-origin, because the page and the engine are not always
    // the same origin: `?engine=` points a shell at another machine, and the
    // dev server proxies from its own port. `<img>` and `<video>` render
    // cross-origin regardless, but the text preview uses `fetch`, which does
    // not, so without this a text file shows an error in exactly the setup
    // most likely to be used while developing.
    //
    // Safe to allow: the capability is the ticket, which is unguessable,
    // scoped to one open dialog and destroyed with it. No cookie or other
    // ambient credential is involved, so `*` grants nothing that presenting
    // the ticket did not already grant.
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str(
        "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n",
    );
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if !with_body {
        return stream.flush();
    }

    // Streamed rather than read whole: a video is served in 64KB steps and
    // the engine never holds more than that, however large the file is.
    file.seek(std::io::SeekFrom::Start(start))?;
    let mut left = length;
    let mut buf = vec![0u8; CHUNK];
    while left > 0 {
        let want = buf.len().min(left as usize);
        let read = file.read(&mut buf[..want])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buf[..read])?;
        left -= read as u64;
    }
    stream.flush()
}

fn simple(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        415 => "Unsupported Media Type",
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

/// The content type a browser needs to render this, by extension.
///
/// Only formats browsers actually decode. Anything else is served as
/// `application/octet-stream`, which the shell reads as "no preview" and
/// shows properties instead of a broken picture. HEIC and JPEG XL are
/// deliberately absent: outside Safari no browser decodes either, and a
/// blank frame is worse than an honest "no preview".
pub fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        // Images every current browser decodes.
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // Served under `sandbox`, so scripts inside one cannot run.
        "svg" => "image/svg+xml",

        // Video. H.264 in MP4 is the universal one; WebM covers the rest.
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",

        // Audio.
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",

        "pdf" => "application/pdf",

        // Text the shell renders itself, so the charset matters.
        "txt" | "md" | "log" | "csv" | "ini" | "conf" | "cfg" | "toml" | "yaml" | "yml" | "rs"
        | "ts" | "tsx" | "js" | "jsx" | "py" | "sh" | "bash" | "c" | "h" | "cpp" | "hpp" | "go"
        | "java" | "kt" | "rb" | "php" | "sql" | "css" | "html" | "xml" | "json" | "lock"
        | "gitignore" | "env" => "text/plain; charset=utf-8",

        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head_with(range: &str) -> Vec<u8> {
        format!("GET /preview HTTP/1.1\r\nHost: x\r\nRange: {range}\r\n\r\n").into_bytes()
    }

    #[test]
    fn parses_the_ranges_media_elements_send() {
        // The opening probe every <video> makes.
        assert_eq!(parse_range(&head_with("bytes=0-"), 1000), Some((0, 999)));
        assert_eq!(
            parse_range(&head_with("bytes=200-499"), 1000),
            Some((200, 499))
        );
        // A seek past the end of what exists is clamped, not trusted.
        assert_eq!(
            parse_range(&head_with("bytes=900-5000"), 1000),
            Some((900, 999))
        );
        // The tail form, used to read a trailing index (MP4 moov atoms).
        assert_eq!(
            parse_range(&head_with("bytes=-100"), 1000),
            Some((900, 999))
        );
    }

    #[test]
    fn refuses_what_it_cannot_answer_honestly() {
        // Multi-range: legal to answer with the whole file instead.
        assert_eq!(parse_range(&head_with("bytes=0-10,20-30"), 1000), None);
        // Starting past the end.
        assert_eq!(parse_range(&head_with("bytes=2000-"), 1000), None);
        // An empty file has no range to give.
        assert_eq!(parse_range(&head_with("bytes=0-"), 0), None);
        // No Range header at all.
        assert_eq!(parse_range(b"GET / HTTP/1.1\r\n\r\n", 1000), None);
    }

    #[test]
    fn only_formats_a_browser_can_show_get_a_type() {
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.MP4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.rs")), "text/plain; charset=utf-8");
        // No browser outside Safari decodes these, so no preview is offered.
        assert_eq!(mime_for(Path::new("a.heic")), "application/octet-stream");
        assert_eq!(mime_for(Path::new("a.jxl")), "application/octet-stream");
        assert_eq!(mime_for(Path::new("a.xcf")), "application/octet-stream");
    }
}
