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
                session: 1,
                primary: true,
                peers: vec![lwfa_proto::PeerInfo {
                    id: 1,
                    account: "owner".to_string(),
                    mode: lwfa_proto::SessionMode::Interact,
                    primary: true,
                    device: "iPad".to_string(),
                }],
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
                session: 2,
                primary: false,
                peers: vec![],
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

    let to_shell = {
        let mut v = to_shell;
        v.push((
            "role",
            ToShell::Role { primary: false },
        ));
        v.push((
            "already-running",
            ToShell::AlreadyRunning {
                command: "code".to_string(),
                terminal: false,
                program: "code".to_string(),
                pid: 4321,
            },
        ));
        v.push((
            "peers",
            ToShell::Peers {
                peers: vec![
                    lwfa_proto::PeerInfo {
                        id: 1,
                        account: "owner".to_string(),
                        mode: lwfa_proto::SessionMode::Interact,
                        primary: true,
                        device: "Linux desktop".to_string(),
                    },
                    lwfa_proto::PeerInfo {
                        id: 2,
                        account: "guest".to_string(),
                        mode: lwfa_proto::SessionMode::View,
                        primary: false,
                        device: "iPad".to_string(),
                    },
                ],
            },
        ));
        v.push((
            "layout",
            ToShell::Layout {
                output,
                windows: vec![WindowLayout {
                    id: WindowId(1),
                    rect: Rect {
                        x: 12.0,
                        y: 12.0,
                        width: 640.0,
                        height: 1056.0,
                    },
                    z: 0,
                }],
            },
        ));
        v.push(("pong", ToShell::Pong));
        v.push((
            "file-chooser",
            ToShell::FileChooser {
                request: 7,
                mode: FileChooserMode::Open,
                multiple: true,
                directory: false,
                title: "Open Image".to_string(),
                app_id: "org.gimp.GIMP".to_string(),
                accept_label: Some("_Open".to_string()),
                suggested_name: None,
                filters: vec![FileFilter {
                    name: "PNG and JPEG images".to_string(),
                    patterns: vec![
                        "*.png".to_string(),
                        "image/jpeg".to_string(),
                    ],
                }],
                names: vec![],
                places: vec![
                    Place {
                        name: "Home".to_string(),
                        path: "/home/user".to_string(),
                    },
                    Place {
                        name: "Documents".to_string(),
                        path: "/home/user/Documents".to_string(),
                    },
                ],
                ticket: "f00dfeedf00dfeedf00dfeedf00dfeed".to_string(),
            },
        ));
        v.push((
            "file-chooser-save",
            ToShell::FileChooser {
                request: 8,
                mode: FileChooserMode::Save,
                multiple: false,
                directory: false,
                title: "Save File".to_string(),
                app_id: String::new(),
                accept_label: None,
                suggested_name: Some("report.pdf".to_string()),
                filters: vec![],
                names: vec![],
                places: vec![],
                ticket: "0123456789abcdef0123456789abcdef".to_string(),
            },
        ));
        v.push((
            "file-chooser-save-files",
            ToShell::FileChooser {
                request: 9,
                mode: FileChooserMode::SaveFiles,
                multiple: false,
                directory: true,
                title: String::new(),
                app_id: "firefox".to_string(),
                accept_label: None,
                suggested_name: None,
                filters: vec![],
                names: vec!["page.html".to_string(), "page_files".to_string()],
                places: vec![],
                ticket: "feedfacefeedfacefeedfacefeedface".to_string(),
            },
        ));
        v.push((
            "file-chooser-closed",
            ToShell::FileChooserClosed { request: 7 },
        ));
        v.push((
            "dir-listing",
            ToShell::DirListing {
                request: 7,
                path: "/home/user/Pictures".to_string(),
                entries: vec![
                    DirEntry {
                        name: "renders".to_string(),
                        dir: true,
                        size: 0,
                        modified: Some(1_754_600_000),
                    },
                    DirEntry {
                        name: "hero-4k.png".to_string(),
                        dir: false,
                        size: 13_421_772,
                        modified: None,
                    },
                ],
                truncated: false,
                error: None,
            },
        ));
        v.push((
            "dir-listing-error",
            ToShell::DirListing {
                request: 7,
                path: "/root".to_string(),
                entries: vec![],
                truncated: false,
                error: Some("Permission denied (os error 13)".to_string()),
            },
        ));
        v.push((
            "upload-offset",
            ToShell::UploadOffset {
                request: 7,
                file: "c1d2e3f4".to_string(),
                offset: 79_691_776,
            },
        ));
        v.push((
            "upload-progress",
            ToShell::UploadProgress {
                request: 7,
                file: "c1d2e3f4".to_string(),
                written: 83_886_080,
            },
        ));
        v.push((
            "upload-done",
            ToShell::UploadDone {
                request: 7,
                file: "c1d2e3f4".to_string(),
                name: "clip-final-2.mov".to_string(),
                ok: true,
                error: None,
            },
        ));
        v.push((
            "upload-done-failed",
            ToShell::UploadDone {
                request: 7,
                file: "c1d2e3f4".to_string(),
                name: String::new(),
                ok: false,
                error: Some("checksum mismatch".to_string()),
            },
        ));
        v.push((
            "path-info",
            ToShell::PathInfo {
                request: 7,
                path: "/home/user/Pictures/hero-4k.png".to_string(),
                name: "hero-4k.png".to_string(),
                kind: PathKind::File,
                size: 13_421_772,
                modified: Some(1_754_600_000),
                created: Some(1_754_500_000),
                accessed: None,
                mode: "rw-r--r--".to_string(),
                owner: "user".to_string(),
                group: "1000".to_string(),
                mime: "image/png".to_string(),
                target: None,
                items: None,
                error: None,
            },
        ));
        v.push((
            "path-info-dir",
            ToShell::PathInfo {
                request: 7,
                path: "/home/user/Pictures".to_string(),
                name: "Pictures".to_string(),
                kind: PathKind::Dir,
                size: 4096,
                modified: Some(1_754_600_000),
                created: None,
                accessed: None,
                mode: "rwxr-xr-x".to_string(),
                owner: "user".to_string(),
                group: "1000".to_string(),
                mime: String::new(),
                target: None,
                items: Some(42),
                error: None,
            },
        ));
        v
    };

    let mut to_engine = vec![
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
                codecs: vec![lwfa_proto::Codec::Hevc, lwfa_proto::Codec::H264],
            },
        ),
        (
            "set-streams-none",
            ToEngine::SetStreams {
                windows: vec![],
                codecs: vec![lwfa_proto::Codec::Hevc, lwfa_proto::Codec::H264],
            },
        ),
        (
            "set-streams-jpeg-only",
            ToEngine::SetStreams {
                windows: vec![WindowId(1)],
                codecs: vec![],
            },
        ),
    ];
    to_engine.push(("take-control", ToEngine::TakeControl));
    to_engine.push(("end-session", ToEngine::EndSession { session: 3 }));
    to_engine.push((
        "set-audio",
        ToEngine::SetAudio {
            enabled: true,
            local: false,
            opus: true,
            quality: lwfa_proto::AudioQuality::Auto,
        },
    ));
    to_engine.push((
        "close-and-spawn",
        ToEngine::CloseAndSpawn {
            command: "code".into(),
            terminal: false,
            pid: 4321,
            force: false,
        },
    ));
    to_engine.push(("set-gamepad", ToEngine::SetGamepad { enabled: true }));
    to_engine.push((
        "gamepad-button",
        ToEngine::GamepadButton {
            button: 10,
            pressed: true,
        },
    ));
    to_engine.push((
        "gamepad-axis",
        ToEngine::GamepadAxis {
            axis: 1,
            value: -0.75,
        },
    ));
    to_engine.push((
        "set-session-mode",
        ToEngine::SetSessionMode {
            session: 3,
            mode: SessionMode::View,
        },
    ));
    to_engine.push((
        "list-dir",
        ToEngine::ListDir {
            request: 7,
            path: "~".to_string(),
        },
    ));
    to_engine.push((
        "file-chosen",
        ToEngine::FileChosen {
            request: 7,
            paths: vec![
                "/home/user/Pictures/hero-4k.png".to_string(),
                "/home/user/Pictures/hero-4k-alt.png".to_string(),
            ],
        },
    ));
    to_engine.push((
        "file-chosen-uploads-only",
        ToEngine::FileChosen {
            request: 7,
            paths: vec![],
        },
    ));
    to_engine.push(("file-cancel", ToEngine::FileCancel { request: 7 }));
    to_engine.push((
        "upload-begin",
        ToEngine::UploadBegin {
            request: 7,
            file: "c1d2e3f4".to_string(),
            name: "clip-final.mov".to_string(),
            rel: vec![],
            size: 127_926_272,
        },
    ));
    to_engine.push((
        "upload-begin-in-folder",
        ToEngine::UploadBegin {
            request: 7,
            file: "a5b6c7d8".to_string(),
            name: "notes.md".to_string(),
            rel: vec!["ProjectDocs".to_string(), "meeting".to_string()],
            size: 1_126,
        },
    ));
    to_engine.push((
        "upload-end",
        ToEngine::UploadEnd {
            request: 7,
            file: "c1d2e3f4".to_string(),
            sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
                .to_string(),
        },
    ));
    to_engine.push((
        "stat-path",
        ToEngine::StatPath {
            request: 7,
            path: "/home/user/Pictures/hero-4k.png".to_string(),
        },
    ));
    to_engine.push(("ping", ToEngine::Ping));

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
