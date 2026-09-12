#if os(iOS)
import SwiftUI
import JavaScriptCore
import LWFACore

/// Uses the browser's pure layout policy without embedding a browser view.
/// The policy is the shell's own `strip.ts`, bundled into JavaScriptCore by
/// `scripts/build-ios-layout.mjs`; it has no DOM and renders nothing.
@MainActor
@Observable
final class NativeLayoutController {
    private(set) var placed: [WindowLayout] = []
    private(set) var focused: UInt64?
    private(set) var state: WireValue = .null
    private(set) var fullscreen = false
    private(set) var error: String?
    private(set) var presets: [Double] = []
    @ObservationIgnored private(set) var spring: WireValue = .null
    @ObservationIgnored private(set) var output = Output(width: 1, height: 1)
    @ObservationIgnored private var allStreams: [UInt64] = []
    @ObservationIgnored private var activeStreams: [UInt64] = []
    @ObservationIgnored private var context: JSContext?
    @ObservationIgnored private var dispatch: JSValue?
    @ObservationIgnored private var persistenceKey: String?
    @ObservationIgnored private var reconciled = false

    init() {
        guard let url = Bundle.module.url(forResource: "layout", withExtension: "js"),
              let script = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else {
            error = "The window layout resource could not be loaded."
            return
        }
        self.context = context
        context.evaluateScript(script)
        if let exception = context.exception { error = exception.toString(); return }
        dispatch = context.objectForKeyedSubscript("LWFALayout")?.objectForKeyedSubscript("dispatch")
        perform(["type": .string("snapshot")])
    }

    func setPersistenceKey(_ key: String) {
        let next = "lwfa.native.arrangement.\(key)"
        guard next != persistenceKey else { return }
        persistenceKey = next
        reset()
    }

    /// Revalidate a saved arrangement against the engine snapshot on every connection.
    func reset() {
        reconciled = false
        let saved = persistenceKey.flatMap { UserDefaults.standard.data(forKey: $0) }
            .flatMap { try? WireValue.decode($0) } ?? .null
        perform(["type": .string("reset"), "saved": saved])
    }

    func configure(orientation: String, defaultWidth: Int, centreFocused: Bool) {
        perform(["type": .string("configure"), "orientation": .string(orientation),
                 "defaultWidth": .int(Int64(defaultWidth)), "centreFocused": .bool(centreFocused)])
    }

    func reconcile(windows: [WindowInfo], focused: UInt64?, output: Output, current: [WindowLayout]) {
        self.output = output
        perform(["type": .string("reconcile"), "output": dimensions(output),
                 "focused": focused.map { .string(String($0)) } ?? .null,
                 "windows": .array(windows.map { .object(["id": .string(String($0.id)), "fullscreen": .bool($0.fullscreen)]) }),
                 "current": .array(current.map { .object(["id": .string(String($0.id)), "rect": rect($0.rect), "z": .int(Int64($0.z))]) })])
        reconciled = error == nil
        if reconciled { perform(["type": .string("snapshot")]) }
    }

    func resize(output: Output) {
        self.output = output
        perform(["type": .string("resize"), "output": dimensions(output)])
    }

    func action(_ name: String, args: [WireValue] = []) {
        // UInt64 identifiers cross the JS boundary as decimal strings. The bridge
        // aliases them to small integers before calling the shell's layout policy.
        perform(["type": .string("action"), "name": .string(name), "args": .array(args.map(stringifyIntegers))])
    }

    func streamIDs(pauseInactive: Bool) -> [UInt64] { pauseInactive ? activeStreams : allStreams }

    private func dimensions(_ output: Output) -> WireValue {
        .object(["width": .uint(UInt64(output.width)), "height": .uint(UInt64(output.height))])
    }
    private func rect(_ rect: Rect) -> WireValue {
        .object(["x": .double(rect.x), "y": .double(rect.y), "width": .double(rect.width), "height": .double(rect.height)])
    }
    private func stringifyIntegers(_ value: WireValue) -> WireValue {
        switch value {
        case .uint(let n): return .string(String(n))
        case .array(let items): return .array(items.map(stringifyIntegers))
        case .object(let fields): return .object(fields.mapValues(stringifyIntegers))
        default: return value
        }
    }
    private func decodeState(_ value: WireValue) -> WireValue {
        switch value {
        case .string(let id): return UInt64(id).map(WireValue.uint) ?? value
        case .array(let items): return .array(items.map(decodeState))
        case .object(let fields): return .object(fields.mapValues(decodeState))
        default: return value
        }
    }
    private func perform(_ fields: [String: WireValue]) {
        guard let dispatch else { return }
        do {
            let data = try WireValue.object(fields).encoded()
            guard let json = String(data: data, encoding: .utf8),
                  let result = dispatch.call(withArguments: [json])?.toString(),
                  let responseData = result.data(using: .utf8) else {
                error = context?.exception?.toString() ?? "The window layout did not return a result."
                return
            }
            let response = try WireValue.decode(responseData)
            if case .string(let message) = response["error"] { error = message; return }
            let nextPlaced = try response["placed"].arrayValue.map { item -> WindowLayout in
                guard let id = UInt64(item["id"].stringValue) else { throw ProtocolError.invalidPacket }
                let value = item["rect"]
                let rect = Rect(x: value["x"].doubleValue, y: value["y"].doubleValue, width: value["width"].doubleValue, height: value["height"].doubleValue)
                guard rect.x.isFinite, rect.y.isFinite, rect.width.isFinite, rect.height.isFinite, rect.width > 0, rect.height > 0,
                      let z = Int32(exactly: item["z"].doubleValue) else { throw ProtocolError.invalidPacket }
                return WindowLayout(id: id, rect: rect, z: z)
            }
            placed = nextPlaced
            focused = UInt64(response["focused"].stringValue)
            state = decodeState(response["state"])
            fullscreen = response["fullscreen"].boolValue
            presets = response["presets"].arrayValue.map(\.doubleValue)
            spring = response["spring"]
            allStreams = response["streams"].arrayValue.compactMap { UInt64($0.stringValue) }
            activeStreams = response["activeStreams"].arrayValue.compactMap { UInt64($0.stringValue) }
            error = nil
            if reconciled, let persistenceKey {
                UserDefaults.standard.set(try response["saved"].encoded(), forKey: persistenceKey)
            }
        } catch { self.error = "Window layout failed: \(error.localizedDescription)" }
    }
}

// MARK: - Windows panel

/// `WindowsPanel.tsx`.
@MainActor
struct NativeWindowsPanel: View {
    @Bindable var session: NativeSession
    @Bindable var layout: NativeLayoutController
    @Bindable var preferences: NativePreferences
    @State private var quitID: UInt64?
    @State private var expandedWindow: UInt64?
    @State private var expandedColumn: Int?
    init(session: NativeSession) { self.session = session; layout = session.layout; preferences = session.preferences }

    private var workspaces: [WireValue] { layout.state["workspaces"].arrayValue }
    private var activeIndex: Int { Int(layout.state["focus"].uintValue) }
    private var workspace: WireValue { workspaces.indices.contains(activeIndex) ? workspaces[activeIndex] : .null }
    private var columns: [WireValue] { workspace["columns"].arrayValue }
    private var mayArrange: Bool { session.connected && session.canInteract && session.primary }
    private var fitted: Bool { workspace["fit"].boolValue }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            if !session.primary {
                let driver = session.peers.first { $0.primary }.map { $0.device.isEmpty ? $0.account : $0.device } ?? "Another device"
                WarningNote {
                    Text("\(driver) is driving.").font(LWFATheme.label).foregroundStyle(LWFATheme.foreground)
                    Text("Input remains available.").foregroundStyle(LWFATheme.mutedForeground)
                    Button { session.sendMessage("takeControl") } label: { Label("Arrange from this device", systemImage: "gamecontroller") }
                        .panelButton(.primary, fullWidth: true).disabled(!session.canInteract || !session.connected)
                }
                PanelGroup {
                    FieldRow("Immersive mode") { immersiveButton }
                }
            }
            Group {
                Button { session.arranging = true } label: { Label("Arrange windows", systemImage: "square.grid.2x2") }
                    .panelButton(.primary, fullWidth: true)
                PanelSection("Workspace") {
                    workspaceChips
                    PanelGroup {
                        SwitchRow(label: "Fit to screen", hint: fitHint, isOn: Binding(get: { fitted }, set: { act("fit", [.bool($0)]) }))
                    }
                }
                PanelSection("Windows") {
                    if columns.isEmpty {
                        VStack(spacing: 12) {
                            Text("No windows in this workspace.").font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
                            Button { session.sendMessage("spawn", ["command": .string("alacritty"), "terminal": .bool(false)]) } label: {
                                Label("Open a terminal", systemImage: "plus")
                            }.panelButton(.outline)
                        }
                        .frame(maxWidth: .infinity).padding(32)
                        .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4])).foregroundStyle(LWFATheme.border))
                    } else {
                        PanelGroup {
                            ForEach(columns.indices, id: \.self) { index in columnRows(index) }
                        }
                    }
                }
                PanelSection("Layout", description: "Saved on this device.") {
                    PanelGroup {
                        FieldRow("Direction", hint: "Auto follows the screen orientation.") { EmptyView() }
                        SegmentedChoice(["auto", "horizontal", "vertical"], selection: $preferences.state.orientation) {
                            Text($0 == "auto" ? "Auto" : $0 == "horizontal" ? "Rows" : "Columns")
                        }.padding(.horizontal, 12).padding(.bottom, 12)
                        FieldRow("New window size") { EmptyView() }
                        SegmentedChoice(Array(layout.presets.indices), selection: $preferences.state.defaultWidth) { index in
                            Text("\(Int((layout.presets[index] * 100).rounded()))%").monospacedDigit()
                        }.padding(.horizontal, 12).padding(.bottom, 12)
                        SwitchRow(label: "Keep focus centred", isOn: $preferences.state.centreFocused)
                    }
                }
            }
            .disabled(!mayArrange)
            .opacity(mayArrange ? 1 : 0.6)
            if let error = layout.error { Text(error).font(LWFATheme.hint).foregroundStyle(LWFATheme.destructive) }
        }
        .confirmationDialog("Quit this application?", isPresented: Binding(get: { quitID != nil }, set: { if !$0 { quitID = nil } }), titleVisibility: .visible) {
            Button("Quit application", role: .destructive) {
                if let id = quitID, mayArrange { session.sendMessage("quitApp", ["id": .uint(id)]) }
                quitID = nil
            }
        } message: { Text("All windows belonging to this application may close. Save your work first.") }
    }

    private var immersiveButton: some View {
        Button { session.immersive.toggle() } label: {
            Image(systemName: "viewfinder")
                .font(.system(size: 16)).frame(width: LWFATheme.hit, height: LWFATheme.hit)
        }
        .panelButton(.outline)
        .accessibilityLabel(session.immersive ? "Exit immersive mode" : "Enter immersive mode")
        .accessibilityValue(session.immersive ? "On" : "Off")
        .accessibilityHint("Hide navigation and use the full iPad display.")
        .help(session.immersive ? "Exit immersive mode" : "Immersive mode: hide navigation")
    }

    private var workspaceChips: some View {
        HStack(spacing: 8) {
            ForEach(workspaces.indices, id: \.self) { index in
                let count = workspaces[index]["columns"].arrayValue.reduce(0) { $0 + $1["windows"].arrayValue.count }
                let current = index == activeIndex
                Button { act("workspace", [.int(Int64(index))]) } label: {
                    VStack(spacing: 1) {
                        Text(String(index + 1)).font(.system(size: 14, weight: .semibold))
                        Text(count == 0 ? "empty" : "\(count) win").font(LWFATheme.tiny)
                    }
                    .foregroundStyle(current ? LWFATheme.primaryForeground : LWFATheme.foreground)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(current ? LWFATheme.primary : LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous).strokeBorder(current ? LWFATheme.primary : LWFATheme.border))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Workspace \(index + 1)")
                .accessibilityAddTraits(current ? .isSelected : [])
            }
        }
    }

    private var fitHint: String {
        if columns.isEmpty { return "Nothing open on this workspace" }
        if fitted { return "Columns share the screen; all windows stream" }
        let total = columns.reduce(0.0) { sum, column in
            let preset = Int(column["width"].uintValue)
            return sum + (layout.presets.indices.contains(preset) ? layout.presets[preset] : 0.5)
        }
        return total > 1 ? "\(columns.count) columns will not fit; the strip keeps scrolling" : "Columns keep their width; the strip scrolls"
    }

    @ViewBuilder private func columnRows(_ index: Int) -> some View {
        let column = columns[index]
        let ids = column["windows"].arrayValue.map(\.uintValue)
        let holdsFocus = ids.contains(layout.focused ?? 0)
        if ids.count > 1 {
            VStack(spacing: 0) {
                Button { expandedColumn = expandedColumn == index ? nil : index } label: {
                    HStack(spacing: 10) {
                        Rectangle().fill(holdsFocus ? LWFATheme.primary : LWFATheme.border).frame(width: 4, height: 24)
                        Image(systemName: "rectangle.split.2x1").font(.system(size: 14)).foregroundStyle(LWFATheme.mutedForeground)
                        Text("\(ids.count) windows").font(LWFATheme.label)
                        if column["live"].boolValue { PanelBadge(text: String(ids.count), icon: "play.rectangle", tint: LWFATheme.primary) }
                        Spacer(minLength: 0)
                        Text(widthLabel(column)).font(LWFATheme.tiny).monospacedDigit().padding(.horizontal, 6).padding(.vertical, 2)
                            .background(LWFATheme.muted, in: Capsule())
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                            .rotationEffect(.degrees(expandedColumn == index ? 180 : 0))
                            .frame(width: LWFATheme.hit, height: LWFATheme.hit)
                    }
                    .padding(.leading, 8).frame(minHeight: LWFATheme.hit)
                    .background(LWFATheme.muted.opacity(0.4))
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                if expandedColumn == index { columnControls(column, ids: ids) }
                ForEach(Array(ids.enumerated()), id: \.element) { row, id in
                    Rectangle().fill(LWFATheme.border).frame(height: 1).padding(.horizontal, 12)
                    windowRow(id, column: index, row: row, count: ids.count, stacked: true)
                }
            }
        } else if let id = ids.first {
            windowRow(id, column: index, row: 0, count: 1, stacked: false)
        }
    }

    private func widthLabel(_ column: WireValue) -> String {
        let preset = Int(column["width"].uintValue)
        return layout.presets.indices.contains(preset) ? "\(Int((layout.presets[preset] * 100).rounded()))%" : "–"
    }

    private func columnControls(_ column: WireValue, ids: [UInt64]) -> some View {
        let live = column["live"].boolValue
        let liveLabel = ids.count <= 1 ? "Only one window in this column"
            : !session.pauseInactive ? "Every visible window already streams"
            : live ? "Stream only the focused window of this column" : "Stream all \(ids.count) windows in this column"
        return VStack(alignment: .leading, spacing: 8) {
            Text("COLUMN WIDTH").font(LWFATheme.sectionHeading).kerning(0.66).foregroundStyle(LWFATheme.mutedForeground)
            HStack(spacing: 8) {
                SegmentedChoice(Array(layout.presets.indices), selection: Binding(get: { Int(column["width"].uintValue) }, set: { preset in
                    if let id = ids.first { act("width", [.uint(id), .int(Int64(preset))]) }
                }), isEnabled: !fitted) { index in
                    Text("\(Int((layout.presets[index] * 100).rounded()))").monospacedDigit()
                }
                if ids.count > 1 {
                    Button { if let id = ids.first { act("live", [.uint(id), .bool(!live)]) } } label: {
                        Image(systemName: "play.rectangle").font(.system(size: 16)).frame(width: LWFATheme.hit, height: LWFATheme.hit)
                    }
                    .panelButton(live ? .primary : .outline)
                    .disabled(!session.pauseInactive)
                    .accessibilityLabel(liveLabel)
                }
            }
        }
        .padding(12)
    }

    private func windowRow(_ id: UInt64, column: Int, row: Int, count: Int, stacked: Bool) -> some View {
        let focused = layout.focused == id
        let open = expandedWindow == id
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                if stacked { Image(systemName: "arrow.turn.down.right").font(.system(size: 12)).foregroundStyle(LWFATheme.mutedForeground) }
                Button { act("focus", [.uint(id)]) } label: {
                    HStack {
                        Text(title(id)).font(LWFATheme.body).foregroundStyle(LWFATheme.foreground).lineLimit(1)
                        Spacer(minLength: 0)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                if !stacked {
                    Text(widthLabel(columns[column])).font(LWFATheme.tiny).monospacedDigit().padding(.horizontal, 6).padding(.vertical, 2)
                        .background(LWFATheme.muted, in: Capsule())
                }
                Button { expandedWindow = open ? nil : id } label: {
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(open ? 180 : 0))
                        .frame(width: LWFATheme.hit, height: LWFATheme.hit).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Arrange \(title(id))")
            }
            .padding(.leading, 12).frame(minHeight: LWFATheme.hit)
            .background(focused ? LWFATheme.primary.opacity(0.05) : .clear)
            if open {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        immersiveButton
                        iconAction(layout.fullscreen && focused ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                   layout.fullscreen && focused ? "Exit window fullscreen" : "Fill canvas with this window") { act("focus", [.uint(id)]); act("fullscreen") }
                        iconAction("arrow.left.to.line", "Stack onto the column to the left") { act("focus", [.uint(id)]); act("stack") }
                            .disabled(column == 0)
                        iconAction("arrow.right.to.line", "Move into its own column") { act("focus", [.uint(id)]); act("unstack") }
                            .disabled(count == 1)
                        iconAction("xmark", "Close", danger: true) { session.sendMessage("closeWindow", ["id": .uint(id)]) }
                        iconAction("power", "Quit the application", danger: true) { quitID = id }
                    }
                    if workspaces.count > 1 {
                        HStack(spacing: 8) {
                            Text("Send to").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                            ForEach(workspaces.indices, id: \.self) { index in
                                Button(String(index + 1)) { act("sendWorkspace", [.uint(id), .int(Int64(index))]) }
                                    .panelButton(.outline).disabled(index == activeIndex)
                            }
                        }
                    }
                    if count == 1 {
                        Rectangle().fill(LWFATheme.border).frame(height: 1)
                        columnControls(columns[column], ids: [id]).padding(-12)
                    }
                }
                .padding(12)
                .overlay(alignment: .top) { Rectangle().fill(LWFATheme.border).frame(height: 1) }
            }
        }
    }

    private func iconAction(_ symbol: String, _ label: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 16)).frame(width: LWFATheme.hit, height: LWFATheme.hit)
        }
        .panelButton(.outline, danger: danger)
        .accessibilityLabel(label)
    }

    private func act(_ name: String, _ args: [WireValue] = []) {
        guard mayArrange else { return }
        session.layoutAction(name, args: args)
    }
    private func title(_ id: UInt64) -> String { session.windows.first(where: { $0.id == id })?.title ?? "Window \(id)" }
}
#endif
