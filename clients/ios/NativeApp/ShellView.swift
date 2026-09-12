#if os(iOS)
import SwiftUI
import LWFACore

/// The workspace frame from `ShellChrome.tsx`: the rail on one edge, the
/// desktop and input docks filling the rest, the panel sheet beside the rail,
/// and the immersive controls floating over everything.
struct ShellView: View {
    @Bindable var session: NativeSession
    @Bindable var prefs: NativePreferences
    @Bindable var gamepad: NativeGamepadModel
    @Binding var panel: String?
    @State private var tab = ""
    @State private var revealed = false
    @State private var dragFraction: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(session: NativeSession, panel: Binding<String?>) {
        self.session = session; prefs = session.preferences; gamepad = session.gamepad; _panel = panel
    }

    private var openSlot: NativeNavigationLayout.Slot? {
        guard let panel else { return nil }
        if let group = NativeNavigationGroup.group(panel) {
            let members = group.members.filter { !prefs.state.hidden.contains($0) && ($0 != "access" || session.isOwner) }
            return NativeNavigationLayout.Slot(id: panel, members: members)
        }
        return NativeNavigationLayout.Slot(id: panel, members: [panel])
    }

    var body: some View {
        GeometryReader { full in
            let portrait = full.size.height > full.size.width
            let edge = prefs.resolvedEdge(portrait: portrait)
            let vertical = edge == "left" || edge == "right"
            let metrics = prefs.metrics
            let railStrip = metrics.rail
            let showsRail = !session.immersive || revealed
            let layout = vertical ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
            layout {
                if !session.immersive && (edge == "left" || edge == "top") { railSpacer(vertical: vertical, strip: railStrip) }
                mainArea
                if !session.immersive && (edge == "right" || edge == "bottom") { railSpacer(vertical: vertical, strip: railStrip) }
            }
            .frame(width: full.size.width, height: full.size.height)
            .background(LWFATheme.backdrop.ignoresSafeArea())
            // Chrome animations must not reach the canvas or its Metal layers.
            // Window placement keeps its own explicitly scoped animations.
            .transaction { $0.animation = nil }
            .overlay {
                ZStack {
                    if panel != nil {
                        LWFATheme.background.opacity(0.45).ignoresSafeArea()
                            .allowsHitTesting(false)
                            .transition(.opacity)
                    }
                }
                .animation(panelAnimation, value: panel != nil)
                .allowsHitTesting(false)
            }
            .overlay {
                // Keep the drawer's viewport mounted at a fixed size. Only the
                // panel moves inside it; panel content cannot size the workspace.
                ZStack(alignment: railAlignment(edge)) {
                    if let slot = openSlot {
                        PanelHost(slot: slot, tab: $tab, edge: edge, onClose: closePanel) { id in
                            panelContent(id)
                        }
                        .frame(width: vertical ? min(LWFATheme.panelWidth, max(0, full.size.width - railStrip)) : full.size.width,
                               height: vertical ? full.size.height : min(LWFATheme.panelHeight, max(0, full.size.height - railStrip)))
                        .transaction { $0.animation = nil }
                        .transition(.move(edge: moveEdge(edge)).combined(with: .opacity))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: railAlignment(edge))
                .clipped()
                .padding(edgeSet(edge), railStrip)
                .animation(panelAnimation, value: panel != nil)
            }
            .overlay {
                ZStack(alignment: railAlignment(edge)) {
                    if showsRail {
                        NavRail(session: session, prefs: prefs, edge: edge, active: panel, tone: session.statusTone,
                                available: vertical ? full.size.height : full.size.width) { slot in
                            select(slot)
                        }
                        .transaction { $0.animation = nil }
                        .transition(.move(edge: moveEdge(edge)).combined(with: .opacity))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: railAlignment(edge))
                .animation(reduceMotion ? nil : LWFATheme.quick, value: showsRail)
            }
            .overlay {
                if session.immersive {
                    ImmersiveControls(prefs: prefs, revealed: $revealed, exit: { session.immersive = false })
                }
            }
        }
        .statusBarHidden(session.immersive)
        .persistentSystemOverlays(session.immersive ? .hidden : .automatic)
        .onChange(of: session.immersive) { _, value in revealed = false; if value { panel = nil } }
        // Hiding the navigation in immersive mode closes whatever panel it opened.
        .onChange(of: revealed) { _, value in if !value && session.immersive { panel = nil } }
        .onChange(of: session.arranging) { _, value in if value { panel = nil } }
        .onChange(of: session.showsWorkspace) { _, value in if !value { panel = nil } }
    }

    private func railSpacer(vertical: Bool, strip: CGFloat) -> some View {
        Color.clear.frame(width: vertical ? strip : nil, height: vertical ? nil : strip)
    }
    private func railAlignment(_ edge: String) -> Alignment {
        switch edge { case "left": .leading; case "right": .trailing; case "top": .top; default: .bottom }
    }
    private func moveEdge(_ edge: String) -> Edge {
        switch edge { case "left": .leading; case "right": .trailing; case "top": .top; default: .bottom }
    }

    private func closePanel() { setPanel(nil) }
    private var panelAnimation: Animation? {
        reduceMotion ? nil : (panel == nil ? LWFATheme.panelClose : LWFATheme.panelOpen)
    }
    private func setPanel(_ next: String?) { panel = next }
    private func edgeSet(_ edge: String) -> Edge.Set {
        switch edge { case "left": .leading; case "right": .trailing; case "top": .top; default: .bottom }
    }

    private func select(_ slot: NativeNavigationLayout.Slot) {
        if slot.isGroup {
            if panel == slot.id { setPanel(nil) } else { tab = slot.members.first ?? ""; setPanel(slot.id) }
            return
        }
        switch slot.id {
        case "escape":
            session.tapKey(1)
            if prefs.state.keyboardHaptics { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        case "keyboard", "mouse":
            session.dock = session.dock == slot.id ? "none" : slot.id
        default:
            setPanel(panel == slot.id ? nil : slot.id)
        }
    }

    // MARK: Main area

    private var mainArea: some View {
        GeometryReader { area in
            let dockHeight = (dragFraction ?? prefs.state.dockFraction) * area.size.height
            VStack(spacing: 0) {
                GeometryReader { geometry in
                    ZStack(alignment: .bottom) {
                        NativeDesktop(session: session)
                            .simultaneousGesture(panel == nil ? nil : TapGesture().onEnded { closePanel() })
                        if !session.arranging && session.dock == "keyboard" && prefs.state.keyboardPlacement == "overlay" {
                            NativeKeyboardSurface(session: session) { setPanel("keyboard") }
                                .frame(height: min(dockHeight, geometry.size.height * 0.8))
                        }
                        if !session.arranging && session.dock == "mouse" && prefs.state.mousePlacement == "overlay" {
                            NativeMouseSurface(session: session) { setPanel("mouse") }
                        }
                        if !session.arranging && gamepad.visible && gamepad.placement == "overlay" {
                            NativeGamepadOverlay(session: session) { setPanel("gamepad") }
                        }
                        if session.reconnecting { reconnecting }
                        if session.audioNeedsResume && !session.reconnecting {
                            Button { session.resumeAudio() } label: { Label("Resume audio", systemImage: "speaker.wave.2") }
                                .buttonStyle(.glassProminent).tint(LWFATheme.primary)
                                .padding(16)
                                // Top-leading: the gamepad and mouse toolbars own the top-trailing corner.
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        }
                    }
                    .onAppear { session.resize(geometry.size) }
                    .onChange(of: geometry.size) { _, size in session.resize(size) }
                }
                if stackedDockVisible {
                    stackedDock(height: dockHeight, area: area.size.height)
                }
            }
        }
    }

    private var stackedDockVisible: Bool {
        (session.dock == "keyboard" && prefs.state.keyboardPlacement == "stacked")
            || (session.dock == "mouse" && prefs.state.mousePlacement == "stacked")
            || (gamepad.visible && gamepad.placement == "stacked")
    }

    /// `InputDock`: a resizable row under the desktop with a grip handle.
    private func stackedDock(height: CGFloat, area: CGFloat) -> some View {
        VStack(spacing: 0) {
            Rectangle().fill(LWFATheme.border).frame(height: 1)
            Image(systemName: "line.3.horizontal").font(.system(size: 13, weight: .medium))
                .foregroundStyle(LWFATheme.mutedForeground)
                .frame(maxWidth: .infinity).frame(height: 18)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 2)
                    .onChanged { value in
                        dragFraction = min(0.75, max(0.2, prefs.state.dockFraction - value.translation.height / max(1, area)))
                    }
                    .onEnded { _ in if let dragFraction { prefs.state.dockFraction = dragFraction }; dragFraction = nil })
                .accessibilityLabel("Resize input controls")
            Group {
                if session.dock == "keyboard" && prefs.state.keyboardPlacement == "stacked" {
                    NativeKeyboardSurface(session: session) { setPanel("keyboard") }
                } else if session.dock == "mouse" && prefs.state.mousePlacement == "stacked" {
                    NativeMouseSurface(session: session) { setPanel("mouse") }
                } else if gamepad.visible && gamepad.placement == "stacked" {
                    NativeGamepadOverlay(session: session) { setPanel("gamepad") }
                }
            }
            .frame(height: max(80, height - 19))
        }
        .background(LWFATheme.card.opacity(0.95))
        .background(.ultraThinMaterial)
    }

    private var reconnecting: some View {
        VStack(spacing: 12) {
            ProgressView().tint(LWFATheme.primary)
            Text("Reconnecting").font(LWFATheme.label)
            Text(session.connectionIssue ?? "The connection dropped. Trying again.").font(LWFATheme.hint)
                .foregroundStyle(LWFATheme.mutedForeground).multilineTextAlignment(.center)
            Button("Cancel", role: .cancel) { session.disconnect() }.panelButton(.outline)
        }
        .padding(20).frame(maxWidth: 380)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Panels

    @ViewBuilder private func panelContent(_ id: String) -> some View {
        switch id {
        case "info": NativeSessionPanel(session: session, openSettings: { setPanel("settings") })
        case "connections": NativeSessionsPanel(session: session)
        case "access": NativeAccessPanel(session: session)
        case "theme": NativeAppearancePanel(prefs: prefs, gamepad: gamepad)
        case "settings": NativeSettingsPanel(session: session)
        case "apps": NativeAppsPanel(session: session)
        case "gamepad": NativeGamepadPanel(session: session)
        case "mouse": NativeMousePanel(session: session)
        case "keyboard": NativeKeyboardPanel(session: session)
        case "clipboard": NativeClipboardPanel(session: session)
        case "workspaces": NativeWindowsPanel(session: session)
        default: EmptyView()
        }
    }
}

// MARK: - Immersive mode

/// The draggable logo button and exit affordance from `ImmersiveMode.tsx`.
struct ImmersiveControls: View {
    @Bindable var prefs: NativePreferences
    @Binding var revealed: Bool
    var exit: () -> Void
    @State private var dragOrigin: CGPoint?
    @State private var dragging = false

    var body: some View {
        GeometryReader { area in
            let inset = CGFloat(12)
            let bounds = CGRect(x: inset, y: inset, width: max(1, area.size.width - inset * 2 - 48), height: max(1, area.size.height - inset * 2 - 48))
            let stored = prefs.state.immersivePosition
            let position = CGPoint(x: bounds.minX + CGFloat(stored[0]) * bounds.width + 24,
                                   y: bounds.minY + CGFloat(stored[1]) * bounds.height + 24)
            // No clear fill here: `Color.clear` is hit-testable and would swallow every
            // touch on the desktop while immersive. Only the button and the exit
            // control take input; the rest passes through.
            ZStack(alignment: .topLeading) {
                Button { revealed.toggle() } label: {
                    LWFAMark(size: 28, forceDark: true)
                        .frame(width: 48, height: 48)
                        .background(LWFATheme.backdrop.opacity(0.65), in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.12)))
                        .shadow(color: .black.opacity(0.18), radius: 5, y: 2)
                }
                .buttonStyle(.plain)
                .opacity(revealed || dragging ? 1 : 0.45)
                .hoverEffect(.lift)
                .accessibilityLabel(revealed ? "Hide navigation" : "Show navigation")
                .accessibilityHint("Tap to toggle navigation. Drag to move.")
                .highPriorityGesture(DragGesture(minimumDistance: 6)
                    .onChanged { value in
                        if dragOrigin == nil { dragOrigin = position }
                        dragging = true
                        guard let dragOrigin else { return }
                        let next = CGPoint(x: dragOrigin.x + value.translation.width, y: dragOrigin.y + value.translation.height)
                        prefs.state.immersivePosition = [
                            Double(min(1, max(0, (next.x - 24 - bounds.minX) / bounds.width))),
                            Double(min(1, max(0, (next.y - 24 - bounds.minY) / bounds.height))),
                        ]
                    }
                    .onEnded { _ in dragOrigin = nil; dragging = false })
                .position(position)
                if revealed {
                    Button(action: exit) { Label("Exit immersive mode", systemImage: "rectangle.portrait.and.arrow.right") }
                        .buttonStyle(.glass)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(12)
                }
            }
            .frame(width: area.size.width, height: area.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea(.keyboard)
    }
}

extension NativeSession {
    /// One table drives the rail light and the Session panel (`lib/status.ts`).
    var statusTone: StatusTone {
        if connected { return .good }
        if connecting || reconnecting { return .busy }
        return connectionIssue == nil ? .busy : .bad
    }
    var statusLabel: String {
        if connected { return "Connected" }
        if connecting { return "Connecting" }
        if reconnecting { return "Reconnecting" }
        return connectionIssue == nil ? "Disconnected" : "No answer"
    }
    var statusHint: String {
        if connected { return "The desktop is live." }
        if connecting { return "Opening a connection to the engine." }
        if reconnecting { return "The connection dropped. Trying again." }
        return connectionIssue ?? "Not connected."
    }
}
#endif
