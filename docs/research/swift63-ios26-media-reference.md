<!-- Extracted 2026-09-12 from an online research pass (swift.org, Swift Evolution, Apple docs, FFmpeg/moonlight sources, libopus docs). Reference for the native iPad client's concurrency and media pipeline. -->

# Low-latency iPad streaming client: Swift 6.3 and iOS 26 reference

Verified against swift.org release posts, the swift-evolution status feed (commit 4b81fae, 2026-09-12), the installed Swift 6.3.3 toolchain's `PackageDescription` symbol graph, Apple's documentation JSON endpoints, SDK headers, FFmpeg's `videotoolbox.c`, moonlight-ios, and the libopus 1.6 API docs. Anything I could not confirm is marked **[unverified]**.

---

## Part A. Swift 6.3 language and concurrency

### A1. What changed in 6.2 and 6.3 (relative to 6.0/6.1)

**Swift 6.2 (Sept 2025)**, all "implemented 6.2" in the evolution feed:

| Proposal | Feature | Notes |
|---|---|---|
| SE-0466 | Control default actor isolation inference | `-default-isolation MainActor|nonisolated`; SwiftPM `.defaultIsolation(MainActor.self)`. With MainActor default: functions, types, properties, inits, deinits, nested types, and non-detached `Task {}` closures in MainActor contexts are inferred `@MainActor`. Stays nonisolated: everything inside `actor` types, explicitly isolated decls, decls inheriting isolation from a superclass/protocol, types conforming to protocols that inherit `SendableMetatype`, and types nested in nonisolated types. |
| SE-0461 | `nonisolated(nonsending)` and `@concurrent` | `nonisolated(nonsending) func f() async` runs on the caller's actor. `@concurrent func f() async` always hops to the global concurrent executor and requires Sendable arguments/results. `@concurrent` cannot be applied to synchronous functions. **Default in Swift 6 mode is still the SE-0338 behaviour (nonisolated async = concurrent) unless you enable the upcoming feature `NonisolatedNonsendingByDefault`.** Closures whose contextual type is neither `@Sendable` nor `sending` inherit the enclosing isolation. |
| SE-0470 | Global-actor isolated conformances | `class MyType: @MainActor P`. Note: the task brief called SE-0470 "InlineArray literal"; that is wrong. InlineArray sugar is SE-0483. |
| SE-0472 | `Task.immediate` / `addImmediateTask` | Runs synchronously in the caller's context until first suspension. **Availability: iOS 26 / macOS 26 only; the Swift team said back-deployment is unlikely** (`_taskIsCurrentExecutor` runtime dependency). |
| SE-0371 | `isolated deinit` | Explicit `isolated deinit {}` on actors and global-actor classes. Implicit and plain `deinit` remain nonisolated. Needs runtime support; **minimum OS not stated in the proposal [unverified]**, so check the compiler's availability diagnostic with your deployment target. |
| SE-0462 | `withTaskPriorityEscalationHandler` | |
| SE-0469 | Task naming `Task("name") {}` | |
| SE-0475 | `Observations` async sequence | `Observations { model.prop }` yields transactional snapshots (transaction runs from first `willSet` to the next suspension). `Observations.untilFinished { ... .next(x) / .finished }`. Availability: **iOS 26+**. Element must be Sendable. |
| SE-0447 / SE-0453 / SE-0456 / SE-0467 / SE-0485 / SE-0483 | `Span`/`RawSpan`, `InlineArray<N, T>`, span properties on stdlib types, `MutableSpan`/`MutableRawSpan`, `OutputSpan`/`OutputRawSpan`, sugar `[5 of Int]` | All 6.2. Spans are non-escapable (SE-0446). Use `array.span`, `UnsafeRawBufferPointer(...).bytes`-style views for zero-copy parsing of packet payloads. |
| SE-0458 | Opt-in strict memory safety | `-strict-memory-safety` (SwiftPM `.strictMemorySafety()`); warnings in group `StrictMemorySafety`; silence with `unsafe` expression. |
| SE-0433 | `Mutex<Value>` in `Synchronization` | Implemented in **6.0**, not 6.2. Runtime availability **iOS 18+**. `withLock`, `withLockIfAvailable`. `Value: ~Copyable`. |
| SE-0419 | `Runtime` module `Backtrace.capture()` | |
| SE-0480 | SwiftPM warning control `.treatWarning(_:as:)`, `.treatAllWarnings(as:)` | |

Also 6.2: modern `NotificationCenter` message types (`MainActorMessage`/`AsyncMessage`), `Subprocess` package, LLDB async stepping, migration fix-its for upcoming features.

**Swift 6.3 (24 Mar 2026)**, "implemented 6.3" in the evolution feed:

- SE-0481 **`weak let`** (the feed says 6.3; some blogs list it under 6.2). Lets classes with weak references be `Sendable` without a `var`.
- SE-0495 `@c` / `@c(Name)` for exposing Swift functions and enums to C; works with `@implementation`.
- SE-0491 module selectors `SwiftUI::View`, `"text".Foundation::data(using:)`; `Swift.Task`, `Swift.Regex` now qualify correctly.
- SE-0460 `@specialize`, SE-0496 `@inline(always)`, SE-0497 `@export(implementation)` (definition visibility in clients), SE-0492 `@section` placement control, SE-0473 clock epochs, SE-0489 readable `DecodingError` descriptions.
- Stdlib: `Span.bytes`, `MutableSpan.mutableBytes`, and `OutputRawSpan.append()` generics marked `@unsafe` (padding concerns).
- Tooling: first official Android SDK, Swift Build integration preview in SwiftPM, `swift package show-traits`, SBOM generation (SE-0509), Swift Testing `severity:` and `Test.cancel()`.
- **No concurrency-semantics changes in 6.3.** `NonisolatedNonsendingByDefault` is still opt-in. SE-0478 (file-level defaults) is accepted but not implemented; SE-0484 (`@dynamicMemberLookup` extra args) and SE-0493 (`await` in `defer`) are queued for 6.4.

Sources: [Swift 6.2 released](https://www.swift.org/blog/swift-6.2-released/), [Swift 6.3 released](https://www.swift.org/blog/swift-6.3-released/), [What's new March 2026](https://www.swift.org/blog/whats-new-in-swift-march-2026/), [swift CHANGELOG](https://github.com/swiftlang/swift/blob/main/CHANGELOG.md), [evolution.json](https://download.swift.org/swift-evolution/v1/evolution.json), [SE-0466](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md), [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md), [SE-0475](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0475-observed.md), [SE-0483](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0483-inline-array-sugar.md), [SE-0371](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0371-isolated-synchronous-deinit.md), [Task.immediate back-deploy thread](https://forums.swift.org/t/back-deployment-of-se-0472-task-immediate/81576), [Observations availability](https://developer.apple.com/documentation/observation/observations), [Mutex availability](https://developer.apple.com/documentation/synchronization/mutex).

### A2. Package.swift for a new iOS 26 target (exact, from the 6.3.3 toolchain)

Signatures and `_PackageDescription` availability, extracted from the installed toolchain's symbol graph:

```
static func swiftLanguageMode(_ mode: SwiftLanguageMode, _ condition: BuildSettingCondition? = nil)   // 6.0
static func defaultIsolation(_ isolation: MainActor.Type?, _ condition: BuildSettingCondition? = nil) // 6.2
static func strictMemorySafety(_ condition: BuildSettingCondition? = nil)                            // 6.2
static func enableUpcomingFeature(_ name: String, _ condition: BuildSettingCondition? = nil)        // 5.8
static func enableExperimentalFeature(_ name: String, _ condition: BuildSettingCondition? = nil)    // 5.8
static func treatWarning(_ name: String, as level: WarningLevel, _ condition: ...)                  // 6.2
static func treatAllWarnings(as level: WarningLevel, _ condition: ...)                              // 6.2
static func interoperabilityMode(_ mode: SwiftSetting.InteroperabilityMode, _ condition: ...)       // 5.9
static func unsafeFlags(_ flags: [String], _ condition: ...)                                        // 5.0
```
`SwiftLanguageMode` cases: `.v3 .v4 .v4_2 .v5 .v6 .version(_:)`. `SupportedPlatform.IOSVersion.v26` exists (introduced 6.2).

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "StreamClient",
    platforms: [.iOS(.v26)],
    targets: [
        // Pure protocol/decoding logic, testable on Linux: keep nonisolated default.
        .target(name: "StreamCore",
                swiftSettings: [
                    .swiftLanguageMode(.v6),
                    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
                    .strictMemorySafety(),
                ]),
        // UI + platform glue: MainActor by default.
        .executableTarget(name: "StreamApp",
                dependencies: ["StreamCore"],
                swiftSettings: [
                    .swiftLanguageMode(.v6),
                    .defaultIsolation(MainActor.self),
                    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
                ]),
    ],
    swiftLanguageModes: [.v6]
)
```
Swift 6 mode already implies `-strict-concurrency=complete`; there is no separate flag to set. Xcode 26 exposes the same two knobs as `SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor` and `SWIFT_APPROACHABLE_CONCURRENCY=YES`; in SwiftPM you set them per target as above. Don't put `.defaultIsolation(MainActor.self)` on the codec/network library target; you'd then have to `nonisolated` everything that runs on your real-time threads.

Sources: local `swift-symbolgraph-extract` of `PackageDescription` (Swift 6.3.3); [SE-0466 SwiftPM API](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md); [Approachable Concurrency in Swift Packages](https://useyourloaf.com/blog/approachable-concurrency-in-swift-packages/); [WWDC25 268 Embracing Swift concurrency](https://developer.apple.com/videos/play/wwdc2025/268/).

### A3. Idiomatic isolation layout for a streaming client

- **`@MainActor`** (inferred via default isolation in the app target): SwiftUI/UIKit views, `CADisplayLink` target, `GCController` handlers if `handlerQueue` stays on main, `AVAudioSession` configuration, scene lifecycle.
- **`actor`** for state that is touched from async network code but not from real-time threads: connection state machine, reconnect/backoff, auth, stats. Keep actor methods short; actors are reentrant at every `await`, so re-check state after each suspension.
- **Real-time threads are outside Swift concurrency.** The cooperative pool has one thread per core and depends on a "runtime contract" that threads always make forward progress (WWDC21 10254). It has no notion of real-time priority, cannot be pinned to a thread, and `Task` scheduling latency is not bounded. Therefore:
  - Audio: the `AVAudioSourceNode` render block runs on the Core Audio real-time thread. No allocation, no locks that can block, no `await`, no `os_log`, no Swift class instantiation. Feed it from a lock-free ring buffer (single producer, single consumer, atomic indices via `Synchronization.Atomic`).
  - Video: VideoToolbox invokes your output handler on its own internal thread. Do the minimal work there (hand the `CVPixelBuffer` to a `Mutex`-protected "latest frame" slot or a bounded queue) and return.
  - Network receive loop: `NWConnection` delivers on the `DispatchQueue` you pass to `start(queue:)`. Make it a dedicated serial queue with `qos: .userInteractive`; do NAL parsing and `VTDecompressionSessionDecodeFrame` directly on it to avoid an extra hop. A `Thread` with `qualityOfService = .userInteractive` is also legitimate if you need a spin/poll loop.
  - Locks in synchronous code are fine ("safe when used for data synchronization around a tight, well-known critical section"); never hold one across `await`. `Mutex` (iOS 18+) or `OSAllocatedUnfairLock` are the right primitives. Semaphores/condition variables that block a cooperative thread violate the contract.
- **Sendable at the boundaries.** Data crossing from the network queue into an actor/MainActor should be value types (`struct Packet: Sendable` holding `Data` or `[UInt8]`), `CMSampleBuffer`/`CVPixelBuffer` are CF types Apple marks Sendable-safe for these transfers (they are reference counted and immutable after production), but wrap them if the compiler complains and document the invariant. Prefer `sending` parameters for one-shot ownership transfer.
- **`AsyncStream` has no back-pressure.** Default `bufferingPolicy` is `.unbounded`. For a decoder feed use `.bufferingNewest(1)` (drop old frames, keep the latest) for video and `.bufferingOldest(n)` or a proper ring buffer for audio. `AsyncStream` delivery still goes through the cooperative pool; don't use it as the hot path from network to decoder, use it for UI-facing events (stats, state changes).
- **`nonisolated(nonsending)` vs `@concurrent`:** with `NonisolatedNonsendingByDefault` on, a plain `nonisolated func parse() async` stays on the caller's executor (no hop, no Sendable requirement). Mark CPU-heavy async helpers `@concurrent` only when you explicitly want the pool, and never for anything latency-critical.
- `weak let` (6.3) lets a `final class` delegate holder be `Sendable` without `nonisolated(unsafe)`.
- `Observations` (iOS 26) is a clean way to drive SwiftUI stats overlays from an `@Observable` model without Combine; transactions coalesce synchronous multi-property updates.

Sources: [WWDC21 10254 notes](https://wwdcnotes.com/documentation/wwdc21-10254-swift-concurrency-behind-the-scenes/), [AsyncStream.init default](https://developer.apple.com/documentation/swift/asyncstream/init(_:bufferingpolicy:_:)), [AVAudioSourceNode](https://developer.apple.com/documentation/avfaudio/avaudiosourcenode), [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md).

### A4. WebSocket transport: `NWConnection` vs `URLSessionWebSocketTask`

Apple's TN3151: "Unless you have a specific reason to use `URLSession`, use Network framework for new WebSocket code." Reasons that matter for a binary stream:

- **`NWProtocolTCP.Options.noDelay: Bool`** (TCP_NODELAY) is only exposed by Network framework. `URLSession` gives no socket-level control.
- **`NWParameters.serviceClass`**: `.interactiveVideo` ("low-delay tolerant, very low-loss tolerant, inelastic flow, constant packet rate"), `.interactiveVoice`, `.responsiveData`, `.signaling`, `.background`, `.bestEffort`. Set `.interactiveVideo` on the media connection and `.responsiveData` or `.signaling` on control.
- **`NWProtocolWebSocket.Options`**: `autoReplyPing: Bool`, `maximumMessageSize: Int`, `skipHandshake: Bool`, `setClientRequestHeader(_:_:)`, `setAdditionalHeaders(_:)`, `setSubprotocols(_:)`. Set `maximumMessageSize` above your largest frame (an IDR at 4K HEVC can exceed 1 MiB). **Default value not confirmed from Apple docs [unverified].**
- **`URLSessionWebSocketTask.maximumMessageSize`**: header says "The maximum number of bytes to be buffered before erroring out. This includes the sum of all bytes from continuation frames... If the maximumMessage size is hit while buffering the frames, the receiveMessage call will error out and all outstanding work will also fail resulting in the end of the task." Default commonly reported as 1 MiB **[unverified]**. It also always advertises `permessage-deflate`, has had documented binary-frame reliability bugs, and its only receive pattern is one-shot `receive()` re-armed recursively with no cancellation of the recursion.

Receive loop with Network framework:

```swift
let tcp = NWProtocolTCP.Options(); tcp.noDelay = true
let tls = NWProtocolTLS.Options()
sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, secTrust, complete in
    let trust = sec_trust_copy_ref(secTrust).takeRetainedValue()
    // Pin: compare SecTrustCopyCertificateChain(trust) leaf against your stored DER.
    complete(pinnedLeafMatches(trust))
}, verifyQueue)
let params = NWParameters(tls: tls, tcp: tcp)
params.serviceClass = .interactiveVideo
let ws = NWProtocolWebSocket.Options()
ws.autoReplyPing = true
ws.maximumMessageSize = 8 << 20
params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
let conn = NWConnection(to: .hostPort(host: host, port: port), using: params)
conn.stateUpdateHandler = { ... }
conn.start(queue: netQueue)   // serial, .userInteractive

func receiveNext() {
    conn.receiveMessage { data, ctx, isComplete, error in
        if let data, isComplete { handle(data) }   // Data may be large; parse in place with span/withUnsafeBytes
        if error == nil { receiveNext() }
    }
}
```
`receiveMessage(completion:)` delivers one complete WebSocket message because `NWProtocolWebSocket` frames the TCP stream ("If you request to receive a message on a protocol that is otherwise an unbounded bytestream, like TCP or TLS, note that this will not deliver any data until the stream is closed"). To send binary: `NWProtocolWebSocket.Metadata(opcode: .binary)` inside `NWConnection.ContentContext(identifier:metadata:)`. `sec_protocol_verify_t` is `(sec_protocol_metadata_t, sec_trust_t, @escaping sec_protocol_verify_complete_t) -> Void` and "may be called one or more times for a given connection". TN3151 also warns: use Apple's trust evaluation (`SecTrustEvaluateWithError`) rather than home-grown checks; pin on top of it, don't replace it.

Sources: [TN3151](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api), [noDelay](https://developer.apple.com/documentation/network/nwprotocoltcp/options/nodelay), [ServiceClass](https://developer.apple.com/documentation/network/nwparameters/serviceclass-swift.enum), [NWProtocolWebSocket.Options](https://developer.apple.com/documentation/network/nwprotocolwebsocket/options), [receiveMessage](https://developer.apple.com/documentation/network/nwconnection/receivemessage(completion:)), [sec_protocol_options_set_verify_block](https://developer.apple.com/documentation/security/sec_protocol_options_set_verify_block(_:_:_:)), [sec_protocol_verify_t](https://developer.apple.com/documentation/security/sec_protocol_verify_t), [NSURLSession.h](https://github.com/xybp888/iOS-SDKs/blob/master/iPhoneOS17.0.sdk/System/Library/Frameworks/Foundation.framework/Headers/NSURLSession.h), [URLSessionWebSocketTask binary issues](https://developer.apple.com/forums/thread/654362), [recursion critique](https://aldo10012.medium.com/my-proposals-to-improve-urlsessionwebsockettask-1f6b80f38c8e).

---

## Part B. Low-latency media on iOS 26

### B1. VideoToolbox decode

**Capability check:** `VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC) -> Bool` (iOS 11+). Every iPad that runs iPadOS 26 has hardware H.264 and HEVC decode; AV1 hardware decode is M3/A17 Pro and later (check the same way with `kCMVideoCodecType_AV1`).

**Format description:**
```swift
CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator:parameterSetCount:parameterSetPointers:parameterSetSizes:nalUnitHeaderLength:formatDescriptionOut:)
CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator:parameterSetCount:parameterSetPointers:parameterSetSizes:nalUnitHeaderLength:extensions:formatDescriptionOut:)
```
Pass raw SPS/PPS (and VPS for HEVC) *with emulation-prevention bytes intact*, without start codes; `parameterSetCount >= 2`; `nalUnitHeaderLength` is 1, 2, or 4 (use 4). Recreate the format description whenever SPS/PPS change, then call `VTDecompressionSessionCanAcceptFormatDescription`; if false, invalidate and recreate the session.

**Annex B to AVCC:** for each NAL between start codes (`00 00 01` / `00 00 00 01`), write a 4-byte big-endian length then the NAL bytes. moonlight-ios does this with `CMBlockBufferAppendMemoryBlock` (length prefix) + `CMBlockBufferReplaceDataBytes` + `CMBlockBufferAppendBufferReference` (NAL bytes, zero copy). Strip AUD/SEI if you like, but keep SPS/PPS out of the sample buffers (they belong in the format description). Build a `CMSampleBuffer` with `CMSampleBufferCreateReady` and one `CMSampleTimingInfo` (PTS = your capture/stream timestamp, duration invalid).

**Session:**
```swift
let spec: [CFString: Any] = [kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: true]
let attrs: [CFString: Any] = [
    kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, // '420v' NV12
    kCVPixelBufferMetalCompatibilityKey: true,
    kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
]
VTDecompressionSessionCreate(allocator: nil, formatDescription: fd, decoderSpecification: spec as CFDictionary,
                             imageBufferAttributes: attrs as CFDictionary, outputCallback: nil, decompressionSessionOut: &session)
VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
```
- `kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder` is iOS 17+ in the docs (it was macOS-only before); `..._RequireHardwareAcceleratedVideoDecoder` also exists. FFmpeg uses `Enable` for HEVC and `Require` for others. On iOS hardware decode is the default anyway; the key just makes intent explicit.
- `kVTDecompressionPropertyKey_RealTime` defaults to true ("By default, VideoToolbox will treat the decompression session as though it is being used for realtime playback"). Set it anyway; setting `kCFBooleanFalse` lowers pipeline priority. Read back `kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder` to log the actual path.
- Pass `outputCallback: nil` and use the handler variant per frame: `VTDecompressionSessionDecodeFrame(_:sampleBuffer:flags:infoFlagsOut:outputHandler:)`. The docs say this variant "cannot be called with a session created with a `VTDecompressionOutputCallbackRecord`". Handler type: `(OSStatus, VTDecodeInfoFlags, CVImageBuffer?, [CMTaggedBuffer]?, CMTime, CMTime) -> Void`.

**Decode flags** (`VTDecodeFrameFlags`):
- `kVTDecodeFrame_EnableAsynchronousDecompression`: "enable asynchronous decompression"; the call may return before the handler runs.
- `kVTDecodeFrame_EnableTemporalProcessing`: decoder may delay output for display-order reordering. **Never set this for a stream with no B-frames**; it adds latency.
- `kVTDecodeFrame_1xRealTimePlayback`: "hint to the video decoder that it's ok to use a low-power mode that can't decode faster than realtime". **Do not set** for a streaming client; you want the decoder to catch up after jitter.
- `kVTDecodeFrame_DoNotOutputFrame`: skip output (useful for reference-only frames after a seek, not for streaming).
- "If both flags are clear, decompression completes and the output handler is called before the function returns." FFmpeg passes `0` (synchronous) and then calls `VTDecompressionSessionWaitForAsynchronousFrames` unconditionally. For a streaming client, synchronous decode (`flags: []`) on your dedicated network/decoder queue is the lowest-latency, simplest option: one frame in, one frame out, no reordering, natural back-pressure. Use `_EnableAsynchronousDecompression` only if profiling shows the queue is stalled by decode time (typically ~2 to 5 ms for 1080p HEVC on recent A/M chips; measure yourself).
- `VTDecompressionSessionWaitForAsynchronousFrames(_:)` "waits for any and all outstanding asynchronous and delayed frames to complete" and calls `FinishDelayedFrames` for you; call it before invalidating a session or on stream switch.

**Backgrounding:** VideoToolbox sessions die when the app is backgrounded: decode returns `kVTInvalidSessionErr` (-12903). FFmpeg treats `kVTVideoDecoderMalfunctionErr` and `kVTInvalidSessionErr` as "reconfig needed" and recreates the session. Do the same: on `-12903`, `VTDecompressionSessionInvalidate`, drop the session, request an IDR from the host, and rebuild on the next SPS/PPS. Proactively tear down on `UIScene.didEnterBackgroundNotification` and rebuild on `willEnterForegroundNotification`; do not try to decode in the background at all. moonlight-ios (which uses `AVSampleBufferDisplayLayer`) does the equivalent: on `status == .failed` it recreates the layer and requests an IDR.

**Output pixel format:** the hardware decoder's native output is bi-planar 4:2:0 (`420v` video-range, `420f` full-range; `x420`/`x422` for 10-bit HEVC). Requesting `kCVPixelFormatType_32BGRA` makes VideoToolbox insert a pixel-transfer conversion stage before the buffer reaches you **[the added cost is widely reported but I found no Apple document quantifying it]**. Request NV12 and do the YUV→RGB in your fragment shader; it's a per-pixel multiply-add that costs nothing next to the blit you already pay for. Match the host's signalling: if the encoder uses full range, request `420f` and use the full-range matrix.

Sources: [VTIsHardwareDecodeSupported](https://developer.apple.com/documentation/videotoolbox/vtishardwaredecodesupported(_:)), [H264 param sets](https://developer.apple.com/documentation/coremedia/cmvideoformatdescriptioncreatefromh264parametersets(allocator:parametersetcount:parametersetpointers:parametersetsizes:nalunitheaderlength:formatdescriptionout:)), [HEVC param sets](https://developer.apple.com/documentation/coremedia/cmvideoformatdescriptioncreatefromhevcparametersets(allocator:parametersetcount:parametersetpointers:parametersetsizes:nalunitheaderlength:extensions:formatdescriptionout:)), [VTDecodeFrameFlags](https://developer.apple.com/documentation/videotoolbox/vtdecodeframeflags), [kVTDecompressionPropertyKey_RealTime](https://developer.apple.com/documentation/videotoolbox/kvtdecompressionpropertykey_realtime), [EnableHardwareAcceleratedVideoDecoder](https://developer.apple.com/documentation/videotoolbox/kvtvideodecoderspecification_enablehardwareacceleratedvideodecoder), [DecodeFrame with handler](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsessiondecodeframe(_:samplebuffer:flags:infoflagsout:outputhandler:)), [WaitForAsynchronousFrames](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsessionwaitforasynchronousframes(_:)), [kCVPixelBufferMetalCompatibilityKey](https://developer.apple.com/documentation/corevideo/kcvpixelbuffermetalcompatibilitykey), [FFmpeg videotoolbox.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/videotoolbox.c), [moonlight-ios VideoDecoderRenderer.m](https://github.com/moonlight-stream/moonlight-ios/blob/master/Limelight/Stream/VideoDecoderRenderer.m), [VTDecompressionSession.h](https://github.com/xybp888/iOS-SDKs/blob/master/iPhoneOS13.0.sdk/System/Library/Frameworks/VideoToolbox.framework/Headers/VTDecompressionSession.h).

### B2. Rendering with Metal

**Texture import:** `CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)` once. Per frame, for NV12:
```swift
CVMetalTextureCacheCreateTextureFromImage(nil, cache, pixelBuffer, nil, .r8Unorm,  w,   h,   0, &yTex)
CVMetalTextureCacheCreateTextureFromImage(nil, cache, pixelBuffer, nil, .rg8Unorm, w/2, h/2, 1, &cbcrTex)
```
(Apple's own doc example uses exactly these mappings for `420v`.) For 10-bit use `.r16Unorm` / `.rg16Unorm` and scale by 65535/1023 in the shader. **Keep the `CVMetalTexture` objects alive until the GPU is done**: "You need to maintain a strong reference to `textureOut` until the GPU finishes execution of commands accessing the texture"; release them in `commandBuffer.addCompletedHandler`. Call `CVMetalTextureCacheFlush(cache, 0)` occasionally if you churn formats.

**NV12 → RGB, BT.709** (fragment shader, `rgba` from `y`, `cbcr` samples in [0,1]):
```
// video range ('420v'): Y in [16,235], C in [16,240] on 8-bit
float Y = (y - 16.0/255.0) * (255.0/219.0);
float Cb = (cbcr.x - 128.0/255.0) * (255.0/224.0);
float Cr = (cbcr.y - 128.0/255.0) * (255.0/224.0);
// full range ('420f'): Y = y; Cb = cbcr.x - 0.5; Cr = cbcr.y - 0.5;
float r = Y + 1.5748 * Cr;
float g = Y - 0.1873 * Cb - 0.4681 * Cr;
float b = Y + 1.8556 * Cb;
```
Coefficients derive from BT.709 Kr = 0.2126, Kb = 0.0722. Use a `.bgra8Unorm_srgb` drawable only if you want the GPU to apply the sRGB OETF on write; for "pixels as the host sent them" use `.bgra8Unorm` and write the values as-is. Use `nearest`/`linear` sampling with `sampler(address::clamp_to_edge)`. Draw a full-screen triangle (3 vertices, no vertex buffer).

**Layer setup (`CAMetalLayer` inside a `UIView` whose `layerClass` is `CAMetalLayer.self`):**
- `maximumDrawableCount = 2` (only 2 or 3 accepted, default 3). Two drawables means at most one frame queued behind the one on screen, which is what you want for latency; the cost is that `nextDrawable()` blocks if the previous frame hasn't been scanned out yet, so only call it when you actually have a new decoded frame.
- `framebufferOnly = true`, `isOpaque = true`, `pixelFormat = .bgra8Unorm`, `drawableSize` = view size × `contentScaleFactor` (set explicitly; don't let it default).
- `allowsNextDrawableTimeout = true` (default): `nextDrawable()` returns nil after 1 s instead of hanging forever; handle nil by dropping the frame.
- `presentsWithTransaction = false` (default): "displays the output of a rendering pass to the display as quickly as possible and asynchronously to any Core Animation transactions." Set it `true` only if you overlay UIKit/SwiftUI content that must be frame-locked to the video (then commit, `waitUntilScheduled()`, then `drawable.present()`, and do *not* use `commandBuffer.present(_:)`). For a streaming client you normally want false.
- `displaySyncEnabled` is **macOS/Mac Catalyst only**; not available on iOS. Tearing-free vsync presentation is the only mode on iPad.
- `present(_:afterMinimumDuration:)` and `present(_:atTime:)` are for pacing content you generate; with network-paced frames they don't lower latency (the forum thread on this ends with no Apple answer). Use plain `present(drawable)`.
- Wrap each draw in `autoreleasepool {}` (Apple's note on drawable release and deadlocks).

**Pacing:** register a `CADisplayLink` on the main run loop with `preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)`; the default is `CAFrameRateRange.default` (display max). On iPad Pro no Info.plist key is required for 120 Hz; `CADisableMinimumFrameDurationOnPhone = YES` is the iPhone-only unlock. The system may still clamp for Low Power Mode or thermal state. In the callback: if a new frame is in the slot, take it, `nextDrawable()`, encode, commit, present; else return without touching the layer (no stale re-present). `CAMetalDisplayLink` (iOS 17+, `init(metalLayer:)`, delegate `metalDisplayLink(_:needsUpdate:)`, `preferredFrameLatency` 1.0 or 2.0) hands you the drawable in the update and is the modern option if you want the system to tell you the exact target present time; `preferredFrameLatency = 1` is the low-latency setting.

**Why `MTKView` is acceptable:** with `isPaused = true` and `enableSetNeedsDisplay = false` it is in "explicit drawing" mode, redrawing only when you call `draw()`, which is exactly the "present only when a frame arrived" behaviour; it wraps a `CAMetalLayer` you can still configure (`(view.layer as! CAMetalLayer).maximumDrawableCount = 2`). Its downsides are an extra abstraction and that its timed mode ignores `preferredFrameRateRange` semantics. Either is fine; a bare `CAMetalLayer` is fewer moving parts.

**Shaders without Xcode:** `MTLDevice.makeLibrary(source:options:)` is available on iOS 8+ and "may only import the Metal default library" (no `#include` of your own headers, so put everything in one string). Runtime compile costs on the order of 100 ms once (a forum measurement: ~134 ms from source vs ~20 ms from a `.metallib`), after which pipeline states are cached by the system-wide Metal shader cache ("apps have benefited from a system-wide shader cache that accelerates creating pipeline objects that have been created from previous runs", WWDC20 10615). For two tiny shaders this is a non-issue; compile once at launch on a background queue, before the first frame arrives. Set `MTLCompileOptions.languageVersion` explicitly and `mathMode = .fast` (`fastMathEnabled` is deprecated). `MTLBinaryArchive` is the way to persist compiled pipelines yourself if you ever need to; not required.

**xtool/SwiftPM on Linux:** SwiftPM on macOS compiles `.metal` files in a target into `default.metallib`; on Linux there is no `metal`/`metallib` compiler, and xtool's docs describe only `resources:` copying (`.copy("Blob.png")` bundled as `.bundle` inside the `.app`, accessed via `Bundle.module`) plus `xtool.yml` keys `bundleID`, `infoPath`, `resources`, `iconPath`, `entitlementsPath`. No Metal support is mentioned anywhere in xtool's repo. So: keep the MSL source as a Swift string literal (or a `.copy`'d `.metal` resource read at runtime) and use `makeLibrary(source:)`. The repo's own toolchain notes confirm MetalKit imports fine against iPhoneOS26.5.sdk but that Metal rendering has not been device-tested yet.

Sources: [CVMetalTextureCacheCreateTextureFromImage](https://developer.apple.com/documentation/corevideo/cvmetaltexturecachecreatetexturefromimage(_:_:_:_:_:_:_:_:_:)), [CAMetalLayer](https://developer.apple.com/documentation/quartzcore/cametallayer), [maximumDrawableCount](https://developer.apple.com/documentation/quartzcore/cametallayer/maximumdrawablecount), [presentsWithTransaction](https://developer.apple.com/documentation/quartzcore/cametallayer/presentswithtransaction), [displaySyncEnabled](https://developer.apple.com/documentation/quartzcore/cametallayer/displaysyncenabled), [allowsNextDrawableTimeout](https://developer.apple.com/documentation/quartzcore/cametallayer/allowsnextdrawabletimeout), [nextDrawable](https://developer.apple.com/documentation/quartzcore/cametallayer/nextdrawable()), [present(_:afterMinimumDuration:)](https://developer.apple.com/documentation/metal/mtlcommandbuffer/present(_:afterminimumduration:)), [CADisplayLink.preferredFrameRateRange](https://developer.apple.com/documentation/quartzcore/cadisplaylink/preferredframeraterange), [CADisableMinimumFrameDurationOnPhone](https://developer.apple.com/documentation/bundleresources/information-property-list/cadisableminimumframedurationonphone), [CAMetalDisplayLink](https://developer.apple.com/documentation/quartzcore/cametaldisplaylink), [preferredFrameLatency](https://developer.apple.com/documentation/quartzcore/cametaldisplaylink/preferredframelatency), [MTKView](https://developer.apple.com/documentation/metalkit/mtkview), [makeLibrary(source:options:)](https://developer.apple.com/documentation/metal/mtldevice/makelibrary(source:options:)), [MTLCompileOptions](https://developer.apple.com/documentation/metal/mtlcompileoptions), [WWDC20 10615](https://developer.apple.com/videos/play/wwdc2020/10615/), [runtime compile timing thread](https://developer.apple.com/forums/thread/696543), [SwiftPM metal thread](https://forums.swift.org/t/support-compiling-metal-files-with-swiftpm/75148), [xtool Control.md](https://github.com/xtool-org/xtool/blob/main/Documentation/xtool.docc/Control.md), [latency forum thread (no Apple answer)](https://developer.apple.com/forums/thread/711033).

### B3. Audio

**Session:**
```swift
let s = AVAudioSession.sharedInstance()
try s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
try s.setPreferredSampleRate(48_000)
try s.setPreferredIOBufferDuration(0.005)
try s.setActive(true)
// then read s.sampleRate and s.ioBufferDuration; they are requests, not guarantees
```
`.mixWithOthers` is settable only with `.playback`, `.playAndRecord`, `.multiRoute`; without it, activating your session interrupts other apps' audio. `setPreferredIOBufferDuration`: "at least 0.005 seconds (256 frames), though may be lower depending on hardware", max ~0.093 s; can be set before or after activation. `setPreferredSampleRate`: "typically from 8000 through 48000"; verify with `sampleRate`. If the hardware ends up at 44.1 kHz (some Bluetooth routes), let `AVAudioEngine` resample by giving the source node a 48 kHz format and connecting to `mainMixerNode`.

**Engine:** `AVAudioSourceNode(format: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!, renderBlock:)` is the pull model: the engine calls your block with `(isSilence: UnsafeMutablePointer<ObjCBool>, timestamp: UnsafePointer<AudioTimeStamp>, frameCount: AVAudioFrameCount, outputData: UnsafeMutablePointer<AudioBufferList>) -> OSStatus` on the real-time thread every `ioBufferDuration`. You copy exactly `frameCount` frames from your ring buffer; if the buffer is short, fill zeros and set `isSilence`. This gives you deterministic latency = jitter buffer depth + IO buffer, and lets you implement the jitter buffer as plain sample arithmetic. `AVAudioPlayerNode.scheduleBuffer` is a push model with its own internal queue; latency depends on how many buffers you keep in flight, completion handlers arrive late, and developers report 100 ms+ end-to-end. Use `AVAudioSourceNode`. (A `realtimeSafeRenderBlock:` initializer with `__attribute__((nonblocking))` is documented as **iOS 27+**, so it is not usable on iOS 26.5.)

**Opus:** `opus_decoder_create(48000, 2, &err)`. Decode with `opus_decode_float(st, data, len, pcm, frame_size, decode_fec)`. For a lost packet call with `data == NULL, len == 0`, and `frame_size` "exactly the duration of audio that is missing... a multiple of 2.5 ms" (i.e. one packet's worth, typically 480 or 960 samples); this is PLC. If the host enables in-band FEC, on a gap first call with the *next* packet and `decode_fec = 1` to recover the lost frame, then decode that packet normally with `decode_fec = 0`. `opus_packet_get_nb_samples(packet, len, 48000)` tells you the packet's frame size without decoding; `opus_decoder_ctl(st, OPUS_GET_LAST_PACKET_DURATION(&n))` gives the last decoded/concealed duration. Do the Opus decode on the network queue (it's ~100 µs), never in the render block.

**Jitter buffer:** target depth = 2 to 3 packets (20 ms packets → 40 to 60 ms) as a start; measure inter-arrival jitter (RFC 3550 style EWMA) and adapt between 1 and 5 packets. Underrun: PLC one frame, then let it refill. Overrun (depth > target + hysteresis for N seconds): drop one packet or time-stretch; dropping is fine for game audio. The ring buffer should hold at least 250 ms.

**Interruptions / route changes:** observe `AVAudioSession.interruptionNotification` (`interruptionTypeKey` → `.began`/`.ended`; on `.ended` check `interruptionOptionKey` for `.shouldResume`, then `setActive(true)` and restart the engine) and `routeChangeNotification` (`routeChangeReasonKey`; `.oldDeviceUnavailable` when headphones unplug, `.newDeviceAvailable`). The route-change notification is posted on a secondary thread. After any route change re-read `ioBufferDuration`/`sampleRate` and restart `AVAudioEngine` if it stopped (`AVAudioEngineConfigurationChange` notification).

Sources: [AVAudioSourceNode](https://developer.apple.com/documentation/avfaudio/avaudiosourcenode), [AVAudioSourceNodeRenderBlock](https://developer.apple.com/documentation/avfaudio/avaudiosourcenoderenderblock), [realtime-safe block iOS 27](https://developer.apple.com/documentation/avfaudio/avaudiosourcenoderenderblockrealtimesafe), [setPreferredIOBufferDuration](https://developer.apple.com/documentation/avfaudio/avaudiosession/setpreferrediobufferduration(_:)), [setPreferredSampleRate](https://developer.apple.com/documentation/avfaudio/avaudiosession/setpreferredsamplerate(_:)), [mixWithOthers](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/mixwithothers), [interruptionNotification](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification), [routeChangeNotification](https://developer.apple.com/documentation/avfaudio/avaudiosession/routechangenotification), [Opus decoder API](https://www.opus-codec.org/docs/opus_api-1.6/group__opus__decoder.html), [Opus decoder CTLs](https://www.opus-codec.org/docs/opus_api-1.6/group__opus__decoderctls.html), [AVAudioPlayerNode latency reports](https://developer.apple.com/forums/thread/705620).

### B4. App lifecycle, privacy keys, security

- **Scene lifecycle:** `UIScene.willEnterForegroundNotification` (always followed by `didActivateNotification`), `didEnterBackgroundNotification`, `willDeactivateNotification`; SwiftUI `@Environment(\.scenePhase)` gives `.active/.inactive/.background`. On background: stop the display link, invalidate the VT session, pause the engine, send a "pause" to the host. On foreground: reconnect (or resume) and request an IDR.
- **Finishing work on background:** `UIApplication.shared.beginBackgroundTask(withName:expirationHandler:) -> UIBackgroundTaskIdentifier` (nonisolated; the expiration handler is `@MainActor @Sendable`). Use it only to send a clean disconnect/pause and flush, then `endBackgroundTask`. "Call this method as early as possible... preferably before your app actually enters the background." There is no background mode that lets a game stream keep running; the socket will be torn down.
- **Thermal:** `ProcessInfo.processInfo.thermalState` (`.nominal .fair .serious .critical`) and `ProcessInfo.thermalStateDidChangeNotification`. At `.serious` ask the host for a lower bitrate/frame rate; at `.critical` cap the display link at 60. The system also clamps `CADisplayLink` rates for you under thermal pressure.
- **Idle timer:** `UIApplication.shared.isIdleTimerDisabled = true` while streaming ("games... programs that need to continue displaying content with minimal user interaction"); reset to `false` when the session ends.
- **`isProtectedDataAvailable`:** only relevant if you read protected files while locked; irrelevant for this app. Store the host token with `kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock` ("cannot be accessed after a restart until the device has been unlocked once"; migrates with encrypted backups). Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` if you don't want it in backups.
- **Info.plist:** `NSLocalNetworkUsageDescription` (iOS 14+) is required for "direct unicast or multicast connections to local hosts"; add `NSBonjourServices` only if you browse Bonjour. ATS: on iOS 17+ "ATS no longer allows IP addresses by default"; with `NSAllowsLocalNetworking = YES` ATS permits unqualified names, `.local` names, and IP addresses. Note ATS governs `URLSession`/`WKWebView`, not `NWConnection`, so with Network framework plus your own verify block you don't strictly need the exception, but add it if any `URLSession` call hits the host. `UIApplicationSupportsIndirectInputEvents` (below). If you ship an app icon, `iconPath` in `xtool.yml`.

Sources: [UIScene notifications](https://developer.apple.com/documentation/uikit/uiscene/willenterforegroundnotification), [beginBackgroundTask](https://developer.apple.com/documentation/uikit/uiapplication/beginbackgroundtask(withname:expirationhandler:)), [ThermalState](https://developer.apple.com/documentation/foundation/processinfo/thermalstate-swift.enum), [isIdleTimerDisabled](https://developer.apple.com/documentation/uikit/uiapplication/isidletimerdisabled), [kSecAttrAccessibleAfterFirstUnlock](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlock), [NSLocalNetworkUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription), [NSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).

### B5. Input

**Gamepad:** observe `GCController.didConnectNotification`/`didDisconnectNotification` and use `GCController.current` ("the most recently used game controller"). Set `controller.extendedGamepad?.valueChangedHandler = { (gamepad: GCExtendedGamepad) in ... }` (the typealias is `(GCExtendedGamepad) -> Void`; the per-element variant is `GCExtendedGamepadValueChangedHandler` on `GCPhysicalInputProfile` with `(profile, element)`). Elements: `buttonA/B/X/Y`, `leftShoulder/rightShoulder`, `leftTrigger/rightTrigger`, `leftThumbstick/rightThumbstick`, `leftThumbstickButton/rightThumbstickButton`, `dpad`, `buttonMenu`, `buttonOptions?`, `buttonHome?`. Read stick values in the handler and pack into your input packet; send on a fixed tick (e.g. 250 Hz on iPad) rather than per callback to bound packet rate. **`GCController.shouldMonitorBackgroundEvents` is macOS-only: "On iOS and tvOS, this property is ignored."** `controller.handlerQueue` lets you move handlers off main **[default of main queue from memory; page 404'd]**. `capture()` snapshots are for testing, not the hot path. Add `GCEventInteraction`/set `GCController` handlers before UIKit consumes Menu/Home (the Menu button otherwise triggers system behaviour).

**Keyboard:** two paths. `GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = { (kb: GCKeyboardInput, key: GCControllerButtonInput, code: GCKeyCode, pressed: Bool) in }` gives HID-style key codes for all keyboards (iOS 14+). Alternatively override `pressesBegan/pressesEnded(_:with:)` on a first-responder view and read `press.key?.keyCode` (`UIKeyboardHIDUsage`, the USB HID usage), `characters`, `charactersIgnoringModifiers`, `modifierFlags`. GameController is better for a streaming client because it does not depend on responder chain and doesn't auto-repeat; UIKit is needed only for text entry and to swallow system shortcuts (`UIKeyCommand` with `wantsPriorityOverSystemBehavior`).

**Mouse:** `GCMouse.current` / `GCMouse.mice()`, notifications `GCMouseDidConnect`, `GCMouseDidBecomeCurrent`. `mouse.mouseInput?.mouseMovedHandler: GCMouseMoved = (GCMouseInput, Float, Float) -> Void` delivers **raw deltas** "without affecting mouse sensitivity settings" (the profile "provides only raw mouse movement delta values"). Buttons: `leftButton`, `rightButton?`, `middleButton?`, `auxiliaryButtons?` (`GCControllerButtonInput.pressedChangedHandler`); wheel: `scroll: GCDeviceCursor` (`xAxis/yAxis` value handlers). To hide the system pointer and capture it: in the streaming view controller override `prefersPointerLocked { true }` and call `setNeedsUpdateOfPrefersPointerLocked()`; the system only honours it when the scene is full screen (no Split View/Slide Over) and `foregroundActive`; check `UIPointerLockState.isLocked` and observe `UIPointerLockState.didChangeNotification`. Also add a `UIPointerInteraction` whose `pointerInteraction(_:styleFor:)` returns `.hidden()` for the unlocked case.

**Trackpad:** set `UIApplicationSupportsIndirectInputEvents = YES` (default YES on iOS 17+, but declare it). Clicks then arrive as `UITouch` of type `.indirectPointer`; two-finger scrolling arrives as `UIEvent` `.scroll` events, which a `UIPanGestureRecognizer` only sees if you set `allowedScrollTypesMask = .continuous` (trackpad) or `.all` (`.discrete` = mouse wheel); "standard `UIPanGestureRecognizers` have no mask by default." In the handler, `translation(in:)` per event gives scroll deltas; `numberOfTouches` is 0 and `location(ofTouch:in:)` throws for scroll events, so guard with `gestureRecognizer(_:shouldReceive: UIEvent)`. Pinch/rotate on the trackpad drive `UIPinchGestureRecognizer`/`UIRotationGestureRecognizer` with `.transform` events. Hover position: `UIHoverGestureRecognizer`.

Sources: [GCController](https://developer.apple.com/documentation/gamecontroller/gccontroller), [shouldMonitorBackgroundEvents](https://developer.apple.com/documentation/gamecontroller/gccontroller/shouldmonitorbackgroundevents), [GCController.h](https://github.com/xybp888/iOS-SDKs/blob/master/iPhoneOS17.0.sdk/System/Library/Frameworks/GameController.framework/Headers/GCController.h), [GCExtendedGamepad](https://developer.apple.com/documentation/gamecontroller/gcextendedgamepad), [GCKeyboard](https://developer.apple.com/documentation/gamecontroller/gckeyboard), [GCMouse](https://developer.apple.com/documentation/gamecontroller/gcmouse), [GCMouseInput](https://developer.apple.com/documentation/gamecontroller/gcmouseinput), [GCMouseMoved](https://developer.apple.com/documentation/gamecontroller/gcmousemoved), [prefersPointerLocked](https://developer.apple.com/documentation/uikit/uiviewcontroller/preferspointerlocked), [UIPointerInteraction](https://developer.apple.com/documentation/uikit/uipointerinteraction), [UIKey](https://developer.apple.com/documentation/uikit/uikey), [UIApplicationSupportsIndirectInputEvents](https://developer.apple.com/documentation/bundleresources/information-property-list/uiapplicationsupportsindirectinputevents), [allowedScrollTypesMask](https://developer.apple.com/documentation/uikit/uipangesturerecognizer/allowedscrolltypesmask), [UIScrollTypeMask](https://developer.apple.com/documentation/uikit/uiscrolltypemask), [WWDC20 10094 Handle trackpad and mouse input](https://developer.apple.com/videos/play/wwdc2020/10094/).

---

## Unverified or corrected items (summary)

1. **SE-0470 is "Global-actor isolated conformances", not InlineArray literal**; InlineArray sugar `[N of T]` is SE-0483 (6.2).
2. `weak let` is recorded as implemented in **6.3** by the evolution feed, though several blogs list it under 6.2.
3. `isolated deinit` minimum OS version: not stated in SE-0371; rely on compiler availability diagnostics.
4. `NWProtocolWebSocket.Options.maximumMessageSize` and `URLSessionWebSocketTask.maximumMessageSize` default values: not stated in Apple docs; set them explicitly.
5. `GCController.handlerQueue` default (main queue): page fetch failed; from memory.
6. BGRA-vs-NV12 decoder output cost: mechanism (pixel transfer stage) is consistent with `kVTDecompressionPropertyKey_PixelTransferProperties`, but I found no Apple figure. Request NV12 regardless.
7. `VTDecodeFrameFlags` bit values were not re-read from the header; only the documented semantics are cited.
8. `AVAudioSourceNodeRenderBlockRealtimeSafe` is documented as iOS 27+, so it's out of scope for iOS 26.5; noted rather than recommended.
9. Metal runtime-compile timing (~134 ms source vs ~20 ms metallib) is a single forum data point, not an Apple number.
