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
use std::os::fd::{AsFd, OwnedFd};
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
/// The connection thread's poll backstop.
///
/// The thread sleeps in `poll(2)` on every socket plus an eventfd the
/// compositor rings whenever it queues something, so real traffic wakes it
/// immediately. It used to spin on a 4ms sleep instead, which cost 250
/// wakeups a second while idle and up to 4ms of queue latency on every
/// encoded frame. The backstop only bounds how long a missed edge case could
/// sit, and none is known.
const POLL_BACKSTOP: rustix::event::Timespec = rustix::event::Timespec {
    tv_sec: 0,
    tv_nsec: 500_000_000,
};

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
    /// A file finished arriving on a dialog's upload channel. Not from a
    /// session at all: upload connections authenticate with a per-dialog
    /// ticket and never become sessions. See `upload.rs`.
    Uploaded(crate::upload::Finished),
}

/// Something queued for the shell: a control message or a frame of pixels.
enum Outgoing {
    /// Serialized once by whoever queues it; a broadcast to five devices
    /// shares one buffer five ways instead of serializing five times.
    Control(tungstenite::Utf8Bytes),
    /// An encoded video frame, header included. `Bytes`, so the fan-out
    /// to several watching devices clones a reference count, not megabytes.
    Frame(tungstenite::Bytes),
    /// A chunk of audio. Separate from [`Outgoing::Frame`] because the two
    /// are accounted separately; see [`Slot::audio_in_flight`].
    Audio(tungstenite::Bytes),
}

/// Serialize a control message for the wire.
fn control(message: &ToShell) -> Option<tungstenite::Utf8Bytes> {
    match serde_json::to_string(message) {
        Ok(json) => Some(json.into()),
        Err(err) => {
            tracing::error!("could not serialize {message:?}: {err}");
            None
        }
    }
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
    /// Video frames queued or written but not yet accepted by the socket.
    ///
    /// Per client, so a slow device applies backpressure to itself and not to
    /// everyone else. A frame counts until the connection thread's flush
    /// succeeds, not merely until it is dequeued: bytes sitting in the
    /// WebSocket's write buffer are still latency the viewer will feel, and
    /// they are also the only honest signal of how the network is coping,
    /// which is exactly what the bitrate controller adapts to.
    in_flight: Arc<AtomicUsize>,
    /// Audio chunks in the same position. Counted apart from video because
    /// the two must not starve each other: fifty small audio chunks a second
    /// were able to occupy every video slot, which showed up as "the audio is
    /// perfect and the picture is bad", the exact opposite of the intent.
    audio_in_flight: Arc<AtomicUsize>,
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
    /// Whether this client can decode Opus, from its `SetAudio`.
    ///
    /// Per client rather than negotiated across all of them, because one
    /// browser without an `AudioDecoder` used to drag every other device onto
    /// raw PCM at 1.5 Mbit/s. Each client now gets the best format it can
    /// take; see [`FrameSink::send_audio`].
    opus: AtomicBool,
    /// How far this client's RTT currently sits above its own baseline, in
    /// microseconds, or [`RTT_UNMEASURED`] before the first pong.
    ///
    /// Written by the connection thread from ping/pong timing, read by the
    /// compositor as the congestion signal. Excess over baseline rather than
    /// the raw RTT, so a client on a naturally slow path (a relay, another
    /// continent) is not read as permanently congested.
    rtt_excess: Arc<AtomicU64>,
    /// Whether the eviction is this client reconnecting rather than a kick.
    superseded: Arc<AtomicBool>,
    /// Set when the owner has asked for this connection to go away.
    ///
    /// A flag rather than a direct close, because the socket belongs to the
    /// accept thread and nothing else may touch it. That thread notices on its
    /// next pass, which is within a poll interval.
    evict: Arc<AtomicBool>,
}

/// How many audio chunks may be unacknowledged per client.
///
/// Three 20ms chunks is 60ms of sound. A client further behind than that is
/// better served by a moment of silence that recovers than by audio drifting
/// ever further from the picture.
const MAX_AUDIO_IN_FLIGHT: usize = 3;

impl Slot {
    fn alive(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    fn has_room(&self, max_in_flight: usize) -> bool {
        self.alive() && self.in_flight.load(Ordering::Relaxed) < max_in_flight
    }

    fn has_audio_room(&self) -> bool {
        self.alive() && self.audio_in_flight.load(Ordering::Relaxed) < MAX_AUDIO_IN_FLIGHT
    }
}

/// Every connection, shared by all three threads.
pub struct Clients {
    slots: Mutex<Vec<Arc<Slot>>>,
    /// `[stream].max_frames_in_flight`, per client.
    max_in_flight: usize,
    next_id: AtomicU64,
    /// Rung after anything is queued, so the connection thread's `poll` wakes
    /// now rather than at its backstop. An eventfd: writes add to a counter,
    /// one read drains it, and it cannot block or fill up in any way that
    /// matters here.
    wake: OwnedFd,
}

impl Clients {
    fn new(max_in_flight: usize, wake: OwnedFd) -> Self {
        Self {
            slots: Mutex::new(Vec::new()),
            max_in_flight: max_in_flight.max(1),
            // Ids start at 1 so 0 can mean "nobody" in logs and tests.
            next_id: AtomicU64::new(1),
            wake,
        }
    }

    /// Wake the connection thread. Failure means only a backstop-length delay.
    fn wake(&self) {
        let _ = rustix::io::write(&self.wake, &1u64.to_ne_bytes());
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

    /// Record whether one client wants to hear the machine, and how.
    pub fn set_audio(&self, id: SessionId, enabled: bool, opus: bool) {
        self.with(id, |slot| {
            slot.audio.store(enabled, Ordering::Relaxed);
            slot.opus.store(opus, Ordering::Relaxed);
        });
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
        let Some(json) = control(&message) else { return };
        let Ok(slots) = self.slots.lock() else { return };
        for slot in slots.iter().filter(|s| s.alive()) {
            let _ = slot.outgoing.send(Outgoing::Control(json.clone()));
        }
        drop(slots);
        self.wake();
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
        self.wake();
    }

    /// Queue a control message for one connection.
    pub fn send_to(&self, id: SessionId, message: ToShell) {
        let Some(json) = control(&message) else { return };
        self.with(id, |slot| {
            if slot.alive() {
                let _ = slot.outgoing.send(Outgoing::Control(json));
            }
        });
        self.wake();
    }
}

/// Which of a chunk's payloads one client should be sent, if any.
///
/// An Opus client falls back to PCM (every client can play PCM, and the
/// chunk header says which it got). The reverse would be handing a client
/// bytes it cannot decode, so a PCM client whose payload is missing skips
/// the chunk; the capture follows the listener mix within one 20ms beat, so
/// the gap is one chunk long.
fn audio_payload<'a, T>(
    decodes_opus: bool,
    opus: Option<&'a T>,
    pcm: Option<&'a T>,
) -> Option<&'a T> {
    if decodes_opus { opus.or(pcm) } else { pcm }
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

    /// The healthiest connected client's queueing delay.
    ///
    /// Excess RTT over each connection's own baseline, minimised across
    /// clients, to match the "any" in [`Self::can_accept_frame`]: the budget
    /// follows the best link, and the fan-out already skips whoever is
    /// behind. `None` until some client has answered a probe.
    pub fn queue_delay(&self) -> Option<Duration> {
        let slots = self.clients.slots.lock().ok()?;
        slots
            .iter()
            .filter(|slot| slot.alive())
            .map(|slot| slot.rtt_excess.load(Ordering::Relaxed))
            .filter(|&micros| micros != RTT_UNMEASURED)
            .min()
            .map(Duration::from_micros)
    }

    /// Is anyone actually connected?
    ///
    /// Distinct from [`Self::can_accept_frame`], which answers false both when
    /// every client is behind and when there are no clients at all. Those look
    /// the same to a caller and mean opposite things: the first is the link
    /// struggling, the second is nothing to struggle with.
    ///
    /// The difference matters during the reconnect grace. A disconnect removes
    /// the slot immediately while the session is held for 45 seconds, so for
    /// that whole window `can_accept_frame` is false with no link involved.
    /// Read as congestion it walked the budget to the floor, and the client
    /// that came back found a session throttled by its own absence.
    pub fn has_clients(&self) -> bool {
        self.clients
            .slots
            .lock()
            .is_ok_and(|slots| slots.iter().any(|slot| slot.alive()))
    }

    /// Hand a chunk of audio to everyone listening, each in its own format.
    ///
    /// A client that decodes Opus gets the Opus payload; one that cannot gets
    /// PCM. The capture builds only the encodings somebody currently needs,
    /// so the common case (every listener on Opus) never pays for PCM at all.
    /// A listener whose format is missing this chunk (it just joined, or the
    /// encoder hiccuped) takes whichever exists rather than silence: the
    /// header on every chunk says what it is, so the client follows.
    ///
    /// Shares the video queue and its bound deliberately. Audio and pixels
    /// compete for the same socket, and a client so far behind that frames are
    /// being dropped is one where continuing to push audio would only widen the
    /// gap between what it hears and what it sees. Silence that recovers beats
    /// audio that drifts further out of sync every second.
    pub fn send_audio(&self, chunk: crate::audio::Chunk) {
        let opus = chunk.opus.map(tungstenite::Bytes::from);
        let pcm = chunk.pcm.map(tungstenite::Bytes::from);
        if opus.is_none() && pcm.is_none() {
            return;
        }
        let Ok(slots) = self.clients.slots.lock() else {
            return;
        };
        for slot in slots.iter() {
            if !slot.audio.load(Ordering::Relaxed) || !slot.has_audio_room() {
                continue;
            }
            let wanted =
                audio_payload(slot.opus.load(Ordering::Relaxed), opus.as_ref(), pcm.as_ref());
            let Some(payload) = wanted else { continue };
            slot.audio_in_flight.fetch_add(1, Ordering::Relaxed);
            if slot.outgoing.send(Outgoing::Audio(payload.clone())).is_err() {
                slot.audio_in_flight.fetch_sub(1, Ordering::Relaxed);
            }
        }
        drop(slots);
        self.clients.wake();
    }

    /// Hand a finished frame to everyone who asked for that window.
    ///
    /// The fan-out clones a `Bytes`, which is a reference count. Several
    /// devices watching the same window share one buffer, and the socket
    /// hands it to the kernel without copying either. The alternative of
    /// encoding per client would cost an NVENC session each, and there are
    /// only eight.
    pub fn send_frame(&self, window: WindowId, bytes: Vec<u8>) {
        let bytes = tungstenite::Bytes::from(bytes);
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
        drop(slots);
        self.clients.wake();
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
        shell_dir: Option<std::path::PathBuf>,
        gates: crate::upload::Gates,
    ) -> std::io::Result<(Self, std::net::SocketAddr, SharedToken)> {
        let listener = TcpListener::bind(addr)?;
        let local = listener.local_addr()?;
        // Shared rather than moved, so editing AUTH_PASS in .env takes effect
        // on the next connection instead of needing a restart. Read once per
        // handshake, which is far too rare for the lock to matter.
        let token = Arc::new(Mutex::new(token));
        let thread_token = Arc::clone(&token);
        let wake = rustix::event::eventfd(
            0,
            rustix::event::EventfdFlags::CLOEXEC | rustix::event::EventfdFlags::NONBLOCK,
        )
        .map_err(std::io::Error::from)?;
        let clients = Arc::new(Clients::new(max_in_flight, wake));
        let thread_clients = Arc::clone(&clients);

        thread::Builder::new()
            .name("lwfa-shell".into())
            .spawn(move || {
                accept_loop(
                    listener,
                    thread_token,
                    accounts,
                    events,
                    thread_clients,
                    shell_dir,
                    gates,
                )
            })?;

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

    /// Is anyone actually connected? See [`FrameSink::has_clients`].
    pub fn has_clients(&self) -> bool {
        self.sink().has_clients()
    }

    /// See [`FrameSink::queue_delay`].
    pub fn queue_delay(&self) -> Option<Duration> {
        self.sink().queue_delay()
    }
}

/// A connection the accept thread is serving.
struct Live {
    id: SessionId,
    socket: tungstenite::WebSocket<TcpStream>,
    outgoing: Receiver<Outgoing>,
    in_flight: Arc<AtomicUsize>,
    audio_in_flight: Arc<AtomicUsize>,
    connected: Arc<AtomicBool>,
    evict: Arc<AtomicBool>,
    superseded: Arc<AtomicBool>,
    /// The last flush hit `WouldBlock`: bytes are sitting in tungstenite's
    /// queue waiting for the kernel buffer to drain, so the poll watches this
    /// socket for writability as well as readability.
    write_blocked: bool,
    /// Frames handed to the WebSocket but not yet accepted by the kernel.
    ///
    /// They stay counted in `in_flight` until a flush succeeds, because until
    /// then they are latency the viewer will feel and the truthful congestion
    /// signal the bitrate controller runs on. Decrementing at dequeue, as
    /// this used to, meant a slow link could buffer *seconds* of video inside
    /// the socket with the engine convinced everything was fine.
    unacked_video: usize,
    /// Audio chunks in the same position.
    unacked_audio: usize,
    /// When anything last arrived from the far end. See `heartbeat`.
    last_read: std::time::Instant,
    /// When the last probe ping was sent, matched against its pong for RTT.
    /// Distinct from `ping_sent`: liveness is satisfied by any inbound
    /// traffic, the measurement only by the pong itself.
    probe_sent: Option<std::time::Instant>,
    /// When a probe was last transmitted, for the cadence.
    last_probe: std::time::Instant,
    /// The least RTT seen, creeping per [`advance_baseline`].
    min_rtt: Option<Duration>,
    /// Where the measured excess is published for the compositor.
    rtt_excess: Arc<AtomicU64>,
    /// An unanswered ping, when one is out. See `heartbeat`.
    ping_sent: Option<std::time::Instant>,
}

/// An unanswered ping older than this is a dead connection.
///
/// This exists because of iOS. A home-screen web app that is swiped away is
/// simply terminated: no unload runs, no close frame is sent, and the socket
/// looks perfectly healthy from here. Before this, a discarded iPad lingered
/// in the peers list, kept its windows in the streamed union, and held the
/// virtual microphone, until a write happened to fail. Browsers answer pings
/// in the network stack, below JavaScript, so a live page always passes; a
/// suspended or dead one cannot.
const PONG_GRACE: Duration = Duration::from_secs(15);

/// How often each client is pinged.
///
/// The pong doubles as a network probe. A ping rides the same TCP stream as
/// the frames, so one queued behind buffered video measures exactly how far
/// behind that client is, and browsers answer pongs in the network stack,
/// below JavaScript, so page jank cannot pollute the number. This is the
/// delay signal congestion controllers like WebRTC's GCC are built on:
/// delay rises as queues form, long before anything blocks or drops.
const PROBE_INTERVAL: Duration = Duration::from_secs(1);

/// How much the RTT baseline may rise per probe.
///
/// The baseline is the least RTT seen, which is the path with empty queues.
/// A strict minimum never recovers if the route genuinely changes (wifi to
/// DERP relay, say), so it is allowed to creep upward slowly: about a
/// millisecond a second. During congestion the creep is dwarfed by the
/// excess it is measuring, and after a route change the baseline re-learns
/// in under a minute.
const BASELINE_CREEP: Duration = Duration::from_millis(1);

/// The delay baseline for one connection, fed by the probes above.
fn advance_baseline(baseline: Option<Duration>, rtt: Duration) -> Duration {
    match baseline {
        None => rtt,
        Some(base) => rtt.min(base + BASELINE_CREEP),
    }
}

/// Marker for "no probe has completed yet" in [`Slot::rtt_excess`].
const RTT_UNMEASURED: u64 = u64::MAX;

/// Ping on a cadence, reap when one goes unanswered too long. True to keep.
///
/// This used to ping only after ten seconds of inbound silence, because its
/// only job was liveness. The pong now also carries the delay measurement
/// (see [`PROBE_INTERVAL`]), and a signal sampled once per idle spell cannot
/// steer a bitrate, so the ping is periodic. One small frame a second against
/// megabits of video is noise.
fn heartbeat(client: &mut Live) -> bool {
    let now = std::time::Instant::now();
    if let Some(sent) = client.ping_sent
        && now.duration_since(sent) > PONG_GRACE
    {
        return false;
    }
    if now.duration_since(client.last_probe) >= PROBE_INTERVAL {
        // Failures are left to the read path, which already knows how to
        // declare a socket dead; this only asks the question.
        let _ = client
            .socket
            .send(tungstenite::Message::Ping(tungstenite::Bytes::new()));
        let _ = client.socket.flush();
        client.last_probe = now;
        client.probe_sent = Some(now);
        if client.ping_sent.is_none() {
            client.ping_sent = Some(now);
        }
    }
    true
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
    shell_dir: Option<std::path::PathBuf>,
    gates: crate::upload::Gates,
) {
    if listener.set_nonblocking(true).is_err() {
        tracing::error!("could not set the shell listener non-blocking; no shell can connect");
        return;
    }

    let mut live: Vec<Live> = Vec::new();

    loop {
        loop {
            match listener.accept() {
                Ok((stream, peer)) => {
                    // One port, split by request rather than by number: an
                    // upgrade is the protocol, anything else is the page. See
                    // `crate::http`.
                    //
                    // The file is served on a thread of its own because this
                    // loop must not block. A tablet pulling a megabyte of
                    // JavaScript over wifi would otherwise stall every other
                    // connection, including live sessions, for as long as the
                    // download takes.
                    // A preview is an ordinary GET, not an upgrade, so it
                    // is split off before the static-file path. Its own
                    // thread for the same reason: a video being streamed
                    // must not hold up anyone else's connection.
                    if crate::http::wants_preview(&stream) {
                        let gates = Arc::clone(&gates);
                        let _ = thread::Builder::new()
                            .name("lwfa-preview".into())
                            .spawn(move || {
                                let mut stream = stream;
                                if let Some(head) = crate::http::peek_head(&mut stream) {
                                    crate::preview::serve(stream, &head, &gates);
                                }
                            });
                        continue;
                    }

                    if !crate::http::wants_websocket(&stream) {
                        match shell_dir.as_deref() {
                            Some(root) => {
                                let root = root.to_path_buf();
                                let _ = thread::Builder::new()
                                    .name("lwfa-http".into())
                                    .spawn(move || crate::http::serve(stream, &root));
                            }
                            None => {
                                // No built shell to serve. Almost always a
                                // development run with Vite on another port, so
                                // this is a debug line rather than a warning;
                                // the one-time warning at startup is where a
                                // production run missing its page is reported.
                                tracing::debug!("HTTP request from {peer} but no shell directory");
                                crate::http::refuse(stream);
                            }
                        }
                        continue;
                    }

                    // Upload connections are WebSockets too, but they are not
                    // sessions: they authenticate with a per-dialog ticket,
                    // move bulk bytes, and must not count against the session
                    // cap or share this thread. Each gets a thread of its own,
                    // for the same reason the HTTP requests do: this loop must
                    // not block, and an upload lasts as long as the file.
                    if crate::http::wants_upload_channel(&stream) {
                        let gates = Arc::clone(&gates);
                        let upload_events = events.clone();
                        let _ = thread::Builder::new()
                            .name("lwfa-upload".into())
                            .spawn(move || crate::upload::serve(stream, gates, upload_events));
                        continue;
                    }

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
                    let audio_in_flight = Arc::new(AtomicUsize::new(0));
                    let connected = Arc::new(AtomicBool::new(true));
                    let evict = Arc::new(AtomicBool::new(false));
                    let superseded = Arc::new(AtomicBool::new(false));
                    let rtt_excess = Arc::new(AtomicU64::new(RTT_UNMEASURED));
                    clients.add(Arc::new(Slot {
                        id,
                        outgoing: outgoing_tx,
                        in_flight: Arc::clone(&in_flight),
                        audio_in_flight: Arc::clone(&audio_in_flight),
                        connected: Arc::clone(&connected),
                        streams: Mutex::new(HashSet::new()),
                        audio: AtomicBool::new(false),
                        opus: AtomicBool::new(false),
                        rtt_excess: Arc::clone(&rtt_excess),
                        superseded: Arc::clone(&superseded),
                        evict: Arc::clone(&evict),
                    }));
                    live.push(Live {
                        id,
                        socket,
                        outgoing: outgoing_rx,
                        in_flight,
                        audio_in_flight,
                        connected,
                        evict,
                        superseded: Arc::clone(&superseded),
                        write_blocked: false,
                        probe_sent: None,
                        last_probe: std::time::Instant::now(),
                        min_rtt: None,
                        rtt_excess,
                        unacked_video: 0,
                        unacked_audio: 0,
                        last_read: std::time::Instant::now(),
                        ping_sent: None,
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
            if kicked {
                finished.push(index);
                continue;
            }
            if !pump(client, &events) {
                finished.push(index);
            } else if !heartbeat(client) {
                tracing::info!(
                    "shell {} stopped answering pings; presumed gone",
                    client.id
                );
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

        // Sleep until there is something to do: a new connection, bytes from
        // a client, room to finish a blocked write, or the compositor ringing
        // the eventfd because it queued something. No timers, no spinning.
        {
            use rustix::event::{PollFd, PollFlags, poll};
            let mut fds = Vec::with_capacity(live.len() + 2);
            fds.push(PollFd::new(&listener, PollFlags::IN));
            fds.push(PollFd::new(&clients.wake, PollFlags::IN));
            for client in &live {
                let flags = if client.write_blocked {
                    PollFlags::IN | PollFlags::OUT
                } else {
                    PollFlags::IN
                };
                fds.push(PollFd::new(client.socket.get_ref(), flags));
            }
            let _ = poll(&mut fds, Some(&POLL_BACKSTOP));
        }

        // Drain the wake counter so the next poll blocks again. One read
        // resets an eventfd however many times it was rung.
        let mut drained = [0u8; 8];
        let _ = rustix::io::read(&clients.wake, &mut drained);
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
    // A small kernel send buffer, because that buffer is an invisible queue.
    //
    // Left to auto-tuning, Linux grows it to megabytes, and `in_flight`
    // counts a frame only until `flush` hands it to the kernel. So the
    // 4-frame cap was being measured against a queue that could hold seconds
    // of video: congestion was only visible after all of it filled, and the
    // client then had to play through it, which is what a "laggy but not
    // adapting" session was. Sized to sustain the 32 Mbit/s ceiling out to
    // ~130ms of RTT (the kernel doubles the requested value), while capping
    // the hidden queue at fractions of a second instead of several.
    if let Err(err) = rustix::net::sockopt::set_socket_send_buffer_size(&stream, 256 * 1024) {
        tracing::debug!("could not shrink the socket send buffer: {err}");
    }
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
fn pump(client: &mut Live, events: &LoopSender<ShellEvent>) -> bool {
    // Reads first, so a burst of shell input is not delayed behind the poll
    // interval.
    loop {
        let message = client.socket.read();
        if message.is_ok() {
            // Anything inbound proves the far end is alive, including the
            // pong a browser's network stack sends below JavaScript.
            client.last_read = std::time::Instant::now();
            client.ping_sent = None;
        }
        match message {
            Ok(tungstenite::Message::Text(text)) => {
                match serde_json::from_str::<ToEngine>(&text) {
                    Ok(message) => {
                        if events
                            .send(ShellEvent::Message(client.id, message))
                            .is_err()
                        {
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
            // Say which way the connection died. "disconnected" alone cannot
            // distinguish a page the user closed (clean close frame), a
            // network path that broke (read error below), and a client that
            // silently vanished (heartbeat), and those point at different
            // culprits when a session is flapping.
            Ok(tungstenite::Message::Pong(_)) => {
                // The other half of the probe in `heartbeat`. RTT against the
                // connection's own floor is the queue: how long a byte sent
                // now would wait behind everything already in flight.
                if let Some(sent) = client.probe_sent.take() {
                    let rtt = std::time::Instant::now().duration_since(sent);
                    let baseline = advance_baseline(client.min_rtt, rtt);
                    client.min_rtt = Some(baseline);
                    let excess = rtt.saturating_sub(baseline);
                    client
                        .rtt_excess
                        .store(excess.as_micros().min(u64::MAX as u128) as u64, Ordering::Relaxed);
                }
            }
            Ok(tungstenite::Message::Close(frame)) => {
                match frame {
                    Some(f) => tracing::info!(
                        "shell {} sent close: {} {:?}",
                        client.id,
                        f.code,
                        f.reason
                    ),
                    None => tracing::info!("shell {} sent close with no reason", client.id),
                }
                return false;
            }
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
        match client.outgoing.try_recv() {
            Ok(outbound) => {
                // Frames stay counted in their in-flight tallies until the
                // flush below succeeds; handing bytes to the WebSocket is not
                // delivery. See `Live::unacked_video`.
                let frame = match outbound {
                    Outgoing::Control(json) => tungstenite::Message::Text(json),
                    Outgoing::Frame(bytes) => {
                        client.unacked_video += 1;
                        tungstenite::Message::Binary(bytes)
                    }
                    Outgoing::Audio(bytes) => {
                        client.unacked_audio += 1;
                        tungstenite::Message::Binary(bytes)
                    }
                };
                if let Err(err) = client.socket.send(frame) {
                    match err {
                        // Queued inside tungstenite; the flush below reports
                        // the blockage.
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

    match client.socket.flush() {
        Ok(()) => {
            // Everything the socket was holding has reached the kernel, so
            // every frame handed over so far is off this client's account.
            if client.unacked_video > 0 {
                client
                    .in_flight
                    .fetch_sub(client.unacked_video, Ordering::Relaxed);
                client.unacked_video = 0;
            }
            if client.unacked_audio > 0 {
                client
                    .audio_in_flight
                    .fetch_sub(client.unacked_audio, Ordering::Relaxed);
                client.unacked_audio = 0;
            }
            client.write_blocked = false;
            true
        }
        Err(tungstenite::Error::Io(ref io)) if io.kind() == ErrorKind::WouldBlock => {
            client.write_blocked = true;
            true
        }
        Err(err) => {
            tracing::warn!("shell socket flush failed: {err}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_opus_client_gets_opus_and_falls_back_to_pcm() {
        assert_eq!(audio_payload(true, Some(&"opus"), Some(&"pcm")), Some(&"opus"));
        assert_eq!(audio_payload(true, None, Some(&"pcm")), Some(&"pcm"));
    }

    #[test]
    fn a_pcm_client_never_gets_bytes_it_cannot_decode() {
        // Handing Opus to a client without a decoder is bandwidth spent on
        // guaranteed silence; skipping the chunk is the honest version.
        assert_eq!(audio_payload(false, Some(&"opus"), Some(&"pcm")), Some(&"pcm"));
        assert_eq!(audio_payload(false, Some(&"opus"), None), None::<&&str>);
    }

    #[test]
    fn the_first_probe_sets_the_baseline() {
        let rtt = Duration::from_millis(12);
        assert_eq!(advance_baseline(None, rtt), rtt);
    }

    #[test]
    fn a_faster_probe_lowers_it_immediately() {
        let base = Some(Duration::from_millis(30));
        assert_eq!(
            advance_baseline(base, Duration::from_millis(9)),
            Duration::from_millis(9)
        );
    }

    #[test]
    fn a_slow_probe_only_creeps_it() {
        // Congestion is exactly "RTT far above baseline", and a baseline that
        // jumped to meet it would erase the signal being measured.
        let base = Some(Duration::from_millis(10));
        assert_eq!(
            advance_baseline(base, Duration::from_millis(400)),
            Duration::from_millis(10) + BASELINE_CREEP
        );
    }

    #[test]
    fn a_route_change_is_relearned_rather_than_permanent() {
        // The path genuinely got slower (wifi roamed, tailscale fell back to
        // a relay). The floor climbs one creep per probe until the excess it
        // reports is honest again.
        let mut base = Some(Duration::from_millis(5));
        let new_path = Duration::from_millis(60);
        for _ in 0..60 {
            base = Some(advance_baseline(base, new_path));
        }
        assert_eq!(base.unwrap(), new_path);
    }
}
