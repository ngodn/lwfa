# Window scaling and sharper streaming

Research date: 2026-09-07. This records feasibility and recommendations, not an implemented feature or a verified visual improvement. The requested factors include 0.5, 0.75, 1, 1.25, 1.5, 1.75 and 2. The user selected offering both workspace scaling and sharper same-size rendering.

## Two different meanings of scale

For a browser window occupying 1000 by 500 CSS pixels, these operations differ:

| Mode at 2x | Application logical size | Rendered pixels | Browser CSS size | Expected effect |
| --- | --- | --- | --- | --- |
| Higher pixel density, or HiDPI | 1000 by 500 | 2000 by 1000 | 1000 by 500 | Same amount of content and same text size, with more detail if the app supports it |
| Larger application workspace | 2000 by 1000 | 2000 by 1000 at app scale 1 | 1000 by 500 | More content, typically smaller text and controls |

These are design deductions from Wayland's distinction between surface coordinates and buffer pixels. Fractional scaling explicitly leaves window geometry in surface coordinates while increasing buffer resolution. Merely resizing an application changes its layout space. [Wayland fractional scale protocol](https://raw.githubusercontent.com/wayland-mirror/wayland-protocols/main/staging/fractional-scale/fractional-scale-v1.xml)

At 0.5x the workspace interpretation asks the app for 500 by 250 and enlarges it into the same browser box. The HiDPI interpretation keeps a 1000 by 500 layout but samples it into 500 by 250 pixels, sacrificing detail. The latter is a performance option, not a sharpness improvement. Applying a factor to both dimensions changes pixel count by its square: 0.5x means 25%, 0.75x means 56.25%, 1.5x means 225%, and 2x means 400% of the 1x pixel count. This arithmetic is not a measured bandwidth or frame-rate prediction.

## What the current code does

- `Cargo.lock` pins Smithay 0.7.0.
- `crates/lwfa-engine/src/capture.rs` renders surface trees and their popup overlays at `Scale::from(1.0)`. Increasing the target allocation alone would not request more detail from the app.
- `packages/shell/src/WindowSurface.tsx` already sizes its canvas backing store to each received frame, independently of its CSS layout box. This separation is useful and should stay.
- The current input path uses the canvas pixel dimensions. With true HiDPI, pointer coordinates need logical surface dimensions instead; otherwise a click halfway across a 2x frame would be sent twice as far across the app.

These are repository observations, not claims about external protocols. Implementation and isolated tests still need to cover GPU and CPU capture, crop origins, subsurfaces, popups, and old frames arriving during scale changes.

## Native Wayland implementation

Smithay 0.7.0 provides `FractionalScaleManagerState`, `FractionalScaleHandler`, `delegate_fractional_scale!`, and `with_fractional_scale(... set_preferred_scale(...))`. Preferences belong to individual `wl_surface` objects, so the protocol supports a per-window policy without inventing an output for each window. The compositor must apply the owning window's policy to its related surfaces. [Smithay fractional scale module](https://docs.rs/smithay/latest/smithay/wayland/fractional_scale/index.html)

The wire representation is a numerator over 120. Quarter steps are exact, including 0.5 as 60 and 0.75 as 90. The protocol imposes no minimum of 1 on this preference. Clients use buffer scale 1 with a viewport destination for logical size. A preference is not proof of a larger buffer. [Protocol XML](https://raw.githubusercontent.com/wayland-mirror/wayland-protocols/main/staging/fractional-scale/fractional-scale-v1.xml)

The engine currently has no viewporter global. Add Smithay's `ViewporterState` and `delegate_viewporter!` alongside fractional scale support. For existing surface trees, use `with_surface_tree_downward` with `TraversalAction::DoChildren(())`, applying `send_surface_state(surface, data, integer_scale, Transform::Normal)` and `with_fractional_scale(data, |state| state.set_preferred_scale(scale))` in the processor. Traverse each popup root separately because an xdg popup is not a wl_subsurface child. Seed later surfaces in `CompositorHandler::new_subsurface`, `XdgShellHandler::new_popup`, and `FractionalScaleHandler::new_fractional_scale` using the owning window's policy. This is a proposed integration approach based on the pinned APIs. [Smithay viewporter](https://docs.rs/crate/smithay/0.7.0/source/src/wayland/viewporter/mod.rs), [Compositor traversal and callbacks](https://docs.rs/crate/smithay/0.7.0/source/src/wayland/compositor/mod.rs)

The integer fallback is `wl_surface.preferred_buffer_scale`, sent by Smithay's `compositor::send_surface_state`. For a fractional preference above 1, a fallback client can render at the next integer scale and be downsampled. For factors below 1, keep the integer fallback at 1 and downsample during capture; buffer scale must be a positive integer. Older clients may rely on output scale instead. Report this as a compatibility limitation, rather than promising every app will redraw sharply. [Wayland core protocol](https://cgit.freedesktop.org/wayland/wayland/tree/protocol/wayland.xml), [Smithay compositor source](https://docs.rs/crate/smithay/0.7.0/source/src/wayland/compositor/mod.rs)

For true HiDPI, retain the original logical xdg configure, request the preferred density, and render at that density into the correspondingly larger capture target. Scale popup offsets and geometry origins with the same conversion. Keep pointer hit-testing in surface logical coordinates. Avoid independently rounding all edges, which can produce seams. Follow the fractional protocol's positive half-away-from-zero buffer rounding and preserve the existing encoder dimension alignment handling. [Fractional protocol](https://raw.githubusercontent.com/wayland-mirror/wayland-protocols/main/staging/fractional-scale/fractional-scale-v1.xml)

Implementation policy for the integer fallback is `max(1, ceil(scale))`. Sub-1 fractional preferences are representable and accepted by Smithay's setter, but client acceptance needs explicit tests. A client that ignores them can still be captured at reduced resolution.

## Xwayland and Proton compatibility

Do not use Smithay's `CompositorClientState::set_client_scale` as a per-window switch. It changes a Wayland client's coordinate conversion. In Smithay 0.7.0, X11 surfaces share the XWM's `Arc<AtomicF64>` scale, which is obtained from Xwayland's compositor client state. Changing it would affect other X11 windows too. This conclusion follows directly from the pinned source, rather than assuming a desktop's global scaling options provide per-app support. [Compositor client state source](https://docs.rs/crate/smithay/0.7.0/source/src/wayland/compositor/mod.rs), [XWM source](https://docs.rs/crate/smithay/0.7.0/source/src/xwayland/xwm/mod.rs), [X11 surface source](https://docs.rs/crate/smithay/0.7.0/source/src/xwayland/xwm/surface.rs)

A larger application workspace is feasible by configuring a larger X11 window and fitting its capture into the browser box, with matching pointer and popup coordinate conversion. It does not automatically enlarge toolkit fonts to preserve their apparent size. A game may also enforce its own resolution or fullscreen policy. This is an implementation direction requiring live compatibility tests, not a claim that all Proton games support it.

For same-size sharp UI, prefer native Wayland where available, and explicitly handle unsupported clients. Avoid silently changing global Xft DPI, toolkit environment variables, Wine prefixes, or a shared Xwayland scale to implement one window's setting. Such changes have different scope from the requested control.

## Browser sharpness and stream quality

`devicePixelRatio` describes how CSS pixels map to physical display pixels. It can change with display or page zoom. A density-aware default can use the display ratio as a target while keeping layout dimensions in CSS pixels, but must apply explicit limits and account for stream cost. Do not multiply both an already density-scaled frame and its canvas by the ratio a second time. [CSSOM View specification](https://www.w3.org/TR/cssom-view/#dom-window-devicepixelratio), [Mozilla canvas example](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)

Sending more real source pixels can improve detail; stretching an existing low-resolution image cannot recreate the app's glyph outlines. The current frame-sized backing store is suitable. A CSS smoothing change alone is not Retina rendering. A proposed normal-mode improvement is to request native source detail up to a bounded display-density target, then retain that detail through capture and encoding, subject to measured latency and quality.

Colour sampling is separate from resolution. NVENC supports different chroma formats depending on codec and GPU capabilities. A future desktop-text mode can investigate 4:4:4, but it needs capability negotiation and visual measurements; changing chroma settings alone is not universally supported. [NVIDIA NVENC capabilities](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-application-note/index.html)

Browser support must be checked with the actual codec profile, level and dimensions through `VideoDecoder.isConfigSupported`, then confirmed during decode. Existing support for H.264 does not establish support for every H.264 profile. Preserve a compatible fallback. [WebCodecs configuration support](https://www.w3.org/TR/webcodecs/#config-support)

## Recommended acceptance checks

Product recommendation: expose separate controls named **Workspace scale** and **Render density**, with the latter explaining that it preserves text size. Retain 1x as the initial default and offer a bounded Auto setting based on the primary client's display density. Automatically turning every existing stream into 2x before measuring capacity would change its pixel workload fourfold. Present native HiDPI as unavailable or limited for unsupported Xwayland clients instead of describing interpolation as sharper rendering. These are recommendations, not selected implementation defaults.

1. A 1000 by 500 CSS box stays that size at every factor. Tests separately assert the expected logical app dimensions and decoded frame dimensions for the chosen mode.
2. Pointer and touch positions hit the same intended locations at corners, centre, popup items and decorated-window edges, including while an old-resolution frame is still displayed.
3. A controlled native Wayland client confirms preferred fractional scale events and actual buffer size, including a client that ignores the preference and an integer-only fallback.
4. Two X11 windows retain independent requested workspace settings without changing the shared Xwayland client scale.
5. CPU and GPU captures retain all coloured edge pixels at odd sizes and fractional factors. Even encoder dimensions must not silently alter input geometry.
6. Static small text, coloured text and thin lines are compared from source capture through decoded output. Measure frame time, bitrate and decode backlog alongside images. A larger frame alone is not sufficient evidence of a quality improvement.
