# How lwfa streams a desktop

Every window is its own video stream, encoded on NVENC and decoded with
[WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API), so
the browser composites real DOM elements rather than one screen rectangle. That
is the difference that makes a desktop usable on a tablet: the shell can lay
windows out for the screen you are actually holding.

## Codecs

Negotiated per session: HEVC where every connected device decodes it, H.264
otherwise, JPEG as the last resort. JPEG is also what you get on a plain-HTTP
page, since `VideoDecoder` is a secure-context API. See
[TLS](remote-access.md#tls).

## Zero copy, when the driver allows it

Pixels never leave the GPU: the rendered window texture is handed to CUDA
through GL interop and NVENC reads it in place, so nothing but the compressed
bitstream ever reaches system RAM.

On any failure the engine falls back to read-back capture by itself.
`[stream] gpu_direct` exists to force the fallback for debugging.

## Bitrate that follows the network

A frame stays on a client's account until the kernel accepts it, so
backpressure is the network's own voice rather than a guess. A fresh connection
climbs to the 32 Mbit/s ceiling in about six seconds on a clean LAN, and a
congested one backs off without buffering seconds of stale video inside the
socket.

Delay is measured as well as throughput, from a median of recent round trips
rather than the best one seen, so a link that is merely jittery is not mistaken
for a clear one. A connection that drops and returns resumes at the quality it
had rather than climbing again from the floor.

The focused window gets the budget. Inactive windows pause by default, frozen on
their last frame, and resume the moment they are focused. A paused window's
application is told to stop rendering too, so a window nobody watches costs
approximately nothing.

## Audio

Opus on the same socket, with its own send accounting so fifty audio chunks a
second can never crowd video out. Off until a device asks for it. See
[the shell](shell.md#audio).

## Next

- [The shell](shell.md), which decides what is drawn where
- [Playing games](gaming.md)
- [Architecture](architecture.md), for why any of this is shaped the way it is
