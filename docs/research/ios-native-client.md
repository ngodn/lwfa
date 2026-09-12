# Native iPad client

Research date: 2026-09-12. This is an implementation reference, not a claim that the Apple-platform code has been built or measured on a device.

## Recommended boundary

Keep lwfa's engine and wire protocol. Build a SwiftUI application around a separately testable Swift protocol/session package, with VideoToolbox, MetalKit, AVAudioEngine and GameController adapters. Do not embed the browser client in WKWebView as the streaming implementation: that retains the browser input and media paths this work is intended to improve.

The portable package should own binary parsing, control messages, coordinate transforms, input state, reconnect policy and bounded queues. These can run under Swift on Linux. Apple frameworks belong in the iPad target, which needs an Apple SDK build and physical-device validation. Swift language compatibility and operating-system deployment targets are distinct settings. [Swift compatibility](https://docs.swift.org/swift-book/documentation/the-swift-programming-language/compatibility/)

Use a main-actor model for SwiftUI state. Keep network receive, compressed-video processing and input serialization off the main actor. One serial outbound sender must preserve button-down/button-up order; independently launching a Task for each controller callback is not an ordering guarantee. Retain a connection generation so old socket and decoder completions cannot update a replacement session.

## Existing wire contract

The local sources of truth are [TypeScript protocol](../../packages/proto/src/index.ts), [Rust protocol](../../crates/lwfa-proto/src/lib.rs), [handshake and transport](../../crates/lwfa-engine/src/shell.rs), and [browser connection](../../packages/shell/src/connection.ts).

Connect to `/engine` with query parameters `token` (owner or account password), `device` (readable device name), and `client` (stable client identifier). There is no HTTP login endpoint or cookie-based authentication in this handshake. Construct the URL with URLComponents; redact the token from diagnostics. Authentication failures are rejected during the WebSocket upgrade. The engine then sends `hello`; require `protocolVersion == 2` before sending session commands.

Text WebSocket messages are JSON control objects. Binary messages are complete audio/video units with the following headers. All multibyte integers are **little-endian**, including the window ID. Byte 7 is reserved. Header version is independent of JSON protocol version and is currently zero.

| Offset | Video: 24-byte header | Audio: 16-byte header |
| --- | --- | --- |
| 0..3 | ASCII `LWFA` | ASCII `LWFP` |
| 4 | Header version 0 | Header version 0 |
| 5 | 0 JPEG, 1 H.264, 2 HEVC | 0 PCM16LE, 1 Opus |
| 6 | Bit 0: keyframe | Channel count |
| 7 | Reserved | Reserved |
| 8..15 | UInt64 window ID | UInt32 sample rate, UInt32 frames per channel |
| 16..23 | UInt32 width, UInt32 height | Audio payload begins at 16 |
| 24 onward | Encoded image/access unit | Remaining audio payload |

Validate magic, version, lengths, supported codec, nonzero dimensions/sample counts, and arithmetic overflow before allocating. The existing browser limits window IDs to JavaScript's exact integer range, 2^53 - 1. Swift can preserve UInt64 internally but should retain interoperability bounds for JSON IDs. PCM payload length must equal `frames * channels * 2`. An Opus payload is one raw packet, normally 20 ms, 960 frames at 48 kHz stereo. It is not an Ogg stream.

There are no capture timestamps or sequence numbers in these headers. Local receipt/decode/display timings can measure queue delay, but they cannot establish true source-to-display latency or exact source A/V synchronization. Adding source timing is a future protocol change, not a client-only claim.

`URLSessionWebSocketTask` supports message-based receive/send and protocol pings. Keep receiving while work is dispatched to bounded media queues. Explicitly set a finite `maximumMessageSize` large enough for supported keyframes; Apple documents that continuation frames count toward this limit. [WebSocket task](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask), [message limit](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/maximummessagesize)

After hello, request visible windows with `setStreams`, declaring only implemented codecs (`h264`, `hevc`). An empty codec list negotiates JPEG. Repeating `setStreams` requests fresh captures and keyframes, as used by [App.tsx](../../packages/shell/src/App.tsx); there is no separate `requestKeyframe` command. Respect `hello.primary` and subsequent role/layout messages: only the primary should drive `setViewport` and `setLayout`. Reconnect must restore stream/audio/controller subscriptions. Stop retrying when a live session is explicitly replaced, rather than fighting the other client.

## VideoToolbox and Metal

H.264/HEVC payloads are Annex B access units with parameter sets repeated on keyframes. Split both three-byte and four-byte start codes. Retain H.264 SPS/PPS or HEVC VPS/SPS/PPS without start codes. Create the appropriate CMVideoFormatDescription from these parameter sets. Replace Annex B delimiters with four-byte **big-endian** NAL lengths before constructing the CMBlockBuffer/CMSampleBuffer given to VideoToolbox. The sample length prefix byte order differs from lwfa's outer header.

Create a VTDecompressionSession per streamed window and format generation. Hardware capability can be checked by codec; successful session creation and decoding must still be tested for the actual profile, size and stream. Recreate or reconfigure when parameter sets/codec change, and discard deltas until a complete keyframe establishes references. Do not decode arbitrary remaining deltas after dropping an encoded reference frame. On queue overload, either keep decoding references while dropping presentation, or reset and request an IDR. [VideoToolbox sessions](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsession-api-collection), [hardware capability](https://developer.apple.com/documentation/videotoolbox/vtishardwaredecodesupported(_:)), [HEVC parameter sets](https://developer.apple.com/documentation/coremedia/cmvideoformatdescriptioncreatefromhevcparametersets(allocator:parametersetcount:parametersetpointers:parametersetsizes:nalunitheaderlength:extensions:formatdescriptionout:))

Request Metal-compatible CVPixelBuffers. A low-copy path maps NV12 luma/chroma planes through CVMetalTextureCache as R8/RG8 textures and converts YUV to RGB in a fragment shader. Honor the buffer's range and color-matrix attachments; treating video-range data as full range changes black levels. A BGRA pixel-buffer path is easier initially but should not be described as proven zero-copy or as having no conversion cost.

Keep the CVMetalTexture wrappers and source pixel buffer alive until GPU completion. Holding only the extracted MTLTexture is insufficient ownership according to Apple's texture-cache documentation. Bound retained frames and release retired decoders. [CVMetalTextureCacheCreateTextureFromImage](https://developer.apple.com/documentation/corevideo/cvmetaltexturecachecreatetexturefromimage(_:_:_:_:_:_:_:_:_:))

Use SwiftUI for window/navigation controls and a UIViewRepresentable MTKView for streamed surfaces. Do not run encoded frames through SwiftUI image state. MTKView drawableSize is in native pixels and can resize automatically with the view. This is separate from the logical canvas size sent to lwfa. Initially send the actual usable canvas in points with `scale: 1`, matching current browser behavior. Do not silently revive Sharper/More space or multiply engine dimensions by the iPad pixel density. Map input through the precise displayed content rectangle, excluding any letterboxing, and test both corners after rotation/resizing. [MTKView drawable size](https://developer.apple.com/documentation/metalkit/mtkview/drawablesize)

## Audio

Use an AVAudioSession configured for playback, activated when streaming sound starts, and handle interruption/route-change recovery explicitly. This avoids the browser AudioContext gesture/unmute workaround. Audio buffer/sample-rate requests are preferences, not guarantees; inspect the actual route and format after activation. [Audio session](https://developer.apple.com/documentation/avfaudio/avaudiosession), [hardware preference guidance](https://developer.apple.com/library/archive/qa/qa1631/_index.html)

The implementation now bundles official libopus 1.6.1 portable C sources, with the release tarball verified against Xiph's published SHA256. It decodes raw 20 ms packets at 48 kHz stereo on a bounded serial worker, then schedules float PCM through AVAudioEngine. PCM remains supported for server fallback. No Ogg demuxer is needed. The decoder preserves its history across packets and resets it after a dropped queue admission, a stream change, or an audio interruption. Linux tests exercise a real encoder/decoder stereo round trip, the raw silence packet, reset reproducibility, malformed packets and mismatched durations. iPad route behavior and listening quality still require a device test. [Official release and checksum](https://opus-codec.org/downloads/), [Raw packet decoder API](https://opus-codec.org/docs/opus_api-1.6/group__opus__decoder.html)

Apple exposes `kAudioFormatOpus` and compressed-to-PCM conversion, but the format constant alone does not establish a working converter contract for lwfa's raw packets. Bundling libopus avoids claiming unverified AudioConverter support. The BSD license and patent grant ship in the source and app resources. [Opus format identifier](https://developer.apple.com/documentation/coreaudiotypes/kaudioformatopus), [AVAudioConverter](https://developer.apple.com/documentation/avfaudio/avaudioconverter)

Keep a measured jitter cushion rather than scheduling an unbounded backlog. Flush queued audio on disconnect, generation changes and interrupted playback. A route change can change output sample rate; let the audio engine/converter bridge from the fixed wire format. Expose queue duration and underruns in diagnostics. Native APIs alone do not make Bluetooth audio low latency or eliminate network buffering.

## Controller, pointer and keyboard

GameController offers value/pressed-change callbacks for shoulders, triggers, face buttons, sticks and d-pad. This removes the browser Gamepad polling dependency and preserves real holds. Use a dedicated serial input queue with an ordered network sender, not the SwiftUI render loop. Newer physical-input APIs also expose queued states; if adopting them, drain all available states instead of reading only the latest snapshot. Native input still needs device tests for hardware/OS behavior. [Extended gamepad](https://developer.apple.com/documentation/gamecontroller/gcextendedgamepad), [handling input events](https://developer.apple.com/documentation/gamecontroller/handling-input-events)

Match [physical.ts](../../packages/shell/src/gamepad/physical.ts): face buttons 0..3, LB/RB 4/5, LT/RT buttons 6/7, back/start 8/9, stick clicks 10/11, d-pad 12..15, home 16. Analog axes 0/1 are left X/Y, 2/3 right X/Y, 4/5 triggers. Negate native positive-up stick Y for lwfa's positive-down convention. Trigger values remain 0..1. Preserve exact neutral transitions even below the change threshold. On disconnect, backgrounding, target loss or loss of interaction permission, release held buttons and reset axes. Do not synthesize timed taps to mask missed releases.

Hardware keyboard input arrives as native key codes and must be mapped to Linux evdev codes; those are not interchangeable numeric spaces. GCMouse supplies relative motion, while touch/trackpad absolute positioning must use the same content transform as rendering. Avoid forwarding the same hardware event through both GameController and UIKit. Only forward gameplay input when the stream owns input, so credentials and native settings fields remain usable. [Keyboard callbacks](https://developer.apple.com/documentation/gamecontroller/gckeyboardinput/keychangedhandler), [mouse movement](https://developer.apple.com/documentation/gamecontroller/gcmouseinput/mousemovedhandler)

## Connection and credential UX

Default to the existing trusted HTTPS endpoint and WSS. Keep system TLS trust evaluation; do not accept arbitrary server-trust challenges. Save the server-specific credential in Keychain, not UserDefaults or an app log, with accessibility appropriate to an unlocked foreground streaming app. Store a stable non-secret client UUID separately. [Authentication challenges](https://developer.apple.com/documentation/foundation/handling-an-authentication-challenge), [Keychain](https://developer.apple.com/documentation/security/keychain-services), [item accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility)

Include NSLocalNetworkUsageDescription because users may enter a LAN endpoint. Start the first connection while foregrounded so the permission prompt can appear. Bonjour declarations are only needed if discovery is implemented. [Local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)

## Acceptance checks

- Linux: decode Rust-generated protocol fixtures, reject truncated/oversized headers, verify Annex B conversion, ordered input edges, neutral release, coordinate transforms and reconnect generations.
- Apple SDK: compile the actual iPad target with strict Swift concurrency checks; portable-package tests do not validate SDK APIs or actor annotations.
- iPad: trusted WSS login, roles/takeover, HEVC and H.264 decode including resize/IDR recovery, JPEG fallback, audio interruptions/route changes, controller taps/holds/stick direction, keyboard text-field isolation, pointer alignment and canvas rotation.
- Regression: retain the current engine sizing and black-edge fixes. Compare stream geometry and corners against the browser without restarting production or mutating game settings as part of development tests.
- Measure actual frame queue latency, input edge counts and audio underruns before claiming performance gains. Metal accelerates client presentation; it does not change the host game's GPU rendering, disk access or frame-generation behavior.
# Session restoration and intermittent audio, 2026-09-12

Apple distinguishes foreground inactivity from backgrounding. Inactivity means input/work should pause; backgrounding can be followed by process termination. Apps must explicitly restore meaningful state on a later launch. The native app previously mapped every non-active phase to teardown and had no launch restoration. A regression test against the old ConnectionProgress reproduced replacement of the authenticated workspace with the login form. [Inactive](https://developer.apple.com/documentation/swiftui/scenephase/inactive), [background](https://developer.apple.com/documentation/swiftui/scenephase/background), [restoration](https://developer.apple.com/documentation/uikit/preserving-your-app-s-ui-across-launches).

SessionActivity now distinguishes input suspension, background transport shutdown, and resumption, including the background-to-inactive-to-active sequence. ConnectionProgress retains the authenticated workspace while suspended. The app preserves the selected window and immersive state, and restores the last authenticated server on launch. A short UIKit background task bounds shutdown and is ended on completion, expiry, or foreground return. Generation checks prevent delayed shutdown from closing a replacement connection. [Background task API](https://developer.apple.com/documentation/uikit/uiapplication/beginbackgroundtask(withname:expirationhandler:)).

Passwords remain generic-password Keychain items with WhenUnlockedThisDeviceOnly accessibility. Only address, HTTP opt-in, selected window and immersive state enter the restoration bookmark. Equivalent hostname casing, default ports, and trailing slashes use the same credential identity; distinct origins and paths stay separate. Existing address-based entries are read as migration aliases. Keychain errors include status codes; no device Keychain failure or signing-entitlement defect has yet been measured. Protected-data availability gates startup reads. [Adding passwords](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain), [updating and deleting](https://developer.apple.com/documentation/security/updating-and-deleting-keychain-items), [accessibility](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly).

Audio replay tests reproduced failure to rebuffer after queue starvation. The old audio decoder also reused video admission logic that invalidated accepted audio when a later packet overflowed the queue. Audio now has its own bounded admission policy, preserves accepted packets across an overflow, and resets Opus history at the subsequent gap. Playback refills a 60 ms cushion after starvation; excessive queued audio is flushed without cycling the audio session. Audio graph work runs on a serial queue. Configuration-change handling recovers engines already stopped by a route/format change, and media-service reset recreates the graph. Completion accounting uses dataRendered rather than dataConsumed. [Engine changes](https://developer.apple.com/documentation/foundation/nsnotification/name-swift.struct/avaudioengineconfigurationchange), [render completion](https://developer.apple.com/documentation/avfaudio/avaudioplayernodecompletioncallbacktype/datarendered).

Interruption-ended events without shouldResume and headphone removal remain paused until user action. The workspace and audio settings expose Resume audio for that state. Repeated quality/local-playback configuration no longer clears an interruption implicitly; explicit unmute and foreground return can resume. [Interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions), [route changes](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes).

Validation: 68 portable Swift tests pass, including background workspace retention, temporary inactivity, resume through inactive, credential identity, bookmark reload/clear, audio starvation/overflow, and stale audio completions. The final ARM64 SDK build passed in 28.73 seconds; IPA integrity checks passed. These tests and the build do not execute Security.framework or AVAudioEngine on an iPad. Password persistence, process relaunch, minimize/restore and listening tests remain device acceptance checks. No host services, certificates, USB configuration, or dgnrt files were changed.

# Metal shader startup failure, 2026-09-12

After connecting successfully, the iPad reported `redefinition of 'quad' as different kind of symbol`, pointing to the vertex shader declaration and Metal's reserved `quad` typedef. `MetalRenderer` had used `quad` as a global function name. Both shader entry points now use the `lwfa_video_` prefix, with matching pipeline lookups. Geometry, texture sampling, and crop calculations are unchanged.

The ARM64 release build passed in 25.60 seconds and IPA integrity verification passed. Inspection of the packaged executable confirms that it contains the renamed shader and no longer contains the conflicting declaration. These checks do not execute Metal: this app compiles the shader source on the iPad through `makeLibrary(source:options:)`. Rendering must be verified on the device after reinstalling.

# Connection failure handling, 2026-09-12

Device testing reported a stuck Connect screen for a Tailscale HTTPS name and a persistent reconnect overlay for `https://192.168.1.51:8443`. Inspection confirmed that the original native client entered the workspace on any retry, including failures before receiving the engine's Hello message. The receive and write error paths discarded network error details. These are app bugs; neither symptom alone established a successful connection or identified the underlying network failure.

The app now uses the portable `ConnectionProgress` state for initial attempts, accepted sessions, bounded retries, cancellation, and foreground resumption. Initial failures return to the form. Both connection states offer Cancel. A separate 20-second Hello deadline prevents unrelated incoming traffic from keeping an initial attempt alive indefinitely, and the WebSocket request also uses a 20-second timeout. Existing generation checks reject callbacks from cancelled connections.

`ConnectionFailure` produces fixed descriptions for TLS trust, certificate validity, DNS, reachability, timeout, authentication, and rejected WebSocket handshakes. NSError descriptions, userInfo, and request URLs are never shown because they can contain the password query. HTTPS certificate validation remains enabled. The actual cause of the device's Tailscale/IP failures still needs the new device error report; no host network, certificate, proxy, or service configuration was changed.

Validation: 56 portable Swift tests pass, including six connection tests. The ARM64 iOS release build passed in 33.07 seconds, and IPA resource/integrity verification passed. Physical-device connection behavior remains to be checked after installing the rebuilt IPA.
