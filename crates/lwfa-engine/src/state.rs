//! Compositor state.
//!
//! Smithay's protocol modules each keep a state struct here and call back into
//! a handler trait implemented on this type. See `handlers/`.
//!
//! Since milestone 3 this type is also the bridge to the shell: it assigns
//! stable [`WindowId`]s, reports lifecycle over the shell protocol, and applies
//! the layout that comes back. It holds no layout policy of its own beyond
//! safe mode. See `layout.rs`.

use std::ffi::OsString;
use std::rc::Rc;
use std::sync::Arc;

use lwfa_proto::{Modifiers, PROTOCOL_VERSION, ToShell, WindowId, WindowInfo};
use smithay::desktop::{PopupManager, Space, Window, WindowSurface, WindowSurfaceType};
use smithay::input::{Seat, SeatState};
use smithay::reexports::calloop::generic::Generic;
use smithay::reexports::calloop::{EventLoop, Interest, LoopHandle, LoopSignal, Mode, PostAction};
use smithay::reexports::wayland_server::backend::{ClientData, ClientId, DisconnectReason};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::{Display, DisplayHandle};
use smithay::utils::{Logical, Point, Rectangle};
use smithay::wayland::compositor::{CompositorClientState, CompositorState};
use smithay::wayland::output::OutputManagerState;
use smithay::wayland::seat::WaylandFocus;
use smithay::wayland::selection::data_device::DataDeviceState;
use smithay::wayland::shell::xdg::XdgShellState;
use smithay::wayland::shm::ShmState;
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::wayland::socket::ListeningSocketSource;
use smithay::wayland::xwayland_shell::XWaylandShellState;
use smithay::xwayland::X11Wm;

use crate::capture::SurfaceCapture;
use crate::encode::EncodeWorker;

use crate::layout::{self, Layout};
use crate::shell::ShellLink;

/// One connected shell.
///
/// Everything here is per connection rather than per engine, which is the whole
/// difference between one client and several. Permissions belong to whoever
/// authenticated, streams belong to whichever windows *that* device can see,
/// and the H.264 capability belongs to that browser: a tablet reached over
/// plain HTTP has no `VideoDecoder` while a laptop on localhost does, and
/// treating either answer as global would leave one of them with blank windows.
pub struct Session {
    /// What this session may do. Enforced here, not in the browser.
    pub permissions: lwfa_proto::Permissions,
    /// Which account it authenticated as. "owner" for `AUTH_PASS`.
    pub account: String,
    /// Best-effort device description, for the connections list.
    pub device: String,
    /// When this session started, for spotting a reconnection storm.
    pub since: std::time::Instant,
    /// The browser's own stable id, used to recognise a reconnection.
    ///
    /// Empty for clients that do not send one, which are then never treated as
    /// reconnections of anything.
    pub client: String,
    /// Whether this client can decode H.264, once it has said.
    ///
    /// `None` until the client declares it in `SetStreams`. That distinction
    /// matters: treating "has not answered yet" as "cannot" made every new
    /// connection flip the session-wide answer to JPEG for a moment, and
    /// switching format tears down every NVENC session. A page refresh
    /// therefore rebuilt all of them, at 90-160ms each.
    pub codecs: Option<Vec<lwfa_proto::Codec>>,
    /// Whether this client has asked to hear the machine.
    pub audio: bool,
    /// Whether this client can decode Opus. See `AudioFormat::Opus`.
    pub opus: bool,
    /// How many bits this client wants spent on sound. The most constrained
    /// listener wins; see `Lwfa::sync_audio_bitrate`.
    pub audio_quality: lwfa_proto::AudioQuality,
}

/// How long a window may be streamed without ever producing a frame.
///
/// Generous: a client that has just been configured to a new size legitimately
/// takes a moment. Anything past this is not slow, it is stuck.
const FIRST_FRAME_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// How often an unfocused window is captured: 20 fps.
///
/// The focused window gets the full redraw rate. The others are peripheral
/// vision, where 20 fps is imperceptible; what is very perceptible is five
/// windows each demanding 60 captures and encodes a second from one GPU.
const UNFOCUSED_CAPTURE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

pub struct Lwfa {
    /// Settings from `configs/defaults.toml`, resolved once at startup.
    pub config: crate::config::Config,
    pub start_time: std::time::Instant,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,

    /// Smithay's 2D plane. The layout decides positions; the space holds what
    /// was decided so rendering and hit-testing can use it.
    pub space: Space<Window>,
    /// Reconciles shell-declared layout. Holds no policy.
    pub layout: Layout,
    /// The shell listener. `None` until it binds.
    pub shell: Option<ShellLink>,
    /// Everyone connected, keyed by session. See [`Session`].
    pub sessions: std::collections::HashMap<lwfa_proto::SessionId, Session>,
    /// The running audio capture, if anyone is listening. See `audio.rs`.
    pub audio: Option<crate::audio::Capture>,
    /// Chooses the total bitrate from how the connection is coping.
    pub bitrate: crate::bitrate::Controller,
    /// Holds focus still before the budget follows it. See `bitrate`.
    pub attention: crate::bitrate::Attention,
    /// What was last allocated, so the division is only recomputed on a change.
    streamed_last: Vec<WindowId>,
    attended_last: Option<WindowId>,
    /// The session's own audio device, so the machine stays quiet. See `sink.rs`.
    pub audio_sink: crate::sink::PrivateSink,
    /// A virtual controller per client that is holding one. See `gamepad.rs`.
    ///
    /// Empty by default: each device is visible to the whole machine, so one
    /// exists only while somebody is holding it. Keyed by session rather than
    /// kept as a single global for two reasons. A client must not be able to
    /// switch off another client's controller, and two people on two devices
    /// should be two players, which is exactly what two controllers are.
    pub gamepads:
        std::collections::HashMap<lwfa_proto::SessionId, crate::gamepad::VirtualPad>,
    /// Windows asked for but never yet captured, and when they were asked for.
    ///
    /// Not "nothing captured recently", which on an idle desktop is damage
    /// tracking working correctly and would cry wolf constantly. This is the
    /// genuinely broken case: pixels were requested for a window and none have
    /// ever arrived. See `warn_if_nothing_ever_arrived`.
    pub awaiting_first_frame: std::collections::HashMap<WindowId, std::time::Instant>,
    /// The last arrangement the primary declared.
    ///
    /// Kept so a device joining mid-session has something to render straight
    /// away. Without it a follower shows an empty desktop until the primary
    /// happens to move a window, which on a session nobody is touching is
    /// never.
    pub last_layout: Vec<lwfa_proto::WindowLayout>,
    /// Which session decides layout, if any.
    ///
    /// A window has exactly one size, so there is exactly one arrangement, so
    /// exactly one connection gets to choose it. The rest are told. Any of them
    /// can take over; see `ToEngine::TakeControl`.
    pub primary: Option<lwfa_proto::SessionId>,
    /// Named accounts, if the database opened. See `accounts.rs`.
    pub accounts: Option<Arc<std::sync::Mutex<crate::accounts::Accounts>>>,
    /// Per-surface capture. Only does work when something asks it to.
    pub capture: SurfaceCapture,
    /// Encoding runs on its own thread. Opening an NVENC session costs
    /// 90-160ms, which must not land in the render loop. See `encode.rs`.
    pub encoders: Option<EncodeWorker>,
    /// Windows the shell has asked for pixels of.
    ///
    /// Empty is the normal case for a local shell, which composites natively
    /// and needs no streams at all.
    pub streaming: std::collections::HashSet<WindowId>,
    /// When each streamed window was last captured, for the unfocused cap.
    ///
    /// The focused window is captured at the redraw rate; the others at
    /// [`UNFOCUSED_CAPTURE_INTERVAL`]. A side window is something being
    /// glanced at, and 20 fps is indistinguishable there while costing a
    /// third of the capture and encode work of 60.
    capture_pacing: std::collections::HashMap<WindowId, std::time::Instant>,
    pub loop_signal: LoopSignal,
    /// Kept because `X11Wm` registers its own event sources, and it is started
    /// from inside a callback where the loop itself is not reachable.
    pub loop_handle: LoopHandle<'static, CalloopData>,

    focused: Option<WindowId>,
    next_window_id: u64,
    /// Last `WindowInfo` reported to the shell, per window.
    ///
    /// Clients set their title and app id after mapping and change them later,
    /// so the engine has to notice and report. Diffing against this is what
    /// stops a `WindowChanged` being sent on every single commit.
    reported: std::collections::HashMap<WindowId, WindowInfo>,

    /// The output the compositor presents, in logical pixels.
    ///
    /// Normally the nested window's own size, but a remote shell can replace it
    /// with its own viewport (`SetViewport`), because the strip should lay out
    /// for the device actually looking at it rather than for a monitor nobody
    /// is in front of. When the two differ, the local view is scaled to fit;
    /// see `winit.rs`.
    ///
    /// `None` means "follow the window", which is the local-only default.
    pub viewport_override: Option<(i32, i32, f64)>,
    /// Set by the winit backend so `SetViewport` can resize the real output.
    pub resize_output: Option<Rc<dyn Fn(&mut Lwfa, i32, i32, f64)>>,

    /// The X11 window manager, once Xwayland has started and handed us a
    /// privileged connection. `None` before that, and for the whole run if
    /// Xwayland is not installed.
    pub xwm: Option<X11Wm>,
    /// The X display number, for putting `DISPLAY` in a spawned client's
    /// environment. See `Lwfa::spawn`.
    pub xdisplay: Option<u32>,

    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub xwayland_shell_state: XWaylandShellState,
    pub shm_state: ShmState,
    pub seat_state: SeatState<Lwfa>,
    pub data_device_state: DataDeviceState,
    pub popups: PopupManager,

    /// Held to keep the `wl_output` and `xdg_output` globals alive. Nothing
    /// reads it; dropping it would unadvertise the protocols.
    #[allow(dead_code)]
    output_manager_state: OutputManagerState,

    pub seat: Seat<Self>,
}

impl Lwfa {
    pub fn new(event_loop: &mut EventLoop<'static, CalloopData>, display: Display<Self>) -> Self {
        let dh = display.handle();
        let config = crate::config::Config::load();

        let compositor_state = CompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        // Advertised unconditionally, and only Xwayland can bind it. Creating
        // the global costs nothing if Xwayland never starts.
        let xwayland_shell_state = XWaylandShellState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, "lwfa");
        // Nested backend, so a keyboard and pointer are always present. The TTY
        // backend will need real hotplug tracking.
        seat.add_keyboard(Default::default(), 200, 25)
            .expect("failed to add keyboard to seat");
        seat.add_pointer();
        // Touch is advertised even though the nested backend has no
        // touchscreen: it exists for remote fingers. A client that sees no
        // wl_touch will never handle multi-touch, so this has to be present
        // before the first client connects, not added when an iPad appears.
        seat.add_touch();

        let socket_name = Self::init_wayland_listener(display, event_loop);
        let loop_signal = event_loop.get_signal();
        let loop_handle = event_loop.handle();

        Self {
            config,
            start_time: std::time::Instant::now(),
            display_handle: dh,
            // Real size arrives from the backend once the output exists.
            layout: Layout::new((0, 0).into()),
            shell: None,
            // A session only exists once it has authenticated, so there is no
            // window between bind and connect in which a half-authenticated
            // peer could act: with no entry here, nothing is permitted.
            sessions: std::collections::HashMap::new(),
            last_layout: Vec::new(),
            audio: None,
            bitrate: crate::bitrate::Controller::new(std::time::Instant::now()),
            attention: crate::bitrate::Attention::new(std::time::Instant::now()),
            streamed_last: Vec::new(),
            attended_last: None,
            audio_sink: crate::sink::PrivateSink::default(),
            gamepads: std::collections::HashMap::new(),
            awaiting_first_frame: std::collections::HashMap::new(),
            primary: None,
            accounts: None,
            capture: SurfaceCapture::default(),
            encoders: None,
            streaming: std::collections::HashSet::new(),
            capture_pacing: std::collections::HashMap::new(),
            space: Space::default(),
            loop_signal,
            loop_handle,
            focused: None,
            next_window_id: 1,
            reported: std::collections::HashMap::new(),
            socket_name,
            viewport_override: None,
            resize_output: None,
            xwm: None,
            xdisplay: None,
            compositor_state,
            xdg_shell_state,
            xwayland_shell_state,
            shm_state,
            output_manager_state,
            seat_state,
            data_device_state,
            popups: PopupManager::default(),
            seat,
        }
    }

    fn init_wayland_listener(
        display: Display<Lwfa>,
        event_loop: &mut EventLoop<'static, CalloopData>,
    ) -> OsString {
        let listening_socket =
            ListeningSocketSource::new_auto().expect("failed to bind a wayland socket");
        let socket_name = listening_socket.socket_name().to_os_string();
        let loop_handle = event_loop.handle();

        loop_handle
            .insert_source(listening_socket, move |client_stream, _, state| {
                if let Err(err) = state
                    .display_handle
                    .insert_client(client_stream, Arc::new(ClientState::default()))
                {
                    tracing::warn!("failed to accept a client: {err}");
                }
            })
            .expect("failed to init the wayland event source");

        loop_handle
            .insert_source(
                Generic::new(display, Interest::READ, Mode::Level),
                |_, display, state| {
                    // SAFETY: `dispatch_clients` requires that the `Display` is
                    // not dropped or moved out of while dispatching. The
                    // display is owned by this event source for the lifetime of
                    // the loop, and the only access is through this closure.
                    #[allow(unsafe_code)]
                    unsafe {
                        display.get_mut().dispatch_clients(state)?;
                    }
                    Ok(PostAction::Continue)
                },
            )
            .expect("failed to init the wayland display source");

        socket_name
    }

    // ---------------------------------------------------------------------
    // Window registry
    // ---------------------------------------------------------------------

    pub fn next_window_id(&mut self) -> WindowId {
        let id = WindowId(self.next_window_id);
        self.next_window_id += 1;
        id
    }

    pub fn focused(&self) -> Option<WindowId> {
        self.focused
    }

    /// Read the current title and app id straight off the window.
    ///
    /// Clients set these after mapping and change them later, so this is read
    /// on demand rather than cached and left stale.
    pub fn window_info(&self, id: WindowId) -> Option<WindowInfo> {
        let window = self.layout.window(id)?;
        let (app_id, title) = match window.underlying_surface() {
            WindowSurface::Wayland(toplevel) => {
                smithay::wayland::compositor::with_states(toplevel.wl_surface(), |states| {
                    let data = states
                        .data_map
                        .get::<smithay::wayland::shell::xdg::XdgToplevelSurfaceData>()
                        .map(|d| d.lock().unwrap());
                    match data {
                        Some(d) => (d.app_id.clone(), d.title.clone()),
                        None => (None, None),
                    }
                })
            }
            // WM_CLASS stands in for the app id. It is the closest X11 has, and
            // it is what desktop files have always matched on. Both come back
            // as empty strings rather than absent, so normalise to None and let
            // the shell show its placeholder.
            WindowSurface::X11(x11) => {
                let blank = |s: String| (!s.is_empty()).then_some(s);
                (blank(x11.class()), blank(x11.title()))
            }
        };
        Some(WindowInfo { id, app_id, title })
    }

    /// Report a title or app id change, but only when something actually
    /// changed. Called on every commit, which is far more often than a client
    /// renames itself.
    pub fn report_window_changes(&mut self, id: WindowId) {
        let Some(info) = self.window_info(id) else {
            return;
        };
        if self.reported.get(&id) == Some(&info) {
            return;
        }
        self.reported.insert(id, info.clone());
        self.send_to_shell(ToShell::WindowChanged { window: info });
    }

    pub fn forget_reported(&mut self, id: WindowId) {
        self.reported.remove(&id);
    }

    /// Drop every trace of a window that has gone away, and tell the shell.
    ///
    /// Shared by the Wayland and X11 destroy paths. Forgetting one of these
    /// places leaks in a way that is easy to miss: a stale capture keeps a
    /// texture alive, and a stale encoder session holds one of only eight NVENC
    /// slots. Safe to call twice, which matters because X11 reports both an
    /// unmap and a destroy for the same window.
    pub fn retire_window(&mut self, id: WindowId) {
        if let Some(window) = self.layout.window(id).cloned() {
            self.space.unmap_elem(&window);
        }
        self.layout.forget(id);
        self.forget_reported(id);
        self.capture.forget(id);
        self.streaming.remove(&id);
        self.capture_pacing.remove(&id);
        if let Some(worker) = self.encoders.as_ref() {
            worker.forget(id);
        }

        if self.focused() == Some(id) {
            // Focus something else rather than leaving the seat pointing at a
            // window that no longer exists.
            let next = self.topmost_window_id();
            self.set_focus(next, true);
        }

        self.send_to_shell(ToShell::WindowClosed { id });

        if self.layout.mode() == layout::Mode::Safe {
            self.apply_safe_mode();
        }
    }

    /// Send to every connected shell.
    ///
    /// Window lifecycle, focus and key bindings are facts about the session
    /// rather than about one viewer, so they go to all of them.
    /// Pass a client's fullscreen request to the shell.
    ///
    /// With no shell connected there is nobody to decide, and safe mode already
    /// gives the focused window the whole output, so the request is dropped
    /// rather than half-applied.
    pub fn request_fullscreen(
        &mut self,
        surface: &smithay::wayland::shell::xdg::ToplevelSurface,
        fullscreen: bool,
    ) {
        let Some(window) = self
            .space
            .elements()
            .find(|w| w.wl_surface().as_deref() == Some(surface.wl_surface()))
            .cloned()
        else {
            return;
        };
        let Some(id) = self.layout.id_of(&window) else {
            return;
        };
        tracing::info!(
            "window {id} asked to {} fullscreen",
            if fullscreen { "enter" } else { "leave" }
        );
        self.send_to_shell(ToShell::FullscreenRequest { window: id, fullscreen });
    }

    /// The X11 half of [`Self::request_fullscreen`].
    pub fn request_fullscreen_x11(
        &mut self,
        surface: &smithay::xwayland::X11Surface,
        fullscreen: bool,
    ) {
        let Some(window) = self
            .space
            .elements()
            .find(|w| match w.underlying_surface() {
                WindowSurface::X11(x11) => x11 == surface,
                WindowSurface::Wayland(_) => false,
            })
            .cloned()
        else {
            return;
        };
        let Some(id) = self.layout.id_of(&window) else {
            return;
        };
        // Told as well as asked, unlike xdg-shell: an X11 client has no way to
        // decline, and its own idea of its state has to be kept in step or a
        // player will show the wrong button.
        let _ = surface.set_fullscreen(fullscreen);
        tracing::info!(
            "X11 window {id} asked to {} fullscreen",
            if fullscreen { "enter" } else { "leave" }
        );
        self.send_to_shell(ToShell::FullscreenRequest { window: id, fullscreen });
    }

    pub fn send_to_shell(&self, message: ToShell) {
        if let Some(shell) = &self.shell {
            shell.broadcast(message);
        }
    }

    /// Send to one connection.
    pub fn send_to_session(&self, session: lwfa_proto::SessionId, message: ToShell) {
        if let Some(shell) = &self.shell {
            shell.send_to(session, message);
        }
    }

    /// Everyone connected, in a stable order.
    ///
    /// Sorted by id, which is allocation order, so the list does not reshuffle
    /// under the user every time it is sent. A `HashMap` iterated directly
    /// would do exactly that.
    pub fn peers(&self) -> Vec<lwfa_proto::PeerInfo> {
        let mut peers: Vec<lwfa_proto::PeerInfo> = self
            .sessions
            .iter()
            .map(|(id, session)| lwfa_proto::PeerInfo {
                id: *id,
                account: session.account.clone(),
                mode: session.permissions.mode,
                primary: self.primary == Some(*id),
                device: session.device.clone(),
            })
            .collect();
        peers.sort_by_key(|p| p.id);
        peers
    }

    /// Tell everyone who is connected, and remind each of its own role.
    ///
    /// Both, because they change together: a session arriving can make another
    /// one no longer primary, and a client showing "you are viewing" needs to
    /// stop showing it the moment that stops being true.
    pub fn announce_peers(&self) {
        let peers = self.peers();
        self.send_to_shell(ToShell::Peers {
            peers: peers.clone(),
        });
        for peer in peers {
            self.send_to_session(
                peer.id,
                ToShell::Role {
                    primary: peer.primary,
                },
            );
        }
    }

    /// Say so, once, when a window is being streamed and has never sent a frame.
    ///
    /// This exists because of a report that could not be reproduced: a session
    /// that streamed nothing until the host workspace was visited on the
    /// physical display. From outside that is indistinguishable from a hang, a
    /// dead encoder, a network problem, and several other things, and guessing
    /// between them wasted an afternoon. So the engine names the condition
    /// itself, with the state needed to tell those apart.
    fn warn_if_nothing_ever_arrived(&mut self) {
        let now = std::time::Instant::now();
        let overdue: Vec<WindowId> = self
            .awaiting_first_frame
            .iter()
            .filter(|(_, asked)| now.duration_since(**asked) >= FIRST_FRAME_GRACE)
            .map(|(id, _)| *id)
            .collect();
        if overdue.is_empty() {
            return;
        }

        let size = self.layout.output_size();
        tracing::warn!(
            "{} window(s) have been streamed for over {:?} without producing a single \
             frame: {overdue:?}. {} placed, output {}x{}, mode {:?}. A remote client is \
             showing these blank.",
            overdue.len(),
            FIRST_FRAME_GRACE,
            self.layout.placements().len(),
            size.w,
            size.h,
            self.layout.mode(),
        );

        // Once per window per request, not once per frame.
        for id in overdue {
            self.awaiting_first_frame.remove(&id);
        }
    }

    /// Recompute which windows anyone wants pixels for.
    ///
    /// The union across connections, because a window visible on the phone has
    /// to be captured even if the tablet has scrolled past it. Kept in one
    /// place so the capture loop never has to reason about who asked.
    pub fn recompute_streams(&mut self) {
        let wanted = match self.shell.as_ref() {
            Some(shell) => shell.clients().streamed_windows(),
            None => std::collections::HashSet::new(),
        };
        // Newly wanted windows need a capture even if they are idle, or an
        // untouched window would never produce a frame for whoever just asked.
        let now = std::time::Instant::now();
        for id in wanted.difference(&self.streaming) {
            self.capture.invalidate(*id);
            self.awaiting_first_frame.insert(*id, now);
        }
        for id in self.streaming.difference(&wanted) {
            self.awaiting_first_frame.remove(id);
            // Streaming is over for this window, so its encoder session is
            // pure cost: consumer NVIDIA drivers cap concurrent NVENC
            // sessions, and an idle one still holds a slot another window
            // could be using. The next request rebuilds it with an IDR
            // anyway, which a newly attached decoder needs regardless.
            if let Some(worker) = self.encoders.as_ref() {
                worker.forget(*id);
            }
        }
        self.streaming = wanted;
        self.sync_suspended();
    }

    /// Tell every application whether anyone can actually see it.
    ///
    /// A window nobody streams is invisible in every sense that matters, and
    /// xdg-shell has a word for that: the `suspended` toplevel state. Clients
    /// that honour it (Firefox, mpv, GTK and Qt applications, most games that
    /// pace themselves with frame callbacks) stop rendering entirely, which is
    /// the difference between "we stopped encoding it" and "it stopped costing
    /// GPU". The 1 Hz frame-callback heartbeat in `frame_throttle` stays even
    /// while suspended, so a client that ignores the state, or one waiting on
    /// a callback when the state flips, can never freeze for good; that is the
    /// failure mode Chromium once shipped against compositors that withheld
    /// callbacks outright.
    fn sync_suspended(&mut self) {
        for id in self.layout.all_ids() {
            let Some(window) = self.layout.window(id) else {
                continue;
            };
            // X11 windows have no such concept; the callback throttle still
            // covers them.
            let Some(toplevel) = window.toplevel() else {
                continue;
            };
            let suspend = !self.streaming.contains(&id);
            let changed = toplevel.with_pending_state(|state| {
                if suspend {
                    state.states.set(xdg_toplevel::State::Suspended)
                } else {
                    state.states.unset(xdg_toplevel::State::Suspended)
                }
            });
            if changed {
                toplevel.send_pending_configure();
            }
        }
    }

    /// How often this window's application deserves a "draw again" callback.
    ///
    /// Streamed windows are paced by the redraw loop, exactly as before.
    /// Everything else gets a callback at most once a second: enough that a
    /// client blocked on one always wakes up and one that ignores `suspended`
    /// only wastes a frame a second, but no longer an invitation to render a
    /// game at 60 fps behind a stream nobody is receiving.
    pub fn frame_throttle(&self, window: &Window) -> Option<std::time::Duration> {
        match self.layout.id_of(window) {
            Some(id) if self.streaming.contains(&id) => Some(std::time::Duration::ZERO),
            _ => Some(std::time::Duration::from_secs(1)),
        }
    }

    /// Start or stop capturing audio, to match whether anyone is listening.
    ///
    /// Idempotent, and called from every place that could change the answer.
    /// Capture is a process and a megabit and a half a second, so it exists
    /// exactly when at least one connected session has asked for it and not a
    /// moment longer.
    pub fn sync_audio_capture(&mut self) {
        let wanted = self.sessions.values().any(|s| s.audio);
        match (wanted, self.audio.is_some()) {
            (true, false) => {
                let Some(shell) = self.shell.as_ref() else {
                    return;
                };
                let clients = shell.sink();
                // The session's own device if we have one, so only what lwfa
                // is playing gets captured. An explicit device in the config
                // still wins, for anyone who wants something else.
                let private = self.audio_sink.ensure();
                let device = self.config.audio.device.clone().or_else(|| {
                    private.then(|| crate::sink::MONITOR.to_string())
                });
                let opus = self.everyone_decodes_opus();
                self.audio = crate::audio::start(device.as_deref(), opus, move |chunk| {
                    clients.send_audio(chunk);
                });
            }
            (true, true) => {
                // Already capturing. A listener joining or leaving can change
                // whether compression is safe, and that takes effect on the
                // next chunk rather than needing the capture restarted.
                if let Some(capture) = self.audio.as_ref() {
                    capture.set_opus(self.everyone_decodes_opus());
                }
            }
            (false, true) => {
                // `Capture` stops the process on drop.
                self.audio = None;
                tracing::info!("nobody is listening; audio capture stopped");
            }
            _ => {}
        }
    }

    /// Point the audio encoder at the bits it currently deserves.
    ///
    /// The most constrained listener wins, like the video codec: one capture
    /// is fanned out to everyone, so a request for less always beats a request
    /// for more. `Auto` listeners delegate to the video budget, on the theory
    /// that a link that cannot carry the picture cannot spare much for sound
    /// either; the rungs sit well below the video floor so audio degrades
    /// last, which is the right order, because broken audio is more jarring
    /// than a softer picture.
    ///
    /// Called when a listener changes its preference and when the budget
    /// moves. Applying is one atomic store; the encoder follows on its next
    /// 20ms chunk with no rebuild and no glitch.
    pub fn sync_audio_bitrate(&self) {
        let Some(capture) = self.audio.as_ref() else {
            return;
        };
        let explicit = self
            .sessions
            .values()
            .filter(|s| s.audio)
            .filter_map(|s| s.audio_quality.bits())
            .min();
        let bits = explicit.unwrap_or_else(|| {
            // Every listener is on Auto: follow the video budget.
            match self.bitrate.bitrate() {
                b if b >= 8_000_000 => 128_000,
                b if b >= 2_000_000 => 96_000,
                b if b >= 1_000_000 => 64_000,
                _ => 48_000,
            }
        });
        capture.set_bitrate(bits);
    }

    /// Whether every client that has answered can decode H.264.
    ///
    /// All, not any: one encode is shared by everyone watching a window, so a
    /// single client without a `VideoDecoder` (which is every browser reached
    /// over plain HTTP, since WebCodecs needs a secure context) decides the
    /// format. The alternative is encoding each window twice, and there are
    /// only eight NVENC sessions.
    ///
    /// Sessions that have not answered yet are *ignored* rather than counted as
    /// "cannot". Counting them made the answer flip to JPEG for the moment
    /// between a client connecting and its first `SetStreams`, and every flip
    /// clears all the encoder sessions.
    /// The codec to encode in, given everyone currently watching.
    ///
    /// `None` means JPEG: nobody has answered yet, or somebody can decode
    /// nothing. Sessions that have not yet said are ignored rather than
    /// assumed, since assuming either way is wrong for one of them. See
    /// [`lwfa_proto::Codec::best_for_all`].
    /// Can every listener decode Opus?
    ///
    /// One capture is fanned out to all of them, so compressing it when one
    /// cannot decode it would leave that one in silence. Only sessions that
    /// are actually listening are asked: somebody with audio switched off has
    /// no say in what the listeners get.
    pub fn everyone_decodes_opus(&self) -> bool {
        let mut listening = self.sessions.values().filter(|s| s.audio).peekable();
        listening.peek().is_some() && listening.all(|s| s.opus)
    }

    pub fn codec_for_all(&self) -> Option<lwfa_proto::Codec> {
        let answered: Vec<&[lwfa_proto::Codec]> = self
            .sessions
            .values()
            .filter_map(|s| s.codecs.as_deref())
            .collect();
        lwfa_proto::Codec::best_for_all(answered)
    }

    /// Broadcast the primary's arrangement to everyone following it.
    ///
    /// Followers cannot compute this for themselves: a window has one size, so
    /// there is one arrangement, and each of them fits it into its own viewport
    /// rather than deciding it.
    pub fn broadcast_layout(&self, from: lwfa_proto::SessionId, windows: &[lwfa_proto::WindowLayout]) {
        let size = self.layout.output_size();
        let message = ToShell::Layout {
            windows: windows.to_vec(),
            output: lwfa_proto::Output {
                width: size.w,
                height: size.h,
                scale: 1.0,
            },
        };
        for id in self.sessions.keys() {
            if *id != from {
                self.send_to_session(*id, message.clone());
            }
        }
    }

    /// The current arrangement, for one connection that is following it.
    pub fn send_layout_to(&self, session: lwfa_proto::SessionId) {
        let size = self.layout.output_size();
        self.send_to_session(
            session,
            ToShell::Layout {
                windows: self.last_layout.clone(),
                output: lwfa_proto::Output {
                    width: size.w,
                    height: size.h,
                    scale: 1.0,
                },
            },
        );
    }

    /// Full current state, sent on every shell connection.
    pub fn hello(&self, session: lwfa_proto::SessionId) -> ToShell {
        let size = self.layout.output_size();
        let mut windows: Vec<WindowInfo> = self
            .layout
            .placements()
            .iter()
            .filter_map(|(w, _)| self.layout.id_of(w))
            .filter_map(|id| self.window_info(id))
            .collect();

        // placements() only returns visible windows, and on a fresh connection
        // nothing is placed yet, so walk the registry for the rest.
        for id in self.all_window_ids() {
            if !windows.iter().any(|w| w.id == id) {
                if let Some(info) = self.window_info(id) {
                    windows.push(info);
                }
            }
        }
        windows.sort_by_key(|w| w.id);

        ToShell::Hello {
            protocol_version: PROTOCOL_VERSION,
            output: lwfa_proto::Output {
                width: size.w,
                height: size.h,
                scale: 1.0,
            },
            windows,
            focused: self.focused,
            permissions: self
                .sessions
                .get(&session)
                .map(|s| s.permissions.clone())
                .unwrap_or_else(|| lwfa_proto::Permissions {
                    mode: lwfa_proto::SessionMode::View,
                    allowed_apps: Some(Vec::new()),
                }),
            account: self
                .sessions
                .get(&session)
                .map(|s| s.account.clone())
                .unwrap_or_default(),
            session,
            primary: self.primary == Some(session),
            peers: self.peers(),
        }
    }

    fn all_window_ids(&self) -> Vec<WindowId> {
        self.layout.all_ids()
    }

    /// Something reasonable to focus after the focused window closes.
    pub fn topmost_window_id(&self) -> Option<WindowId> {
        self.layout
            .topmost()
            .or_else(|| self.layout.all_ids().last().copied())
    }

    pub fn forward_key_binding(&self, key: String, modifiers: Modifiers) {
        self.send_to_shell(ToShell::KeyBinding { key, modifiers });
    }

    // ---------------------------------------------------------------------
    // Focus
    // ---------------------------------------------------------------------

    /// Set keyboard focus, telling the shell only when it did not ask for this.
    ///
    /// `notify_shell` is false when the shell initiated the change, so a focus
    /// command does not echo back and start a loop.
    pub fn set_focus(&mut self, id: Option<WindowId>, notify_shell: bool) {
        self.focused = id;

        let target = id
            .and_then(|id| self.layout.window(id))
            .and_then(crate::focus::KeyboardFocus::of);

        // Activated state drives the client's own focus styling.
        for (window, _) in self.layout.placements() {
            // Compared through `target`, never `is_none() == is_none()`: an
            // X11 window has no `wl_surface` until Xwayland associates one, and
            // matching two absent surfaces would activate every window that had
            // not finished mapping.
            let is_focused = target
                .as_ref()
                .and_then(|t| t.wl_surface())
                .is_some_and(|t| window.wl_surface() == Some(t));
            window.set_activated(is_focused);
            match window.underlying_surface() {
                WindowSurface::Wayland(toplevel) => {
                    toplevel.send_pending_configure();
                }
                // `set_activated` already wrote the X11 property. There is no
                // second round trip to flush.
                WindowSurface::X11(_) => {}
            }
        }

        // X11 keeps its own stacking order, and a client that believes it is
        // behind something will not take input properly. Nothing to do for
        // Wayland, where the shell's z-order is the only order there is.
        let focused_x11 = id
            .and_then(|id| self.layout.window(id))
            .and_then(|w| w.x11_surface())
            .cloned();
        if let (Some(xwm), Some(x11)) = (self.xwm.as_mut(), focused_x11)
            && let Err(err) = xwm.raise_window(&x11)
        {
            tracing::warn!("failed to raise an X11 window: {err}");
        }

        if let Some(keyboard) = self.seat.get_keyboard() {
            let serial = smithay::utils::SERIAL_COUNTER.next_serial();
            keyboard.set_focus(self, target, serial);
        }

        if notify_shell {
            self.send_to_shell(ToShell::FocusChanged { id });
        }
    }

    /// Re-assert the current focus without changing it.
    ///
    /// Focus is delivered to a *surface*, and surfaces churn: a fullscreen
    /// toggle unmaps and remaps windows, and a launching game tears its
    /// window down and rebuilds it on the way from banner to windowed to
    /// fullscreen. When the surface under the focus goes, the seat's focus
    /// goes with it, but `focused` still names the window, so nothing ever
    /// sent the keyboard enter again. The window then believes it is in the
    /// background, and SDL games deliberately drop controller input for
    /// background windows: the pad went dead exactly when the window size
    /// was toggled, which is how this was found.
    ///
    /// Idempotent and cheap: re-activating an activated window changes no
    /// state and sends no configure, and the seat ignores a focus set to the
    /// target it already has. Called after every layout application, which
    /// is precisely when the churn happens.
    pub fn reassert_focus(&mut self) {
        let id = self.focused;
        // X11 needs more than idempotence. Its focus lives inside the X
        // server, and Smithay only issues SetInputFocus from the keyboard
        // *enter* handler, which a same-target set_focus never produces. A
        // game's own fullscreen dance moves X server focus around behind our
        // back, so the focus is bounced for X11 windows: the leave and
        // re-enter forces SetInputFocus and WM_TAKE_FOCUS to actually go
        // out. Proton runs every Steam game through XWayland, which makes
        // this the path that decides whether the controller works.
        let is_x11 = id
            .and_then(|id| self.layout.window(id))
            .is_some_and(|w| w.x11_surface().is_some());
        if is_x11 {
            if let Some(keyboard) = self.seat.get_keyboard() {
                let serial = smithay::utils::SERIAL_COUNTER.next_serial();
                keyboard.set_focus(self, None, serial);
            }
        }
        self.set_focus(id, false);
    }

    // ---------------------------------------------------------------------
    // Layout
    // ---------------------------------------------------------------------

    /// Recompute placements and push them into the scene.
    pub fn apply_layout(&mut self) {
        for (window, location) in self.layout.placements() {
            self.space.map_element(window, location, false);
        }
        // Windows the shell left out are unmapped rather than moved off-screen,
        // so they stop being rendered and stop consuming a frame callback.
        for window in self.layout.hidden() {
            self.space.unmap_elem(&window);
        }
    }

    /// Place windows when no shell is connected. See `layout::Mode::Safe`.
    pub fn apply_safe_mode(&mut self) {
        let focused = self
            .focused
            .or_else(|| self.all_window_ids().first().copied());
        if self.focused != focused {
            self.set_focus(focused, true);
        }
        let configures = self.layout.apply_safe_mode(focused);
        self.send_configures(configures);
        self.apply_layout();
    }

    pub fn send_configures(&mut self, configures: Vec<layout::PendingConfigure>) {
        let output = self.layout.output_size();
        for configure in configures {
            match configure.window.underlying_surface() {
                WindowSurface::Wayland(toplevel) => {
                    // Tell the client whether it is fullscreen, not just how
                    // big to be.
                    //
                    // A size alone is not enough. A window told to fill the
                    // screen still believes it is an ordinary window, so a
                    // video player keeps its page chrome and its fullscreen
                    // button keeps offering to do the thing it is already
                    // doing. The state is what makes the client change its own
                    // mind, and it is double-buffered with the size in the
                    // same configure so the two can never disagree.
                    //
                    // Derived from the geometry rather than tracked separately:
                    // a window covering the whole output *is* fullscreen,
                    // however it came to be that size. That means lwfa's own
                    // fullscreen control tells clients too, which it never used
                    // to. Same rule the shell uses to decide whether to round
                    // the corners; see `fillsOutput` there.
                    let fills = configure.rect.size.w >= output.w && configure.rect.size.h >= output.h;
                    toplevel.with_pending_state(|state| {
                        state.size = Some(configure.rect.size);
                        if fills {
                            state.states.set(xdg_toplevel::State::Fullscreen);
                        } else {
                            state.states.unset(xdg_toplevel::State::Fullscreen);
                        }
                    });
                    toplevel.send_pending_configure();
                }
                WindowSurface::X11(x11) => {
                    // X11 has no notion of a client that may decline, so this
                    // both asks and tells. Unlike xdg-shell it takes a
                    // position, which is what an override-redirect menu reads
                    // to work out where to put itself.
                    if let Err(err) = x11.configure(configure.rect) {
                        tracing::warn!("failed to configure an X11 window: {err}");
                    }
                }
            }
        }
    }

    /// Advance animations. Returns true while a redraw is still needed.
    pub fn tick_animations(&mut self) -> bool {
        let animating = self.layout.tick(std::time::Instant::now());
        if animating {
            self.apply_layout();
        }
        animating
    }

    /// Capture every visible window and write it out as a PNG.
    ///
    /// Debug only, driven by `LWFA_CAPTURE_DUMP`. This is how per-surface
    /// capture gets verified against what is actually on screen: if the
    /// channel order or the stride were wrong, it would be obvious here rather
    /// than showing up as garbled video three layers later.
    pub fn dump_captures(
        &mut self,
        renderer: &mut smithay::backend::renderer::gles::GlesRenderer,
        dir: &std::path::Path,
    ) {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        for (id, window, _) in self.layout.placements_with_ids() {
            let size = window.geometry().size.to_physical(1);
            let overlays = self.overlays_for(&window, (0, 0).into());
            let gpu_direct = self.config.stream.gpu_direct;
            let Some(frame) =
                self.capture
                    .capture(renderer, id, &window, size, &overlays, gpu_direct)
            else {
                continue; // unchanged since last capture
            };
            let Some(png) = frame.to_png() else { continue };
            let path = dir.join(format!("window-{}.png", id.0));
            if let Err(err) = std::fs::write(&path, png) {
                tracing::warn!("could not write {}: {err}", path.display());
            } else {
                tracing::info!(
                    "captured {id} -> {} ({}x{})",
                    path.display(),
                    frame.width,
                    frame.height
                );
            }
        }
    }

    /// Surfaces that visually belong to a window but are not part of it.
    ///
    /// Menus, tooltips, combo box drop-downs. On the local display these are
    /// ordinary scene elements and need nothing special. A remote frame is
    /// addressed by window id, though, and none of these have one, so left
    /// alone they simply never reach the browser: a menu that opens on the
    /// physical screen and nowhere else.
    ///
    /// Rather than invent ids for them, they are drawn into the frame of the
    /// window they belong to, at an offset relative to its origin. That keeps
    /// the protocol unchanged and makes them behave like part of the window,
    /// which for compositing purposes is what they are.
    ///
    /// The cost is clipping: the parts of a menu that hang outside the window's
    /// bounds are cut off, because the capture buffer is the window's size.
    /// Under scrollable tiling that is usually invisible, since columns are tall
    /// and menus open inside them. Growing the buffer to `bbox_with_popups`
    /// would fix it properly, but the stream's dimensions would stop matching
    /// the window's and the shell would need an offset to place it: a protocol
    /// change, worth doing when a real menu is seen to be cut off.
    ///
    /// `loc` is the window's position in the space, needed to work out where an
    /// override-redirect X11 window sits relative to it.
    fn overlays_for(
        &self,
        window: &Window,
        loc: Point<i32, Logical>,
    ) -> Vec<(WlSurface, Point<i32, Logical>)> {
        let mut overlays = Vec::new();

        // Wayland: xdg popups, which the popup manager already tracks against
        // their parent surface and gives us an offset for.
        if let Some(surface) = window.wl_surface() {
            for (popup, offset) in PopupManager::popups_for_surface(&surface) {
                // `popups_for_surface` measures to the popup's *window*
                // geometry, which excludes its shadow; the surface starts
                // earlier. Subtracting puts the surface where it belongs.
                overlays.push((popup.wl_surface().clone(), offset - popup.geometry().loc));
            }
        }

        // X11: override-redirect windows, which opt out of window management
        // and place themselves in absolute coordinates. They have no parent
        // link worth trusting (plenty of toolkits never set WM_TRANSIENT_FOR),
        // so ownership is decided geometrically, by which window the popup's
        // top-left corner lands in. That gives exactly one owner, which
        // matters: shared ownership would draw the same menu into two streams.
        let bounds = Rectangle::new(loc, window.geometry().size);
        for other in self.space.elements() {
            let Some(x11) = other.x11_surface() else {
                continue;
            };
            if !x11.is_override_redirect() {
                continue;
            }
            let Some(surface) = other.wl_surface() else {
                continue;
            };
            let at = x11.geometry().loc;
            if !bounds.contains(at) {
                continue;
            }
            overlays.push((surface.into_owned(), at - loc));
        }

        overlays
    }

    /// The accounts database, but only for a session that may administer it.
    ///
    /// Account administration is the owner's alone. A session that authenticated
    /// with a named account can read its own permissions from `Hello`, and that
    /// is all: letting a view-only guest list or edit accounts would make the
    /// whole permission system decorative.
    pub fn accounts_for_owner(
        &self,
        session: lwfa_proto::SessionId,
        request: &str,
    ) -> Result<Arc<std::sync::Mutex<crate::accounts::Accounts>>, ToShell> {
        if self
            .sessions
            .get(&session)
            .map(|s| s.account.as_str())
            != Some("owner")
        {
            return Err(ToShell::Error {
                request: request.to_string(),
                message: "only the owner may manage accounts".to_string(),
            });
        }
        self.accounts.clone().ok_or_else(|| ToShell::Error {
            request: request.to_string(),
            message: "the accounts database is not available".to_string(),
        })
    }

    /// Send the current account list, after a change.
    pub fn reply_accounts(&mut self) {
        let Some(db) = self.accounts.clone() else {
            return;
        };
        let accounts = db
            .lock()
            .ok()
            .and_then(|db| db.list().ok())
            .unwrap_or_default()
            .into_iter()
            .map(|a| lwfa_proto::AccountInfo {
                id: a.id,
                name: a.name,
                permissions: a.permissions,
            })
            .collect();
        self.send_to_shell(ToShell::Accounts { accounts });
    }

    /// Capture the streaming windows and queue them for the shell.
    ///
    /// Three things keep this from dominating the frame:
    ///
    /// 1. Only windows the shell asked for are considered at all, which under
    ///    scrollable tiling means roughly "what fits in the viewport".
    /// 2. `SurfaceCapture` skips anything that has not committed, so idle
    ///    windows cost nothing.
    /// 3. Backpressure. If the socket is behind, frames are not captured in the
    ///    first place, so a slow link costs no GPU read-back rather than
    ///    building an unbounded queue.
    pub fn stream_frames(&mut self, renderer: &mut smithay::backend::renderer::gles::GlesRenderer) {
        if self.streaming.is_empty() {
            return;
        }
        self.warn_if_nothing_ever_arrived();
        let Some(shell) = self.shell.as_ref() else {
            return;
        };
        let Some(worker) = self.encoders.as_ref() else {
            return;
        };

        // Backpressure is the congestion signal, but only the *network's*.
        //
        // A socket that is not accepting frames means the far end or the path
        // to it cannot keep up, and that is what the bitrate controller
        // adapts to. The encoder's own queue filling is a different fact: it
        // happens during session rebuilds, which the controller's own changes
        // cause, and reading it as congestion made every climb refute itself.
        // A busy encoder still skips capture below; it just is not evidence
        // about the link.
        let congested = !shell.can_accept_frame();
        let skip = congested || !worker.has_capacity();
        let now = std::time::Instant::now();
        let budget_changed = self.bitrate.observe(congested, now).is_some();

        // Divide the budget between the windows actually being streamed, giving
        // the focused one the larger share.
        //
        // The budget is a *total*: each window has its own encoder session, and
        // the rate handed to a session is that session's ceiling, so giving them
        // all the same number multiplies it by the window count. The connection
        // experiences the sum. See `bitrate::allocate`.
        let streamed: Vec<WindowId> = {
            let mut ids: Vec<WindowId> = self.streaming.iter().copied().collect();
            // Sorted so the allocation is stable frame to frame and a set's
            // iteration order cannot make windows swap shares.
            ids.sort_unstable();
            ids
        };
        let attended = self.attention.observe(self.focused, now);
        if budget_changed {
            // The one place the budget moves, so the one log line that tells
            // the whole adaptation story for a session.
            tracing::info!(
                "stream budget is now {} kbit/s ({})",
                self.bitrate.bitrate() / 1000,
                if congested { "link congested" } else { "link clear" },
            );
            // Auto-quality audio follows the same budget.
            self.sync_audio_bitrate();
        }
        if budget_changed || streamed != self.streamed_last || attended != self.attended_last {
            let budget = self.bitrate.bitrate();
            let rates = crate::bitrate::allocate(budget, &streamed, attended);
            worker.set_rates(rates, budget);
            self.streamed_last = streamed;
            self.attended_last = attended;
        }

        if skip {
            return;
        }

        // Read once, not per window per frame: `var_os` takes the process
        // environment lock and allocates every call.
        static PROFILE: std::sync::LazyLock<bool> =
            std::sync::LazyLock::new(|| std::env::var_os("LWFA_PROFILE").is_some());

        let targets: Vec<(WindowId, Window, Point<i32, Logical>)> = self
            .layout
            .placements_with_ids()
            .into_iter()
            .filter(|(id, _, _)| self.streaming.contains(id))
            .collect();

        for (id, window, loc) in targets {
            // Re-checked per window: one large frame can fill either queue.
            // Stopping here loses nothing. A readback in flight stays parked
            // in the capture until a pass with room, and damage not yet read
            // back keeps its commit counters, so both are picked up whenever
            // the queues drain.
            let (Some(shell), Some(worker)) = (self.shell.as_ref(), self.encoders.as_ref()) else {
                return;
            };
            if !shell.can_accept_frame() || !worker.has_capacity() {
                return;
            }

            // The unfocused capture cap. See `capture_pacing` on the struct.
            // Skipping costs nothing: damage keeps its commit counters, so
            // whatever changed is picked up whole on the next eligible pass.
            if Some(id) != self.focused {
                if let Some(last) = self.capture_pacing.get(&id) {
                    if now.duration_since(*last) < UNFOCUSED_CAPTURE_INTERVAL {
                        continue;
                    }
                }
            }

            let size = window.geometry().size.to_physical(1);
            let t0 = PROFILE.then(std::time::Instant::now);

            let overlays = self.overlays_for(&window, loc);
            let gpu_direct = self.config.stream.gpu_direct;
            let Some(frame) =
                self.capture
                    .capture(renderer, id, &window, size, &overlays, gpu_direct)
            else {
                continue;
            };
            self.capture_pacing.insert(id, now);

            if let Some(t0) = t0 {
                tracing::info!(
                    "profile {id} {}x{}: capture+readback {:.2}ms",
                    frame.width,
                    frame.height,
                    t0.elapsed().as_secs_f64() * 1000.0,
                );
            }

            // Hand off. Encoding, and in particular opening an NVENC session,
            // happens on the encoder thread so a 160ms session build cannot
            // stall compositing.
            // Whatever else happens to this frame, the window has now produced
            // one, which is the thing `warn_if_nothing_ever_arrived` watches.
            self.awaiting_first_frame.remove(&id);

            if let Some(worker) = self.encoders.as_ref() {
                if !worker.submit(frame) {
                    // Should not happen: capacity was checked above and only
                    // this thread submits. Skip just this window rather than
                    // abandoning the rest of the pass.
                    tracing::trace!("encoder busy, dropped a frame for {id}");
                    continue;
                }
            }
        }
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.space
            .element_under(pos)
            .and_then(|(window, location)| {
                window
                    .surface_under(pos - location.to_f64(), WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + location).to_f64()))
            })
    }
}

/// The event loop's data type.
///
/// An alias, not a wrapper. `X11Wm::start_wm` requires the loop data to
/// implement `XwmHandler`, and Smithay's protocol handlers are all implemented
/// on `Lwfa`, so the two have to be the same type. The wrapper this replaces
/// held a second copy of `display_handle` and nothing else.
pub type CalloopData = Lwfa;

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
