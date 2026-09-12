# libopus 1.6.1

Portable floating-point sources from the official Xiph release, unmodified.

Source: https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz
SHA256: `6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1`
Release and checksum: https://opus-codec.org/downloads/

The SwiftPM target includes OPUS_SOURCES, OPUS_SOURCES_FLOAT, CELT_SOURCES,
SILK_SOURCES and SILK_SOURCES_FLOAT from the release's *_sources.mk manifests,
and their headers. No assembly, DRED neural-network models or platform-specific
SIMD dispatch are enabled. The compiler may vectorize portable C for ARM64.
Encoder objects permit portable round-trip tests and are dead stripped when unused.

The upstream BSD license and additional patent grant are in COPYING.
