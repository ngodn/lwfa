//! Shared-secret authentication for the shell socket.
//!
//! # Why this exists at all
//!
//! The shell protocol can inject keystrokes and spawn processes. Anything that
//! can open the socket therefore has full control of the session, so once the
//! socket leaves loopback a bare port is remote code execution for every device
//! on the network. A shared token is the smallest thing that stops that.
//!
//! # What it does not do
//!
//! There is no TLS. The token crosses the network in the clear as a query
//! parameter, so anyone who can passively watch the traffic can replay it, and
//! frames and keystrokes are readable on the wire. On a home LAN that is a
//! reasonable trade for not needing certificates; on any untrusted network it
//! is not. Tunnelling over SSH or WireGuard is the answer until TLS lands.
//!
//! The token is also not per-client and cannot be revoked without restarting.

use std::io::Read;

/// 128 bits, hex encoded. Long enough that guessing is not a concern even
/// without rate limiting, which there also is not.
const TOKEN_BYTES: usize = 16;

/// The name of the query parameter carrying the token.
pub const TOKEN_PARAM: &str = "token";

/// The variable holding the shared secret, in `.env` or the environment.
pub const PASS_VAR: &str = "AUTH_PASS";

/// Resolve the shared secret.
///
/// In order: the `AUTH_PASS` environment variable, then `AUTH_PASS` in a `.env`
/// file beside the repo, then a freshly generated one.
///
/// A file is the normal path because the secret has to stay *stable* for a
/// bookmarked URL on a tablet to keep working, and a generated-per-run secret
/// breaks that bookmark on every restart.
pub fn resolve_token() -> std::io::Result<String> {
    if let Some(value) = std::env::var(PASS_VAR).ok().filter(|v| !v.is_empty()) {
        tracing::debug!("using {PASS_VAR} from the environment");
        return Ok(value);
    }

    match dotenv_value(PASS_VAR)? {
        Some(value) if !value.is_empty() => {
            tracing::debug!("using {PASS_VAR} from .env");
            Ok(value)
        }
        Some(_) => Err(std::io::Error::other(format!(
            "{PASS_VAR} in .env is empty. Give it a value, or remove the line to \
             have one generated."
        ))),
        None => {
            tracing::warn!(
                "no {PASS_VAR} set, so a temporary one was generated. Any bookmarked \
                 shell URL will stop working on restart. Put {PASS_VAR} in .env to pin it."
            );
            generate_token()
        }
    }
}

/// Look a setting up in the environment, then in `.env`.
///
/// The environment wins, so a one-off `LWFA_SHELL_ADDR=... cargo run` overrides
/// the file without editing it.
pub fn setting(key: &str) -> Option<String> {
    if let Some(value) = std::env::var(key).ok().filter(|v| !v.is_empty()) {
        return Some(value);
    }
    dotenv_value(key).ok().flatten().filter(|v| !v.is_empty())
}

/// Read one key out of a `.env` file, if there is one.
///
/// Deliberately minimal: `KEY=value`, `#` comments, optional surrounding
/// quotes. No interpolation, no `export`, no multi-line values. A secret file
/// wants boring and predictable parsing far more than it wants features, and a
/// surprising expansion rule here would be a security bug rather than an
/// inconvenience.
fn dotenv_value(key: &str) -> std::io::Result<Option<String>> {
    let Some(path) = dotenv_path() else {
        return Ok(None);
    };

    warn_if_world_readable(&path);

    let contents = std::fs::read_to_string(&path)?;
    Ok(parse_dotenv(&contents, key))
}

/// The parsing half, separated so it can be tested without touching the disk.
fn parse_dotenv(contents: &str, key: &str) -> Option<String> {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        // `export FOO=bar` is common enough in hand-written files to be worth
        // tolerating, even though nothing here writes it.
        let name = name
            .trim()
            .strip_prefix("export ")
            .unwrap_or(name.trim())
            .trim();
        if name != key {
            continue;
        }
        let value = value.trim();
        let unquoted = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        return Some(unquoted.to_string());
    }
    None
}

/// Where to look for `.env`.
///
/// The working directory first, so `cargo run` from the repo root finds it,
/// then the repo root relative to the binary for an installed layout.
fn dotenv_path() -> Option<std::path::PathBuf> {
    let candidates = [
        std::path::PathBuf::from(".env"),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .map(|root| root.join(".env"))
            .unwrap_or_default(),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// A secret readable by every user on the machine is not much of a secret.
fn warn_if_world_readable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    let mode = metadata.permissions().mode();
    if mode & 0o077 != 0 {
        tracing::warn!(
            "{} is readable by other users (mode {:o}). Run: chmod 600 {}",
            path.display(),
            mode & 0o777,
            path.display(),
        );
    }
}

/// A random token from the kernel.
///
/// `/dev/urandom` rather than a crate: this is Linux-only software that already
/// depends on DRM and libinput, and it avoids a dependency whose only job is
/// reading a file.
fn generate_token() -> std::io::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Compare in constant time.
///
/// The practical risk of a timing attack against a 128-bit token over a LAN is
/// negligible, but comparing properly costs nothing and means the question does
/// not have to be revisited if this ever faces the internet.
pub fn token_matches(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    if expected.len() != presented.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(presented) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Pull the token out of a request URI's query string.
///
/// A query parameter rather than a header because browsers cannot set headers
/// on a `WebSocket` handshake. The cost is that the token can end up in logs and
/// browser history, which is another reason it is not a long-term answer.
pub fn token_from_query(uri: &str) -> Option<&str> {
    let query = uri.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == TOKEN_PARAM).then_some(value)
    })
}

/// True when this address is reachable from outside the machine.
pub fn is_exposed(addr: &std::net::SocketAddr) -> bool {
    !addr.ip().is_loopback()
}

/// Best-effort LAN address, so the engine can print a URL worth copying.
///
/// Found by asking the routing table which source address would be used to
/// reach a public address. No packet is sent: connecting a UDP socket only
/// selects a route.
pub fn lan_address() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?; // TEST-NET-1, guaranteed unroutable
    Some(socket.local_addr().ok()?.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_long_and_different() {
        let a = generate_token().expect("urandom should be readable");
        let b = generate_token().expect("urandom should be readable");
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert_ne!(a, b, "two tokens should not collide");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn matching_is_exact() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", ""));
        assert!(!token_matches("", "x"));
    }

    #[test]
    fn a_prefix_is_not_a_match() {
        // Length is checked first, so a correct prefix must still fail.
        assert!(!token_matches("longtoken", "long"));
        assert!(!token_matches("long", "longtoken"));
    }

    #[test]
    fn extracts_the_token_from_a_query() {
        assert_eq!(token_from_query("/?token=abc"), Some("abc"));
        assert_eq!(token_from_query("/ws?a=1&token=abc&b=2"), Some("abc"));
        assert_eq!(token_from_query("/?other=abc"), None);
        assert_eq!(token_from_query("/"), None);
        assert_eq!(token_from_query(""), None);
    }

    #[test]
    fn does_not_confuse_a_similarly_named_parameter() {
        // "tokenish=x" must not be read as the token.
        assert_eq!(token_from_query("/?tokenish=x"), None);
        assert_eq!(token_from_query("/?mytoken=x"), None);
    }

    #[test]
    fn reads_a_plain_assignment() {
        assert_eq!(
            parse_dotenv("AUTH_PASS=hunter2", "AUTH_PASS").as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let file = "# a comment\n\n  # indented comment\nAUTH_PASS=abc\n";
        assert_eq!(parse_dotenv(file, "AUTH_PASS").as_deref(), Some("abc"));
    }

    #[test]
    fn strips_surrounding_quotes() {
        assert_eq!(
            parse_dotenv("AUTH_PASS=\"abc\"", "AUTH_PASS").as_deref(),
            Some("abc")
        );
        assert_eq!(
            parse_dotenv("AUTH_PASS='abc'", "AUTH_PASS").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn keeps_characters_that_look_like_syntax() {
        // A generated password can contain anything. Mangling one silently
        // would lock the user out with no clue why.
        assert_eq!(
            parse_dotenv("AUTH_PASS=a=b#c$d", "AUTH_PASS").as_deref(),
            Some("a=b#c$d"),
            "only the first = splits, and # mid-value is not a comment"
        );
    }

    #[test]
    fn tolerates_export_and_surrounding_whitespace() {
        assert_eq!(
            parse_dotenv("export AUTH_PASS = abc ", "AUTH_PASS").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn does_not_match_a_similarly_named_key() {
        let file = "MY_AUTH_PASS=wrong\nAUTH_PASS_EXTRA=wrong\nAUTH_PASS=right\n";
        assert_eq!(parse_dotenv(file, "AUTH_PASS").as_deref(), Some("right"));
    }

    #[test]
    fn returns_none_when_absent() {
        assert_eq!(parse_dotenv("OTHER=1", "AUTH_PASS"), None);
        assert_eq!(parse_dotenv("", "AUTH_PASS"), None);
    }

    #[test]
    fn distinguishes_empty_from_absent() {
        // Empty must be an error upstream, not a silently generated token:
        // a typo in the file should not quietly change the password.
        assert_eq!(parse_dotenv("AUTH_PASS=", "AUTH_PASS").as_deref(), Some(""));
    }

    #[test]
    fn loopback_is_not_exposed() {
        assert!(!is_exposed(&"127.0.0.1:9843".parse().unwrap()));
        assert!(!is_exposed(&"[::1]:9843".parse().unwrap()));
        assert!(is_exposed(&"0.0.0.0:9843".parse().unwrap()));
        assert!(is_exposed(&"192.168.1.10:9843".parse().unwrap()));
    }
}
