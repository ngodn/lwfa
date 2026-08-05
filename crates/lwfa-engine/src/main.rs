//! lwfa compositor entry point.
//!
//! Milestone 3: the shell owns layout. The engine registers windows, reports
//! them over the shell protocol, and applies the geometry that comes back. When
//! no shell is connected it falls back to safe mode (focused window
//! full-screen), which is deliberately not a layout engine. See
//! docs/architecture.md.
//!
//! Engine-level keybinds (Alt, not Super, because the host compositor claims
//! Super in the nested backend):
//!   Alt+Return   spawn a terminal
//!   Alt+Q        quit
//!
//! Everything else modified with Alt is forwarded to the shell, which decides
//! what it means. Focus order is layout policy, and policy lives in the shell.

mod accounts;
mod apps;
mod audio;
mod auth;
mod capture;
mod config;
mod cuda;
mod encode;
mod focus;
mod bitrate;
mod gamepad;
mod outside;
mod handlers;
mod http;
mod icons;
mod input;
mod layout;
mod remote_input;
mod shell;
mod sink;
mod state;
mod winit;
mod xfocus;

use lwfa_proto::{ToEngine, ToShell};
use smithay::reexports::calloop::EventLoop;
use smithay::reexports::calloop::channel;
use smithay::reexports::wayland_server::Display;
use smithay::xwayland::{X11Wm, XWayland, XWaylandEvent};

use crate::layout::Mode;
use crate::shell::{ShellEvent, ShellLink};
use crate::state::{CalloopData, Lwfa};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match tracing_subscriber::EnvFilter::try_from_default_env() {
        Ok(env_filter) => tracing_subscriber::fmt().with_env_filter(env_filter).init(),
        Err(_) => tracing_subscriber::fmt().init(),
    }

    let mut event_loop: EventLoop<'static, CalloopData> = EventLoop::try_new()?;
    let display: Display<Lwfa> = Display::new()?;
    let mut data = Lwfa::new(&mut event_loop, display);

    winit::init_winit(&mut event_loop, &mut data)?;
    init_shell_link(&mut event_loop, &mut data)?;
    init_xwayland(&mut event_loop, &mut data);

    // The focus guardian's tick: once a second, repair the X server's input
    // focus if it has fallen on nothing. See `xfocus.rs` for the story.
    //
    // The same tick reaps exited children. Everything the engine launches is
    // its child, and a child that exits stays a zombie until someone waits on
    // it. Nothing did, so every application the user ever quit left an entry
    // holding a pid. Doing it here rather than with a SIGCHLD handler keeps
    // the crate free of unsafe code, and once a second is far more often than
    // applications exit.
    {
        use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
        event_loop
            .handle()
            .insert_source(
                Timer::from_duration(std::time::Duration::from_secs(1)),
                |_, _, data| {
                    data.guard_x_focus();
                    reap_children();
                    TimeoutAction::ToDuration(std::time::Duration::from_secs(1))
                },
            )
            .map_err(|err| format!("failed to insert the focus guardian: {err}"))?;
    }

    tracing::info!("lwfa running on WAYLAND_DISPLAY={:?}", data.socket_name);

    // A fresh session opens a terminal so there is something in it. Without
    // one the shell shows an empty workspace, which looks the same whether
    // nothing was meant to start or the terminal is simply not installed.
    //
    // So the missing case is said out loud. `Alt+Return` is dead for the same
    // reason and would otherwise be the second confusing thing.
    if let Some((message, serious)) = data.config.terminal_report() {
        if serious {
            tracing::warn!("{message}");
        } else {
            tracing::info!("{message}");
        }
    }
    if data.config.terminal_available() && data.config.autostart_terminal() {
        data.spawn_terminal();
    }
    data.ensure_persistent_gamepad();

    event_loop.run(None, &mut data, |_| {})?;

    Ok(())
}

/// Collect any children that have exited, without blocking.
///
/// Loops because several may have gone since the last tick, and stops on the
/// first "nothing waiting" so a tick never spins. `ECHILD` simply means there
/// are no children at all, which is the ordinary state of an idle session.
fn reap_children() {
    use rustix::process::{WaitOptions, waitpid};
    loop {
        match waitpid(None, WaitOptions::NOHANG) {
            Ok(Some((pid, _status))) => tracing::debug!("reaped child {pid:?}"),
            Ok(None) | Err(_) => break,
        }
    }
}

/// Start Xwayland so X11 clients have somewhere to connect.
///
/// Never fatal. A machine without Xwayland installed, or one where it fails to
/// start, still gets a working compositor for native Wayland clients; it just
/// cannot run Steam. `LWFA_NO_XWAYLAND` skips it deliberately.
///
/// The server is started eagerly rather than on the first X11 connection.
/// Lazy startup is what most compositors do and it does save ~30MB, but it
/// means `DISPLAY` is unset when early clients are spawned, and a client that
/// checks once at startup will already have decided X11 is unavailable.
fn init_xwayland(event_loop: &mut EventLoop<'static, CalloopData>, data: &mut CalloopData) {
    if !data.config.xwayland() {
        tracing::info!("xwayland disabled; X11 clients will not run");
        return;
    }

    let (xwayland, client) = match XWayland::spawn(
        &data.display_handle.clone(),
        None,
        std::iter::empty::<(String, String)>(),
        true,
        std::process::Stdio::null(),
        std::process::Stdio::null(),
        |_| (),
    ) {
        Ok(started) => started,
        Err(err) => {
            tracing::warn!("could not start xwayland: {err}. X11 clients will not run.");
            return;
        }
    };

    let handle = event_loop.handle();
    let ret = handle.insert_source(xwayland, move |event, _, data| match event {
        XWaylandEvent::Ready {
            x11_socket,
            display_number,
        } => {
            // Only now is DISPLAY meaningful. Held on the state rather than put
            // in the environment; see `Lwfa::spawn` for why.
            data.xdisplay = Some(display_number);
            data.xfocus = Some(crate::xfocus::Guardian::new(display_number));
            match X11Wm::start_wm(data.loop_handle.clone(), x11_socket, client.clone()) {
                Ok(wm) => {
                    data.xwm = Some(wm);
                    tracing::info!("xwayland ready on DISPLAY=:{display_number}");
                }
                Err(err) => {
                    tracing::warn!("could not attach the X11 window manager: {err}");
                    data.xdisplay = None;
                }
            }
        }
        XWaylandEvent::Error => {
            tracing::warn!("xwayland failed to start; X11 clients will not run");
            data.xdisplay = None;
        }
    });
    if let Err(err) = ret {
        tracing::warn!("could not watch xwayland: {err}. X11 clients will not run.");
    }
}

/// Start the shell listener and route its events into the compositor.
fn init_shell_link(
    event_loop: &mut EventLoop<'static, CalloopData>,
    data: &mut CalloopData,
) -> Result<(), Box<dyn std::error::Error>> {
    // Environment first, then .env, then configs/defaults.toml.
    let addr = data.config.shell_addr();
    let (events_tx, events_rx) = channel::channel::<ShellEvent>();

    let token = match auth::resolve_token() {
        Ok(token) => token,
        Err(err) => {
            // Refusing to start beats starting without authentication on a
            // socket that can spawn processes.
            tracing::error!("could not establish a shell token: {err}");
            return Err(err.into());
        }
    };

    // Not fatal if it fails: the owner's AUTH_PASS still works, so a broken
    // database means "no named accounts" rather than "no way in".
    let accounts = match crate::accounts::Accounts::open() {
        Ok(db) => Some(std::sync::Arc::new(std::sync::Mutex::new(db))),
        Err(err) => {
            tracing::warn!(
                "could not open the accounts database: {err}. Only AUTH_PASS will work."
            );
            None
        }
    };
    data.accounts = accounts.clone();

    // Resolved once here rather than per request, so a production run missing
    // its page says so at startup instead of answering 503 forever with nobody
    // watching the log.
    let shell_dir = data.config.shell_dir();
    match &shell_dir {
        Some(dir) => tracing::info!("serving the shell from {}", dir.display()),
        None => tracing::warn!(
            "no built shell found, so the engine serves the protocol only. Run \
             `pnpm run build`, or use the dev server for the page."
        ),
    }

    let (link, bound, shared_token) = match ShellLink::bind(
        &addr,
        token.clone(),
        accounts,
        events_tx,
        data.config.stream.max_frames_in_flight,
        shell_dir,
    ) {
        Ok(bound) => bound,
        Err(err) => {
            // Not fatal. Safe mode still gives a usable compositor, and a bad
            // LWFA_SHELL_ADDR should not stop the machine from booting to
            // something you can fix it from.
            tracing::error!("could not listen for a shell on {addr}: {err}. Running in safe mode.");
            return Ok(());
        }
    };
    // The encoder needs a frame sink, so it is spawned once the link exists.
    match crate::encode::EncodeWorker::spawn(link.sink(), data.config.stream.clone()) {
        Ok(worker) => data.encoders = Some(worker),
        Err(err) => {
            // Not fatal: the compositor still works, there is just nothing to
            // send a remote shell.
            tracing::error!("could not start the encoder thread: {err}. Streaming disabled.");
        }
    }
    data.shell = Some(link);
    announce(bound, &token);
    watch_dotenv(event_loop, shared_token);

    event_loop
        .handle()
        .insert_source(events_rx, |event, _, data| {
            let channel::Event::Msg(event) = event else {
                return;
            };
            handle_shell_event(data, event);
        })
        .map_err(|err| format!("failed to insert the shell event source: {err}"))?;

    Ok(())
}

/// Re-read `AUTH_PASS` when `.env` changes.
///
/// Without this, changing the password means restarting the compositor, which
/// means killing every window in the session. That is a bad trade for a typo,
/// and it is exactly what you want to do after typing the password wrong on a
/// tablet a few times.
///
/// Polled rather than inotified: one `stat` every two seconds costs nothing
/// measurable, and it keeps working when an editor replaces the file rather
/// than writing it in place, which is what most editors do and what breaks a
/// naive inotify watch on the file itself.
///
/// Only the *next* connection is affected. Whoever is already connected stays
/// connected, which is deliberate: changing the password should not knock the
/// tablet you are holding off the session.
fn watch_dotenv(
    event_loop: &mut EventLoop<'static, CalloopData>,
    token: crate::shell::SharedToken,
) {
    const POLL: std::time::Duration = std::time::Duration::from_secs(2);

    let Some(path) = auth::dotenv_file() else {
        return;
    };
    let mut seen = std::fs::metadata(&path).and_then(|m| m.modified()).ok();

    let inserted = event_loop.handle().insert_source(
        smithay::reexports::calloop::timer::Timer::from_duration(POLL),
        move |_, _, _: &mut CalloopData| {
            let now = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            if now != seen {
                seen = now;
                match auth::resolve_token() {
                    Ok(next) => {
                        let mut current = token.lock().unwrap();
                        if *current != next {
                            *current = next;
                            tracing::info!(
                                "{} changed in .env; the new one is live for the next connection",
                                auth::PASS_VAR
                            );
                        }
                    }
                    // Keep the old password rather than locking everyone out
                    // over a half-written file.
                    Err(err) => tracing::warn!("could not re-read {}: {err}", path.display()),
                }
            }
            smithay::reexports::calloop::timer::TimeoutAction::ToDuration(POLL)
        },
    );
    if let Err(err) = inserted {
        tracing::warn!("could not watch .env: {err}. A password change will need a restart.");
    }
}

/// Tell the user where to connect, and warn if the socket left this machine.
fn announce(bound: std::net::SocketAddr, token: &str) {
    tracing::info!("shell protocol listening on ws://{bound}");

    if auth::is_exposed(&bound) {
        // Worth being blunt about: the token stops casual access, but there is
        // no transport encryption, so anyone who can watch the traffic can
        // replay it and read every keystroke.
        tracing::warn!(
            "the shell socket is reachable from the network. The token gates access, \
             but there is NO encryption: keystrokes and frames are readable on the wire, \
             and the token itself can be replayed by anyone watching. Only do this on a \
             network you trust."
        );
    }

    // A URL that can be pasted into a tablet, rather than three values to
    // assemble by hand.
    let host = if bound.ip().is_unspecified() {
        auth::lan_address().map(|ip| ip.to_string())
    } else {
        Some(bound.ip().to_string())
    };
    // One port, so the printed URL is the port the engine actually bound.
    if let Some(host) = host {
        tracing::info!("open the shell at:  http://{host}:{}/?token={token}", bound.port());
    } else {
        tracing::info!("shell password: {token}");
    }

    // The best guess is a guess. On a machine with a VPN, Docker and VMware
    // there are a dozen addresses and only one is the LAN, so show the
    // alternatives rather than leaving someone poking at a dead link.
    let others = auth::lan_addresses();
    if others.len() > 1 {
        let list = others
            .iter()
            .map(|(iface, ip)| format!("{ip} ({iface})"))
            .collect::<Vec<_>>()
            .join(", ");
        tracing::info!("other addresses on this machine: {list}");
    }
}

fn handle_shell_event(state: &mut Lwfa, event: ShellEvent) {
    // Every shell event, at debug. Cheap, off by default, and the one thing
    // that turns "a client connected but nothing happened" from a guess into a
    // one-line answer: it says whether the compositor saw the event at all,
    // which is the fork in the road between a socket problem and a handler bug.
    tracing::debug!("shell event: {event:?}");
    match event {
        ShellEvent::Connected {
            session,
            permissions,
            account,
            device,
            client,
        } => {
            let interactive = permissions.may_interact();

            // Whatever the grace was holding the world together for, it is
            // here. See `begin_session_grace`.
            state.cancel_session_grace();

            // A refresh, not a second device.
            //
            // A browser that reloads opens its new socket before the old one
            // has finished dying, and in development React opens two on every
            // mount anyway. Without this the engine sees each of those as
            // another viewer: it resyncs them all, invalidates every capture
            // per connection, and counts them as live listeners. Worse, until
            // a new session says what it can decode it used to drag the whole
            // session down to JPEG, and every such flip tears down all the
            // NVENC sessions at 90-160ms each.
            //
            // So a connection carrying the same browser id as a live one
            // *replaces* it. The old socket is closed rather than left to time
            // out, which is what stops two of them being counted at once.
            if !client.is_empty() {
                let stale: Vec<lwfa_proto::SessionId> = state
                    .sessions
                    .iter()
                    .filter(|(id, s)| **id != session && s.client == client)
                    .map(|(id, _)| *id)
                    .collect();
                for old in stale {
                    // A reconnection that arrives within a moment of the last
                    // one is not a page reload, it is a fight.
                    //
                    // Two connections of the same browser can each supersede
                    // the other, take that as a reason to reconnect, and trade
                    // the session forever. That happened: a new session every
                    // 290ms, two hundred deep, restarting audio capture on
                    // every pass. The client no longer retries when it is
                    // superseded, so this should not recur, and it is worth
                    // naming out loud if it ever does rather than leaving
                    // somebody to read two hundred log lines to notice.
                    let churning = state
                        .sessions
                        .get(&old)
                        .is_some_and(|s| s.since.elapsed() < RECONNECT_STORM_WINDOW);
                    if churning {
                        tracing::warn!(
                            "session {session} replaced session {old} after only {:?}: this \
                             browser is reconnecting in a loop, which usually means two tabs \
                             or windows of it are both trying to hold the session",
                            state.sessions.get(&old).map(|s| s.since.elapsed()).unwrap_or_default(),
                        );
                    } else {
                        tracing::info!(
                            "session {session} is session {old} reconnecting; dropping the old one"
                        );
                    }
                    state.sessions.remove(&old);
                    if state.primary == Some(old) {
                        // Hand the wheel straight to the reconnection rather
                        // than letting it fall to some other device for the
                        // moment in between.
                        state.primary = None;
                    }
                    if let Some(shell) = state.shell.as_ref() {
                        // Superseded, not kicked: the client must keep its
                        // newer socket rather than stop reconnecting.
                        shell.evict(old, true);
                    }
                }
            }
            state.sessions.insert(
                session,
                new_session(permissions, account, device, client),
            );
            state.layout.set_mode(Mode::Shell);

            // The first connection that can actually drive takes the wheel. A
            // view-only session never does: it has no right to move anything,
            // so making it primary would freeze the layout for everyone.
            if state.primary.is_none() && interactive {
                state.primary = Some(session);
            }

            // A browser attaching mid-stream cannot decode until it sees an
            // IDR, so ask every live encoder for one now rather than making it
            // wait up to a whole GOP.
            if let Some(worker) = state.encoders.as_ref() {
                worker.request_keyframes();
            }
            // And force a capture of every window, because an idle one would
            // otherwise never produce a frame for the new client to decode.
            state.capture.invalidate_all();

            let hello = state.hello(session);
            if let Some(shell) = state.shell.as_ref() {
                shell.send_to(session, hello);
            }
            // A device that joined into an existing session is following, and
            // has nothing to draw until it is told the arrangement. Waiting for
            // the primary to move something would mean an empty desktop for as
            // long as nobody touches anything.
            if state.primary != Some(session) {
                state.send_layout_to(session);
            }
            // The new arrival also has to reach everyone else's connections
            // list, and it may have just changed who is primary.
            state.announce_peers();
            tracing::info!(
                "session {session} joined; {} connected, primary is {:?}",
                state.sessions.len(),
                state.primary
            );
        }

        ShellEvent::Disconnected(session) => {
            state.sessions.remove(&session);
            // Parked, not unplugged: a network flap must not cost the game
            // its controller device. Inputs are released on the way into the
            // parking spot, so a tab closed mid-press does not leave a
            // character running into a wall. See `park_gamepad`.
            state.park_gamepad(session);
            // The grace must begin *before* the audio sync below looks at
            // the session list, or the sync sees "empty, no grace" and
            // tears the capture down in the same breath the grace was
            // meant to keep it alive. That ordering bug was a six-second
            // audio dropout on every reconnect.
            let now_empty = state.sessions.is_empty();
            if now_empty {
                state.begin_session_grace();
                tracing::info!("last shell gone; holding the session for 45s");
            }
            // The last listener leaving stops the capture, so an unattended
            // session is not holding a recording process open. During the
            // grace it keeps running; see `sync_audio_capture`.
            state.sync_audio_capture();
            // Streams are per connection and the registry already forgot this
            // one, so the union simply shrinks. Recomputing rather than
            // clearing is what keeps the *other* clients streaming.
            state.recompute_streams();

            if state.primary == Some(session) {
                // Hand the wheel to whoever is left, preferring a session that
                // can actually use it. Without this the desktop would keep
                // running with nobody able to move a window.
                state.primary = state
                    .sessions
                    .iter()
                    .find(|(_, s)| s.permissions.may_interact())
                    .map(|(id, _)| *id);
                if let Some(next) = state.primary {
                    state.send_to_session(next, ToShell::Role { primary: true });
                    // It has been following someone else's arrangement, so it
                    // needs the window list to build its own from.
                    let hello = state.hello(next);
                    state.send_to_session(next, hello);
                }
            }

            if !now_empty {
                state.announce_peers();
                tracing::info!("session {session} left; {} left", state.sessions.len());
            }
        }

        ShellEvent::Message(session, message) => {
            // Enforced here, at the one point every shell message passes
            // through, rather than at each handler. A permission checked in
            // nine places is a permission that will be missing from the tenth.
            if !permitted(state, session, &message) {
                tracing::debug!(
                    "dropped {} from session {session}, which may not do that",
                    kind_of(&message),
                );
                return;
            }
            handle_shell_message(state, session, message)
        }
    }
}

/// A reconnection sooner than this after the last is a loop, not a reload.
const RECONNECT_STORM_WINDOW: std::time::Duration = std::time::Duration::from_millis(1500);

fn new_session(
    permissions: lwfa_proto::Permissions,
    account: String,
    device: String,
    client: String,
) -> state::Session {
    state::Session {
        permissions,
        account,
        device,
        since: std::time::Instant::now(),
        client,
        // Unknown until the client says so in `SetStreams`. Not `false`:
        // see `codec_for_all`.
        codecs: None,
        // Silent until asked. Capturing costs a process and 1.5 Mbit/s per
        // listener, and a device that connects should not start broadcasting
        // the room because it happened to open a page.
        audio: false,
        opus: false,
        audio_quality: lwfa_proto::AudioQuality::default(),
    }
}

/// Whether this session is allowed to send this.
///
/// A thin lookup around [`allowed`], which holds the actual rule and is pure so
/// it can be tested. This is a security boundary, and a security boundary that
/// can only be exercised by standing up a compositor is a security boundary
/// nobody exercises.
#[cfg_attr(test, allow(dead_code))]
fn permitted(state: &Lwfa, session: lwfa_proto::SessionId, message: &ToEngine) -> bool {
    // No session, no authority. This is the state between a socket closing and
    // the compositor hearing about it, and it must fail closed.
    let Some(who) = state.sessions.get(&session) else {
        return false;
    };
    allowed(who, state.primary == Some(session), message)
}

/// The rule itself.
///
/// Read-only traffic is always fine: asking for pixels is what a viewer *is*.
/// Anything that reaches the machine underneath, whether by typing into it,
/// clicking on it, closing something or starting something, requires interact.
///
/// Layout is separate again, and gated on being *primary* rather than on
/// permissions. Not because a follower is untrusted, but because a window has
/// exactly one size: two devices pushing their own arrangements would each undo
/// the other's, forever.
fn allowed(who: &state::Session, is_primary: bool, message: &ToEngine) -> bool {
    match message {
        // Streaming is the viewer's own business: they decide what their own
        // screen shows, not what the machine does.
        //
        // Audio is listed here rather than behind interact for the same reason
        // pixels are: a view-only session exists to watch the machine, and a
        // desktop you can see but not hear is a strange half-thing. Anyone with
        // a session can already see every window; hearing them is not a
        // separate escalation. Whether to hand out a session at all is the
        // decision, and that is what accounts are for.
        ToEngine::SetAudio { .. }
        | ToEngine::SetStreams { .. }
        | ToEngine::FocusWindow { .. }
        | ToEngine::ListApps
        | ToEngine::RequestIcons { .. } => true,

        // Liveness is universal: a view-only session needs to know whether its
        // socket is real exactly as much as anyone else does.
        ToEngine::Ping => true,

        ToEngine::SetLayout { .. } | ToEngine::SetViewport { .. } => is_primary,

        // Taking the wheel needs the right to use it.
        ToEngine::TakeControl => who.permissions.may_interact(),

        // Deciding who else is on your desktop is the owner's alone. Not
        // gated on interact: a named account with full interact rights still
        // must not be able to kick the owner off their own machine.
        ToEngine::EndSession { .. } | ToEngine::SetSessionMode { .. } => who.account == "owner",

        // Administering accounts is the owner's alone, and is refused out loud
        // rather than dropped: the UI is waiting on a reply. See
        // `accounts_for_owner`.
        ToEngine::ListAccounts
        | ToEngine::CreateAccount { .. }
        | ToEngine::UpdateAccount { .. }
        | ToEngine::DeleteAccount { .. } => true,

        // Launching is gated twice: on interact, and on the app list.
        ToEngine::Spawn { command, .. } | ToEngine::CloseAndSpawn { command, .. } => {
            who.permissions.may_interact() && Lwfa::may_spawn(&who.permissions, command)
        }

        // A controller is input, so it needs the same right as a keypress.
        ToEngine::SetGamepad { .. }
        | ToEngine::GamepadButton { .. }
        | ToEngine::GamepadAxis { .. } => who.permissions.may_interact(),

        // Everything else drives the machine.
        _ => who.permissions.may_interact(),
    }
}

fn kind_of(message: &ToEngine) -> &'static str {
    match message {
        ToEngine::Spawn { .. } => "spawn",
        ToEngine::CloseAndSpawn { .. } => "closeAndSpawn",
        ToEngine::CloseWindow { .. } => "closeWindow",
        ToEngine::QuitApp { .. } => "quitApp",
        ToEngine::Key { .. } => "key",
        ToEngine::PointerButton { .. } | ToEngine::PointerMotion { .. } => "pointer",
        ToEngine::TouchDown { .. } | ToEngine::TouchMotion { .. } | ToEngine::TouchUp { .. } => {
            "touch"
        }
        _ => "message",
    }
}

fn handle_shell_message(state: &mut Lwfa, session: lwfa_proto::SessionId, message: ToEngine) {
    match message {
        ToEngine::SetLayout { windows, animate } => {
            let configures = state.layout.apply(
                &windows,
                animate.map(|a| a.spring),
                std::time::Instant::now(),
            );
            state.send_configures(configures);
            state.apply_layout();
            // The churn a layout causes can drop the seat's focus while the
            // focused window is unchanged, and a game whose window lost
            // focus stops reading the controller. Deferred so a burst of
            // layouts (a window opening, a fullscreen dance) settles first;
            // see `schedule_reassert`.
            state.schedule_reassert();
            // Everyone else is following this arrangement rather than deciding
            // their own, so they have to be told what it is. Only the primary
            // reaches this arm; `permitted` dropped the rest.
            state.broadcast_layout(session, &windows);
            state.last_layout = windows;
        }
        ToEngine::FocusWindow { id } => {
            // notify_shell false: the shell asked for this, so echoing it
            // back would be noise and could start a loop.
            state.set_focus(Some(id), false);
        }
        ToEngine::CloseWindow { id } => state.request_close(id),
        ToEngine::QuitApp { id } => state.quit_app(id, session),
        ToEngine::SetViewport {
            width,
            height,
            scale,
        } => {
            // Guarded against nonsense, not against small. A hidden tab or a
            // mid-rotation measurement can report zero, and resizing the
            // compositor to nothing takes every window with it. The floor is
            // deliberately far below any real device: the rail eats ~64px, so
            // a 320px phone in portrait offers ~256, and a guard set at phone
            // width would reject exactly the devices this project exists for.
            if width < 160 || height < 160 {
                tracing::debug!("ignoring an implausible viewport {width}x{height}");
                return;
            }
            let scale = if scale.is_finite() && scale > 0.0 {
                scale.clamp(1.0, 3.0)
            } else {
                1.0
            };
            if state.viewport_override == Some((width, height, scale)) {
                return;
            }
            state.viewport_override = Some((width, height, scale));
            match state.resize_output.clone() {
                Some(resize) => {
                    tracing::debug!("session {session} set the viewport to {width}x{height}@{scale}");
                    resize(state, width, height, scale);
                }
                // Only the TTY backend, which owns a real display and cannot be
                // asked to be another shape.
                None => tracing::debug!("backend cannot resize; ignoring the viewport"),
            }
        }

        ToEngine::Ping => {
            // Answered to the asking session only, straight away. The shell
            // uses the round trip to tell a live socket from the corpse iOS
            // hands back after a resume; see the variant's docs in lwfa-proto.
            state.send_to_session(session, lwfa_proto::ToShell::Pong);
        }

        ToEngine::ListApps => {
            // Scanned on demand. A few hundred small files is a handful of
            // milliseconds, and doing it eagerly would cost every session
            // that never opens the launcher.
            let apps = crate::apps::installed();
            tracing::debug!("found {} installed applications", apps.len());

            // Names only. The shell asks for the icons it is missing, which
            // for a returning client is usually none.
            state.send_to_shell(lwfa_proto::ToShell::Apps { apps });
        }

        ToEngine::RequestIcons { ids } => {
            if ids.is_empty() {
                return;
            }
            let wanted: Vec<(String, String)> = crate::apps::installed()
                .into_iter()
                .filter(|app| ids.iter().any(|id| id == &app.id))
                .filter_map(|app| app.icon.map(|icon| (app.id, icon)))
                .collect();

            let started = std::time::Instant::now();
            let icons = crate::icons::resolve_all(&wanted);
            tracing::debug!(
                "resolved {} of {} requested icons in {:.0}ms",
                icons.len(),
                wanted.len(),
                started.elapsed().as_secs_f64() * 1000.0,
            );
            state.send_to_shell(lwfa_proto::ToShell::AppIcons { icons });
        }
        ToEngine::TakeControl => {
            if state.primary == Some(session) {
                return; // already driving
            }
            let previous = state.primary.replace(session);
            tracing::info!("session {session} took control from {previous:?}");
            // The new driver has been following someone else's arrangement, so
            // it has no strip of its own to push. `Hello` carries the window
            // list it needs to build one.
            let hello = state.hello(session);
            state.send_to_session(session, hello);
            // Whoever just lost the wheel has to start following, and needs the
            // arrangement to follow.
            if let Some(old) = previous {
                state.send_layout_to(old);
            }
            state.announce_peers();
        }

        ToEngine::EndSession { session: target } => {
            if target == session {
                // Kicking yourself is never what you meant, and on a machine
                // you are holding it is a way to lock yourself out.
                return;
            }
            tracing::info!("session {session} disconnected session {target}");
            if let Some(shell) = state.shell.as_ref() {
                shell.evict(target, false);
            }
            // The rest follows from the socket closing: the accept thread
            // reports it and `Disconnected` reassigns primary if it has to.
        }

        ToEngine::SetSessionMode {
            session: target,
            mode,
        } => {
            if target == session {
                return; // same reason as above
            }
            let Some(who) = state.sessions.get_mut(&target) else {
                return;
            };
            who.permissions.mode = mode;
            let downgraded = !who.permissions.may_interact();

            // A session that can no longer interact cannot go on deciding
            // layout: it has just lost the right to move anything, so leaving
            // it primary would freeze the arrangement for everyone.
            if downgraded && state.primary == Some(target) {
                state.primary = state
                    .sessions
                    .iter()
                    .find(|(id, s)| **id != target && s.permissions.may_interact())
                    .map(|(id, _)| *id);
                if let Some(next) = state.primary {
                    let hello = state.hello(next);
                    state.send_to_session(next, hello);
                }
            }

            // Its own `Hello` again, because permissions are what the shell
            // greys its controls from and it has to see the change.
            let hello = state.hello(target);
            state.send_to_session(target, hello);
            if state.primary != Some(target) {
                state.send_layout_to(target);
            }
            state.announce_peers();
            tracing::info!("session {session} set session {target} to {mode:?}");
        }

        ToEngine::SetGamepad { enabled } => {
            // Each client gets its own device, so this only ever touches the
            // asking session's. Nobody can unplug anybody else's controller.
            if enabled == state.gamepads.contains_key(&session) {
                return;
            }
            if !enabled {
                if state.config.gamepad.persistent {
                    // The device must outlive the session: games only see
                    // controllers that existed before they launched. Parked,
                    // inputs released; see `Gamepad::persistent`.
                    state.park_gamepad(session);
                } else {
                    // Dropping it releases every button first; see `VirtualPad`.
                    state.gamepads.remove(&session);
                }
                tracing::info!("session {session} put its controller down");
                return;
            }
            // A controller parked by a flapped session is adopted rather
            // than a new device created: to the game it is the same pad it
            // has been holding all along.
            if let Some(pad) = state.adopt_parked_gamepad() {
                state.gamepads.insert(session, pad);
                tracing::info!("session {session} adopted the parked controller");
                return;
            }
            match crate::gamepad::VirtualPad::open() {
                Ok(pad) => {
                    state.gamepads.insert(session, pad);
                    tracing::info!(
                        "session {session} picked up a controller; {} in play",
                        state.gamepads.len()
                    );
                }
                Err(err) => {
                    tracing::warn!("no virtual controller: {err}");
                    state.send_to_session(
                        session,
                        ToShell::Error {
                            request: "setGamepad".into(),
                            message: err.to_string(),
                        },
                    );
                }
            }
        }

        ToEngine::GamepadButton { button, pressed } => {
            // `gamepad_for`, not `gamepads.get`: a reconnected session that
            // never re-announced its controller must not have its presses
            // silently eaten. See `Lwfa::gamepad_for`.
            let (Some(pad), Some(button)) = (
                state.gamepad_for(session),
                lwfa_proto::GamepadButton::from_index(button),
            ) else {
                return;
            };
            pad.button(button, pressed);
        }

        ToEngine::GamepadAxis { axis, value } => {
            let (Some(pad), Some(axis)) = (
                state.gamepad_for(session),
                lwfa_proto::GamepadAxis::from_index(axis),
            ) else {
                return;
            };
            pad.axis(axis, value);
        }

        ToEngine::SetAudio { enabled, local, opus, quality } => {
            if let Some(who) = state.sessions.get_mut(&session) {
                who.audio = enabled;
                who.opus = opus;
                who.audio_quality = quality;
            }
            // Machine-wide rather than per session: there is one set of
            // speakers, so the last session to express a preference wins.
            state.audio_sink.set_local_playback(local);
            if let Some(shell) = state.shell.as_ref() {
                shell.clients().set_audio(session, enabled);
            }
            state.sync_audio_capture();
            state.sync_audio_bitrate();
        }

        ToEngine::SetStreams { windows, codecs } => {
            // Per connection, not global: a phone and a tablet are looking at
            // different parts of the same strip, so what each can see is its
            // own answer. The engine captures the union.
            let next: std::collections::HashSet<_> = windows.into_iter().collect();
            // Force a fresh, self-contained frame for every window named
            // here, not just newly-added ones.
            //
            // This is the moment that matters: a shell announces what it
            // wants *after* connecting, so invalidating on connect alone
            // pushes frames out before the client has asked for anything,
            // and damage tracking then means an idle window never produces
            // another one. The symptom is a browser where only the window
            // you happen to type in is ever visible.
            //
            // Cheap because it is bounded by what the viewport shows and
            // only costs one capture per window.
            for id in &next {
                state.capture.invalidate(*id);
            }
            if let Some(who) = state.sessions.get_mut(&session) {
                who.codecs = Some(codecs);
            }
            // One encode is shared by everyone watching a window, so the format
            // is decided by the least capable client rather than by whoever
            // spoke last. See `codec_for_all`.
            let codec_for_all = state.codec_for_all();
            if let Some(worker) = state.encoders.as_ref() {
                worker.set_codec(codec_for_all);
                worker.request_keyframes();
            }
            if let Some(shell) = state.shell.as_ref() {
                shell.clients().set_streams(session, next);
            }
            state.recompute_streams();
            tracing::debug!(
                "session {session} streaming; {} window(s) captured in total",
                state.streaming.len()
            );
        }
        ToEngine::PointerMotion { window, x, y } => state.remote_pointer_motion(window, x, y),
        ToEngine::PointerButton { button, pressed } => state.remote_pointer_button(button, pressed),
        ToEngine::PointerAxis {
            horizontal,
            vertical,
        } => state.remote_pointer_axis(horizontal, vertical),
        ToEngine::PointerLeave => state.remote_pointer_leave(),
        ToEngine::Key { key, pressed } => state.remote_key(key, pressed),
        ToEngine::TouchDown { window, id, x, y } => state.remote_touch_down(window, id, x, y),
        ToEngine::TouchMotion { window, id, x, y } => state.remote_touch_motion(window, id, x, y),
        ToEngine::TouchUp { id } => state.remote_touch_up(id),
        ToEngine::Spawn { command, terminal } => {
            // Reaching here means `permitted` already checked both interact and
            // the account's application list.
            //
            // An application already running on the host would not start a
            // second copy: it would hand the request to the copy that is
            // running and raise a window on the other screen, which from here
            // looks like the launch doing nothing. Say so instead. See
            // `outside`.
            if let Some(other) = state.running_outside(&command) {
                tracing::info!(
                    "{} is already running outside this session as pid {}",
                    other.program,
                    other.pid
                );
                state.send_to_session(
                    session,
                    ToShell::AlreadyRunning {
                        command,
                        terminal,
                        program: other.program,
                        pid: other.pid,
                    },
                );
                return;
            }
            state.spawn(&command, terminal);
        }

        ToEngine::CloseAndSpawn {
            command,
            terminal,
            pid,
            force,
        } => {
            // Only ever reached after somebody was asked; see `AlreadyRunning`.
            //
            // Checked again rather than trusting the pid the shell sent back:
            // the process may have exited in between, and pids are reused, so
            // signalling a stale one could hit something else entirely.
            let Some(other) = state.running_outside(&command) else {
                // Already gone. Do what was actually wanted.
                state.spawn(&command, terminal);
                return;
            };
            if other.pid != pid {
                tracing::warn!(
                    "asked to close pid {pid} but {} is now pid {}; not signalling",
                    other.program,
                    other.pid
                );
                state.send_to_session(
                    session,
                    ToShell::AlreadyRunning {
                        command,
                        terminal,
                        program: other.program,
                        pid: other.pid,
                    },
                );
                return;
            }

            state.close_outside_then_spawn(session, command, terminal, other, force);
        }

        ToEngine::ListAccounts => match state.accounts_for_owner(session, "listAccounts") {
            Ok(db) => {
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
                state.send_to_shell(lwfa_proto::ToShell::Accounts { accounts });
            }
            Err(refusal) => state.send_to_shell(refusal),
        },

        ToEngine::CreateAccount {
            name,
            password,
            permissions,
        } => match state.accounts_for_owner(session, "createAccount") {
            Ok(db) => {
                let result = db
                    .lock()
                    .map_err(|_| "the accounts database is unavailable".to_string())
                    .and_then(|db| {
                        db.create(&name, &password, &permissions)
                            .map_err(|e| e.to_string())
                    });
                match result {
                    Ok(account) => {
                        tracing::info!("created account {}", account.name);
                        state.reply_accounts();
                    }
                    Err(message) => state.send_to_shell(lwfa_proto::ToShell::Error {
                        request: "createAccount".into(),
                        message,
                    }),
                }
            }
            Err(refusal) => state.send_to_shell(refusal),
        },

        ToEngine::UpdateAccount {
            id,
            permissions,
            password,
        } => match state.accounts_for_owner(session, "updateAccount") {
            Ok(db) => {
                let result = db
                    .lock()
                    .map_err(|_| "the accounts database is unavailable".to_string())
                    .and_then(|db| {
                        db.set_permissions(id, &permissions)
                            .map_err(|e| e.to_string())?;
                        if let Some(password) = password.as_deref().filter(|p| !p.is_empty()) {
                            db.set_password(id, password).map_err(|e| e.to_string())?;
                        }
                        Ok(())
                    });
                match result {
                    Ok(()) => state.reply_accounts(),
                    Err(message) => state.send_to_shell(lwfa_proto::ToShell::Error {
                        request: "updateAccount".into(),
                        message,
                    }),
                }
            }
            Err(refusal) => state.send_to_shell(refusal),
        },

        ToEngine::DeleteAccount { id } => match state.accounts_for_owner(session, "deleteAccount") {
            Ok(db) => {
                if let Ok(db) = db.lock() {
                    let _ = db.delete(id);
                }
                state.reply_accounts();
            }
            Err(refusal) => state.send_to_shell(refusal),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lwfa_proto::{Permissions, SessionMode, WindowId};

    fn session(mode: SessionMode) -> state::Session {
        state::Session {
            permissions: Permissions {
                mode,
                allowed_apps: None,
            },
            account: "someone".into(),
            device: "iPad".into(),
            since: std::time::Instant::now(),
            client: "test-client".into(),
            codecs: Some(vec![lwfa_proto::Codec::H264]),
            audio: false,
            opus: false,
            audio_quality: lwfa_proto::AudioQuality::default(),
        }
    }

    fn key() -> ToEngine {
        ToEngine::Key {
            key: 30,
            pressed: true,
        }
    }

    fn set_layout() -> ToEngine {
        ToEngine::SetLayout {
            windows: Vec::new(),
            animate: None,
        }
    }

    #[test]
    fn a_viewer_may_watch_but_not_touch() {
        let viewer = session(SessionMode::View);
        assert!(allowed(
            &viewer,
            false,
            &ToEngine::SetStreams {
                windows: vec![WindowId(1)],
                codecs: vec![lwfa_proto::Codec::H264],
            }
        ));
        assert!(!allowed(&viewer, false, &key()));
        assert!(!allowed(
            &viewer,
            false,
            &ToEngine::CloseWindow { id: WindowId(1) }
        ));
    }

    #[test]
    fn a_viewer_may_not_take_control() {
        // Otherwise view-only would be one button press from interact, which
        // would make the whole permission decorative.
        assert!(!allowed(
            &session(SessionMode::View),
            false,
            &ToEngine::TakeControl
        ));
        assert!(allowed(
            &session(SessionMode::Interact),
            false,
            &ToEngine::TakeControl
        ));
    }

    #[test]
    fn only_the_primary_declares_layout() {
        let full = session(SessionMode::Interact);
        assert!(allowed(&full, true, &set_layout()));
        assert!(!allowed(&full, false, &set_layout()));
    }

    #[test]
    fn only_the_primary_resizes_the_output() {
        // Two devices reporting their own viewports would resize the
        // compositor back and forth forever, taking every window with it.
        let message = ToEngine::SetViewport {
            width: 1194,
            height: 834,
            scale: 2.0,
        };
        let full = session(SessionMode::Interact);
        assert!(allowed(&full, true, &message));
        assert!(!allowed(&full, false, &message));
    }

    #[test]
    fn a_follower_still_streams_and_still_types() {
        // A follower is not a spectator. Only *layout* is denied to it.
        let full = session(SessionMode::Interact);
        assert!(allowed(&full, false, &key()));
        assert!(allowed(
            &full,
            false,
            &ToEngine::SetStreams {
                windows: vec![WindowId(2)],
                codecs: vec![],
            }
        ));
    }

    #[test]
    fn only_the_owner_manages_other_sessions() {
        // A named account with full interact rights can use the machine. It
        // must not be able to kick the owner off it.
        let mut guest = session(SessionMode::Interact);
        guest.account = "guest".into();
        let mut owner = session(SessionMode::Interact);
        owner.account = "owner".into();

        let kick = ToEngine::EndSession { session: 2 };
        assert!(!allowed(&guest, true, &kick));
        assert!(allowed(&owner, false, &kick));

        let demote = ToEngine::SetSessionMode {
            session: 2,
            mode: SessionMode::View,
        };
        assert!(!allowed(&guest, true, &demote));
        assert!(allowed(&owner, false, &demote));
    }

    /// A `Lwfa` is far too heavy to build in a unit test, so the format rule
    /// is exercised through the same shape it uses: a set of sessions and
    /// their declared capability.
    fn decides_h264(answers: &[Option<bool>]) -> bool {
        let mut answered = answers.iter().copied().flatten().peekable();
        answered.peek().is_some() && answered.all(|yes| yes)
    }

    #[test]
    fn a_client_that_has_not_answered_does_not_force_jpeg() {
        // The bug this pins: a session starts with its capability unknown, and
        // counting unknown as "cannot" flipped the whole session to JPEG for
        // the moment between a client connecting and its first SetStreams.
        // Every flip clears all NVENC sessions, which cost 90-160ms each to
        // rebuild, so a page refresh stalled the encoder for seconds.
        assert!(decides_h264(&[Some(true), None]));
        assert!(decides_h264(&[None, Some(true), None]));
    }

    #[test]
    fn one_client_that_cannot_decode_still_decides_for_everyone() {
        // One encode is shared, so the least capable client that has actually
        // answered sets the format.
        assert!(!decides_h264(&[Some(true), Some(false)]));
        assert!(!decides_h264(&[Some(false)]));
    }

    #[test]
    fn nobody_answering_means_no_hardware_encode() {
        // Guessing H.264 for a client that has not said would leave a browser
        // with no VideoDecoder showing blank windows.
        assert!(!decides_h264(&[]));
        assert!(!decides_h264(&[None, None]));
    }

    #[test]
    fn an_empty_app_list_permits_nothing() {
        let mut restricted = session(SessionMode::Interact);
        restricted.permissions.allowed_apps = Some(Vec::new());
        assert!(!allowed(
            &restricted,
            true,
            &ToEngine::Spawn {
                command: "xterm".into(),
                terminal: false,
            }
        ));
    }
}
