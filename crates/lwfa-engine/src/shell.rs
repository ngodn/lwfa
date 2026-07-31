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
//! Binds to localhost only. There is no authentication, so this must not be
//! exposed off the machine as it stands: anything that can reach the port can
//! move windows and spawn processes. Auth and TLS are milestone 7, and are
//! listed as a hard requirement in docs/architecture.md section 6.

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::thread;
use std::time::Duration;

use lwfa_proto::{ToEngine, ToShell};
use smithay::reexports::calloop::channel::Sender as LoopSender;

/// Where the shell connects. Localhost by design; see the security note above.
pub const DEFAULT_ADDR: &str = "127.0.0.1:9843";

/// How often the connection thread checks for outgoing messages while idle.
///
/// These are window lifecycle events, not per-frame data, so this only bounds
/// notification latency and costs almost nothing. Video will not come through
/// this socket.
const POLL_INTERVAL: Duration = Duration::from_millis(4);

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

/// Handle the compositor uses to talk to whatever shell is connected.
pub struct ShellLink {
    outgoing: Sender<Outgoing>,
    connected: bool,
    /// Frames queued but not yet written, so the compositor can stop capturing
    /// when the shell cannot keep up.
    in_flight: Arc<AtomicUsize>,
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
        events: LoopSender<ShellEvent>,
    ) -> std::io::Result<(Self, std::net::SocketAddr)> {
        let listener = TcpListener::bind(addr)?;
        let local = listener.local_addr()?;
        let (outgoing_tx, outgoing_rx) = channel::<Outgoing>();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let thread_in_flight = Arc::clone(&in_flight);

        thread::Builder::new()
            .name("lwfa-shell".into())
            .spawn(move || accept_loop(listener, events, outgoing_rx, thread_in_flight))?;

        Ok((
            Self {
                outgoing: outgoing_tx,
                connected: false,
                in_flight,
            },
            local,
        ))
    }

    pub fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
    }

    /// Queue a message for the shell. Cheap, never blocks the compositor, and
    /// silently drops when nothing is connected, which is the normal state.
    pub fn send(&self, message: ToShell) {
        if self.connected {
            let _ = self.outgoing.send(Outgoing::Control(Box::new(message)));
        }
    }

    /// True when the write queue has room for another frame.
    ///
    /// Checked *before* capturing rather than after encoding, so a shell that
    /// cannot keep up costs no GPU read-back at all.
    pub fn can_accept_frame(&self) -> bool {
        self.connected && self.in_flight.load(Ordering::Relaxed) < MAX_FRAMES_IN_FLIGHT
    }

    /// Queue an encoded frame.
    pub fn send_frame(&self, bytes: Vec<u8>) {
        if !self.connected {
            return;
        }
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        if self.outgoing.send(Outgoing::Frame(bytes)).is_err() {
            self.in_flight.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

fn accept_loop(
    listener: TcpListener,
    events: LoopSender<ShellEvent>,
    outgoing: Receiver<Outgoing>,
    in_flight: Arc<AtomicUsize>,
) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                tracing::info!("shell connected from {:?}", stream.peer_addr().ok());
                serve(stream, &events, &outgoing, &in_flight);
                tracing::info!("shell disconnected");
                let _ = events.send(ShellEvent::Disconnected);
            }
            Err(err) => {
                tracing::warn!("shell listener accept failed: {err}");
            }
        }
    }
}

fn serve(
    stream: TcpStream,
    events: &LoopSender<ShellEvent>,
    outgoing: &Receiver<Outgoing>,
    in_flight: &AtomicUsize,
) {
    // Nagle would add up to 40ms to a small layout message, which is a visible
    // hitch on something the user just triggered.
    let _ = stream.set_nodelay(true);

    let mut socket = match tungstenite::accept(stream) {
        Ok(socket) => socket,
        Err(err) => {
            tracing::warn!("shell websocket handshake failed: {err}");
            return;
        }
    };

    if socket.get_ref().set_nonblocking(true).is_err() {
        tracing::warn!("could not set the shell socket non-blocking");
        return;
    }

    // Drain anything queued while no shell was connected, so a reconnecting
    // shell does not receive a backlog addressed to its predecessor. The
    // `Hello` the engine sends next carries the full current state anyway.
    while let Ok(stale) = outgoing.try_recv() {
        if matches!(stale, Outgoing::Frame(_)) {
            in_flight.fetch_sub(1, Ordering::Relaxed);
        }
    }

    if events.send(ShellEvent::Connected).is_err() {
        return;
    }

    loop {
        // Reads first, so a burst of shell input is not delayed behind the
        // poll interval.
        loop {
            match socket.read() {
                Ok(tungstenite::Message::Text(text)) => {
                    match serde_json::from_str::<ToEngine>(&text) {
                        Ok(message) => {
                            if events.send(ShellEvent::Message(message)).is_err() {
                                return;
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
                Ok(tungstenite::Message::Close(_)) => return,
                Ok(_) => {}
                Err(tungstenite::Error::Io(err)) if err.kind() == ErrorKind::WouldBlock => break,
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return;
                }
                Err(err) => {
                    tracing::warn!("shell socket read failed: {err}");
                    return;
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
                            tungstenite::Error::Io(ref io)
                                if io.kind() == ErrorKind::WouldBlock => {}
                            _ => {
                                tracing::warn!("shell socket write failed: {err}");
                                return;
                            }
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                // The compositor is gone.
                Err(TryRecvError::Disconnected) => return,
            }
        }

        // Flush anything tungstenite buffered because the socket was full.
        match socket.flush() {
            Ok(()) => {}
            Err(tungstenite::Error::Io(ref io)) if io.kind() == ErrorKind::WouldBlock => {}
            Err(err) => {
                tracing::warn!("shell socket flush failed: {err}");
                return;
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}
