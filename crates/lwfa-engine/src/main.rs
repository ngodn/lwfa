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

mod capture;
mod encode;
mod handlers;
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

use crate::layout::Mode;
use crate::shell::{DEFAULT_ADDR, ShellEvent, ShellLink};
use crate::state::{CalloopData, Lwfa};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match tracing_subscriber::EnvFilter::try_from_default_env() {
        Ok(env_filter) => tracing_subscriber::fmt().with_env_filter(env_filter).init(),
        Err(_) => tracing_subscriber::fmt().init(),
    }

    let mut event_loop: EventLoop<CalloopData> = EventLoop::try_new()?;
    let display: Display<Lwfa> = Display::new()?;
    let display_handle = display.handle();
    let state = Lwfa::new(&mut event_loop, display);

    let mut data = CalloopData {
        state,
        display_handle,
    };

    winit::init_winit(&mut event_loop, &mut data)?;
    init_shell_link(&mut event_loop, &mut data)?;

    tracing::info!(
        "lwfa running on WAYLAND_DISPLAY={:?}",
        data.state.socket_name
    );

    if std::env::var_os("LWFA_NO_AUTOSTART").is_none() {
        data.state.spawn_terminal();
    }

    event_loop.run(None, &mut data, |_| {})?;

    Ok(())
}

/// Start the shell listener and route its events into the compositor.
fn init_shell_link(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = std::env::var("LWFA_SHELL_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string());
    let (events_tx, events_rx) = channel::channel::<ShellEvent>();

    let (link, bound) = match ShellLink::bind(&addr, events_tx) {
        Ok(bound) => bound,
        Err(err) => {
            // Not fatal. Safe mode still gives a usable compositor, and a bad
            // LWFA_SHELL_ADDR should not stop the machine from booting to
            // something you can fix it from.
            tracing::error!("could not listen for a shell on {addr}: {err}. Running in safe mode.");
            return Ok(());
        }
    };
    data.state.shell = Some(link);
    tracing::info!("shell protocol listening on ws://{bound}");

    event_loop
        .handle()
        .insert_source(events_rx, |event, _, data| {
            let channel::Event::Msg(event) = event else {
                return;
            };
            handle_shell_event(&mut data.state, event);
        })
        .map_err(|err| format!("failed to insert the shell event source: {err}"))?;

    Ok(())
}

fn handle_shell_event(state: &mut Lwfa, event: ShellEvent) {
    match event {
        ShellEvent::Connected => {
            if let Some(shell) = state.shell.as_mut() {
                shell.set_connected(true);
            }
            state.layout.set_mode(Mode::Shell);
            // A browser attaching mid-stream cannot decode until it sees an
            // IDR, so ask every live encoder for one now rather than making it
            // wait up to a whole GOP.
            state.encoders.request_keyframes();
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
            // Fall back immediately rather than leaving the last shell-declared
            // layout frozen on screen, which would look like a hang.
            state.apply_safe_mode();
            tracing::info!("shell gone, back to safe mode");
        }

        ShellEvent::Message(message) => match message {
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
            ToEngine::CloseWindow { id } => {
                if let Some(toplevel) = state.layout.window(id).and_then(|w| w.toplevel()) {
                    toplevel.send_close();
                }
            }
            ToEngine::SetStreams { windows } => {
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
                state.encoders.request_keyframes();
                state.streaming = next;
                tracing::debug!("streaming {} window(s)", state.streaming.len());
            }
            ToEngine::PointerMotion { window, x, y } => state.remote_pointer_motion(window, x, y),
            ToEngine::PointerButton { button, pressed } => {
                state.remote_pointer_button(button, pressed)
            }
            ToEngine::PointerAxis {
                horizontal,
                vertical,
            } => state.remote_pointer_axis(horizontal, vertical),
            ToEngine::PointerLeave => state.remote_pointer_leave(),
            ToEngine::Key { key, pressed } => state.remote_key(key, pressed),
            ToEngine::TouchDown { window, id, x, y } => state.remote_touch_down(window, id, x, y),
            ToEngine::TouchMotion { window, id, x, y } => {
                state.remote_touch_motion(window, id, x, y)
            }
            ToEngine::TouchUp { id } => state.remote_touch_up(id),
            ToEngine::Spawn { command } => {
                // NOTE: arbitrary command execution, reachable by anything that
                // can open the socket. Acceptable while bound to localhost with
                // no auth; see the security note in shell.rs and milestone 7.
                state.spawn(&command);
            }
        },
    }
}
