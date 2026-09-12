#if os(iOS)
import SwiftUI
import LWFACore

@main
struct LWFAApp: App {
    @State private var session = NativeSession()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                .frame(minWidth: 480, minHeight: 320)
                .tint(LWFATheme.primary)
                .onChange(of: scenePhase, initial: true) { _, phase in
                    switch phase {
                    case .active: session.setActivity(.active)
                    case .inactive: session.setActivity(.inactive)
                    case .background: session.setActivity(.background)
                    @unknown default: session.setActivity(.inactive)
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                    session.protectedDataAvailable()
                }
        }
        .windowResizability(.contentMinSize)
    }
}

private enum NativePresentation: Identifiable {
    case settings
    case chooser(WireValue)
    var id: String {
        switch self { case .settings: return "settings"; case .chooser(let request): return "file:\(request["request"].uintValue)" }
    }
}

/// Login until the engine accepts the session, then the shell.
private struct RootView: View {
    @Bindable var session: NativeSession
    @State private var panel: String?
    @State private var loginSettings = false

    private var presentation: NativePresentation? {
        if session.showsWorkspace, let request = session.fileChoosers.first { return .chooser(request) }
        if !session.showsWorkspace, loginSettings { return .settings }
        return nil
    }
    /// Native sheets and dialogs release gameplay input. An open panel does
    /// not: it is non-modal and the desktop behind it stays live, as in the browser.
    private var suspended: Bool { presentation != nil || session.problem != nil || session.arranging }

    var body: some View {
        Group {
            if session.showsWorkspace {
                ShellView(session: session, panel: $panel)
            } else {
                LoginView(session: session) { loginSettings = true }
            }
        }
        .preferredColorScheme(session.preferences.state.theme == "dark" ? .dark : session.preferences.state.theme == "light" ? .light : nil)
        .alert("lwfa", isPresented: Binding(get: { session.showsWorkspace && session.problem != nil }, set: { if !$0 { session.problem = nil } })) {
            Button("OK") { session.problem = nil }
        } message: { Text(session.problem ?? "") }
        .sheet(item: Binding(get: { presentation }, set: { value in if value == nil { loginSettings = false } })) { item in
            switch item {
            case .chooser(let request):
                NativeFileChooser(session: session, request: request)
                    .id(request["request"].uintValue)
                    .interactiveDismissDisabled()
            case .settings:
                NavigationStack {
                    ScrollView {
                        NativeSettingsPanel(session: session).padding(14)
                    }
                    .background(LWFATheme.background)
                    .navigationTitle("Settings")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { loginSettings = false } } }
                }
            }
        }
        .protectNativeTextInput(session)
        .onChange(of: suspended, initial: true) { _, value in session.setInputSuspended(value) }
    }
}

// MARK: - Session panel

/// `SessionPanel.tsx`: everything here is observed, never chosen.
struct NativeSessionPanel: View {
    @Bindable var session: NativeSession
    var openSettings: () -> Void
    @State private var confirmSignOut = false
    @State private var confirmRestart = false
    @State private var restartPending = false
    @State private var copied = false
    @State private var showLicenses = false

    private var fps: Double { session.diagnostics["framesPerSecond"].doubleValue }
    private var codec: String {
        let receiving = session.diagnostics["codec"].stringValue
        if !receiving.isEmpty { return receiving }
        switch session.videoMode {
        case .jpeg: return "JPEG"
        case .auto: return NativeMedia.supportedCodecs.first.map { $0 == .hevc ? "HEVC" : "H.264" } ?? "JPEG"
        default: return session.videoMode.rawValue
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelSection("Connection") {
                PanelGroup {
                    HStack(spacing: 14) {
                        Text("Status").font(LWFATheme.readout).foregroundStyle(LWFATheme.mutedForeground)
                        Spacer(minLength: 0)
                        HStack(spacing: 8) { StatusDot(tone: session.statusTone); Text(session.statusLabel).font(LWFATheme.readout) }
                    }.frame(minHeight: 38).padding(.horizontal, 12).padding(.vertical, 6)
                    ReadoutRow("Decode", value: codec)
                    ReadoutRow("Windows", value: String(session.windows.count))
                    ReadoutRow("Viewport", value: session.displayOutput.width > 1 ? "\(session.displayOutput.width) × \(session.displayOutput.height)" : "Unavailable")
                }
                if session.statusTone != .good {
                    Text(session.statusHint).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground).padding(.horizontal, 2)
                }
            }
            PanelSection("Video") {
                if !session.videoEnabled {
                    DashedNote(text: "Video paused. Enable it in Stream.")
                } else {
                    PanelGroup {
                        ReadoutRow("Frame rate", value: fps > 0 ? String(format: "%.0f /s", fps) : "Nothing yet", tone: fps > 0 && fps < 20 ? LWFATheme.warning : nil)
                        ReadoutRow("Bitrate", value: bitrate(session.diagnostics["megabitsPerSecond"].doubleValue))
                        ReadoutRow("Largest frame", value: "\(session.diagnostics["largestFrameWidth"].uintValue) × \(session.diagnostics["largestFrameHeight"].uintValue)")
                        ReadoutRow("Keyframes", value: String(format: "%.1f of %.0f", session.diagnostics["keyframesPerSecond"].doubleValue, fps))
                        if session.diagnostics["roundTripMilliseconds"] != .null {
                            ReadoutRow("Round trip", value: String(format: "%.0f ms", session.diagnostics["roundTripMilliseconds"].doubleValue))
                        }
                        ReadoutRow("Presented", value: String(format: "%.0f /s", session.diagnostics["presentedPerSecond"].doubleValue))
                    }
                    if fps > 0 && fps < 20 { DashedNote(text: "Low frame rate.", padding: 12) }
                }
            }
            PanelSection("Sound") {
                if session.muted {
                    PanelGroup {
                        FieldRow("Muted") {
                            Button("Enable") { session.muted = false }.panelButton(.outline)
                        }
                    }
                } else { audioReadout }
            }
            PanelSection("Session") {
                PanelGroup {
                    ReadoutRow("Engine", value: session.publicServerURL?.absoluteString ?? "Disconnected")
                    ReadoutRow("Account", value: "\(session.account) · \(session.canInteract ? "interact" : "view") · \(session.allowedApps.map { "\($0.count) apps" } ?? "all apps")")
                    ReadoutRow("Workspace", value: "\(session.layout.state["focus"].uintValue + 1) of \(max(1, session.layout.state["workspaces"].arrayValue.count)) · \(columnCount) columns")
                    ReadoutRow("Devices", value: session.peers.count <= 1 ? "This one only" : "\(session.peers.count) attached · \(session.primary ? "driving here" : "following")")
                    ReadoutRow("Focus", value: session.selected == nil ? "Nothing focused" : session.selectedTitle)
                    ReadoutRow("Version", value: session.engineVersion.isEmpty ? "Unknown" : session.engineVersion)
                    ReadoutRow("iPad app", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
                if !session.primary && session.canInteract {
                    Button { session.send(.takeControl) } label: { Label("Arrange from this device", systemImage: "gamecontroller") }
                        .panelButton(.outline, fullWidth: true)
                }
            }
            PanelSection("Log", description: "Newest first.") {
                let events = Array(session.diagnostics["recentEvents"].arrayValue.reversed())
                if events.isEmpty { DashedNote(text: "Nothing yet.") }
                else {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                            HStack(alignment: .top, spacing: 8) {
                                Text(Date(timeIntervalSince1970: event["time"].doubleValue), style: .time).monospacedDigit()
                                    .foregroundStyle(LWFATheme.mutedForeground)
                                Text(event["message"].stringValue)
                            }.font(LWFATheme.monoLog)
                        }
                    }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                    .panelCard(padding: 0)
                }
            }
            VStack(spacing: 8) {
                Button { copyDiagnostics() } label: { Label(copied ? "Copied" : "Copy diagnostics", systemImage: "doc.on.doc") }
                    .panelButton(.outline, fullWidth: true)
                Button { session.disconnect() } label: { Label("Disconnect", systemImage: "xmark.circle") }
                    .panelButton(.outline, fullWidth: true)
                Button { confirmSignOut = true } label: { Label("Sign out of this device", systemImage: "rectangle.portrait.and.arrow.right") }
                    .panelButton(.outline, fullWidth: true)
                if session.isOwner {
                    Button { confirmRestart = true } label: {
                        HStack(spacing: 8) {
                            if restartPending { ProgressView().controlSize(.small) }
                            Label(restartPending ? "Restarting lwfa…" : "Restart lwfa", systemImage: "arrow.clockwise")
                        }
                    }
                    .panelButton(.outline, fullWidth: true)
                    .disabled(!session.connected || restartPending)
                }
                Button { showLicenses = true } label: { Label("Open-source licenses", systemImage: "doc.text") }
                    .panelButton(.ghost, fullWidth: true)
            }
        }
        .gameInputSuspended(session, while: confirmSignOut || confirmRestart || showLicenses)
        .confirmationDialog("Sign out of this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { session.signOut() }
        } message: { Text("The saved password for this server will be removed from this iPad.") }
        .confirmationDialog("Restart lwfa?", isPresented: $confirmRestart, titleVisibility: .visible) {
            Button("Restart lwfa", role: .destructive) {
                guard session.connected, session.isOwner else { return }
                restartPending = true; session.sendMessage("restartEngine")
            }
        } message: { Text("Everyone will disconnect, and running apps and games may close. Save your work first. This app will reconnect automatically.") }
        .sheet(isPresented: $showLicenses) {
            NavigationStack {
                ScrollView { Text(opusLicense).font(.footnote).textSelection(.enabled).padding() }
                    .background(LWFATheme.background)
                    .navigationTitle("Licenses")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showLicenses = false } } }
            }
        }
        .task(id: restartPending) {
            guard restartPending else { return }
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            restartPending = false
        }
    }

    private var columnCount: Int {
        let workspaces = session.layout.state["workspaces"].arrayValue
        let index = Int(session.layout.state["focus"].uintValue)
        return workspaces.indices.contains(index) ? workspaces[index]["columns"].arrayValue.count : 0
    }

    private func bitrate(_ megabits: Double) -> String {
        if megabits <= 0 { return "Nothing yet" }
        if megabits < 1 { return String(format: "%.0f kbit/s", megabits * 1000) }
        return String(format: "%.1f Mbit/s", megabits)
    }

    private var audioReadout: some View {
        let audio = session.media.audio.diagnostics
        let queued = audio["queuedMilliseconds"].doubleValue
        let stalled = audio["interrupted"].boolValue
        let chunks = session.diagnostics["audioChunksPerSecond"].doubleValue
        let warn = stalled || queued > 150 || (audio["queueStarvations"].uintValue > 0 && chunks == 0)
        let tone: Color? = warn ? LWFATheme.warning : nil
        let format = session.diagnostics["audioFormat"].stringValue
        return Group {
            PanelGroup {
                ReadoutRow("Playback path", value: audio["primed"].boolValue ? "Source node, \(Int(audio["ioBufferMilliseconds"].doubleValue.rounded())) ms IO" : (stalled ? "Interrupted" : "Priming"), tone: tone)
                ReadoutRow("Incoming audio", value: format.isEmpty ? "nothing yet" :
                    "\(format == "Opus" ? "Opus" : "raw PCM"), \(String(format: "%.0f kbit/s", session.diagnostics["audioMegabitsPerSecond"].doubleValue * 1000))", tone: tone)
                ReadoutRow("Playback buffer", value: String(format: "%.0f ms", queued), tone: tone)
                ReadoutRow("Output latency", value: String(format: "%.0f ms", audio["outputLatencyMilliseconds"].doubleValue))
                ReadoutRow("Chunks received", value: String(format: "%.0f /s", chunks))
                ReadoutRow("Dropouts", value: String(audio["queueStarvations"].uintValue), tone: tone)
                ReadoutRow("Skips", value: String(audio["queueOverflows"].uintValue))
                ReadoutRow("Decode errors", value: String(audio["decodeFailures"].uintValue))
            }
            if stalled {
                PanelGroup {
                    FieldRow("Audio is paused", hint: "Tap to resume after the interruption.") {
                        Button("Resume") { session.resumeAudio() }.panelButton(.primary)
                    }
                }
            } else if format == "PCM16" {
                DashedNote(text: "Uncompressed audio fallback is active.", padding: 12)
            } else if queued > 150 {
                DashedNote(text: "Playback buffer is high.", padding: 12)
            } else if format.isEmpty {
                DashedNote(text: "No audio received yet.", padding: 12)
            }
        }
    }

    private func copyDiagnostics() {
        let report = WireValue.object(["engine": .string(session.engineVersion), "stream": session.diagnostics, "audio": session.media.audio.diagnostics,
                                       "canvas": .object(["width": .uint(UInt64(session.displayOutput.width)), "height": .uint(UInt64(session.displayOutput.height))])])
        if let data = try? report.encoded() { UIPasteboard.general.string = String(data: data, encoding: .utf8) }
        copied = true
        Task { @MainActor in try? await Task.sleep(for: .milliseconds(1500)); copied = false }
    }

    private var opusLicense: String {
        guard let url = Bundle.module.url(forResource: "Opus-LICENSE", withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "libopus, BSD license. See opus-codec.org." }
        return text
    }
}
#endif
