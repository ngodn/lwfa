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
                permissions: Permissions::owner(),
                account: "owner".into(),
                session: 1,
                primary: true,
                peers: vec![lwfa_proto::PeerInfo {
                    id: 1,
                    account: "owner".into(),
                    mode: lwfa_proto::SessionMode::Interact,
                    primary: true,
                    device: "iPad".into(),
                }],
            },
        ),
        (
            "hello-empty",
            ToShell::Hello {
                protocol_version: PROTOCOL_VERSION,
                output,
                windows: vec![],
                focused: None,
                // A view-only session, so the fixture covers the restrictive
                // shape as well as the permissive one.
                permissions: Permissions {
                    mode: SessionMode::View,
                    allowed_apps: Some(vec!["org.example.Thing".into()]),
                },
                account: "guest".into(),
                session: 2,
                primary: false,
                peers: vec![],
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
            "engine-version",
            ToShell::EngineVersion {
                version: "1.1.10".into(),
            },
        ),
        (
            "window-blank",
            ToShell::WindowBlank {
                id: WindowId(7),
                blank: true,
            },
        ),
        (
            "window-painted-at-last",
            ToShell::WindowBlank {
                id: WindowId(7),
                blank: false,
            },
        ),
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
        ("role", ToShell::Role { primary: false }),
        (
            "clip-ready",
            ToShell::ClipReady {
                channel: 9_000_001,
                ticket: "0f3a9c2e5b174d68".into(),
            },
        ),
        (
            "clip-added-text",
            ToShell::ClipAdded {
                item: ClipItem {
                    id: 41,
                    at: 1_755_600_000_000,
                    origin: ClipOrigin::Lwfa,
                    device: None,
                    kind: ClipKind::Text,
                    bytes: 11,
                    mime: "text/plain;charset=utf-8".into(),
                    preview: "hello there".into(),
                    whole: true,
                    width: None,
                    height: None,
                    path: None,
                },
            },
        ),
        (
            "clip-added-image",
            ToShell::ClipAdded {
                item: ClipItem {
                    id: 42,
                    at: 1_755_600_030_000,
                    origin: ClipOrigin::Device,
                    device: Some("iPad".into()),
                    kind: ClipKind::Image,
                    bytes: 284_913,
                    mime: "image/png".into(),
                    preview: "screenshot.png".into(),
                    whole: false,
                    width: Some(2360),
                    height: Some(1640),
                    path: Some("/home/user/Uploads/screenshot.png".into()),
                },
            },
        ),
        ("clip-dropped", ToShell::ClipDropped { id: 41 }),
        ("clip-cleared", ToShell::ClipCleared),
        (
            "clip-history",
            ToShell::ClipHistory {
                request: 3,
                items: vec![ClipItem {
                    id: 40,
                    at: 1_755_599_000_000,
                    origin: ClipOrigin::Desktop,
                    device: None,
                    kind: ClipKind::Files,
                    bytes: 46,
                    mime: "text/uri-list".into(),
                    preview: "notes.md".into(),
                    whole: false,
                    width: None,
                    height: None,
                    path: Some("/home/user/notes.md".into()),
                }],
                more: true,
            },
        ),
        ("pong", ToShell::Pong),
        (
            "already-running",
            ToShell::AlreadyRunning {
                command: "code".to_string(),
                terminal: false,
                program: "code".to_string(),
                pid: 4321,
            },
        ),
        (
            "peers",
            ToShell::Peers {
                peers: vec![
                    lwfa_proto::PeerInfo {
                        id: 1,
                        account: "owner".into(),
                        mode: SessionMode::Interact,
                        primary: true,
                        device: "Linux desktop".into(),
                    },
                    lwfa_proto::PeerInfo {
                        id: 2,
                        account: "guest".into(),
                        mode: SessionMode::View,
                        primary: false,
                        device: "iPad".into(),
                    },
                ],
            },
        ),
        (
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
        ),
        (
            "file-chooser",
            ToShell::FileChooser {
                request: 7,
                mode: FileChooserMode::Open,
                multiple: true,
                directory: false,
                title: "Open Image".into(),
                app_id: "org.gimp.GIMP".into(),
                accept_label: Some("_Open".into()),
                suggested_name: None,
                filters: vec![FileFilter {
                    name: "PNG and JPEG images".into(),
                    patterns: vec!["*.png".into(), "image/jpeg".into()],
                }],
                names: vec![],
                places: vec![
                    Place {
                        name: "Home".into(),
                        path: "/home/user".into(),
                    },
                    Place {
                        name: "Documents".into(),
                        path: "/home/user/Documents".into(),
                    },
                ],
                ticket: "f00dfeedf00dfeedf00dfeedf00dfeed".into(),
            },
        ),
        (
            "file-chooser-save",
            ToShell::FileChooser {
                request: 8,
                mode: FileChooserMode::Save,
                multiple: false,
                directory: false,
                title: "Save File".into(),
                app_id: String::new(),
                accept_label: None,
                suggested_name: Some("report.pdf".into()),
                filters: vec![],
                names: vec![],
                places: vec![],
                ticket: "0123456789abcdef0123456789abcdef".into(),
            },
        ),
        (
            "file-chooser-save-files",
            ToShell::FileChooser {
                request: 9,
                mode: FileChooserMode::SaveFiles,
                multiple: false,
                directory: true,
                title: String::new(),
                app_id: "firefox".into(),
                accept_label: None,
                suggested_name: None,
                filters: vec![],
                names: vec!["page.html".into(), "page_files".into()],
                places: vec![],
                ticket: "feedfacefeedfacefeedfacefeedface".into(),
            },
        ),
        (
            "file-chooser-closed",
            ToShell::FileChooserClosed { request: 7 },
        ),
        (
            "dir-listing",
            ToShell::DirListing {
                request: 7,
                path: "/home/user/Pictures".into(),
                entries: vec![
                    DirEntry {
                        name: "renders".into(),
                        dir: true,
                        size: 0,
                        modified: Some(1_754_600_000),
                    },
                    DirEntry {
                        name: "hero-4k.png".into(),
                        dir: false,
                        size: 13_421_772,
                        modified: None,
                    },
                ],
                truncated: false,
                error: None,
            },
        ),
        (
            "dir-listing-error",
            ToShell::DirListing {
                request: 7,
                path: "/root".into(),
                entries: vec![],
                truncated: false,
                error: Some("Permission denied (os error 13)".into()),
            },
        ),
        (
            "upload-offset",
            ToShell::UploadOffset {
                request: 7,
                file: "c1d2e3f4".into(),
                offset: 79_691_776,
            },
        ),
        (
            "upload-progress",
            ToShell::UploadProgress {
                request: 7,
                file: "c1d2e3f4".into(),
                written: 83_886_080,
            },
        ),
        (
            "upload-done",
            ToShell::UploadDone {
                request: 7,
                file: "c1d2e3f4".into(),
                name: "clip-final-2.mov".into(),
                ok: true,
                error: None,
            },
        ),
        (
            "upload-done-failed",
            ToShell::UploadDone {
                request: 7,
                file: "c1d2e3f4".into(),
                name: String::new(),
                ok: false,
                error: Some("checksum mismatch".into()),
            },
        ),
        (
            "path-info",
            ToShell::PathInfo {
                request: 7,
                path: "/home/user/Pictures/hero-4k.png".into(),
                name: "hero-4k.png".into(),
                kind: PathKind::File,
                size: 13_421_772,
                modified: Some(1_754_600_000),
                created: Some(1_754_500_000),
                accessed: None,
                mode: "rw-r--r--".into(),
                owner: "user".into(),
                group: "1000".into(),
                mime: "image/png".into(),
                target: None,
                items: None,
                error: None,
            },
        ),
        (
            "path-info-dir",
            ToShell::PathInfo {
                request: 7,
                path: "/home/user/Pictures".into(),
                name: "Pictures".into(),
                kind: PathKind::Dir,
                size: 4096,
                modified: Some(1_754_600_000),
                created: None,
                accessed: None,
                mode: "rwxr-xr-x".into(),
                owner: "user".into(),
                group: "1000".into(),
                mime: String::new(),
                target: None,
                items: Some(42),
                error: None,
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
        ("take-control", ToEngine::TakeControl),
        (
            "crashed",
            ToEngine::Crashed {
                message: "Cannot read properties of undefined (reading 'width')".into(),
            },
        ),
        ("end-session", ToEngine::EndSession { session: 3 }),
        (
            "set-audio",
            ToEngine::SetAudio {
                enabled: true,
                local: false,
                opus: true,
                quality: lwfa_proto::AudioQuality::Auto,
            },
        ),
        (
            "close-and-spawn",
            ToEngine::CloseAndSpawn {
                command: "code".into(),
                terminal: false,
                pid: 4321,
                force: false,
            },
        ),
        ("set-gamepad", ToEngine::SetGamepad { enabled: true }),
        (
            "gamepad-button",
            ToEngine::GamepadButton {
                button: 10,
                pressed: true,
            },
        ),
        (
            "gamepad-axis",
            ToEngine::GamepadAxis {
                axis: 1,
                value: -0.75,
            },
        ),
        (
            "set-session-mode",
            ToEngine::SetSessionMode {
                session: 3,
                mode: SessionMode::View,
            },
        ),
        (
            "list-dir",
            ToEngine::ListDir {
                request: 7,
                path: "~".into(),
            },
        ),
        (
            "file-chosen",
            ToEngine::FileChosen {
                request: 7,
                paths: vec![
                    "/home/user/Pictures/hero-4k.png".into(),
                    "/home/user/Pictures/hero-4k-alt.png".into(),
                ],
            },
        ),
        (
            "file-chosen-uploads-only",
            ToEngine::FileChosen {
                request: 7,
                paths: vec![],
            },
        ),
        ("file-cancel", ToEngine::FileCancel { request: 7 }),
        (
            "upload-begin",
            ToEngine::UploadBegin {
                request: 7,
                file: "c1d2e3f4".into(),
                name: "clip-final.mov".into(),
                rel: vec![],
                size: 127_926_272,
            },
        ),
        (
            "upload-begin-in-folder",
            ToEngine::UploadBegin {
                request: 7,
                file: "a5b6c7d8".into(),
                name: "notes.md".into(),
                rel: vec!["ProjectDocs".into(), "meeting".into()],
                size: 1_126,
            },
        ),
        (
            "upload-end",
            ToEngine::UploadEnd {
                request: 7,
                file: "c1d2e3f4".into(),
                sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
                    .into(),
            },
        ),
        (
            "stat-path",
            ToEngine::StatPath {
                request: 7,
                path: "/home/user/Pictures/hero-4k.png".into(),
            },
        ),
        (
            "clip-list",
            ToEngine::ClipList {
                request: 3,
                before: Some(40),
                limit: 20,
            },
        ),
        (
            "clip-set-text",
            ToEngine::ClipSetText {
                text: "sent from the tablet".into(),
            },
        ),
        ("clip-use", ToEngine::ClipUse { id: 40 }),
        ("clip-drop", ToEngine::ClipDrop { id: 40 }),
        ("clip-clear", ToEngine::ClipClear),
        ("ping", ToEngine::Ping),
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
