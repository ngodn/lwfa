import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Only the credential-free publicURL/description may be displayed or logged.
public struct ServerEndpoint: Sendable, CustomStringConvertible {
    public let publicURL: URL
    public var description: String { publicURL.absoluteString }
    /// Equivalent origin/path spellings share credentials; distinct ports and paths do not.
    public var credentialKey: String {
        var parts = URLComponents(url: publicURL, resolvingAgainstBaseURL: false)!
        parts.host = parts.host?.lowercased()
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) { parts.port = nil }
        while parts.percentEncodedPath.hasSuffix("/") { parts.percentEncodedPath.removeLast() }
        return parts.url!.absoluteString
    }
    public var credentialAliases: [String] {
        var candidates = [credentialKey, description, credentialKey + "/"]
        var parts = URLComponents(string: credentialKey)!
        if parts.port == nil {
            parts.port = parts.scheme == "https" ? 443 : 80
            candidates.append(parts.url!.absoluteString)
            candidates.append(parts.url!.absoluteString + "/")
        }
        var seen: Set<String> = []
        return candidates.filter { seen.insert($0).inserted }
    }
    public init(_ address: String, allowInsecure: Bool = false) throws {
        guard var parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["https", "wss", "http", "ws"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil else { throw ProtocolError.invalidEndpoint }
        guard allowInsecure || scheme == "https" || scheme == "wss" else { throw ProtocolError.insecureEndpoint }
        parts.scheme = scheme == "wss" || scheme == "https" ? "https" : "http"
        if let port = parts.port, !(1...65535).contains(port) { throw ProtocolError.invalidEndpoint }
        guard let url = parts.url else { throw ProtocolError.invalidEndpoint }
        publicURL = url
    }
    /// lwfa 1.5.10 authenticates the WebSocket query. Never log this request's URL.
    public func request(token: String, clientID: String, device: String = "iPad native") throws -> URLRequest {
        guard !token.isEmpty, !clientID.isEmpty,
              var parts = URLComponents(url: publicURL, resolvingAgainstBaseURL: false) else { throw ProtocolError.invalidEndpoint }
        parts.scheme = publicURL.scheme == "https" ? "wss" : "ws"
        let prefix = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.path = prefix.isEmpty ? "/engine" : "/\(prefix)/engine"
        parts.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "client", value: clientID), URLQueryItem(name: "device", value: device)]
        // The engine treats plus as a form-encoded space; URLComponents leaves it literal.
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = parts.url else { throw ProtocolError.invalidEndpoint }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("lwfa native iPad", forHTTPHeaderField: "User-Agent")
        return request
    }
}
