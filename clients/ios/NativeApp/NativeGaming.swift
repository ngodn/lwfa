#if os(iOS)
import SwiftUI
import Combine
import LWFACore

/// `GamingPanel.tsx`: one managed component tab inside the Gamepad panel.
@MainActor
struct NativeGamingPanel: View {
    var session: NativeSession
    var initialTab: String = "proton"
    @State private var model = GamingPanelModel()
    @State private var confirmInstall = false
    @State private var copied = false

    private var component: GamingComponentName { GamingComponentName(rawValue: initialTab) ?? .proton }
    private var busy: Bool { model.pending != nil || !session.connected }
    private var installed: Bool { model.inventory?.isInstalled(component) == true }
    private var ready: Bool { model.inventory?.isReady(component) == true }
    private var enabled: Bool { model.draft.provider.rawValue == component.rawValue }

    var body: some View {
        Group {
            if !session.isOwner {
                DashedNote(text: "Gaming components are managed by the session owner.")
            } else {
                VStack(alignment: .leading, spacing: 15) {
                    HStack {
                        Text(component.title).font(LWFATheme.title)
                        Spacer()
                        IconButton(systemImage: "arrow.clockwise", label: "Refresh gaming components") { model.request(.status, session: session) }
                            .disabled(busy)
                    }
                    if let pending = model.pending {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(pending) }.font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                    }
                    if let error = model.error {
                        Text(error).font(LWFATheme.hint).foregroundStyle(LWFATheme.destructive).accessibilityAddTraits(.updatesFrequently)
                    }
                    if let inventory = model.inventory {
                        componentStatus(inventory)
                        if component == .proton { protonDetails(inventory) }
                        else { frameGeneration(inventory) }
                    } else if !busy {
                        DashedNote(text: "Refresh to load gaming components from your computer.")
                    }
                    if let notice = model.notice { DashedNote(text: notice, padding: 12) }
                }
            }
        }
        .onAppear { refreshIfNeeded() }
        .onReceive(session.serverEvents) { type, reply in
            if type == "gaming" { model.receive(reply) }
        }
        .onChange(of: session.connected) { _, connected in
            if connected { refreshIfNeeded() } else { model.disconnected() }
        }
        .onChange(of: session.sessionID) { _, _ in
            model.disconnected()
            refreshIfNeeded()
        }
        .onChange(of: session.isOwner) { _, owner in
            if owner { refreshIfNeeded() } else { model.disconnected() }
        }
        .onChange(of: component) { _, _ in model.notice = nil; model.error = nil; refreshIfNeeded() }
        .gameInputSuspended(session, while: confirmInstall)
        .confirmationDialog("Install \(component.installName)?", isPresented: $confirmInstall, titleVisibility: .visible) {
            Button("Install on your computer") {
                model.request(.install, component: component, session: session)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(component == .proton
                 ? "Downloads GE-Proton and the lwfa Canvas patch to your computer. Running games are not restarted."
                 : "Downloads this component to your computer. Saved profiles apply when you next launch a game.")
        }
    }

    private func refreshIfNeeded() {
        guard session.connected, session.isOwner, model.inventory == nil, model.pending == nil else { return }
        model.request(.status, session: session)
    }

    private func componentStatus(_ inventory: GamingInventory) -> some View {
        PanelGroup {
            FieldRow(component == .proton ? component.installName : "\(component.installName) \(inventory.version(component))",
                     hint: installed ? "Installed" : "Not installed") {
                if !installed {
                    Button { confirmInstall = true } label: { Label("Install", systemImage: "arrow.down.circle") }
                        .panelButton(.outline).disabled(busy)
                }
            }
        }
    }

    private func protonDetails(_ inventory: GamingInventory) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Includes the original GE runtime and lwfa's window sizing fixes. Host games use the original runtime. The base download is about 509 MiB.")
                .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
            if !inventory.proton.tools.isEmpty {
                PanelGroup {
                    ForEach(inventory.proton.tools) { tool in
                        FieldRow(tool.name, hint: (tool.selfContained == true ? "Self-contained" : "Uses a separate GE installation") + (tool.activePids.isEmpty ? "" : " · In use")) {
                            if !tool.activePids.isEmpty { Image(systemName: "play.circle").foregroundStyle(LWFATheme.primary) }
                        }
                    }
                }
            }
            Text("After installation, restart Steam when your games are closed. Choose the lwfa Canvas tool in the game's Properties → Compatibility.")
                .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
        }
    }

    private func frameGeneration(_ inventory: GamingInventory) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if component == .lsfg {
                Text("Requires your purchased Lossless Scaling. Interpolates game images to make motion smoother. For a 60 FPS stream, start with a stable 30 FPS game limit and 2× generation.")
                    .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                if inventory.lsfg.dll_compatible != true {
                    DashedNote(text: inventory.lsfg.error ?? "Install Lossless Scaling through Steam to provide its required DLL.", padding: 12)
                }
            } else {
                Text("Experimental, for compatible games with frame-generation hooks. Uses an isolated game-file overlay and preserves native NVIDIA upscaling. Support varies by game and Steam Input setup.")
                    .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                if inventory.framegen.overlaySupported != true {
                    DashedNote(text: inventory.framegen.error ?? "This host needs Bubblewrap with overlay support.", padding: 12)
                }
            }
            PanelSection("Game") {
                if inventory.games.isEmpty {
                    DashedNote(text: "No installed Steam games", padding: 12)
                } else {
                    PanelGroup {
                        FieldRow("Steam game") {
                            Picker("Game", selection: Binding(get: { model.appid }, set: { model.selectGame($0) })) {
                                ForEach(inventory.games) { game in Text(game.name).tag(game.appid) }
                            }
                            .labelsHidden().tint(LWFATheme.foreground).disabled(busy)
                        }
                        SwitchRow(label: "Use \(component.shortName)",
                                  hint: model.draft.provider == .off || enabled ? "One frame generation provider per game."
                                    : "Currently set to \(model.draft.provider == .lsfg ? "LSFG" : "Framegen").",
                                  isOn: Binding(get: { enabled }, set: { model.selectProvider(component, enabled: $0) }))
                            .disabled(busy || (!enabled && !ready))
                        if enabled {
                            if component == .lsfg { lsfgSettings } else { framegenSettings }
                        }
                    }
                    Button("Save for next launch") { model.request(.saveProfile, session: session) }
                        .panelButton(.primary, fullWidth: true)
                        .disabled(busy || (enabled && !ready) || model.appid.isEmpty)
                    if let saved = inventory.profiles[model.appid] {
                        Text("Saved: \(saved.provider.description). Applies on the next launch.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                    }
                    Text("Close and relaunch the game to apply changes. Turn off other frame-generation layers first; keep native upscaling if supported.")
                        .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                }
            }
            if !inventory.games.isEmpty {
                PanelSection("Steam launch option", description: "Add this once in the game's Properties → General. The wrapper applies its profile only inside lwfa. Host launches pass through unchanged.") {
                    Text(inventory.launchOption).font(LWFATheme.mono).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        .background(LWFATheme.muted, in: RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous))
                    Button {
                        UIPasteboard.general.string = inventory.launchOption
                        copied = true
                        Task { @MainActor in try? await Task.sleep(for: .milliseconds(1500)); copied = false }
                    } label: { Label(copied ? "Copied" : "Copy launch option", systemImage: "doc.on.doc") }
                    .panelButton(.outline, fullWidth: true)
                }
            }
        }
    }

    private var lsfgSettings: some View {
        Group {
            FieldRow("Multiplier") {
                SegmentedChoice([2, 3, 4], selection: Binding(get: { model.lsfg.multiplier }, set: { value in model.changeLSFG { $0.multiplier = value } })) { Text("\($0)×") }
                    .frame(width: 180)
            }
            FieldRow("Motion detail") {
                Picker("Motion detail", selection: Binding(get: { model.lsfg.flow_scale }, set: { value in model.changeLSFG { $0.flow_scale = value } })) {
                    Text("Full").tag(1.0)
                    Text("Balanced").tag(0.75)
                    Text("Reduced GPU load").tag(0.5)
                    Text("Lowest GPU load").tag(0.25)
                    if ![1.0, 0.75, 0.5, 0.25].contains(model.lsfg.flow_scale) {
                        Text("Custom (\(Int(model.lsfg.flow_scale * 100))%)").tag(model.lsfg.flow_scale)
                    }
                }.labelsHidden().tint(LWFATheme.foreground)
            }
            SwitchRow(label: "Performance mode", hint: "Reduces processing cost and image detail.",
                      isOn: Binding(get: { model.lsfg.performance_mode }, set: { value in model.changeLSFG { $0.performance_mode = value } }))
        }
        .disabled(busy)
    }

    private var framegenSettings: some View {
        Group {
            FieldRow("Game integration") {
                Picker("Game integration", selection: Binding(get: { model.framegen.input }, set: { model.setIntegration($0) })) {
                    Text("DLSS frame generation").tag("dlssg")
                    Text("FSR 3.1 frame generation").tag("fsrfg")
                    Text("FSR 3.0 frame generation").tag("fsrfg30")
                    Text("Upscaler integration").tag("upscaler")
                    Text("DLSSG-to-FSR3").tag("nukems")
                }.labelsHidden().tint(LWFATheme.foreground)
            }
            FieldRow("Frame generation backend") {
                Picker("Frame generation backend", selection: Binding(get: { model.framegen.output }, set: { model.setBackend($0) })) {
                    if model.framegen.input == "nukems" { Text("DLSSG-to-FSR3").tag("nukems") }
                    else { Text("FSR").tag("fsrfg"); Text("XeSS").tag("xefg") }
                }.labelsHidden().tint(LWFATheme.foreground)
                .disabled(model.framegen.input == "nukems")
            }
        }
        .disabled(busy)
    }
}

private enum GamingComponentName: String { case proton, lsfg, framegen
    var title: String { "lwfa \(shortName)" }
    var shortName: String { switch self { case .proton: "Proton"; case .lsfg: "LSFG"; case .framegen: "Framegen" } }
    var installName: String { switch self { case .proton: "GE-Proton + Canvas"; case .lsfg: "lsfg-vk"; case .framegen: "OptiScaler" } }
}
private enum GamingAction: String { case status, install, saveProfile }
private enum GamingProvider: String, Codable { case off, lsfg, framegen
    var description: String { switch self { case .off: "lwfa frame generation off"; case .lsfg: "LSFG"; case .framegen: "Framegen" } }
}
private struct LSFGProfile: Codable { var multiplier = 2; var flow_scale = 1.0; var performance_mode = false }
private struct FramegenProfile: Codable { var input = "dlssg"; var output = "fsrfg" }
private struct GameProfile: Codable {
    var provider: GamingProvider = .off
    var lsfg: LSFGProfile?
    var framegen: FramegenProfile?
}
private struct GamingInventory: Decodable {
    struct Game: Decodable, Identifiable { let appid: String; let name: String; let directory: String; var id: String { appid } }
    struct Tool: Decodable, Identifiable { let path: String; let name: String; let selfContained: Bool?; let activePids: [UInt64]; var id: String { path } }
    struct Proton: Decodable { let tools: [Tool] }
    struct Component: Decodable {
        let installed: Bool
        let version: String
        let error: String?
        let dll_compatible: Bool?
        let overlaySupported: Bool?
    }
    let games: [Game]
    let profiles: [String: GameProfile]
    let proton: Proton
    let lsfg: Component
    let framegen: Component
    let launchOption: String
    let streamTargetFps: Double
    func isInstalled(_ component: GamingComponentName) -> Bool {
        switch component { case .proton: proton.tools.contains { $0.selfContained == true }; case .lsfg: lsfg.installed; case .framegen: framegen.installed }
    }
    func isReady(_ component: GamingComponentName) -> Bool {
        isInstalled(component) && (component == .proton || (component == .lsfg ? lsfg.dll_compatible == true : framegen.overlaySupported == true))
    }
    func version(_ component: GamingComponentName) -> String { component == .lsfg ? lsfg.version : framegen.version }
}

@MainActor
@Observable
private final class GamingPanelModel {
    var inventory: GamingInventory?
    var appid = ""
    var draft = GameProfile()
    var pending: String?
    var error: String?
    var notice: String?
    @ObservationIgnored private var requestID: UInt64?
    @ObservationIgnored private var operation: GamingAction?
    @ObservationIgnored private var timeout: Task<Void, Never>?
    var lsfg: LSFGProfile { draft.lsfg ?? LSFGProfile() }
    var framegen: FramegenProfile { draft.framegen ?? FramegenProfile() }

    func selectGame(_ id: String) {
        guard inventory?.games.contains(where: { $0.appid == id }) == true else { return }
        appid = id
        draft = inventory?.profiles[id] ?? GameProfile()
        notice = nil
    }
    func selectProvider(_ component: GamingComponentName, enabled: Bool) {
        guard component != .proton else { return }
        draft.provider = enabled ? (component == .lsfg ? .lsfg : .framegen) : .off
        if component == .lsfg { draft.lsfg = lsfg } else { draft.framegen = framegen }
    }
    func changeLSFG(_ change: (inout LSFGProfile) -> Void) {
        var next = lsfg; change(&next); draft.lsfg = next
    }
    func setIntegration(_ input: String) {
        guard ["dlssg", "fsrfg", "fsrfg30", "upscaler", "nukems"].contains(input) else { return }
        var next = framegen
        next.input = input
        next.output = input == "nukems" ? "nukems" : (next.output == "nukems" ? "fsrfg" : next.output)
        draft.framegen = next
    }
    func setBackend(_ output: String) {
        guard framegen.input != "nukems", ["fsrfg", "xefg"].contains(output) else { return }
        var next = framegen; next.output = output; draft.framegen = next
    }

    func request(_ action: GamingAction, component: GamingComponentName? = nil, session: NativeSession) {
        guard requestID == nil, session.connected, session.isOwner else { return }
        guard action != .saveProfile || (!appid.isEmpty && inventory?.games.contains(where: { $0.appid == appid }) == true) else { return }
        guard action != .install || component != nil else { return }
        let id = session.nextRequestID()
        do {
            let profile = action == .saveProfile ? try WireValue.decode(JSONEncoder().encode(draft)) : .null
            requestID = id; operation = action; error = nil; notice = nil
            pending = action == .install ? "Installing \(component?.shortName ?? "component")…" : action == .saveProfile ? "Saving profile…" : "Loading…"
            timeout?.cancel()
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(action == .install ? 1810 : 35)) } catch { return }
                guard let self, self.requestID == id else { return }
                self.requestID = nil; self.operation = nil; self.pending = nil
                self.error = "No response from the engine. Refresh to check whether the operation completed."
            }
            session.sendMessage("gaming", ["request": .uint(id), "action": .string(action.rawValue),
                                           "component": component.map { .string($0.rawValue) } ?? .null,
                                           "appid": action == .saveProfile ? .string(appid) : .null, "profile": profile])
        } catch { self.error = "Could not encode this gaming profile." }
    }

    func receive(_ reply: WireValue) {
        guard let requestID, reply["request"].uintValue == requestID else { return }
        let action = operation
        timeout?.cancel(); timeout = nil; self.requestID = nil; operation = nil; pending = nil
        if !reply["error"].stringValue.isEmpty { error = reply["error"].stringValue; return }
        do {
            let decoded = try JSONDecoder().decode(GamingInventory.self, from: reply["data"].encoded())
            // Reject unsupported profile values before they reach Picker selections.
            for profile in decoded.profiles.values {
                if let lsfg = profile.lsfg {
                    guard [2, 3, 4].contains(lsfg.multiplier), lsfg.flow_scale.isFinite, (0.25...1).contains(lsfg.flow_scale) else { throw InvalidInventory() }
                }
                if let fg = profile.framegen {
                    guard ["dlssg", "fsrfg", "fsrfg30", "upscaler", "nukems"].contains(fg.input),
                          ["fsrfg", "xefg", "nukems"].contains(fg.output),
                          (fg.input == "nukems") == (fg.output == "nukems") else { throw InvalidInventory() }
                }
            }
            inventory = decoded
            selectGame(decoded.games.contains(where: { $0.appid == appid }) ? appid : (decoded.games.first?.appid ?? ""))
            if decoded.games.isEmpty { appid = ""; draft = GameProfile() }
            error = nil
            if action == .saveProfile { notice = "Profile saved for the next launch." }
            else if action == .install { notice = "Installation completed. Refresh Steam when your games are closed." }
        } catch { self.error = "The engine returned an invalid gaming inventory. Refresh to try again." }
    }

    func disconnected() {
        timeout?.cancel(); timeout = nil; requestID = nil; operation = nil
        inventory = nil; pending = nil; appid = ""; draft = GameProfile(); notice = nil; error = nil
    }
    private struct InvalidInventory: Error {}
    deinit { timeout?.cancel() }
}
#endif
