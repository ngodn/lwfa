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
mod auth;
mod capture;
mod config;
mod encode;
mod focus;
mod handlers;
mod icons;
mod input;
mod layout;
mod remote_input;
mod shell;
mod state;
mod winit;

use lwfa_proto::ToEngine;
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

    tracing::info!("lwfa running on WAYLAND_DISPLAY={:?}", data.socket_name);

    if data.config.autostart_terminal() {
        data.spawn_terminal();
    }

    event_loop.run(None, &mut data, |_| {})?;

    Ok(())
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

    let (link, bound, shared_token) = match ShellLink::bind(
        &addr,
        token.clone(),
        accounts,
        events_tx,
        data.config.stream.max_frames_in_flight,
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
    let shell_port = auth::setting("SHELL_PORT").unwrap_or_else(|| "6733".to_string());

    if let Some(host) = host {
        tracing::info!("open the shell at:  http://{host}:{shell_port}/?token={token}");
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
    match event {
        ShellEvent::Connected {
            permissions,
            account,
        } => {
            state.permissions = permissions;
            state.account = account;
            if let Some(shell) = state.shell.as_mut() {
                shell.set_connected(true);
            }
            state.layout.set_mode(Mode::Shell);
            // A browser attaching mid-stream cannot decode until it sees an
            // IDR, so ask every live encoder for one now rather than making it
            // wait up to a whole GOP.
            if let Some(worker) = state.encoders.as_ref() {
                worker.request_keyframes();
            }
            // And force a capture of every window, because an idle one would
            // otherwise never produce a frame for the new client to decode.
            state.capture.invalidate_all();
            let hello = state.hello();
            state.send_to_shell(hello);
            tracing::info!("shell took over layout");
        }

        ShellEvent::Disconnected => {
            if let Some(shell) = state.shell.as_mut() {
                shell.set_connected(false);
            }
            state.layout.set_mode(Mode::Safe);
            // Forget what the departed shell wanted streamed. Otherwise the
            // next one receives frames for windows it never asked about,
            // before it has had a chance to say what its viewport shows.
            state.streaming.clear();
            // Fall back immediately rather than leaving the last shell-declared
            // layout frozen on screen, which would look like a hang.
            state.apply_safe_mode();
            tracing::info!("shell gone, back to safe mode");
        }

        ShellEvent::Message(message) => {
            // Enforced here, at the one point every shell message passes
            // through, rather than at each handler. A permission checked in
            // nine places is a permission that will be missing from the tenth.
            if !permitted(state, &message) {
                tracing::debug!(
                    "dropped {} from {}, which may not interact",
                    kind_of(&message),
                    state.account
                );
                return;
            }
            handle_shell_message(state, message)
        }
    }
}

/// Whether the connected session is allowed to send this.
///
/// Read-only traffic is always fine: laying windows out and asking for pixels
/// is what a viewer *is*. Anything that reaches the machine underneath, whether
/// by typing into it, clicking on it, closing something or starting something,
/// requires interact.
#[cfg_attr(test, allow(dead_code))]
fn permitted(state: &Lwfa, message: &ToEngine) -> bool {
    match message {
        // Layout and streaming are the viewer's own business: they decide what
        // their screen shows, not what the machine does.
        ToEngine::SetLayout { .. }
        | ToEngine::SetStreams { .. }
        | ToEngine::FocusWindow { .. }
        | ToEngine::ListApps
        | ToEngine::SetViewport { .. }
        | ToEngine::RequestIcons { .. } => true,

        // Administering accounts is the owner's alone, and is refused out loud
        // rather than dropped: the UI is waiting on a reply.
        ToEngine::ListAccounts
        | ToEngine::CreateAccount { .. }
        | ToEngine::UpdateAccount { .. }
        | ToEngine::DeleteAccount { .. } => true,

        // Launching is gated twice: on interact, and on the app list.
        ToEngine::Spawn { command, .. } => {
            state.permissions.may_interact() && state.may_spawn(command)
        }

        // Everything else drives the machine.
        _ => state.permissions.may_interact(),
    }
}

fn kind_of(message: &ToEngine) -> &'static str {
    match message {
        ToEngine::Spawn { .. } => "spawn",
        ToEngine::CloseWindow { .. } => "closeWindow",
        ToEngine::Key { .. } => "key",
        ToEngine::PointerButton { .. } | ToEngine::PointerMotion { .. } => "pointer",
        ToEngine::TouchDown { .. } | ToEngine::TouchMotion { .. } | ToEngine::TouchUp { .. } => {
            "touch"
        }
        _ => "message",
    }
}

fn handle_shell_message(state: &mut Lwfa, message: ToEngine) {
    match message {
        ToEngine::SetLayout { windows, animate } => {
            let configures = state.layout.apply(
                &windows,
                animate.map(|a| a.spring),
                std::time::Instant::now(),
            );
            state.send_configures(configures);
            state.apply_layout();
        }
        ToEngine::FocusWindow { id } => {
            // notify_shell false: the shell asked for this, so echoing it
            // back would be noise and could start a loop.
            state.set_focus(Some(id), false);
        }
        ToEngine::CloseWindow { id } => state.request_close(id),
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
            if let Some(resize) = state.resize_output.clone() {
                resize(state, width, height, scale);
            }
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
        ToEngine::SetStreams { windows, h264 } => {
            // Total, like SetLayout: anything not listed stops streaming.
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
            if let Some(worker) = state.encoders.as_ref() {
                worker.set_client_supports_h264(h264);
            }
            if let Some(worker) = state.encoders.as_ref() {
                worker.request_keyframes();
            }
            state.streaming = next;
            tracing::debug!("streaming {} window(s)", state.streaming.len());
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
            state.spawn(&command, terminal);
        }

        ToEngine::ListAccounts => match state.accounts_for_owner("listAccounts") {
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
        } => match state.accounts_for_owner("createAccount") {
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
        } => match state.accounts_for_owner("updateAccount") {
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

        ToEngine::DeleteAccount { id } => match state.accounts_for_owner("deleteAccount") {
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
