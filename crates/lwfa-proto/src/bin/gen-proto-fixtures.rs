//! Emits one canonical JSON sample per protocol message.
//!
//! `packages/proto/test/parity.test.ts` parses each of these with the
//! TypeScript types and re-serialises it, then checks the result is byte-equal.
//! That catches the failure this whole setup exists to prevent: a field renamed
//! or retyped on one side only, which would otherwise show up as windows
//! silently going to the wrong place at runtime.
//!
//! Run from the repo root: `cargo run -p lwfa-proto --bin gen-proto-fixtures`

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lwfa_proto::*;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crate should live two levels below the repo root")
        .to_path_buf()
}

/// Every message shape, with values chosen to exercise the awkward cases:
/// absent optionals, present optionals, fractional coordinates, negative
/// coordinates (a column scrolled off the left), and empty collections.
fn samples() -> (Vec<(&'static str, ToShell)>, Vec<(&'static str, ToEngine)>) {
    let output = Output {
        width: 1920,
        height: 1080,
        scale: 1.0,
    };

    let to_shell = vec![
        (
            "hello",
            ToShell::Hello {
                permissions: lwfa_proto::Permissions::owner(),
                account: "owner".to_string(),
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
                // A restricted session, so the fixtures cover both permission
                // shapes: `allowed_apps: None` meaning everything, and an
                // explicit list meaning only those.
                permissions: lwfa_proto::Permissions {
                    mode: lwfa_proto::SessionMode::View,
                    allowed_apps: Some(vec!["org.example.Thing".to_string()]),
                },
                account: "guest".to_string(),
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
    ];

    let to_engine = vec![
        (
            "set-layout-animated",
            ToEngine::SetLayout {
                windows: vec![
                    WindowLayout {
                        id: WindowId(1),
                        // Negative x: a column scrolled partly off the left,
                        // which is the normal steady state for a strip.
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
                terminal: false,
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
    ];

    (to_shell, to_engine)
}

fn write_dir<T: serde::Serialize>(dir: &Path, samples: &[(&str, T)]) -> std::io::Result<usize> {
    fs::create_dir_all(dir)?;
    for (name, value) in samples {
        // Pretty-printed so a diff on failure is readable rather than one long
        // line. The parity test compares parsed values and re-serialised
        // compact form, so formatting here is purely for humans.
        let json = serde_json::to_string_pretty(value).expect("serialize sample");
        fs::write(dir.join(format!("{name}.json")), json + "\n")?;
    }
    Ok(samples.len())
}

fn main() -> ExitCode {
    let root = repo_root();
    let base = root.join("fixtures/proto");

    // Regenerate from scratch so a renamed sample cannot leave a stale file
    // behind that the TS side keeps happily parsing.
    if base.exists() {
        if let Err(err) = fs::remove_dir_all(&base) {
            eprintln!("failed to clear {}: {err}", base.display());
            return ExitCode::FAILURE;
        }
    }

    let (to_shell, to_engine) = samples();

    let shell_count = match write_dir(&base.join("to-shell"), &to_shell) {
        Ok(n) => n,
        Err(err) => {
            eprintln!("failed to write to-shell fixtures: {err}");
            return ExitCode::FAILURE;
        }
    };
    let engine_count = match write_dir(&base.join("to-engine"), &to_engine) {
        Ok(n) => n,
        Err(err) => {
            eprintln!("failed to write to-engine fixtures: {err}");
            return ExitCode::FAILURE;
        }
    };

    println!(
        "wrote {shell_count} toShell and {engine_count} toEngine fixtures to {}",
        base.display()
    );
    ExitCode::SUCCESS
}
