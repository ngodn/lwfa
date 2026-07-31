//! Nested backend.
//!
//! Runs lwfa as an ordinary window inside whatever compositor is already
//! running. This is the development loop: `cargo run`, a window appears, Ctrl+C
//! kills it, and the host session is never at risk. See docs/architecture.md
//! section 7 for why this rather than a VM.
//!
//! The DRM/KMS backend for the real display lands in a later milestone and will
//! share everything below the backend boundary.

use std::time::Duration;

use smithay::backend::renderer::damage::OutputDamageTracker;
use smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::winit::{self, WinitEvent};
use smithay::output::{Mode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::calloop::EventLoop;
use smithay::utils::{Rectangle, Transform};

use crate::state::{CalloopData, Lwfa};

/// Background behind the strip. Slightly lighter than black so the gaps between
/// columns are visible and the strip reads as a strip.
const BACKDROP: [f32; 4] = [0.06, 0.06, 0.08, 1.0];

pub fn init_winit(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
) -> Result<(), Box<dyn std::error::Error>> {
    let (mut backend, winit_source) = winit::init::<GlesRenderer>()?;

    let mode = Mode {
        size: backend.window_size(),
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

    data.state.space.map_output(&output, (0, 0));
    data.state.strip.set_output_size(mode.size.to_logical(1));

    let mut damage_tracker = OutputDamageTracker::from_output(&output);

    // Clients spawned from here inherit our socket rather than the host's.
    //
    // SAFETY: `set_var` is unsafe in edition 2024 because concurrent reads of
    // the environment from other threads are a data race. This runs during
    // single-threaded startup, before the event loop begins and before any
    // client is spawned.
    #[allow(unsafe_code)]
    unsafe {
        std::env::set_var("WAYLAND_DISPLAY", &data.state.socket_name);
    }

    event_loop
        .handle()
        .insert_source(winit_source, move |event, _, data| {
            let display = &mut data.display_handle;
            let state = &mut data.state;

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
                    // The strip is a viewport onto the columns, so a resize
                    // changes what is visible without resizing any column.
                    // That is the whole point of the layout model.
                    state.strip.set_output_size(size.to_logical(1));
                    state.apply_layout();
                }

                WinitEvent::Input(event) => state.process_input_event(event),

                WinitEvent::Redraw => {
                    // Advance the scroll spring before rendering, so this frame
                    // shows the current position rather than the previous one.
                    state.tick_animations();

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
                            BACKDROP,
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

                    state.space.refresh();
                    state.popups.cleanup();
                    let _ = display.flush_clients();

                    backend.window().request_redraw();
                }

                WinitEvent::CloseRequested => state.loop_signal.stop(),

                _ => {}
            }
        })?;

    Ok(())
}
