//! Direction 2 of the protocol parity check: TypeScript to Rust.
//!
//! `packages/proto/test/parity.test.ts` decodes each canonical fixture and
//! re-encodes it into `fixtures/proto-from-ts/`. This test deserialises those
//! with the Rust types and asserts they are identical to what Rust would have
//! produced.
//!
//! Direction 1 alone (Rust fixtures decoding in TS) would pass if the
//! TypeScript decoder were permissive. This direction catches the opposite
//! failure: TypeScript emitting a shape Rust tolerates but never generates.
//!
//! Ordering: run the TypeScript test first. `pnpm run test:all` does this.
//! Running `cargo test` alone will fail here with instructions, which is
//! deliberate. A silent skip would make a broken parity check look like a
//! passing one.

use std::fs;
use std::path::{Path, PathBuf};

use lwfa_proto::*;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crate should live two levels below the repo root")
        .to_path_buf()
}

fn read(direction: &str, name: &str) -> String {
    let path = repo_root()
        .join("fixtures/proto-from-ts")
        .join(direction)
        .join(format!("{name}.json"));

    fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "could not read {}: {err}\n\n\
             This fixture is written by the TypeScript parity test. Run:\n  \
             pnpm run test:all\n\
             (or `pnpm test` once, then `cargo test`)",
            path.display()
        )
    })
}

/// Must stay in step with `samples()` in `src/bin/gen-proto-fixtures.rs`.
/// The count assertion at the bottom catches it if it does not.
fn expected_to_shell() -> Vec<(&'static str, ToShell)> {
    let output = Output {
        width: 1920,
        height: 1080,
        scale: 1.0,
    };
    vec![
        (
            "hello",
            ToShell::Hello {
                protocol_version: PROTOCOL_VERSION,
                output,
                windows: vec![
                    WindowInfo {
                        id: WindowId(1),
                        app_id: Some("Alacritty".into()),
                        title: Some("~/development/lwfa".into()),
                    },
                    WindowInfo {
                        id: WindowId(2),
                        app_id: None,
                        title: None,
                    },
                ],
                focused: Some(WindowId(1)),
            },
        ),
        (
            "hello-empty",
            ToShell::Hello {
                protocol_version: PROTOCOL_VERSION,
                output,
                windows: vec![],
                focused: None,
            },
        ),
        ("output-changed", ToShell::OutputChanged { output }),
        (
            "window-opened",
            ToShell::WindowOpened {
                window: WindowInfo {
                    id: WindowId(7),
                    app_id: Some("firefox".into()),
                    title: None,
                },
            },
        ),
        (
            "window-changed",
            ToShell::WindowChanged {
                window: WindowInfo {
                    id: WindowId(7),
                    app_id: Some("firefox".into()),
                    title: Some("lwfa \u{2014} not an em dash test, just unicode".into()),
                },
            },
        ),
        ("window-closed", ToShell::WindowClosed { id: WindowId(7) }),
        (
            "focus-changed",
            ToShell::FocusChanged {
                id: Some(WindowId(2)),
            },
        ),
        ("focus-cleared", ToShell::FocusChanged { id: None }),
        (
            "key-binding",
            ToShell::KeyBinding {
                key: "l".into(),
                modifiers: Modifiers {
                    alt: true,
                    ctrl: false,
                    shift: false,
                    logo: false,
                },
            },
        ),
    ]
}

fn expected_to_engine() -> Vec<(&'static str, ToEngine)> {
    vec![
        (
            "set-layout-animated",
            ToEngine::SetLayout {
                windows: vec![
                    WindowLayout {
                        id: WindowId(1),
                        rect: Rect {
                            x: -23.5,
                            y: 12.0,
                            width: 630.0,
                            height: 1056.0,
                        },
                        z: 0,
                    },
                    WindowLayout {
                        id: WindowId(2),
                        rect: Rect {
                            x: 619.0,
                            y: 12.0,
                            width: 630.0,
                            height: 1056.0,
                        },
                        z: 1,
                    },
                ],
                animate: Some(Animation {
                    spring: SpringSpec {
                        stiffness: 220.0,
                        damping: 26.0,
                        mass: 1.0,
                    },
                }),
            },
        ),
        (
            "set-layout-immediate",
            ToEngine::SetLayout {
                windows: vec![WindowLayout {
                    id: WindowId(1),
                    rect: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 1920.0,
                        height: 1080.0,
                    },
                    z: 0,
                }],
                animate: None,
            },
        ),
        (
            "set-layout-empty",
            ToEngine::SetLayout {
                windows: vec![],
                animate: None,
            },
        ),
        ("focus-window", ToEngine::FocusWindow { id: WindowId(2) }),
        ("close-window", ToEngine::CloseWindow { id: WindowId(2) }),
        (
            "spawn",
            ToEngine::Spawn {
                command: "alacritty".into(),
            },
        ),
        (
            "set-streams",
            ToEngine::SetStreams {
                windows: vec![WindowId(1), WindowId(2)],
                h264: true,
            },
        ),
        (
            "set-streams-none",
            ToEngine::SetStreams {
                windows: vec![],
                h264: true,
            },
        ),
        (
            "set-streams-jpeg-only",
            ToEngine::SetStreams {
                windows: vec![WindowId(1)],
                h264: false,
            },
        ),
    ]
}

#[test]
fn typescript_output_deserialises_identically() {
    for (name, expected) in expected_to_shell() {
        let json = read("to-shell", name);
        let actual: ToShell = serde_json::from_str(&json)
            .unwrap_or_else(|err| panic!("to-shell/{name}: {err}\n  json was: {json}"));
        assert_eq!(actual, expected, "to-shell/{name} differs");
    }

    for (name, expected) in expected_to_engine() {
        let json = read("to-engine", name);
        let actual: ToEngine = serde_json::from_str(&json)
            .unwrap_or_else(|err| panic!("to-engine/{name}: {err}\n  json was: {json}"));
        assert_eq!(actual, expected, "to-engine/{name} differs");
    }
}

#[test]
fn every_generated_fixture_is_covered() {
    // Guards against a message being added to the generator but not to this
    // test, which would silently shrink parity coverage to a subset.
    for (direction, expected) in [
        ("to-shell", expected_to_shell().len()),
        ("to-engine", expected_to_engine().len()),
    ] {
        let dir = repo_root().join("fixtures/proto").join(direction);
        let found = fs::read_dir(&dir)
            .unwrap_or_else(|err| panic!("could not list {}: {err}", dir.display()))
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .count();
        assert_eq!(
            found, expected,
            "{direction}: {found} generated fixtures but {expected} covered here. \
             Add the new message to from_ts.rs."
        );
    }
}
