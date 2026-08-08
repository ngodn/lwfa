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

/// The `.env` file in use, if there is one.
///
/// Public so the engine can watch it for changes; see `Lwfa::watch_dotenv`.
pub fn dotenv_file() -> Option<std::path::PathBuf> {
    dotenv_path()
}

/// Where to look for `.env`.
///
/// The working directory first, so `cargo run` from the repo root finds it,
/// then the repo root relative to the binary for an installed layout.
fn dotenv_path() -> Option<std::path::PathBuf> {
    let candidates = [
        // A checkout you are standing in. First, so `cd repo && lwfa-engine`
        // uses that tree's settings whatever else is installed.
        Some(std::path::PathBuf::from(".env")),
        // Where an installed copy keeps it, and where the installer writes it.
        //
        // Without this an installed engine has nowhere to read the secret
        // from: the working directory of a systemd unit is `/`, and the
        // candidate below is a path on whatever machine built the binary.
        user_env_path(),
        // The checkout this binary was built from. Convenient during
        // development, when the engine is often run from `target/debug`
        // rather than the repository root, and meaningless anywhere else.
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .map(|root| root.join(".env")),
    ];
    candidates.into_iter().flatten().find(|p| p.is_file())
}

/// `$XDG_CONFIG_HOME/lwfa/env`, or the `~/.config` fallback.
///
/// Beside `config.toml` rather than inside it, because this file holds the
/// shared password and wants mode 600 while the config is ordinarily
/// readable. Not named `.env`: in a config directory there is nothing to hide
/// it from, and a dotfile there is just harder to find.
///
/// Returns the path whether or not it exists, so an installer and the engine
/// agree on where the file goes.
pub fn user_env_path() -> Option<std::path::PathBuf> {
    user_env_path_for(
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )
}

/// The decision behind [`user_env_path`], with the environment passed in, so
/// it is testable without mutating it. See `config::user_config_path_for`.
fn user_env_path_for(
    xdg: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    if let Some(dir) = xdg
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Some(dir.join("lwfa/env"));
    }
    home.filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|home| home.join(".config/lwfa/env"))
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
///
/// Crate-visible because upload tickets are minted from the same cloth as
/// the bootstrap password; see `files.rs`.
pub(crate) fn generate_token() -> std::io::Result<String> {
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

/// Pull the token out of a request URI's query string, percent-decoded.
///
/// A query parameter rather than a header because browsers cannot set headers
/// on a `WebSocket` handshake. The cost is that the token can end up in logs and
/// browser history, which is another reason it is not a long-term answer.
///
/// # Decoding is not optional
///
/// The browser percent-encodes anything outside the unreserved set, so a
/// password of `!!hunter2!!` arrives as `%21%21hunter2%21%21`. Comparing the
/// raw query value rejects every password that is not purely alphanumeric,
/// which is easy to miss when the only password ever tested is hex.
pub fn token_from_query(uri: &str) -> Option<String> {
    param_from_query(uri, TOKEN_PARAM)
}

/// One query parameter, percent-decoded.
pub fn param_from_query(uri: &str, name: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

/// Decode `%XX` escapes and `+` as space.
///
/// `+` because `URLSearchParams` serialises a space that way, which is
/// application/x-www-form-urlencoded rather than strict RFC 3986. A password
/// containing a space would otherwise fail for the same reason `!` did.
///
/// Invalid escapes are passed through untouched rather than dropped: mangling
/// a password into something that silently never matches is worse than
/// comparing it verbatim and failing honestly.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }

    // Lossy so a mangled escape cannot make this return None and turn a wrong
    // password into an indistinguishable "no password".
    String::from_utf8_lossy(&out).into_owned()
}

/// True when this address is reachable from outside the machine.
pub fn is_exposed(addr: &std::net::SocketAddr) -> bool {
    !addr.ip().is_loopback()
}

/// Interface name prefixes that are never the address another device uses.
///
/// The route-to-the-internet trick gets this wrong on any machine with a VPN:
/// it returns the tunnel address, which a phone on the same wifi cannot reach.
/// This box has twelve addresses across Docker bridges, VMware, a VPN and
/// Tailscale, and exactly one of them is the LAN.
const VIRTUAL_PREFIXES: &[&str] = &[
    "lo",
    "docker",
    "br-",
    "veth",
    "virbr",
    "vmnet",
    "tun",
    "tap",
    "tailscale",
    "wg",
    "zt",
];

/// Addresses another device on the network could plausibly reach, best first.
///
/// Parses `ip -4 -o addr show scope global`, which is part of iproute2 and
/// present on any Linux that can run a Wayland compositor. Shelling out beats
/// `getifaddrs` here because that needs unsafe FFI for a convenience feature.
pub fn lan_addresses() -> Vec<(String, std::net::IpAddr)> {
    let Ok(output) = std::process::Command::new("ip")
        .args(["-4", "-o", "addr", "show", "scope", "global"])
        .output()
    else {
        return fallback_address().into_iter().collect();
    };

    let mut found: Vec<(String, std::net::IpAddr)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.nth(1)?.to_string();
            let addr = fields.nth(1)?.split('/').next()?;
            let ip: std::net::IpAddr = addr.parse().ok()?;
            (!VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p))).then_some((name, ip))
        })
        .collect();

    // Private ranges first: a public address on a home machine is unusual and
    // almost certainly not what the tablet should be pointed at.
    found.sort_by_key(|(_, ip)| !is_private(ip));

    if found.is_empty() {
        return fallback_address().into_iter().collect();
    }
    found
}

/// The single best guess, for the URL printed at startup.
pub fn lan_address() -> Option<std::net::IpAddr> {
    lan_addresses().first().map(|(_, ip)| *ip)
}

fn is_private(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private(),
        std::net::IpAddr::V6(_) => false,
    }
}

/// Last resort when `ip` is unavailable: ask the routing table.
///
/// Known to return a tunnel address on a machine with a VPN, which is why it is
/// the fallback rather than the primary.
fn fallback_address() -> Option<(String, std::net::IpAddr)> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?; // TEST-NET-1, guaranteed unroutable
    Some(("route".to_string(), socket.local_addr().ok()?.ip()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_secret_file_follows_xdg_when_it_is_set() {
        assert_eq!(
            user_env_path_for(Some("/xdg".into()), Some("/home/someone".into())).unwrap(),
            std::path::PathBuf::from("/xdg/lwfa/env")
        );
    }

    #[test]
    fn the_secret_file_falls_back_to_dot_config() {
        assert_eq!(
            user_env_path_for(None, Some("/home/someone".into())).unwrap(),
            std::path::PathBuf::from("/home/someone/.config/lwfa/env")
        );
    }

    #[test]
    fn a_relative_or_missing_environment_yields_no_secret_path() {
        // Rather than a path built from an empty string, which would land at
        // the filesystem root and be read by anything running as this user.
        assert!(user_env_path_for(Some("relative".into()), None).is_none());
        assert!(user_env_path_for(None, Some("".into())).is_none());
        assert!(user_env_path_for(None, None).is_none());
    }

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
        assert_eq!(token_from_query("/?token=abc").as_deref(), Some("abc"));
        assert_eq!(
            token_from_query("/ws?a=1&token=abc&b=2").as_deref(),
            Some("abc")
        );
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
    fn decodes_percent_escapes() {
        // The bug that made every non-alphanumeric password fail. A browser
        // sends "!!secret!!" as "%21%21secret%21%21", and comparing the raw
        // query value rejected it. Only hex passwords had ever been tested,
        // and hex needs no encoding, so nothing caught it.
        assert_eq!(
            token_from_query("/?token=%21%21secret%21%21").as_deref(),
            Some("!!secret!!"),
        );
    }

    #[test]
    fn decodes_the_characters_a_password_actually_contains() {
        let cases = [
            ("%21", "!"),
            ("%40", "@"),
            ("%23", "#"),
            ("%24", "$"),
            ("%25", "%"),
            ("%5E", "^"),
            ("%26", "&"),
            ("%2A", "*"),
            ("%3F", "?"),
            ("%2F", "/"),
            ("%3D", "="),
            ("%2B", "+"),
            ("+", " "),
            ("%20", " "),
        ];
        for (encoded, decoded) in cases {
            assert_eq!(
                token_from_query(&format!("/?token={encoded}")).as_deref(),
                Some(decoded),
                "{encoded} should decode to {decoded}",
            );
        }
    }

    #[test]
    fn handles_lowercase_hex_escapes() {
        // Not every client uppercases them.
        assert_eq!(token_from_query("/?token=%2a%2f").as_deref(), Some("*/"));
    }

    #[test]
    fn passes_through_a_malformed_escape_rather_than_dropping_it() {
        // A password ending in a bare % must fail honestly, not silently
        // become a different string or vanish.
        assert_eq!(token_from_query("/?token=abc%").as_deref(), Some("abc%"));
        assert_eq!(token_from_query("/?token=a%zzb").as_deref(), Some("a%zzb"));
    }

    #[test]
    fn a_decoded_password_still_has_to_match_exactly() {
        // Decoding must not become a way to smuggle a near-miss through.
        assert!(token_matches(
            "!!a!!",
            &token_from_query("/?token=%21%21a%21%21").unwrap()
        ));
        assert!(!token_matches(
            "!!a!!",
            &token_from_query("/?token=%21%21b%21%21").unwrap()
        ));
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
    fn virtual_interfaces_are_excluded() {
        // The list this filters is not hypothetical: this machine has Docker
        // bridges, VMware, a VPN tunnel and Tailscale, and a phone on the wifi
        // can reach none of them.
        for name in [
            "docker0",
            "br-4496345c5827",
            "veth13de519",
            "vmnet1",
            "tun0",
            "tailscale0",
            "lo",
        ] {
            assert!(
                VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p)),
                "{name} should be treated as virtual"
            );
        }
        for name in ["eno1", "wlan0", "enp3s0", "eth0"] {
            assert!(
                !VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p)),
                "{name} should be treated as real"
            );
        }
    }

    #[test]
    fn private_addresses_sort_first() {
        assert!(is_private(&"192.168.1.51".parse().unwrap()));
        assert!(is_private(&"10.0.0.5".parse().unwrap()));
        assert!(is_private(&"172.17.0.1".parse().unwrap()));
        // CGNAT, which is what a VPN tunnel often uses, is not RFC1918.
        assert!(!is_private(&"100.64.100.6".parse().unwrap()));
    }

    #[test]
    fn loopback_is_not_exposed() {
        assert!(!is_exposed(&"127.0.0.1:9843".parse().unwrap()));
        assert!(!is_exposed(&"[::1]:9843".parse().unwrap()));
        assert!(is_exposed(&"0.0.0.0:9843".parse().unwrap()));
        assert!(is_exposed(&"192.168.1.10:9843".parse().unwrap()));
    }
}
