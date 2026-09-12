#if os(iOS)
import SwiftUI
import UniformTypeIdentifiers
import PhotosUI
import QuickLook
import ImageIO
import LWFACore

private struct NativeClipEntry: Identifiable {
    let value: WireValue
    var id: UInt64 { value["id"].uintValue }
    var kind: String { value["kind"].stringValue }
    var preview: String { value["preview"].stringValue }
    var name: String {
        let path = value["path"].stringValue
        if !path.isEmpty { return URL(fileURLWithPath: path).lastPathComponent }
        return kind == "image" ? "Clipboard image.png" : "Clipboard text.txt"
    }
}

private struct NativePresentedFile: Identifiable {
    let id = UUID()
    let url: URL
}

/// `ClipboardPanel.tsx`.
struct NativeClipboardPanel: View {
    var session: NativeSession
    private var uploader: NativeUploader
    @State private var entries: [NativeClipEntry] = []
    @State private var channel: UInt64?
    @State private var ticket = ""
    @State private var awaiting: UInt64?
    @State private var more = false
    @State private var draft = ""
    @State private var status: String?
    @State private var clearConfirmation = false
    @State private var importing = false
    @State private var importingFolder = false
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var thumbnails = NativeClipboardThumbnails()
    @State private var transfer: Task<Void, Never>?
    @State private var fetching = false
    @State private var share: NativePresentedFile?
    @State private var preview: NativePresentedFile?
    @State private var copiedID: UInt64?

    init(session: NativeSession) {
        self.session = session
        self.uploader = session.clipboardUploader
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !session.canInteract {
                DashedNote(text: "Clipboard access requires permission to interact.")
            } else if !session.connected {
                DashedNote(text: session.connecting || session.reconnecting ? "Connecting…" : "Not connected to the machine.")
            } else {
                sendSection
                if !uploader.rows.isEmpty || uploader.error != nil { NativeUploadSection(uploader: uploader) }
                history
            }
        }
        .onAppear {
            if let ready = session.serverMessages["clipReady"] { accept("clipReady", ready) }
        }
        .onReceive(session.serverEvents) { type, value in accept(type, value) }
        .onChange(of: session.connected) { _, connected in
            if !connected { stop(); entries = []; channel = nil; ticket = ""; awaiting = nil }
        }
        .onChange(of: session.canInteract) { _, allowed in if !allowed { stop() } }
        .onDisappear { transfer?.cancel(); transfer = nil; fetching = false }
        .fileImporter(isPresented: $importing, allowedContentTypes: importingFolder ? [.folder] : [.data], allowsMultipleSelection: !importingFolder) { result in
            if case .success(let urls) = result { uploader.add(urls) }
            if case .failure = result { status = "Files could not be opened" }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task {
                let urls = await PickedMedia.copies(of: items)
                if urls.isEmpty { status = "The selected items could not be read" } else { uploader.add(urls) }
            }
        }
        .gameInputSuspended(session, while: clearConfirmation || importing || share != nil || preview != nil)
        .confirmationDialog("Clear clipboard history?", isPresented: $clearConfirmation, titleVisibility: .visible) {
            Button("Clear history", role: .destructive) { session.sendMessage("clipClear") }
        } message: { Text("This also clears the host's current clipboard.") }
        .sheet(item: $share) { item in NativeShareSheet(url: item.url).onDisappear { NativeDownloads.remove(item.url) } }
        .sheet(item: $preview) { item in NativeQuickLook(url: item.url).onDisappear { NativeDownloads.remove(item.url) } }
    }

    private var sendSection: some View {
        PanelSection("Send") {
            HStack(spacing: 8) {
                Button(action: pasteFromDevice) { Label("Send clipboard", systemImage: "doc.on.clipboard") }.panelButton(.outline, fullWidth: true)
                Menu {
                    Button("Photos and videos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
                    Button("Files", systemImage: "doc") { importingFolder = false; importing = true }
                    Button("A folder", systemImage: "folder") { importingFolder = true; importing = true }
                } label: { Label("Choose files", systemImage: "arrow.up.circle") }
                .panelButton(.outline, fullWidth: true)
                .disabled(channel == nil)
            }
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    Text("Paste text or a file here").font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
                        .padding(.horizontal, 13).padding(.vertical, 12)
                }
                TextEditor(text: $draft).font(LWFATheme.body).scrollContentBackground(.hidden)
                    .frame(minHeight: 64, maxHeight: 160).padding(8)
                    .accessibilityLabel("Text or files to send")
            }
            .panelCard(padding: 0)
            Button {
                session.sendMessage("clipSetText", ["text": .string(draft)])
                draft = ""; status = "Text sent."
            } label: { Label("Send", systemImage: "paperplane") }
            .panelButton(.primary, fullWidth: true)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if let status { Text(status).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground) }
            if fetching { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Retrieving file") }.font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground) }
        }
    }

    private var history: some View {
        PanelSection("History") {
            if entries.isEmpty {
                if awaiting != nil {
                    VStack(spacing: 8) {
                        ForEach(0..<3, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous).fill(LWFATheme.muted).frame(height: 64)
                        }
                    }
                } else { DashedNote(text: "No clipboard history.") }
            } else {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in entryCard(entry, current: index == 0) }
                if more {
                    Button(awaiting != nil ? "Loading" : "Show older") { load(more: true) }.panelButton(.outline, fullWidth: true).disabled(awaiting != nil)
                }
                Button("Clear history", role: .destructive) { clearConfirmation = true }.panelButton(.ghost, fullWidth: true, danger: true)
            }
        }
    }

    private func entryCard(_ entry: NativeClipEntry, current: Bool) -> some View {
        let kind = entry.kind
        let icon = kind == "image" ? "photo" : kind == "files" ? "doc" : "textformat"
        let origin = entry.value["device"].stringValue
        return VStack(spacing: 0) {
            if current {
                HStack {
                    Text("ON THE CLIPBOARD").font(.system(size: 10.5, weight: .semibold)).kerning(0.5).foregroundStyle(LWFATheme.primary)
                    Spacer()
                    Text(relative(entry.value["at"].doubleValue / 1000)).font(LWFATheme.tiny).foregroundStyle(LWFATheme.mutedForeground)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(LWFATheme.primary.opacity(0.10))
                .overlay(alignment: .bottom) { Rectangle().fill(LWFATheme.border).frame(height: 1) }
            }
            HStack(alignment: .top, spacing: 12) {
                Group {
                    if kind == "image" {
                        NativeClipboardThumbnail(store: thumbnails,
                            url: session.connected && session.canInteract ? try? endpoint(entry.id, download: false, thumbnail: true) : nil)
                    } else {
                        Image(systemName: icon).font(.system(size: 18)).foregroundStyle(LWFATheme.mutedForeground)
                            .frame(width: 48, height: 48)
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 3])).foregroundStyle(LWFATheme.border))
                    }
                }
                .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.preview.isEmpty ? entry.name : entry.preview).font(LWFATheme.mono).lineLimit(kind == "text" ? 3 : 1)
                        .textSelection(.enabled)
                    Text("\(origin.isEmpty ? "Device" : origin) · \(nativeByteCount(entry.value["bytes"].uintValue))\(current ? "" : " · " + relative(entry.value["at"].doubleValue / 1000))")
                        .font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            HStack(spacing: 6) {
                Button(copiedID == entry.id ? "Copied here" : "Copy here") { copy(entry) }.panelButton(.outline).disabled(fetching)
                if !current {
                    Button { session.sendMessage("clipUse", ["id": .uint(entry.id)]) } label: { Label("Put back", systemImage: "display") }.panelButton(.outline)
                }
                if kind == "image" || entry.value["path"] != .null {
                    Menu {
                        Button("Preview", systemImage: "eye") { download(entry, previewing: true) }
                        Button("Save or share", systemImage: "square.and.arrow.up") { download(entry, previewing: false) }
                    } label: { Label("Download", systemImage: "arrow.down.circle") }.panelButton(.outline).disabled(fetching)
                }
                Spacer(minLength: 0)
                IconButton(systemImage: "trash", label: "Forget this entry", tint: LWFATheme.mutedForeground) {
                    session.sendMessage("clipDrop", ["id": .uint(entry.id)])
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 12)
        }
        .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous).strokeBorder(current ? LWFATheme.primary.opacity(0.5) : LWFATheme.border))
        .clipShape(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
    }

    private func relative(_ seconds: Double) -> String {
        let elapsed = Date().timeIntervalSince1970 - seconds
        if elapsed < 45 { return "just now" }
        if elapsed < 3600 { return "\(Int(elapsed / 60)) min ago" }
        if elapsed < 86_400 { return "\(Int(elapsed / 3600)) h ago" }
        return Date(timeIntervalSince1970: seconds).formatted(.dateTime.day().month(.abbreviated))
    }

    private func accept(_ type: String, _ value: WireValue) {
        switch type {
        case "clipReady":
            guard session.connected, session.canInteract, let base = session.publicServerURL else { return }
            channel = value["channel"].uintValue; ticket = value["ticket"].stringValue
            uploader.configure(base: base, request: channel!, ticket: ticket)
            load(more: false)
        case "clipHistory":
            guard awaiting == value["request"].uintValue else { return }
            awaiting = nil
            for item in value["items"].arrayValue {
                let entry = NativeClipEntry(value: item)
                if !entries.contains(where: { $0.id == entry.id }) { entries.append(entry) }
            }
            more = value["more"].boolValue
        case "clipAdded":
            let entry = NativeClipEntry(value: value["item"])
            entries.removeAll { $0.id == entry.id }; entries.insert(entry, at: 0)
        case "clipDropped": entries.removeAll { $0.id == value["id"].uintValue }
        case "clipCleared": entries = []; more = false
        default: break
        }
    }

    private func load(more paging: Bool) {
        guard session.connected, session.canInteract else { return }
        let before = paging ? entries.last.map { WireValue.uint($0.id) } ?? .null : .null
        if !paging { entries = []; more = false }
        let request = session.nextRequestID(); awaiting = request
        session.sendMessage("clipList", ["request": .uint(request), "before": before, "limit": .uint(20)])
    }

    private func endpoint(_ id: UInt64, download: Bool, thumbnail: Bool = false) throws -> URL {
        guard let base = session.publicServerURL, let channel, !ticket.isEmpty else {
            throw NativeTransferError.message("Clipboard access is not ready")
        }
        var query = ["channel": String(channel), "ticket": ticket, "id": String(id)]
        if download { query["download"] = "1" }
        if thumbnail { query["thumb"] = "1" }
        return try FileTransferProtocol.endpoint(base: base, operation: "clip", query: query)
    }

    private func pasteFromDevice() {
        guard session.connected, session.canInteract else { return }
        let board = UIPasteboard.general
        if board.hasImages, let data = board.data(forPasteboardType: UTType.png.identifier) ?? board.image?.pngData() {
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lwfa-upload-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let url = directory.appendingPathComponent("Clipboard image.png")
                try data.write(to: url, options: .atomic)
                uploader.add([url]); status = "Image sent."
            } catch { status = "The clipboard image could not be prepared" }
        } else if let urls = board.urls?.filter(\.isFileURL), !urls.isEmpty {
            uploader.add(urls)
        } else if let text = board.string, !text.isEmpty {
            session.sendMessage("clipSetText", ["text": .string(text)]); status = "Text sent."
        } else { status = "Clipboard is empty." }
    }

    private func copy(_ entry: NativeClipEntry) {
        func done(_ message: String) {
            status = message; copiedID = entry.id
            Task { @MainActor in try? await Task.sleep(for: .milliseconds(1500)); if copiedID == entry.id { copiedID = nil } }
        }
        if entry.kind == "text", entry.value["whole"].boolValue {
            UIPasteboard.general.string = entry.preview; done("Copied to iPad"); return
        }
        if entry.kind == "files", !entry.value["path"].stringValue.isEmpty {
            UIPasteboard.general.string = entry.value["path"].stringValue; done("Path copied to iPad"); return
        }
        fetching = true
        transfer = Task {
            do {
                let url = try await NativeDownloads.fetch(endpoint(entry.id, download: false), name: entry.name)
                defer { NativeDownloads.remove(url) }
                try Task.checkCancellation()
                guard session.connected, session.canInteract else { return }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 32 * 1024 * 1024 else {
                    throw NativeTransferError.message("This clipboard item is too large to copy. Use Save or share")
                }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                if entry.kind == "image" {
                    let mime = entry.value["mime"].stringValue
                    UIPasteboard.general.setData(data, forPasteboardType: UTType(mimeType: mime)?.identifier ?? UTType.png.identifier)
                } else if let text = String(data: data, encoding: .utf8) { UIPasteboard.general.string = text }
                else { throw NativeTransferError.message("This item is not UTF-8 text") }
                done("Copied to iPad")
            } catch is CancellationError {} catch { status = (error as? NativeTransferError)?.errorDescription ?? "The clipboard item could not be retrieved" }
            fetching = false; transfer = nil
        }
    }

    private func download(_ entry: NativeClipEntry, previewing: Bool) {
        fetching = true
        transfer = Task {
            do {
                let url = try await NativeDownloads.fetch(endpoint(entry.id, download: true), name: entry.name)
                guard !Task.isCancelled, session.connected, session.canInteract else { NativeDownloads.remove(url); return }
                let item = NativePresentedFile(url: url)
                if previewing { preview = item } else { share = item }
            } catch is CancellationError {} catch { status = (error as? NativeTransferError)?.errorDescription ?? "The file could not be downloaded" }
            fetching = false; transfer = nil
        }
    }

    private func stop() { transfer?.cancel(); transfer = nil; fetching = false; uploader.cancel() }
}

/// Cache only small rendered thumbnails; original images remain on disk.
@MainActor
@Observable private final class NativeClipboardThumbnails {
    private let cache = NSCache<NSURL, UIImage>()
    private var active = 0

    init() { cache.countLimit = 32; cache.totalCostLimit = 8 * 1024 * 1024 }

    func image(_ url: URL) async throws -> UIImage? {
        if let cached = cache.object(forKey: url as NSURL) { return cached }
        while active >= 3 { try await Task.sleep(for: .milliseconds(50)) }
        try Task.checkCancellation()
        active += 1
        defer { active -= 1 }
        let local = try await NativeDownloads.fetch(url, name: "thumbnail")
        defer { NativeDownloads.remove(local) }
        try Task.checkCancellation()
        let size = try local.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 1024 * 1024, let source = CGImageSourceCreateWithURL(local as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.int64Value > 0, width.int64Value <= 16384,
              height.int64Value > 0, height.int64Value <= 16384,
              width.int64Value * height.int64Value <= 67_108_864 else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 256]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let image = UIImage(cgImage: cgImage)
        cache.setObject(image, forKey: url as NSURL, cost: cgImage.bytesPerRow * cgImage.height)
        return image
    }
}

private struct NativeClipboardThumbnail: View {
    let store: NativeClipboardThumbnails
    let url: URL?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: "photo").foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, minHeight: 96, maxHeight: 160)
        .accessibilityLabel("Clipboard image preview")
        .task(id: url) {
            image = nil
            guard let url else { return }
            let downloaded = try? await store.image(url)
            guard !Task.isCancelled else { return }
            image = downloaded
        }
    }
}

struct NativeFileChooser: View {
    var session: NativeSession
    let request: WireValue
    @Environment(\.dismiss) private var dismiss
    @State private var uploader = NativeUploader()
    @State private var currentPath = ""
    @State private var typedPath = "~"
    @State private var loading = false
    @State private var listed = false
    @State private var entries: [WireValue] = []
    @State private var selected: Set<String> = []
    @State private var saveName = ""
    @State private var search = ""
    @State private var showHidden = false
    @State private var showAll = false
    @State private var sortBy = "name"
    @State private var status: String?
    @State private var truncated = false
    @State private var importing = false
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var answered = false
    @State private var replacing = false
    @State private var detailsPath: String?
    @State private var details: WireValue?
    @State private var preview: NativePresentedFile?
    @State private var transfer: Task<Void, Never>?
    @State private var fetching = false

    private var requestID: UInt64 { request["request"].uintValue }
    private var mode: String { request["mode"].stringValue }
    private var wantsDirectory: Bool { request["directory"].boolValue }
    private var multiple: Bool { request["multiple"].boolValue }
    private var patterns: [String] {
        request["filters"].arrayValue.flatMap { $0["patterns"].arrayValue.map(\.stringValue) }
    }
    private var canConfirm: Bool {
        guard session.connected, session.canInteract, !answered, !uploader.busy else { return false }
        if mode == "save" { return listed && validName }
        if mode == "saveFiles" { return listed }
        return !selected.isEmpty || uploader.rows.contains(where: \.done)
    }
    private var validName: Bool {
        let name = saveName.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && name != "." && name != ".." && !name.contains("/") && !name.contains("\0")
    }
    private var displayed: [WireValue] {
        entries.filter { item in
            let name = item["name"].stringValue
            return (showHidden || !name.hasPrefix(".")) && (search.isEmpty || name.localizedCaseInsensitiveContains(search)) &&
                (showAll || mode != "open" || item["dir"].boolValue || matches(name))
        }.sorted { a, b in
            if a["dir"].boolValue != b["dir"].boolValue { return a["dir"].boolValue }
            if sortBy == "size", a["size"] != b["size"] { return a["size"].uintValue > b["size"].uintValue }
            if sortBy == "date", a["modified"] != b["modified"] { return a["modified"].doubleValue > b["modified"].doubleValue }
            return a["name"].stringValue.localizedStandardCompare(b["name"].stringValue) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if mode == "open" {
                    Section("From this iPad") {
                        Group {
                            if wantsDirectory {
                                Button("Upload a folder", systemImage: "square.and.arrow.up") { importing = true }
                            } else {
                                Button("Photos and videos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
                                Button("Files", systemImage: "square.and.arrow.up") { importing = true }
                            }
                        }
                            .disabled(!session.connected || !session.canInteract || (!multiple && (uploader.busy || uploader.rows.contains(where: \.done))))
                        Text("Completed uploads are included when you choose Open.").font(.footnote).foregroundStyle(.secondary)
                    }
                    if !uploader.rows.isEmpty || uploader.error != nil { NativeUploadSection(uploader: uploader) }
                }
                Section("On the host") {
                    HStack {
                        Menu {
                            ForEach(Array(request["places"].arrayValue.enumerated()), id: \.offset) { _, place in
                                Button(place["name"].stringValue) { browse(place["path"].stringValue) }
                            }
                            Button("Home") { browse("~") }
                            Button("Root") { browse("/") }
                        } label: { Image(systemName: "folder").frame(minWidth: 36) }
                        TextField("Folder path", text: $typedPath).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .onSubmit { browse(typedPath) }
                        Button("Go", systemImage: "arrow.right") { browse(typedPath) }.labelStyle(.iconOnly)
                    }.disabled(loading || !session.connected || !session.canInteract)
                    HStack {
                        Button("Up", systemImage: "arrow.up") { browse(URL(fileURLWithPath: currentPath).deletingLastPathComponent().path) }
                            .disabled(currentPath.isEmpty || currentPath == "/" || loading)
                        Spacer()
                        Menu {
                            Toggle("Hidden files", isOn: $showHidden)
                            Toggle("Ignore file filters", isOn: $showAll)
                            Picker("Sort", selection: $sortBy) {
                                Text("Name").tag("name"); Text("Size").tag("size"); Text("Modified").tag("date")
                            }
                        } label: { Label("View", systemImage: "line.3.horizontal.decrease") }
                    }
                    TextField("Filter this folder", text: $search)
                    if loading { ProgressView("Reading folder") }
                    if let status { Text(status).foregroundStyle(.secondary) }
                    if !patterns.isEmpty && !showAll {
                        Text(request["filters"].arrayValue.map { $0["name"].stringValue }.joined(separator: ", "))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(Array(displayed.enumerated()), id: \.offset) { _, entry in fileRow(entry) }
                    if listed && displayed.isEmpty && !loading { Text("No matching files").foregroundStyle(.secondary) }
                    if truncated { Text("This folder's listing was truncated by the host.").font(.footnote).foregroundStyle(.secondary) }
                    if wantsDirectory && mode == "open" {
                        Button("Choose this folder", systemImage: selected.contains(currentPath) ? "checkmark.circle.fill" : "folder.badge.checkmark") {
                            toggleSelection(currentPath)
                        }.disabled(!listed || (!multiple && (uploader.busy || uploader.rows.contains(where: \.done))))
                    }
                }
                if mode == "save" {
                    Section("File name") {
                        TextField("File name", text: $saveName).textInputAutocapitalization(.never).autocorrectionDisabled()
                        if entries.contains(where: { $0["name"].stringValue == saveName.trimmingCharacters(in: .whitespacesAndNewlines) }) {
                            Text("A file with this name already exists.").font(.footnote).foregroundStyle(.orange)
                        }
                    }
                }
                if mode == "saveFiles" {
                    Section("Files to save here") {
                        ForEach(Array(request["names"].arrayValue.enumerated()), id: \.offset) { _, name in Text(name.stringValue) }
                    }
                }
                if let detailsPath {
                    NativePathDetails(path: detailsPath, info: details, fetching: fetching,
                                      close: { self.detailsPath = nil; self.details = nil }, preview: previewDetails)
                }
            }
            .navigationTitle(request["title"].stringValue.isEmpty ? (mode == "open" ? "Open" : "Save") : request["title"].stringValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(request["acceptLabel"].stringValue.isEmpty ? (mode == "open" ? "Open" : "Save") : request["acceptLabel"].stringValue) {
                        if mode == "save", entries.contains(where: { $0["name"].stringValue == saveName.trimmingCharacters(in: .whitespacesAndNewlines) }) {
                            replacing = true
                        } else { confirm() }
                    }.disabled(!canConfirm)
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear {
            saveName = request["suggestedName"].stringValue
            if let base = session.publicServerURL { uploader.configure(base: base, request: requestID, ticket: request["ticket"].stringValue) }
            browse("~")
        }
        .onReceive(session.serverEvents) { type, value in receive(type, value) }
        .onChange(of: session.connected) { _, connected in if !connected { uploader.cancel(); transfer?.cancel() } }
        .onChange(of: session.canInteract) { _, allowed in if !allowed { uploader.cancel(); transfer?.cancel() } }
        .onDisappear { uploader.cancel(); transfer?.cancel() }
        .fileImporter(isPresented: $importing, allowedContentTypes: importTypes, allowsMultipleSelection: multiple && !wantsDirectory) { result in
            if case .success(let urls) = result {
                if !multiple { selected = [] }
                uploader.add(urls)
            }
            if case .failure = result { status = "The selected files could not be opened" }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: multiple ? 0 : 1, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task {
                let urls = await PickedMedia.copies(of: items)
                if urls.isEmpty { status = "The selected items could not be read" } else { if !multiple { selected = [] }; uploader.add(urls) }
            }
        }
        .confirmationDialog("Replace the existing file?", isPresented: $replacing, titleVisibility: .visible) {
            Button("Replace", role: .destructive, action: confirm)
        }
        .sheet(item: $preview) { item in
            NativeQuickLook(url: item.url).onDisappear { NativeDownloads.remove(item.url) }
        }
    }

    @ViewBuilder private func fileRow(_ entry: WireValue) -> some View {
        let name = entry["name"].stringValue
        let path = join(currentPath, name)
        let directory = entry["dir"].boolValue
        HStack {
            Button {
                if directory && !(wantsDirectory && mode == "open") { browse(path) }
                else if mode == "save" { saveName = name }
                else if mode == "open" && directory == wantsDirectory { toggleSelection(path) }
            } label: {
                HStack {
                    Image(systemName: selected.contains(path) ? "checkmark.circle.fill" : directory ? "folder" : "doc")
                    VStack(alignment: .leading) {
                        Text(name).foregroundStyle(.primary)
                        if !directory { Text(nativeByteCount(entry["size"].uintValue)).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(loading || (!directory && wantsDirectory) ||
                (mode == "open" && directory == wantsDirectory && !multiple && (uploader.busy || uploader.rows.contains(where: \.done))))
            if directory && wantsDirectory && mode == "open" {
                Button("Open folder", systemImage: "chevron.right") { browse(path) }
                    .labelStyle(.iconOnly).buttonStyle(.borderless).disabled(loading)
            }
            Button("Details", systemImage: "info.circle") {
                guard detailsPath == nil || details != nil else { return }
                detailsPath = path; details = nil
                session.sendMessage("statPath", ["request": .uint(requestID), "path": .string(path)])
            }.labelStyle(.iconOnly).buttonStyle(.borderless)
                .disabled(detailsPath != nil && details == nil)
        }
    }

    private func toggleSelection(_ path: String) {
        if selected.contains(path) { selected.remove(path) }
        else if multiple { selected.insert(path) }
        else { selected = [path] }
    }

    private func browse(_ path: String) {
        guard !loading, session.connected, session.canInteract, !answered else { return }
        loading = true; listed = false; selected = []; entries = []; status = nil
        detailsPath = nil; details = nil
        session.sendMessage("listDir", ["request": .uint(requestID), "path": .string(path)])
    }

    private func receive(_ type: String, _ value: WireValue) {
        guard value["request"].uintValue == requestID else { return }
        if type == "fileChooserClosed" { answered = true; uploader.cancel(); transfer?.cancel(); dismiss() }
        if type == "dirListing" {
            loading = false
            currentPath = value["path"].stringValue; typedPath = currentPath
            entries = value["entries"].arrayValue; truncated = value["truncated"].boolValue
            listed = value["error"] == .null && !currentPath.isEmpty
            status = value["error"].stringValue.isEmpty ? nil : value["error"].stringValue
        }
        if type == "pathInfo", let detailsPath {
            if value["path"].stringValue == detailsPath || value["name"].stringValue == URL(fileURLWithPath: detailsPath).lastPathComponent {
                details = value
            }
        }
    }

    private func confirm() {
        guard canConfirm else { return }
        let paths: [String]
        if mode == "save" { paths = [join(currentPath, saveName.trimmingCharacters(in: .whitespacesAndNewlines))] }
        else if mode == "saveFiles" { paths = [currentPath] }
        else { paths = selected.sorted() }
        answered = true; uploader.cancel()
        session.sendMessage("fileChosen", ["request": .uint(requestID), "paths": .array(paths.map(WireValue.string))])
        session.dismissFileChooser(requestID)
        dismiss()
    }

    private func cancel() {
        guard !answered else { return }
        answered = true; uploader.cancel(); transfer?.cancel()
        session.sendMessage("fileCancel", ["request": .uint(requestID)])
        session.dismissFileChooser(requestID)
        dismiss()
    }

    private func matches(_ name: String) -> Bool {
        guard !patterns.isEmpty else { return true }
        let lower = name.lowercased()
        let type = UTType(filenameExtension: URL(fileURLWithPath: name).pathExtension)
        return patterns.contains { pattern in
            if pattern == "*" || pattern == "*.*" { return true }
            if pattern.hasPrefix("*.") { return lower.hasSuffix(String(pattern.dropFirst()).lowercased()) }
            if pattern.hasSuffix("/*") { return type?.preferredMIMEType?.hasPrefix(String(pattern.dropLast())) == true }
            if pattern.contains("/"), let wanted = UTType(mimeType: pattern) { return type?.conforms(to: wanted) == true }
            // File filters are advisory; unfamiliar portal globs stay visible.
            return !pattern.hasPrefix("*.") && !pattern.contains("/")
        }
    }

    private var importTypes: [UTType] {
        if wantsDirectory { return [.folder] }
        if showAll { return [.data] }
        let types = patterns.compactMap { pattern -> UTType? in
            if pattern.hasPrefix("*.") { return UTType(filenameExtension: String(pattern.dropFirst(2))) }
            if pattern == "image/*" { return .image }
            if pattern == "video/*" { return .movie }
            if pattern == "audio/*" { return .audio }
            return UTType(mimeType: pattern)
        }
        return types.isEmpty ? [.data] : types
    }

    private func previewDetails() {
        guard let details, let base = session.publicServerURL else { return }
        fetching = true
        transfer = Task {
            do {
                let endpoint = try FileTransferProtocol.endpoint(base: base, operation: "preview", query: [
                    "request": String(requestID), "ticket": request["ticket"].stringValue, "path": details["path"].stringValue])
                let url = try await NativeDownloads.fetch(endpoint, name: details["name"].stringValue)
                guard !Task.isCancelled, session.connected else { NativeDownloads.remove(url); return }
                preview = .init(url: url)
            } catch is CancellationError {} catch { status = "The file could not be previewed" }
            fetching = false; transfer = nil
        }
    }

    private func join(_ path: String, _ name: String) -> String { path == "/" ? "/" + name : path + "/" + name }
}

private struct NativePathDetails: View {
    let path: String
    let info: WireValue?
    let fetching: Bool
    let close: () -> Void
    let preview: () -> Void
    var body: some View {
        Section("File details") {
            Text(path).font(.caption).textSelection(.enabled)
            if let info {
                if info["error"] != .null { Text(info["error"].stringValue).foregroundStyle(.secondary) }
                else {
                    LabeledContent("Kind", value: info["kind"].stringValue)
                    LabeledContent("Size", value: nativeByteCount(info["size"].uintValue))
                    if info["items"] != .null { LabeledContent("Items", value: String(info["items"].uintValue)) }
                    LabeledContent("Permissions", value: info["mode"].stringValue)
                    LabeledContent("Owner", value: info["owner"].stringValue)
                    LabeledContent("Group", value: info["group"].stringValue)
                    if info["target"] != .null { LabeledContent("Target", value: info["target"].stringValue) }
                    ForEach(["modified", "created", "accessed"], id: \.self) { key in
                        if info[key] != .null {
                            LabeledContent(key.capitalized, value: Date(timeIntervalSince1970: info[key].doubleValue).formatted())
                        }
                    }
                    if info["kind"].stringValue == "file", !info["mime"].stringValue.isEmpty {
                        Button("Preview", systemImage: "eye", action: preview).disabled(fetching)
                    }
                }
            } else { ProgressView("Reading file details") }
            Button("Close details", action: close)
        }
    }
}

struct NativeUploadSection: View {
    var uploader: NativeUploader
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = uploader.error { Text(error).font(LWFATheme.hint).foregroundStyle(LWFATheme.destructive) }
            ForEach(uploader.rows) { row in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Image(systemName: row.done ? "checkmark" : row.failed ? "rectangle.dashed" : "arrow.up.circle")
                            .foregroundStyle(row.done ? LWFATheme.success : row.failed ? LWFATheme.destructive : LWFATheme.mutedForeground)
                        Text(row.name).font(LWFATheme.body).lineLimit(1)
                        Spacer(minLength: 0)
                        Text(row.done ? "On the machine" : row.failed ? (row.error ?? row.state) : row.size == 0 ? row.state : "\(Int(Double(row.written) / Double(row.size) * 100))%")
                            .font(LWFATheme.hint).foregroundStyle(row.failed ? LWFATheme.destructive : LWFATheme.mutedForeground).lineLimit(1)
                    }
                    if !row.done && !row.failed {
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                Capsule().fill(LWFATheme.muted)
                                Capsule().fill(LWFATheme.primary).frame(width: proxy.size.width * (row.size == 0 ? 0 : CGFloat(row.written) / CGFloat(row.size)))
                            }
                        }.frame(height: 4)
                    }
                }
            }
            if uploader.busy { Button("Stop uploads", role: .destructive) { uploader.cancel() }.panelButton(.ghost, danger: true) }
        }
        .panelCard()
    }
}

/// A photo or video from the system picker, copied to an `lwfa-upload-` folder
/// that the uploader's file access cleans up when the transfer ends.
private struct PickedMedia: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { try Self(copying: $0.file) }
        FileRepresentation(importedContentType: .image) { try Self(copying: $0.file) }
        FileRepresentation(importedContentType: .item) { try Self(copying: $0.file) }
    }
    init(url: URL) { self.url = url }
    init(copying source: URL) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lwfa-upload-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = source.lastPathComponent.isEmpty ? "Photo" : source.lastPathComponent
        let destination = directory.appendingPathComponent(name)
        try FileManager.default.copyItem(at: source, to: destination)
        url = destination
    }
    /// Loads every picked item; items that fail are skipped.
    static func copies(of items: [PhotosPickerItem]) async -> [URL] {
        var urls: [URL] = []
        for item in items {
            if let media = try? await item.loadTransferable(type: Self.self) { urls.append(media.url) }
        }
        return urls
    }
}

private func nativeByteCount(_ bytes: UInt64) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(clamping: bytes), countStyle: .file)
}

private struct NativeShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct NativeQuickLook: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { url as NSURL }
    }
}
#endif
