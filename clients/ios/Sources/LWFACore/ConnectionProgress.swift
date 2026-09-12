import Foundation

/// A workspace is available only after the server has accepted this connection.
public struct ConnectionProgress: Sendable {
    public enum Phase: Sendable { case idle, connecting, connected, reconnecting, suspended }
    public private(set) var phase: Phase = .idle
    public private(set) var established = false
    public private(set) var retries = 0
    public var showsWorkspace: Bool { phase == .connected || phase == .reconnecting || (phase == .suspended && established) }
    public init() {}

    public mutating func begin() { self = Self(); startAttempt() }
    public mutating func startAttempt() { phase = established ? .reconnecting : .connecting }
    public mutating func accepted() { established = true; retries = 0; phase = .connected }
    public mutating func pause() { phase = .suspended }
    public mutating func cancel() { self = Self() }

    /// Failed first attempts return to the form. Only established sessions retry.
    public mutating func failed(retryable: Bool) -> Bool {
        guard established, retryable, retries < 6 else { cancel(); return false }
        retries += 1
        phase = .reconnecting
        return true
    }
}
