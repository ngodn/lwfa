//! lwfa compositor entry point.
//!
//! Milestone 2: a nested Wayland compositor with a scrollable strip layout.
//! No shell protocol and no remote backend yet, so the layout is driven by
//! keybinds rather than by React. See docs/architecture.md for the full plan.
//!
//! Keybinds (Alt, not Super, because the host compositor claims Super):
//!   Alt+Return   spawn a terminal
//!   Alt+H / Left focus the column to the left
//!   Alt+L / Right focus the column to the right
//!   Alt+W        close the focused window
//!   Alt+Q        quit

mod handlers;
mod input;
mod layout;
mod state;
mod winit;

use smithay::reexports::calloop::EventLoop;
use smithay::reexports::wayland_server::Display;

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

    tracing::info!(
        "lwfa running on WAYLAND_DISPLAY={:?}",
        data.state.socket_name
    );

    // Start with one terminal so the window is not an empty rectangle. Opt out
    // with LWFA_NO_AUTOSTART to test the empty-strip path.
    if std::env::var_os("LWFA_NO_AUTOSTART").is_none() {
        data.state.spawn_terminal();
    }

    event_loop.run(None, &mut data, |_| {})?;

    Ok(())
}
