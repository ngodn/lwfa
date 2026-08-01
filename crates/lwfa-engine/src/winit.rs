//! Nested backend.
//!
//! Runs lwfa as an ordinary window inside whatever compositor is already
//! running. This is the development loop: `cargo run`, a window appears, Ctrl+C
//! kills it, and the host session is never at risk. See docs/architecture.md
//! section 7 for why this rather than a VM.
//!
//! The DRM/KMS backend for the real display lands in a later milestone and will
//! share everything below the backend boundary.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use smithay::backend::renderer::damage::OutputDamageTracker;
use smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::winit::{self, WinitEvent};
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::calloop::EventLoop;
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::winit::dpi::LogicalSize;
use smithay::reexports::winit::platform::wayland::WindowAttributesExtWayland;
use smithay::reexports::winit::window::Window as WinitWindow;
use smithay::utils::{Rectangle, Transform};

use crate::config;
use crate::state::{CalloopData, Lwfa};

/// Where to write per-window capture PNGs, if the debug dump is enabled.
fn capture_dump_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("LWFA_CAPTURE_DUMP").map(std::path::PathBuf::from)
}

// The backdrop colour is `[window].backdrop`, and the two timings below are
// `[render]`, all in `configs/defaults.toml`.

// Why the stall fallback exists at all, and why `[render].redraw_stall_ms`
// defaults to three frames rather than something longer:
//
// The nested backend redraws only when the host compositor hands it a frame
// callback, and a host stops doing that the moment our window is not visible:
// another workspace, a minimise, something full-screen on top. For an ordinary
// nested compositor that is correct, and it is the behaviour you want.
//
// It is wrong for lwfa. The point of the whole project is that the session is
// usable from a tablet while nobody is looking at the host screen, so tying the
// remote frame rate to the host's redraw cadence means parking lwfa on another
// workspace freezes every remote client. It fails in a way that is genuinely
// hard to read, too: titles, geometry and layout keep working, because those
// are protocol traffic and owe nothing to rendering. The shell looks perfectly
// alive and shows nothing.
//
// So when the host goes quiet and someone is still watching remotely, drive the
// streaming path from a timer instead. Long enough that a normally scheduled
// loop never trips it, short enough that the stall is not visible.

pub fn init_winit(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
) -> Result<(), Box<dyn std::error::Error>> {
    // Smithay's `winit::init` titles the window "Smithay" and sets no app id at
    // all, which leaves the host compositor with an empty class. That is not
    // cosmetic: a window rule cannot match on nothing, so there is no way to
    // tell a host "always put lwfa on this workspace, full-screen". Name it.
    //
    // `with_name(general, instance)` is winit's Wayland extension; `general`
    // becomes the `xdg_toplevel` app id, which is what compositors call the
    // window's class.
    let attributes = WinitWindow::default_attributes()
        .with_title(config::WINDOW_TITLE)
        .with_name(config::APP_ID, config::APP_ID)
        .with_inner_size(LogicalSize::new(
            data.config.window.width,
            data.config.window.height,
        ))
        .with_visible(true);
    let (backend, winit_source) = winit::init_from_attributes::<GlesRenderer>(attributes)?;

    // Shared because two sources need it: the winit event source for the
    // on-screen path, and the stall timer for the remote one. They are both
    // calloop callbacks on the same thread, so the two never borrow at once.
    let backend = Rc::new(RefCell::new(backend));
    let last_redraw = Rc::new(Cell::new(Instant::now()));

    let mode = Mode {
        size: backend.borrow().window_size(),
        refresh: 60_000,
    };

    let output = Output::new(
        "lwfa-nested".to_string(),
        PhysicalProperties {
            size: (0, 0).into(),
            subpixel: Subpixel::Unknown,
            make: "lwfa".into(),
            model: "nested".into(),
        },
    );
    let _global = output.create_global::<Lwfa>(&data.display_handle);
    output.change_current_state(
        Some(mode),
        Some(Transform::Flipped180),
        None,
        Some((0, 0).into()),
    );
    output.set_preferred(mode);

    data.space.map_output(&output, (0, 0));
    data.layout.set_output_size(mode.size.to_logical(1));

    let mut damage_tracker = OutputDamageTracker::from_output(&output);

    // Clients spawned from here inherit our socket rather than the host's.
    //
    // SAFETY: `set_var` is unsafe in edition 2024 because concurrent reads of
    // the environment from other threads are a data race. This runs during
    // single-threaded startup, before the event loop begins and before any
    // client is spawned.
    #[allow(unsafe_code)]
    unsafe {
        std::env::set_var("WAYLAND_DISPLAY", &data.socket_name);
    }

    event_loop.handle().insert_source(winit_source, {
        let backend = Rc::clone(&backend);
        let last_redraw = Rc::clone(&last_redraw);
        let output = output.clone();
        move |event, _, data| {
            let mut display = data.display_handle.clone();
            let state = &mut *data;

            match event {
                WinitEvent::Resized { size, .. } => {
                    output.change_current_state(
                        Some(Mode {
                            size,
                            refresh: 60_000,
                        }),
                        None,
                        None,
                        None,
                    );
                    // Tell the shell and let it re-lay-out. The engine does
                    // not reflow on its own: that would be layout policy.
                    let logical = size.to_logical(1);
                    state.layout.set_output_size(logical);
                    state.send_to_shell(lwfa_proto::ToShell::OutputChanged {
                        output: lwfa_proto::Output {
                            width: logical.w,
                            height: logical.h,
                            scale: 1.0,
                        },
                    });
                    if state.layout.mode() == crate::layout::Mode::Safe {
                        state.apply_safe_mode();
                    }
                    state.apply_layout();
                }

                WinitEvent::Input(event) => state.process_input_event(event),

                WinitEvent::Redraw => {
                    // Tells the stall timer to stay out of the way: the host is
                    // driving us, so the on-screen path owns this frame.
                    last_redraw.set(Instant::now());

                    // Advance the scroll spring before rendering, so this frame
                    // shows the current position rather than the previous one.
                    state.tick_animations();

                    let backend = &mut *backend.borrow_mut();
                    let backdrop = state.config.window.backdrop;
                    let size = backend.window_size();
                    let damage = Rectangle::from_size(size);

                    {
                        let (renderer, mut framebuffer) = match backend.bind() {
                            Ok(bound) => bound,
                            Err(err) => {
                                tracing::error!("failed to bind the backend buffer: {err}");
                                return;
                            }
                        };
                        if let Err(err) = smithay::desktop::space::render_output::<
                            _,
                            WaylandSurfaceRenderElement<GlesRenderer>,
                            _,
                            _,
                        >(
                            &output,
                            renderer,
                            &mut framebuffer,
                            1.0,
                            0,
                            [&state.space],
                            &[],
                            &mut damage_tracker,
                            backdrop,
                        ) {
                            tracing::error!("render failed: {err}");
                        }
                    }

                    if let Err(err) = backend.submit(Some(&[damage])) {
                        tracing::error!("failed to submit a frame: {err}");
                    }

                    state.space.elements().for_each(|window| {
                        window.send_frame(
                            &output,
                            state.start_time.elapsed(),
                            Some(Duration::ZERO),
                            |_, _| Some(output.clone()),
                        )
                    });

                    // Per-surface capture for any remote shell. Does
                    // nothing unless a shell has asked for streams.
                    //
                    // `renderer()`, not `bind()`. `bind()` acquires a buffer
                    // from the swapchain, and one acquired here after `submit`
                    // is never presented, which makes the output flicker.
                    // Capture renders into its own offscreen texture and needs
                    // no backend buffer at all.
                    state.stream_frames(backend.renderer());

                    // Debug: dump one PNG per window so capture can be
                    // verified against what is actually on screen. Off unless
                    // LWFA_CAPTURE_DUMP names a directory.
                    if let Some(dir) = capture_dump_dir() {
                        state.dump_captures(backend.renderer(), &dir);
                    }

                    state.space.refresh();
                    state.popups.cleanup();
                    let _ = display.flush_clients();

                    backend.window().request_redraw();
                }

                WinitEvent::CloseRequested => state.loop_signal.stop(),

                _ => {}
            }
        }
    })?;

    // The stall fallback. See the comment above for why this exists at all.
    let tick = data.config.render.tick();
    let redraw_stall = data.config.render.redraw_stall();
    event_loop
        .handle()
        .insert_source(Timer::from_duration(tick), move |_, _, data| {
            let stalled = last_redraw.get().elapsed() >= redraw_stall;
            // Only worth doing for someone actually watching. With no shell
            // connected there is nobody to send frames to, and letting an
            // invisible nested compositor idle is the right behaviour.
            if stalled && data.shell.is_some() {
                let state = &mut *data;
                state.tick_animations();

                {
                    let backend = &mut *backend.borrow_mut();
                    state.stream_frames(backend.renderer());
                }

                // Frame callbacks matter more than the capture here. A Wayland
                // client waits for one before drawing again, so without this
                // the windows would not just stop streaming, they would stop
                // *running*: no clock ticking, no video playing, no cursor
                // blinking, on a session someone is looking at right now.
                state.space.elements().for_each(|window| {
                    window.send_frame(
                        &output,
                        state.start_time.elapsed(),
                        Some(Duration::ZERO),
                        |_, _| Some(output.clone()),
                    )
                });

                state.space.refresh();
                state.popups.cleanup();
                let _ = state.display_handle.clone().flush_clients();

                // Deliberately NOT `request_redraw()` here, which is what an
                // earlier version did and which wedged the whole compositor.
                //
                // `Redraw` means "paint to the host's swapchain". Asking for one
                // every 16ms while the host is not consuming buffers exhausts
                // the swapchain, and the next `submit()` then blocks inside
                // libwayland waiting for a release that is not coming. It blocks
                // the *event loop thread*, so nothing else is dispatched either:
                // no shell events, no protocol traffic, no reply to the host's
                // ping. The host puts up "application not responding" and the
                // remote session dies with it.
                //
                // Nothing needs to be asked for. The on-screen handler ends with
                // its own `request_redraw()`, so exactly one request is always
                // outstanding, and the host honours it the moment the window is
                // visible again. One request in flight never exhausts anything.
            }
            TimeoutAction::ToDuration(tick)
        })?;

    Ok(())
}
