//! The file-chooser portal: applications ask, the connected device answers.
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
//! Without this, an application inside lwfa reaches the *host's* portal,
//! which renders its dialog on the physical display of a machine nobody is
//! sitting at. From the connected device the application just looks hung.
//!
//! # The shape of a request
//!
//! `xdg-desktop-portal` calls the backend and waits; the user is deciding.
//! The handler forwards the request to the compositor thread and awaits a
//! oneshot for the answer. Awaits, not blocks: zbus runs every method call
//! as its own task, so a dialog open for ten minutes does not stop the
//! Settings interface answering, and a second application can open its own
//! dialog meanwhile. The shell queues them; humans answer one at a time.
//!
//! The application can also withdraw: the portal contract says the caller
//! may `Close` the request object at the handle path it supplied. That
//! arrives as [`PortalEvent::Closed`] and the compositor treats it exactly
//! like a cancel, including deleting anything already uploaded under it.

// One unsafe block: `pre_exec`, to tie child lifetimes to ours. See
// `dies_with_us`.
#![allow(unsafe_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use smithay::reexports::calloop::channel::Sender as LoopSender;
use zbus::zvariant;

/// What the compositor thread receives from the portal.
pub enum PortalEvent {
    /// An application opened a dialog and is waiting on the answer.
    Ask(FileRequest),
    /// An application withdrew the request with this handle. Treat as a
    /// cancel: the human should not answer a question nobody is asking.
    Closed(String),
}

/// Which dialog the application asked for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Open,
    Save,
    SaveFiles,
}

/// One file dialog, as the compositor sees it.
pub struct FileRequest {
    pub kind: Kind,
    pub multiple: bool,
    pub directory: bool,
    pub title: String,
    /// Who is asking, as it identified itself to the portal. Often empty:
    /// only sandboxed applications are forced to be honest about it.
    pub app_id: String,
    /// The label the application wants on the confirm button, mnemonic
    /// underscores already stripped.
    pub accept_label: Option<String>,
    pub suggested_name: Option<String>,
    /// What the application says it can open, already flattened for the
    /// shell: globs and MIME types in one list per filter.
    pub filters: Vec<lwfa_proto::FileFilter>,
    /// The filenames a `SaveFiles` call will write. Empty otherwise.
    pub names: Vec<String>,
    /// The caller's request handle, for matching a later `Close`.
    pub handle: String,
    /// Answered exactly once. Dropping it without answering is a cancel.
    pub reply: futures_channel::oneshot::Sender<FileReply>,
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
    pub fn start(events: LoopSender<PortalEvent>) -> Result<Self, String> {
        let frontend_path = find_frontend()?;

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

        // Anything the host serves that an application in here still needs.
        //
        // Started before the frontend so the names are owned by the time the
        // first application connects; a client that asks early and gets
        // "no such name" caches that answer for its lifetime. Not fatal if it
        // fails: the session works without a keyring, it just cannot remember
        // a password. See `crate::hostbus`.
        //
        // The host's address is read from the environment rather than passed
        // in, and read here rather than kept from startup, because nothing in
        // this process ever overwrites it: `DBUS_SESSION_BUS_ADDRESS` is set on
        // the children this module spawns, never on the engine itself.
        match std::env::var("DBUS_SESSION_BUS_ADDRESS") {
            Ok(host) => {
                if let Err(err) = crate::hostbus::start(&address, &host, crate::hostbus::RELAYED) {
                    tracing::warn!("no host services inside the session: {err}");
                }
            }
            Err(_) => tracing::warn!(
                "no DBUS_SESSION_BUS_ADDRESS, so the host's keyring is not reachable in here"
            ),
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
        let mut command = Command::new(&frontend_path);
        command
            .env("DBUS_SESSION_BUS_ADDRESS", &address)
            .env("XDG_DESKTOP_PORTAL_DIR", &dir)
            .env("XDG_CURRENT_DESKTOP", "lwfa")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        dies_with_us(&mut command);
        let frontend = match command.spawn() {
            Ok(frontend) => frontend,
            Err(err) => {
                let _ = bus.kill();
                return Err(format!("could not run {}: {err}", frontend_path.display()));
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

/// Where the frontend binary lives. Never in PATH by design; distributions
/// treat it as infrastructure, not a command.
///
/// Arch puts it under `/usr/lib`, Debian and Fedora under `/usr/libexec`.
/// `LWFA_PORTAL_FRONTEND` overrides both for anything more exotic.
fn find_frontend() -> Result<std::path::PathBuf, String> {
    if let Some(explicit) = std::env::var_os("LWFA_PORTAL_FRONTEND") {
        let path = std::path::PathBuf::from(explicit);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "LWFA_PORTAL_FRONTEND={} does not exist",
                path.display()
            ))
        };
    }
    const CANDIDATES: [&str; 2] = [
        "/usr/lib/xdg-desktop-portal",
        "/usr/libexec/xdg-desktop-portal",
    ];
    CANDIDATES
        .iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.is_file())
        .ok_or_else(|| {
            format!(
                "xdg-desktop-portal is not installed (looked in {})",
                CANDIDATES.join(" and ")
            )
        })
}

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
    // The death signal is `SIGTERM`, which a child that inherited the engine's
    // blocked mask would never act on. See `crate::childsig`.
    crate::childsig::unblock_signals(command);
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

/// Register the backend interfaces on the private bus.
fn backend(
    address: &str,
    events: LoopSender<PortalEvent>,
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
    events: LoopSender<PortalEvent>,
}

/// The request object the portal contract wants at the caller's handle path.
///
/// Its one job is `Close`: an application withdrawing its own dialog, which
/// happens whenever the window that asked is closed first. Without it the
/// dialog would outlive the question, and whatever the human answered would
/// go nowhere.
struct PortalRequest {
    handle: String,
    events: LoopSender<PortalEvent>,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Request")]
impl PortalRequest {
    fn close(&self) {
        let _ = self.events.send(PortalEvent::Closed(self.handle.clone()));
    }
}

impl FileChooser {
    /// Forward to the compositor and await the human.
    ///
    /// The request object is served at `handle` for the duration, so the
    /// caller can withdraw, and removed on the way out either way.
    async fn ask(
        &self,
        server: &zbus::object_server::ObjectServer,
        kind: Kind,
        handle: zvariant::ObjectPath<'_>,
        app_id: String,
        title: String,
        options: &HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        let flag = |key: &str| {
            options
                .get(key)
                .and_then(|value| bool::try_from(value).ok())
                .unwrap_or(false)
        };
        let text = |key: &str| {
            options
                .get(key)
                .and_then(|value| <&str>::try_from(value).ok())
                .map(str::to_string)
        };

        let (reply_tx, reply_rx) = futures_channel::oneshot::channel();
        let request = FileRequest {
            kind,
            multiple: flag("multiple"),
            directory: flag("directory"),
            title,
            app_id,
            // The mnemonic underscore ("_Open") is a toolkit convention;
            // a browser has no mnemonics to bind it to.
            accept_label: text("accept_label").map(|l| l.replace('_', "")),
            suggested_name: text("current_name"),
            filters: parse_filters(options.get("filters")),
            names: parse_save_names(options.get("files")),
            handle: handle.to_string(),
            reply: reply_tx,
        };
        if self.events.send(PortalEvent::Ask(request)).is_err() {
            // The compositor is gone; 2 is the portal's "something failed".
            return (2, HashMap::new());
        }

        let served = server
            .at(
                &handle,
                PortalRequest {
                    handle: handle.to_string(),
                    events: self.events.clone(),
                },
            )
            .await
            .unwrap_or(false);

        // Awaits for as long as the human takes. A dropped sender (no shell
        // connected, session closed mid-dialog) resolves as a cancel, which
        // is what the application would have seen from a closed dialog.
        let reply = reply_rx.await;

        if served {
            let _ = server.remove::<PortalRequest, _>(&handle).await;
        }

        match reply {
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

/// The portal's filter shape: an array of (name, array of (type, pattern))
/// where type 0 is a glob and type 1 is a MIME type. Flattened to one
/// pattern list per filter, because that is what a browser's `accept`
/// attribute and a listing filter both want.
fn parse_filters(value: Option<&zvariant::OwnedValue>) -> Vec<lwfa_proto::FileFilter> {
    type Wire = Vec<(String, Vec<(u32, String)>)>;
    let Some(value) = value else {
        return Vec::new();
    };
    let Ok(cloned) = value.try_clone() else {
        return Vec::new();
    };
    let Ok(filters) = <Wire>::try_from(cloned) else {
        tracing::debug!("ignoring malformed file filters");
        return Vec::new();
    };
    filters
        .into_iter()
        .map(|(name, patterns)| lwfa_proto::FileFilter {
            name,
            patterns: patterns.into_iter().map(|(_, pattern)| pattern).collect(),
        })
        .collect()
}

/// `SaveFiles` names arrive as byte arrays with a trailing NUL, because they
/// are filenames and filenames are bytes. Shown to a human, so lossy UTF-8
/// is the right amount of honesty.
fn parse_save_names(value: Option<&zvariant::OwnedValue>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Ok(cloned) = value.try_clone() else {
        return Vec::new();
    };
    let Ok(names) = <Vec<Vec<u8>>>::try_from(cloned) else {
        return Vec::new();
    };
    names
        .into_iter()
        .map(|bytes| {
            let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
            String::from_utf8_lossy(&bytes[..end]).into_owned()
        })
        .filter(|name| !name.is_empty())
        .collect()
}

#[zbus::interface(name = "org.freedesktop.impl.portal.FileChooser")]
impl FileChooser {
    async fn open_file(
        &self,
        #[zbus(object_server)] server: &zbus::object_server::ObjectServer,
        handle: zvariant::ObjectPath<'_>,
        app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        self.ask(server, Kind::Open, handle, app_id, title, &options)
            .await
    }

    async fn save_file(
        &self,
        #[zbus(object_server)] server: &zbus::object_server::ObjectServer,
        handle: zvariant::ObjectPath<'_>,
        app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        self.ask(server, Kind::Save, handle, app_id, title, &options)
            .await
    }

    /// "Save these named files into a folder the user picks": a browser's
    /// "save page with its assets". The shell shows the names and asks for a
    /// folder; the engine composes the paths.
    async fn save_files(
        &self,
        #[zbus(object_server)] server: &zbus::object_server::ObjectServer,
        handle: zvariant::ObjectPath<'_>,
        app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, zvariant::OwnedValue>,
    ) -> (u32, HashMap<String, zvariant::OwnedValue>) {
        self.ask(server, Kind::SaveFiles, handle, app_id, title, &options)
            .await
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
    fn read_host(&self, namespaces: &[String]) -> Option<SettingsTree> {
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
        self.read_host(&namespaces).unwrap_or_else(Self::fallback)
    }

    /// One key. Answered through `ReadAll` rather than the host's `Read`,
    /// which double-wraps its variant and would need unwrapping anyway.
    fn read(&self, namespace: String, key: String) -> zbus::fdo::Result<zvariant::OwnedValue> {
        let tree = self
            .read_host(std::slice::from_ref(&namespace))
            .unwrap_or_else(Self::fallback);
        tree.get(&namespace)
            .and_then(|ns| ns.get(&key))
            .cloned()
            .ok_or_else(|| zbus::fdo::Error::Failed(format!("no setting {namespace}.{key}")))
    }
}
