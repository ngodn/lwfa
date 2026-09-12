#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import LWFACore

/// Virtual controller state and its persisted layout (`gamepad/model.ts`).
@MainActor
@Observable
final class NativeGamepadModel {
    @ObservationIgnored var onChange: (() -> Void)?
    var visible = false { didSet { if !visible { editing = false }; onChange?() } }
    var hidden = false
    var editing = false { didSet { if !editing { selectedPad = nil } } }
    var selectedPad: String?
    var shield = false { didSet { UserDefaults.standard.set(shield, forKey: "lwfa.gamepad.shield") } }
    var placement = "overlay" { didSet { UserDefaults.standard.set(placement, forKey: "lwfa.gamepad.placement"); onChange?() } }
    var skin = "neutral" { didSet { persist() } }
    var opacity = 0.85 { didSet { persist() } }
    var haptics = true { didSet { persist() } }
    var mode = "controller" { didSet { persist(); onChange?() } }
    var pads = GamepadLayout.defaultPads { didSet { persist() } }
    var recording = false { didSet { if recording { samples.removeAll(); started = Date() } } }
    @ObservationIgnored private var samples: [WireValue] = []
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private let storage = "lwfa.native.gamepad.backup"

    init() {
        if let data = UserDefaults.standard.data(forKey: storage), let backup = try? GamepadBackup.read(data) {
            pads = backup.pads; skin = backup.settings.skin; opacity = backup.settings.opacity
            haptics = backup.settings.haptics; mode = backup.settings.mode
        }
        shield = UserDefaults.standard.bool(forKey: "lwfa.gamepad.shield")
        if let placement = UserDefaults.standard.string(forKey: "lwfa.gamepad.placement"), ["overlay", "stacked"].contains(placement) {
            self.placement = placement
        }
    }
    func backupData() throws -> Data {
        try GamepadBackup(pads: pads, settings: .init(skin: skin, opacity: opacity, haptics: haptics, mode: mode)).encoded()
    }
    func restore(_ data: Data) throws {
        let backup = try GamepadBackup.read(data)
        editing = false
        pads = backup.pads; skin = backup.settings.skin; opacity = backup.settings.opacity
        haptics = backup.settings.haptics; mode = backup.settings.mode
    }
    func update(_ pad: GamepadPad) {
        guard let index = pads.firstIndex(where: { $0.id == pad.id }) else { return }
        pads[index] = pad.clamped()
    }
    func releasePads(_ session: NativeSession) { pads.forEach { session.releaseSource("pad:\($0.id)") } }
    func record(command: ClientCommand, source: String) {
        guard recording, let data = try? command.encoded(), let message = try? WireValue.decode(data) else { return }
        if samples.count >= 4096 { samples.removeFirst() }
        samples.append(.object(["atMs": .double(Date().timeIntervalSince(started) * 1000), "source": .string(source), "message": message]))
    }
    func traceData() throws -> Data {
        try WireValue.object(["kind": .string("lwfa.controller.native"), "version": .uint(1),
                              "savedAt": .string(ISO8601DateFormatter().string(from: Date())), "samples": .array(samples)]).encoded()
    }
    private func persist() { if let data = try? backupData() { UserDefaults.standard.set(data, forKey: storage) } }
}

// MARK: - Panel

/// `GamepadPanel.tsx`: Controller, Proton, LSFG and Framegen tabs.
@MainActor
struct NativeGamepadPanel: View {
    @Bindable var session: NativeSession
    @Bindable private var model: NativeGamepadModel
    @Bindable private var prefs: NativePreferences
    @State private var tab = "controller"
    @State private var showImporter = false
    @State private var showExporter = false
    @State private var pasteOpen = false
    @State private var restoreText = ""
    @State private var confirmReset = false
    @State private var keysOpen = false
    @State private var notice: String?
    @State private var noticeIsError = false
    @State private var copied = false
    @State private var document = GamepadJSONDocument(data: Data())
    @State private var filename = "lwfa-controller.json"

    init(session: NativeSession) { self.session = session; model = session.gamepad; prefs = session.preferences }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            SegmentedChoice(["controller", "proton", "lsfg", "framegen"], selection: $tab) {
                Text($0 == "controller" ? "Controller" : $0 == "proton" ? "Proton" : $0 == "lsfg" ? "LSFG" : "Framegen")
            }
            if tab == "controller" { controllerSettings }
            else { NativeGamingPanel(session: session, initialTab: tab) }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json, .plainText]) { result in
            do {
                let url = try result.get()
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                restore(try handle.read(upToCount: 1_048_577) ?? Data())
            } catch { show("Could not read the controller backup.", error: true) }
        }
        .fileExporter(isPresented: $showExporter, document: document, contentType: .json, defaultFilename: filename) { result in
            switch result { case .success: show("File saved."); case .failure: show("Could not save the file.", error: true) }
        }
        .gameInputSuspended(session, while: confirmReset || showImporter || showExporter)
        .confirmationDialog("Restore the default arrangement?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Restore default layout", role: .destructive) {
                model.releasePads(session); model.pads = GamepadLayout.defaultPads; model.editing = false
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Custom keyboard buttons and control positions will be replaced. Save a backup to keep them.") }
    }

    private var controllerSettings: some View {
        Group {
            PanelGroup {
                SwitchRow(label: "Show the gamepad", isOn: Binding(get: { model.visible }, set: { model.releasePads(session); model.visible = $0 }))
                SwitchRow(label: "Physical controller", hint: "Forward a connected game controller.", isOn: $session.gamepadEnabled)
                FieldRow("Edit layout", hint: model.visible ? "Drag the controls to rearrange them." : "Turn the gamepad on first.") {
                    Button { model.releasePads(session); model.editing.toggle(); if model.editing { model.hidden = false } } label: {
                        Label(model.editing ? "Done" : "Edit", systemImage: "pencil")
                    }
                    .panelButton(model.editing ? .primary : .outline)
                    .disabled(!model.visible)
                }
            }
            PanelSection("Labels") {
                SegmentedChoice(["playstation", "xbox", "neutral"], selection: $model.skin) { skin in
                    VStack(spacing: 2) {
                        Text(skin == "playstation" ? "PlayStation" : skin == "xbox" ? "Xbox" : "Neutral").font(.system(size: 12))
                        Text(skin == "playstation" ? "△ ✕ ○ □" : skin == "xbox" ? "Y A B X" : "N S E W").font(LWFATheme.tiny).opacity(0.7)
                    }.padding(.vertical, 4)
                }
            }
            PanelSection("Opacity") {
                HStack(spacing: 12) {
                    Slider(value: $model.opacity, in: 0.2...1, step: 0.05).tint(LWFATheme.primary)
                    Text("\(Int((model.opacity * 100).rounded()))%").font(LWFATheme.readout).monospacedDigit().frame(width: 40, alignment: .trailing)
                }
            }
            PanelSection("Placement", description: "Stacked reduces the desktop to make room for the gamepad.") {
                PlacementChoice(placement: $model.placement)
            }
            PanelSection("Stray taps") {
                PanelGroup {
                    SwitchRow(label: "Block taps outside the pads",
                              hint: model.placement == "overlay" ? "Overlay only, never while editing." : "Only applies to an overlay controller.",
                              isOn: $model.shield)
                        .disabled(model.placement != "overlay")
                }
            }
            PanelSection("Haptics") {
                PanelGroup { SwitchRow(label: "Vibrate on press", isOn: $model.haptics) }
            }
            PanelSection("Input") {
                PanelGroup {
                    FieldRow("Controller mode", hint: model.mode == "controller" ? "A virtual gamepad on the machine." : "Sends the bound keys instead.") {
                        SegmentedChoice(["controller", "keyboard"], selection: Binding(get: { model.mode }, set: { model.releasePads(session); model.mode = $0 })) {
                            Text($0 == "controller" ? "Gamepad" : "Keys")
                        }.frame(width: 170)
                    }
                    SwitchRow(label: "Hide pads, keep the controller", hint: "For a physical controller with the virtual one out of the way.",
                              isOn: Binding(get: { model.hidden }, set: { model.releasePads(session); model.hidden = $0; if $0 { model.editing = false } }))
                }
            }
            PanelSection("Layout") {
                PanelGroup {
                    VStack(spacing: 0) {
                        Button { keysOpen.toggle() } label: {
                            HStack {
                                Text("Keyboard buttons").font(LWFATheme.label)
                                Spacer()
                                Label("Add a key", systemImage: "plus").font(LWFATheme.control).foregroundStyle(LWFATheme.mutedForeground)
                                Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).rotationEffect(.degrees(keysOpen ? 180 : 0))
                            }
                            .padding(.horizontal, 12).frame(minHeight: LWFATheme.hit).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        if keysOpen {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("A key or a chord as a button on the pad.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                                NativeCustomKeys(session: session, model: model) { message in show(message, error: true) }
                            }
                            .padding(12)
                            .overlay(alignment: .top) { Rectangle().fill(LWFATheme.border).frame(height: 1) }
                        }
                    }
                    FieldRow("Save a backup", hint: "Layout and controller settings.") {
                        HStack(spacing: 6) {
                            Button { export(try? model.backupData(), name: "lwfa-controller.json") } label: { Label("File", systemImage: "arrow.down.circle") }.panelButton(.outline)
                            Button {
                                if let data = try? model.backupData() {
                                    UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
                                    copied = true
                                    Task { @MainActor in try? await Task.sleep(for: .milliseconds(1500)); copied = false }
                                }
                            } label: { Label(copied ? "Copied" : "Copy", systemImage: "doc.on.doc") }.panelButton(.outline)
                        }
                    }
                    VStack(spacing: 10) {
                        FieldRow("Restore", hint: "Replaces the controller with a saved one.") {
                            HStack(spacing: 6) {
                                Button { showImporter = true } label: { Label("File", systemImage: "arrow.up.circle") }.panelButton(.outline)
                                Button { pasteOpen.toggle() } label: { Label("Paste", systemImage: "doc.on.clipboard") }.panelButton(pasteOpen ? .secondary : .outline)
                            }
                        }
                        if pasteOpen {
                            VStack(spacing: 8) {
                                TextEditor(text: $restoreText).font(LWFATheme.mono).scrollContentBackground(.hidden)
                                    .frame(height: 96).padding(6).panelCard(padding: 0)
                                    .overlay(alignment: .topLeading) {
                                        if restoreText.isEmpty { Text("Paste a backup here").font(LWFATheme.mono).foregroundStyle(LWFATheme.mutedForeground).padding(12) }
                                    }
                                Button("Restore from text") { restore(Data(restoreText.utf8)); pasteOpen = false; restoreText = "" }
                                    .panelButton(.outline, fullWidth: true)
                                    .disabled(restoreText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }.padding(.horizontal, 12).padding(.bottom, 12)
                        }
                    }
                    FieldRow("Restore the default arrangement") {
                        Button { confirmReset = true } label: { Label("Reset", systemImage: "arrow.counterclockwise") }.panelButton(.outline)
                    }
                }
                if let notice {
                    if noticeIsError { Text(notice).font(LWFATheme.hint).foregroundStyle(LWFATheme.destructive) }
                    else { DashedNote(text: notice, padding: 12) }
                }
            }
            PanelSection("Physical controller", description: "Release the controller buttons before resetting.") {
                PanelGroup {
                    FieldRow("Clear held input") {
                        Button { session.resetController(); show("Controller input cleared.") } label: { Label("Reset", systemImage: "arrow.counterclockwise") }.panelButton(.outline)
                    }
                    FieldRow("Record input", hint: "Last 4,096 samples, about 33 seconds.") {
                        Button {
                            if model.recording {
                                model.recording = false
                                export(try? model.traceData(), name: "lwfa-controller-trace.json")
                            } else { model.recording = true; show("Recording the last 4,096 native input events.") }
                        } label: { Label(model.recording ? "Stop and save" : "Record", systemImage: model.recording ? "stop.circle" : "record.circle") }
                        .panelButton(model.recording ? .primary : .outline)
                    }
                }
            }
        }
    }

    private func show(_ message: String, error: Bool = false) {
        notice = message; noticeIsError = error
        Task { @MainActor in try? await Task.sleep(for: .milliseconds(2500)); if notice == message { notice = nil } }
    }
    private func restore(_ data: Data) {
        do {
            _ = try GamepadBackup.read(data)
            model.releasePads(session); try model.restore(data); show("Controller restored.")
        } catch { show("This file contains no usable lwfa controller layout, or exceeds the backup limits.", error: true) }
    }
    private func export(_ data: Data?, name: String) {
        guard let data else { show("Could not create the file.", error: true); return }
        document = GamepadJSONDocument(data: data); filename = name; showExporter = true
    }
}

/// `CustomKeys.tsx`: chord pads on the controller.
@MainActor
private struct NativeCustomKeys: View {
    var session: NativeSession
    @Bindable var model: NativeGamepadModel
    var fail: (String) -> Void
    @State private var modifiers: Set<UInt32> = []
    @State private var key: UInt32?
    private let modifierNames: [(UInt32, String)] = [(29, "Ctrl"), (42, "Shift"), (56, "Alt"), (125, "Super")]
    private var chordName: String {
        let parts = modifierNames.filter { modifiers.contains($0.0) }.map(\.1) + [key.map { GamepadLayout.keyNames[$0] ?? "#\($0)" }].compactMap { $0 }
        return parts.isEmpty ? "Pick a key" : parts.joined(separator: " + ")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let keys = model.pads.filter { $0.kind == "key" }
            if !keys.isEmpty {
                VStack(spacing: 0) {
                    ForEach(keys) { pad in
                        HStack {
                            Text(GamepadLayout.label(pad, skin: model.skin)).font(LWFATheme.body)
                            Spacer()
                            IconButton(systemImage: "trash", label: "Remove \(GamepadLayout.label(pad, skin: model.skin))", tint: LWFATheme.mutedForeground) {
                                session.releaseSource("pad:\(pad.id)"); model.pads.removeAll { $0.id == pad.id }
                            }
                        }.padding(.leading, 12).frame(minHeight: LWFATheme.hit)
                        if pad.id != keys.last?.id { Rectangle().fill(LWFATheme.border).frame(height: 1) }
                    }
                }
                .background(LWFATheme.muted.opacity(0.2), in: RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous).strokeBorder(LWFATheme.border))
            }
            HStack(spacing: 6) {
                ForEach(modifierNames, id: \.0) { code, name in
                    let on = modifiers.contains(code)
                    Button(name) { if on { modifiers.remove(code) } else { modifiers.insert(code) } }
                        .panelButton(on ? .primary : .outline, fullWidth: true)
                }
            }
            let candidates = GamepadLayout.keyNames.keys.sorted().filter { ![29, 42, 54, 56, 97, 100, 125, 126].contains($0) }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 4)], spacing: 4) {
                    ForEach(candidates, id: \.self) { code in
                        let selected = key == code
                        Button(GamepadLayout.keyNames[code] ?? "#\(code)") { key = selected ? nil : code }
                            .font(.system(size: 12, weight: selected ? .medium : .regular))
                            .foregroundStyle(selected ? LWFATheme.primary : LWFATheme.foreground)
                            .frame(maxWidth: .infinity, minHeight: 40)
                            .background(selected ? LWFATheme.primary.opacity(0.15) : LWFATheme.card, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(selected ? LWFATheme.primary : LWFATheme.border))
                            .buttonStyle(.plain)
                    }
                }.padding(6)
            }
            .frame(maxHeight: 224)
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous).strokeBorder(LWFATheme.border))
            FieldRow(chordName, hint: model.editing ? "Drag to reposition in edit mode." : "Modifiers are optional.") {
                Button { add() } label: { Label("Add", systemImage: "plus") }.panelButton(.outline).disabled(key == nil)
            }.padding(.horizontal, -12)
        }
    }
    private func add() {
        guard let key else { return }
        guard model.pads.count < 128 else { fail("The controller already has 128 controls."); return }
        let chord = modifierNames.map(\.0).filter { modifiers.contains($0) } + [key]
        model.pads.append(GamepadPad(id: "key-\(UUID().uuidString)", kind: "key", face: "key", x: 50, y: 62, size: 11, chord: chord, label: nil))
        self.key = nil; modifiers = []
    }
}

// MARK: - Overlay

/// `GamepadOverlay.tsx`: the pads over (or under) the desktop.
@MainActor
struct NativeGamepadOverlay: View {
    var session: NativeSession
    @Bindable private var model: NativeGamepadModel
    var openSettings: () -> Void
    init(session: NativeSession, openSettings: @escaping () -> Void = {}) {
        self.session = session; model = session.gamepad; self.openSettings = openSettings
    }
    var body: some View {
        ZStack(alignment: .topTrailing) {
            GeometryReader { geometry in
                // Never taller than 16:9, anchored to the bottom: a portrait
                // tablet gets a controller-shaped band holding the landscape arrangement.
                let height = min(geometry.size.height, geometry.size.width * 9 / 16)
                let area = CGSize(width: geometry.size.width, height: height)
                // No clear fill: the gaps between pads must pass touches to the game
                // unless the shield is on (`pointer-events-none` in GamepadOverlay.tsx).
                ZStack(alignment: .bottom) {
                    ZStack {
                        if model.editing { editorBackground }
                        else if model.shield && model.placement == "overlay" {
                            Color.black.opacity(0.001).contentShape(Rectangle()).onTapGesture {}
                        }
                        if !model.hidden {
                            ForEach(model.pads) { pad in
                                GamepadPadView(session: session, model: model, pad: pad, canvas: area)
                            }
                        }
                    }
                    .frame(width: area.width, height: area.height)
                    .coordinateSpace(name: "lwfaGamepadCanvas")
                }
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .bottom)
            }
            toolbar
            if model.editing { editorHint }
        }
        .onChange(of: session.acceptsInput) { _, enabled in if !enabled { model.releasePads(session) } }
        .onChange(of: model.editing) { _, _ in model.releasePads(session) }
        .onDisappear { model.releasePads(session) }
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            dockButton(model.editing ? "Done" : "Edit", icon: nil) { model.releasePads(session); model.editing.toggle(); if model.editing { model.hidden = false } }
            dockButton(model.hidden ? "Show on-screen controls" : "Hide on-screen controls", icon: model.hidden ? "eye.slash" : "eye") {
                model.releasePads(session); model.hidden.toggle(); if model.hidden { model.editing = false }
            }
            if model.placement == "overlay" {
                dockButton("Block stray taps", icon: model.shield ? "shield.fill" : "shield.slash") { model.shield.toggle() }
            }
            dockButton("Controller settings", icon: "slider.horizontal.3") { model.releasePads(session); openSettings() }
            dockButton("Hide gamepad", icon: "xmark") { model.releasePads(session); model.visible = false }
        }
        .padding(2)
        .background(.black.opacity(0.45))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.white.opacity(0.2)))
        .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 8))
        .opacity(model.opacity)
    }
    private func dockButton(_ label: String, icon: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group {
                if let icon { Image(systemName: icon).font(.system(size: 15, weight: .medium)) }
                else { Text(label).font(LWFATheme.control) }
            }
            .foregroundStyle(.white.opacity(0.9))
            .frame(minWidth: 56, minHeight: LWFATheme.hit).padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var editorBackground: some View {
        Canvas { context, size in
            let gap: CGFloat = 24
            var x: CGFloat = gap / 2
            while x < size.width {
                var y: CGFloat = gap / 2
                while y < size.height {
                    context.fill(Path(ellipseIn: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5)), with: .color(.white.opacity(0.6)))
                    y += gap
                }
                x += gap
            }
        }
        .background(.black.opacity(0.3))
        .contentShape(Rectangle())
        .onTapGesture { model.selectedPad = nil }
    }

    private var editorHint: some View {
        VStack {
            Spacer()
            if let id = model.selectedPad, let pad = model.pads.first(where: { $0.id == id }) {
                HStack(spacing: 8) {
                    Text(pad.id).font(LWFATheme.control).padding(.horizontal, 6)
                    Button { resize(pad, by: -2) } label: { Image(systemName: "minus").frame(width: 32, height: 32) }
                    Button { resize(pad, by: 2) } label: { Image(systemName: "plus").frame(width: 32, height: 32) }
                }
                .padding(4)
                .background(LWFATheme.card.opacity(0.95), in: RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous).strokeBorder(LWFATheme.border))
                .padding(.bottom, 12)
            } else {
                Text("Drag a control to move it. Tap one to resize.").font(LWFATheme.hint).foregroundStyle(.white.opacity(0.8))
                    .padding(.horizontal, 12).padding(.vertical, 4)
                    .background(.black.opacity(0.6), in: Capsule())
                    .padding(.bottom, 12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(model.selectedPad != nil)
    }
    private func resize(_ pad: GamepadPad, by amount: Double) {
        model.releasePads(session); var next = pad; next.size += amount; model.update(next)
    }
}

/// One pad. The hit target is the full square; the visible shape is inside it,
/// so a near miss does not fall through a rounded corner to the game.
@MainActor
private struct GamepadPadView: View {
    var session: NativeSession
    @Bindable var model: NativeGamepadModel
    var pad: GamepadPad
    var canvas: CGSize
    @State private var pressed = false
    @State private var stick = CGSize.zero
    @State private var dragStart: CGPoint?
    @State private var moved = false
    private var source: String { "pad:\(pad.id)" }
    /// `size` percent of the shorter side (`cqmin`).
    private var side: CGFloat { max(36, min(canvas.width, canvas.height) * pad.size / 100) }
    private var rounded: Bool { pad.kind == "trigger" || pad.kind == "key" }

    var body: some View {
        ZStack {
            if model.editing {
                editorNode
            } else {
                switch pad.kind {
                case "dpad": dpad
                case "stick": stickView
                default: button
                }
            }
        }
        .frame(width: side, height: side)
        .opacity(model.editing ? 1 : model.opacity)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("lwfaGamepadCanvas"))
            .onChanged { value in
                if model.editing {
                    if dragStart == nil { dragStart = CGPoint(x: pad.x, y: pad.y); moved = false }
                    if hypot(value.translation.width, value.translation.height) > 6 { moved = true }
                    if moved, let dragStart, canvas.width > 0, canvas.height > 0 {
                        var next = pad
                        next.x = dragStart.x + value.translation.width / canvas.width * 100
                        next.y = dragStart.y + value.translation.height / canvas.height * 100
                        model.update(next)
                    }
                } else if session.acceptsInput {
                    if !pressed, model.haptics { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                    pressed = true
                    let radius = side * 0.45
                    let x = (value.location.x - center.x) / radius
                    let y = (value.location.y - center.y) / radius
                    let magnitude = max(1, hypot(x, y))
                    stick = CGSize(width: x / magnitude * min(1, hypot(x, y)), height: y / magnitude * min(1, hypot(x, y)))
                    emit(true, x: x, y: y)
                }
            }
            .onEnded { _ in
                if model.editing {
                    if !moved { model.selectedPad = model.selectedPad == pad.id ? nil : pad.id }
                    dragStart = nil; moved = false
                } else { finish() }
            })
        .accessibilityLabel(GamepadLayout.label(pad, skin: model.skin))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            guard !model.editing, session.acceptsInput else { return }
            emit(true); emit(false)
        }
        .onChange(of: session.acceptsInput) { _, enabled in if !enabled { finish() } }
        .onChange(of: session.inputGeneration) { _, _ in finish() }
        .onChange(of: model.mode) { _, _ in finish() }
        .onDisappear { finish() }
        .position(center)
    }

    private var center: CGPoint {
        CGPoint(x: min(max(side / 2, canvas.width * pad.x / 100), max(side / 2, canvas.width - side / 2)),
                y: min(max(side / 2, canvas.height * pad.y / 100), max(side / 2, canvas.height - side / 2)))
    }
    private var labelFont: Font {
        let label = GamepadLayout.label(pad, skin: model.skin)
        let factor = min(rounded ? 0.30 : 0.34, 0.9 / (0.68 * Double(max(1, label.count))))
        return .system(size: max(9, side * factor), weight: .semibold)
    }
    private var shape: AnyShape {
        rounded ? AnyShape(RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous)) : AnyShape(Circle())
    }

    private var button: some View {
        Text(GamepadLayout.label(pad, skin: model.skin)).font(labelFont)
            .minimumScaleFactor(0.5).lineLimit(pad.kind == "key" ? 2 : 1).padding(4)
            .foregroundStyle(.white.opacity(0.9))
            .frame(width: side * (pad.kind == "trigger" ? 1 : 0.92), height: side * (pad.kind == "trigger" ? 0.6 : 0.92))
            .background(.black.opacity(pressed ? 0.25 : 0.5), in: shape)
            .overlay(shape.stroke(.white.opacity(0.2), lineWidth: 1))
            .scaleEffect(pressed ? 0.95 : 1)
            .animation(LWFATheme.quick, value: pressed)
    }

    private var stickView: some View {
        ZStack {
            Circle().fill(.black.opacity(0.4)).overlay(Circle().stroke(.white.opacity(0.2), lineWidth: 1))
            Circle().fill(.white.opacity(0.25)).overlay(Circle().stroke(.white.opacity(0.3), lineWidth: 1))
                .frame(width: side * 0.45, height: side * 0.45)
                .offset(x: stick.width * side * 0.27, y: stick.height * side * 0.27)
            Text(GamepadLayout.label(pad, skin: model.skin)).font(.system(size: 10, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom).padding(.bottom, side * 0.1)
        }
        .frame(width: side, height: side)
    }

    private var dpad: some View {
        let cell = side / 3
        let active: [Bool] = pressed ? [stick.height < -0.38, stick.width > 0.38, stick.height > 0.38, stick.width < -0.38] : [false, false, false, false]
        func segment(_ glyph: String?, _ on: Bool, corners: UnevenRoundedRectangle) -> some View {
            corners.fill(.black.opacity(on ? 0.25 : glyph == nil ? 0.3 : 0.5))
                .overlay(corners.stroke(.white.opacity(glyph == nil ? 0.1 : 0.2), lineWidth: 1))
                .overlay { if let glyph { Text(glyph).font(.system(size: 10)).foregroundStyle(.white.opacity(0.8)) } }
                .frame(width: cell, height: cell)
        }
        let radius = cell * 0.35
        return Grid(horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                Color.clear.frame(width: cell, height: cell)
                segment("▲", active[0], corners: UnevenRoundedRectangle(topLeadingRadius: radius, topTrailingRadius: radius))
                Color.clear.frame(width: cell, height: cell)
            }
            GridRow {
                segment("◀", active[3], corners: UnevenRoundedRectangle(topLeadingRadius: radius, bottomLeadingRadius: radius))
                segment(nil, false, corners: UnevenRoundedRectangle())
                segment("▶", active[1], corners: UnevenRoundedRectangle(bottomTrailingRadius: radius, topTrailingRadius: radius))
            }
            GridRow {
                Color.clear.frame(width: cell, height: cell)
                segment("▼", active[2], corners: UnevenRoundedRectangle(bottomLeadingRadius: radius, bottomTrailingRadius: radius))
                Color.clear.frame(width: cell, height: cell)
            }
        }
    }

    private var editorNode: some View {
        let selected = model.selectedPad == pad.id
        let glyph = pad.kind == "dpad" ? "✛" : pad.kind == "stick" ? "◉" : GamepadLayout.label(pad, skin: model.skin)
        return Text(glyph).font(.system(size: 12, weight: .medium)).foregroundStyle(LWFATheme.primary)
            .minimumScaleFactor(0.5).lineLimit(1).padding(4)
            .frame(width: side * 0.92, height: side * (pad.kind == "trigger" ? 0.6 : 0.92))
            .background(LWFATheme.primary.opacity(selected ? 0.4 : 0.25), in: shape)
            .overlay(shape.stroke(style: StrokeStyle(lineWidth: 2, dash: [5, 4])).foregroundStyle(LWFATheme.primary.opacity(0.7)))
    }

    private func emit(_ down: Bool, x: Double = 0, y: Double = 0) {
        for command in GamepadLayout.commands(pad, mode: model.mode, pressed: down, x: x, y: y) {
            switch command {
            case .gamepadButton(let code, let pressed): session.button(code, pressed: pressed, source: source)
            case .gamepadAxis(let code, let value): session.axis(code, value: value, source: source)
            case .key(let code, let pressed): session.key(code, pressed: pressed, source: source)
            default: break
            }
        }
    }
    private func finish() {
        if pressed { emit(false) }
        session.releaseSource(source)
        pressed = false; stick = .zero; dragStart = nil
    }
}

private struct GamepadJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .plainText] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
#endif
