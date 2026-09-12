#if os(iOS)
import SwiftUI
import UIKit
import LWFACore

private struct AdministrationRow: Identifiable {
    let id: UInt64
    let value: WireValue
}

struct LauncherApp: Identifiable, Equatable {
    let value: WireValue
    var id: String { value["id"].stringValue }
    var name: String { value["name"].stringValue }
    var command: String { value["exec"].stringValue }
    var terminal: Bool { value["terminal"].boolValue }
    var description: String { value["description"].stringValue }
    var categories: [String] { value["categories"].arrayValue.map(\.stringValue) }
}

// Keep the ranking aligned with AppsPanel.tsx: names beat IDs and descriptions.
enum NativeAppSearch {
    static func score(name: String, id: String, description: String, categories: [String], needle: String) -> Int? {
        let name = name.lowercased()
        if name.hasPrefix(needle) { return 0 }
        if name.split(whereSeparator: { $0.isWhitespace }).contains(where: { $0.hasPrefix(needle) }) { return 1 }
        if name.contains(needle) { return 2 }
        if id.lowercased().contains(needle) { return 3 }
        if description.lowercased().contains(needle) { return 4 }
        if categories.contains(where: { $0.lowercased().contains(needle) }) { return 5 }
        return nil
    }
}

// MARK: - Apps

/// `AppsPanel.tsx`.
@MainActor
struct NativeAppsPanel: View {
    var session: NativeSession
    @State private var query = ""
    @State private var command = ""
    @State private var terminal = false
    @State private var pinned: [String] = []
    @State private var recent: [String] = []
    @State private var icons: [String: UIImage] = [:]
    @State private var requestedIcons: Set<String> = []
    @State private var outside: WireValue?
    @State private var confirmOutside = false
    @State private var confirmForce = false
    @State private var attemptedPoliteClose = false
    @State private var quitBackground: WireValue?
    @State private var pendingLaunch: String?
    @State private var launchNotice: String?

    private var apps: [LauncherApp] {
        (session.serverMessages["apps"]?["apps"].arrayValue ?? []).map { LauncherApp(value: $0) }
    }
    private var filtered: [LauncherApp] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !needle.isEmpty {
            return apps.compactMap { app -> (LauncherApp, Int)? in
                NativeAppSearch.score(name: app.name, id: app.id, description: app.description, categories: app.categories, needle: needle).map { (app, $0) }
            }.sorted { a, b in
                a.1 != b.1 ? a.1 < b.1 : a.0.name.localizedStandardCompare(b.0.name) == .orderedAscending
            }.map(\.0)
        }
        return apps.sorted { a, b in
            if pinned.contains(a.id) != pinned.contains(b.id) { return pinned.contains(a.id) }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }
    private var historyKey: String { "lwfa.launcher.\(session.publicServerURL?.absoluteString ?? "").\(session.account)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(LWFATheme.mutedForeground).padding(.leading, 12)
                TextField("Search applications", text: $query)
                    .font(LWFATheme.body)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .frame(minHeight: LWFATheme.hit)
                    .accessibilityLabel("Search applications")
            }
            .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous).strokeBorder(LWFATheme.input))

            if session.serverMessages["apps"] == nil {
                HStack(spacing: 8) { ProgressView(); Text("Reading installed applications…") }
                    .font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground).padding(.vertical, 24).frame(maxWidth: .infinity)
            } else if filtered.isEmpty {
                DashedNote(text: query.isEmpty ? "No applications found." : "Nothing matches “\(query)”.")
            } else {
                PanelSection(filtered.count == 1 ? "1 application" : "\(filtered.count) applications") {
                    PanelGroup {
                        ForEach(filtered) { app in appRow(app) }
                    }
                }
            }
            if let launchNotice { Text(launchNotice).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground) }
            backgroundApps
            outsideApp
            PanelSection("Run a command") {
                HStack(spacing: 8) {
                    TextField("alacritty", text: $command)
                        .textFieldStyle(PanelTextFieldStyle(mono: true))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit(runCommand)
                        .accessibilityLabel("Command to run")
                    Button("Run", action: runCommand).panelButton(.outline)
                        .disabled(!session.connected || !session.canInteract || command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(8).panelCard(padding: 0)
                PanelGroup { SwitchRow(label: "Open in a terminal", isOn: $terminal) }
            }
        }
        .onAppear {
            pinned = UserDefaults.standard.stringArray(forKey: historyKey + ".pinned") ?? []
            recent = UserDefaults.standard.stringArray(forKey: historyKey + ".recent") ?? []
            refresh()
            mergeIcons()
        }
        .onReceive(session.serverEvents) { event in
            switch event.0 {
            case "apps": requestIcons(entries: event.1["apps"].arrayValue)
            case "appIcons": mergeIcons(event.1)
            case "alreadyRunning": receiveOutside(event.1)
            default: break
            }
        }
        .onChange(of: session.windows) { _, _ in pendingLaunch = nil; launchNotice = nil }
        .task(id: pendingLaunch) {
            guard pendingLaunch != nil else { return }
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            pendingLaunch = nil
            launchNotice = "The launch was sent, but no new window has appeared yet."
        }
        .gameInputSuspended(session, while: confirmOutside || confirmForce || quitBackground != nil)
        .confirmationDialog("\(outside?["program"].stringValue ?? "The app") is already open on the desktop", isPresented: $confirmOutside, titleVisibility: .visible) {
            Button("Close it and open here", role: .destructive) { moveOutside(force: false) }
        } message: { Text("Apps that share a profile reuse their open window instead of starting a second copy, so it opened on the desktop rather than here.") }
        .confirmationDialog("\(outside?["program"].stringValue ?? "The app") has not closed", isPresented: $confirmForce, titleVisibility: .visible) {
            Button("Force quit", role: .destructive) { moveOutside(force: true) }
            Button("Keep waiting") {}
        } message: { Text("It is most likely asking to save something on the desktop screen. Answer it there, or force it to quit and lose those changes.") }
        .confirmationDialog("Quit this background application?", isPresented: Binding(get: { quitBackground != nil }, set: { if !$0 { quitBackground = nil } }), titleVisibility: .visible) {
            Button("Quit application", role: .destructive) {
                if session.canInteract, let app = quitBackground { session.sendMessage("quitWindowless", ["pid": app["pid"]]) }
                quitBackground = nil
            }
        }
    }

    private func appRow(_ app: LauncherApp) -> some View {
        let launching = pendingLaunch == app.command
        return Button { launch(app) } label: {
            HStack(spacing: 12) {
                appIcon(app)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name).font(.system(size: 14, weight: .medium)).foregroundStyle(LWFATheme.foreground).lineLimit(1)
                    if !app.description.isEmpty {
                        Text(app.description).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if pinned.contains(app.id) { Image(systemName: "pin.fill").font(.system(size: 11)).foregroundStyle(LWFATheme.mutedForeground) }
                if app.terminal { PanelBadge(text: "term", icon: "terminal") }
                if launching { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .frame(minHeight: 52)
            .background(launching ? LWFATheme.accent.opacity(0.6) : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!mayLaunch(app) || launching)
        .contextMenu {
            Button(pinned.contains(app.id) ? "Unpin" : "Pin", systemImage: pinned.contains(app.id) ? "pin.slash" : "pin") { togglePin(app.id) }
        }
        .accessibilityLabel("Launch \(app.name)")
    }

    @ViewBuilder private func appIcon(_ app: LauncherApp) -> some View {
        if let image = icons[app.id] {
            Image(uiImage: image).resizable().scaledToFit().frame(width: 32, height: 32)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            let hue = Double(abs(app.id.hashValue) % 360) / 360
            Text(String(app.name.prefix(1)).uppercased()).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Color(hue: hue, saturation: 0.55, brightness: 0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }
    @ViewBuilder private var backgroundApps: some View {
        let items = session.serverMessages["windowless"]?["apps"].arrayValue ?? []
        if !items.isEmpty {
            PanelSection("Running with no window", description: "Background applications.") {
                PanelGroup {
                    ForEach(items.map { AdministrationRow(id: $0["pid"].uintValue, value: $0) }) { row in
                        FieldRow(row.value["program"].stringValue, hint: "pid \(row.id)") {
                            Button("Quit") { quitBackground = row.value }.panelButton(.secondary).disabled(!session.canInteract)
                        }
                    }
                }
            }
        }
    }
    @ViewBuilder private var outsideApp: some View {
        if let outside {
            PanelSection("Running on the desktop") {
                VStack(alignment: .leading, spacing: 10) {
                    Label("\(outside["program"].stringValue) is already open on the desktop", systemImage: "macbook.and.iphone")
                        .font(LWFATheme.label)
                    Text(attemptedPoliteClose ? "Waiting for it to close. It may be asking to save something on the desktop screen."
                         : "Apps that share a profile reuse their open window instead of starting a second copy.")
                        .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                    HStack(spacing: 8) {
                        Button("Leave it open") { self.outside = nil; attemptedPoliteClose = false }.panelButton(.outline, fullWidth: true)
                        if attemptedPoliteClose {
                            Button("Force quit") { confirmForce = true }.panelButton(.destructive, fullWidth: true).disabled(!session.canInteract)
                        } else {
                            Button("Close it and open here") { confirmOutside = true }.panelButton(.primary, fullWidth: true).disabled(!session.canInteract)
                        }
                    }
                }
                .panelCard()
            }
        }
    }
    private func refresh() { session.sendMessage("listApps"); requestIcons() }
    private func mayLaunch(_ app: LauncherApp) -> Bool {
        session.connected && session.canInteract && (session.allowedApps?.contains(app.id) ?? true)
    }
    private func launch(_ app: LauncherApp) {
        guard mayLaunch(app) else { return }
        recent.removeAll { $0 == app.id }; recent.insert(app.id, at: 0)
        recent = Array(recent.prefix(20))
        UserDefaults.standard.set(recent, forKey: historyKey + ".recent")
        run(app.command, terminal: app.terminal)
    }
    private func runCommand() {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        run(trimmed, terminal: terminal); command = ""
    }
    private func run(_ command: String, terminal: Bool) {
        guard session.connected, session.canInteract else { return }
        launchNotice = nil
        pendingLaunch = command
        session.sendMessage("spawn", ["command": .string(command), "terminal": .bool(terminal)])
    }
    private func togglePin(_ id: String) {
        if pinned.contains(id) { pinned.removeAll { $0 == id } } else { pinned.append(id) }
        UserDefaults.standard.set(pinned, forKey: historyKey + ".pinned")
    }
    private func requestIcons(entries: [WireValue]? = nil) {
        let source = entries.map { $0.map { LauncherApp(value: $0) } } ?? apps
        let missing = source.map(\.id).filter { !requestedIcons.contains($0) }
        for start in stride(from: 0, to: missing.count, by: 50) {
            let batch = Array(missing[start..<min(start + 50, missing.count)])
            session.sendMessage("requestIcons", ["ids": .array(batch.map(WireValue.string))])
            requestedIcons.formUnion(batch)
        }
    }
    private func mergeIcons(_ message: WireValue? = nil) {
        for item in (message ?? session.serverMessages["appIcons"])?["icons"].arrayValue ?? [] {
            let uri = item["data"].stringValue
            guard uri.hasPrefix("data:image/"), uri.utf8.count < 2_000_000,
                  let comma = uri.firstIndex(of: ","), uri[..<comma].hasSuffix(";base64"),
                  let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])), let image = UIImage(data: data) else { continue }
            icons[item["id"].stringValue] = image
        }
    }
    private func receiveOutside(_ value: WireValue) {
        if !value["command"].stringValue.isEmpty {
            if outside?["pid"] != value["pid"] { attemptedPoliteClose = false }
            outside = value; pendingLaunch = nil
        }
    }
    private func moveOutside(force: Bool) {
        guard session.connected, session.canInteract, let outside, !force || attemptedPoliteClose else { return }
        session.sendMessage("closeAndSpawn", ["command": outside["command"], "terminal": outside["terminal"], "pid": outside["pid"], "force": .bool(force)])
        attemptedPoliteClose = true
        pendingLaunch = outside["command"].stringValue
    }
}

// MARK: - Access

/// `AccessPanel.tsx`.
@MainActor
struct NativeAccessPanel: View {
    var session: NativeSession
    @State private var expanded: UInt64?
    @State private var deleting: WireValue?
    @State private var adding = false
    private var accounts: [WireValue] { session.serverMessages["accounts"]?["accounts"].arrayValue ?? [] }
    private var apps: [LauncherApp] { (session.serverMessages["apps"]?["apps"].arrayValue ?? []).map { LauncherApp(value: $0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelSection("This session") {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.shield").font(.system(size: 20)).foregroundStyle(LWFATheme.primary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.account.isEmpty ? "not connected" : session.account).font(LWFATheme.label)
                        Text("\(session.canInteract ? "Interact" : "View only") · \(session.allowedApps.map { "\($0.count) application\($0.count == 1 ? "" : "s")" } ?? "all apps")")
                            .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                    }
                    Spacer(minLength: 0)
                }.panelCard()
            }
            if !session.isOwner {
                DashedNote(text: "Sign in as the owner to manage accounts.")
            } else {
                PanelSection("Accounts", description: "Each account has its own password and permissions.") {
                    if session.serverMessages["accounts"] == nil {
                        HStack(spacing: 8) { ProgressView(); Text("Loading…") }.font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
                    } else if accounts.isEmpty {
                        DashedNote(text: "No additional accounts.")
                    } else {
                        PanelGroup {
                            ForEach(accounts.map { AdministrationRow(id: $0["id"].uintValue, value: $0) }) { row in
                                accountRow(row.value)
                            }
                        }
                    }
                }
                if adding {
                    NativeAccountForm(session: session, apps: apps, account: nil) { adding = false }
                } else {
                    Button { adding = true } label: { Label("Add an account", systemImage: "plus") }.panelButton(.outline, fullWidth: true)
                }
            }
        }
        .onAppear { if session.isOwner { session.sendMessage("listAccounts"); session.sendMessage("listApps") } }
        .gameInputSuspended(session, while: deleting != nil)
        .confirmationDialog("Delete this account?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete account", role: .destructive) {
                if session.connected, session.isOwner, let deleting { session.sendMessage("deleteAccount", ["id": deleting["id"]]) }
                deleting = nil
            }
        } message: { Text("The account will lose access to this lwfa server.") }
    }

    private func accountRow(_ account: WireValue) -> some View {
        let id = account["id"].uintValue
        let interact = account["permissions"]["mode"].stringValue == "interact"
        let open = expanded == id
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(account["name"].stringValue).font(LWFATheme.label)
                PanelBadge(text: interact ? "Interact" : "View", icon: interact ? "hand.raised" : "eye")
                Spacer(minLength: 0)
                Button(open ? "Done" : "Edit") { expanded = open ? nil : id }.panelButton(.ghost)
            }
            .frame(minHeight: LWFATheme.hit).padding(.horizontal, 12).padding(.vertical, 4)
            if open {
                NativeAccountForm(session: session, apps: apps, account: account) { expanded = nil }
                    .padding(12)
                    .background(LWFATheme.primary.opacity(0.03))
                    .overlay(alignment: .top) { Rectangle().fill(LWFATheme.border).frame(height: 1) }
                Button { deleting = account } label: { Label("Delete account", systemImage: "trash") }
                    .panelButton(.ghost, fullWidth: true, danger: true)
            }
        }
    }
}

/// Inline editor for a new or existing account.
@MainActor
private struct NativeAccountForm: View {
    var session: NativeSession
    var apps: [LauncherApp]
    let account: WireValue?
    var done: () -> Void
    @State private var name = ""
    @State private var password = ""
    @State private var mode = "view"
    @State private var allApps = false
    @State private var allowed: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if account == nil {
                HStack {
                    Text("New account").font(LWFATheme.label)
                    Spacer()
                    IconButton(systemImage: "xmark", label: "Cancel", action: done)
                }
                TextField("tablet", text: $name).textFieldStyle(PanelTextFieldStyle())
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Name")
            }
            VStack(alignment: .leading, spacing: 6) {
                SecureField(account == nil ? "Password" : "New password (leave blank to keep)", text: $password)
                    .textFieldStyle(PanelTextFieldStyle()).textContentType(.newPassword)
                Text("Use this password to sign in to the account.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
            }
            SegmentedChoice(["view", "interact"], selection: $mode) { value in
                Label(value == "view" ? "View" : "Interact", systemImage: value == "view" ? "eye" : "hand.raised")
            }
            HStack {
                Text("Applications").font(LWFATheme.label)
                Spacer()
                SegmentedChoice([true, false], selection: $allApps) { Text($0 ? "All" : "Selected") }.frame(width: 160)
            }
            if !allApps {
                if apps.isEmpty {
                    Text("Reading applications…").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(apps) { app in
                                let selected = allowed.contains(app.id)
                                Button {
                                    if selected { allowed.remove(app.id) } else { allowed.insert(app.id) }
                                } label: {
                                    HStack {
                                        Text(app.name).font(LWFATheme.body)
                                        Spacer()
                                        if selected { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)) }
                                    }
                                    .foregroundStyle(selected ? LWFATheme.primary : LWFATheme.foreground)
                                    .padding(.horizontal, 12).frame(minHeight: LWFATheme.hit)
                                    .background(selected ? LWFATheme.primary.opacity(0.15) : .clear)
                                    .contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                Rectangle().fill(LWFATheme.border).frame(height: 1)
                            }
                        }
                    }
                    .frame(maxHeight: 192)
                    .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous).strokeBorder(LWFATheme.border))
                    if allowed.isEmpty { Text("No applications may be launched.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground) }
                }
            }
            Button(account == nil ? "Create" : "Save", action: save)
                .panelButton(.primary, fullWidth: true)
                .disabled(!session.connected || !session.isOwner || (account == nil && (name.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)))
        }
        .onAppear {
            if let account {
                name = account["name"].stringValue
                mode = account["permissions"]["mode"].stringValue
                let list = account["permissions"]["allowedApps"]
                allApps = list == .null
                allowed = Set(list.arrayValue.map(\.stringValue))
            }
        }
    }
    private func save() {
        guard session.connected, session.isOwner else { return }
        let permissions: WireValue = .object(["mode": .string(mode), "allowedApps": allApps ? .null : .array(allowed.sorted().map(WireValue.string))])
        if let account {
            session.sendMessage("updateAccount", ["id": account["id"], "permissions": permissions, "password": password.isEmpty ? .null : .string(password)])
        } else {
            session.sendMessage("createAccount", ["name": .string(name.trimmingCharacters(in: .whitespaces)), "password": .string(password), "permissions": permissions])
        }
        password = ""
        done()
    }
}

// MARK: - Connections

/// `ConnectionsPanel.tsx`.
@MainActor
struct NativeSessionsPanel: View {
    var session: NativeSession
    @State private var kicking: PeerInfo?
    @State private var saved: [SavedNativeServer] = []
    @State private var adding = false
    @State private var editing: SavedNativeServer?
    @State private var switching: SavedNativeServer?

    private var currentAddress: String? { session.publicServerURL?.absoluteString }
    private var currentSaved: Bool { saved.contains { $0.address == currentAddress } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PanelSection("Connected to") {
                HStack(spacing: 12) {
                    StatusDot(tone: session.statusTone)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.statusLabel).font(LWFATheme.label)
                        Text(currentAddress ?? "Disconnected").font(LWFATheme.mono).foregroundStyle(LWFATheme.mutedForeground).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if !session.account.isEmpty { PanelBadge(text: session.account) }
                }.panelCard()
                if !currentSaved, let currentAddress {
                    Button { saveCurrent(currentAddress) } label: { Label("Save this machine", systemImage: "plus") }.panelButton(.outline, fullWidth: true)
                }
            }
            PanelSection("Attached devices", description: "One device controls the layout.") {
                if session.peers.isEmpty { DashedNote(text: "No other devices.") }
                else { PanelGroup { ForEach(session.peers) { peer in peerRow(peer) } } }
                if !session.primary && session.canInteract {
                    Button { session.sendMessage("takeControl") } label: { Label("Drive from this device", systemImage: "gamecontroller") }
                        .panelButton(.outline, fullWidth: true).disabled(!session.connected)
                }
            }
            PanelSection("Saved", description: "Stored on this device. Switching reconnects.") {
                if saved.isEmpty { DashedNote(text: "No saved machines.") }
                else {
                    PanelGroup {
                        ForEach(saved) { server in
                            HStack(spacing: 4) {
                                Button { switching = server } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "display").font(.system(size: 16)).foregroundStyle(LWFATheme.mutedForeground).frame(width: 24)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(server.name).font(LWFATheme.body)
                                            Text(server.address).font(LWFATheme.mono).foregroundStyle(LWFATheme.mutedForeground).lineLimit(1)
                                        }
                                        Spacer(minLength: 0)
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                IconButton(systemImage: "pencil", label: "Edit \(server.name)") { editing = server }
                                IconButton(systemImage: "trash", label: "Forget \(server.name)", tint: LWFATheme.destructive) {
                                    saved.removeAll { $0.id == server.id }; persist()
                                }
                            }
                            .frame(minHeight: LWFATheme.hit).padding(.horizontal, 12).padding(.vertical, 4)
                        }
                    }
                }
            }
            if adding {
                NativeServerForm(session: session, server: nil) { server in
                    saved.removeAll { $0.id == server.id }; saved.append(server); persist(); adding = false
                } cancel: { adding = false }
            } else if let editing {
                NativeServerForm(session: session, server: editing) { server in
                    saved.removeAll { $0.id == editing.id || $0.id == server.id }; saved.append(server); persist(); self.editing = nil
                } cancel: { self.editing = nil }
            } else {
                Button { adding = true } label: { Label("Add a machine", systemImage: "plus") }.panelButton(.outline, fullWidth: true)
            }
        }
        .onAppear { saved = SavedNativeServer.load() }
        .gameInputSuspended(session, while: kicking != nil || switching != nil)
        .confirmationDialog("Disconnect this device?", isPresented: Binding(get: { kicking != nil }, set: { if !$0 { kicking = nil } }), titleVisibility: .visible) {
            Button("Disconnect device", role: .destructive) {
                if session.isOwner, let kicking, kicking.id != session.sessionID { session.sendMessage("endSession", ["session": .uint(kicking.id)]) }
                kicking = nil
            }
        }
        .confirmationDialog(switching?.name ?? "Switch machine", isPresented: Binding(get: { switching != nil }, set: { if !$0 { switching = nil } }), titleVisibility: .visible) {
            Button("Connect") {
                if let server = switching { connect(server) }
                switching = nil
            }
        } message: { Text("Connecting closes the current connection and uses the password saved for that machine.") }
    }

    private func peerRow(_ peer: PeerInfo) -> some View {
        let device = peer.device.lowercased()
        let icon = device.contains("ipad") ? "ipad" : (device.contains("iphone") || device.contains("android")) ? "iphone" : "display"
        let me = peer.id == session.sessionID
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 16)).foregroundStyle(LWFATheme.mutedForeground).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text((peer.device.isEmpty ? peer.account : peer.device) + (me ? " (this one)" : "")).font(LWFATheme.label)
                    Text(peer.account).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                }
                Spacer(minLength: 0)
                if peer.mode == .view { PanelBadge(text: "Viewing", icon: "eye") }
                if peer.primary { PanelBadge(text: "Driving", icon: "gamecontroller", solid: true) }
            }
            if session.isOwner && !me {
                HStack(spacing: 8) {
                    Button {
                        session.sendMessage("setSessionMode", ["session": .uint(peer.id), "mode": .string(peer.mode == .interact ? "view" : "interact")])
                    } label: {
                        Label(peer.mode == .interact ? "Viewing only" : "Allow input", systemImage: peer.mode == .interact ? "eye" : "pencil")
                    }.panelButton(.outline, fullWidth: true)
                    Button { kicking = peer } label: { Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right") }
                        .panelButton(.outline, fullWidth: true, danger: true)
                }.disabled(!session.connected)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private func connect(_ server: SavedNativeServer) {
        if let index = saved.firstIndex(where: { $0.id == server.id }) { saved[index].lastUsed = Date().timeIntervalSince1970; persist() }
        session.connect(address: server.address, token: "", allowInsecure: server.allowHTTP)
    }
    private func saveCurrent(_ address: String) {
        guard let url = session.publicServerURL else { return }
        saved.append(SavedNativeServer(name: url.host ?? address, address: address, allowHTTP: url.scheme == "http", lastUsed: Date().timeIntervalSince1970))
        persist()
    }
    private func persist() { SavedNativeServer.save(saved); saved = SavedNativeServer.load() }
}

/// The inline "Add a machine" form.
@MainActor
private struct NativeServerForm: View {
    var session: NativeSession
    let server: SavedNativeServer?
    var save: (SavedNativeServer) -> Void
    var cancel: () -> Void
    @State private var name = ""
    @State private var address = ""
    @State private var password = ""
    @State private var allowHTTP = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(server == nil ? "Add a machine" : "Edit machine").font(LWFATheme.label)
                Spacer()
                IconButton(systemImage: "xmark", label: "Cancel", action: cancel)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Address").font(LWFATheme.label)
                TextField("192.168.1.51", text: $address).textFieldStyle(PanelTextFieldStyle(mono: true))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("Port 6734 is assumed. https:// is the default; http:// needs the switch below.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Password").font(LWFATheme.label)
                SecureField(server == nil ? "Password" : "New password (leave blank to keep)", text: $password).textFieldStyle(PanelTextFieldStyle())
                    .textContentType(.password)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Name (optional)").font(LWFATheme.label)
                TextField("desktop", text: $name).textFieldStyle(PanelTextFieldStyle())
            }
            PanelGroup { SwitchRow(label: "Allow unencrypted HTTP", isOn: $allowHTTP) }
            if let error { Text(error).font(LWFATheme.hint).foregroundStyle(LWFATheme.destructive) }
            Button { submit() } label: { Label("Save", systemImage: "checkmark") }
                .panelButton(.primary, fullWidth: true)
                .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .panelCard()
        .onAppear { name = server?.name ?? ""; address = server?.address ?? ""; allowHTTP = server?.allowHTTP ?? false }
    }
    private func submit() {
        do {
            let insecure = allowHTTP || address.lowercased().hasPrefix("http://")
            let endpoint = try ServerEndpoint(address, allowInsecure: insecure)
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !password.isEmpty { try session.saveCredential(address: endpoint.description, allowInsecure: insecure, password: password) }
            save(SavedNativeServer(name: trimmed.isEmpty ? (endpoint.publicURL.host ?? endpoint.description) : trimmed,
                                   address: endpoint.description, allowHTTP: endpoint.publicURL.scheme == "http", lastUsed: server?.lastUsed))
            password = ""
        } catch ProtocolError.insecureEndpoint {
            error = "Turn on unencrypted HTTP for an http:// address."
        } catch {
            self.error = "Enter a valid address, such as https://your-computer."
        }
    }
}
#endif
