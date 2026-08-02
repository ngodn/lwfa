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
//! # The read-back is pipelined
//!
//! A render pass and its read-back are issued on one pass and *mapped* on the
//! next, because the GL copy is asynchronous and it is the map that waits for
//! the GPU. Mapping in the same pass stalled the calloop thread, which is also
//! the input and on-screen rendering thread, for the full render-plus-copy of
//! every captured window. See [`Pending`].
//!
//! The mapped pixels go straight into a pooled ffmpeg frame ([`FramePool`])
//! that the encoder consumes without another copy or conversion: NVENC takes
//! the RGBA bytes as they are and converts to YUV on the GPU. See `encode.rs`.

use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex};

use ffmpeg_next as ff;
use lwfa_proto::WindowId;
use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::surface::{
    WaylandSurfaceRenderElement, render_elements_from_surface_tree,
};
use smithay::backend::renderer::element::{Element, Kind, RenderElement};
use smithay::backend::renderer::gles::{GlesMapping, GlesRenderer, GlesTexture};
use smithay::backend::renderer::utils::CommitCounter;
use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame, Offscreen, Renderer};
use smithay::desktop::Window;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{
    Buffer as BufferCoord, Logical, Physical, Point, Rectangle, Scale, Size, Transform,
};
use smithay::wayland::seat::WaylandFocus;

/// A captured window image.
///
/// The pixels sit in a pooled ffmpeg frame from the moment they leave the GPU,
/// so the encoder receives them without another copy. The bytes are RGBA in
/// memory; the frame is labelled `RGB0`, which tells NVENC to read them as
/// written and ignore the fourth byte. The alpha survives in the data itself,
/// which is what the PNG debug dump reads.
///
/// The data is *strided*: ffmpeg aligns rows, so a row occupies
/// `frame.stride(0)` bytes of which the first `width * 4` are pixels.
pub struct CapturedFrame {
    pub id: WindowId,
    pub width: u32,
    pub height: u32,
    pub frame: PooledFrame,
}

/// Reusable ffmpeg frames, shared by the capture and encoder threads.
///
/// A full-size frame is several megabytes, and one used to be allocated per
/// window per frame on each side of the thread boundary. The pool keeps a
/// handful warm instead; a [`PooledFrame`] returns itself here when it drops,
/// wherever that happens, so the encoder thread needs no explicit hand-back.
pub struct FramePool {
    frames: Mutex<Vec<ff::frame::Video>>,
}

/// How many idle frames to keep. Bounded so a burst of resizes cannot pin a
/// pile of stale-sized buffers; evicted oldest-first, so frames of a size no
/// longer in use age out on their own.
const POOL_KEEP: usize = 8;

impl FramePool {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            frames: Mutex::new(Vec::new()),
        })
    }

    /// A frame of exactly this size, reused if one is idle.
    fn get(self: &Arc<Self>, width: u32, height: u32) -> PooledFrame {
        let reused = self.frames.lock().ok().and_then(|mut frames| {
            frames
                .iter()
                .position(|f| f.width() == width && f.height() == height)
                .map(|i| frames.swap_remove(i))
        });
        let frame = reused
            .unwrap_or_else(|| ff::frame::Video::new(ff::format::Pixel::RGBZ, width, height));
        PooledFrame {
            frame: Some(frame),
            pool: Arc::clone(self),
        }
    }

    fn put(&self, frame: ff::frame::Video) {
        let Ok(mut frames) = self.frames.lock() else {
            return;
        };
        if frames.len() >= POOL_KEEP {
            frames.remove(0);
        }
        frames.push(frame);
    }
}

/// A frame borrowed from the [`FramePool`]. Returns itself on drop.
pub struct PooledFrame {
    frame: Option<ff::frame::Video>,
    pool: Arc<FramePool>,
}

impl Deref for PooledFrame {
    type Target = ff::frame::Video;
    fn deref(&self) -> &Self::Target {
        self.frame.as_ref().expect("present until drop")
    }
}

impl DerefMut for PooledFrame {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.frame.as_mut().expect("present until drop")
    }
}

impl Drop for PooledFrame {
    fn drop(&mut self) {
        if let Some(frame) = self.frame.take() {
            self.pool.put(frame);
        }
    }
}

/// A readback in flight: issued last pass, mapped on the next one.
///
/// The `ReadPixels` behind [`ExportMem::copy_framebuffer`] is asynchronous; it
/// is the *map* that waits for the GPU. Mapping in the same pass therefore
/// stalled the calloop thread for the whole render-plus-readback, once per
/// window per frame, with input and on-screen rendering queued behind it. Held
/// here instead, the GPU has a full tick to finish and the map returns at
/// once. Costs one tick of stream latency, which the encoder and network dwarf.
struct Pending {
    mapping: GlesMapping,
    size: Size<i32, Physical>,
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
    /// At most one readback in flight per window. Issuing a second before the
    /// first is mapped would just queue GPU work nobody can consume yet.
    pending: Option<Pending>,
}

pub struct SurfaceCapture {
    targets: HashMap<WindowId, Target>,
    pool: Arc<FramePool>,
}

impl Default for SurfaceCapture {
    fn default() -> Self {
        Self {
            targets: HashMap::new(),
            pool: FramePool::new(),
        }
    }
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

    /// Capture one window.
    ///
    /// Two things happen, pipelined across calls. A readback issued on the
    /// previous pass is mapped and returned, and if the window has committed
    /// since it was last captured, the next readback is issued. So the frame
    /// returned is the one whose copy the GPU has had a whole tick to finish,
    /// and `None` means "nothing in flight and nothing changed", which for an
    /// idle window is every call.
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
        let harvested = self.harvest(renderer, id);
        self.issue(renderer, id, window, size, overlays);
        harvested
    }

    /// Map the readback issued last pass, if there is one, into a pooled frame.
    fn harvest(&mut self, renderer: &mut GlesRenderer, id: WindowId) -> Option<CapturedFrame> {
        let target = self.targets.get_mut(&id)?;
        let pending = target.pending.take()?;

        let bytes = renderer
            .map_texture(&pending.mapping)
            .inspect_err(|err| tracing::warn!("could not map capture buffer for {id}: {err}"))
            .ok()?;

        let width = pending.size.w as u32;
        let height = pending.size.h as u32;
        let expected = width as usize * height as usize * 4;
        if bytes.len() < expected {
            tracing::warn!(
                "capture for {id} returned {} bytes, expected {expected}",
                bytes.len()
            );
            return None;
        }

        // The one CPU copy on the whole path: out of the mapped pixel buffer,
        // straight into the frame the encoder will read.
        let mut frame = self.pool.get(width, height);
        copy_rows(&bytes[..expected], &mut frame, width, height);

        Some(CapturedFrame {
            id,
            width,
            height,
            frame,
        })
    }

    /// Render the window and start reading it back, if it changed.
    fn issue(
        &mut self,
        renderer: &mut GlesRenderer,
        id: WindowId,
        window: &Window,
        size: Size<i32, Physical>,
        overlays: &[(WlSurface, Point<i32, Logical>)],
    ) {
        if size.w <= 0 || size.h <= 0 {
            return;
        }

        // One readback in flight per window, checked before any of the
        // per-element work below is paid for. The damage that arrives in the
        // meantime keeps its commit counters, so nothing is lost: the next
        // pass sees them still unequal and issues then.
        if self.targets.get(&id).is_some_and(|t| t.pending.is_some()) {
            return;
        }

        // Not `toplevel()`, which is `None` for an X11 window and would make
        // every X11 client stream nothing at all while still appearing in the
        // strip with the right title and geometry.
        let Some(surface) = window.wl_surface() else {
            return;
        };
        let surface = surface.into_owned();

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

        // The damage check comes first and reads the commit counters straight
        // off the surface tree, before a single render element is built or a
        // client buffer imported. An idle window used to pay for all of that
        // every pass just to learn it was idle, and idle windows are most
        // windows most of the time.
        //
        // The overlay trees join the same set, which is what makes a menu
        // appearing count as damage. Without that the window would look
        // unchanged and the menu would never be sent.
        let mut commits: Vec<CommitCounter> = Vec::new();
        tree_commits(&surface, &mut commits);
        for (overlay, _) in overlays {
            tree_commits(overlay, &mut commits);
        }

        // Recreate the buffer when the window resizes; reuse it otherwise, so
        // the steady state allocates nothing.
        let needs_new_buffer = match self.targets.get(&id) {
            Some(target) => target.size != size,
            None => true,
        };

        if !needs_new_buffer
            && self
                .targets
                .get(&id)
                .is_some_and(|t| t.last_commits == commits)
        {
            // Unchanged. Skipping everything below here is what makes
            // capturing many windows affordable.
            return;
        }

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

        if needs_new_buffer {
            let Ok(texture) = renderer
                .create_buffer(Fourcc::Abgr8888, buffer_size(size))
                .inspect_err(|err| {
                    tracing::warn!("could not create a capture buffer for {id}: {err}")
                })
            else {
                return;
            };
            self.targets.insert(
                id,
                Target {
                    texture,
                    size,
                    last_commits: Vec::new(),
                    pending: None,
                },
            );
        }

        let Some(target) = self.targets.get_mut(&id) else {
            return;
        };
        target.last_commits = commits;

        let whole = Rectangle::from_size(size);
        let Ok(mut framebuffer) = renderer
            .bind(&mut target.texture)
            .inspect_err(|err| tracing::warn!("could not bind capture buffer for {id}: {err}"))
        else {
            return;
        };

        {
            let Ok(mut frame) = renderer
                .render(&mut framebuffer, size, Transform::Normal)
                .inspect_err(|err| tracing::warn!("could not start capture render for {id}: {err}"))
            else {
                return;
            };

            // Transparent, not black: a window with rounded corners or an
            // alpha channel has to arrive with that alpha intact, or the
            // browser cannot composite it over anything.
            if frame.clear(Color32F::TRANSPARENT, &[whole]).is_err() {
                return;
            }

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

            // The fence from `finish` is deliberately not waited on. The
            // `ReadPixels` issued by `copy_framebuffer` below is queued on the
            // same GL context as the draws above, and GL executes a context's
            // commands in order, so the readback always sees the finished
            // render; the fence answers "has the GPU caught up", which only
            // the *map* needs, and that happens a pass later, by which point
            // it has. The explicit wait here was a full render-length stall of
            // the calloop thread, per window, per frame.
            if let Err(err) = frame.finish() {
                tracing::warn!("capture finish failed for {id}: {err}");
                return;
            }
        }

        let Ok(mapping) = renderer
            .copy_framebuffer(
                &framebuffer,
                Rectangle::from_size(buffer_size(size)),
                Fourcc::Abgr8888,
            )
            .inspect_err(|err| tracing::warn!("could not copy capture buffer for {id}: {err}"))
        else {
            return;
        };
        drop(framebuffer);

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
        target.pending = Some(Pending { mapping, size });
    }
}

/// The commit counters of every surface in a tree, in traversal order.
///
/// This is the cheap read behind the damage check: it walks the tree and
/// copies one counter per surface, where building render elements walks the
/// same tree while also importing client buffers into the renderer. The
/// counters are the same ones a render element would report, because both
/// read them from the surface's renderer state.
///
/// A surface no renderer has imported yet has no state and contributes
/// nothing; once it is imported it appears, the set changes, and that reads
/// as damage, which it is.
fn tree_commits(surface: &WlSurface, out: &mut Vec<CommitCounter>) {
    use smithay::backend::renderer::utils::RendererSurfaceStateUserData;
    use smithay::wayland::compositor::{TraversalAction, with_surface_tree_downward};

    with_surface_tree_downward(
        surface,
        (),
        |_, _, ()| TraversalAction::DoChildren(()),
        // The traversal hands each surface's states in: they must be read from
        // that argument, not through `with_states`, because the walk already
        // holds the surface's state lock and taking it again deadlocks the
        // calloop thread. That is the whole compositor: render, input, all of
        // it, stopped on the first captured frame.
        |_, states, ()| {
            if let Some(state) = states
                .data_map
                .get::<RendererSurfaceStateUserData>()
                .and_then(|data| data.lock().ok())
            {
                out.push(state.current_commit());
            }
        },
        |_, _, ()| true,
    );
}

/// Copy tightly-packed RGBA rows into an ffmpeg frame, honouring its stride.
///
/// ffmpeg aligns each row, so the destination stride is usually wider than
/// `width * 4`. Copying the buffer wholesale would shear the image.
fn copy_rows(rgba: &[u8], frame: &mut ff::frame::Video, width: u32, height: u32) {
    let stride = frame.stride(0);
    let row_bytes = width as usize * 4;
    let dst = frame.data_mut(0);
    for y in 0..height as usize {
        let src_start = y * row_bytes;
        let dst_start = y * stride;
        let Some(src) = rgba.get(src_start..src_start + row_bytes) else {
            break;
        };
        let Some(dst_row) = dst.get_mut(dst_start..dst_start + row_bytes) else {
            break;
        };
        dst_row.copy_from_slice(src);
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
    /// A frame built from packed RGBA bytes, for tests.
    #[cfg(test)]
    pub fn for_tests(id: WindowId, width: u32, height: u32, rgba: &[u8]) -> Self {
        let pool = FramePool::new();
        let mut frame = pool.get(width, height);
        copy_rows(rgba, &mut frame, width, height);
        Self {
            id,
            width,
            height,
            frame,
        }
    }

    /// The pixel rows, without the stride padding between them.
    fn rows(&self) -> impl Iterator<Item = &[u8]> {
        let stride = self.frame.stride(0);
        let row_bytes = self.width as usize * 4;
        let data = self.frame.data(0);
        (0..self.height as usize)
            .map(move |y| &data[y * stride..y * stride + row_bytes])
    }

    /// The pixels, tightly packed RGBA. A copy; for the fallback paths only.
    pub fn packed_rgba(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.width as usize * self.height as usize * 4);
        for row in self.rows() {
            out.extend_from_slice(row);
        }
        out
    }

    /// Encode as JPEG for the wire.
    ///
    /// The fallback when hardware sessions run out or the client cannot
    /// decode video at all. JPEG has no alpha channel, so anything
    /// transparent composites onto black here.
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
    /// captured, including alpha, which the pixel data still carries even
    /// though the encoder is told to ignore it.
    pub fn to_png(&self) -> Option<Vec<u8>> {
        use image::ImageEncoder;
        use image::codecs::png::PngEncoder;

        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(
                &self.packed_rgba(),
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
        for row in self.rows() {
            for px in row.chunks_exact(4) {
                rgb.extend_from_slice(&px[..3]);
            }
        }
        rgb
    }
}

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    fn gradient(width: u32, height: u32) -> Vec<u8> {
        (0..width as usize * height as usize)
            .flat_map(|i| {
                let x = (i % width as usize) as u8;
                let y = (i / width as usize) as u8;
                [x, y, x.wrapping_add(y), 255]
            })
            .collect()
    }

    #[test]
    fn copy_rows_respects_a_wider_destination_stride() {
        // The bug this guards against shears the image diagonally, which is
        // easy to mistake for a capture problem three layers away.
        let width = 7; // deliberately not a multiple of any alignment
        let height = 4;
        let src = gradient(width, height);
        let mut dst = ff::frame::Video::new(ff::format::Pixel::RGBZ, width, height);

        copy_rows(&src, &mut dst, width, height);

        let stride = dst.stride(0);
        let row_bytes = width as usize * 4;
        for y in 0..height as usize {
            let expected = &src[y * row_bytes..(y + 1) * row_bytes];
            let actual = &dst.data(0)[y * stride..y * stride + row_bytes];
            assert_eq!(actual, expected, "row {y} differs");
        }
    }

    #[test]
    fn packed_rgba_round_trips_through_the_stride() {
        // What goes in packed must come out packed, whatever ffmpeg chose as
        // the row alignment in between.
        let src = gradient(7, 4);
        let frame = CapturedFrame::for_tests(WindowId(1), 7, 4, &src);
        assert_eq!(frame.packed_rgba(), src);
    }

    #[test]
    fn the_pool_reuses_a_frame_of_the_same_size() {
        let pool = FramePool::new();
        let first = pool.get(64, 64);
        let ptr = first.data(0).as_ptr();
        drop(first);
        let second = pool.get(64, 64);
        assert_eq!(second.data(0).as_ptr(), ptr, "should be the same buffer");
    }

    #[test]
    fn the_pool_does_not_hand_out_the_wrong_size() {
        let pool = FramePool::new();
        drop(pool.get(64, 64));
        let other = pool.get(32, 32);
        assert_eq!((other.width(), other.height()), (32, 32));
    }

    #[test]
    fn the_pool_is_bounded() {
        let pool = FramePool::new();
        let held: Vec<_> = (0..POOL_KEEP + 4).map(|_| pool.get(16, 16)).collect();
        drop(held);
        let idle = pool.frames.lock().expect("not poisoned").len();
        assert!(idle <= POOL_KEEP, "kept {idle} frames");
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
