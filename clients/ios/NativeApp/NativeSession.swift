#if os(iOS)
import Foundation
import Combine
import Observation
import UIKit
import Security
import LWFACore

@MainActor
@Observable final class NativeSession {
    enum VideoMode: String, CaseIterable, Identifiable {
        case auto = "Auto", hevc = "HEVC", h264 = "H.264", jpeg = "JPEG"
        var id: String { rawValue }
    }

    private var connection = ConnectionProgress()
    var connected: Bool { connection.phase == .connected }
    var connecting: Bool { connection.phase == .connecting }
    var reconnecting: Bool { connection.phase == .reconnecting }
    var showsWorkspace: Bool { connection.showsWorkspace }
    var audioNeedsResume: Bool { connected && !muted && audioInterrupted }
    /// Mirrors the audio worker's interrupted flag, written only when it changes,
    /// so the shell does not re-render with every one-second diagnostics tick.
    private(set) var audioInterrupted = false
    private(set) var connectionIssue: String?
    private(set) var windows: [WindowInfo] = []
    private(set) var selected: UInt64?
    private(set) var primary = false
    private(set) var canInteract = false
    private(set) var frameSize = CGSize.zero
    private(set) var frameSizes: [UInt64: CGSize] = [:]
    private(set) var placedWindows: [WindowLayout] = []
    /// False when the last layout came with a viewport change: windows appear
    /// in place instead of flying in, as in the browser's `Motion.set(_, false)`.
    private(set) var layoutAnimated = true
    /// Windows the engine is currently asked to stream (`streamedIds`).
    private(set) var streamedWindows: Set<UInt64> = []
    private(set) var diagnostics: WireValue = .object([:])
    private(set) var blankWindowIDs: Set<UInt64> = []
    private(set) var pendingCloseIDs: Set<UInt64> = []
    private var closeExpiry: [UInt64: Task<Void, Never>] = [:]
    private(set) var displayOutput = Output(width: 1, height: 1)
    private(set) var account = ""
    private(set) var sessionID: UInt64 = 0
    private(set) var peers: [PeerInfo] = []
    private(set) var allowedApps: [String]?
    private(set) var engineVersion = ""
    private(set) var serverMessages: [String: WireValue] = [:]
    private(set) var fileChoosers: [WireValue] = []
    let serverEvents = PassthroughSubject<(String, WireValue), Never>()
    var publicServerURL: URL? { endpoint?.publicURL }
    var isOwner: Bool { account == "owner" }
    var problem: String?
    var muted = true { didSet { configureAudio(); saveStreamPreferences() } }
    var localPlayback = false { didSet { configureAudio(); saveStreamPreferences() } }
    var volume = 1.0 { didSet { media.audio.setVolume(volume); saveStreamPreferences() } }
    var audioQuality: AudioQuality = .auto { didSet { configureAudio(); saveStreamPreferences() } }
    var videoEnabled = true { didSet { subscribe(); saveStreamPreferences() } }
    var pauseInactive = true { didSet { subscribe(); saveStreamPreferences() } }
    var gamepadEnabled = true { didSet { configureController(); UserDefaults.standard.set(gamepadEnabled, forKey: "native.physicalController") } }
    /// One input surface at a time, like `lib/dock.ts`: keyboard, mouse or the
    /// virtual gamepad. Showing one hides the others.
    var dock = "none" {
        didSet {
            releaseSource("keyboard"); releaseSource("mouse:lock")
            if dock != "none", gamepad.visible { gamepad.visible = false }
        }
    }
    var mouseHover = false
    var immersive = false { didSet { persistSession() } }
    var arranging = false { didSet { subscribe() } }
    var videoMode: VideoMode = .auto {
        didSet {
            rejectedCodecs.removeAll(); codecRetrySizes.removeAll()
            windowMedia.values.forEach { $0.resetVideo() }
            subscribe(force: true)
            saveStreamPreferences()
        }
    }
    let media = NativeMedia()
    let layout = NativeLayoutController()
    let clipboardUploader = NativeUploader()
    private var windowMedia: [UInt64: NativeMedia] = [:]
    private var subscribedWindows: [UInt64] = []
    private var subscribedCodecs: [Codec] = []
    private var engineOutput = Output(width: 1, height: 1)
    let preferences = NativePreferences()
    let gamepad = NativeGamepadModel()
    var selectedTitle: String { windows.first { $0.id == selected }?.title ?? "lwfa" }
    var acceptsCanvasInput: Bool { connected && wanted && active && canInteract && !inputSuspended }
    var acceptsInput: Bool { acceptsCanvasInput && selected != nil }

    private let network = URLSession(configuration: .ephemeral)
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var writer: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var handshakeDeadline: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var resizeTask: Task<Void, Never>?
    private var keyframeTask: Task<Void, Never>?
    @ObservationIgnored private var queue: [ClientCommand] = []
    private var generation: UInt64 = 0
    private var wanted = false
    private var activity = SessionActivity()
    private var active: Bool { activity.acceptsInput }
    private let bookmarkStore = SessionBookmarkStore()
    private var restorationAttempted = false
    private var credentialsPersisted = false
    private var resumeSelection: UInt64?
    private var suspensionTask: Task<Void, Never>?
    private var backgroundLease: UIBackgroundTaskIdentifier = .invalid
    private var inputSuspensions = InputSuspension()
    private(set) var inputGeneration: UInt64 = 0
    private var inputSuspended: Bool { inputSuspensions.isSuspended }
    private var endpoint: ServerEndpoint?
    private var credential = ""
    // Per-packet bookkeeping. Not observed: nothing in a view reads these, and
    // tracking a mutation per frame at 60 Hz is wasted work on the main actor.
    @ObservationIgnored private var lastReceived = Date()
    @ObservationIgnored private var measuredAt = Date()
    @ObservationIgnored private var receivedFrames = 0
    @ObservationIgnored private var receivedKeyframes = 0
    @ObservationIgnored private var receivedAudioChunks = 0
    @ObservationIgnored private var largestFrame: (width: UInt32, height: UInt32) = (0, 0)
    @ObservationIgnored private var audioFormat = ""
    @ObservationIgnored private var audioSampleRate: UInt32 = 0
    @ObservationIgnored private var eventLog: [WireValue] = []
    @ObservationIgnored private var receivedVideoBytes = 0
    @ObservationIgnored private var receivedAudioBytes = 0
    @ObservationIgnored private var lastCodec = ""
    @ObservationIgnored private var pingSentAt: Date?
    @ObservationIgnored private var roundTripMilliseconds: Double?
    @ObservationIgnored private var lastKeyframeRequest = Date.distantPast
    @ObservationIgnored private var rejectedCodecs: Set<Codec> = []
    private struct DecodeSize: Hashable { let width: UInt32; let height: UInt32 }
    @ObservationIgnored private var codecRetrySizes: [UInt64: Set<DecodeSize>] = [:]
    private var viewport: Output?
    private var lastViewport: Output?
    private var previousLayout: [WindowLayout] = []
    private var receivedLayout = false
    private var restoredLayout = false
    private var followerOffset = CGSize.zero
    private var lastSentLayout: [WindowLayout] = []
    @ObservationIgnored private var inputs = InputMixer()
    private struct TouchSource: Hashable { let window: UInt64; let local: Int32 }
    @ObservationIgnored private var touches: [TouchSource: Int32] = [:]
    @ObservationIgnored private var nextTouch: Int32 = 1
    @ObservationIgnored private var pointerWindow: UInt64?
    private var controller: NativeController?
    private var requestSequence: UInt64 = 0
    private var clientID: String {
        if let value = UserDefaults.standard.string(forKey: "clientID") { return value }
        let value = UUID().uuidString
        UserDefaults.standard.set(value, forKey: "clientID")
        return value
    }

    init() {
        if let saved = UserDefaults.standard.dictionary(forKey: "native.stream") {
            videoMode = VideoMode(rawValue: saved["videoMode"] as? String ?? "") ?? .auto
            videoEnabled = saved["videoEnabled"] as? Bool ?? true
            pauseInactive = saved["pauseInactive"] as? Bool ?? true
            muted = saved["muted"] as? Bool ?? true
            localPlayback = saved["localPlayback"] as? Bool ?? false
            volume = min(1, max(0, saved["volume"] as? Double ?? 1))
            audioQuality = AudioQuality(rawValue: saved["audioQuality"] as? String ?? "") ?? .auto
        }
        gamepadEnabled = UserDefaults.standard.object(forKey: "native.physicalController") as? Bool ?? true
        preferences.onChange = { [weak self] in
            guard let self else { return }
            self.configureLayout()
            self.applyLayout()
        }
        configureLayout()
        gamepad.onChange = { [weak self] in
            guard let self else { return }
            if gamepad.visible, dock != "none" { dock = "none" }
            configureController()
        }
        media.audio.setVolume(volume)
        media.onFailure = { [weak self] message in
            if self?.problem == nil { self?.problem = message }
        }
        controller = NativeController(
            button: { [weak self] in self?.button($0, pressed: $1) },
            axis: { [weak self] in self?.axis($0, value: $1) },
            release: { [weak self] in self?.releaseGamepad() }
        )
    }

    func connect(address: String, token: String, allowInsecure: Bool) {
        do {
            let server = try ServerEndpoint(address, allowInsecure: allowInsecure)
            let secret = token.isEmpty ? (try CredentialStore.read(server) ?? "") : token
            guard !secret.isEmpty else { problem = "Enter your lwfa password."; return }
            restorationAttempted = true
            UserDefaults.standard.set(true, forKey: "native.sessionRestorationMigrated")
            media.audio.resumeAfterBackground()
            credentialsPersisted = false
            bookmarkStore.clear()
            connection.cancel()
            stopTransport()
            eventLog.removeAll()
            endpoint = server
            credential = secret
            UserDefaults.standard.set(server.description, forKey: "server")
            UserDefaults.standard.set(allowInsecure, forKey: "server.allowHTTP")
            wanted = true
            problem = nil; connectionIssue = nil
            connection.begin()
            open()
        } catch let failure as CredentialStore.Failure {
            problem = failure.localizedDescription
        } catch ProtocolError.insecureEndpoint {
            problem = "Use HTTPS, or explicitly allow unencrypted HTTP for this connection."
        } catch {
            problem = "Could not read this server address or its saved password. Enter an address such as https://your-computer."
        }
    }

    private func open() {
        guard wanted, active, let endpoint else { return }
        stopTransport()
        let current = generation
        do {
            let task = network.webSocketTask(with: try endpoint.request(token: credential, clientID: clientID))
            task.maximumMessageSize = VideoPacket.maximumPacketBytes
            socket = task
            connection.startAttempt()
            recordEvent("Connecting")
            lastReceived = Date()
            task.resume()
            handshakeDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                guard let self, self.generation == current, !self.connected else { return }
                self.failed(generation: current, fatal: false,
                            message: "The server did not establish an lwfa session within 20 seconds. Check the address, network, and proxy connection.")
            }
            // Parsing happens outside the UI actor. Delivery is ordered and applies backpressure.
            receiver = Task.detached { [weak self] in
                do {
                    while !Task.isCancelled {
                        let wire = try await task.receive()
                        let event: Received
                        switch wire {
                        case .string(let text): event = .control(try ServerMessage.decode(Data(text.utf8)))
                        case .data(let data):
                            if data.starts(with: [0x4c, 0x57, 0x46, 0x50]) {
                                event = .audio(try AudioPacket.parse(data))
                            } else { event = .video(try VideoPacket.parse(data)) }
                        @unknown default: continue
                        }
                        await self?.receive(event, generation: current)
                    }
                } catch {
                    let status = (task.response as? HTTPURLResponse)?.statusCode
                    let replaced = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } == "replaced-by-newer-shell"
                    let failure = ConnectionFailure(error, httpStatus: status, replaced: replaced)
                    await self?.failed(generation: current, fatal: !failure.retryable, message: failure.message)
                }
            }
            heartbeat = Task { [weak self] in
                var ticks = 0
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    guard let self, self.generation == current else { return }
                    self.publishDiagnostics()
                    guard self.connected else { continue }
                    ticks += 1
                    if Date().timeIntervalSince(self.lastReceived) > 20 {
                        self.failed(generation: current, fatal: false, message: "The server stopped responding for 20 seconds.")
                        return
                    }
                    if ticks % 5 == 0 {
                        self.pingSentAt = Date()
                        self.send(.ping)
                    }
                }
            }
        } catch {
            failed(generation: current, fatal: true, message: "Could not create the connection. Check the server address.")
        }
    }

    private enum Received: Sendable {
        case control(ServerMessage), video(VideoPacket), audio(AudioPacket)
    }

    private func receive(_ received: Received, generation current: UInt64) {
        guard generation == current, wanted, activity.allowsTransport else { return }
        lastReceived = Date()
        switch received {
        case .video(let packet):
            receivedFrames += 1; receivedVideoBytes += packet.payload.count + VideoPacket.headerLength
            if packet.keyframe { receivedKeyframes += 1 }
            if UInt64(packet.width) * UInt64(packet.height) > UInt64(largestFrame.width) * UInt64(largestFrame.height) {
                largestFrame = (packet.width, packet.height)
            }
            lastCodec = packet.format == .hevc ? "HEVC" : (packet.format == .h264 ? "H.264" : "JPEG")
            guard connected, subscribedWindows.contains(packet.window), windows.contains(where: { $0.id == packet.window }) else { return }
            if blankWindowIDs.contains(packet.window) { blankWindowIDs.remove(packet.window) }
            let size = CGSize(width: Int(packet.width), height: Int(packet.height))
            if let previousSize = frameSizes[packet.window], previousSize != size,
               videoMode == .auto, !rejectedCodecs.isEmpty {
                let candidate = DecodeSize(width: packet.width, height: packet.height)
                var retried = codecRetrySizes[packet.window] ?? []
                // Retry once per distinct size, capped per window and connection.
                // An app oscillating between resolutions cannot create a retry loop.
                if retried.count < 16, retried.insert(candidate).inserted {
                    codecRetrySizes[packet.window] = retried
                    rejectedCodecs.removeAll()
                    windowMedia.values.forEach { $0.resetVideo() }
                    recordEvent("Retrying automatic codecs after resize")
                    subscribe(force: true)
                }
            }
            if frameSizes[packet.window] != size { frameSizes[packet.window] = size }
            if packet.window == selected, size != frameSize { frameSize = size }
            media(for: packet.window).decode(packet)
        case .audio(let packet):
            receivedAudioBytes += packet.payload.count + AudioPacket.headerLength
            receivedAudioChunks += 1
            audioFormat = packet.format == .opus ? "Opus" : "PCM16"
            audioSampleRate = packet.sampleRate
            if connected && !muted { media.audio.play(packet) }
        case .control(let message):
            switch message {
            case .hello(let hello):
                controller?.setEnabled(false)
                releaseInput(); clearWindowMedia(); frameSize = .zero; blankWindowIDs.removeAll()
                recordEvent("Connected")
                handshakeDeadline?.cancel(); handshakeDeadline = nil
                connection.accepted(); connectionIssue = nil
                windows = hello.windows; primary = hello.primary; canInteract = hello.permissions.mode == .interact
                account = hello.account; sessionID = hello.session; peers = hello.peers; allowedApps = hello.permissions.allowedApps
                lastViewport = nil; lastSentLayout = []; previousLayout = []; receivedLayout = false; restoredLayout = false; followerOffset = .zero
                engineOutput = hello.output; displayOutput = primary && canInteract ? (viewport ?? hello.output) : hello.output
                layout.setPersistenceKey((endpoint?.publicURL.absoluteString ?? "") + "." + account)
                layout.reset()
                configureLayout()
                if !canInteract { clipboardUploader.cancel() }
                selected = resumeSelection ?? hello.focused ?? windows.first?.id
                resumeSelection = nil
                if !windows.contains(where: { $0.id == selected }) { selected = windows.first?.id }
                if let endpoint {
                    do {
                        try CredentialStore.save(credential, endpoint: endpoint)
                        credentialsPersisted = true
                        persistSession()
                    } catch {
                        credentialsPersisted = false
                        problem = "Connected, but the password could not be saved. \(error.localizedDescription)"
                    }
                }
                subscribe(); configureAudio(); configureController(); applyLayout()
                UIApplication.shared.isIdleTimerDisabled = true
            case .windowOpened(let window):
                recordEvent("Window opened")
                windows.removeAll { $0.id == window.id }; windows.append(window)
                if primary && canInteract { select(window.id) } else { applyLayout() }
            case .windowChanged(let window):
                if let index = windows.firstIndex(where: { $0.id == window.id }) { windows[index] = window }
            case .windowClosed(let id):
                recordEvent("Window closed")
                blankWindowIDs.remove(id); codecRetrySizes.removeValue(forKey: id); finishClosing(id)
                windows.removeAll { $0.id == id }
                windowMedia.removeValue(forKey: id)?.resetVideo(); frameSizes.removeValue(forKey: id)
                if selected == id { updateSelection(nil) }
                applyLayout()
            case .focusChanged(let id):
                if let id, id != selected, windows.contains(where: { $0.id == id }) { select(id, focus: false) }
                // A transient missing host focus does not revoke the client's
                // selected window or disable a controller-only session. WindowClosed
                // removes invalid selections, as in the browser's strip policy.
            case .role(let value):
                guard primary != value else { return }
                releaseInput()
                primary = value
                recordEvent(value ? "Layout control acquired" : "Following another client")
                lastViewport = nil; lastSentLayout = []
                if value { layout.reset(); restoredLayout = false }
                applyLayout()
            case .layout(let placed, let output):
                previousLayout = placed
                engineOutput = output
                let initial = !receivedLayout
                receivedLayout = true
                if primary && canInteract {
                    if initial { applyLayout() }
                } else { applyFollowerLayout() }
            case .outputChanged(let output):
                engineOutput = output
                if !primary || !canInteract { applyFollowerLayout() }
            case .fullscreenRequest(let id, let fullscreen):
                layoutAction("fullscreenRequest", args: [.uint(id), .bool(fullscreen)])
            case .windowBlank(let id, let blank):
                if blank {
                    blankWindowIDs.insert(id); windowMedia[id]?.resetVideo()
                    recordEvent("Window has no image")
                } else { blankWindowIDs.remove(id) }
            case .error(let request, let message):
                if ["closewindow", "quitapp"].contains(request.lowercased()) {
                    for id in Array(pendingCloseIDs) { finishClosing(id) }
                }
                recordEvent("Server rejected a request")
                if problem == nil { problem = message }
            case .peers(let value):
                peers = value
                if let currentPeer = value.first(where: { $0.id == sessionID }) {
                    let nextPermission = currentPeer.mode == .interact
                    if canInteract && !nextPermission { releaseInput(); clipboardUploader.cancel() }
                    let changed = canInteract != nextPermission
                    canInteract = nextPermission
                    if changed {
                        if primary && canInteract { layout.reset(); restoredLayout = false }
                        applyLayout()
                    }
                    configureController()
                }
            case .engineVersion(let value): engineVersion = value
            case .pong:
                if let pingSentAt { roundTripMilliseconds = Date().timeIntervalSince(pingSentAt) * 1000; self.pingSentAt = nil }
            case .administration(let type, let value):
                if type == "keyBinding" { handleKeyBinding(value) }
                serverMessages[type] = value
                if type == "fileChooser", !fileChoosers.contains(where: { $0["request"] == value["request"] }) { fileChoosers.append(value) }
                if type == "fileChooserClosed" { fileChoosers.removeAll { $0["request"] == value["request"] } }
                serverEvents.send((type, value))
            default: break
            }
        }
    }

    func send(_ command: ClientCommand) {
        guard connected, socket != nil else { return }
        guard queue.count < 512 else {
            failed(generation: generation, fatal: false, message: nil)
            return
        }
        let closing: UInt64?
        switch command {
        case .closeWindow(let id): closing = id
        case .administration(let type, let fields) where type == "closeWindow" || type == "quitApp": closing = fields["id"]?.uintValue
        default: closing = nil
        }
        if let id = closing {
            guard canInteract, windows.contains(where: { $0.id == id }), !pendingCloseIDs.contains(id) else { return }
            pendingCloseIDs.insert(id)
            let current = generation
            closeExpiry[id] = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.generation == current else { return }
                self.finishClosing(id)
                self.recordEvent("Window close was not confirmed")
            }
        }
        queue.append(command)
        guard writer == nil, let socket else { return }
        let current = generation
        writer = Task { [weak self] in
            guard let self else { return }
            do {
                while self.generation == current && !Task.isCancelled && !self.queue.isEmpty {
                    let next = self.queue.removeFirst()
                    let data = try next.encoded()
                    guard let text = String(data: data, encoding: .utf8) else { continue }
                    try await socket.send(.string(text))
                }
                if self.generation == current { self.writer = nil }
            } catch {
                let failure = ConnectionFailure(error)
                self.failed(generation: current, fatal: !failure.retryable, message: failure.message)
            }
        }
    }

    private func finishClosing(_ id: UInt64) {
        pendingCloseIDs.remove(id)
        closeExpiry.removeValue(forKey: id)?.cancel()
    }

    func sendMessage(_ type: String, _ fields: [String: WireValue] = [:]) {
        send(.administration(type: type, fields: fields))
    }

    func dismissFileChooser(_ id: UInt64) {
        fileChoosers.removeAll { $0["request"].uintValue == id }
    }

    func nextRequestID() -> UInt64 {
        requestSequence &+= 1
        return requestSequence
    }

    /// Store a password for a machine without connecting (Connections panel).
    func saveCredential(address: String, allowInsecure: Bool, password: String) throws {
        let server = try ServerEndpoint(address, allowInsecure: allowInsecure)
        try CredentialStore.save(password, endpoint: server)
    }
    func hasCredential(address: String, allowInsecure: Bool) -> Bool {
        guard let server = try? ServerEndpoint(address, allowInsecure: allowInsecure) else { return false }
        return (try? CredentialStore.read(server)) != nil
    }

    func signOut() {
        do {
            if let endpoint { try CredentialStore.remove(endpoint) }
        } catch { problem = "Could not remove the saved password. \(error.localizedDescription)" }
        disconnect()
    }

    private func failed(generation current: UInt64, fatal: Bool, message: String?) {
        guard current == generation else { return }
        stopTransport()
        connectionIssue = message ?? "The connection was interrupted. Try connecting again."
        recordEvent(fatal ? "Connection stopped" : "Connection interrupted")
        guard wanted, active else { connection.pause(); return }
        guard connection.failed(retryable: !fatal) else {
            wanted = false
            credential = ""
            problem = connectionIssue
            publishDiagnostics()
            return
        }
        recordEvent("Reconnecting")
        let delay = min(15.0, pow(2.0, Double(connection.retries - 1))) + Double.random(in: 0...0.5)
        let retryGeneration = generation
        retry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.generation == retryGeneration, self.wanted, self.active else { return }
            self.open()
        }
    }

    func disconnect() {
        wanted = false
        credential = ""
        bookmarkStore.clear()
        credentialsPersisted = false
        restorationAttempted = true
        UserDefaults.standard.set(true, forKey: "native.sessionRestorationMigrated")
        if connected { suspendTransport() } else { stopTransport() }
        connection.cancel()
        connectionIssue = nil
    }

    func setActivity(_ phase: SessionActivity.Phase) {
        let transition = activity.move(to: phase)
        switch transition {
        case .none: break
        case .pauseInput:
            releaseInput()
            controller?.setEnabled(false)
        case .suspend:
            persistSession()
            resumeSelection = selected
            suspendTransport()
        case .resume, .resumeInput:
            if !restorationAttempted { restoreLastSession() }
            else if wanted, socket == nil || connection.phase == .suspended { open() }
            if transition == .resume { media.audio.resumeAfterBackground() }
            if phase == .active { configureController() }
        }
    }

    private func restoreLastSession() {
        guard active, !restorationAttempted, UIApplication.shared.isProtectedDataAvailable else { return }
        restorationAttempted = true
        let bookmark = bookmarkStore.load()
        let legacyAddress = UserDefaults.standard.bool(forKey: "native.sessionRestorationMigrated")
            ? nil : UserDefaults.standard.string(forKey: "server")
        UserDefaults.standard.set(true, forKey: "native.sessionRestorationMigrated")
        // Older builds saved only the address. Migrate only if Keychain has its password.
        guard let address = bookmark?.address ?? legacyAddress else { return }
        do {
            let server = try ServerEndpoint(address, allowInsecure: bookmark?.allowInsecure ?? UserDefaults.standard.bool(forKey: "server.allowHTTP"))
            guard let secret = try CredentialStore.read(server), !secret.isEmpty else {
                if bookmark != nil { problem = "The saved password is unavailable. Enter it once to reconnect." }
                return
            }
            endpoint = server
            credential = secret
            credentialsPersisted = true
            wanted = true
            resumeSelection = bookmark?.selectedWindow
            immersive = bookmark?.immersive ?? immersive
            connection.begin()
            open()
        } catch {
            problem = "Could not restore the previous session. \(error.localizedDescription)"
        }
    }

    func protectedDataAvailable() {
        if active, !restorationAttempted { restoreLastSession() }
    }

    private func persistSession() {
        guard connection.established, credentialsPersisted, wanted, let endpoint else { return }
        do {
            try bookmarkStore.save(SessionBookmark(endpoint: endpoint, selectedWindow: selected, immersive: immersive))
        } catch { problem = "Could not save session restoration information." }
    }

    private func suspendTransport() {
        releaseInput()
        controller?.setEnabled(false)
        if connected { send(.setGamepad(enabled: false)); send(.setAudio(enabled: false, local: localPlayback, opus: false, quality: .auto)) }
        let current = generation
        finishBackgroundLease()
        // A short UIKit background assertion lets queued input releases drain.
        // Every path closes it, including expiry and a quick foreground return.
        backgroundLease = UIApplication.shared.beginBackgroundTask(withName: "lwfa suspend") { [weak self] in
            guard let self else { return }
            if self.generation == current { self.stopTransport(); self.connection.pause() }
            else { self.finishBackgroundLease() }
        }
        suspensionTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
            guard let self, self.generation == current else { return }
            self.stopTransport()
            if self.wanted { self.connection.pause() }
        }
        connection.pause()
    }

    private func finishBackgroundLease() {
        suspensionTask?.cancel(); suspensionTask = nil
        if backgroundLease != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundLease)
            backgroundLease = .invalid
        }
    }

    private func stopTransport() {
        generation &+= 1
        finishBackgroundLease()
        receiver?.cancel(); receiver = nil
        writer?.cancel(); writer = nil
        heartbeat?.cancel(); heartbeat = nil
        handshakeDeadline?.cancel(); handshakeDeadline = nil
        retry?.cancel(); retry = nil
        resizeTask?.cancel(); resizeTask = nil
        keyframeTask?.cancel(); keyframeTask = nil
        closeExpiry.values.forEach { $0.cancel() }; closeExpiry.removeAll(); pendingCloseIDs.removeAll()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        queue.removeAll(); _ = inputs.releaseAll(); touches.removeAll(); pointerWindow = nil
        serverMessages.removeAll()
        fileChoosers.removeAll()
        controller?.setEnabled(false)
        clearWindowMedia(); media.reset(); clipboardUploader.cancel(); frameSize = .zero
        if !connection.established { placedWindows = [] }
        receivedLayout = false; blankWindowIDs.removeAll()
        subscribedWindows = []; subscribedCodecs = []; rejectedCodecs.removeAll(); codecRetrySizes.removeAll()
        receivedFrames = 0; receivedVideoBytes = 0; receivedAudioBytes = 0
        receivedKeyframes = 0; receivedAudioChunks = 0; largestFrame = (0, 0); audioFormat = ""; audioSampleRate = 0
        lastCodec = ""; pingSentAt = nil; roundTripMilliseconds = nil; measuredAt = Date(); diagnostics = .object([:])
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// Decoder ownership follows a window, so switching focus never resets audio or another window's reference frames.
    func media(for id: UInt64) -> NativeMedia {
        if let existing = windowMedia[id] { return existing }
        let item = NativeMedia(audio: media.audio)
        item.onNeedsKeyframe = { [weak self] in
            self?.recordEvent("Video recovery requested")
            self?.requestKeyframe()
        }
        item.onFailure = { [weak self] message in
            self?.recordEvent("Video decoder reported an error")
            if self?.problem == nil { self?.problem = message }
        }
        item.onCodecFailure = { [weak self] codec in
            guard let self, self.videoMode == .auto, self.rejectedCodecs.insert(codec).inserted else { return }
            self.recordEvent("Automatic codec fallback")
            self.subscribe()
        }
        windowMedia[id] = item
        return item
    }

    private func clearWindowMedia() {
        windowMedia.values.forEach { $0.resetVideo() }
        windowMedia.removeAll(); frameSizes.removeAll()
    }

    private func updateSelection(_ id: UInt64?) {
        guard selected != id else { return }
        controller?.setEnabled(false)
        releaseInput()
        selected = id
        persistSession()
        frameSize = id.flatMap { frameSizes[$0] } ?? .zero
        configureController()
    }

    func select(_ id: UInt64?, focus: Bool = true) {
        guard id == nil || windows.contains(where: { $0.id == id }) else { return }
        let changed = selected != id
        updateSelection(id)
        if changed, focus, canInteract, let id { send(.focusWindow(id: id)) }
        if primary && canInteract { applyLayout() } else { applyFollowerLayout() }
    }

    private func subscribe(force: Bool = false) {
        guard connected, receivedLayout else { return }
        let codecs: [Codec]
        switch videoMode {
        case .auto: codecs = NativeMedia.supportedCodecs.filter { !rejectedCodecs.contains($0) }
        case .hevc: codecs = [.hevc]
        case .h264: codecs = [.h264]
        case .jpeg: codecs = []
        }
        let ids: [UInt64]
        if !videoEnabled { ids = [] }
        else if primary && canInteract {
            if arranging {
                let workspaces = layout.state["workspaces"].arrayValue
                let index = Int(layout.state["focus"].uintValue)
                ids = workspaces.indices.contains(index) ? workspaces[index]["columns"].arrayValue.flatMap { $0["windows"].arrayValue.map(\.uintValue) } : []
            } else { ids = layout.streamIDs(pauseInactive: pauseInactive) }
        }
        else {
            // Followers display the primary client's actual geometry and never impose their own arrangement.
            ids = placedWindows.filter { item in
                let rect = item.rect
                return rect.x < Double(displayOutput.width) && rect.y < Double(displayOutput.height) && rect.x + rect.width > 0 && rect.y + rect.height > 0
                    && (arranging || !pauseInactive || selected == nil || selected == item.id || followerLiveWindows().contains(item.id))
            }.map(\.id)
        }
        guard force || ids != subscribedWindows || codecs != subscribedCodecs else { return }
        subscribedWindows = ids; subscribedCodecs = codecs
        streamedWindows = Set(ids)
        send(.setStreams(windows: ids, codecs: codecs))
    }

    private func requestKeyframe() {
        guard connected, keyframeTask == nil else { return }
        let current = generation
        let delay = max(0, 1 - Date().timeIntervalSince(lastKeyframeRequest))
        // Coalesce requests without losing the only request for a broken frame chain.
        keyframeTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.generation == current else { return }
            self.keyframeTask = nil
            self.lastKeyframeRequest = Date()
            self.subscribe(force: true)
        }
    }

    private func configureAudio() {
        media.setMuted(muted)
        send(.setAudio(enabled: !muted, local: localPlayback, opus: true, quality: audioQuality))
    }

    func resumeAudio() {
        guard connected, !muted else { return }
        media.audio.resumeAfterBackground()
    }

    private func configureController() {
        let deviceEnabled = (gamepadEnabled || (gamepad.visible && gamepad.mode == "controller")) && connected && wanted && active && canInteract
        if deviceEnabled {
            send(.setGamepad(enabled: true))
            controller?.setEnabled(acceptsInput && gamepadEnabled)
        } else {
            controller?.setEnabled(false)
            send(.setGamepad(enabled: false))
        }
    }

    func setInputSuspended(_ value: Bool, source: String = "root") {
        guard inputSuspensions.set(value, owner: source) else { return }
        if inputSuspended { releaseInput() }
        configureController()
    }

    func resize(_ size: CGSize) {
        guard let next = CanvasGeometry.viewport(width: size.width, height: size.height), next != viewport else { return }
        viewport = next
        resizeTask?.cancel()
        resizeTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
            self?.applyLayout()
        }
    }

    private func recordEvent(_ message: String) {
        // Callers provide fixed descriptions only. No server text, credentials,
        // application titles, command lines, URLs, or file paths enter this log.
        eventLog.append(.object(["time": .double(Date().timeIntervalSince1970), "message": .string(message)]))
        if eventLog.count > 60 { eventLog.removeFirst(eventLog.count - 60) }
    }

    private func publishDiagnostics() {
        let now = Date()
        let elapsed = max(0.001, now.timeIntervalSince(measuredAt))
        let interrupted = media.audio.diagnostics["interrupted"].boolValue
        if interrupted != audioInterrupted { audioInterrupted = interrupted }
        diagnostics = .object([
            "framesPerSecond": .double(Double(receivedFrames) / elapsed),
            "keyframesPerSecond": .double(Double(receivedKeyframes) / elapsed),
            "largestFrameWidth": .uint(UInt64(largestFrame.width)),
            "largestFrameHeight": .uint(UInt64(largestFrame.height)),
            "audioFormat": .string(audioFormat),
            "audioSampleRate": .uint(UInt64(audioSampleRate)),
            "audioChunksPerSecond": .double(Double(receivedAudioChunks) / elapsed),
            "recentEvents": .array(eventLog),
            "connectionIssue": connectionIssue.map(WireValue.string) ?? .null,
            "megabitsPerSecond": .double(Double(receivedVideoBytes + receivedAudioBytes) * 8 / elapsed / 1_000_000),
            "videoMegabitsPerSecond": .double(Double(receivedVideoBytes) * 8 / elapsed / 1_000_000),
            "audioMegabitsPerSecond": .double(Double(receivedAudioBytes) * 8 / elapsed / 1_000_000),
            "codec": .string(lastCodec),
            "roundTripMilliseconds": roundTripMilliseconds.map(WireValue.double) ?? .null,
            "audioQueuedMilliseconds": .double(media.audio.queuedMilliseconds),
            "audio": media.audio.diagnostics,
            "activeStreams": .uint(UInt64(subscribedWindows.count)),
            "presentedPerSecond": .double(Double(windowMedia.values.reduce(UInt64(0)) { $0 + $1.takePresentedFrameCount() }) / elapsed),
        ])
        measuredAt = now; receivedFrames = 0; receivedVideoBytes = 0; receivedAudioBytes = 0
        receivedKeyframes = 0; receivedAudioChunks = 0; largestFrame = (0, 0)
    }

    private func handleKeyBinding(_ value: WireValue) {
        guard primary, canInteract else { return }
        let shifted = value["modifiers"]["shift"].boolValue
        switch value["key"].stringValue {
        case "h", "Left": layoutAction(shifted ? "stack" : "focusLeft")
        case "l", "Right": layoutAction(shifted ? "unstack" : "focusRight")
        case "k", "Up": layoutAction(shifted ? "moveWorkspace" : "focusUp", args: shifted ? [.int(-1)] : [])
        case "j", "Down": layoutAction(shifted ? "moveWorkspace" : "focusDown", args: shifted ? [.int(1)] : [])
        case "1", "2", "3":
            if let number = Int64(value["key"].stringValue) { layoutAction("workspace", args: [.int(number - 1)]) }
        case "4": layoutAction("cycleWidth")
        case "f": layoutAction("fullscreen")
        case "w": if let selected { sendMessage("closeWindow", ["id": .uint(selected)]) }
        default: break
        }
    }

    private func configureLayout() {
        let prefs = preferences.state
        layout.configure(orientation: prefs.orientation, defaultWidth: prefs.defaultWidth, centreFocused: prefs.centreFocused)
    }

    func layoutAction(_ name: String, args: [WireValue] = []) {
        guard connected, primary, canInteract, receivedLayout else { return }
        let output = viewport ?? engineOutput
        if layout.output != output { layout.resize(output: output) }
        layout.action(name, args: args)
        commitLayout()
    }

    private func applyLayout() {
        guard connected, receivedLayout else { return }
        guard primary && canInteract else { applyFollowerLayout(); return }
        let output = viewport ?? engineOutput
        layout.reconcile(windows: windows, focused: selected, output: restoredLayout ? output : engineOutput, current: previousLayout)
        restoredLayout = true
        if layout.output != output { layout.resize(output: output) }
        commitLayout()
    }

    private func applyFollowerLayout() {
        guard connected, receivedLayout else { return }
        layoutAnimated = displayOutput == engineOutput
        displayOutput = engineOutput
        if preferences.state.followEngineScroll { followerOffset = .zero }
        else if let selected, let target = previousLayout.first(where: { $0.id == selected }) {
            let width = Double(engineOutput.width), height = Double(engineOutput.height)
            let rect = target.rect
            let x = rect.x + followerOffset.width, y = rect.y + followerOffset.height
            if rect.width >= width { followerOffset.width = -rect.x }
            else if x < 0 { followerOffset.width -= x }
            else if x + rect.width > width { followerOffset.width -= x + rect.width - width }
            if rect.height >= height { followerOffset.height = -rect.y }
            else if y < 0 { followerOffset.height -= y }
            else if y + rect.height > height { followerOffset.height -= y + rect.height - height }
        }
        // Move the whole desktop together. The captured pixels and host window
        // sizes remain unchanged, and normalized input still addresses each window.
        placedWindows = previousLayout.map { item in
            WindowLayout(id: item.id, rect: Rect(x: item.rect.x + followerOffset.width, y: item.rect.y + followerOffset.height,
                                                width: item.rect.width, height: item.rect.height), z: item.z)
        }
        subscribe()
    }

    private func followerLiveWindows() -> Set<UInt64> {
        // Live-column flags are client arrangement preferences, not transmitted
        // in SetLayout. Preserve any locally known flag; never infer stacks from
        // overlapping rectangles or change the primary client's arrangement.
        guard let selected else { return [] }
        for workspace in layout.state["workspaces"].arrayValue {
            for column in workspace["columns"].arrayValue where column["live"].boolValue {
                let ids = column["windows"].arrayValue.map(\.uintValue)
                if ids.contains(selected) { return Set(ids) }
            }
        }
        return []
    }

    private func commitLayout() {
        guard primary, canInteract, connected, receivedLayout else { return }
        if let error = layout.error { problem = error; return }
        let output = viewport ?? engineOutput
        layoutAnimated = output == lastViewport && output == displayOutput
        if output != lastViewport {
            send(.setViewport(width: output.width, height: output.height, scale: 1))
            lastViewport = output
        }
        displayOutput = output
        placedWindows = layout.placed
        if selected != layout.focused {
            updateSelection(layout.focused)
            if canInteract, let id = selected { send(.focusWindow(id: id)) }
        }
        if layout.placed != lastSentLayout {
            if let encoded = try? JSONEncoder().encode(layout.placed), let windows = try? WireValue.decode(encoded) {
                let animate = preferences.state.animate && !UIAccessibility.isReduceMotionEnabled
                sendMessage("setLayout", ["windows": windows, "animate": animate ? .object(["spring": layout.spring]) : .null])
                lastSentLayout = layout.placed
            }
        }
        subscribe()
    }

    func button(_ code: UInt32, pressed: Bool, source: String = "physical") {
        guard acceptsInput, gamepadEnabled || source != "physical" else { return }
        gamepad.record(command: .gamepadButton(button: code, pressed: pressed), source: source)
        if let command = inputs.button(code, pressed: pressed, source: source) { send(command) }
    }
    func axis(_ code: UInt32, value: Double, source: String = "physical") {
        guard acceptsInput, gamepadEnabled || source != "physical" else { return }
        gamepad.record(command: .gamepadAxis(axis: code, value: value), source: source)
        if let command = inputs.axis(code, value: value, source: source) { send(command) }
    }
    func touch(window: UInt64, type: String, id: Int32, x: Double, y: Double) {
        let source = TouchSource(window: window, local: id)
        if type == "touchUp" || type == "up" {
            if let global = touches.removeValue(forKey: source) { sendMessage("touchUp", ["id": .int(Int64(global))]) }
            return
        }
        guard connected, wanted, active, canInteract, !inputSuspended, windows.contains(where: { $0.id == window }), x.isFinite, y.isFinite else { return }
        let down = type == "touchDown" || type == "down"
        guard down || type == "touchMotion" || type == "move" else { return }
        if down {
            select(window)
            if let old = touches.removeValue(forKey: source) { sendMessage("touchUp", ["id": .int(Int64(old))]) }
            while touches.values.contains(nextTouch) { nextTouch = nextTouch == Int32.max ? 1 : nextTouch + 1 }
            touches[source] = nextTouch
            nextTouch = nextTouch == Int32.max ? 1 : nextTouch + 1
        }
        guard let global = touches[source] else { return }
        sendMessage(down ? "touchDown" : "touchMotion", ["window": .uint(window), "id": .int(Int64(global)),
                    "x": .double(x), "y": .double(y), "normalized": .bool(true)])
    }

    func pointerLeave() { pointerWindow = nil; if connected { send(.pointerLeave) } }
    func pointerLeave(window: UInt64) { if pointerWindow == window { pointerLeave() } }
    func key(window: UInt64, _ code: UInt32, pressed: Bool) {
        guard selected == window else { return }
        key(code, pressed: pressed, source: "canvas:\(window)")
    }
    func scroll(window: UInt64, horizontal: Double, vertical: Double) {
        guard pointerWindow == window || selected == window else { return }
        scroll(horizontal: horizontal, vertical: vertical)
    }
    func releasePointerInput(window: UInt64) {
        releaseSource("canvas:\(window)")
        for source in touches.keys.filter({ $0.window == window }) {
            if let id = touches.removeValue(forKey: source) { sendMessage("touchUp", ["id": .int(Int64(id))]) }
        }
        pointerLeave(window: window)
    }

    func pointer(window id: UInt64, x: Double, y: Double) {
        guard connected, wanted, active, canInteract, !inputSuspended, windows.contains(where: { $0.id == id }) else { return }
        pointerWindow = id
        send(.pointerMotion(window: id, x: x, y: y, normalized: true))
    }
    func pointerButton(window id: UInt64, _ code: UInt32, pressed: Bool, source: String = "canvas") {
        guard connected, wanted, active, canInteract, !inputSuspended, windows.contains(where: { $0.id == id }) else { return }
        if pressed { select(id) }
        pointerButton(code, pressed: pressed, source: source == "canvas" ? "canvas:\(id)" : source)
    }
    func pointer(x: Double, y: Double) {
        guard acceptsInput, let selected else { return }
        pointerWindow = selected
        send(.pointerMotion(window: selected, x: x, y: y, normalized: true))
    }
    func pointerButton(_ code: UInt32, pressed: Bool, source: String = "canvas") {
        guard acceptsInput else { return }
        if let command = inputs.pointerButton(code, pressed: pressed, source: source) { send(command) }
    }
    func key(_ code: UInt32, pressed: Bool, source: String = "canvas") {
        guard acceptsInput else { return }
        if let command = inputs.key(code, pressed: pressed, source: source) { send(command) }
    }
    func scroll(horizontal: Double, vertical: Double) {
        guard acceptsInput else { return }
        let speed = preferences.state.scrollSpeed * (preferences.state.naturalScroll ? -1 : 1)
        send(.pointerAxis(horizontal: horizontal * speed, vertical: vertical * speed))
    }
    func releaseInput() {
        inputGeneration &+= 1
        for id in touches.values { sendMessage("touchUp", ["id": .int(Int64(id))]) }
        touches.removeAll()
        for command in inputs.releaseAll() { send(command) }
    }
    func releaseSource(_ source: String) {
        for command in inputs.release(source: source) { send(command) }
    }
    private func releaseGamepad() { releaseSource("physical") }
    func releasePointerInput() { releaseSource("canvas") }
    func resetController() {
        controller?.setEnabled(false)
        configureController()
    }
    func tapKey(_ code: UInt32) {
        key(code, pressed: true, source: "shortcut")
        key(code, pressed: false, source: "shortcut")
    }
    private func saveStreamPreferences() {
        UserDefaults.standard.set(["videoMode": videoMode.rawValue, "videoEnabled": videoEnabled, "pauseInactive": pauseInactive,
                                   "muted": muted, "localPlayback": localPlayback, "volume": volume,
                                   "audioQuality": audioQuality.rawValue], forKey: "native.stream")
    }
    func resetStreamPreferences() {
        videoMode = .auto; videoEnabled = true; pauseInactive = true; muted = true
        localPlayback = false; volume = 1; audioQuality = .auto
    }
}

private enum CredentialStore {
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "io.github.ngodn.lwfa.server",
         kSecAttrAccount as String: account]
    }
    static func read(_ endpoint: ServerEndpoint) throws -> String? {
        for account in endpoint.credentialAliases {
            if let password = try readAccount(account) { return password }
        }
        return nil
    }
    private static func readAccount(_ account: String) throws -> String? {
        var values = query(account)
        values[kSecReturnData as String] = true
        values[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(values as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.status(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw Failure.status(errSecDecode) }
        return value
    }
    static func save(_ value: String, endpoint: ServerEndpoint) throws {
        let key = query(endpoint.credentialKey)
        let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8),
                                        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(key.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure.status(status) }
    }
    static func remove(_ endpoint: ServerEndpoint) throws {
        for account in endpoint.credentialAliases {
            let status = SecItemDelete(query(account) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.status(status) }
        }
    }
    enum Failure: Error, LocalizedError {
        case status(OSStatus)
        var errorDescription: String? {
            switch self {
            case .status(let code):
                switch code {
                case errSecMissingEntitlement:
                    return "The installed app's signing entitlements do not allow Keychain access (\(code)). Re-signing must preserve the app's Keychain identity."
                case errSecInteractionNotAllowed:
                    return "The saved password is temporarily unavailable while the iPad is locked (\(code)). Unlock it and try again."
                default:
                    return "Keychain could not complete the password operation (status \(code))."
                }
            }
        }
    }
}
#endif
