//! Per-surface capture.
//!
//! Renders each window into its own offscreen buffer and reads it back, so a
//! window can be transported to a remote shell independently of everything
//! else on screen.
//!
//! # Why per-surface and not one screen capture
//!
//! Capturing the whole output gives the browser a single rectangle with no idea
//! where windows are, which makes responsive layout impossible: the remote
//! device would get a shrunken desktop rather than a layout of its own. Capture
//! per window and the browser can put each one in its own DOM node and lay them
//! out however its viewport demands. See docs/architecture.md section 2.1.
//!
//! # Cost, and why damage tracking is load-bearing
//!
//! Capturing is a GPU render plus a read-back per window per frame. Read-back
//! is the expensive part, so a window whose content has not changed must not be
//! captured at all. [`SurfaceCapture`] tracks each surface's commit counter and
//! skips anything that has not committed since it was last captured. Most
//! windows are static most of the time, which is what makes this affordable.
//!
//! # What this is not, yet
//!
//! The frames produced here are raw RGBA. Encoding them (NVENC H.264, up to 8
//! concurrent sessions on the dev GPU) is a separate concern and is not done;
//! see `encode.rs` for what currently happens instead.

use std::collections::HashMap;

use lwfa_proto::WindowId;
use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::surface::{
    WaylandSurfaceRenderElement, render_elements_from_surface_tree,
};
use smithay::backend::renderer::element::{Element, Kind, RenderElement};
use smithay::backend::renderer::gles::{GlesRenderer, GlesTexture};
use smithay::backend::renderer::utils::CommitCounter;
use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame, Offscreen, Renderer};
use smithay::desktop::Window;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{
    Buffer as BufferCoord, Logical, Physical, Point, Rectangle, Scale, Size, Transform,
};
use smithay::wayland::seat::WaylandFocus;

/// A captured window image, tightly packed RGBA.
pub struct CapturedFrame {
    pub id: WindowId,
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, row-major, no padding.
    pub rgba: Vec<u8>,
}

struct Target {
    texture: GlesTexture,
    size: Size<i32, Physical>,
    /// Commit counters of every element captured last time.
    ///
    /// A window is a surface tree (toplevel plus subsurfaces), so one counter
    /// is not enough: a video player's subsurface can commit while its parent
    /// does not. Comparing the whole set catches that.
    last_commits: Vec<CommitCounter>,
}

#[derive(Default)]
pub struct SurfaceCapture {
    targets: HashMap<WindowId, Target>,
}

impl SurfaceCapture {
    pub fn forget(&mut self, id: WindowId) {
        self.targets.remove(&id);
    }

    /// Force the next capture of every window, ignoring damage.
    ///
    /// Damage tracking means an idle window produces no frames at all, which is
    /// the point. But it also means a shell that connects *later* would never
    /// receive anything for a window nobody is touching, and would show it
    /// blank until the user happened to type in it. Attaching a client is
    /// exactly the moment that has to be overridden.
    pub fn invalidate_all(&mut self) {
        for target in self.targets.values_mut() {
            target.last_commits.clear();
        }
    }

    /// Force the next capture of one window. Used when it starts streaming.
    pub fn invalidate(&mut self, id: WindowId) {
        if let Some(target) = self.targets.get_mut(&id) {
            target.last_commits.clear();
        }
    }

    /// Capture one window, or return `None` if nothing changed since last time.
    ///
    /// `size` is the window's current size in physical pixels.
    ///
    /// `overlays` are surfaces to draw on top of it, at offsets relative to the
    /// window's own origin: menus, tooltips, combo box drop-downs. They are part
    /// of *this* capture rather than streams of their own because a remote frame
    /// is addressed by window id and a popup has none. See `Lwfa::overlays_for`.
    pub fn capture(
        &mut self,
        renderer: &mut GlesRenderer,
        id: WindowId,
        window: &Window,
        size: Size<i32, Physical>,
        overlays: &[(WlSurface, Point<i32, Logical>)],
    ) -> Option<CapturedFrame> {
        if size.w <= 0 || size.h <= 0 {
            return None;
        }

        // Not `toplevel()`, which is `None` for an X11 window and would make
        // every X11 client stream nothing at all while still appearing in the
        // strip with the right title and geometry.
        let surface = window.wl_surface()?.into_owned();

        // Where the *window* starts inside its own surface.
        //
        // A client drawing its own decorations makes its surface bigger than
        // its window: GTK and Firefox pad it with an invisible margin so the
        // drop shadow has somewhere to go, then declare the real window with
        // `xdg_surface.set_window_geometry`. Capturing from the surface origin
        // therefore captures the shadow, pushes the application down and to the
        // right by the margin, and cuts off as much of the far edges as it let
        // in at the near ones. Firefox in a column made that unmistakable: the
        // tab bar sat inset from the top-left corner and the hamburger menu was
        // sliced off the right.
        //
        // Rendering the tree at minus that offset puts the window's own
        // top-left corner at the buffer's, which is what the shell places and
        // what the encoder should be spending bandwidth on. Hence the negation
        // below: `origin` is the shift to apply, not the offset itself.
        //
        // X11 is excluded deliberately. `Window::geometry` falls back to the
        // bounding box for a window with no `wl_surface` state of its own, and
        // for an X11 window that box is in X11 *root* coordinates, so its `loc`
        // is where the window sits on the screen rather than an offset inside a
        // surface. Subtracting it would translate the capture by the window's
        // absolute position. Xwayland surfaces have no client-side margin
        // anyway: the surface is the window.
        let origin: Point<i32, Logical> = if window.is_x11() {
            Point::default()
        } else {
            let loc = window.geometry().loc;
            Point::from((-loc.x, -loc.y))
        };

        // Building elements is CPU-only and cheap. Doing it before the skip
        // check is what lets the commit counters be read at all: they live on
        // the elements.
        let mut elements: Vec<WaylandSurfaceRenderElement<GlesRenderer>> =
            render_elements_from_surface_tree(
                renderer,
                &surface,
                origin.to_physical(1),
                Scale::from(1.0),
                1.0,
                Kind::Unspecified,
            );

        // Prepended, because this list is drawn back to front in reverse: the
        // popup has to end up in front of the window it belongs to.
        //
        // Their commit counters join the damage set below, which is what makes a
        // menu appearing count as damage. Without that the window would look
        // unchanged and the menu would never be sent.
        for (overlay, offset) in overlays {
            let mut popup: Vec<WaylandSurfaceRenderElement<GlesRenderer>> =
                render_elements_from_surface_tree(
                    renderer,
                    overlay,
                    offset.to_physical(1),
                    Scale::from(1.0),
                    1.0,
                    Kind::Unspecified,
                );
            popup.append(&mut elements);
            elements = popup;
        }

        let commits: Vec<CommitCounter> = elements.iter().map(Element::current_commit).collect();

        // Recreate the buffer when the window resizes; reuse it otherwise, so
        // the steady state allocates nothing.
        let needs_new_buffer = match self.targets.get(&id) {
            Some(target) => target.size != size,
            None => true,
        };

        if needs_new_buffer {
            let texture = renderer
                .create_buffer(Fourcc::Abgr8888, buffer_size(size))
                .inspect_err(|err| {
                    tracing::warn!("could not create a capture buffer for {id}: {err}")
                })
                .ok()?;
            self.targets.insert(
                id,
                Target {
                    texture,
                    size,
                    last_commits: Vec::new(),
                },
            );
        } else if self
            .targets
            .get(&id)
            .is_some_and(|t| t.last_commits == commits)
        {
            // Unchanged. Skipping the render and read-back here is what makes
            // capturing many windows affordable.
            return None;
        }

        let target = self.targets.get_mut(&id)?;
        target.last_commits = commits;

        let whole = Rectangle::from_size(size);
        let mut framebuffer = renderer
            .bind(&mut target.texture)
            .inspect_err(|err| tracing::warn!("could not bind capture buffer for {id}: {err}"))
            .ok()?;

        {
            let mut frame = renderer
                .render(&mut framebuffer, size, Transform::Normal)
                .inspect_err(|err| tracing::warn!("could not start capture render for {id}: {err}"))
                .ok()?;

            // Transparent, not black: a window with rounded corners or an
            // alpha channel has to arrive with that alpha intact, or the
            // browser cannot composite it over anything.
            frame.clear(Color32F::TRANSPARENT, &[whole]).ok()?;

            // Back to front, matching how Smithay's own space renderer walks
            // elements.
            for element in elements.iter().rev() {
                let src = element.src();
                let dst = element.geometry(Scale::from(1.0));
                if let Err(err) = RenderElement::draw(element, &mut frame, src, dst, &[whole], &[])
                {
                    tracing::warn!("capture draw failed for {id}: {err}");
                }
            }

            // The fence must be awaited before reading back, or the copy
            // below races the GPU and returns stale or half-drawn content.
            // This is the one place where getting it wrong produces a subtly
            // wrong image rather than an error.
            let sync = frame
                .finish()
                .inspect_err(|err| tracing::warn!("capture finish failed for {id}: {err}"))
                .ok()?;
            if let Err(err) = sync.wait() {
                tracing::warn!("waiting on the capture fence for {id} was interrupted: {err}");
                return None;
            }
        }

        let mapping = renderer
            .copy_framebuffer(
                &framebuffer,
                Rectangle::from_size(buffer_size(size)),
                Fourcc::Abgr8888,
            )
            .inspect_err(|err| tracing::warn!("could not copy capture buffer for {id}: {err}"))
            .ok()?;
        drop(framebuffer);

        let bytes = renderer
            .map_texture(&mapping)
            .inspect_err(|err| tracing::warn!("could not map capture buffer for {id}: {err}"))
            .ok()?;

        let expected = size.w as usize * size.h as usize * 4;
        if bytes.len() < expected {
            tracing::warn!(
                "capture for {id} returned {} bytes, expected {expected}",
                bytes.len()
            );
            return None;
        }

        // NOT cropping the unpainted columns, though they are measurable and
        // this used to.
        //
        // The frame's dimensions are the window's dimensions everywhere else:
        // the shell sizes its canvas from them and maps clicks through that
        // canvas, and the engine forwards the result to the client as window
        // coordinates. Narrowing the frame therefore narrows the coordinate
        // space without telling anybody, and every click lands short of where
        // it was aimed, by more the further right it is. That is exactly the
        // bug it caused: Firefox, which draws its own decorations and so has
        // the widest unpainted margin, stopped taking clicks at all.
        //
        // A black band down one edge is worse-looking than this is
        // wrong-behaving, but only one of the two stops you using the desktop.
        // Doing this properly means either carrying the true window size
        // alongside the coded size, or scaling input by the crop on the way
        // back in. `unpainted_right` and its tests are kept for whichever of
        // those comes next.
        Some(CapturedFrame {
            id,
            width: size.w as u32,
            height: size.h as u32,
            rgba: bytes[..expected].to_vec(),
        })
    }
}

/// How many columns at the right edge the client left unpainted.
///
/// # Why this is needed at all
///
/// The capture buffer is sized from `xdg_surface.set_window_geometry`, which is
/// the client's own statement of where its window is inside its surface. Some
/// clients declare a window wider than the area they actually paint. VS Code
/// does, measured: a window declared 1022 wide painted 1010, leaving twelve
/// columns of the cleared buffer untouched. The buffer is cleared to black and
/// has no alpha by the time it reaches the browser, so those columns arrive as
/// a black band down the side of the application, full height.
///
/// Nothing in the protocol reports the real painted width. The geometry and the
/// surface's bounding box agree with each other and both disagree with the
/// pixels, so the pixels are the only source.
///
/// # Why this is affordable
///
/// The band only changes when the window changes size, and this runs when the
/// buffer is created, which is exactly then. It also stops at the first column
/// that has been painted, so the normal case, a client that paints everything
/// it declared, costs one column.
///
/// A column counts only if every pixel in it is untouched. Testing "dark" would
/// eat the right-hand edge of a terminal.
#[cfg_attr(not(test), allow(dead_code))]
fn unpainted_right(rgba: &[u8], width: i32, height: i32) -> i32 {
    // A cap, because this is a guess about a misbehaving client and a large
    // answer means the guess is wrong. A window that is genuinely blank down
    // one whole side is not a case worth silently cropping.
    let limit = (width / 8).min(64);

    let mut dead = 0;
    while dead < limit {
        let x = width - 1 - dead;
        let painted = (0..height).any(|y| {
            let i = ((y * width + x) * 4) as usize;
            // Opaque and not black. The buffer is cleared to transparent black,
            // so either channel being set means something drew here.
            rgba.get(i + 3).is_some_and(|&a| a != 0)
                && (rgba[i] != 0 || rgba[i + 1] != 0 || rgba[i + 2] != 0)
        });
        if painted {
            break;
        }
        dead += 1;
    }

    // Rounded down to an even number of columns, so the frame keeps the parity
    // it had. H.264 subsamples chroma, so NV12 wants even dimensions, and
    // handing the encoder an odd width breaks the pipe to ffmpeg and takes the
    // whole engine down with it. Cropping one column less costs a single line
    // of black and cannot change the parity of anything.
    dead - (dead % 2)
}

/// Physical pixels to buffer coordinates.
///
/// lwfa renders at scale 1 with no transform for now, so this is a relabel
/// rather than a conversion. It exists as a named function so the day
/// fractional scaling arrives there is one place to fix rather than three call
/// sites that silently assumed 1:1.
fn buffer_size(size: Size<i32, Physical>) -> Size<i32, BufferCoord> {
    Size::from((size.w, size.h))
}

impl CapturedFrame {
    /// Encode as JPEG for the wire.
    ///
    /// JPEG, not H.264, because this is the transport that proves the
    /// architecture rather than the one that ships. Per-surface hardware
    /// encode (NVENC, 8 concurrent sessions on the dev GPU) is the real
    /// answer and is not implemented; see the module docs.
    ///
    /// JPEG has no alpha channel, so anything transparent composites onto
    /// black here. That is a real limitation of this stopgap and another
    /// reason it is a stopgap.
    pub fn to_jpeg(&self, quality: u8) -> Option<Vec<u8>> {
        use image::codecs::jpeg::JpegEncoder;

        let rgb = self.to_rgb();
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, quality)
            .encode(
                &rgb,
                self.width,
                self.height,
                image::ExtendedColorType::Rgb8,
            )
            .inspect_err(|err| tracing::warn!("jpeg encode failed for {}: {err}", self.id))
            .ok()?;
        Some(out)
    }

    /// Encode as PNG. Lossless, so the debug dump shows exactly what was
    /// captured, including alpha.
    pub fn to_png(&self) -> Option<Vec<u8>> {
        use image::ImageEncoder;
        use image::codecs::png::PngEncoder;

        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(
                &self.rgba,
                self.width,
                self.height,
                image::ExtendedColorType::Rgba8,
            )
            .inspect_err(|err| tracing::warn!("png encode failed for {}: {err}", self.id))
            .ok()?;
        Some(out)
    }

    /// Drop the alpha channel, compositing onto black.
    fn to_rgb(&self) -> Vec<u8> {
        let mut rgb = Vec::with_capacity(self.width as usize * self.height as usize * 3);
        for px in self.rgba.chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        rgb
    }
}

#[cfg(test)]
mod crop_tests {
    use super::unpainted_right;

    /// Build an RGBA buffer, painting every pixel except the last `dead`
    /// columns.
    fn frame(width: i32, height: i32, dead: i32) -> Vec<u8> {
        let mut buf = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..(width - dead) {
                let i = ((y * width + x) * 4) as usize;
                buf[i] = 30;
                buf[i + 1] = 32;
                buf[i + 2] = 38;
                buf[i + 3] = 255;
            }
        }
        buf
    }

    #[test]
    fn a_fully_painted_window_is_not_cropped() {
        // The normal case, and the one that must cost almost nothing: it stops
        // at the first painted column.
        assert_eq!(unpainted_right(&frame(100, 40, 0), 100, 40), 0);
    }

    #[test]
    fn finds_the_band_a_client_leaves_behind() {
        // VS Code, measured: a window declared 1022 wide painted 1010.
        assert_eq!(unpainted_right(&frame(1022, 876, 12), 1022, 876), 12);
    }

    #[test]
    fn a_dark_window_is_not_a_band() {
        // A terminal is nearly black. Testing "dark" rather than "untouched"
        // would crop its whole width and this would be a far worse bug than
        // the one it fixes.
        let mut buf = vec![0u8; (100 * 40 * 4) as usize];
        for i in (0..buf.len()).step_by(4) {
            buf[i] = 1;
            buf[i + 3] = 255;
        }
        assert_eq!(unpainted_right(&buf, 100, 40), 0);
    }

    #[test]
    fn one_painted_pixel_anywhere_keeps_the_column() {
        // A column counts only if *every* pixel in it is untouched, so a
        // window with a thin border down its right edge keeps that edge.
        let mut buf = frame(100, 40, 5);
        let x = 99;
        let i = ((20 * 100 + x) * 4) as usize;
        buf[i + 1] = 200;
        buf[i + 3] = 255;
        assert_eq!(unpainted_right(&buf, 100, 40), 0);
    }

    #[test]
    fn refuses_to_crop_an_implausible_amount() {
        // A window blank down a third of its width is not a misdeclared
        // geometry, it is something else, and cropping it would hide whatever
        // that is. The cap is a twelfth of the width or 64 columns.
        let wide = frame(600, 40, 400);
        assert!(unpainted_right(&wide, 600, 40) <= 64);
    }

    #[test]
    fn crops_an_even_number_of_columns() {
        // H.264 subsamples chroma, so an odd width breaks the encoder and the
        // engine goes down with it. Measured 13 unpainted columns, crop 12.
        assert_eq!(unpainted_right(&frame(100, 40, 13), 100, 40), 12);
        assert_eq!(unpainted_right(&frame(100, 40, 7), 100, 40), 6);
        assert_eq!(unpainted_right(&frame(100, 40, 1), 100, 40), 0);
    }

    #[test]
    fn keeps_the_width_even_when_it_started_even() {
        for dead in 0..20 {
            let kept = 100 - unpainted_right(&frame(100, 40, dead), 100, 40);
            assert_eq!(kept % 2, 0, "odd width after cropping {dead} columns");
        }
    }

    #[test]
    fn an_entirely_blank_window_is_left_alone() {
        // A window that has never painted must not be cropped to nothing.
        let blank = vec![0u8; (100 * 40 * 4) as usize];
        let dead = unpainted_right(&blank, 100, 40);
        assert!(dead < 100, "cropped the whole window");
    }
}
