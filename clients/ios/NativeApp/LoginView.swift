#if os(iOS)
import SwiftUI
import LWFACore

/// The connect screen from `Login.tsx`, plus the fields a native client needs
/// that a same-origin web page does not: the machine's address and an
/// explicit opt-in for unencrypted HTTP.
struct LoginView: View {
    @Bindable var session: NativeSession
    var openSettings: () -> Void
    @State private var address = UserDefaults.standard.string(forKey: "server") ?? ""
    @State private var password = ""
    @State private var allowHTTP = UserDefaults.standard.bool(forKey: "server.allowHTTP")
    @State private var savedServers: [SavedNativeServer] = []
    @FocusState private var focus: Field?
    @Environment(\.colorScheme) private var colorScheme
    private enum Field { case address, password }

    private var insecureAddress: Bool { address.lowercased().hasPrefix("http://") }
    private var canConnect: Bool { !session.connecting && !address.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        ZStack {
            LWFATheme.background.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 24) {
                    header
                    form
                    if session.connecting {
                        Button("Cancel", role: .cancel) { session.disconnect() }.panelButton(.outline, fullWidth: true)
                    }
                    if !savedServers.isEmpty { saved }
                }
                .frame(maxWidth: 384)
                .padding(24)
                .frame(maxWidth: .infinity)
                .padding(.top, 48)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .overlay(alignment: .topTrailing) {
            Button(action: openSettings) {
                Image(systemName: "gearshape").font(.system(size: 17, weight: .medium))
                    .frame(width: LWFATheme.hit, height: LWFATheme.hit)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel("Device settings")
            .padding(12)
        }
        .onAppear {
            savedServers = SavedNativeServer.load()
            focus = address.isEmpty ? .address : .password
        }
        .onChange(of: session.connecting) { _, connecting in if !connecting { savedServers = SavedNativeServer.load() } }
    }

    private var header: some View {
        VStack(spacing: 12) {
            LWFALockup(height: 40)
            Text("Connect to your lwfa computer.")
                .font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
                .multilineTextAlignment(.center)
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Address").font(LWFATheme.label)
                TextField("https://your-computer", text: $address)
                    .textFieldStyle(PanelTextFieldStyle(mono: true))
                    .keyboardType(.URL).textContentType(.URL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .address)
                    .onSubmit { focus = .password }
                    .onChange(of: address) { _, _ in session.problem = nil }
                Text("Use your trusted HTTPS address. Include a port if your server requires one.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Password").font(LWFATheme.label)
                SecureField("Password", text: $password)
                    .textFieldStyle(PanelTextFieldStyle())
                    .textContentType(.password)
                    .submitLabel(.go)
                    .focused($focus, equals: .password)
                    .onSubmit { if canConnect { connect() } }
                    .onChange(of: password) { _, _ in session.problem = nil }
                Text("Leave it blank to use the password saved on this iPad.").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
            }
            if insecureAddress || allowHTTP {
                PanelGroup {
                    SwitchRow(label: "Allow unencrypted HTTP", hint: "Passwords and pixels travel in the clear.", isOn: $allowHTTP)
                }
            }
            if let problem = session.problem {
                Text(problem).font(LWFATheme.body).foregroundStyle(LWFATheme.destructive)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            Button(action: connect) {
                HStack(spacing: 8) {
                    if session.connecting { ProgressView().controlSize(.small).tint(LWFATheme.primaryForeground) }
                    Text("Connect").font(.system(size: 14, weight: .medium))
                }
            }
            .panelButton(.primary, fullWidth: true)
            .disabled(!canConnect)
            .keyboardShortcut(.defaultAction)
        }
    }

    private var saved: some View {
        PanelSection("Saved machines", description: "Stored on this device.") {
            PanelGroup {
                ForEach(savedServers) { server in
                    Button {
                        address = server.address; allowHTTP = server.allowHTTP
                        session.connect(address: server.address, token: "", allowInsecure: server.allowHTTP)
                        password = ""
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "display").font(.system(size: 16)).foregroundStyle(LWFATheme.mutedForeground).frame(width: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(server.name).font(LWFATheme.body).foregroundStyle(LWFATheme.foreground)
                                Text(server.address).font(LWFATheme.mono).foregroundStyle(LWFATheme.mutedForeground).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: LWFATheme.hit).padding(.horizontal, 12).padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(session.connecting)
                }
            }
        }
    }

    private func connect() {
        session.connect(address: address, token: password, allowInsecure: allowHTTP)
        password = ""
    }
}

/// The horizontal lockup: the mark with the wordmark set in bold monospace,
/// matching `lockup-horizontal-on-*.svg` (JetBrains Mono Bold, tracking -3/100).
struct LWFALockup: View {
    var height: CGFloat
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        HStack(spacing: height * 0.16) {
            LWFAMark(size: height)
            Text("lwfa").font(.system(size: height * 0.58, weight: .bold, design: .monospaced)).kerning(-height * 0.03)
                .foregroundStyle(LWFATheme.foreground)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("lwfa")
    }
}

/// The brand mark, drawn for its ground. Two files, never a recolour.
struct LWFAMark: View {
    var size: CGFloat
    var forceDark = false
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        let name = forceDark || colorScheme == .dark ? "mark-on-dark" : "mark-on-light"
        Group {
            if let url = Bundle.module.url(forResource: name, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().interpolation(.high).scaledToFit()
            } else {
                Image(systemName: "rectangle.split.3x1").resizable().scaledToFit().foregroundStyle(LWFATheme.primary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A machine remembered on this device (`ConnectionsPanel` saved list).
struct SavedNativeServer: Codable, Identifiable, Equatable {
    var id: String { address }
    var name: String
    var address: String
    var allowHTTP: Bool
    var lastUsed: Double?

    static let storageKey = "lwfa.native.savedServers"
    static func load() -> [Self] {
        guard let data = UserDefaults.standard.data(forKey: storageKey), let values = try? JSONDecoder().decode([Self].self, from: data) else { return [] }
        return values.sorted { ($0.lastUsed ?? 0) > ($1.lastUsed ?? 0) }
    }
    static func save(_ servers: [Self]) {
        let sorted = servers.sorted { ($0.lastUsed ?? 0) > ($1.lastUsed ?? 0) }
        if let data = try? JSONEncoder().encode(sorted) { UserDefaults.standard.set(data, forKey: storageKey) }
    }
}
#endif
