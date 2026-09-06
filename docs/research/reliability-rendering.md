# Rendering reliability investigation, 2026-09-06

The right/bottom black-strip bug is reproducible in a native Wayland Chromium
window through the real compositor capture and JPEG stream. Safari, H.264
padding, Proton and a particular browser viewport are not required to trigger it.

## Reproduction and cause

`scripts/e2e-rendering.mjs` creates its own Chromium profiles and a moving color
fixture, launches it into the explicitly supplied dev Wayland/Xwayland displays,
then arranges and captures its window through the dev WebSocket. It decodes the
real JPEG payload in Chromium and counts fully black edge columns and rows.
It waits for three correctly sized frames and then another two seconds before
checking the latest frame, so startup geometry is not the verdict.

A small [before/after measurement fixture](fixtures/rendering-edge-measurements.json)
preserves all 18 observed results without device names, credentials, or user
window contents. It is a numerical transcript of the live pixel assertions;
original image payloads were not saved during the failing runs.

Before the fix, two separate runs failed for native Wayland at 802x602:

```text
sample: { w: 802, h: 602, right: 10, bottom: 10 }
AssertionError: wayland 802x602 black columns: 10 !== 0
```

`SurfaceCapture::issue` correctly places the surface tree at the negative window
geometry offset to exclude a client's shadow. It then incorrectly supplies the
capture framebuffer rectangle as the draw damage rectangle. Smithay interprets
that rectangle in the render element's local coordinates. A surface starting at
(-10, -10) therefore renders damage ending ten pixels before the framebuffer's
right and bottom edges. Those pixels remain clear and become black in video.

The fix supplies the full element-local rectangle, `Rectangle::from_size(dst.size)`.
The framebuffer clips pixels outside the capture target. This changes neither
window dimensions nor input coordinates, and introduces no heuristic color fill,
content crop, or decoration policy.

Primary source: [Smithay's own damage renderer](https://smithay.github.io/smithay/src/smithay/backend/renderer/damage/mod.rs.html)
intersects output damage with element geometry, then subtracts the element
location before drawing. The installed Smithay 0.7.0 source follows that same
coordinate conversion. [Wayland's window geometry protocol](https://wayland.app/protocols/xdg-shell)
explains why visible window bounds can differ from the full surface bounds.

## Prior investigation recovered from Claude history

The Aug 20 investigation in session `ef875cde-ec11-4d4f-a5fa-04cbe13e475e`
previously tried codec crops, margin filling and decoration changes. Those were
reverted after inconsistent results and input-coordinate regressions. Later
captures of Chromium, GTK zenity and VS Code at 1280x800 showed zero steady-state
margins. That limited test did not exercise the current failing 802x602 resized
native Chromium case. We did not reintroduce those workarounds.

## Browser decoder lifecycle

Five new tests failed before changes to `FrameDecoder`: pending JPEG and video
bitmap conversions still published after a window was forgotten or the
connection closed; an older JPEG could replace a newer frame when conversion
promises completed out of order. These are separate rendering/resource bugs,
not the demonstrated cause of the black strips.

Delivery now has a per-window lifetime and increasing sequence number. Retired
or superseded bitmaps close without entering the shared frame store. Resizing
invalidates conversions already pending, and video-to-JPEG fallback retires the
video decoder. A timestamp cutoff also rejects old video output queued before a reconfiguration
but delivered afterwards; an additional test reproduced that failure before the
cutoff was added. Decoder reuse across resizes is preserved.

[HTML's createImageBitmap specification](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html)
returns a promise; [WebCodecs close/reset](https://www.w3.org/TR/webcodecs/)
controls decoder output, not an already-started bitmap conversion owned by the
application. Both lifetimes must be handled.

Validation: `pnpm exec vitest run packages/shell/test/decode.test.ts` passes 14
tests, including eight delivery/lifecycle regressions. TypeScript check passed.

## Repeatable live check

Use only an isolated dev engine. The script changes that engine's layout.
It creates and closes its own browser contexts and removes private profiles.

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
AUTH_PASS='<dev password>' \
LWFA_TEST_WAYLAND=wayland-3 LWFA_TEST_DISPLAY=:2 \
mise exec node@24.15.0 -- node scripts/e2e-rendering.mjs
```

Set `LWFA_TEST_CODEC=h264` to test the same pixels through H.264/WebCodecs.
The default endpoint is `http://127.0.0.1:6734`; override with `LWFA_TEST_URL`.
The script uses `/usr/bin/chromium` for both the native fixture and headless
viewer. It checks 802x602, 1192x860, 640x480 and 1324x884 on Wayland and Xwayland.

After rebuilding the isolated dev engine, all 16 live checks passed: four sizes
on each of native Wayland and Xwayland, through both JPEG and NVENC H.264.
Every sampled frame had zero fully black right columns and bottom rows. The
original 802x602 case changed from 10/10 to 0/0 with the capture fix alone.
Proton game rendering, physical iPad/Safari presentation, and application-specific
transparent borders remain outside the fixture's coverage.

## Final CPU readback integration

After the JPEG admission and prefetch changes, root rebuilt the engine and
repeated all 16 geometry checks with `gpu_direct=false` in a private copy of
the installed configuration. JPEG and H.264 each passed four sizes on Wayland
and Xwayland, with zero black right columns and bottom rows. These complement
the original 16 checks under the normal GPU-direct configuration.

[Parsed final measurements](fixtures/rendering-cpu-edge-measurements.json)
preserve the dimensions, backend, codec and measured borders. The two
readback policy tests cover discarding a speculative stale image without
losing a static update. The live pixel tests establish geometry, not a
benchmark of image age.
