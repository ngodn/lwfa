//! Zero-copy capture: the rendered window goes to NVENC without ever
//! touching system RAM.
//!
//! # The path this replaces
//!
//! The portable pipeline reads each captured window back over PCIe, copies it
//! into an ffmpeg frame on the CPU, and uploads it straight back to the GPU it
//! came from for encoding. Two bus crossings and a CPU copy per frame, per
//! window, to move pixels between two units of the same card.
//!
//! Here the rendered texture is handed to CUDA through GL interop and copied
//! GPU-to-GPU into a CUDA buffer that ffmpeg's NVENC wrapper encodes in place.
//! The only thing that ever reaches system RAM is the compressed bitstream.
//!
//! # Division of labour
//!
//! ffmpeg does everything hard: `av_hwdevice_ctx_create` owns the CUDA
//! context, the hardware frames pool recycles device buffers, and its nvenc
//! wrapper registers and maps them. This module only bridges GL to CUDA:
//! register the capture texture, map it, one device-to-device copy, unmap.
//! Eight driver functions, loaded from `libcuda.so.1` at runtime, so a build
//! runs unchanged on a machine with no NVIDIA driver and simply reports the
//! path unavailable.
//!
//! # Failure policy
//!
//! Any error anywhere disables this path for the rest of the run and the
//! portable pipeline carries on. A session that falls back is slower, never
//! broken.
//!
//! # Safety
//!
//! This is the FFI-and-GPU boundary the workspace lint anticipates. Every
//! unsafe block talks to either the CUDA driver API, whose signatures are
//! pinned against `/opt/cuda/include/cuda.h`, or ffmpeg's hwcontext API
//! through the same bindings the rest of the encoder already trusts.

#![allow(unsafe_code)]
// The driver struct's fields are named after the exact C symbols they hold,
// because grepping a CUDA error message for the function name should land
// here, not on a translation of it.
#![allow(non_snake_case)]

use std::ffi::{c_char, c_int, c_uint, c_void};
use std::ptr;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use ffmpeg_next as ff;

// ---------------------------------------------------------------------------
// CUDA driver API, the eight functions this needs
// ---------------------------------------------------------------------------

type CUresult = c_int;
type CUcontext = *mut c_void;
type CUstream = *mut c_void;
type CUarray = *mut c_void;
type CUgraphicsResource = *mut c_void;
type CUdeviceptr = u64;

const CUDA_SUCCESS: CUresult = 0;
const GL_TEXTURE_2D: c_uint = 0x0DE1;
const CU_GRAPHICS_REGISTER_FLAGS_READ_ONLY: c_uint = 0x01;
const CU_MEMORYTYPE_DEVICE: c_uint = 0x02;
const CU_MEMORYTYPE_ARRAY: c_uint = 0x03;

/// `CUDA_MEMCPY2D`, laid out field-for-field against cuda.h.
#[repr(C)]
struct CudaMemcpy2d {
    src_x_in_bytes: usize,
    src_y: usize,
    src_memory_type: c_uint,
    src_host: *const c_void,
    src_device: CUdeviceptr,
    src_array: CUarray,
    src_pitch: usize,
    dst_x_in_bytes: usize,
    dst_y: usize,
    dst_memory_type: c_uint,
    dst_host: *mut c_void,
    dst_device: CUdeviceptr,
    dst_array: CUarray,
    dst_pitch: usize,
    width_in_bytes: usize,
    height: usize,
}

/// The public prefix of ffmpeg's `AVCUDADeviceContext`: the context and the
/// stream, which are the two fields this module reads. The struct has private
/// fields after them, never touched here.
#[repr(C)]
struct AvCudaDeviceContext {
    cuda_ctx: CUcontext,
    stream: CUstream,
}

macro_rules! cu_fns {
    ($($name:ident : fn($($arg:ty),*) -> CUresult;)*) => {
        struct Driver {
            $($name: unsafe extern "C" fn($($arg),*) -> CUresult,)*
        }

        impl Driver {
            /// Load `libcuda.so.1` and resolve every function, or say why not.
            fn load() -> Result<Self, String> {
                // The `_v2`-suffixed symbols where cuda.h defines them: the
                // unsuffixed names are the pre-2010 ABI kept for old binaries.
                let names = [$(concat!(stringify!($name), "\0"),)*];
                let lib = unsafe {
                    libc::dlopen(c"libcuda.so.1".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL)
                };
                if lib.is_null() {
                    return Err("libcuda.so.1 is not loadable".into());
                }
                let mut ptrs = names.iter().map(|name| {
                    let sym = unsafe { libc::dlsym(lib, name.as_ptr().cast::<c_char>()) };
                    if sym.is_null() {
                        Err(format!("{} missing from libcuda", name.trim_end_matches('\0')))
                    } else {
                        Ok(sym)
                    }
                });
                Ok(Self {
                    $($name: {
                        let sym = ptrs.next().expect("one pointer per name")?;
                        // Transmuting a dlsym result to the signature pinned
                        // against cuda.h is the entire point of dlsym.
                        unsafe { std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($arg),*) -> CUresult>(sym) }
                    },)*
                })
            }
        }
    };
}

cu_fns! {
    cuCtxPushCurrent_v2: fn(CUcontext) -> CUresult;
    cuCtxPopCurrent_v2: fn(*mut CUcontext) -> CUresult;
    cuMemcpy2D_v2: fn(*const CudaMemcpy2d) -> CUresult;
    cuGraphicsGLRegisterImage: fn(*mut CUgraphicsResource, c_uint, c_uint, c_uint) -> CUresult;
    cuGraphicsMapResources: fn(c_uint, *mut CUgraphicsResource, CUstream) -> CUresult;
    cuGraphicsUnmapResources: fn(c_uint, *mut CUgraphicsResource, CUstream) -> CUresult;
    cuGraphicsSubResourceGetMappedArray: fn(*mut CUarray, CUgraphicsResource, c_uint, c_uint) -> CUresult;
    cuGraphicsUnregisterResource: fn(CUgraphicsResource) -> CUresult;
}

// ---------------------------------------------------------------------------
// The shared device
// ---------------------------------------------------------------------------

/// One CUDA device context for the whole engine, created by ffmpeg and shared
/// with the interop calls here. Never freed: it lives as long as the process,
/// like the GL context it mirrors.
struct Device {
    driver: Driver,
    /// `av_hwdevice_ctx_create` result. Sessions ref it; the frames pools ref
    /// it; it outlives them all.
    device_ref: *mut ff::ffi::AVBufferRef,
    cuda_ctx: CUcontext,
}

// The context is used from the calloop thread (interop copies) and by ffmpeg
// on the encoder thread (which pushes/pops it itself). CUDA contexts are made
// for exactly this; the raw pointers are what stop Send from deriving.
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

/// Tripped by the first failure; checked before every use.
static DISABLED: AtomicBool = AtomicBool::new(false);
static DEVICE: OnceLock<Option<Device>> = OnceLock::new();

fn device() -> Option<&'static Device> {
    if DISABLED.load(Ordering::Relaxed) {
        return None;
    }
    DEVICE
        .get_or_init(|| {
            let driver = match Driver::load() {
                Ok(driver) => driver,
                Err(why) => {
                    tracing::info!("zero-copy encode unavailable: {why}");
                    return None;
                }
            };
            let mut device_ref: *mut ff::ffi::AVBufferRef = ptr::null_mut();
            let err = unsafe {
                ff::ffi::av_hwdevice_ctx_create(
                    &mut device_ref,
                    ff::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
                    ptr::null(),
                    ptr::null_mut(),
                    0,
                )
            };
            if err < 0 || device_ref.is_null() {
                tracing::info!("zero-copy encode unavailable: no CUDA device context ({err})");
                return None;
            }
            let cuda_ctx = unsafe {
                let hw = (*device_ref).data.cast::<ff::ffi::AVHWDeviceContext>();
                (*(*hw).hwctx.cast::<AvCudaDeviceContext>()).cuda_ctx
            };
            if cuda_ctx.is_null() {
                tracing::info!("zero-copy encode unavailable: device context has no CUcontext");
                return None;
            }
            tracing::info!("zero-copy encode ready: GL capture feeds NVENC on the GPU");
            Some(Device {
                driver,
                device_ref,
                cuda_ctx,
            })
        })
        .as_ref()
}

/// Give up on the GPU path for the rest of the run.
fn disable(what: &str, err: CUresult) {
    if !DISABLED.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            "zero-copy encode disabled after {what} failed with CUDA error {err}; \
             falling back to read-back capture"
        );
    }
}

/// Is the zero-copy path usable right now?
pub fn available() -> bool {
    device().is_some()
}

// ---------------------------------------------------------------------------
// Per-window state
// ---------------------------------------------------------------------------

/// The GL-to-CUDA bridge for one window's capture texture.
pub struct GpuTarget {
    /// The registered GL texture. Registration is per texture object, so a
    /// resize, which recreates the texture, recreates this too.
    resource: CUgraphicsResource,
    tex: u32,
    width: u32,
    height: u32,
    /// The CUDA frame pool for this window's size, owned by ffmpeg.
    frames_ref: *mut ff::ffi::AVBufferRef,
}

impl GpuTarget {
    /// Bridge one texture, building the frame pool for its size.
    pub fn new(tex: u32, width: u32, height: u32) -> Option<Self> {
        let device = device()?;

        let frames_ref = unsafe {
            let frames_ref = ff::ffi::av_hwframe_ctx_alloc(device.device_ref);
            if frames_ref.is_null() {
                disable("allocating a frame pool", -1);
                return None;
            }
            let ctx = (*frames_ref).data.cast::<ff::ffi::AVHWFramesContext>();
            (*ctx).format = ff::ffi::AVPixelFormat::AV_PIX_FMT_CUDA;
            (*ctx).sw_format = ff::ffi::AVPixelFormat::AV_PIX_FMT_RGB0;
            (*ctx).width = width as c_int;
            (*ctx).height = height as c_int;
            // Enough for the frame being encoded plus the one being copied,
            // with slack for the encoder holding a reference across a packet.
            (*ctx).initial_pool_size = 4;
            let err = ff::ffi::av_hwframe_ctx_init(frames_ref);
            if err < 0 {
                let mut frames_ref = frames_ref;
                ff::ffi::av_buffer_unref(&mut frames_ref);
                disable("initialising a frame pool", err);
                return None;
            }
            frames_ref
        };

        let mut resource: CUgraphicsResource = ptr::null_mut();
        let err = unsafe {
            let mut popped: CUcontext = ptr::null_mut();
            (device.driver.cuCtxPushCurrent_v2)(device.cuda_ctx);
            let err = (device.driver.cuGraphicsGLRegisterImage)(
                &mut resource,
                tex,
                GL_TEXTURE_2D,
                CU_GRAPHICS_REGISTER_FLAGS_READ_ONLY,
            );
            (device.driver.cuCtxPopCurrent_v2)(&mut popped);
            err
        };
        if err != CUDA_SUCCESS {
            unsafe {
                let mut frames_ref = frames_ref;
                ff::ffi::av_buffer_unref(&mut frames_ref);
            }
            disable("registering the capture texture", err);
            return None;
        }

        Some(Self {
            resource,
            tex,
            width,
            height,
            frames_ref,
        })
    }

    /// Does this bridge still match the capture buffer it was built for?
    pub fn matches(&self, tex: u32, width: u32, height: u32) -> bool {
        self.tex == tex && self.width == width && self.height == height
    }

    /// Copy the rendered texture into a CUDA frame the encoder reads in place.
    ///
    /// The map call synchronises against the GL work already issued on the
    /// texture, which is what makes reading it here safe without a fence: the
    /// same driver owns both queues.
    pub fn frame(&mut self) -> Option<ff::frame::Video> {
        let device = device()?;

        let mut frame = ff::frame::Video::empty();
        let err = unsafe { ff::ffi::av_hwframe_get_buffer(self.frames_ref, frame.as_mut_ptr(), 0) };
        if err < 0 {
            disable("taking a frame from the pool", err);
            return None;
        }

        let err = unsafe {
            let mut popped: CUcontext = ptr::null_mut();
            (device.driver.cuCtxPushCurrent_v2)(device.cuda_ctx);

            let mut err = (device.driver.cuGraphicsMapResources)(1, &mut self.resource, ptr::null_mut());
            if err == CUDA_SUCCESS {
                let mut array: CUarray = ptr::null_mut();
                err = (device.driver.cuGraphicsSubResourceGetMappedArray)(
                    &mut array,
                    self.resource,
                    0,
                    0,
                );
                if err == CUDA_SUCCESS {
                    let raw = frame.as_ptr();
                    let copy = CudaMemcpy2d {
                        src_x_in_bytes: 0,
                        src_y: 0,
                        src_memory_type: CU_MEMORYTYPE_ARRAY,
                        src_host: ptr::null(),
                        src_device: 0,
                        src_array: array,
                        src_pitch: 0,
                        dst_x_in_bytes: 0,
                        dst_y: 0,
                        dst_memory_type: CU_MEMORYTYPE_DEVICE,
                        dst_host: ptr::null_mut(),
                        dst_device: (*raw).data[0] as CUdeviceptr,
                        dst_array: ptr::null_mut(),
                        dst_pitch: (*raw).linesize[0] as usize,
                        width_in_bytes: self.width as usize * 4,
                        height: self.height as usize,
                    };
                    err = (device.driver.cuMemcpy2D_v2)(&copy);
                }
                let unmap =
                    (device.driver.cuGraphicsUnmapResources)(1, &mut self.resource, ptr::null_mut());
                if err == CUDA_SUCCESS {
                    err = unmap;
                }
            }

            (device.driver.cuCtxPopCurrent_v2)(&mut popped);
            err
        };
        if err != CUDA_SUCCESS {
            disable("copying the texture to CUDA", err);
            return None;
        }

        Some(frame)
    }
}

impl Drop for GpuTarget {
    fn drop(&mut self) {
        if let Some(device) = DEVICE.get().and_then(Option::as_ref) {
            unsafe {
                let mut popped: CUcontext = ptr::null_mut();
                (device.driver.cuCtxPushCurrent_v2)(device.cuda_ctx);
                let _ = (device.driver.cuGraphicsUnregisterResource)(self.resource);
                (device.driver.cuCtxPopCurrent_v2)(&mut popped);
            }
        }
        unsafe {
            ff::ffi::av_buffer_unref(&mut self.frames_ref);
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers the encoder needs
// ---------------------------------------------------------------------------

/// Attach a CUDA frame's pool to an encoder about to be opened.
///
/// nvenc reads device frames only when the codec context names the pool they
/// come from; without this, opening the encoder with `AV_PIX_FMT_CUDA` fails.
pub fn adopt_frames(enc: &mut ff::codec::context::Context, frame: &ff::frame::Video) -> bool {
    unsafe {
        let src = (*frame.as_ptr()).hw_frames_ctx;
        if src.is_null() {
            return false;
        }
        let referenced = ff::ffi::av_buffer_ref(src);
        if referenced.is_null() {
            return false;
        }
        (*enc.as_mut_ptr()).hw_frames_ctx = referenced;
        true
    }
}

/// Is this frame on the GPU?
pub fn is_gpu(frame: &ff::frame::Video) -> bool {
    frame.format() == ff::format::Pixel::CUDA
}

/// Download a GPU frame, for the paths that genuinely need pixels on the CPU:
/// the JPEG fallback and the PNG debug dump.
pub fn download(frame: &ff::frame::Video) -> Option<ff::frame::Video> {
    let mut cpu = ff::frame::Video::empty();
    let err = unsafe { ff::ffi::av_hwframe_transfer_data(cpu.as_mut_ptr(), frame.as_ptr(), 0) };
    if err < 0 {
        tracing::warn!("could not download a GPU frame ({err})");
        return None;
    }
    Some(cpu)
}
