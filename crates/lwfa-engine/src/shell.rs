//! The shell connection.
//!
//! A WebSocket server the shell connects to. The shell sends layout; the engine
//! sends window lifecycle. See `crates/lwfa-proto` for the wire format.
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

use std::cell::Cell;
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::thread;
use std::time::Duration;

use lwfa_proto::{ToEngine, ToShell};
use smithay::reexports::calloop::channel::Sender as LoopSender;

use crate::auth;

/// Where the shell connects. Localhost by design; see the security note above.
pub const DEFAULT_ADDR: &str = "127.0.0.1:9843";

/// How often the connection thread checks for outgoing messages while idle.
///
/// These are window lifecycle events, not per-frame data, so this only bounds
/// notification latency and costs almost nothing. Video will not come through
/// this socket.
const POLL_INTERVAL: Duration = Duration::from_millis(4);

/// Bound on how long a connecting client may stall the accept loop.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Close reason sent to a shell that a newer one has replaced.
///
/// The client checks for this and stops reconnecting. It has to be explicit:
/// a plain socket drop is indistinguishable from a network blip, and retrying
/// is the right response to a blip.
pub const REPLACED_REASON: &str = "replaced-by-newer-shell";

/// Bound on how long saying goodbye to a replaced shell may take.
const GOODBYE_TIMEOUT: Duration = Duration::from_millis(250);

/// What the compositor sees. Delivered on the event loop thread.
#[derive(Debug)]
pub enum ShellEvent {
    /// A shell connected. The engine replies with `Hello`.
    Connected,
    Message(ToEngine),
    Disconnected,
}

/// Something queued for the shell: a control message or a frame of pixels.
enum Outgoing {
    Control(Box<ToShell>),
    /// Already-encoded binary frame, header included.
    Frame(Vec<u8>),
}

/// A cloneable handle for queueing encoded frames.
///
/// Separate from [`ShellLink`] so the encoder thread can send frames without
/// borrowing compositor state. Everything in it is shared, so a clone talks to
/// the same connection.
#[derive(Clone)]
pub struct FrameSink {
    outgoing: Sender<Outgoing>,
    in_flight: Arc<AtomicUsize>,
    connected: Arc<AtomicBool>,
}

impl FrameSink {
    /// True when the write queue has room for another frame.
    ///
    /// Checked *before* capturing rather than after encoding, so a shell that
    /// cannot keep up costs no GPU work at all.
    pub fn can_accept_frame(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
            && self.in_flight.load(Ordering::Relaxed) < MAX_FRAMES_IN_FLIGHT
    }

    pub fn send_frame(&self, bytes: Vec<u8>) {
        if !self.connected.load(Ordering::Relaxed) {
            return;
        }
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        if self.outgoing.send(Outgoing::Frame(bytes)).is_err() {
            self.in_flight.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Handle the compositor uses to talk to whatever shell is connected.
pub struct ShellLink {
    sink: FrameSink,
}

/// How many encoded frames may be queued before capture backs off.
///
/// Without this, a shell on a slow link makes the queue grow without bound and
/// the compositor spends all its time encoding frames nobody will see. Dropping
/// frames is the correct response to a slow consumer; buffering them is not.
const MAX_FRAMES_IN_FLIGHT: usize = 4;

impl ShellLink {
    /// Start listening. Returns the link plus a calloop event source to insert.
    pub fn bind(
        addr: &str,
        token: String,
        events: LoopSender<ShellEvent>,
    ) -> std::io::Result<(Self, std::net::SocketAddr)> {
        let listener = TcpListener::bind(addr)?;
        let local = listener.local_addr()?;
        let (outgoing_tx, outgoing_rx) = channel::<Outgoing>();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let connected = Arc::new(AtomicBool::new(false));
        let thread_in_flight = Arc::clone(&in_flight);
        let thread_connected = Arc::clone(&connected);

        thread::Builder::new()
            .name("lwfa-shell".into())
            .spawn(move || {
                accept_loop(
                    listener,
                    token,
                    events,
                    outgoing_rx,
                    thread_in_flight,
                    thread_connected,
                )
            })?;

        Ok((
            Self {
                sink: FrameSink {
                    outgoing: outgoing_tx,
                    in_flight,
                    connected,
                },
            },
            local,
        ))
    }

    pub fn set_connected(&mut self, connected: bool) {
        self.sink.connected.store(connected, Ordering::Relaxed);
    }

    /// A handle the encoder thread can keep.
    pub fn sink(&self) -> FrameSink {
        self.sink.clone()
    }

    /// Queue a message for the shell. Cheap, never blocks the compositor, and
    /// silently drops when nothing is connected, which is the normal state.
    pub fn send(&self, message: ToShell) {
        if self.sink.connected.load(Ordering::Relaxed) {
            let _ = self
                .sink
                .outgoing
                .send(Outgoing::Control(Box::new(message)));
        }
    }

    pub fn can_accept_frame(&self) -> bool {
        self.sink.can_accept_frame()
    }
}

/// Accept connections and serve whichever is newest.
///
/// One thread, which owns the outgoing queue, so no lock is needed around the
/// WebSocket and no frame can be half-written.
///
/// **Newest connection wins.** The obvious loop
/// (`for stream in listener.incoming() { serve(stream) }`) serves one client to
/// completion, which means a stale or hung shell holds the slot forever and
/// every later connection sits unread in the accept backlog. That is not a
/// theoretical problem: a browser tab that never cleanly closed will lock you
/// out of your own desktop until the engine restarts. Replacing the current
/// connection instead means the client the user is actually looking at is
/// always the one being served.
fn accept_loop(
    listener: TcpListener,
    token: String,
    events: LoopSender<ShellEvent>,
    outgoing: Receiver<Outgoing>,
    in_flight: Arc<AtomicUsize>,
    connected: Arc<AtomicBool>,
) {
    if listener.set_nonblocking(true).is_err() {
        tracing::error!("could not set the shell listener non-blocking; no shell can connect");
        return;
    }

    let mut current: Option<tungstenite::WebSocket<TcpStream>> = None;

    loop {
        // Drain every pending connection, keeping only the last. Dropping the
        // previous socket closes it, which is how the old client learns it has
        // been replaced.
        loop {
            match listener.accept() {
                Ok((stream, peer)) => match handshake(stream, &token) {
                    Some(socket) => {
                        if let Some(old) = current.take() {
                            tracing::info!(
                                "a new shell connected from {peer}, replacing the old one"
                            );
                            // Deliberately no `Disconnected` here. A
                            // replacement is not a gap in shell coverage, and
                            // dropping to safe mode and straight back would
                            // resize every window twice and rebuild every
                            // encoder session for nothing.
                            say_goodbye(old);
                        } else {
                            tracing::info!("shell connected from {peer}");
                        }
                        current = Some(socket);
                        drain_stale(&outgoing, &in_flight);
                        if events.send(ShellEvent::Connected).is_err() {
                            return;
                        }
                    }
                    None => continue,
                },
                Err(err) if err.kind() == ErrorKind::WouldBlock => break,
                Err(err) => {
                    tracing::warn!("shell listener accept failed: {err}");
                    break;
                }
            }
        }

        if let Some(socket) = current.as_mut() {
            if !pump(socket, &events, &outgoing, &in_flight) {
                tracing::info!("shell disconnected");
                current = None;
                // Stop the encoder thread queueing into a dead socket
                // immediately, rather than waiting for the compositor to
                // process the event.
                connected.store(false, Ordering::Relaxed);
                let _ = events.send(ShellEvent::Disconnected);
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}

/// Complete the WebSocket handshake, then switch the socket to non-blocking.
///
/// The handshake itself needs a blocking socket, but a client that connects and
/// then says nothing would stall the whole loop, so it is bounded by a read
/// timeout rather than trusted.
fn handshake(stream: TcpStream, token: &str) -> Option<tungstenite::WebSocket<TcpStream>> {
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
    let authorized = Rc::new(Cell::new(false));
    let flag = Rc::clone(&authorized);

    let accepted = tungstenite::accept_hdr(
        stream,
        |request: &tungstenite::handshake::server::Request, response| {
            let uri = request.uri().to_string();
            let ok = auth::token_from_query(&uri).is_some_and(|t| auth::token_matches(token, t));
            flag.set(ok);
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
            if authorized.get() {
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
    Some(socket)
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
fn say_goodbye(mut socket: tungstenite::WebSocket<TcpStream>) {
    let stream = socket.get_ref();
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(GOODBYE_TIMEOUT));

    let _ = socket.close(Some(tungstenite::protocol::CloseFrame {
        code: tungstenite::protocol::frame::coding::CloseCode::Normal,
        reason: REPLACED_REASON.into(),
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

/// Discard anything queued for a previous shell.
///
/// The `Hello` sent next carries the full current state, so a backlog addressed
/// to the old client is worse than useless: it would be decoded against the new
/// client's empty world.
fn drain_stale(outgoing: &Receiver<Outgoing>, in_flight: &AtomicUsize) {
    while let Ok(stale) = outgoing.try_recv() {
        if matches!(stale, Outgoing::Frame(_)) {
            in_flight.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Move one round of messages in both directions.
///
/// Returns false when the connection is finished and should be dropped.
fn pump(
    socket: &mut tungstenite::WebSocket<TcpStream>,
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
                        if events.send(ShellEvent::Message(message)).is_err() {
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
