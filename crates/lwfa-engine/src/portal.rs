//! The file-chooser portal: "upload a file" answered by the client device.
//!
//! # What this is
//!
//! When an application wants a file it does not draw a dialog itself; it
//! calls the desktop's *portal* over D-Bus and the desktop provides one.
//! lwfa is the desktop here, so it provides one, and its dialog is the shell
//! on whatever device is connected: pick a file that is already on this
//! machine, or upload one from the device in your hands, and the
//! application receives a path either way, none the wiser.
//!
//! # Why a private session bus
//!
//! The engine runs nested inside the user's real desktop, and that desktop
//! already has a portal frontend wired to its own backends: touching the
//! user's `portals.conf` would reroute *host* dialogs through lwfa, which is
//! exactly backwards. So the engine runs its own little session: a private
//! `dbus-daemon`, its own `xdg-desktop-portal` frontend pointed at a portal
//! definition naming this backend, and every application lwfa spawns gets
//! `DBUS_SESSION_BUS_ADDRESS` pointing at that bus. Host applications never
//! see it; lwfa applications never see the host's. Nothing is installed and
//! nothing outlives the engine.
//!
//! # The shape of a request
//!
//! `xdg-desktop-portal` calls the backend and *waits*; the user is deciding.
//! So the D-Bus handler sends the request to the compositor thread and
//! blocks on a reply channel: the compositor forwards it to a connected
//! shell, the human answers eventually, and the reply releases the handler.
//! One dialog at a time, which is also what a human is capable of answering.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use smithay::reexports::calloop::channel::Sender as LoopSender;
use zbus::zvariant;

/// What the compositor thread receives when an application asks.
pub struct FileRequest {
    pub save: bool,
    pub multiple: bool,
    pub directory: bool,
    pub title: String,
    pub suggested_name: Option<String>,
    /// Answered exactly once. Dropping it without answering is a cancel.
    pub reply: std::sync::mpsc::Sender<FileReply>,
}

/// The human's answer, as portal response codes expect it.
pub struct FileReply {
    /// `file://` URIs. Empty plus `cancelled: false` still means cancelled.
    pub uris: Vec<String>,
    pub cancelled: bool,
}

/// The running portal plumbing. Dropping it tears the whole session down.
pub struct Portal {
    bus: Child,
    frontend: Child,
    address: String,
    /// Keeps the backend registered; the connection dies with the struct.
    _connection: zbus::blocking::Connection,
}

impl Portal {
    /// Bring up the private bus, the backend, and the frontend.
    pub fn start(events: LoopSender<FileRequest>) -> Result<Self, String> {
        // A private bus whose address we learn from its own stdout.
        let mut bus = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("could not run dbus-daemon: {err}"))?;
        let stdout = bus.stdout.take().ok_or("dbus-daemon has no stdout")?;
        let mut address = String::new();
        if let Err(err) = BufReader::new(stdout).read_line(&mut address) {
            let _ = bus.kill();
            return Err(format!("could not read the bus address: {err}"));
        }
        let address = address.trim().to_string();
        if address.is_empty() {
            let _ = bus.kill();
            return Err("dbus-daemon printed no address".into());
        }

        // The backend, on that bus, under the name the portal definition
        // promises.
        let connection = match backend(&address, events) {
            Ok(connection) => connection,
            Err(err) => {
                let _ = bus.kill();
                return Err(err);
            }
        };

        // A portal definition directory of our own, generated fresh: nothing
        // to install, nothing to drift out of date.
        let dir = portal_dir();
        if let Err(err) = std::fs::create_dir_all(&dir).and_then(|()| {
            std::fs::write(
                dir.join("lwfa.portal"),
                "[portal]\n\
                 DBusName=org.freedesktop.impl.portal.desktop.lwfa\n\
                 Interfaces=org.freedesktop.impl.portal.FileChooser\n\
                 UseIn=lwfa\n",
            )
        }) {
            let _ = bus.kill();
            return Err(format!("could not write the portal definition: {err}"));
        }

        // The frontend, told this desktop is called "lwfa" so it picks the
        // definition above, on the private bus so applications find it.
        let frontend = Command::new(FRONTEND)
            .env("DBUS_SESSION_BUS_ADDRESS", &address)
            .env("XDG_DESKTOP_PORTAL_DIR", &dir)
            .env("XDG_CURRENT_DESKTOP", "lwfa")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let frontend = match frontend {
            Ok(frontend) => frontend,
            Err(err) => {
                let _ = bus.kill();
                return Err(format!("could not run {FRONTEND}: {err}"));
            }
        };

        tracing::info!("file-chooser portal up on a private bus");
        Ok(Self {
            bus,
            frontend,
            address,
            _connection: connection,
        })
    }

    /// The private bus, for the environment of every spawned application.
    pub fn address(&self) -> &str {
        &self.address
    }
}

impl Drop for Portal {
    fn drop(&mut self) {
        let _ = self.frontend.kill();
        let _ = self.frontend.wait();
        let _ = self.bus.kill();
        let _ = self.bus.wait();
    }
}

/// Where the Arch package puts the frontend. Not in PATH by design there.
const FRONTEND: &str = "/usr/lib/xdg-desktop-portal";

fn portal_dir() -> std::path::PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    runtime.join("lwfa-portal")
}

/// Register the backend interface on the private bus.
fn backend(
    address: &str,
    events: LoopSender<FileRequest>,
) -> Result<zbus::blocking::Connection, String> {
    let addr: zbus::Address = address
        .parse()
        .map_err(|err| format!("unusable bus address: {err}"))?;
    zbus::blocking::connection::Builder::address(addr)
        .and_then(|builder| builder.name("org.freedesktop.impl.portal.desktop.lwfa"))
        .and_then(|builder| {
            builder.serve_at("/org/freedesktop/portal/desktop", FileChooser { events })
        })
        .and_then(|builder| builder.build())
        .map_err(|err| format!("could not serve the portal backend: {err}"))
}

struct FileChooser {
    events: LoopSender<FileRequest>,
}

impl FileChooser {
    /// Forward to the compositor and wait for the human.
    fn ask(
        &self,
        save: bool,
        title: String,
        options: &HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        let flag = |key: &str| {
            options
                .get(key)
                .and_then(|value| bool::try_from(value).ok())
                .unwrap_or(false)
        };
        let suggested_name = options
            .get("current_name")
            .and_then(|value| <&str>::try_from(value).ok())
            .map(str::to_string);

        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let request = FileRequest {
            save,
            multiple: flag("multiple"),
            directory: flag("directory"),
            title,
            suggested_name,
            reply: reply_tx,
        };
        if self.events.send(request).is_err() {
            // The compositor is gone; 2 is the portal's "something failed".
            return (2, HashMap::new());
        }

        // Blocks for as long as the human takes. A dropped sender (no shell
        // connected, session closed mid-dialog) resolves as a cancel, which
        // is what the application would have seen from a closed dialog.
        match reply_rx.recv() {
            Ok(reply) if !reply.cancelled && !reply.uris.is_empty() => {
                let mut results = HashMap::new();
                match zvariant::OwnedValue::try_from(zvariant::Value::new(reply.uris)) {
                    Ok(uris) => {
                        results.insert("uris".to_string(), uris);
                        (0, results)
                    }
                    Err(err) => {
                        tracing::warn!("could not encode portal reply: {err}");
                        (2, HashMap::new())
                    }
                }
            }
            _ => (1, HashMap::new()),
        }
    }
}

#[zbus::interface(name = "org.freedesktop.impl.portal.FileChooser")]
impl FileChooser {
    #[allow(clippy::too_many_arguments)]
    fn open_file(
        &self,
        _handle: zvariant::ObjectPath<'_>,
        _app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        self.ask(false, title, &options)
    }

    #[allow(clippy::too_many_arguments)]
    fn save_file(
        &self,
        _handle: zvariant::ObjectPath<'_>,
        _app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        self.ask(true, title, &options)
    }

    /// Batch saves are rare (a browser's "save all"); answered as cancelled
    /// rather than pretending, so the application falls back sensibly.
    #[allow(clippy::too_many_arguments)]
    fn save_files(
        &self,
        _handle: zvariant::ObjectPath<'_>,
        _app_id: String,
        _parent_window: String,
        _title: String,
        _options: HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        (1, HashMap::new())
    }
}
