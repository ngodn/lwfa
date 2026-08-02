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
use smithay::backend::renderer::Renderer;
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

    // When the on-screen path last presented, used to tell a host-driven
    // redraw from a spurious one. See the check inside the Redraw handler.
    let last_present = Rc::new(Cell::new(None::<Instant>));

    // Heartbeat counters. See the heartbeat source further down.
    let redraws = Rc::new(Cell::new(0u32));
    let ticks = Rc::new(Cell::new(0u32));

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

    // Applying a new output size is the same work whether the host resized the
    // window or a remote shell declared its viewport, so both go through here.
    // Having two copies is how they drift.
    let apply_output_size = {
        let output = output.clone();
        move |state: &mut Lwfa, w: i32, h: i32, scale: f64| {
            let size: smithay::utils::Size<i32, smithay::utils::Physical> = (w, h).into();
            output.change_current_state(
                Some(Mode {
                    size,
                    refresh: 60_000,
                }),
                None,
                None,
                None,
            );
            output.set_preferred(Mode {
                size,
                refresh: 60_000,
            });
            let logical = size.to_logical(1);
            state.layout.set_output_size(logical);
            state.send_to_shell(lwfa_proto::ToShell::OutputChanged {
                output: lwfa_proto::Output {
                    width: logical.w,
                    height: logical.h,
                    scale,
                },
            });
            if state.layout.mode() == crate::layout::Mode::Safe {
                state.apply_safe_mode();
            }
            state.apply_layout();
        }
    };

    // Handed to the state so `SetViewport` can reach it from the message
    // handler, which has no access to the output otherwise.
    data.resize_output = Some(Rc::new({
        let apply = apply_output_size.clone();
        move |state: &mut Lwfa, w, h, scale| {
            tracing::info!("shell viewport is {w}x{h} at scale {scale}; resizing the output");
            apply(state, w, h, scale);
        }
    }));

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

    // Whether to actually show the session in the host window. See
    // `[window] preview` in configs/defaults.toml: a window parked on a
    // hidden workspace must not be presented to, or the driver eventually
    // blocks the whole engine waiting for a buffer the host never returns.
    let preview =
        data.config.window.preview && std::env::var_os("LWFA_NO_PREVIEW").is_none();
    if !preview {
        tracing::info!("host window preview is off; the session is remote-only");
    }

    event_loop.handle().insert_source(winit_source, {
        let apply_resize = apply_output_size.clone();
        let backend = Rc::clone(&backend);
        let last_redraw = Rc::clone(&last_redraw);
        let last_present = Rc::clone(&last_present);
        let redraws = Rc::clone(&redraws);
        let min_present = data.config.render.min_present();
        let output = output.clone();
        move |event, _, data| {
            let mut display = data.display_handle.clone();
            let state = &mut *data;

            match event {
                WinitEvent::Resized { size, .. } => {
                    // A remote shell's viewport wins over the host window's
                    // size: the person looking at the session is looking at
                    // *their* screen, and letting the host window's shape
                    // reflow their layout would be reflowing it for a display
                    // nobody is in front of.
                    if state.viewport_override.is_some() {
                        return;
                    }
                    // Tell the shell and let it re-lay-out. The engine does
                    // not reflow on its own: that would be layout policy.
                    apply_resize(state, size.w, size.h, 1.0);
                }

                WinitEvent::Input(event) => state.process_input_event(event),

                WinitEvent::Redraw => {
                    // Tells the stall timer to stay out of the way: the host is
                    // driving us, so the on-screen path owns this frame.
                    last_redraw.set(Instant::now());
                    redraws.set(redraws.get() + 1);

                    // Advance the scroll spring before rendering, so this frame
                    // shows the current position rather than the previous one.
                    state.tick_animations();

                    tracing::trace!("redraw: begin");
                    let backend = &mut *backend.borrow_mut();
                    let backdrop = state.config.window.backdrop;

                    // Is this redraw plausibly the host asking for a frame?
                    //
                    // A host drives us through frame callbacks, so a genuine
                    // one cannot arrive sooner than a display interval after
                    // the last present: 16ms at 60Hz, 5.5ms at 180Hz. Anything
                    // faster came from somewhere else, in practice a burst of
                    // configures when a window rule places or full-screens us.
                    //
                    // Presenting on those is what hangs the compositor. The
                    // host has not released the previous buffer and will not
                    // release it for a surface it has never displayed, so the
                    // second `submit()` blocks in libwayland, on the event loop
                    // thread, forever. Nothing else is dispatched after that:
                    // no shell events, no protocol traffic, no ping reply. The
                    // host reports "application not responding" and every
                    // remote client dies with it. Measured: the two redraws
                    // were 0.24ms apart.
                    //
                    // So skip the on-screen half when it is too soon, and do
                    // the rest of the frame anyway. Everything remote lives
                    // below this and does not touch the host's swapchain.
                    let now = Instant::now();
                    let present = preview
                        && last_present
                            .get()
                            .is_none_or(|last| now.duration_since(last) >= min_present);

                    if present {
                        let size = backend.window_size();
                        let damage = Rectangle::from_size(size);
                        // The output and the host window are the same size
                        // until a remote shell declares a viewport, and then
                        // they are not. Scaling here is what keeps the local
                        // view a faithful preview of what the tablet sees,
                        // letterboxed rather than cropped.
                        let out = state.layout.output_size();
                        let fit = if out.w > 0 && out.h > 0 {
                            f32::min(size.w as f32 / out.w as f32, size.h as f32 / out.h as f32)
                        } else {
                            1.0
                        };
                        tracing::trace!("redraw: binding");
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
                                fit,
                                0,
                                [&state.space],
                                &[],
                                &mut damage_tracker,
                                backdrop,
                            ) {
                                tracing::error!("render failed: {err}");
                            }
                        }
                        last_present.set(Some(now));
                        tracing::trace!("redraw: rendered, submitting");
                        backend.window().pre_present_notify();
                        if let Err(err) = backend.submit(Some(&[damage])) {
                            tracing::error!("failed to submit a frame: {err}");
                        }
                        tracing::trace!("redraw: submitted");
                    } else {
                        tracing::trace!("redraw: too soon to present, skipping the on-screen half");
                    }

                    // Streamed windows are paced at the redraw rate; everything
                    // else gets a 1 Hz heartbeat. See `frame_throttle`.
                    state.space.elements().for_each(|window| {
                        let throttle = state.frame_throttle(window);
                        window.send_frame(
                            &output,
                            state.start_time.elapsed(),
                            throttle,
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

                    // Free what the renderer has finished with.
                    //
                    // Smithay does not delete GPU objects the moment they are
                    // dropped: textures, sync fences and the pixel buffers used
                    // for readback all go onto a queue, and the queue is only
                    // drained here. Capture allocates a pixel buffer and a fence
                    // for *every frame of every window*, so leaving this out
                    // leaks on the order of a hundred objects a second.
                    //
                    // It ran for hours before anyone noticed, and then failed in
                    // a way that pointed nowhere near the cause: EGL refused to
                    // create another fence, the renderer lost its context, and
                    // Smithay panicked deep inside a draw call. The one clue was
                    // BAD_ALLOC from `eglCreateSyncKHR`.
                    if let Err(err) = backend.renderer().cleanup_texture_cache() {
                        tracing::warn!("could not free finished GPU resources: {err}");
                    }

                    // Debug: dump one PNG per window so capture can be
                    // verified against what is actually on screen. Off unless
                    // LWFA_CAPTURE_DUMP names a directory.
                    if let Some(dir) = capture_dump_dir() {
                        state.dump_captures(backend.renderer(), &dir);
                    }

                    state.space.refresh();
                    state.popups.cleanup();
                    let _ = display.flush_clients();

                    // Deliberately NOT `request_redraw()` here.
                    //
                    // Asking for the next frame at the end of this one looks
                    // like the obvious way to keep a render loop going, and it
                    // is how this was written for months. It hangs the whole
                    // compositor the first time the window is never shown.
                    //
                    // Traced: exactly two redraws happen. The first presents
                    // fine. The second is the one this line asked for, and its
                    // `submit()` never returns, because the host has not
                    // released the first buffer and will not release it for a
                    // surface it has never displayed. That blocks the event
                    // loop thread, so nothing else runs either: no shell
                    // events, no protocol traffic, no reply to the host's ping.
                    // The host reports "application not responding" and every
                    // remote client dies with it. Being on a hidden workspace at
                    // startup is enough to trigger it, which is exactly where
                    // the `workspace N silent` rule puts us.
                    //
                    // `pre_present_notify` above is what replaces this: it takes
                    // a frame callback, and winit re-emits `RedrawRequested`
                    // when the host fires it. So while the window is visible
                    // this loop runs at the display's rate, driven by the host,
                    // and while it is hidden it simply stops, which is correct.
                    // The stall timer below keeps the remote path alive
                    // meanwhile.
                }

                WinitEvent::CloseRequested => state.loop_signal.stop(),

                _ => {}
            }
        }
    })?;

    // The stall fallback. See the comment above for why this exists at all.
    let tick = data.config.render.tick();
    let redraw_stall = data.config.render.redraw_stall();

    // Heartbeat, so that "it hung" is a diagnosis rather than the start of one.
    //
    // Both hangs this backend has had looked identical from outside: a live
    // process, an unresponsive window, and no way to tell whether the event
    // loop was spinning, idle, or blocked inside a syscall. This counts what
    // actually happened. Off unless LWFA_HEARTBEAT is set, because it logs
    // once a second forever.
    if std::env::var_os("LWFA_HEARTBEAT").is_some() {
        let redraws = Rc::clone(&redraws);
        let ticks = Rc::clone(&ticks);
        event_loop.handle().insert_source(
            Timer::from_duration(Duration::from_secs(1)),
            move |_, _, data: &mut CalloopData| {
                // A live loop with 0 redraws is a hidden window working
                // correctly. 0 of *both* means the loop is not running at all,
                // and this line stopping is itself the signal.
                tracing::info!(
                    "heartbeat: {} redraws/s, {} ticks/s, {} streaming, shell {}",
                    redraws.replace(0),
                    ticks.replace(0),
                    data.streaming.len(),
                    if data.shell.is_some() { "up" } else { "down" },
                );
                TimeoutAction::ToDuration(Duration::from_secs(1))
            },
        )?;
    }

    event_loop
        .handle()
        .insert_source(Timer::from_duration(tick), move |_, _, data| {
            ticks.set(ticks.get() + 1);
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

                    // The same on the stalled path, which captures just as
                    // hard and for just as long. See the note on the redraw
                    // path above.
                    if let Err(err) = backend.renderer().cleanup_texture_cache() {
                        tracing::warn!("could not free finished GPU resources: {err}");
                    }

                    // The capture dump belongs on this path too, not only on
                    // the redraw one. Otherwise the one tool for inspecting
                    // what capture produces goes silent in precisely the
                    // situation worth inspecting: nobody at the host, someone
                    // watching remotely. It also makes the dump look like
                    // evidence that streaming had stopped, which it is not.
                    if let Some(dir) = capture_dump_dir() {
                        state.dump_captures(backend.renderer(), &dir);
                    }
                }

                // Frame callbacks matter more than the capture here. A Wayland
                // client waits for one before drawing again, so without this
                // the windows would not just stop streaming, they would stop
                // *running*: no clock ticking, no video playing, no cursor
                // blinking, on a session someone is looking at right now.
                // Throttled per window exactly like the redraw path, or the
                // stall fallback would quietly undo the suspension.
                state.space.elements().for_each(|window| {
                    let throttle = state.frame_throttle(window);
                    window.send_frame(
                        &output,
                        state.start_time.elapsed(),
                        throttle,
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

// There used to be a `never_block_on_present` here that called
// `eglSwapInterval(0)` after `bind()`, meant to stop presents from waiting on
// the host. It never once worked: Smithay renders through an FBO with the
// context current *surfaceless* at that point, and the EGL spec makes
// `eglSwapInterval` fail with `BAD_SURFACE` when no surface is bound to the
// current context. So the call's entire observable effect was one scary EGL
// error in the log at first present. The freeze it was aimed at is actually
// prevented by the redraw scheduling above: presents only happen inside
// host-driven `Redraw` events, and a host that has hidden the window sends
// none, so there is never a swap waiting on a callback that is not coming.
