//! The clipboard of the desktop outside lwfa.
//!
//! # Why this is not just another Wayland client
//!
//! lwfa is a nested compositor, which makes it an ordinary client of the
//! desktop it runs on. That would be enough to read the host clipboard if
//! the engine ever held keyboard focus over there, because `wl_data_device`
//! delivers offers only to the focused surface. It does not: the session
//! window sits parked on a workspace nobody is looking at, and the tablet
//! driving it is not touching the host at all.
//!
//! So this speaks `ext-data-control`, the protocol clipboard managers use,
//! which reports every selection change regardless of focus and can set the
//! selection without one. `wlr-data-control` is the older spelling of the
//! same idea and still the only one some compositors offer, so both are
//! supported and whichever exists is used, newer first.
//!
//! # A thread, not an event source
//!
//! Its own connection and its own small event loop, on its own thread. The
//! compositor's loop is busy compositing, and a clipboard read blocks on a
//! program that may be paging in from disk. Captures come back over the
//! same channel the shell's events use.
//!
//! # Which display
//!
//! Explicitly the host's, captured before startup overwrites
//! `WAYLAND_DISPLAY` with this session's own socket (see `winit.rs`).
//! Connecting to the environment here would connect lwfa to itself, and
//! every copy would echo between the two halves of one process forever.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Arc;

use smithay::reexports::calloop;
use smithay::reexports::calloop::channel::Sender as LoopSender;
use wayland_client::backend::ObjectId;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, delegate_noop, event_created_child};
use wayland_protocols::ext::data_control::v1::client as ext;
use wayland_protocols_wlr::data_control::v1::client as wlr;

use crate::clipboard::Where;
use crate::shell::ShellEvent;

/// A type nothing will ever ask for, offered on everything we put on the
/// host clipboard so we can recognise our own copy coming back.
///
/// The host announces every selection change, including the ones we make,
/// and reading our own copy back files it a second time under a second
/// name: a photo sent from a tablet appeared once as itself and again as
/// "copied on the desktop" a moment later. Content hashing does not catch
/// it, because what goes out is the file and what comes back can be the
/// list naming it. Telling the two apart by which event arrived first
/// would be guessing at an ordering; a marker is simply exact.
const MARKER: &str = "application/x-lwfa-echo";

/// What the compositor asks the host clipboard to do.
enum Command {
    /// Own the host selection, offering these types, backed by these bytes.
    Offer {
        mimes: Vec<String>,
        bytes: Arc<Vec<u8>>,
    },
    /// Stop owning it.
    Withdraw,
}

/// The compositor's handle on the host clipboard.
pub struct Link {
    commands: calloop::channel::Sender<Command>,
}

impl Link {
    /// Put these bytes on the host's clipboard, under these types.
    ///
    /// One set of bytes for every type offered: what lwfa captured is one
    /// thing described several ways, and a program asking for `UTF8_STRING`
    /// and one asking for `text/plain` want the same text.
    pub fn offer(&self, mimes: Vec<String>, bytes: Vec<u8>) {
        let _ = self.commands.send(Command::Offer {
            mimes,
            bytes: Arc::new(bytes),
        });
    }

    pub fn withdraw(&self) {
        let _ = self.commands.send(Command::Withdraw);
    }
}

/// Start watching and driving the host clipboard.
///
/// `display` is the host's `WAYLAND_DISPLAY` as it was before startup
/// replaced it, and `ours` is this session's socket. `None` for either, or
/// a host with neither data-control protocol, means the desktop's clipboard
/// is not part of the picture and everything else still works.
pub fn start(
    display: Option<OsString>,
    ours: &OsStr,
    events: LoopSender<ShellEvent>,
) -> Option<Link> {
    let display = display?;
    if display == ours {
        tracing::debug!("no host clipboard: nothing was running outside this session");
        return None;
    }
    let socket = socket_path(&display)?;
    let (commands, receiver) = calloop::channel::channel();

    let spawned = std::thread::Builder::new()
        .name("lwfa-hostclip".to_string())
        .spawn(move || match run(&socket, receiver, events) {
            Ok(()) => tracing::info!("the host clipboard connection closed"),
            Err(err) => tracing::info!("no host clipboard: {err}"),
        });
    match spawned {
        Ok(_) => Some(Link { commands }),
        Err(err) => {
            tracing::warn!("could not start the host clipboard thread: {err}");
            None
        }
    }
}

/// An absolute socket path, resolved the way every Wayland client does.
fn socket_path(display: &OsStr) -> Option<PathBuf> {
    let path = PathBuf::from(display);
    if path.is_absolute() {
        return Some(path);
    }
    let dir = std::env::var_os("XDG_RUNTIME_DIR")?;
    Some(PathBuf::from(dir).join(path))
}

fn run(
    socket: &PathBuf,
    commands: calloop::channel::Channel<Command>,
    events: LoopSender<ShellEvent>,
) -> Result<(), String> {
    let stream =
        UnixStream::connect(socket).map_err(|err| format!("{}: {err}", socket.display()))?;
    let connection = Connection::from_socket(stream).map_err(|err| err.to_string())?;
    let (globals, queue) =
        registry_queue_init::<Host>(&connection).map_err(|err| err.to_string())?;
    let qh = queue.handle();

    // Any seat will do: a selection belongs to a seat, and a desktop with
    // two of them is rare enough that the first is the right guess.
    let seat: wl_seat::WlSeat = globals
        .bind(&qh, 1..=1, ())
        .map_err(|err| format!("no seat on the host: {err}"))?;

    // Newest first. `wlr-data-control` is the deprecated spelling of the
    // same protocol, kept because compositors are still catching up.
    let device = if let Ok(manager) = globals
        .bind::<ext::ext_data_control_manager_v1::ExtDataControlManagerV1, _, _>(&qh, 1..=1, ())
    {
        tracing::info!("host clipboard: connected over ext-data-control");
        Device::Ext(manager.get_data_device(&seat, &qh, ()), manager)
    } else if let Ok(manager) = globals
        .bind::<wlr::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1, _, _>(&qh, 1..=2, ())
    {
        tracing::info!("host clipboard: connected over wlr-data-control");
        Device::Wlr(manager.get_data_device(&seat, &qh, ()), manager)
    } else {
        return Err("the host offers no data-control protocol".to_string());
    };

    let mut event_loop = calloop::EventLoop::<Host>::try_new().map_err(|err| err.to_string())?;
    let handle = event_loop.handle();
    handle
        .insert_source(commands, |event, _, host| {
            if let calloop::channel::Event::Msg(command) = event {
                host.command(command);
            }
        })
        .map_err(|err| err.to_string())?;
    calloop_wayland_source::WaylandSource::new(connection.clone(), queue)
        .insert(handle)
        .map_err(|err| err.to_string())?;

    let mut host = Host {
        connection,
        qh,
        device,
        offers: HashMap::new(),
        held: None,
        events,
    };
    event_loop
        .run(None, &mut host, |_| {})
        .map_err(|err| err.to_string())
}

/// Whichever data-control protocol the host turned out to speak.
///
/// The manager is held next to the device because dropping it destroys the
/// binding, and with it the ability to create a source later.
enum Device {
    Ext(
        ext::ext_data_control_device_v1::ExtDataControlDeviceV1,
        ext::ext_data_control_manager_v1::ExtDataControlManagerV1,
    ),
    Wlr(
        wlr::zwlr_data_control_device_v1::ZwlrDataControlDeviceV1,
        wlr::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1,
    ),
}

/// One selection the host is offering us.
enum Offer {
    Ext(ext::ext_data_control_offer_v1::ExtDataControlOfferV1),
    Wlr(wlr::zwlr_data_control_offer_v1::ZwlrDataControlOfferV1),
}

impl Offer {
    fn id(&self) -> ObjectId {
        match self {
            Self::Ext(offer) => offer.id(),
            Self::Wlr(offer) => offer.id(),
        }
    }

    fn receive(&self, mime: String, fd: std::os::fd::BorrowedFd<'_>) {
        match self {
            Self::Ext(offer) => offer.receive(mime, fd),
            Self::Wlr(offer) => offer.receive(mime, fd),
        }
    }

    fn destroy(&self) {
        match self {
            Self::Ext(offer) => offer.destroy(),
            Self::Wlr(offer) => offer.destroy(),
        }
    }
}

/// The bytes behind a selection we own, and the source offering them.
struct Held {
    bytes: Arc<Vec<u8>>,
    source: SourceHandle,
}

enum SourceHandle {
    Ext(ext::ext_data_control_source_v1::ExtDataControlSourceV1),
    Wlr(wlr::zwlr_data_control_source_v1::ZwlrDataControlSourceV1),
}

impl SourceHandle {
    fn id(&self) -> ObjectId {
        match self {
            Self::Ext(source) => source.id(),
            Self::Wlr(source) => source.id(),
        }
    }

    fn destroy(&self) {
        match self {
            Self::Ext(source) => source.destroy(),
            Self::Wlr(source) => source.destroy(),
        }
    }
}

struct Host {
    connection: Connection,
    qh: QueueHandle<Host>,
    device: Device,
    /// Types each live offer advertises, keyed by the offer object. Filled
    /// by the `offer` events that follow every `data_offer`.
    offers: HashMap<ObjectId, Vec<String>>,
    /// What we put on the host clipboard, while we own it.
    held: Option<Held>,
    events: LoopSender<ShellEvent>,
}

impl Host {
    fn command(&mut self, command: Command) {
        match command {
            Command::Offer { mimes, bytes } => self.offer(mimes, bytes),
            Command::Withdraw => {
                if let Some(old) = self.held.take() {
                    old.source.destroy();
                }
                match &self.device {
                    Device::Ext(device, _) => device.set_selection(None),
                    Device::Wlr(device, _) => device.set_selection(None),
                }
                let _ = self.connection.flush();
            }
        }
    }

    fn offer(&mut self, mut mimes: Vec<String>, bytes: Arc<Vec<u8>>) {
        // The one being replaced goes first, so the compositor is not left
        // holding an object nothing will ever answer for.
        if let Some(old) = self.held.take() {
            old.source.destroy();
        }
        mimes.push(MARKER.to_string());
        let source = match &self.device {
            Device::Ext(device, manager) => {
                let source = manager.create_data_source(&self.qh, ());
                for mime in &mimes {
                    source.offer(mime.clone());
                }
                device.set_selection(Some(&source));
                SourceHandle::Ext(source)
            }
            Device::Wlr(device, manager) => {
                let source = manager.create_data_source(&self.qh, ());
                for mime in &mimes {
                    source.offer(mime.clone());
                }
                device.set_selection(Some(&source));
                SourceHandle::Wlr(source)
            }
        };
        self.held = Some(Held { bytes, source });
        let _ = self.connection.flush();
    }

    /// The host's selection changed. Read it, unless it is ours.
    ///
    /// See [`MARKER`] for how our own copies are recognised, and why they
    /// have to be.
    fn selection(&mut self, offer: Option<Offer>) {
        let Some(offer) = offer else { return };
        let mimes = self.offers.remove(&offer.id()).unwrap_or_default();
        if mimes.iter().any(|mime| mime == MARKER) {
            // Ours. Reading it would file the same copy twice.
            offer.destroy();
            let _ = self.connection.flush();
            return;
        }
        let Some(mime) = crate::clipboard::best_mime(&mimes) else {
            offer.destroy();
            let _ = self.connection.flush();
            return;
        };
        let Ok((reader, writer)) = std::io::pipe() else {
            offer.destroy();
            return;
        };
        // The request has to reach the host before it will write anything,
        // and our own copy of the write end has to go before the read can
        // ever see the end of it.
        offer.receive(mime.clone(), writer.as_fd());
        offer.destroy();
        if self.connection.flush().is_err() {
            return;
        }
        drop(writer);
        crate::clipboard::read_offer(reader, mime, Where::Desktop, None, self.events.clone());
    }

    /// An offer we will never read. Let it go rather than leak the object.
    fn discard(&mut self, offer: &Offer) {
        self.offers.remove(&offer.id());
        offer.destroy();
        let _ = self.connection.flush();
    }

    /// We are no longer the host's selection owner.
    ///
    /// The check is not ceremony. Replacing our own selection cancels the
    /// source it replaced, and that cancellation arrives *after* the new
    /// one is in place: clearing unconditionally threw away the selection
    /// we had just set, and every copy after the first read back as empty
    /// on the host. Found by copying twice.
    fn cancelled(&mut self, source: ObjectId) {
        if self.held.as_ref().is_some_and(|held| held.source.id() == source) {
            self.held = None;
        }
    }

    /// A program on the host is pasting what we offered.
    fn send(&self, fd: OwnedFd) {
        let Some(held) = self.held.as_ref() else {
            return;
        };
        crate::clipboard::write_offer(fd.into(), held.bytes.as_ref().clone());
    }
}

// ---------------------------------------------------------------------------
// Protocol plumbing
//
// Two near-identical sets, one per data-control protocol. Written out rather
// than generated by a macro: six short impls that each forward to one method
// read better than one macro that hides which protocol does what.
// ---------------------------------------------------------------------------

delegate_noop!(Host: ignore wl_seat::WlSeat);
delegate_noop!(Host: ignore ext::ext_data_control_manager_v1::ExtDataControlManagerV1);
delegate_noop!(Host: ignore wlr::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1);

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Host {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Globals appearing later are of no interest: what this needs was
        // bound at startup or was never there.
    }
}

impl Dispatch<ext::ext_data_control_device_v1::ExtDataControlDeviceV1, ()> for Host {
    event_created_child!(Host, ext::ext_data_control_device_v1::ExtDataControlDeviceV1, [
        0 => (ext::ext_data_control_offer_v1::ExtDataControlOfferV1, ()),
    ]);

    fn event(
        host: &mut Self,
        _: &ext::ext_data_control_device_v1::ExtDataControlDeviceV1,
        event: ext::ext_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use ext::ext_data_control_device_v1::Event;
        match event {
            // The offer arrives empty and is described by the `offer`
            // events that follow; only the later `selection` says it is the
            // clipboard rather than the primary selection.
            Event::DataOffer { .. } => {}
            Event::Selection { id } => host.selection(id.map(Offer::Ext)),
            // Middle-click paste, which nothing here tracks.
            Event::PrimarySelection { id: Some(offer) } => host.discard(&Offer::Ext(offer)),
            Event::Finished => tracing::debug!("the host took the clipboard device away"),
            _ => {}
        }
    }
}

impl Dispatch<ext::ext_data_control_offer_v1::ExtDataControlOfferV1, ()> for Host {
    fn event(
        host: &mut Self,
        offer: &ext::ext_data_control_offer_v1::ExtDataControlOfferV1,
        event: ext::ext_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let ext::ext_data_control_offer_v1::Event::Offer { mime_type } = event {
            host.offers.entry(offer.id()).or_default().push(mime_type);
        }
    }
}

impl Dispatch<ext::ext_data_control_source_v1::ExtDataControlSourceV1, ()> for Host {
    fn event(
        host: &mut Self,
        source: &ext::ext_data_control_source_v1::ExtDataControlSourceV1,
        event: ext::ext_data_control_source_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use ext::ext_data_control_source_v1::Event;
        match event {
            Event::Send { fd, .. } => host.send(fd),
            // Somebody else copied, or we replaced this source ourselves.
            Event::Cancelled => host.cancelled(source.id()),
            _ => {}
        }
    }
}

impl Dispatch<wlr::zwlr_data_control_device_v1::ZwlrDataControlDeviceV1, ()> for Host {
    event_created_child!(Host, wlr::zwlr_data_control_device_v1::ZwlrDataControlDeviceV1, [
        0 => (wlr::zwlr_data_control_offer_v1::ZwlrDataControlOfferV1, ()),
    ]);

    fn event(
        host: &mut Self,
        _: &wlr::zwlr_data_control_device_v1::ZwlrDataControlDeviceV1,
        event: wlr::zwlr_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use wlr::zwlr_data_control_device_v1::Event;
        match event {
            Event::DataOffer { .. } => {}
            Event::Selection { id } => host.selection(id.map(Offer::Wlr)),
            Event::PrimarySelection { id: Some(offer) } => host.discard(&Offer::Wlr(offer)),
            Event::Finished => tracing::debug!("the host took the clipboard device away"),
            _ => {}
        }
    }
}

impl Dispatch<wlr::zwlr_data_control_offer_v1::ZwlrDataControlOfferV1, ()> for Host {
    fn event(
        host: &mut Self,
        offer: &wlr::zwlr_data_control_offer_v1::ZwlrDataControlOfferV1,
        event: wlr::zwlr_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wlr::zwlr_data_control_offer_v1::Event::Offer { mime_type } = event {
            host.offers.entry(offer.id()).or_default().push(mime_type);
        }
    }
}

impl Dispatch<wlr::zwlr_data_control_source_v1::ZwlrDataControlSourceV1, ()> for Host {
    fn event(
        host: &mut Self,
        source: &wlr::zwlr_data_control_source_v1::ZwlrDataControlSourceV1,
        event: wlr::zwlr_data_control_source_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use wlr::zwlr_data_control_source_v1::Event;
        match event {
            Event::Send { fd, .. } => host.send(fd),
            Event::Cancelled => host.cancelled(source.id()),
            _ => {}
        }
    }
}
