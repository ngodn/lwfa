//! The shell connection.
//!
//! A WebSocket server the shell connects to. The shell sends layout; the engine
//! sends window lifecycle. See `crates/lwfa-proto` for the wire format.
//!
//! # Several connections at once
//!
//! A session is one desktop that any number of devices can be looking at: the
//! machine itself, a tablet on the sofa, a phone. Each connection gets its own
//! outbound queue and its own backpressure, so a phone on bad wifi slows down
//! only itself, and each asks for the windows it can actually see rather than
//! sharing one global set.
//!
//! What they cannot each have is their own arrangement, because a window has
//! exactly one size. So one connection is *primary* and decides layout, and the
//! rest are told what it decided. Which one that is can be handed over at any
//! time; see `ToShell::Role`.
//!
//! # Threading
//!
//! Smithay's event loop is calloop, which is single-threaded and callback
//! driven, and `tungstenite` is blocking. Rather than drag in an async runtime
//! for one socket, the server runs on its own thread and bridges into calloop
//! with `calloop::channel`. The compositor never blocks on the shell.
//!
//! The connection thread owns the socket and polls it non-blocking, draining
//! the outgoing queue between reads. One thread, no lock around the WebSocket,
//! no half-written frames.
//!
//! # Security
//!
//! The protocol can inject keystrokes and spawn processes, so anything that can
//! open this socket controls the session. A shared token is therefore required
//! on every connection, whether the socket is on loopback or not. See `auth.rs`.
//!
//! There is still **no TLS**. The token and everything after it cross the
//! network in the clear, so this is safe on a home LAN and not safe on an
//! untrusted one. Tunnel it until TLS exists.

use std::cell::RefCell;
use std::collections::HashSet;
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use lwfa_proto::{SessionId, ToEngine, ToShell, WindowId};
use smithay::reexports::calloop::channel::Sender as LoopSender;

use crate::auth;

// The listen address is `[net].shell_addr` in `configs/defaults.toml`, and
// `LWFA_SHELL_ADDR` overrides it. lwfa owns the 6733+ block: 6733 serves the
// shell page and 6734 is this socket. Loopback by default, so exposing it to
// the network is always a deliberate edit rather than a side effect of
// installing.
/// How often the connection thread checks for outgoing messages while idle.
///
/// These are window lifecycle events, not per-frame data, so this only bounds
/// notification latency and costs almost nothing. Video will not come through
/// this socket.
const POLL_INTERVAL: Duration = Duration::from_millis(4);

/// Bound on how long a connecting client may stall the accept loop.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Close reason sent to a shell the engine deliberately dropped.
///
/// Only used when `MAX_SESSIONS` is reached and the oldest connection is
/// evicted. The client checks for this and stops reconnecting, which it has to
/// be told explicitly: a plain socket drop is indistinguishable from a network
/// blip, and retrying is the right response to a blip.
pub const REPLACED_REASON: &str = "replaced-by-newer-shell";

/// Close reason for a socket the *same* client superseded by reconnecting.
///
/// Deliberately different from [`REPLACED_REASON`], because the client's right
/// response is the opposite: being replaced by another device means stop
/// reconnecting, being superseded by your own newer socket means carry on. A
/// reconnect that raced its predecessor was being told "you were replaced",
/// and the shell stopped trying and sat on "connecting" forever.
pub const SUPERSEDED_REASON: &str = "superseded-by-reconnect";

/// Bound on how long saying goodbye to a replaced shell may take.
const GOODBYE_TIMEOUT: Duration = Duration::from_millis(250);

/// What the compositor sees. Delivered on the event loop thread.
///
/// Every variant names the session it came from. With more than one connection
/// there is no such thing as "the shell said": permissions, streams and the
/// right to drive layout are all per connection, so a message with no sender
/// could not be checked against anything.
#[derive(Debug)]
pub enum ShellEvent {
    /// A shell connected. The engine replies with `Hello`.
    ///
    /// Carries who it turned out to be, because authentication happens on the
    /// accept thread during the handshake and the compositor needs the answer
    /// to decide what the session may do.
    Connected {
        session: SessionId,
        permissions: lwfa_proto::Permissions,
        account: String,
        /// Best-effort, from the `User-Agent` header. Only ever shown to the
        /// user so they can tell their own devices apart.
        device: String,
        /// The browser's own stable id, or empty if it did not send one.
        ///
        /// Not a security boundary and not trusted for anything: the token is
        /// what authenticates. This exists so a *reconnection* can be told
        /// apart from a second device, because a page refresh otherwise leaves
        /// the previous session lingering until its socket times out, and both
        /// are then counted as live viewers.
        client: String,
    },
    Message(SessionId, ToEngine),
    Disconnected(SessionId),
}

/// Something queued for the shell: a control message or a frame of pixels.
enum Outgoing {
    Control(Box<ToShell>),
    /// Already-encoded binary frame, header included.
    Frame(Vec<u8>),
}

/// One connected client's outbound queue.
///
/// Owned by the registry and shared with the connection thread. Everything on
/// it is atomic or behind a small lock, because three threads touch it: the
/// accept thread writes to the socket, the compositor queues control messages,
/// and the encoder queues frames.
struct Slot {
    id: SessionId,
    outgoing: Sender<Outgoing>,
    /// Frames queued but not yet written. Per client, so a slow device applies
    /// backpressure to itself and not to everyone else.
    in_flight: Arc<AtomicUsize>,
    connected: Arc<AtomicBool>,
    /// Windows this client wants pixels for.
    ///
    /// Read on the encoder thread, to decide who a finished frame goes to.
    /// Written on the compositor thread when a client sends `SetStreams`.
    streams: Mutex<HashSet<WindowId>>,
    /// Whether this client has asked to hear the machine.
    ///
    /// Read on the capture thread, written on the compositor thread, same as
    /// `streams`.
    audio: AtomicBool,
    /// Whether the eviction is this client reconnecting rather than a kick.
    superseded: Arc<AtomicBool>,
    /// Set when the owner has asked for this connection to go away.
    ///
    /// A flag rather than a direct close, because the socket belongs to the
    /// accept thread and nothing else may touch it. That thread notices on its
    /// next pass, which is within a poll interval.
    evict: Arc<AtomicBool>,
}

impl Slot {
    fn alive(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    fn has_room(&self, max_in_flight: usize) -> bool {
        self.alive() && self.in_flight.load(Ordering::Relaxed) < max_in_flight
    }
}

/// Every connection, shared by all three threads.
pub struct Clients {
    slots: Mutex<Vec<Arc<Slot>>>,
    /// `[stream].max_frames_in_flight`, per client.
    max_in_flight: usize,
    next_id: AtomicU64,
}

impl Clients {
    fn new(max_in_flight: usize) -> Self {
        Self {
            slots: Mutex::new(Vec::new()),
            max_in_flight: max_in_flight.max(1),
            // Ids start at 1 so 0 can mean "nobody" in logs and tests.
            next_id: AtomicU64::new(1),
        }
    }

    fn allocate(&self) -> SessionId {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn add(&self, slot: Arc<Slot>) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.push(slot);
        }
    }

    fn remove(&self, id: SessionId) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.retain(|slot| slot.id != id);
        }
    }

    fn with<T>(&self, id: SessionId, f: impl FnOnce(&Slot) -> T) -> Option<T> {
        let slots = self.slots.lock().ok()?;
        slots.iter().find(|slot| slot.id == id).map(|s| f(s))
    }

    /// Which windows anyone is asking for. The union bounds what is captured.
    pub fn streamed_windows(&self) -> HashSet<WindowId> {
        let Ok(slots) = self.slots.lock() else {
            return HashSet::new();
        };
        let mut all = HashSet::new();
        for slot in slots.iter().filter(|s| s.alive()) {
            if let Ok(streams) = slot.streams.lock() {
                all.extend(streams.iter().copied());
            }
        }
        all
    }

    /// Record whether one client wants to hear the machine.
    pub fn set_audio(&self, id: SessionId, enabled: bool) {
        self.with(id, |slot| slot.audio.store(enabled, Ordering::Relaxed));
    }

    /// Record what one client wants. Total, matching `SetStreams`.
    pub fn set_streams(&self, id: SessionId, windows: HashSet<WindowId>) {
        self.with(id, |slot| {
            if let Ok(mut streams) = slot.streams.lock() {
                *streams = windows;
            }
        });
    }

    /// Queue a control message for everyone.
    pub fn broadcast(&self, message: ToShell) {
        let Ok(slots) = self.slots.lock() else { return };
        for slot in slots.iter().filter(|s| s.alive()) {
            let _ = slot
                .outgoing
                .send(Outgoing::Control(Box::new(message.clone())));
        }
    }

    /// Ask the accept thread to disconnect one client.
    ///
    /// `superseded` distinguishes "this device reconnected" from "the owner
    /// kicked you", which the client must react to differently.
    pub fn evict(&self, id: SessionId, superseded: bool) {
        self.with(id, |slot| {
            slot.superseded.store(superseded, Ordering::Relaxed);
            slot.evict.store(true, Ordering::Relaxed);
            // Stop feeding it immediately rather than waiting for the accept
            // thread to notice: the point of kicking someone is that they stop
            // seeing your screen now.
            slot.connected.store(false, Ordering::Relaxed);
        });
    }

    /// Queue a control message for one connection.
    pub fn send_to(&self, id: SessionId, message: ToShell) {
        self.with(id, |slot| {
            if slot.alive() {
                let _ = slot.outgoing.send(Outgoing::Control(Box::new(message)));
            }
        });
    }
}

/// A cloneable handle for queueing encoded frames.
///
/// Separate from [`ShellLink`] so the encoder thread can send frames without
/// borrowing compositor state.
#[derive(Clone)]
pub struct FrameSink {
    clients: Arc<Clients>,
}

impl FrameSink {
    /// True when at least one client has room for another frame.
    ///
    /// Checked *before* capturing rather than after encoding, so a client that
    /// cannot keep up costs no GPU work at all. It is deliberately "any" and
    /// not "all": one device on bad wifi must not stop the others being fed,
    /// and the fan-out below skips whoever is behind.
    pub fn can_accept_frame(&self) -> bool {
        let Ok(slots) = self.clients.slots.lock() else {
            return false;
        };
        slots
            .iter()
            .any(|slot| slot.has_room(self.clients.max_in_flight))
    }

    /// Hand a chunk of audio to everyone listening.
    ///
    /// Shares the video queue and its bound deliberately. Audio and pixels
    /// compete for the same socket, and a client so far behind that frames are
    /// being dropped is one where continuing to push audio would only widen the
    /// gap between what it hears and what it sees. Silence that recovers beats
    /// audio that drifts further out of sync every second.
    pub fn send_audio(&self, chunk: Vec<u8>) {
        let Ok(slots) = self.clients.slots.lock() else {
            return;
        };
        let max = self.clients.max_in_flight;
        for slot in slots.iter() {
            if !slot.audio.load(Ordering::Relaxed) || !slot.has_room(max) {
                continue;
            }
            slot.in_flight.fetch_add(1, Ordering::Relaxed);
            if slot.outgoing.send(Outgoing::Frame(chunk.clone())).is_err() {
                slot.in_flight.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }

    /// Hand a finished frame to everyone who asked for that window.
    ///
    /// The bytes are cloned per recipient. That is a real cost with several
    /// devices watching, and it is still the right trade: the alternative is
    /// encoding the same window once per client, which costs an NVENC session
    /// each and there are only eight.
    pub fn send_frame(&self, window: WindowId, bytes: Vec<u8>) {
        let Ok(slots) = self.clients.slots.lock() else {
            return;
        };
        let max = self.clients.max_in_flight;
        for slot in slots.iter() {
            if !slot.has_room(max) {
                continue;
            }
            let wanted = slot
                .streams
                .lock()
                .map(|streams| streams.contains(&window))
                .unwrap_or(false);
            if !wanted {
                continue;
            }
            slot.in_flight.fetch_add(1, Ordering::Relaxed);
            if slot.outgoing.send(Outgoing::Frame(bytes.clone())).is_err() {
                slot.in_flight.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }
}

/// The shared password, readable by the accept thread and replaceable by the
/// compositor when `.env` changes. See `Lwfa::watch_dotenv`.
pub type SharedToken = Arc<Mutex<String>>;

/// Handle the compositor uses to talk to every connected shell.
pub struct ShellLink {
    clients: Arc<Clients>,
}

// `[stream].max_frames_in_flight` bounds each client's write queue. Without a
// bound, a shell on a slow link makes it grow forever and the compositor spends
// all its time encoding frames nobody will see. Dropping frames is the correct
// response to a slow consumer; buffering them is not.

impl ShellLink {
    /// Start listening. Returns the link plus a calloop event source to insert.
    pub fn bind(
        addr: &str,
        token: String,
        accounts: Option<Arc<Mutex<crate::accounts::Accounts>>>,
        events: LoopSender<ShellEvent>,
        max_in_flight: usize,
    ) -> std::io::Result<(Self, std::net::SocketAddr, SharedToken)> {
        let listener = TcpListener::bind(addr)?;
        let local = listener.local_addr()?;
        // Shared rather than moved, so editing AUTH_PASS in .env takes effect
        // on the next connection instead of needing a restart. Read once per
        // handshake, which is far too rare for the lock to matter.
        let token = Arc::new(Mutex::new(token));
        let thread_token = Arc::clone(&token);
        let clients = Arc::new(Clients::new(max_in_flight));
        let thread_clients = Arc::clone(&clients);

        thread::Builder::new()
            .name("lwfa-shell".into())
            .spawn(move || accept_loop(listener, thread_token, accounts, events, thread_clients))?;

        Ok((Self { clients }, local, token))
    }

    /// A handle the encoder thread can keep.
    pub fn sink(&self) -> FrameSink {
        FrameSink {
            clients: Arc::clone(&self.clients),
        }
    }

    /// The registry, for the compositor's own bookkeeping.
    pub fn clients(&self) -> &Clients {
        &self.clients
    }

    /// Queue a message for every connected shell.
    pub fn broadcast(&self, message: ToShell) {
        self.clients.broadcast(message);
    }

    /// Queue a message for one connection.
    pub fn send_to(&self, session: SessionId, message: ToShell) {
        self.clients.send_to(session, message);
    }

    /// Disconnect one connection. See [`Clients::evict`].
    pub fn evict(&self, session: SessionId, superseded: bool) {
        self.clients.evict(session, superseded);
    }

    pub fn can_accept_frame(&self) -> bool {
        self.sink().can_accept_frame()
    }
}

/// How many shells may be connected at once.
///
/// Not a resource limit so much as a sanity limit. Every connection costs a
/// thread-visible queue and a copy of every frame it asks for, and a session
/// with more than a handful of devices watching is a misconfiguration or a
/// client stuck in a reconnect loop, not a use case. When it is reached the
/// *oldest* connection is dropped rather than the newest refused: refusing the
/// newest would mean a stale tab locking you out of your own desktop, which is
/// exactly the failure this used to have when only one connection was allowed.
const MAX_SESSIONS: usize = 8;

/// Accept connections and serve all of them.
///
/// One thread owning every socket, so no lock is needed around a WebSocket and
/// no frame can be half-written. The sockets are non-blocking and polled in
/// turn, which is fine for a handful of connections carrying control messages
/// and pre-encoded frames; it would not be fine for hundreds, and there will
/// never be hundreds.
fn accept_loop(
    listener: TcpListener,
    token: SharedToken,
    accounts: Option<Arc<Mutex<crate::accounts::Accounts>>>,
    events: LoopSender<ShellEvent>,
    clients: Arc<Clients>,
) {
    if listener.set_nonblocking(true).is_err() {
        tracing::error!("could not set the shell listener non-blocking; no shell can connect");
        return;
    }

    /// A connection this thread is serving.
    struct Live {
        id: SessionId,
        socket: tungstenite::WebSocket<TcpStream>,
        outgoing: Receiver<Outgoing>,
        in_flight: Arc<AtomicUsize>,
        connected: Arc<AtomicBool>,
        evict: Arc<AtomicBool>,
        superseded: Arc<AtomicBool>,
    }

    let mut live: Vec<Live> = Vec::new();

    loop {
        loop {
            match listener.accept() {
                Ok((stream, peer)) => {
                    let Some((socket, permissions, account, device, client)) =
                        handshake(stream, &token.lock().unwrap().clone(), accounts.as_deref())
                    else {
                        continue;
                    };

                    // Make room before adding, so the cap is a real bound.
                    while live.len() >= MAX_SESSIONS {
                        let evicted = live.remove(0);
                        tracing::info!(
                            "session limit reached; dropping the oldest shell ({})",
                            evicted.id
                        );
                        evicted.connected.store(false, Ordering::Relaxed);
                        clients.remove(evicted.id);
                        say_goodbye(evicted.socket, false);
                        let _ = events.send(ShellEvent::Disconnected(evicted.id));
                    }

                    let id = clients.allocate();
                    let (outgoing_tx, outgoing_rx) = channel::<Outgoing>();
                    let in_flight = Arc::new(AtomicUsize::new(0));
                    let connected = Arc::new(AtomicBool::new(true));
                    let evict = Arc::new(AtomicBool::new(false));
                    let superseded = Arc::new(AtomicBool::new(false));
                    clients.add(Arc::new(Slot {
                        id,
                        outgoing: outgoing_tx,
                        in_flight: Arc::clone(&in_flight),
                        connected: Arc::clone(&connected),
                        streams: Mutex::new(HashSet::new()),
                        audio: AtomicBool::new(false),
                        superseded: Arc::clone(&superseded),
                        evict: Arc::clone(&evict),
                    }));
                    live.push(Live {
                        id,
                        socket,
                        outgoing: outgoing_rx,
                        in_flight,
                        connected,
                        evict,
                        superseded: Arc::clone(&superseded),
                    });

                    tracing::info!(
                        "shell {id} connected from {peer} as {account} ({:?}, {device}); \
                         {} connected",
                        permissions.mode,
                        live.len()
                    );
                    if events
                        .send(ShellEvent::Connected {
                            session: id,
                            permissions,
                            account,
                            device,
                            client,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => break,
                Err(err) => {
                    tracing::warn!("shell listener accept failed: {err}");
                    break;
                }
            }
        }

        // Indices first, then removal back to front, so a finished connection
        // can be moved out whole. `retain_mut` only lends `&mut`, and closing
        // an evicted socket politely needs to own it.
        let mut finished: Vec<usize> = Vec::new();
        for (index, client) in live.iter_mut().enumerate() {
            let kicked = client.evict.load(Ordering::Relaxed);
            let alive = !kicked
                && pump(
                    &mut client.socket,
                    client.id,
                    &events,
                    &client.outgoing,
                    &client.in_flight,
                );
            if !alive {
                finished.push(index);
            }
        }

        for index in finished.into_iter().rev() {
            let client = live.remove(index);
            client.connected.store(false, Ordering::Relaxed);
            clients.remove(client.id);
            if client.evict.load(Ordering::Relaxed) {
                let superseded = client.superseded.load(Ordering::Relaxed);
                if superseded {
                    tracing::debug!("shell {} superseded by its own reconnect", client.id);
                } else {
                    tracing::info!("shell {} was disconnected by the owner", client.id);
                }
                // Told *why*, because the two demand opposite responses: a
                // client that was replaced must stop reconnecting, and one
                // that superseded itself must carry on with its newer socket.
                // A bare drop is indistinguishable from a network blip and
                // would come straight back.
                say_goodbye(client.socket, superseded);
            } else {
                tracing::info!("shell {} disconnected", client.id);
            }
            let _ = events.send(ShellEvent::Disconnected(client.id));
        }

        thread::sleep(POLL_INTERVAL);
    }
}

/// Complete the WebSocket handshake, then switch the socket to non-blocking.
///
/// The handshake itself needs a blocking socket, but a client that connects and
/// then says nothing would stall the whole loop, so it is bounded by a read
/// timeout rather than trusted.
/// The result of a successful handshake.
///
/// The socket, what the far end may do, the account it authenticated as, a
/// description of the device, and the browser's own stable id.
type Accepted = (
    tungstenite::WebSocket<TcpStream>,
    lwfa_proto::Permissions,
    String,
    String,
    String,
);

fn handshake(
    stream: TcpStream,
    token: &str,
    accounts: Option<&Mutex<crate::accounts::Accounts>>,
) -> Option<Accepted> {
    // Nagle would add up to 40ms to a small layout message, which is a visible
    // hitch on something the user just triggered.
    let _ = stream.set_nodelay(true);
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));

    // The token rides in the query string because a browser cannot set headers
    // on a WebSocket handshake. Rejecting during the handshake means an
    // unauthenticated peer never reaches the protocol at all.
    // A shared cell rather than a captured `&mut`: `accept_hdr`'s error
    // variant holds the callback, so a borrow would outlive the call and the
    // result could not be inspected afterwards.
    // Also carries *who*, not just whether: the same query parameter can be the
    // owner's `AUTH_PASS` or any account's password, and the two grant very
    // different things.
    let identity: Rc<RefCell<Option<crate::accounts::Identity>>> = Rc::new(RefCell::new(None));
    let found = Rc::clone(&identity);
    // Captured in the same callback, because the request headers are not
    // available anywhere else and the user needs some way to tell "the iPad"
    // from "the laptop" in a list of connected sessions.
    let agent: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let seen_agent = Rc::clone(&agent);
    // The browser's own id, so a reconnection can be recognised as one.
    let client_id: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let seen_client = Rc::clone(&client_id);

    let accepted = tungstenite::accept_hdr(
        stream,
        |request: &tungstenite::handshake::server::Request, response| {
            let uri = request.uri().to_string();
            // The client's own answer first, because the user agent cannot be
            // trusted to know. An iPad running Safari reports itself as a
            // Macintosh and says nothing about being an iPad anywhere in the
            // string; the only reliable signal is client-side, so the shell
            // works it out and sends it. Falling back to the header keeps a
            // plain `websocat` session from showing up as nothing at all.
            *seen_client.borrow_mut() = auth::param_from_query(&uri, "client")
                .map(|claimed| sanitise_device(&claimed))
                .unwrap_or_default();
            *seen_agent.borrow_mut() = auth::param_from_query(&uri, "device")
                .map(|claimed| sanitise_device(&claimed))
                .filter(|d| !d.is_empty())
                .or_else(|| {
                    request
                        .headers()
                        .get("user-agent")
                        .and_then(|value| value.to_str().ok())
                        .map(describe_device)
                })
                .unwrap_or_else(|| "Unknown device".to_string());
            let presented = auth::token_from_query(&uri);
            let who = presented.and_then(|presented| {
                // The owner's password first, so the bootstrap credential keeps
                // working even if an account is created with the same one.
                if auth::token_matches(token, &presented) {
                    return Some(crate::accounts::Identity::Owner);
                }
                accounts
                    .and_then(|db| db.lock().ok()?.authenticate(&presented))
                    .map(crate::accounts::Identity::User)
            });
            let ok = who.is_some();
            *found.borrow_mut() = who;
            if ok {
                Ok(response)
            } else {
                Err(tungstenite::http::Response::builder()
                    .status(tungstenite::http::StatusCode::UNAUTHORIZED)
                    .body(Some("missing or invalid token".to_string()))
                    .expect("static response should build"))
            }
        },
    );

    let socket = match accepted {
        Ok(socket) => socket,
        Err(err) => {
            if identity.borrow().is_some() {
                tracing::warn!("shell websocket handshake failed: {err}");
            } else {
                // Expected whenever someone opens the port without the token.
                // Logged so a genuine misconfiguration is visible, but at debug
                // so a scanner cannot flood the log.
                tracing::debug!("rejected an unauthenticated shell connection");
            }
            return None;
        }
    };

    if socket.get_ref().set_read_timeout(None).is_err()
        || socket.get_ref().set_nonblocking(true).is_err()
    {
        tracing::warn!("could not set the shell socket non-blocking");
        return None;
    }

    // The callback ran and said yes, so this is populated. If it somehow is
    // not, refusing beats guessing at permissions.
    let who = identity.borrow_mut().take()?;
    let device = agent.borrow().clone();
    let client = client_id.borrow().clone();
    Some((
        socket,
        who.permissions(),
        who.name().to_string(),
        device,
        client,
    ))
}

/// A short, human name for a device, from its user agent.
///
/// Deliberately crude. This is not analytics and nothing depends on it being
/// right; it exists so a person looking at a list of their own connected
/// devices can tell which line is the tablet. Anything unrecognised says so
/// rather than guessing.
/// Trim a client-supplied device name to something safe to show.
///
/// It is displayed in a list next to accounts and permissions, so it is
/// attacker-controlled text in a security-relevant place. Bounded in length and
/// stripped of control characters so it cannot forge a second row, blow up the
/// layout, or hide itself.
fn sanitise_device(claimed: &str) -> String {
    claimed
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect::<String>()
        .trim()
        .to_string()
}

fn describe_device(agent: &str) -> String {
    // Order matters: an iPad's user agent also says "Macintosh" in desktop
    // mode, and every Android one also says "Linux".
    const KNOWN: &[(&str, &str)] = &[
        ("iPad", "iPad"),
        ("iPhone", "iPhone"),
        ("Android", "Android"),
        ("CrOS", "Chromebook"),
        ("Macintosh", "Mac"),
        ("Windows", "Windows PC"),
        ("Linux", "Linux"),
    ];
    for (needle, name) in KNOWN {
        if agent.contains(needle) {
            return (*name).to_string();
        }
    }
    "Unknown device".to_string()
}

/// Close a replaced connection, making sure the reason actually gets sent.
///
/// `close()` only *queues* the close frame, and on a non-blocking socket the
/// following flush returns `WouldBlock` and the frame is lost when the socket
/// drops. The old client then sees a bare TCP reset, cannot tell it apart from
/// a network blip, and reconnects, which replaces the new shell and starts the
/// whole cycle again.
///
/// So the socket goes briefly back to blocking, with a write timeout so a dead
/// peer cannot stall the accept loop.
fn say_goodbye(mut socket: tungstenite::WebSocket<TcpStream>, superseded: bool) {
    let stream = socket.get_ref();
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(GOODBYE_TIMEOUT));

    let _ = socket.close(Some(tungstenite::protocol::CloseFrame {
        code: tungstenite::protocol::frame::coding::CloseCode::Normal,
        reason: if superseded {
            SUPERSEDED_REASON.into()
        } else {
            REPLACED_REASON.into()
        },
    }));
    // close() queues; the write only happens on flush, and tungstenite may
    // need more than one to drain.
    for _ in 0..3 {
        match socket.flush() {
            Ok(()) => break,
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => break,
            Err(_) => continue,
        }
    }
}

/// Move one round of messages in both directions.
///
/// Returns false when the connection is finished and should be dropped.
fn pump(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    session: SessionId,
    events: &LoopSender<ShellEvent>,
    outgoing: &Receiver<Outgoing>,
    in_flight: &AtomicUsize,
) -> bool {
    // Reads first, so a burst of shell input is not delayed behind the poll
    // interval.
    loop {
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                match serde_json::from_str::<ToEngine>(&text) {
                    Ok(message) => {
                        if events.send(ShellEvent::Message(session, message)).is_err() {
                            return false;
                        }
                    }
                    Err(err) => {
                        // Report rather than drop. A shell sending something
                        // the engine cannot parse is a bug worth surfacing,
                        // not something to fail silently on.
                        tracing::warn!("undecodable message from shell: {err}; raw: {text}");
                    }
                }
            }
            Ok(tungstenite::Message::Close(_)) => return false,
            Ok(_) => {}
            Err(tungstenite::Error::Io(err)) if err.kind() == ErrorKind::WouldBlock => break,
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return false;
            }
            Err(err) => {
                tracing::warn!("shell socket read failed: {err}");
                return false;
            }
        }
    }

    loop {
        match outgoing.try_recv() {
            Ok(outbound) => {
                let frame = match outbound {
                    Outgoing::Control(message) => match serde_json::to_string(&message) {
                        Ok(json) => tungstenite::Message::Text(json.into()),
                        Err(err) => {
                            tracing::error!("could not serialize {message:?}: {err}");
                            continue;
                        }
                    },
                    Outgoing::Frame(bytes) => {
                        in_flight.fetch_sub(1, Ordering::Relaxed);
                        tungstenite::Message::Binary(bytes.into())
                    }
                };
                if let Err(err) = socket.send(frame) {
                    match err {
                        tungstenite::Error::Io(ref io) if io.kind() == ErrorKind::WouldBlock => {}
                        _ => {
                            tracing::warn!("shell socket write failed: {err}");
                            return false;
                        }
                    }
                }
            }
            Err(TryRecvError::Empty) => break,
            // The compositor is gone.
            Err(TryRecvError::Disconnected) => return false,
        }
    }

    match socket.flush() {
        Ok(()) => true,
        Err(tungstenite::Error::Io(ref io)) if io.kind() == ErrorKind::WouldBlock => true,
        Err(err) => {
            tracing::warn!("shell socket flush failed: {err}");
            false
        }
    }
}
