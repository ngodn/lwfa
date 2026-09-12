#if os(iOS)
import SwiftUI
import LWFACore

/// Device preferences. Mirrors `packages/shell/src/lib/prefs.ts` field for
/// field so a setting means the same thing on the browser and on the iPad.
struct NativePreferenceState: Codable, Equatable {
    var theme = "system"
    var edge = "auto"
    /// `sm` 36pt, `md` 44pt, `lg` 52pt buttons.
    var size = "md"
    var order = NativeNavigationItem.all.map(\.id)
    var hidden: [String] = []
    var anchored: [String] = ["escape", "gamepad", "mouse", "keyboard", "clipboard", "workspaces"]
    var centred: [String] = ["apps"]
    var animate = true
    var followEngineScroll = false
    var orientation = "auto"
    var defaultWidth = 3
    var centreFocused = true
    var keyboardPlacement = "stacked"
    /// Height of a stacked input dock as a fraction of the content area.
    var dockFraction = 0.42
    var stickyModifiers = true
    var keyboardHaptics = true
    var mousePlacement = "overlay"
    var mouseHaptics = true
    var mouseButton: UInt32 = 272
    var scrollSpeed = 0.4
    var naturalScroll = false
    var mousePositions: [String: [Double]] = ["selector": [92, 50], "tools": [8, 50], "modifiers": [50, 90]]
    /// Normalised position of the immersive logo button. Right edge, 18% down.
    var immersivePosition: [Double] = [1, 0.18]

    var buttonSize: CGFloat { NativeRailMetrics.forSize(size).button }
}

/// Rail geometry per size, from `NavRail.tsx`.
struct NativeRailMetrics: Equatable {
    let button: CGFloat
    let gap: CGFloat
    let pad: CGFloat
    let icon: CGFloat
    /// Match the browser visual sizes, with a 44pt minimum native touch target.
    var hitTarget: CGFloat { max(44, button) }
    var rail: CGFloat { hitTarget + pad * 2 }
    static func forSize(_ size: String) -> Self {
        switch size {
        case "sm": Self(button: 36, gap: 4, pad: 8, icon: 16)
        case "lg": Self(button: 52, gap: 8, pad: 12, icon: 20)
        default: Self(button: 44, gap: 6, pad: 10, icon: 18)
        }
    }
}

@MainActor
@Observable
final class NativePreferences {
    var state: NativePreferenceState { didSet { save(); onChange?() } }
    @ObservationIgnored var onChange: (() -> Void)?
    init() {
        let defaults = NativePreferenceState()
        var saved: WireValue = .null
        if let data = UserDefaults.standard.data(forKey: "native.preferences"), let value = try? WireValue.decode(data) { saved = value }
        if let base = try? WireValue.decode(JSONEncoder().encode(defaults)),
           let merged = try? WireValue.object(base.objectValue.merging(saved.objectValue) { _, new in new }).encoded(),
           let decoded = try? JSONDecoder().decode(NativePreferenceState.self, from: merged) {
            state = decoded
        } else { state = defaults }
        // Earlier builds stored the button size in points.
        if case .double(let points) = saved["buttonSize"] { state.size = points <= 36 ? "sm" : points >= 52 ? "lg" : "md" }
        let ids = Set(NativeNavigationItem.all.map(\.id))
        var seen = Set<String>()
        state.order = state.order.filter { ids.contains($0) && seen.insert($0).inserted }
        state.order += NativeNavigationItem.all.map(\.id).filter { !seen.contains($0) }
        state.hidden = state.hidden.filter { ids.contains($0) }
        state.anchored = state.anchored.filter { ids.contains($0) }
        state.centred = state.centred.filter { ids.contains($0) && !state.anchored.contains($0) }
        if !["sm", "md", "lg"].contains(state.size) { state.size = "md" }
        if !["auto", "left", "right", "top", "bottom"].contains(state.edge) { state.edge = "auto" }
        if !["system", "light", "dark"].contains(state.theme) { state.theme = "system" }
        if !["auto", "horizontal", "vertical"].contains(state.orientation) { state.orientation = "auto" }
        state.defaultWidth = min(4, max(0, state.defaultWidth))
        state.dockFraction = state.dockFraction.isFinite ? min(0.75, max(0.2, state.dockFraction)) : 0.42
        state.scrollSpeed = state.scrollSpeed.isFinite ? min(1.5, max(0.1, state.scrollSpeed)) : 0.4
        if ![272, 273, 274].contains(state.mouseButton) { state.mouseButton = 272 }
        for placement in [\NativePreferenceState.keyboardPlacement, \.mousePlacement] where !["overlay", "stacked"].contains(state[keyPath: placement]) {
            state[keyPath: placement] = defaults[keyPath: placement]
        }
        for (key, fallback) in defaults.mousePositions {
            let saved = state.mousePositions[key] ?? []
            state.mousePositions[key] = saved.count == 2 && saved.allSatisfy(\.isFinite)
                ? saved.map { min(96, max(4, $0)) } : fallback
        }
        let position = state.immersivePosition
        state.immersivePosition = position.count == 2 && position.allSatisfy(\.isFinite) ? position.map { min(1, max(0, $0)) } : [1, 0.18]
    }
    func reset() { state = .init() }
    private func save() {
        if let data = try? JSONEncoder().encode(state) { UserDefaults.standard.set(data, forKey: "native.preferences") }
    }

    /// Resolve the rail edge against the current viewport (`resolveEdge`).
    func resolvedEdge(portrait: Bool) -> String {
        ["left", "right", "top", "bottom"].contains(state.edge) ? state.edge : (portrait ? "bottom" : "left")
    }
    var metrics: NativeRailMetrics { NativeRailMetrics.forSize(state.size) }
}

/// One rail entry, from `nav/registry.ts`.
struct NativeNavigationItem: Identifiable, Equatable {
    enum Kind { case panel, dock, action }
    let id: String
    let title: String
    let hint: String
    let icon: String
    var glyph: String? = nil
    var kind: Kind = .panel
    static let all: [Self] = [
        .init(id: "info", title: "Session", hint: "Connection and stream status", icon: "info.circle"),
        .init(id: "connections", title: "Connections", hint: "Saved connections", icon: "network"),
        .init(id: "access", title: "Access", hint: "Accounts and permissions", icon: "person.2"),
        .init(id: "theme", title: "Appearance", hint: "Theme and feedback", icon: "circle.lefthalf.filled"),
        .init(id: "settings", title: "Settings", hint: "Navigation and streaming", icon: "gearshape"),
        .init(id: "apps", title: "Apps", hint: "Launch apps", icon: "square.grid.3x3"),
        .init(id: "escape", title: "Escape", hint: "Send Escape", icon: "arrow.uturn.backward", glyph: "ESC", kind: .action),
        .init(id: "gamepad", title: "Gamepad", hint: "Controller and gaming settings", icon: "gamecontroller"),
        .init(id: "mouse", title: "Mouse", hint: "Show mouse controls", icon: "computermouse", kind: .dock),
        .init(id: "keyboard", title: "Keyboard", hint: "Show keyboard", icon: "keyboard", kind: .dock),
        .init(id: "clipboard", title: "Clipboard", hint: "Clipboard history", icon: "list.clipboard"),
        .init(id: "workspaces", title: "Windows", hint: "Window layout", icon: "macwindow"),
    ]
    static func item(_ id: String) -> Self? { all.first { $0.id == id } ?? NativeNavigationGroup.group(id)?.asItem }
}

/// A merged rail entry that opens a tabbed panel.
struct NativeNavigationGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let hint: String
    let icon: String
    let members: [String]
    static let all: [Self] = [
        .init(id: "input", title: "Input", hint: "Keyboard, mouse and gamepad", icon: "slider.horizontal.3", members: NavigationLayout.groupMembers["input"]!),
        .init(id: "more", title: "More", hint: "Session and settings", icon: "ellipsis", members: NavigationLayout.groupMembers["more"]!),
    ]
    static func group(_ id: String) -> Self? { all.first { $0.id == id } }
    var asItem: NativeNavigationItem { NativeNavigationItem(id: id, title: title, hint: hint, icon: icon) }
}

/// The collapse policy from `nav/registry.ts`: pick the roomiest tier that
/// fits, then un-merge groups while there is still room.
enum NativeNavigationLayout {
    typealias Slot = NavigationLayout.Slot
    typealias Zones = NavigationLayout.Zones

    static func fits(count: Int, metrics: NativeRailMetrics, available: CGFloat) -> Bool {
        guard count > 0 else { return true }
        return CGFloat(count) * metrics.hitTarget + CGFloat(count - 1) * metrics.gap + max(12, 2 * metrics.gap) <= available - 2 * metrics.pad
    }

    static func resolve(visible: [String], metrics: NativeRailMetrics, available: CGFloat) -> [Slot] {
        NavigationLayout.resolve(visible: visible) { fits(count: $0, metrics: metrics, available: available) }
    }

    static func zones(_ slots: [Slot], prefs: NativePreferenceState) -> Zones {
        NavigationLayout.zones(slots, anchored: prefs.anchored, centred: prefs.centred)
    }
}

// MARK: - Settings panel

struct NativeSettingsPanel: View {
    @Bindable var session: NativeSession
    @Bindable var prefs: NativePreferences
    @State private var tab = "navigation"
    @State private var confirmReset = false
    @State private var confirmStreamAll = false
    init(session: NativeSession) { self.session = session; prefs = session.preferences }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            SegmentedChoice(["navigation", "buttons", "stream"], selection: $tab) { Text($0 == "navigation" ? "Navigation" : $0 == "buttons" ? "Buttons" : "Stream") }
            switch tab {
            case "buttons": buttons
            case "stream": stream
            default: navigation
            }
            PanelSection("Reset") {
                PanelGroup {
                    FieldRow("Restore defaults", hint: "Resets this device only.") {
                        Button { confirmReset = true } label: { Label("Reset", systemImage: "arrow.counterclockwise") }.panelButton(.outline)
                    }
                }
            }
        }
        .gameInputSuspended(session, while: confirmReset)
        .confirmationDialog("Reset settings saved on this iPad?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset settings", role: .destructive) { prefs.reset(); session.resetStreamPreferences() }
        }
    }

    private var navigation: some View {
        Group {
            PanelSection("Position", description: "Auto follows the shape of the screen.") {
                SegmentedChoice(["auto", "left", "top", "right", "bottom"], selection: $prefs.state.edge) { edge in
                    VStack(spacing: 4) {
                        Image(systemName: ["auto": "wand.and.stars", "left": "sidebar.left", "top": "rectangle.topthird.inset.filled",
                                           "right": "sidebar.right", "bottom": "rectangle.bottomthird.inset.filled"][edge] ?? "questionmark")
                            .font(.system(size: 15))
                        Text(edge.capitalized).font(.system(size: 11))
                    }.padding(.vertical, 4)
                }
            }
            PanelSection("Button size") {
                SegmentedChoice(["sm", "md", "lg"], selection: $prefs.state.size) { Text($0 == "sm" ? "36 px" : $0 == "lg" ? "52 px" : "44 px") }
            }
        }
    }

    private var buttons: some View {
        PanelSection("Buttons") {
            PanelGroup {
                ForEach(Array(prefs.state.order.enumerated()), id: \.element) { index, id in
                    if let item = NativeNavigationItem.item(id) {
                        let hidden = prefs.state.hidden.contains(id)
                        let anchored = prefs.state.anchored.contains(id)
                        HStack(spacing: 4) {
                            Image(systemName: item.icon).font(.system(size: 15)).frame(width: 24).opacity(hidden ? 0.4 : 1)
                            Text(item.title).font(LWFATheme.label).strikethrough(hidden)
                                .foregroundStyle(hidden ? LWFATheme.mutedForeground : LWFATheme.foreground)
                            Spacer(minLength: 0)
                            IconButton(systemImage: "arrow.up", label: "Move \(item.title) earlier") { move(index, by: -1) }.disabled(index == 0)
                            IconButton(systemImage: "arrow.down", label: "Move \(item.title) later") { move(index, by: 1) }.disabled(index == prefs.state.order.count - 1)
                            IconButton(systemImage: anchored ? "arrow.down.to.line" : "arrow.up.to.line",
                                       label: anchored ? "Move \(item.title) to the near end" : "Anchor \(item.title) to the far end",
                                       tint: anchored ? LWFATheme.primary : LWFATheme.foreground.opacity(0.6)) {
                                prefs.state.anchored.removeAll { $0 == id }
                                if !anchored { prefs.state.anchored.append(id); prefs.state.centred.removeAll { $0 == id } }
                            }
                            IconButton(systemImage: hidden ? "eye.slash" : "eye", label: hidden ? "Show \(item.title)" : "Hide \(item.title)",
                                       tint: hidden ? LWFATheme.foreground.opacity(0.6) : LWFATheme.foreground) {
                                prefs.state.hidden.removeAll { $0 == id }
                                if !hidden { prefs.state.hidden.append(id) }
                            }
                        }
                        .frame(minHeight: LWFATheme.hit).padding(.horizontal, 12).padding(.vertical, 4)
                    }
                }
            }
        }
    }
    private func move(_ index: Int, by delta: Int) {
        let target = index + delta
        guard prefs.state.order.indices.contains(target) else { return }
        prefs.state.order.swapAt(index, target)
    }

    private var stream: some View {
        Group {
            PanelSection("Video", description: "Pausing video keeps the connection open.") {
                PanelGroup {
                    SwitchRow(label: "Show the desktop", hint: session.videoEnabled ? "Receiving video" : "Paused", isOn: $session.videoEnabled)
                    SwitchRow(label: "Pause inactive windows",
                              hint: session.pauseInactive ? "Only the focused window streams live" : "Every visible window streams live",
                              isOn: Binding(get: { session.pauseInactive }, set: { value in
                                  if value { session.pauseInactive = true } else { confirmStreamAll = true }
                              }))
                    if confirmStreamAll {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Streaming all visible windows uses more bandwidth and battery.").font(LWFATheme.hint)
                            HStack(spacing: 8) {
                                Button("Stream all windows") { session.pauseInactive = false; confirmStreamAll = false }.panelButton(.outline, fullWidth: true)
                                Button("Keep pausing") { confirmStreamAll = false }.panelButton(.primary, fullWidth: true)
                            }
                        }.padding(12).background(LWFATheme.warning.opacity(0.10))
                    }
                }
            }
            PanelSection("Video quality", description: "Video uses less bandwidth. JPEG keeps text sharper.") {
                let modes = NativeSession.VideoMode.allCases.filter { mode in
                    switch mode {
                    case .hevc: NativeMedia.supportedCodecs.contains(.hevc)
                    case .h264: NativeMedia.supportedCodecs.contains(.h264)
                    default: true
                    }
                }
                SegmentedChoice(modes, selection: $session.videoMode, isEnabled: session.videoEnabled) { Text($0.rawValue) }
                if NativeMedia.supportedCodecs.isEmpty {
                    DashedNote(text: "No supported video decoder detected. Using JPEG.")
                }
            }
            PanelSection("Sound") {
                PanelGroup {
                    SwitchRow(label: "Enable audio", hint: session.muted ? "Muted" : "Streaming",
                              isOn: Binding(get: { !session.muted }, set: { session.muted = !$0 }))
                    if !session.muted {
                        SwitchRow(label: "Also play on the desktop's speakers",
                                  hint: session.localPlayback ? "Plays on the host and this device" : "Plays on connected devices only",
                                  isOn: $session.localPlayback)
                        FieldRow("Volume", hint: "\(Int((session.volume * 100).rounded()))%") {
                            Slider(value: $session.volume, in: 0...1, step: 0.05).tint(LWFATheme.primary).frame(width: 150)
                        }
                        if session.audioNeedsResume {
                            FieldRow("Audio is paused", hint: "Interrupted by another app or a route change.") {
                                Button { session.resumeAudio() } label: { Label("Resume", systemImage: "speaker.wave.2") }.panelButton(.primary)
                            }
                        }
                    }
                }
                if !session.muted { DashedNote(text: "If audio is silent, check the side switch and Silent Mode.", padding: 12) }
                FieldRow("Sound quality", hint: ["auto": "Adapts to the connection", "high": "128 kbit/s", "medium": "96 kbit/s", "low": "64 kbit/s"][session.audioQuality.rawValue]) {
                    EmptyView()
                }.padding(.horizontal, -12)
                SegmentedChoice([AudioQuality.auto, .high, .medium, .low], selection: $session.audioQuality) { Text($0.rawValue.capitalized) }
            }
        }
    }
}

// MARK: - Appearance panel

struct NativeAppearancePanel: View {
    @Bindable var prefs: NativePreferences
    @Bindable var gamepad: NativeGamepadModel
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            PanelSection("Theme") {
                SegmentedChoice(["light", "dark", "system"], selection: $prefs.state.theme) { theme in
                    Label(theme.capitalized, systemImage: theme == "light" ? "sun.max" : theme == "dark" ? "moon" : "desktopcomputer")
                }
            }
            PanelSection("Motion") {
                PanelGroup {
                    SwitchRow(label: "Animate window movement", isOn: $prefs.state.animate)
                    SwitchRow(label: "Mirror the desktop's scroll", isOn: $prefs.state.followEngineScroll)
                }
            }
            PanelSection("Haptics") {
                PanelGroup {
                    SwitchRow(label: "Keyboard", isOn: $prefs.state.keyboardHaptics)
                    SwitchRow(label: "Gamepad", isOn: $gamepad.haptics)
                }
            }
        }
    }
}
#endif
