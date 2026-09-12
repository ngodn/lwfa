#if os(iOS)
import SwiftUI
import LWFACore
import Synchronization
import simd
@preconcurrency import AVFoundation
@preconcurrency import VideoToolbox
@preconcurrency import Metal
@preconcurrency import QuartzCore

/// Apple adapters stay outside LWFACore so the protocol can be tested on Linux.
///
/// Video path: WebSocket bytes → `VideoWorker` (serial decode queue, hardware
/// VideoToolbox, synchronous output) → `VideoFrameMailbox` (latest frame wins)
/// → `VideoRenderer` (own render queue, wakes per frame, presents once). The
/// main thread never touches pixels, and a frame is on its way to the display
/// the moment it is decoded rather than at the next display-link tick.
@MainActor
final class NativeMedia {
    static var supportedCodecs: [Codec] {
        var codecs: [Codec] = []
        if VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC) { codecs.append(.hevc) }
        if VTIsHardwareDecodeSupported(kCMVideoCodecType_H264) { codecs.append(.h264) }
        return codecs
    }

    var onNeedsKeyframe: (() -> Void)?
    var onCodecFailure: ((Codec) -> Void)?
    var onFailure: ((String) -> Void)?
    let audio: NativeAudioPlayer
    fileprivate let frames = VideoFrameMailbox()
    private lazy var decoder = VideoWorker(frames: frames, recover: { [weak self] message, isCurrent in
        Task { @MainActor [weak self] in
            guard isCurrent() else { return }
            if let message { self?.onFailure?(message) }
            self?.onNeedsKeyframe?()
        }
    }, reject: { [weak self] codec, message, isCurrent in
        Task { @MainActor [weak self] in
            guard isCurrent() else { return }
            self?.onFailure?(message)
            self?.onCodecFailure?(codec)
        }
    })

    init(audio: NativeAudioPlayer? = nil) {
        self.audio = audio ?? NativeAudioPlayer()
        if audio == nil { self.audio.onFailure = { [weak self] message in self?.onFailure?(message) } }
    }

    func decode(_ packet: VideoPacket) { decoder.submit(packet) }
    func setMuted(_ muted: Bool) { audio.setMuted(muted) }
    func resetVideo() { decoder.reset() }
    func reset() {
        decoder.reset()
        audio.reset()
    }
    /// Frames presented since the last call, for diagnostics.
    func takePresentedFrameCount() -> UInt64 { frames.takePresented() }
}

// MARK: - Frame hand-off

/// The lock protects ownership and generation. At most one decoded frame waits
/// for the renderer; GPU submissions retain their own frame separately. A
/// registered sink is woken on every publish so presentation is frame-driven.
fileprivate final class VideoFrameMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var epoch: UInt64 = 0
    private var revision: UInt64 = 0
    private var sequence: Int64 = -1
    private var image: CVPixelBuffer?
    private var sink: (@Sendable () -> Void)?
    private let presented = Atomic<UInt64>(0)

    func clear() -> UInt64 {
        let (clearedEpoch, wake): (UInt64, (@Sendable () -> Void)?) = lock.withLock {
            epoch &+= 1
            revision &+= 1
            image = nil
            sequence = -1
            return (epoch, sink)
        }
        wake?()
        return clearedEpoch
    }

    func publish(_ buffer: CVPixelBuffer, epoch candidate: UInt64, sequence next: Int64) {
        let wake: (@Sendable () -> Void)? = lock.withLock {
            guard candidate == epoch, next > sequence else { return nil }
            image = buffer
            sequence = next
            revision &+= 1
            return sink
        }
        wake?()
    }

    func latest() -> (UInt64, CVPixelBuffer?) { lock.withLock { (revision, image) } }
    func isCurrent(_ candidate: UInt64) -> Bool { lock.withLock { candidate == epoch } }
    func setSink(_ sink: (@Sendable () -> Void)?) { lock.withLock { self.sink = sink } }
    func countPresented() { presented.wrappingAdd(1, ordering: .relaxed) }
    func takePresented() -> UInt64 { presented.exchange(0, ordering: .relaxed) }
}

// MARK: - Decoding

/// All codec state is confined to `queue`. Decoding is synchronous on that
/// queue: the stream carries no timestamps or B-frames, so there is nothing to
/// reorder, and a frame reaches the mailbox before the next packet is parsed.
private final class VideoWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "lwfa.video.decode", qos: .userInteractive)
    private let admissions = VideoDecodeAdmissions()
    private let frames: VideoFrameMailbox
    private let recover: @Sendable (String?, @escaping @Sendable () -> Bool) -> Void
    private let reject: @Sendable (Codec, String, @escaping @Sendable () -> Bool) -> Void
    private var rejectedFormats: Set<UInt8> = []
    private var session: VTDecompressionSession?
    private var description: CMVideoFormatDescription?
    private var parameters: [Data] = []
    private var codec: VideoFormat?
    private var window: UInt64?
    private var epoch: UInt64 = 0
    private var sequence: Int64 = 0
    private var waitingForKeyframe = true
    private var recoveryRequested = false

    init(frames: VideoFrameMailbox, recover: @escaping @Sendable (String?, @escaping @Sendable () -> Bool) -> Void,
         reject: @escaping @Sendable (Codec, String, @escaping @Sendable () -> Bool) -> Void) {
        self.frames = frames
        self.recover = recover
        self.reject = reject
    }

    func submit(_ packet: VideoPacket) {
        guard let ticket = admissions.acquire() else { return }
        queue.async { [self] in process(packet, ticket: ticket) }
    }

    func reset() {
        // Immediately stop old callbacks publishing while queued teardown runs.
        admissions.reset()
        _ = frames.clear()
        queue.async { [self] in
            invalidate()
            window = nil
            recoveryRequested = false
            rejectedFormats = []
        }
    }

    private func invalidate() {
        recoveryRequested = false
        epoch = frames.clear()
        if let session { VTDecompressionSessionInvalidate(session) }
        session = nil
        description = nil
        parameters = []
        codec = nil
        waitingForKeyframe = true
    }

    private func requestRecovery(_ message: String? = nil, ticket: VideoDecodeTicket) {
        guard !recoveryRequested else { return }
        recoveryRequested = true
        recover(message, { ticket.isCurrent })
    }

    private func process(_ packet: VideoPacket, ticket: VideoDecodeTicket) {
        defer { ticket.finish() }
        guard ticket.isCurrent else { return }
        guard !rejectedFormats.contains(packet.format.rawValue) else { return }
        let discontinuity = admissions.consumeDiscontinuity()
        if window != packet.window || discontinuity {
            invalidate()
            window = packet.window
        }
        if packet.format == .jpeg {
            if codec != .jpeg {
                invalidate()
                codec = .jpeg
            }
            guard let image = UIImage(data: packet.payload)?.cgImage,
                  image.width == Int(packet.width), image.height == Int(packet.height),
                  let pixel = Self.pixelBuffer(image) else { return }
            sequence += 1
            if ticket.isCurrent { frames.publish(pixel, epoch: epoch, sequence: sequence) }
            return
        }

        var creatingSession = false
        do {
            if packet.keyframe {
                let units = try AnnexB.nalUnits(packet.payload)
                let parameterSets = units.filter { unit in
                    guard let first = unit.first else { return false }
                    if packet.format == .h264 { return [7, 8].contains(Int(first & 31)) }
                    return [32, 33, 34].contains(Int((first >> 1) & 63))
                }
                if session == nil || codec != packet.format || parameters != parameterSets {
                    invalidate()
                    let format = try Self.format(packet.format, parameters: parameterSets)
                    let size = CMVideoFormatDescriptionGetDimensions(format)
                    guard size.width > 0, size.height > 0, size.width <= 16_384, size.height <= 16_384,
                          Int64(size.width) * Int64(size.height) <= 67_108_864 else {
                        throw MediaFailure.description("Decoded video dimensions exceed the supported limit")
                    }
                    description = format
                    parameters = parameterSets
                    codec = packet.format
                    creatingSession = true
                    session = try Self.makeSession(format)
                    creatingSession = false
                }
                waitingForKeyframe = false
                recoveryRequested = false
            }
            guard !waitingForKeyframe, let session, let description, codec == packet.format else {
                requestRecovery(ticket: ticket)
                return
            }

            let sample = try Self.sampleBuffer(packet.payload, description: description, sequence: sequence + 1)
            sequence += 1
            let frameEpoch = epoch
            let frameSequence = sequence
            let mailbox = frames
            var infoFlags: VTDecodeInfoFlags = []
            let output = DecodeOutputStatus()
            // No asynchronous flag: the output handler runs before this returns.
            let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [],
                                                           infoFlagsOut: &infoFlags) { status, flags, image, _, _ in
                if status != noErr { output.state.withLock { $0.status = status }; return }
                if flags.contains(.frameDropped) { output.state.withLock { $0.dropped = true }; return }
                if let image, ticket.isCurrent { mailbox.publish(image, epoch: frameEpoch, sequence: frameSequence) }
            }
            try check(status)
            let result = output.state.withLock { $0 }
            if result.status != noErr {
                throw MediaFailure.status(result.status)
            }
            if result.dropped || infoFlags.contains(.frameDropped) {
                _ = admissions.breakChain()
                invalidate()
                requestRecovery(ticket: ticket)
            }
        } catch {
            invalidate()
            guard ticket.isCurrent else { return }
            if creatingSession {
                rejectedFormats.insert(packet.format.rawValue)
                reject(packet.format == .hevc ? .hevc : .h264,
                       "Hardware video decoder could not open this stream: \(error)",
                       { ticket.isCurrent })
            } else {
                requestRecovery("Video decoding failed: \(error)", ticket: ticket)
            }
        }
    }

    private static func makeSession(_ description: CMVideoFormatDescription) throws -> VTDecompressionSession {
        var created: VTDecompressionSession?
        // Prefer the decoder's native biplanar output: no BGRA conversion pass
        // in VideoToolbox, and Metal samples the planes directly. BGRA stays as
        // a fallback for decoders that cannot produce 4:2:0 for this stream.
        let formats: [OSType] = [
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
            kCVPixelFormatType_420YpCbCr10BiPlanarFullRange,
            kCVPixelFormatType_32BGRA,
        ]
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: formats.map { NSNumber(value: $0) },
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:],
        ]
        let specification: [CFString: Any] = [
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder: true,
        ]
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault, formatDescription: description,
            decoderSpecification: specification as CFDictionary,
            imageBufferAttributes: attributes as CFDictionary,
            outputCallback: nil, decompressionSessionOut: &created)
        guard status == noErr, let created else { throw MediaFailure.status(status) }
        VTSessionSetProperty(created, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        return created
    }

    private static func sampleBuffer(_ payload: Data, description: CMVideoFormatDescription, sequence: Int64) throws -> CMSampleBuffer {
        let bytes = try AnnexB.lengthPrefixed(payload)
        var block: CMBlockBuffer?
        try checkStatus(CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: bytes.count, flags: 0, blockBufferOut: &block))
        guard let block else { throw MediaFailure.description("Video sample allocation failed") }
        try bytes.withUnsafeBytes { data in
            try checkStatus(CMBlockBufferReplaceDataBytes(with: data.baseAddress!, blockBuffer: block,
                                                          offsetIntoDestination: 0, dataLength: bytes.count))
        }
        // The wire format has no source timestamps. This ordering timestamp is
        // not a claim about capture time or source A/V sync.
        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: CMTime(value: sequence, timescale: 60), decodeTimeStamp: .invalid)
        var sampleSize = bytes.count
        var sample: CMSampleBuffer?
        try checkStatus(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
            formatDescription: description, sampleCount: 1, sampleTimingEntryCount: 1,
            sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize,
            sampleBufferOut: &sample))
        guard let sample else { throw MediaFailure.description("Video sample creation failed") }
        return sample
    }

    private static func format(_ codec: VideoFormat, parameters: [Data]) throws -> CMVideoFormatDescription {
        let required = codec == .hevc ? 3 : 2
        guard parameters.count >= required else { throw MediaFailure.description("Missing video parameter sets") }
        let storage = parameters.map { bytes -> UnsafeMutablePointer<UInt8> in
            let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
            bytes.copyBytes(to: pointer, count: bytes.count)
            return pointer
        }
        defer { storage.forEach { $0.deallocate() } }
        let pointers = storage.map { UnsafePointer($0) }
        let sizes = parameters.map(\.count)
        var result: CMFormatDescription?
        let status = pointers.withUnsafeBufferPointer { pointers in
            sizes.withUnsafeBufferPointer { sizes in
                if codec == .hevc {
                    return CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                        allocator: kCFAllocatorDefault, parameterSetCount: parameters.count,
                        parameterSetPointers: pointers.baseAddress!, parameterSetSizes: sizes.baseAddress!,
                        nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &result)
                }
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault, parameterSetCount: parameters.count,
                    parameterSetPointers: pointers.baseAddress!, parameterSetSizes: sizes.baseAddress!,
                    nalUnitHeaderLength: 4, formatDescriptionOut: &result)
            }
        }
        guard status == noErr, let result else { throw MediaFailure.status(status) }
        return result
    }

    private static func pixelBuffer(_ image: CGImage) -> CVPixelBuffer? {
        var result: CVPixelBuffer?
        let attributes: [CFString: Any] = [kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:]]
        guard CVPixelBufferCreate(kCFAllocatorDefault, image.width, image.height,
            kCVPixelFormatType_32BGRA, attributes as CFDictionary, &result) == kCVReturnSuccess,
            let result else { return nil }
        CVPixelBufferLockBaseAddress(result, [])
        defer { CVPixelBufferUnlockBaseAddress(result, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(result), width: image.width,
            height: image.height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(result),
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)
        else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return result
    }

    private func check(_ status: OSStatus) throws { try Self.checkStatus(status) }
    private static func checkStatus(_ status: OSStatus) throws {
        if status != noErr { throw MediaFailure.status(status) }
    }

    deinit { if let session { VTDecompressionSessionInvalidate(session) } }
}

private enum MediaFailure: Error { case status(OSStatus), description(String) }

/// VideoToolbox may execute its synchronous callback on another thread before
/// DecodeFrame returns. Keep its result Sendable without captured mutable vars.
private final class DecodeOutputStatus: Sendable {
    let state = Mutex((status: OSStatus(noErr), dropped: false))
}

// MARK: - Presentation

struct NativeVideoView: UIViewRepresentable {
    let media: NativeMedia
    func makeUIView(context: Context) -> VideoSurfaceView {
        VideoSurfaceView(frames: media.frames) { [weak media] message in
            Task { @MainActor in media?.onFailure?(message) }
        }
    }
    func updateUIView(_ view: VideoSurfaceView, context: Context) {}
    static func dismantleUIView(_ view: VideoSurfaceView, coordinator: ()) { view.stop() }
}

/// A CAMetalLayer host. The layer's drawable size follows the view on the
/// main thread; drawing happens on the renderer's queue whenever a frame lands.
@MainActor
final class VideoSurfaceView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
    private let renderer: VideoRenderer

    fileprivate init(frames: VideoFrameMailbox, failure: @escaping @Sendable (String) -> Void) {
        renderer = VideoRenderer(frames: frames, failure: failure)
        super.init(frame: .zero)
        isOpaque = true
        backgroundColor = .black
        isUserInteractionEnabled = false
        let metal = metalLayer
        metal.device = renderer.device
        metal.pixelFormat = .bgra8Unorm
        metal.framebufferOnly = true
        metal.isOpaque = true
        metal.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        // Present from the command buffer, not a Core Animation transaction:
        // nothing on the main thread stands between a decoded frame and glass.
        metal.presentsWithTransaction = false
        metal.maximumDrawableCount = 2
        metal.allowsNextDrawableTimeout = true
        renderer.attach(metal)
    }

    required init?(coder: NSCoder) { fatalError("Use init(frames:failure:)") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = window?.screen.scale ?? traitCollection.displayScale
        metalLayer.contentsScale = scale
        let size = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
        guard size.width >= 1, size.height >= 1 else { return }
        if metalLayer.drawableSize != size {
            metalLayer.drawableSize = size
            renderer.wake()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { setNeedsLayout(); renderer.wake() }
    }

    func stop() { renderer.stop() }
}

/// Owns the GPU resources for one surface. Rendering is frame-driven: the
/// mailbox wakes this renderer on publish, one draw is coalesced per wake, and
/// the newest frame is what gets presented. One frame is in flight at a time.
private final class VideoRenderer: @unchecked Sendable {
    let device: MTLDevice? = MTLCreateSystemDefaultDevice()
    private let queue = DispatchQueue(label: "lwfa.video.render", qos: .userInteractive)
    private let frames: VideoFrameMailbox
    private let failure: @Sendable (String) -> Void
    private var commands: MTLCommandQueue?
    private var rgbPipeline: MTLRenderPipelineState?
    private var yuvPipeline: MTLRenderPipelineState?
    private var cache: CVMetalTextureCache?
    private let inflight = DispatchSemaphore(value: 1)
    private let scheduled = Atomic<Bool>(false)
    private let lock = NSLock()
    private var layer: CAMetalLayer?
    private var lastRevision: UInt64?
    private var lastDrawableSize = CGSize.zero
    private var prepared = false

    fileprivate init(frames: VideoFrameMailbox, failure: @escaping @Sendable (String) -> Void) {
        self.frames = frames
        self.failure = failure
    }

    @MainActor func attach(_ layer: CAMetalLayer) {
        lock.withLock { self.layer = layer }
        frames.setSink { [weak self] in self?.wake() }
        queue.async { [self] in prepare() }
    }

    func stop() {
        frames.setSink(nil)
        lock.withLock { layer = nil }
    }

    /// Coalesces to one pending draw regardless of how many frames arrive.
    func wake() {
        guard scheduled.compareExchange(expected: false, desired: true, ordering: .acquiringAndReleasing).exchanged else { return }
        queue.async { [self] in
            scheduled.store(false, ordering: .releasing)
            autoreleasepool { draw() }
        }
    }

    private func prepare() {
        guard !prepared else { return }
        prepared = true
        guard let device else { failure("Metal is unavailable on this device"); return }
        commands = device.makeCommandQueue()
        guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess else {
            failure("Could not create the video texture cache"); return
        }
        do {
            // Compiled on the device once per launch; the driver caches the
            // result. SwiftPM on Linux cannot produce a metallib.
            let library = try device.makeLibrary(source: Self.shaderSource, options: nil)
            let vertex = library.makeFunction(name: "lwfa_video_vertex")
            func pipeline(_ fragment: String) throws -> MTLRenderPipelineState {
                let descriptor = MTLRenderPipelineDescriptor()
                descriptor.vertexFunction = vertex
                descriptor.fragmentFunction = library.makeFunction(name: fragment)
                descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
                return try device.makeRenderPipelineState(descriptor: descriptor)
            }
            rgbPipeline = try pipeline("lwfa_video_fragment_rgb")
            yuvPipeline = try pipeline("lwfa_video_fragment_yuv")
        } catch {
            failure("Could not prepare Metal rendering: \(error.localizedDescription)")
        }
    }

    private func draw() {
        prepare()
        guard let layer = lock.withLock({ layer }), let cache, let commands, let rgbPipeline, let yuvPipeline else { return }
        let (revision, image) = frames.latest()
        let drawableSize = layer.drawableSize
        guard drawableSize.width >= 1, drawableSize.height >= 1 else { return }
        guard revision != lastRevision || drawableSize != lastDrawableSize else { return }
        // Two drawables, one in flight: the newest frame lands at the next vsync
        // and nothing queues behind it. Waiting here blocks only this queue.
        inflight.wait()
        var submitted = false
        defer { if !submitted { inflight.signal() } }
        guard let drawable = layer.nextDrawable() else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        guard let command = commands.makeCommandBuffer(), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
        var retained: [CVMetalTexture] = []
        if let image, let planes = Self.textures(for: image, cache: cache) {
            retained = planes.textures
            let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
            // Encoded padding is not image content. CoreVideo expresses clean
            // apertures from the lower-left; the shader UVs start at the
            // upper-left. Never derive texture stride from width.
            let bounds = CGRect(x: 0, y: 0, width: width, height: height)
            let aperture = CVImageBufferGetCleanRect(image).intersection(bounds)
            let clean = aperture.isEmpty || aperture.isNull ? bounds : aperture
            var uniforms = Self.conversion(for: image, fullRange: planes.fullRange)
            uniforms.crop = SIMD4<Float>(Float(clean.minX / Double(width)),
                                         Float((Double(height) - clean.maxY) / Double(height)),
                                         Float(clean.width / Double(width)), Float(clean.height / Double(height)))
            // Fill the box exactly, like the browser's `<canvas class="h-full w-full">`:
            // the engine renders each window at the size the client asked for, so
            // the box matches the frame except for the moment after a resize, when
            // the last frame stretches until the new one lands.
            let target = CGSize(width: drawable.texture.width, height: drawable.texture.height)
            encoder.setViewport(MTLViewport(originX: 0, originY: 0, width: target.width, height: target.height, znear: 0, zfar: 1))
            encoder.setRenderPipelineState(planes.biplanar ? yuvPipeline : rgbPipeline)
            for (index, texture) in planes.textures.enumerated() {
                encoder.setFragmentTexture(CVMetalTextureGetTexture(texture), index: index)
            }
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Conversion>.stride, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
        encoder.endEncoding()
        let resources = GPUFrame(image: image, textures: retained)
        let semaphore = inflight
        let mailbox = frames
        command.addCompletedHandler { _ in
            withExtendedLifetime(resources) { _ = semaphore.signal() }
            mailbox.countPresented()
        }
        command.present(drawable)
        command.commit()
        submitted = true
        lastRevision = revision
        lastDrawableSize = drawableSize
    }

    private struct Planes { let textures: [CVMetalTexture]; let biplanar: Bool; let fullRange: Bool }

    private static func textures(for image: CVPixelBuffer, cache: CVMetalTextureCache) -> Planes? {
        let format = CVPixelBufferGetPixelFormatType(image)
        func texture(_ pixel: MTLPixelFormat, plane: Int) -> CVMetalTexture? {
            var result: CVMetalTexture?
            let planar = CVPixelBufferIsPlanar(image)
            let width = planar ? CVPixelBufferGetWidthOfPlane(image, plane) : CVPixelBufferGetWidth(image)
            let height = planar ? CVPixelBufferGetHeightOfPlane(image, plane) : CVPixelBufferGetHeight(image)
            guard width > 0, height > 0 else { return nil }
            let status = CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, image, nil, pixel, width, height, plane, &result)
            return status == kCVReturnSuccess ? result : nil
        }
        switch format {
        case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
            guard let luma = texture(.r8Unorm, plane: 0), let chroma = texture(.rg8Unorm, plane: 1) else { return nil }
            return Planes(textures: [luma, chroma], biplanar: true, fullRange: format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
        case kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr10BiPlanarFullRange:
            guard let luma = texture(.r16Unorm, plane: 0), let chroma = texture(.rg16Unorm, plane: 1) else { return nil }
            return Planes(textures: [luma, chroma], biplanar: true, fullRange: format == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange)
        case kCVPixelFormatType_32BGRA:
            guard let rgb = texture(.bgra8Unorm, plane: 0) else { return nil }
            return Planes(textures: [rgb], biplanar: false, fullRange: true)
        default:
            return nil
        }
    }

    /// Must match the Metal `Conversion` struct: float4, float3x3, float3.
    private struct Conversion {
        var crop: SIMD4<Float>
        var matrix: simd_float3x3
        var offset: SIMD3<Float>
    }

    /// Y'CbCr → R'G'B' honoring the buffer's colour matrix and range. Treating
    /// video range as full range lifts blacks and clips whites.
    private static func conversion(for image: CVPixelBuffer, fullRange: Bool) -> Conversion {
        let attachment = CVBufferCopyAttachment(image, kCVImageBufferYCbCrMatrixKey, nil) as? String
        let height = CVPixelBufferGetHeight(image)
        let matrix: VideoColorConversion.Matrix
        switch attachment as CFString? {
        case kCVImageBufferYCbCrMatrix_ITU_R_601_4: matrix = .bt601
        case kCVImageBufferYCbCrMatrix_ITU_R_2020: matrix = .bt2020
        case kCVImageBufferYCbCrMatrix_ITU_R_709_2: matrix = .bt709
        default: matrix = height >= 720 ? .bt709 : .bt601
        }
        let pixelFormat = CVPixelBufferGetPixelFormatType(image)
        let tenBit = pixelFormat == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
            || pixelFormat == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange
        let conversion = VideoColorConversion(matrix: matrix, fullRange: fullRange, tenBit: tenBit)
        return Conversion(crop: SIMD4<Float>(0, 0, 1, 1),
                          matrix: simd_float3x3(columns: conversion.columns), offset: conversion.offset)
    }

    // Names carry a prefix: Metal reserves plain identifiers such as `quad`.
    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;
    struct LWFAVertex { float4 position [[position]]; float2 uv; };
    struct LWFAConversion { float4 crop; float3x3 matrix; float3 offset; };
    vertex LWFAVertex lwfa_video_vertex(uint id [[vertex_id]]) {
        const float2 positions[] = { {-1,-1}, {1,-1}, {-1,1}, {1,1} };
        const float2 uv[] = { {0,1}, {1,1}, {0,0}, {1,0} };
        return {float4(positions[id], 0, 1), uv[id]};
    }
    fragment float4 lwfa_video_fragment_rgb(LWFAVertex in [[stage_in]], texture2d<float> image [[texture(0)]],
                                            constant LWFAConversion &c [[buffer(0)]]) {
        constexpr sampler linearSampler(filter::linear, address::clamp_to_edge);
        return float4(image.sample(linearSampler, c.crop.xy + in.uv * c.crop.zw).rgb, 1);
    }
    fragment float4 lwfa_video_fragment_yuv(LWFAVertex in [[stage_in]], texture2d<float> luma [[texture(0)]],
                                            texture2d<float> chroma [[texture(1)]], constant LWFAConversion &c [[buffer(0)]]) {
        constexpr sampler linearSampler(filter::linear, address::clamp_to_edge);
        float2 uv = c.crop.xy + in.uv * c.crop.zw;
        float3 yuv = float3(luma.sample(linearSampler, uv).r, chroma.sample(linearSampler, uv).rg);
        return float4(saturate(c.matrix * (yuv - c.offset)), 1);
    }
    """
}

/// Immutable ownership transferred to the GPU completion handler. Holding only
/// the extracted MTLTexture is not enough: the CVMetalTexture and the pixel
/// buffer must both outlive the GPU work.
private final class GPUFrame: @unchecked Sendable {
    let image: CVPixelBuffer?
    let textures: [CVMetalTexture]
    init(image: CVPixelBuffer?, textures: [CVMetalTexture]) { self.image = image; self.textures = textures }
}

// MARK: - Audio

@MainActor
final class NativeAudioPlayer {
    var onFailure: ((String) -> Void)?
    private(set) var diagnostics: WireValue = .object([:])
    var queuedMilliseconds: Double { diagnostics["queuedMilliseconds"].doubleValue }
    private lazy var worker = AudioPlaybackWorker { [weak self] diagnostics, failure in
        Task { @MainActor [weak self] in
            self?.diagnostics = diagnostics
            if let failure { self?.onFailure?(failure) }
        }
    }

    func setVolume(_ value: Double) { worker.setVolume(value) }
    func setMuted(_ value: Bool) { worker.setMuted(value) }
    func reset() { worker.reset() }
    func play(_ packet: AudioPacket) { worker.play(packet) }
    /// An explicit return to the stream can resume an interruption for which
    /// iOS never delivered an end notification (for example, suspension).
    func resumeAfterBackground() { worker.resumeAfterBackground() }
}

/// Pull-model playback. The audio unit's render thread reads straight from the
/// jitter buffer; nothing is scheduled ahead, so latency is the cushion plus
/// the hardware IO buffer. Graph and session changes run on one serial queue.
private final class AudioPlaybackWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "lwfa.audio.playback", qos: .userInteractive)
    private let buffer = AudioJitterBuffer()
    private var engine: AVAudioEngine?
    private var source: AVAudioSourceNode?
    // Opus/PCM and the ring use packed stereo. Keep that as the source block's
    // format, but give the mixer standard, non-interleaved float audio. The
    // source node performs this supported PCM conversion at its output bus.
    private let renderFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true)!
    private let mixerFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
    private let observations = AudioObservations()
    private let output: @Sendable (WireValue, String?) -> Void
    private let running = Atomic<Bool>(false)
    private let decodeFailures = Atomic<UInt64>(0)
    private lazy var decoder = NativeAudioDecodeWorker { [weak self] samples, ticket in
        guard let self else { ticket.finish(); return }
        queue.async { [self] in
            defer { ticket.finish() }
            // Accept decoded output on the same queue as reset/mute. Checking
            // the ticket on the decode queue then writing there leaves a race
            // where old audio can enter the ring after playback was reset.
            guard ticket.isCurrent, !muted, !interrupted else { return }
            if let samples {
                _ = buffer.write(samples)
                if !running.load(ordering: .acquiring) { start() }
            } else {
                decodeFailures.wrappingAdd(1, ordering: .relaxed)
                fail("The audio packet could not be decoded")
            }
        }
    }
    private var muted = false
    private var interrupted = false
    private var reportedFailure = false
    private var volume: Float = 1
    private var packetFormat = "none"
    private var packetsSincePublish = 0

    init(output: @escaping @Sendable (WireValue, String?) -> Void) {
        self.output = output
        let center = NotificationCenter.default
        observations.tokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
        ) { [weak self] notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            guard let self, let raw else { return }
            queue.async { [self] in
                if raw == AVAudioSession.InterruptionType.began.rawValue {
                    interrupted = true
                    decoder.reset()
                    stopGraph()
                } else if raw == AVAudioSession.InterruptionType.ended.rawValue {
                    interrupted = !AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
                }
                publish()
            }
        })
        observations.tokens.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
        ) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            guard let self, reason != AVAudioSession.RouteChangeReason.categoryChange.rawValue else { return }
            queue.async { [self] in
                guard !muted else { return }
                if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                    // Unplugging headphones must not unexpectedly play on speakers.
                    interrupted = true
                }
                decoder.reset()
                stopGraph()
                publish()
            }
        })
        observations.tokens.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
        ) { [weak self] notification in
            guard let self, let changed = notification.object as? AVAudioEngine else { return }
            let identity = ObjectIdentifier(changed)
            // Apple posts on an internal queue. Never tear down the engine there.
            queue.async { [self] in
                guard let engine, ObjectIdentifier(engine) == identity, !engine.isRunning else { return }
                running.store(false, ordering: .releasing)
                buffer.reset()
                publish()
            }
        })
        observations.tokens.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            queue.async { [self] in
                decoder.reset()
                stopGraph()
                engine = nil
                source = nil
                interrupted = true
                publish()
            }
        })
    }

    func setVolume(_ value: Double) {
        queue.async { [self] in
            volume = Float(max(0, min(1, value.isFinite ? value : 1)))
            source?.volume = volume
        }
    }

    func setMuted(_ value: Bool) {
        queue.async { [self] in
            guard muted != value else { return }
            muted = value
            if value { resetPlayback() }
            else { interrupted = false; reportedFailure = false }
            publish()
        }
    }

    func reset() { queue.async { [self] in resetPlayback(); publish() } }

    func resumeAfterBackground() {
        queue.async { [self] in
            decoder.reset()
            stopGraph()
            interrupted = false
            reportedFailure = false
            publish()
        }
    }

    func play(_ packet: AudioPacket) {
        queue.async { [self] in
            guard !muted, !interrupted else { return }
            packetFormat = packet.format == .opus ? "opus" : "pcm16"
            decoder.submit(packet)
            packetsSincePublish += 1
            if packetsSincePublish >= 25 { publish() }
        }
    }

    private func resetPlayback() {
        decoder.reset()
        stopGraph()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        reportedFailure = false
    }

    private func stopGraph() {
        running.store(false, ordering: .releasing)
        engine?.stop()
        buffer.reset()
    }

    private func start() {
        guard !muted, !interrupted else { return }
        do {
            if engine == nil {
                let engine = AVAudioEngine()
                let buffer = buffer
                let channels = buffer.channels
                let source = AVAudioSourceNode(format: renderFormat) { isSilence, _, frameCount, list -> OSStatus in
                    // Real-time thread: no locks, no allocation, no Swift objects
                    // beyond the ring itself.
                    let buffers = UnsafeMutableAudioBufferListPointer(list)
                    guard let data = buffers[0].mData else { return noErr }
                    let frames = Int(frameCount)
                    let served = buffer.read(into: data.assumingMemoryBound(to: Float.self), frames: frames)
                    buffers[0].mDataByteSize = UInt32(frames * channels * MemoryLayout<Float>.size)
                    isSilence.pointee = ObjCBool(served == 0)
                    return noErr
                }
                source.volume = volume
                engine.attach(source)
                engine.connect(source, to: engine.mainMixerNode, format: mixerFormat)
                self.engine = engine
                self.source = source
            }
            guard let engine, !engine.isRunning else { return }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setPreferredSampleRate(48_000)
            // A 5 ms IO buffer is what the hardware allows at best; the session
            // reports what it actually granted.
            try session.setPreferredIOBufferDuration(0.005)
            try session.setActive(true)
            engine.prepare()
            try engine.start()
            running.store(true, ordering: .releasing)
            reportedFailure = false
            publish()
        } catch {
            stopGraph()
            fail("Audio playback failed: \(error.localizedDescription)")
        }
    }

    private func publish(_ failure: String? = nil) {
        packetsSincePublish = 0
        let stats = buffer.statistics
        let session = AVAudioSession.sharedInstance()
        output(.object([
            "queuedMilliseconds": .double(stats.queuedMilliseconds),
            "queueStarvations": .uint(stats.underruns), "queueOverflows": .uint(stats.overflows),
            "decodeFailures": .uint(decodeFailures.load(ordering: .relaxed)), "packetFormat": .string(packetFormat),
            "interrupted": .bool(interrupted), "muted": .bool(muted), "primed": .bool(stats.primed),
            "deviceSampleRate": .double(session.sampleRate),
            "ioBufferMilliseconds": .double(session.ioBufferDuration * 1000),
            "outputLatencyMilliseconds": .double(session.outputLatency * 1000),
            "cushionMilliseconds": .double(Double(buffer.cushionFrames) / 48),
        ]), failure)
    }

    private func fail(_ message: String) {
        guard !reportedFailure else { return }
        reportedFailure = true
        publish(message)
    }
}

/// Serial, bounded decode preserves Opus history without blocking touch/UI work.
private final class NativeAudioDecodeWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "lwfa.audio.decode", qos: .userInteractive)
    private let admissions = AudioDecodeAdmissions(capacity: 5)
    private var opus: OpusAudioDecoder?
    private var previous: AudioFormat?
    private let output: @Sendable ([Float]?, AudioDecodeTicket) -> Void

    init(output: @escaping @Sendable ([Float]?, AudioDecodeTicket) -> Void) { self.output = output }

    func reset() {
        admissions.reset()
        queue.async { [self] in opus?.reset(); previous = nil }
    }

    func submit(_ packet: AudioPacket) {
        guard let ticket = admissions.acquire() else { return }
        queue.async { [self] in
            guard ticket.isCurrent else { ticket.finish(); return }
            if ticket.discontinuity || previous != packet.format { opus?.reset() }
            previous = packet.format
            do {
                guard packet.channels == 2, packet.sampleRate == 48_000,
                      packet.frames > 0, packet.frames <= 4_800 else { throw ProtocolError.invalidPacket }
                let samples: [Float]
                if packet.format == .opus {
                    if opus == nil { opus = try OpusAudioDecoder() }
                    samples = try opus!.decode(packet)
                } else {
                    guard packet.payload.count == Int(packet.frames) * 4 else { throw ProtocolError.invalidPacket }
                    samples = packet.payload.withUnsafeBytes { raw -> [Float] in
                        let count = raw.count / 2
                        return [Float](unsafeUninitializedCapacity: count) { out, initialized in
                            for index in 0..<count {
                                let bits = UInt16(raw[index * 2]) | UInt16(raw[index * 2 + 1]) << 8
                                out[index] = Float(Int16(bitPattern: bits)) / 32_768
                            }
                            initialized = count
                        }
                    }
                }
                output(samples, ticket)
            } catch { opus?.reset(); output(nil, ticket) }
        }
    }
}

private final class AudioObservations {
    var tokens: [NSObjectProtocol] = []
    deinit { tokens.forEach(NotificationCenter.default.removeObserver) }
}
#endif
