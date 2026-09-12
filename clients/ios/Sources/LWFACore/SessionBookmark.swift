import Foundation

/// Restoration metadata contains no password. Credentials remain in Keychain.
public struct SessionBookmark: Codable, Equatable, Sendable {
    public let address: String
    public let allowInsecure: Bool
    public var selectedWindow: UInt64?
    public var immersive: Bool

    public init(endpoint: ServerEndpoint, selectedWindow: UInt64?, immersive: Bool) {
        address = endpoint.description
        allowInsecure = endpoint.publicURL.scheme == "http"
        self.selectedWindow = selectedWindow
        self.immersive = immersive
    }
    public func endpoint() throws -> ServerEndpoint { try ServerEndpoint(address, allowInsecure: allowInsecure) }
}

public struct SessionBookmarkStore {
    private let defaults: UserDefaults
    private let key = "lwfa.native.lastAuthenticatedSession"
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func load() -> SessionBookmark? {
        guard let data = defaults.data(forKey: key),
              let bookmark = try? JSONDecoder().decode(SessionBookmark.self, from: data),
              (try? bookmark.endpoint()) != nil else { return nil }
        return bookmark
    }
    public func save(_ bookmark: SessionBookmark) throws {
        _ = try bookmark.endpoint()
        defaults.set(try JSONEncoder().encode(bookmark), forKey: key)
    }
    public func clear() { defaults.removeObject(forKey: key) }
}
