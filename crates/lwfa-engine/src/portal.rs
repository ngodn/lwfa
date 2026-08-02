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

// One unsafe block: `pre_exec`, to tie child lifetimes to ours. See
// `dies_with_us`.
#![allow(unsafe_code)]

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
        let mut command = Command::new("dbus-daemon");
        command
            .args(["--session", "--nofork", "--print-address"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        dies_with_us(&mut command);
        let mut bus = command
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
                 Interfaces=org.freedesktop.impl.portal.FileChooser;org.freedesktop.impl.portal.Settings\n\
                 UseIn=lwfa\n",
            )
        }) {
            let _ = bus.kill();
            return Err(format!("could not write the portal definition: {err}"));
        }

        // The frontend, told this desktop is called "lwfa" so it picks the
        // definition above, on the private bus so applications find it.
        let mut command = Command::new(FRONTEND);
        command
            .env("DBUS_SESSION_BUS_ADDRESS", &address)
            .env("XDG_DESKTOP_PORTAL_DIR", &dir)
            .env("XDG_CURRENT_DESKTOP", "lwfa")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        dies_with_us(&mut command);
        let frontend = command.spawn();
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

/// Make a child exit when the engine does, however the engine goes.
///
/// `Drop` only runs on a graceful shutdown; a SIGKILL, a panic-abort, or an
/// OOM leaves the children orphaned, and a `dbus-daemon` has no pipe to
/// notice its parent by, so it would sit there forever. Six of them did,
/// which is how this function came to exist. `PR_SET_PDEATHSIG` asks the
/// kernel to deliver SIGTERM to the child the moment its parent dies, which
/// covers every exit path at once.
fn dies_with_us(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `set_parent_process_death_signal` is a single prctl syscall,
    // async-signal-safe, allocating nothing: exactly what pre_exec allows.
    unsafe {
        command.pre_exec(|| {
            let _ = rustix::process::set_parent_process_death_signal(Some(
                rustix::process::Signal::TERM,
            ));
            Ok(())
        });
    }
}

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
        .and_then(|builder| builder.serve_at("/org/freedesktop/portal/desktop", Settings::new()))
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

/// The settings answers applications ask the portal for, proxied from the
/// host desktop's own portal.
///
/// Two reasons this is a proxy and not a table of values:
///
/// - **Auto-detection.** The colour scheme, the fonts, the cursor theme are
///   whatever the user's real desktop says they are, and the applications
///   inside lwfa should agree with the ones outside it. The engine runs
///   inside that session, so its default bus *is* the host's, and the
///   host's portal already knows every answer.
/// - **Completeness.** GTK reads its fonts through this portal (the
///   `org.gnome.desktop.interface` namespace). A backend that answers with
///   only a colour scheme starves applications of font configuration, and
///   text goes visibly wrong: that was a real bug here, Firefox tab titles
///   vanishing, because GTK trusted the portal that existed over its own
///   fallbacks.
///
/// When the host has no portal (a bare TTY session), the one answer that
/// matters falls back: prefer dark, matching the shell's own ink.
struct Settings {
    /// The host session bus, when it was reachable at startup.
    host: Option<zbus::blocking::Connection>,
}

/// `color-scheme`: 0 no preference, 1 prefer dark, 2 prefer light.
const PREFER_DARK: u32 = 1;

type SettingsTree = HashMap<String, HashMap<String, zvariant::OwnedValue>>;

impl Settings {
    fn new() -> Self {
        let host = zbus::blocking::Connection::session()
            .map_err(|err| {
                tracing::info!("no host session bus for settings ({err}); using defaults");
            })
            .ok();
        Self { host }
    }

    /// Ask the host desktop's portal, `None` when there is none to ask.
    fn from_host(&self, namespaces: &[String]) -> Option<SettingsTree> {
        let host = self.host.as_ref()?;
        let reply = host
            .call_method(
                Some("org.freedesktop.portal.Desktop"),
                "/org/freedesktop/portal/desktop",
                Some("org.freedesktop.portal.Settings"),
                "ReadAll",
                &(namespaces,),
            )
            .ok()?;
        reply.body().deserialize::<SettingsTree>().ok()
    }

    fn fallback() -> SettingsTree {
        let mut ns = HashMap::new();
        if let Ok(scheme) = zvariant::OwnedValue::try_from(zvariant::Value::from(PREFER_DARK)) {
            ns.insert("color-scheme".to_string(), scheme);
        }
        let mut all = HashMap::new();
        all.insert("org.freedesktop.appearance".to_string(), ns);
        all
    }
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Settings")]
impl Settings {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        1
    }

    fn read_all(&self, namespaces: Vec<String>) -> SettingsTree {
        self.from_host(&namespaces).unwrap_or_else(Self::fallback)
    }

    /// One key. Answered through `ReadAll` rather than the host's `Read`,
    /// which double-wraps its variant and would need unwrapping anyway.
    fn read(&self, namespace: String, key: String) -> zbus::fdo::Result<zvariant::OwnedValue> {
        let tree = self
            .from_host(std::slice::from_ref(&namespace))
            .unwrap_or_else(Self::fallback);
        tree.get(&namespace)
            .and_then(|ns| ns.get(&key))
            .cloned()
            .ok_or_else(|| zbus::fdo::Error::Failed(format!("no setting {namespace}.{key}")))
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
