#if os(iOS)
import SwiftUI
import UIKit
import LWFACore

// MARK: - Keyboard panel

struct NativeKeyboardPanel: View {
    @Bindable var session: NativeSession
    @Bindable var prefs: NativePreferences
    init(session: NativeSession) { self.session = session; prefs = session.preferences }
    private var shown: Bool { session.dock == "keyboard" }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            PanelGroup {
                FieldRow("Show the keyboard") {
                    Button { session.dock = shown ? "none" : "keyboard" } label: {
                        Label(shown ? "Hide" : "Show", systemImage: "keyboard")
                    }.panelButton(shown ? .secondary : .outline)
                }
            }
            PanelSection("Keys") {
                PanelGroup {
                    SwitchRow(label: "Show the Escape button", hint: "A one-tap Escape button in the navigation bar.",
                              isOn: Binding(get: { !prefs.state.hidden.contains("escape") }, set: {
                                  prefs.state.hidden.removeAll { $0 == "escape" }; if !$0 { prefs.state.hidden.append("escape") }
                              }))
                    SwitchRow(label: "Start in combo mode", hint: "Holds modifiers until you tap them again.", isOn: $prefs.state.stickyModifiers)
                }
            }
            PanelSection("Placement", description: "Stacked reduces the desktop to make room for the keyboard.") {
                PlacementChoice(placement: $prefs.state.keyboardPlacement)
            }
            PanelSection("Haptics") {
                PanelGroup { SwitchRow(label: "Vibrate on press", isOn: $prefs.state.keyboardHaptics) }
            }
        }
    }
}

/// `placement.tsx`: overlay floats over the desktop, stacked takes its own row.
struct PlacementChoice: View {
    @Binding var placement: String
    var body: some View {
        SegmentedChoice(["overlay", "stacked"], selection: $placement) { value in
            VStack(spacing: 2) {
                Image(systemName: value == "overlay" ? "square.stack.3d.up" : "rectangle.bottomthird.inset.filled").font(.system(size: 15))
                Text(value == "overlay" ? "Overlay" : "Stacked").font(.system(size: 12))
                Text(value == "overlay" ? "Floats on top" : "Takes its own space").font(LWFATheme.tiny).opacity(0.7)
            }.padding(.vertical, 4)
        }
    }
}

// MARK: - Keyboard surface

/// Keys are evdev keycodes, not characters: the remote machine owns the
/// keymap. Legends are US-layout labels only (`keyboard/layout.ts`).
private struct KeyboardKey: Identifiable {
    let legend: String
    let code: UInt32
    var shifted: String? = nil
    var width: CGFloat = 1
    var id: UInt32 { code }
    var modifier: Bool { [29, 42, 56, 125, 54, 97, 100, 126].contains(code) }
    var isEnter: Bool { code == 28 }

    static let functionRow: [Self] = zip(["Esc", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"],
                                         [1, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88]).map { .init(legend: $0, code: UInt32($1)) }
    static let mainRows: [[Self]] = [
        [.init(legend: "`", code: 41, shifted: "~"), .init(legend: "1", code: 2, shifted: "!"), .init(legend: "2", code: 3, shifted: "@"),
         .init(legend: "3", code: 4, shifted: "#"), .init(legend: "4", code: 5, shifted: "$"), .init(legend: "5", code: 6, shifted: "%"),
         .init(legend: "6", code: 7, shifted: "^"), .init(legend: "7", code: 8, shifted: "&"), .init(legend: "8", code: 9, shifted: "*"),
         .init(legend: "9", code: 10, shifted: "("), .init(legend: "0", code: 11, shifted: ")"), .init(legend: "-", code: 12, shifted: "_"),
         .init(legend: "=", code: 13, shifted: "+"), .init(legend: "Bksp", code: 14, width: 2)],
        [.init(legend: "Tab", code: 15, width: 1.5), .init(legend: "q", code: 16), .init(legend: "w", code: 17), .init(legend: "e", code: 18),
         .init(legend: "r", code: 19), .init(legend: "t", code: 20), .init(legend: "y", code: 21), .init(legend: "u", code: 22),
         .init(legend: "i", code: 23), .init(legend: "o", code: 24), .init(legend: "p", code: 25), .init(legend: "[", code: 26, shifted: "{"),
         .init(legend: "]", code: 27, shifted: "}"), .init(legend: "\\", code: 43, shifted: "|", width: 1.5)],
        [.init(legend: "Caps", code: 58, width: 1.75), .init(legend: "a", code: 30), .init(legend: "s", code: 31), .init(legend: "d", code: 32),
         .init(legend: "f", code: 33), .init(legend: "g", code: 34), .init(legend: "h", code: 35), .init(legend: "j", code: 36),
         .init(legend: "k", code: 37), .init(legend: "l", code: 38), .init(legend: ";", code: 39, shifted: ":"), .init(legend: "'", code: 40, shifted: "\""),
         .init(legend: "Enter", code: 28, width: 2.25)],
        [.init(legend: "Shift", code: 42, width: 2.25), .init(legend: "z", code: 44), .init(legend: "x", code: 45), .init(legend: "c", code: 46),
         .init(legend: "v", code: 47), .init(legend: "b", code: 48), .init(legend: "n", code: 49), .init(legend: "m", code: 50),
         .init(legend: ",", code: 51, shifted: "<"), .init(legend: ".", code: 52, shifted: ">"), .init(legend: "/", code: 53, shifted: "?"),
         .init(legend: "↑", code: 103), .init(legend: "Del", code: 111)],
        [.init(legend: "Ctrl", code: 29, width: 1.5), .init(legend: "Super", code: 125, width: 1.5), .init(legend: "Alt", code: 56, width: 1.5),
         .init(legend: "Space", code: 57, width: 6), .init(legend: "←", code: 105), .init(legend: "↓", code: 108), .init(legend: "→", code: 106)],
    ]
    static let extraKeys: [Self] = zip(["Ins", "Home", "PgUp", "End", "PgDn", "PrtSc", "ScrLk", "Pause", "Menu", "NumLk"],
                                       [110, 102, 104, 107, 109, 99, 70, 119, 127, 69]).map { .init(legend: $0, code: UInt32($1)) }
}

/// Chords from `COMBOS`, in the browser's order.
private struct KeyboardCombo: Identifiable {
    let label: String
    let hint: String
    let modifiers: [UInt32]
    let key: UInt32
    var id: String { label }
    static let all: [Self] = [
        .init(label: "Ctrl C", hint: "Copy, or interrupt", modifiers: [29], key: 46), .init(label: "Ctrl V", hint: "Paste", modifiers: [29], key: 47),
        .init(label: "Ctrl X", hint: "Cut", modifiers: [29], key: 45), .init(label: "Ctrl Z", hint: "Undo", modifiers: [29], key: 44),
        .init(label: "Ctrl A", hint: "Select all", modifiers: [29], key: 30), .init(label: "Ctrl S", hint: "Save", modifiers: [29], key: 31),
        .init(label: "Ctrl W", hint: "Close", modifiers: [29], key: 17), .init(label: "Ctrl D", hint: "End of input", modifiers: [29], key: 32),
        .init(label: "Ctrl L", hint: "Clear", modifiers: [29], key: 38), .init(label: "Ctrl R", hint: "Reverse search", modifiers: [29], key: 19),
        .init(label: "Alt Tab", hint: "Switch window", modifiers: [56], key: 15), .init(label: "Alt F4", hint: "Quit", modifiers: [56], key: 62),
        .init(label: "Ctrl Alt Del", hint: "", modifiers: [29, 56], key: 111), .init(label: "Ctrl Alt T", hint: "Terminal", modifiers: [29, 56], key: 20),
    ]
}

/// `keyboard/Keyboard.tsx`.
struct NativeKeyboardSurface: View {
    var session: NativeSession
    @Bindable var prefs: NativePreferences
    var openSettings: () -> Void
    @State private var combo = true
    @State private var moreKeys = false
    @State private var keyboard = KeyboardHoldState()
    private var latched: [UInt32] { keyboard.latched }
    private var held: Set<UInt32> { keyboard.held }
    private let modifierNames: [UInt32: String] = [29: "Ctrl", 56: "Alt", 42: "Shift", 125: "Super"]
    init(session: NativeSession, openSettings: @escaping () -> Void) {
        self.session = session; prefs = session.preferences; self.openSettings = openSettings
    }

    var body: some View {
        VStack(spacing: 6) {
            toolbar
            GeometryReader { geometry in
                let rows: [[KeyboardKey]] = [KeyboardKey.functionRow] + KeyboardKey.mainRows + (moreKeys ? [KeyboardKey.extraKeys] : [])
                let rowHeight = (geometry.size.height - CGFloat(rows.count - 1) * 4) / CGFloat(rows.count)
                VStack(spacing: 4) {
                    ForEach(rows.indices, id: \.self) { index in
                        keyRow(rows[index], width: geometry.size.width, height: rowHeight)
                    }
                }
            }
        }
        .padding(8)
        .background(LWFATheme.card.opacity(0.85))
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Rectangle().fill(LWFATheme.border).frame(height: 1) }
        .onAppear { combo = prefs.state.stickyModifiers }
        .onChange(of: combo) { _, _ in release() }
        .onChange(of: session.acceptsInput) { _, enabled in if !enabled { release() } }
        .onChange(of: session.inputGeneration) { _, _ in release() }
        .onDisappear { release() }
    }

    private var toolbar: some View {
        HStack(spacing: 6) {
            Button { combo.toggle() } label: { Label(combo ? "Combo" : "Normal", systemImage: "bolt") }
                .font(LWFATheme.control)
                .padding(.horizontal, 10).frame(height: 32)
                .foregroundStyle(combo ? LWFATheme.primaryForeground : LWFATheme.foreground)
                .background(combo ? LWFATheme.primary : LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous).strokeBorder(combo ? .clear : LWFATheme.border))
                .buttonStyle(.plain)
                .accessibilityHint("Keep modifiers held until tapped again")
            Button("More keys") { moreKeys.toggle() }
                .font(LWFATheme.control)
                .padding(.horizontal, 10).frame(height: 32)
                .foregroundStyle(LWFATheme.foreground)
                .background(moreKeys ? LWFATheme.muted : LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous).strokeBorder(moreKeys ? .clear : LWFATheme.border))
                .buttonStyle(.plain)
                .accessibilityHint("Insert, Home, Page Up and other full-size keys")
            if !latched.isEmpty {
                Button { clearLatched() } label: {
                    Text(latched.compactMap { modifierNames[$0] }.joined(separator: " + ") + " + …").font(LWFATheme.mono)
                        .foregroundStyle(LWFATheme.primary).padding(.horizontal, 8).padding(.vertical, 4)
                        .background(LWFATheme.primary.opacity(0.15), in: RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous))
                }.buttonStyle(.plain).accessibilityLabel("Clear held modifiers")
            }
            Spacer(minLength: 4)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(KeyboardCombo.all) { item in
                        Button { chord(item) } label: {
                            Text(item.label).font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(LWFATheme.foreground)
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusSmall, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusSmall, style: .continuous).strokeBorder(LWFATheme.border))
                        }.buttonStyle(.plain).accessibilityHint(item.hint)
                    }
                }
            }
            IconButton(systemImage: "slider.horizontal.3", label: "Keyboard settings", size: 32, action: openSettings)
            IconButton(systemImage: "xmark", label: "Hide keyboard", size: 32) { session.dock = "none" }
        }
        .frame(height: 32)
    }

    private func keyRow(_ keys: [KeyboardKey], width: CGFloat, height: CGFloat) -> some View {
        let units = keys.reduce(0) { $0 + $1.width }
        let unit = max(1, (width - CGFloat(keys.count - 1) * 4) / units)
        let shift = latched.contains(42) || held.contains(42)
        return HStack(spacing: 4) {
            ForEach(keys) { key in
                NativeHoldControl(legend: shift ? (key.shifted ?? key.legend.uppercased()) : key.legend,
                                  systemImage: key.isEnter ? "return" : nil,
                                  fontSize: min(22, max(9, height * 0.4)),
                                  latched: latched.contains(key.code),
                                  down: { press(key) }, up: { lift(key) })
                    .frame(width: unit * key.width, height: height)
            }
        }
    }

    /// Normal mode latches a modifier for one keypress; combo mode keeps it
    /// until tapped off. Chords go out modifiers first, key, then reversed.
    private func press(_ key: KeyboardKey) {
        guard session.acceptsInput else { return }
        if prefs.state.keyboardHaptics { UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.6) }
        if key.modifier, [29, 56, 42, 125].contains(key.code) {
            keyboard.toggleModifier(key.code)
            return
        }
        emit(keyboard.press(key.code))
    }
    private func lift(_ key: KeyboardKey) {
        emit(keyboard.lift(key.code, sticky: combo))
    }
    private func emit(_ commands: [ClientCommand]) {
        for case let .key(code, pressed) in commands {
            session.key(code, pressed: pressed, source: "keyboard")
        }
    }
    private func chord(_ item: KeyboardCombo) {
        guard session.acceptsInput else { return }
        if prefs.state.keyboardHaptics { UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.6) }
        for modifier in item.modifiers { session.key(modifier, pressed: true, source: "keyboard:shortcut") }
        session.key(item.key, pressed: true, source: "keyboard:shortcut")
        session.key(item.key, pressed: false, source: "keyboard:shortcut")
        for modifier in item.modifiers.reversed() { session.key(modifier, pressed: false, source: "keyboard:shortcut") }
    }
    private func clearLatched() { release() }
    private func release() { session.releaseSource("keyboard"); session.releaseSource("keyboard:shortcut"); keyboard.reset() }
}

/// A key that fires on touch down and releases on touch up or cancel.
struct NativeHoldControl: UIViewRepresentable {
    var legend: String
    var systemImage: String? = nil
    var fontSize: CGFloat = 13
    var latched = false
    var down: () -> Void
    var up: () -> Void
    @Environment(\.isEnabled) private var enabled
    func makeUIView(context: Context) -> NativeKeyControl {
        let control = NativeKeyControl(type: .custom)
        control.configure(self, enabled: enabled)
        return control
    }
    func updateUIView(_ view: NativeKeyControl, context: Context) { view.configure(self, enabled: enabled) }
    static func dismantleUIView(_ view: NativeKeyControl, coordinator: ()) { view.releaseKey() }
}

final class NativeKeyControl: UIButton {
    private var downAction: () -> Void = {}
    private var upAction: () -> Void = {}
    private var holding = false
    private var registered = false
    private var latched = false
    fileprivate func configure(_ key: NativeHoldControl, enabled: Bool) {
        if !enabled { releaseKey() }
        downAction = key.down; upAction = key.up; latched = key.latched
        isEnabled = enabled
        var config = UIButton.Configuration.plain()
        config.contentInsets = .zero
        if let symbol = key.systemImage {
            config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: key.fontSize * 1.1, weight: .medium))
            config.title = nil
        } else {
            config.image = nil
            config.attributedTitle = AttributedString(key.legend, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: key.fontSize, weight: .medium)]))
        }
        configuration = config
        titleLabel?.adjustsFontSizeToFitWidth = true
        titleLabel?.minimumScaleFactor = 0.6
        layer.cornerRadius = 8.4
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        accessibilityLabel = key.legend
        if !registered {
            registered = true
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (control: NativeKeyControl, _: UITraitCollection) in
                control.updateColor()
            }
            addTarget(self, action: #selector(pressKey), for: .touchDown)
            addTarget(self, action: #selector(releaseKey), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        }
        updateColor()
    }
    @objc private func pressKey() {
        guard isEnabled, !holding else { return }
        holding = true; downAction(); updateColor()
    }
    @objc func releaseKey() {
        guard holding else { return }
        holding = false; upAction(); updateColor()
    }
    override func cancelTracking(with event: UIEvent?) { super.cancelTracking(with: event); releaseKey() }
    override func accessibilityActivate() -> Bool {
        guard isEnabled else { return false }
        pressKey(); releaseKey(); return true
    }
    private func updateColor() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let background = dark ? UIColor(rgb: 0x090A0E) : UIColor(rgb: 0xF2EFE9)
        let accent = dark ? UIColor(rgb: 0x27292E) : UIColor(rgb: 0xF0F0F0)
        let primary = dark ? UIColor(rgb: 0xFB6B44) : UIColor(rgb: 0xE8552D)
        let border = dark ? UIColor.white.withAlphaComponent(0.11) : UIColor(rgb: 0xDEDEDE)
        backgroundColor = holding ? accent : latched ? primary.withAlphaComponent(0.15) : background
        layer.borderColor = (latched ? primary : border).cgColor
        tintColor = latched ? primary : .label
        transform = holding ? CGAffineTransform(scaleX: 0.95, y: 0.95) : .identity
    }
}

// MARK: - Mouse panel

struct NativeMousePanel: View {
    @Bindable var session: NativeSession
    @Bindable var prefs: NativePreferences
    init(session: NativeSession) { self.session = session; prefs = session.preferences }
    private var shown: Bool { session.dock == "mouse" }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            PanelGroup {
                FieldRow("Show the mouse", hint: "A tap becomes a real click.") {
                    Button { session.dock = shown ? "none" : "mouse" } label: {
                        Label(shown ? "Hide" : "Show", systemImage: "computermouse")
                    }.panelButton(shown ? .secondary : .outline)
                }
            }
            PanelSection("Default button", description: "Change it live from the buttons on the mouse surface.") {
                SegmentedChoice([UInt32(272), 273, 274], selection: $prefs.state.mouseButton) { code in
                    Text(code == 272 ? "Left" : code == 273 ? "Right" : "Middle")
                }
            }
            PanelSection("Scrolling") {
                PanelGroup {
                    FieldRow("Scroll speed", hint: "Matches the desktop by default.") {
                        Slider(value: $prefs.state.scrollSpeed, in: 0.1...1.5, step: 0.05).tint(LWFATheme.primary).frame(width: 150)
                    }
                    SwitchRow(label: "Natural scrolling", hint: "Contents follow your finger.", isOn: $prefs.state.naturalScroll)
                }
            }
            PanelSection("Placement", description: "Stacked reduces the desktop to make room for the mouse.") {
                PlacementChoice(placement: $prefs.state.mousePlacement)
            }
            PanelSection("Haptics") {
                PanelGroup { SwitchRow(label: "Vibrate on press", isOn: $prefs.state.mouseHaptics) }
            }
            PanelSection("Layout") {
                PanelGroup {
                    FieldRow("Restore the default arrangement", hint: "Puts the three clusters back where they started.") {
                        Button { prefs.state.mousePositions = NativePreferenceState().mousePositions } label: {
                            Label("Reset", systemImage: "arrow.counterclockwise")
                        }.panelButton(.outline)
                    }
                }
            }
        }
    }
}

// MARK: - Mouse surface

/// `mouse/MouseOverlay.tsx`: three draggable clusters over a desktop where
/// the tap itself is the click. Stacked placement adds a trackpad row instead.
struct NativeMouseSurface: View {
    @Bindable var session: NativeSession
    @Bindable var prefs: NativePreferences
    var openSettings: () -> Void
    @State private var locked = false
    @State private var editing = false
    @State private var modifiers: Set<UInt32> = []
    @State private var dragOrigin: [String: [Double]] = [:]
    @State private var padSize = CGSize(width: 1, height: 1)
    init(session: NativeSession, openSettings: @escaping () -> Void) {
        self.session = session; prefs = session.preferences; self.openSettings = openSettings
    }
    var body: some View {
        Group {
            if prefs.state.mousePlacement == "stacked" { stacked } else { overlay }
        }
        .onChange(of: session.acceptsInput) { _, enabled in if !enabled { release() } }
        .onChange(of: session.inputGeneration) { _, _ in release() }
        .onChange(of: prefs.state.mouseButton) { _, _ in session.releaseSource("mouse:lock"); locked = false }
        .onChange(of: editing) { _, value in if value { release() } }
        .onDisappear { release() }
    }

    private var overlay: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topTrailing) {
                if editing {
                    Color.black.opacity(0.3).contentShape(Rectangle()).onTapGesture {}
                    Text("Drag the clusters to rearrange. Tap Done when finished.").font(LWFATheme.hint).foregroundStyle(.white.opacity(0.8))
                        .padding(.horizontal, 12).padding(.vertical, 4).background(.black.opacity(0.6), in: Capsule())
                        .frame(maxWidth: .infinity).padding(.top, 12)
                }
                cluster("selector", size: geometry.size) { VStack(spacing: 12) { selectors } }
                cluster("tools", size: geometry.size) { VStack(spacing: 12) { tools } }
                cluster("modifiers", size: geometry.size) { HStack(spacing: 8) { modifierChips } }
                toolbar
            }
        }
    }

    private var stacked: some View {
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) { selectors; tools; modifierChips }.padding(.horizontal, 6)
                }
                toolbar
            }
            .frame(height: 52)
            Color.primary.opacity(0.03).contentShape(Rectangle())
                .overlay { Image(systemName: "hand.point.up.left").font(.system(size: 20)).foregroundStyle(LWFATheme.mutedForeground.opacity(0.4)) }
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard session.acceptsInput else { return }
                        session.pointer(x: value.location.x / max(1, padSize.width), y: value.location.y / max(1, padSize.height))
                    }.onEnded { _ in if !session.mouseHover && !locked { click(prefs.state.mouseButton) } })
                .onGeometryChange(for: CGSize.self) { $0.size } action: { padSize = $0 }
        }
        .background(LWFATheme.card.opacity(0.95))
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            if prefs.state.mousePlacement == "overlay" {
                Button(editing ? "Done" : "Edit") { editing.toggle() }.font(LWFATheme.control).foregroundStyle(.white.opacity(0.9))
                    .padding(.horizontal, 10).frame(height: 32)
            }
            Button(action: openSettings) { Image(systemName: "slider.horizontal.3").frame(width: 36, height: 32) }
                .foregroundStyle(.white.opacity(0.9)).accessibilityLabel("Mouse settings")
            Button { session.dock = "none" } label: { Image(systemName: "xmark").frame(width: 36, height: 32) }
                .foregroundStyle(.white.opacity(0.9)).accessibilityLabel("Hide mouse")
        }
        .buttonStyle(.plain)
        .padding(2)
        .background(.black.opacity(0.45))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.white.opacity(0.2)))
        .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 8))
    }

    @ViewBuilder private var selectors: some View {
        ForEach([(UInt32(272), "cursorarrow", "Left click"), (273, "cursorarrow.click", "Right click"), (274, "cursorarrow.rays", "Middle click")], id: \.0) { code, icon, label in
            roundButton(icon, label: label, active: prefs.state.mouseButton == code) { prefs.state.mouseButton = code }
        }
    }
    @ViewBuilder private var tools: some View {
        NativeMouseScroll { x, y in if !editing { session.scroll(horizontal: x, vertical: y) } }
            .frame(width: 36, height: prefs.state.mousePlacement == "stacked" ? 44 : 96)
        roundButton("chevron.left", label: "Back (side button)") { click(275) }
        roundButton("chevron.right", label: "Forward (side button)") { click(276) }
        roundButton("hand.draw", label: locked ? "Release drag" : "Drag lock", active: locked) {
            guard session.acceptsInput, !editing else { return }
            if locked { session.releaseSource("mouse:lock"); locked = false }
            else { locked = true; session.pointerButton(prefs.state.mouseButton, pressed: true, source: "mouse:lock") }
        }
        roundButton("cursorarrow.motionlines", label: "Hover (move without clicking)", active: session.mouseHover) { session.mouseHover.toggle() }
    }
    @ViewBuilder private var modifierChips: some View {
        ForEach([(UInt32(29), "Ctrl"), (42, "Shift"), (56, "Alt")], id: \.0) { code, label in
            let on = modifiers.contains(code)
            Button(label) {
                guard session.acceptsInput, !editing else { return }
                if modifiers.remove(code) != nil { session.key(code, pressed: false, source: "mouse:modifiers") }
                else { modifiers.insert(code); session.key(code, pressed: true, source: "mouse:modifiers") }
            }
            .font(LWFATheme.control)
            .foregroundStyle(on ? LWFATheme.primaryForeground : .white.opacity(0.8))
            .frame(minWidth: 56, minHeight: 36)
            .background(on ? LWFATheme.primary : .black.opacity(0.45), in: RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous).strokeBorder(on ? LWFATheme.primary : .white.opacity(0.2)))
            .buttonStyle(.plain)
        }
    }
    private func roundButton(_ icon: String, label: String, active: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 17, weight: .medium))
                .foregroundStyle(active ? LWFATheme.primaryForeground : .white.opacity(0.8))
                .frame(width: LWFATheme.hit, height: LWFATheme.hit)
                .background(active ? LWFATheme.primary : .black.opacity(0.45), in: Circle())
                .overlay(Circle().strokeBorder(active ? LWFATheme.primary : .white.opacity(0.2)))
                .contentShape(Circle().inset(by: -8))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
    private func cluster<C: View>(_ id: String, size: CGSize, @ViewBuilder content: () -> C) -> some View {
        let point = prefs.state.mousePositions[id] ?? [50, 50]
        return content()
            .padding(editing ? 8 : 0)
            .background(editing ? Color.white.opacity(0.05) : .clear, in: RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous).strokeBorder(editing ? LWFATheme.primary.opacity(0.7) : .clear, lineWidth: 2))
            .gesture(editing ? DragGesture().onChanged { value in
                let start = dragOrigin[id] ?? point
                dragOrigin[id] = start
                prefs.state.mousePositions[id] = [min(96, max(4, start[0] + value.translation.width / max(1, size.width) * 100)),
                                                 min(96, max(4, start[1] + value.translation.height / max(1, size.height) * 100))]
            }.onEnded { _ in dragOrigin[id] = nil } : nil)
            .position(x: point[0] / 100 * size.width, y: point[1] / 100 * size.height)
    }
    private func click(_ button: UInt32) {
        guard session.acceptsInput, !editing else { return }
        if prefs.state.mouseHaptics { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
        session.pointerButton(button, pressed: true, source: "mouse:click")
        session.pointerButton(button, pressed: false, source: "mouse:click")
    }
    private func release() {
        session.releaseSource("mouse:click"); session.releaseSource("mouse:lock"); session.releaseSource("mouse:modifiers")
        modifiers.removeAll(); locked = false
        session.mouseHover = false
    }
}

/// The scroll strip: drag the dot to scroll, coalesced per gesture change.
private struct NativeMouseScroll: View {
    var action: (Double, Double) -> Void
    @State private var last = CGSize.zero
    @State private var offset: CGFloat = 0
    var body: some View {
        ZStack {
            Capsule().fill(.black.opacity(0.45)).overlay(Capsule().strokeBorder(.white.opacity(0.2)))
            Circle().fill(.white.opacity(0.5)).frame(width: 16, height: 16).offset(y: offset)
        }
        .contentShape(Capsule().inset(by: -8))
        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
            action(value.translation.width - last.width, value.translation.height - last.height)
            last = value.translation
            offset = max(-30, min(30, value.translation.height / 3))
        }.onEnded { _ in last = .zero; offset = 0 })
        .accessibilityLabel("Scroll")
    }
}
#endif
