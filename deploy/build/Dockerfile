# Build lwfa against an old glibc, so the release runs on more than one distro.
#
# # Why this exists
#
# A binary built on Arch requires the glibc it was built against, and so does
# every library bundled with it. Running one on Debian 13 fails at exec:
#
#   libm.so.6: version `GLIBC_2.43' not found (required by libavcodec.so.62)
#
# Bundling cannot fix that. glibc is resolved by the host's loader, and its
# symbol versions are a floor, not a preference. The only real answer is to
# build against the oldest glibc you intend to support, because glibc is
# backward compatible: a binary needing 2.31 runs on 2.39, never the reverse.
#
# Debian 11 has glibc 2.31, which covers essentially everything still in
# service: Debian 11+, Ubuntu 20.04+, Fedora 32+, RHEL 9+, and every rolling
# distribution.
#
# # Why FFmpeg is built here rather than installed
#
# `ffmpeg-next 8.1` needs FFmpeg 8 headers, and no old distribution ships
# them; Debian 11 has 4.3. Since the release bundles FFmpeg anyway, building
# it here costs nothing extra at run time and removes the last reason to care
# what the host has installed.
#
# `--enable-nvenc` needs only nv-codec-headers, not the CUDA toolkit: FFmpeg
# opens libcuda at run time, from the driver on the machine that runs it. That
# is what makes it possible to build NVENC support on a machine with no NVIDIA
# hardware at all, including CI.
#
# # What is deliberately absent
#
# Node. The shell is built on the host and copied in, because it is a static
# bundle whose output does not depend on glibc at all, and a JavaScript
# toolchain in here would double the image for nothing.
FROM debian:11

ENV DEBIAN_FRONTEND=noninteractive

# Build tooling, plus the headers Smithay needs for the winit and EGL backends.
# libwayland and libEGL are opened at run time rather than linked, but their
# headers are still needed to compile against.
#
# clang is here for bindgen, which ffmpeg-sys-next uses to generate its
# bindings from the FFmpeg headers. It is a build-time tool, not a link-time
# dependency, so it does not follow the binary anywhere.
#
# Deliberately absent: libseat and libdisplay-info, which bullseye does not
# have. They belong to Smithay's TTY/DRM backend, and lwfa runs nested through
# winit, so nothing here compiles against them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config curl ca-certificates git \
      nasm yasm cmake meson ninja-build \
      libwayland-dev libxkbcommon-dev libudev-dev libinput-dev \
      libgbm-dev libdrm-dev libegl1-mesa-dev libgles2-mesa-dev \
      libsystemd-dev patchelf \
      clang libclang-dev \
      libssl-dev libsqlite3-dev libpulse-dev \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# NVENC headers. No CUDA toolkit: FFmpeg dlopens libcuda from the driver at
# run time, so the build machine needs no NVIDIA anything.
ARG NV_CODEC_HEADERS=n13.0.19.0
RUN git clone --depth 1 --branch "$NV_CODEC_HEADERS" \
      https://github.com/FFmpeg/nv-codec-headers.git /tmp/nv \
    && make -C /tmp/nv install PREFIX=/usr/local \
    && rm -rf /tmp/nv

# FFmpeg, shared, and only what lwfa asks for.
#
# The encoders it actually uses are h264_nvenc and hevc_nvenc; the rest of
# FFmpeg's codec zoo would be dead weight in the bundle. Built shared rather
# than static because ffmpeg-next links the libraries by soname, and shared is
# the arrangement the packaging step already knows how to carry.
#
# --disable-programs because nothing here needs the ffmpeg CLI, and
# --disable-doc because manual pages in a build container help nobody.
ARG FFMPEG_VERSION=8.1
RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o /tmp/ffmpeg.tar.xz \
    && mkdir -p /tmp/ffmpeg && tar xf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 \
    && cd /tmp/ffmpeg \
    && ./configure \
         --prefix=/usr/local \
         --enable-shared --disable-static \
         --disable-programs --disable-doc \
         --disable-everything \
         --enable-nvenc \
         --enable-encoder=h264_nvenc,hevc_nvenc,mjpeg \
         --enable-decoder=h264,hevc,mjpeg,rawvideo \
         --enable-parser=h264,hevc,mjpeg \
         --enable-muxer=null,rawvideo \
         --enable-demuxer=rawvideo \
         --enable-protocol=file \
         --enable-filter=scale,null \
         --enable-swscale --enable-swresample \
         --enable-avdevice --enable-avfilter --enable-avformat \
    && make -j"$(nproc)" && make install \
    && ldconfig && rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz

# Rust, pinned to what rust-toolchain.toml asks for. Installed after the slow
# layers so a toolchain bump does not rebuild FFmpeg.
ARG RUST_VERSION=1.95.0
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y \
      --default-toolchain "$RUST_VERSION" --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib

# patchelf comes from apt: bullseye ships 0.12, which has both --set-rpath and
# --force-rpath, and those are all the packaging step uses. Checked rather than
# assumed, because building it from source here failed on the release tarball's
# layout and would have been a dependency for no gain.

WORKDIR /src
