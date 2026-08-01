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

/// Read the token from the environment, or generate one.
///
/// Setting `LWFA_SHELL_TOKEN` makes it stable across restarts, which is what
/// you want once a tablet has the URL bookmarked. Leaving it unset generates a
/// fresh one each run, which is safer but means re-copying the URL.
pub fn resolve_token() -> std::io::Result<String> {
    if let Ok(token) = std::env::var("LWFA_SHELL_TOKEN") {
        if token.is_empty() {
            // Explicitly empty is not "no token"; that would be a footgun where
            // a typo in a unit file silently disables authentication.
            return Err(std::io::Error::other(
                "LWFA_SHELL_TOKEN is set but empty. Unset it to generate one, \
                 or give it a value.",
            ));
        }
        return Ok(token);
    }
    generate_token()
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
    fn loopback_is_not_exposed() {
        assert!(!is_exposed(&"127.0.0.1:9843".parse().unwrap()));
        assert!(!is_exposed(&"[::1]:9843".parse().unwrap()));
        assert!(is_exposed(&"0.0.0.0:9843".parse().unwrap()));
        assert!(is_exposed(&"192.168.1.10:9843".parse().unwrap()));
    }
}
