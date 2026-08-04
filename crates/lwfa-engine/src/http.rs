//! Serving the built shell, on the same port as the protocol.
//!
//! # Why the engine serves the page at all
//!
//! The shell is a static bundle: HTML, JavaScript, CSS, fonts and icons. In
//! development Vite serves it, which is right, because Vite is also doing the
//! hot reload. In production it was `pnpm run start`, and that quietly made
//! Node a runtime dependency of a compositor written in Rust.
//!
//! That cost is not the disk space. It is that shipping lwfa then means
//! shipping a JavaScript runtime, a second service to supervise, a second
//! systemd unit that can fail on its own, and a second thing an installer has
//! to ask about and a user has to keep running. The engine already runs an
//! HTTP server, because a WebSocket handshake *is* an HTTP request. Serving a
//! directory next to it is a few hundred lines and removes all of that.
//!
//! # Why one port
//!
//! Because two ports bought nothing once both were served by the same process.
//! They cost a reverse-proxy configuration with a path split and a priority
//! rule, a second firewall hole, and an installer question. On one port a
//! proxy is an ordinary one-backend reverse proxy and the shell reaches its
//! socket at its own origin, so there is nothing cross-origin to configure and
//! one certificate covers everything.
//!
//! The split is by request, not by port: a WebSocket upgrade is the protocol,
//! anything else is a file.
//!
//! # Why `peek` rather than parsing first
//!
//! `tungstenite::accept_hdr` reads and parses the request itself, so it needs
//! a stream nothing has consumed. Reading the head here to decide would leave
//! the stream mid-request and there would be no way to hand it over.
//!
//! `MSG_PEEK` reads without consuming, so the bytes are still there for
//! tungstenite afterwards. The alternative was a wrapper stream replaying a
//! buffer, which changes the socket type threaded through every connection in
//! `shell.rs` for no gain.
//!
//! # What this is not
//!
//! Not a general web server. It answers `GET` and `HEAD` for files under one
//! directory, closes the connection after each response, and does nothing
//! else: no keep-alive, no ranges, no compression, no directory listings. Page
//! loads on a LAN are a few dozen small requests and this is comfortably fast
//! enough for them. Anything facing the internet has a real proxy in front of
//! it already, for the TLS that WebCodecs requires.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a client may take to send its request head before being dropped.
///
/// The same reasoning as the WebSocket handshake timeout: a peer that connects
/// and then says nothing must not be able to hold a thread.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Cap on the request head. Anything larger is a client doing something
/// strange, and a bound means a peer cannot make the engine allocate.
const MAX_HEAD: usize = 16 * 1024;

/// Files the browser must never keep, because they name the others.
///
/// Vite fingerprints everything under `assets/`, so those are safe to cache
/// forever. `index.html` is what points at the current fingerprints, so a
/// cached copy after an upgrade loads bundles that are no longer there.
const NEVER_CACHE: &[&str] = &[
    "index.html",
    "manifest.webmanifest",
    "manifest.json",
    "sw.js",
];

/// A year. What Vite's fingerprinted assets are safe to be given.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Does this connection want to be a WebSocket?
///
/// Peeks at the request head without consuming it, so the caller can hand the
/// untouched stream to the WebSocket handshake. See the module comment.
///
/// A request that never arrives, is not valid HTTP, or is too large to be a
/// request head answers `false`: it will be handled as an ordinary request and
/// refused there, which is the same outcome without a second error path.
pub fn wants_websocket(stream: &TcpStream) -> bool {
    let mut buf = vec![0u8; 4096];
    let deadline = Instant::now() + REQUEST_TIMEOUT;

    loop {
        let peeked = match stream.peek(&mut buf) {
            Ok(0) => return false,
            Ok(n) => n,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            Err(_) => return false,
        };

        let head = &buf[..peeked];
        // The whole head has arrived once the blank line separating it from the
        // body is visible. Until then a header could still be split across TCP
        // segments, and deciding early would miss an `Upgrade` that has not
        // landed yet.
        if find(head, b"\r\n\r\n").is_some() || peeked == buf.len() {
            return has_upgrade(head);
        }
        if Instant::now() >= deadline {
            return has_upgrade(head);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Is this request head a WebSocket upgrade?
///
/// Both the `Upgrade: websocket` token and a `Connection` header containing
/// `upgrade` are required, which is what RFC 6455 specifies. Matching is
/// case-insensitive because header names and these particular values are, and
/// browsers do not agree on the casing they send.
fn has_upgrade(head: &[u8]) -> bool {
    let lower = head.to_ascii_lowercase();
    header_contains(&lower, b"upgrade:", b"websocket")
        && header_contains(&lower, b"connection:", b"upgrade")
}

/// Does the named header's value contain this token?
///
/// Deliberately scans every occurrence: `Connection` may legitimately appear
/// more than once, and a proxy may add its own.
fn header_contains(lower: &[u8], name: &[u8], token: &[u8]) -> bool {
    let mut rest = lower;
    while let Some(at) = find(rest, name) {
        // Only at the start of a line, so a `Sec-WebSocket-Extensions` value
        // mentioning "upgrade:" cannot be mistaken for the header itself.
        let at_line_start = at == 0 || rest[at - 1] == b'\n';
        let after = &rest[at + name.len()..];
        let line_end = find(after, b"\r\n").unwrap_or(after.len());
        if at_line_start && find(&after[..line_end], token).is_some() {
            return true;
        }
        rest = &rest[at + name.len()..];
    }
    false
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Serve one request from `root`, then close.
///
/// Errors are deliberately swallowed: this runs on a throwaway thread for one
/// connection, and a client that hangs up mid-response is ordinary rather than
/// notable. Anything worth knowing about is logged by the caller.
pub fn serve(mut stream: TcpStream, root: &Path) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));

    let Some(head) = read_head(&mut stream) else {
        return;
    };
    let Some((method, target)) = request_line(&head) else {
        let _ = respond(&mut stream, 400, "text/plain", b"bad request", None, true);
        return;
    };

    if method != "GET" && method != "HEAD" {
        let _ = respond(
            &mut stream,
            405,
            "text/plain",
            b"method not allowed",
            None,
            true,
        );
        return;
    }

    let body_wanted = method == "GET";
    match resolve(root, target) {
        Some(path) => {
            let cache = cache_control(&path, root);
            match std::fs::read(&path) {
                Ok(bytes) => {
                    let _ = respond(
                        &mut stream,
                        200,
                        mime_for(&path),
                        &bytes,
                        Some(cache),
                        body_wanted,
                    );
                }
                Err(err) => {
                    tracing::debug!("could not read {}: {err}", path.display());
                    let _ = respond(&mut stream, 404, "text/plain", b"not found", None, body_wanted);
                }
            }
        }
        None => {
            let _ = respond(&mut stream, 404, "text/plain", b"not found", None, body_wanted);
        }
    }
}

/// Answer an HTTP request when there is no built shell to serve.
///
/// A closed connection would show up in a browser as "cannot connect", which
/// sends people looking at firewalls and addresses. Saying what is actually
/// wrong costs one response and points at the fix, which is usually either
/// running the dev server or building the shell.
pub fn refuse(mut stream: TcpStream) {
    let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));
    let body = b"lwfa: the engine is running, but no built shell was found to serve.\n\n\
                 Build it with `pnpm run build`, or run `pnpm --filter @lwfa/shell dev` \
                 and open the dev server instead.\n";
    let _ = respond(&mut stream, 503, "text/plain; charset=utf-8", body, None, true);
}

/// Read until the blank line that ends the request head.
fn read_head(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    // Byte at a time so nothing past the head is consumed. The head is small
    // and this runs once per connection, so the syscalls do not matter, and it
    // means never having to hand back an over-read remainder.
    while head.len() < MAX_HEAD {
        match stream.read(&mut byte) {
            Ok(0) => return None,
            Ok(_) => {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    return Some(head);
                }
            }
            Err(_) => return None,
        }
    }
    None
}

/// The method and target from the request line.
fn request_line(head: &[u8]) -> Option<(String, &str)> {
    let line_end = find(head, b"\r\n")?;
    let line = std::str::from_utf8(&head[..line_end]).ok()?;
    let mut parts = line.split(' ');
    let method = parts.next()?.to_ascii_uppercase();
    let target = parts.next()?;
    Some((method, target))
}

/// Turn a request target into a file under `root`, or nothing.
///
/// # Why this is careful
///
/// The target is attacker-controlled and names a file. `..`, an absolute path,
/// a percent-encoded separator or a symlink pointing outward all reach files
/// the server was never meant to expose, and on this machine that is a user's
/// home directory. So the path is rebuilt from components rather than joined,
/// every traversal component is refused rather than resolved, and the final
/// path is canonicalised and checked to still be under the root.
///
/// # The single-page fallback
///
/// The shell is a single-page application: `/windows` is a route inside it,
/// not a file, and a browser asked to reload that URL requests it from the
/// server. A request with no file extension therefore falls back to
/// `index.html` and lets the shell's router sort it out. A request that *does*
/// look like a file gets an honest 404, so a missing bundle is not silently
/// answered with a page.
fn resolve(root: &Path, target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(path);

    let mut out = root.to_path_buf();
    let mut named_a_file = false;
    for part in decoded.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        // Not resolved, refused. Resolving would mean a target that escapes and
        // comes back is accepted, and there is no reason to accept one.
        if part == ".." {
            return None;
        }
        if part.contains('\0') {
            return None;
        }
        out.push(part);
        named_a_file = part.contains('.');
    }

    let index = root.join("index.html");
    if out == root {
        return canonical_under(root, &index);
    }
    if let Some(found) = canonical_under(root, &out)
        && found.is_file()
    {
        return Some(found);
    }
    // A missing bundle should 404 rather than quietly return a page, which
    // otherwise shows up as a blank screen and a console full of MIME errors.
    if named_a_file {
        return None;
    }
    canonical_under(root, &index)
}

/// Canonicalise, and refuse anything that leaves the root.
///
/// After `canonicalize` every symlink is resolved, so this also catches a link
/// inside the directory pointing somewhere outside it.
fn canonical_under(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    real.starts_with(&root).then_some(real)
}

/// Decode `%XX`, and nothing else.
///
/// `+` is deliberately left alone: it means a space in a query string, which
/// this never sees, and a literal `+` in a path component.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What a file may be cached as. See [`NEVER_CACHE`].
fn cache_control(path: &Path, root: &Path) -> &'static str {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if NEVER_CACHE.contains(&name) {
        return "no-cache";
    }
    if path.strip_prefix(root).is_ok_and(|rest| {
        rest.components()
            .next()
            .is_some_and(|c| c.as_os_str() == "assets")
    }) {
        return IMMUTABLE;
    }
    "no-cache"
}

/// The content type for a file, by extension.
///
/// A short table rather than a crate, because the shell's build output is a
/// known and small set of types. An unknown extension is served as bytes: a
/// browser will not execute it, which is the right default for a file the
/// server does not recognise.
fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    cache: Option<&str>,
    with_body: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        503 => "Service Unavailable",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: {}\r\n",
        body.len(),
        cache.unwrap_or("no-cache"),
    );
    // The shell decodes video in a worker and the page is same-origin with its
    // own socket, so nothing here needs to be embeddable anywhere else.
    head.push_str("X-Content-Type-Options: nosniff\r\n");
    head.push_str("Connection: close\r\n\r\n");

    stream.write_all(head.as_bytes())?;
    if with_body {
        stream.write_all(body)?;
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lwfa-http-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
        std::fs::write(dir.join("assets/app-a1b2c3.js"), "console.log(1)").unwrap();
        dir
    }

    #[test]
    fn an_upgrade_is_recognised_whatever_the_casing() {
        let head = b"GET /engine HTTP/1.1\r\nHost: x\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n\r\n";
        assert!(has_upgrade(&head.to_ascii_lowercase()));
    }

    #[test]
    fn an_ordinary_request_is_not_an_upgrade() {
        let head = b"GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n";
        assert!(!has_upgrade(&head.to_ascii_lowercase()));
    }

    #[test]
    fn upgrade_needs_both_headers() {
        // Firefox sends `Connection: keep-alive, Upgrade`, so the token is
        // matched inside the value rather than compared to it.
        let both = b"upgrade: websocket\r\nconnection: keep-alive, upgrade\r\n\r\n";
        assert!(has_upgrade(both));
        let only_one = b"upgrade: websocket\r\nconnection: keep-alive\r\n\r\n";
        assert!(!has_upgrade(only_one));
    }

    #[test]
    fn a_header_name_in_a_value_is_not_a_header() {
        let sneaky = b"sec-websocket-protocol: upgrade: websocket\r\nconnection: keep-alive\r\n\r\n";
        assert!(!has_upgrade(sneaky));
    }

    #[test]
    fn the_root_is_the_page() {
        let root = root();
        assert_eq!(
            resolve(&root, "/").unwrap().file_name().unwrap(),
            "index.html"
        );
    }

    #[test]
    fn a_route_falls_back_to_the_page() {
        let root = root();
        assert_eq!(
            resolve(&root, "/windows").unwrap().file_name().unwrap(),
            "index.html"
        );
    }

    #[test]
    fn a_missing_bundle_is_a_404_rather_than_the_page() {
        let root = root();
        assert!(resolve(&root, "/assets/gone-9f9f9f.js").is_none());
    }

    #[test]
    fn a_real_file_is_served() {
        let root = root();
        let found = resolve(&root, "/assets/app-a1b2c3.js").unwrap();
        assert_eq!(found.file_name().unwrap(), "app-a1b2c3.js");
    }

    #[test]
    fn a_query_string_is_not_part_of_the_path() {
        let root = root();
        let found = resolve(&root, "/assets/app-a1b2c3.js?v=2").unwrap();
        assert_eq!(found.file_name().unwrap(), "app-a1b2c3.js");
    }

    #[test]
    fn traversal_is_refused() {
        let root = root();
        assert!(resolve(&root, "/../../etc/passwd").is_none());
        assert!(resolve(&root, "/assets/../../etc/passwd").is_none());
        // Percent-encoded, which is the form that gets past a naive check.
        assert!(resolve(&root, "/%2e%2e/%2e%2e/etc/passwd").is_none());
        assert!(resolve(&root, "/..%2f..%2fetc%2fpasswd").is_none());
    }

    #[test]
    fn a_null_byte_is_refused() {
        let root = root();
        assert!(resolve(&root, "/assets/app%00.js").is_none());
    }

    #[test]
    fn fingerprinted_assets_are_cached_and_the_page_is_not() {
        let root = root();
        assert_eq!(
            cache_control(&root.join("assets/app-a1b2c3.js"), &root),
            IMMUTABLE
        );
        assert_eq!(cache_control(&root.join("index.html"), &root), "no-cache");
    }

    #[test]
    fn types_the_shell_actually_ships() {
        assert_eq!(mime_for(Path::new("a.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime_for(Path::new("a.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        // Unknown means bytes, never something a browser will run.
        assert_eq!(mime_for(Path::new("a.zzz")), "application/octet-stream");
    }

    #[test]
    fn percent_decoding_handles_the_shapes_that_appear_in_paths() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/a%2Fb"), "/a/b");
        // A stray percent is left alone rather than eating the next character.
        assert_eq!(percent_decode("/100%"), "/100%");
        assert_eq!(percent_decode("/a%zzb"), "/a%zzb");
    }
}
