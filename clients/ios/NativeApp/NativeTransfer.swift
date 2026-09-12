#if os(iOS)
import SwiftUI
import CryptoKit
import LWFACore
@preconcurrency import Foundation

enum NativeTransferError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { text } else { nil } }
}

/// Retained by every child file of a picked folder until transfer ends.
final class NativeFileAccess: @unchecked Sendable {
    let url: URL
    private let granted: Bool
    init(_ url: URL) { self.url = url; granted = url.startAccessingSecurityScopedResource() }
    deinit {
        if granted { url.stopAccessingSecurityScopedResource() }
        let parent = url.deletingLastPathComponent()
        if parent.lastPathComponent.hasPrefix("lwfa-upload-"),
           parent.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL {
            try? FileManager.default.removeItem(at: parent)
        }
    }
}

struct NativeUploadSource: Sendable {
    let id = UUID().uuidString
    let url: URL
    let access: NativeFileAccess
    let name: String
    let relative: [String]
    let size: UInt64
    let modified: Date?

    static func prepare(_ urls: [URL]) throws -> [Self] {
        var sources: [Self] = []
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey,
                                       .fileSizeKey, .contentModificationDateKey]
        for url in urls {
            let access = NativeFileAccess(url)
            let values = try url.resourceValues(forKeys: keys)
            guard values.isSymbolicLink != true else { throw NativeTransferError.message("Symbolic links cannot be uploaded") }
            if values.isDirectory == true {
                guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: Array(keys)) else {
                    throw NativeTransferError.message("This folder could not be read")
                }
                let root = url.standardizedFileURL.path + "/"
                var found = false
                for case let child as URL in enumerator {
                    try Task.checkCancellation()
                    let info = try child.resourceValues(forKeys: keys)
                    if info.isSymbolicLink == true { enumerator.skipDescendants(); continue }
                    guard info.isRegularFile == true else { continue }
                    let path = child.standardizedFileURL.path
                    guard path.hasPrefix(root) else { continue }
                    let components = String(path.dropFirst(root.count)).split(separator: "/").map(String.init)
                    sources.append(.init(url: child, access: access, name: child.lastPathComponent,
                        relative: [url.lastPathComponent] + components.dropLast(),
                        size: UInt64(info.fileSize ?? 0), modified: info.contentModificationDate))
                    found = true
                    guard sources.count <= 5_000 else { throw NativeTransferError.message("Choose a folder with at most 5,000 files") }
                }
                if !found { throw NativeTransferError.message("This folder contains no uploadable files") }
            } else if values.isRegularFile == true {
                sources.append(.init(url: url, access: access, name: url.lastPathComponent, relative: [],
                                     size: UInt64(values.fileSize ?? 0), modified: values.contentModificationDate))
            }
        }
        return sources
    }
}

struct NativeUploadRow: Identifiable {
    let id: String
    var name: String
    let size: UInt64
    var written: UInt64 = 0
    var state = "Waiting"
    var error: String?
    var done = false
    var failed = false
}

/// Uploads use a separate socket and consume acknowledgments while sending.
/// No file-sized Data allocation, and no payload enters the session socket.
private actor NativeUploadWire {
    let request: UInt64
    let url: URL
    let session = URLSession(configuration: .ephemeral, delegate: NativeNoRedirect(), delegateQueue: nil)
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var waiting: CheckedContinuation<WireValue, any Error>?
    private var expected = ""
    private var file = ""
    private var size: UInt64 = 0
    private var update: (@Sendable (UInt64, String) -> Void)?
    private var aborted = false
    private var connectionError: (any Error)?

    init(base: URL, request: UInt64, ticket: String) throws {
        self.request = request
        url = try FileTransferProtocol.endpoint(base: base, operation: "upload",
                                               query: ["request": String(request), "ticket": ticket])
    }

    func abort() {
        aborted = true
        close()
        session.invalidateAndCancel()
    }

    private func close() {
        reader?.cancel(); reader = nil
        timeout?.cancel(); timeout = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        let pending = waiting; waiting = nil
        pending?.resume(throwing: CancellationError())
    }

    func upload(_ source: NativeUploadSource, update: @escaping @Sendable (UInt64, String) -> Void) async throws -> String {
        self.update = update
        file = source.id
        size = source.size
        var delay = 0.5
        defer { close(); self.update = nil }
        while !aborted {
            try Task.checkCancellation()
            do {
                try validate(source)
                connectionError = nil
                let socket = session.webSocketTask(with: url)
                socket.maximumMessageSize = 512 * 1024
                self.socket = socket
                socket.resume()
                reader = Task { [weak self] in
                    do {
                        while !Task.isCancelled {
                            let message = try await socket.receive()
                            await self?.received(message, from: socket)
                        }
                    } catch {
                        if !Task.isCancelled { await self?.failed(error, from: socket) }
                    }
                }
                update(0, "Connecting")
                let offsetReply = try await ask(try FileTransferProtocol.begin(request: request, file: source.id,
                    name: source.name, relative: source.relative, size: source.size), expecting: "uploadOffset")
                try checkRefusal(offsetReply)
                let offset = try FileTransferProtocol.offset(offsetReply, request: request, file: source.id, size: source.size)
                update(offset, "Sending")

                let handle: FileHandle
                do { handle = try FileHandle(forReadingFrom: source.url) }
                catch { throw NativeTransferError.message("The selected file is no longer readable") }
                defer { try? handle.close() }
                var hash = SHA256()
                var read: UInt64 = 0
                while read < source.size {
                    try Task.checkCancellation()
                    guard !aborted else { throw CancellationError() }
                    if let connectionError { throw connectionError }
                    let target = read < offset ? offset : source.size
                    let count = min(FileTransferProtocol.chunkBytes, Int(min(UInt64(Int.max), target - read)))
                    let bytes: Data
                    do { bytes = try handle.read(upToCount: count) ?? Data() }
                    catch { throw NativeTransferError.message("The selected file could not be read") }
                    guard !bytes.isEmpty else { throw NativeTransferError.message("The file changed while it was being uploaded") }
                    hash.update(data: bytes)
                    if read >= offset { try await socket.send(.data(bytes)) }
                    read += UInt64(bytes.count)
                    await Task.yield()
                }
                try validate(source)
                let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
                let done = try await ask(try FileTransferProtocol.end(request: request, file: source.id, sha256: digest),
                                         expecting: "uploadDone")
                try checkRefusal(done)
                guard done["ok"].boolValue else { throw NativeTransferError.message("The host could not verify this upload") }
                update(source.size, "Done")
                return done["name"].stringValue.isEmpty ? source.name : done["name"].stringValue
            } catch is CancellationError { throw CancellationError() }
            catch let error as NativeTransferError { throw error }
            catch is ProtocolError { throw NativeTransferError.message("The upload channel returned an invalid reply") }
            catch {
                let status = (socket?.response as? HTTPURLResponse)?.statusCode
                close()
                if status == 401 || status == 403 {
                    throw NativeTransferError.message("Upload access expired. Reconnect and choose the file again")
                }
                guard !aborted else { throw CancellationError() }
                update(0, "Paused, reconnecting")
                try await Task.sleep(for: .seconds(delay))
                delay = min(5, delay * 2)
            }
        }
        throw CancellationError()
    }

    private func validate(_ source: NativeUploadSource) throws {
        let value: URLResourceValues
        do { value = try source.url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) }
        catch { throw NativeTransferError.message("The selected file is no longer available") }
        guard UInt64(value.fileSize ?? 0) == source.size, value.contentModificationDate == source.modified else {
            throw NativeTransferError.message("The file changed. Choose it again before uploading")
        }
    }

    private func checkRefusal(_ value: WireValue) throws {
        if value["type"].stringValue == "uploadDone", !value["ok"].boolValue {
            let detail = value["error"].stringValue
            throw NativeTransferError.message(detail.isEmpty ? "The host refused this upload" : detail)
        }
    }

    private func ask(_ data: Data, expecting type: String) async throws -> WireValue {
        guard let socket, !aborted else { throw CancellationError() }
        if let connectionError { throw connectionError }
        expected = type
        return try await withCheckedThrowingContinuation { continuation in
            waiting = continuation
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                await self?.failed(URLError(.timedOut), from: socket)
            }
            Task { [weak self] in
                do { try await socket.send(.string(String(decoding: data, as: UTF8.self))) }
                catch { await self?.failed(error, from: socket) }
            }
        }
    }

    private func received(_ message: URLSessionWebSocketTask.Message, from source: URLSessionWebSocketTask) {
        guard socket === source, case .string(let text) = message, let reply = try? WireValue.decode(Data(text.utf8)),
              reply["request"].uintValue == request, reply["file"].stringValue == file else { return }
        let type = reply["type"].stringValue
        if type == "uploadProgress" {
            let written = reply["written"].uintValue
            if written <= size { update?(written, "Sending") }
        }
        if type == "uploadDone", !reply["ok"].boolValue {
            let detail = reply["error"].stringValue
            connectionError = NativeTransferError.message(detail.isEmpty ? "The host refused this upload" : detail)
        }
        if type == expected || (type == "uploadDone" && !reply["ok"].boolValue) {
            timeout?.cancel(); timeout = nil
            let pending = waiting; waiting = nil
            pending?.resume(returning: reply)
        }
    }

    private func failed(_ error: any Error, from source: URLSessionWebSocketTask) {
        guard socket === source else { return }
        connectionError = error
        timeout?.cancel(); timeout = nil
        let pending = waiting; waiting = nil
        pending?.resume(throwing: error)
        socket?.cancel(with: .goingAway, reason: nil)
    }

    deinit { session.invalidateAndCancel() }
}

@MainActor
@Observable final class NativeUploader {
    private(set) var rows: [NativeUploadRow] = []
    private(set) var busy = false
    var error: String?
    private var pending: [NativeUploadSource] = []
    private var task: Task<Void, Never>?
    private var wire: NativeUploadWire?
    private var configuration: (URL, UInt64, String)?
    private var epoch: UInt64 = 0
    private var preparing = 0
    private var preparations: [UUID: Task<[NativeUploadSource], any Error>] = [:]

    func configure(base: URL, request: UInt64, ticket: String) {
        if let old = configuration, old.0 == base, old.1 == request, old.2 == ticket { return }
        cancel()
        configuration = (base, request, ticket)
    }

    func add(_ urls: [URL]) {
        guard configuration != nil else { error = "Waiting for upload access"; return }
        let generation = epoch
        preparing += 1
        busy = true
        let preparationID = UUID()
        let preparation = Task.detached(priority: .userInitiated) { try NativeUploadSource.prepare(urls) }
        preparations[preparationID] = preparation
        Task { [weak self] in
            defer { self?.preparations.removeValue(forKey: preparationID) }
            do {
                let sources = try await preparation.value
                guard let self, self.epoch == generation else { return }
                self.preparing -= 1
                self.pending.append(contentsOf: sources)
                self.rows.append(contentsOf: sources.map { .init(id: $0.id, name: $0.name, size: $0.size) })
                self.start()
            } catch {
                guard let self, self.epoch == generation else { return }
                self.preparing -= 1
                self.error = (error as? NativeTransferError)?.errorDescription ?? "The selected files could not be read"
                self.busy = self.task != nil || self.preparing > 0
            }
        }
    }

    private func start() {
        guard task == nil, let configuration else { return }
        let generation = epoch
        do { wire = try NativeUploadWire(base: configuration.0, request: configuration.1, ticket: configuration.2) }
        catch { self.error = "The upload address is invalid"; busy = false; return }
        guard let wire else { return }
        busy = true
        task = Task { [weak self] in
            while let self, !self.pending.isEmpty, self.epoch == generation, !Task.isCancelled {
                let source = self.pending.removeFirst()
                do {
                    let name = try await wire.upload(source) { [weak self] written, state in
                        Task { @MainActor [weak self] in
                            guard let self, self.epoch == generation else { return }
                            self.patch(source.id) { row in
                                guard !row.done && !row.failed else { return }
                                row.state = state
                                if state == "Sending" || state == "Done" { row.written = max(row.written, written) }
                            }
                        }
                    }
                    guard self.epoch == generation else { return }
                    self.patch(source.id) { $0.name = name; $0.written = source.size; $0.state = "Done"; $0.done = true }
                } catch {
                    guard self.epoch == generation else { return }
                    let detail = (error as? NativeTransferError)?.errorDescription ?? "Upload stopped"
                    self.patch(source.id) { $0.failed = true; $0.state = "Failed"; $0.error = detail }
                }
            }
            guard let self, self.epoch == generation else { return }
            self.task = nil; self.busy = self.preparing > 0
            self.wire = nil
            await wire.abort()
        }
    }

    private func patch(_ id: String, _ change: (inout NativeUploadRow) -> Void) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        change(&rows[index])
    }

    func cancel() {
        preparations.values.forEach { $0.cancel() }
        preparations.removeAll()
        epoch &+= 1
        task?.cancel(); task = nil
        let old = wire; wire = nil
        Task { await old?.abort() }
        pending = []; preparing = 0; busy = false
        for i in rows.indices where !rows[i].done && !rows[i].failed {
            rows[i].failed = true; rows[i].state = "Stopped"
        }
    }
}

/// Never forward ticket-bearing requests through a redirect to another URL.
final class NativeNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum NativeDownloads {
    static func fetch(_ url: URL, name: String) async throws -> URL {
        let session = URLSession(configuration: .ephemeral, delegate: NativeNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (temporary, response) = try await session.download(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw NativeTransferError.message("This file is no longer available. Refresh the panel and try again")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lwfa-download-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: name).lastPathComponent
        let destination = directory.appendingPathComponent(safeName.isEmpty || safeName == "." || safeName == ".." ? "download" : safeName)
        try FileManager.default.moveItem(at: temporary, to: destination)
        return destination
    }

    static func remove(_ url: URL) {
        let parent = url.deletingLastPathComponent()
        guard parent.lastPathComponent.hasPrefix("lwfa-download-"),
              parent.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: parent)
    }
}
#endif
