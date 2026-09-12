import Foundation

/// Bounds audio decode work without discarding accepted sound when a later
/// packet is dropped. A history reset belongs to the next accepted packet.
public final class AudioDecodeAdmissions: @unchecked Sendable {
    private let lock = NSLock()
    private let capacity: Int
    private var count = 0
    private var generation: UInt64 = 0
    private var discontinuity = false

    public init(capacity: Int = 5) { self.capacity = max(1, min(64, capacity)) }

    public func acquire() -> AudioDecodeTicket? {
        lock.withLock {
            guard count < capacity else {
                discontinuity = true
                return nil
            }
            count += 1
            let ticket = AudioDecodeTicket(owner: self, generation: generation, discontinuity: discontinuity)
            discontinuity = false
            return ticket
        }
    }

    public func reset() { lock.withLock { generation &+= 1; discontinuity = false } }
    fileprivate func isCurrent(_ value: UInt64) -> Bool { lock.withLock { value == generation } }
    fileprivate func release() { lock.withLock { count -= 1 } }
}

public final class AudioDecodeTicket: @unchecked Sendable {
    private let lock = NSLock()
    private let owner: AudioDecodeAdmissions
    private let generation: UInt64
    private var finished = false
    public let discontinuity: Bool

    fileprivate init(owner: AudioDecodeAdmissions, generation: UInt64, discontinuity: Bool) {
        self.owner = owner
        self.generation = generation
        self.discontinuity = discontinuity
    }

    public var isCurrent: Bool { owner.isCurrent(generation) }
    public func finish() {
        let release = lock.withLock {
            guard !finished else { return false }
            finished = true
            return true
        }
        if release { owner.release() }
    }
    deinit { finish() }
}
