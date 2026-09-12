import Foundation

/// Ticket-scoped endpoints never carry the session password.
public enum FileTransferProtocol {
    public static let chunkBytes = 256 * 1024

    public static func endpoint(base: URL, operation: String, query: [String: String]) throws -> URL {
        guard ["upload", "clip", "preview"].contains(operation),
              var parts = URLComponents(url: base, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme, ["https", "http"].contains(scheme),
              parts.host != nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, query["token"] == nil else {
            throw ProtocolError.invalidEndpoint
        }
        let prefix = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.path = (prefix.isEmpty ? "" : "/\(prefix)") + "/engine/\(operation)"
        if operation == "upload" { parts.scheme = scheme == "https" ? "wss" : "ws" }
        parts.queryItems = query.sorted { $0.key < $1.key }.map { .init(name: $0.key, value: $0.value) }
        // The engine uses form decoding, where an unescaped plus means space.
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let result = parts.url else { throw ProtocolError.invalidEndpoint }
        return result
    }

    public static func begin(request: UInt64, file: String, name: String, relative: [String], size: UInt64) throws -> Data {
        try WireValue.object(["type": .string("uploadBegin"), "request": .uint(request),
            "file": .string(file), "name": .string(name), "rel": .array(relative.map(WireValue.string)),
            "size": .uint(size)]).encoded()
    }

    public static func end(request: UInt64, file: String, sha256: String) throws -> Data {
        try WireValue.object(["type": .string("uploadEnd"), "request": .uint(request),
                              "file": .string(file), "sha256": .string(sha256)]).encoded()
    }

    public static func offset(_ reply: WireValue, request: UInt64, file: String, size: UInt64) throws -> UInt64 {
        guard reply["type"] == .string("uploadOffset"), reply["request"] == .uint(request),
              reply["file"] == .string(file), case let .uint(offset) = reply["offset"], offset <= size else {
            throw ProtocolError.invalidPacket
        }
        return offset
    }
}
