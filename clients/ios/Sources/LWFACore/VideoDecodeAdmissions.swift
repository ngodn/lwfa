import Foundation

/// Bounds compressed access units waiting for or running in a decoder.
/// A dropped admission invalidates earlier work because a queued keyframe
/// cannot repair a reference-frame gap that occurs after that keyframe.
public final class VideoDecodeAdmissions: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var discontinuity = false
    private var generation: UInt64 = 0

    private let capacity: Int

    public init(capacity: Int = 6) { self.capacity = max(1, min(64, capacity)) }

    public func acquire() -> VideoDecodeTicket? {
        lock.withLock {
            guard count < capacity else {
                generation &+= 1
                discontinuity = true
                return nil
            }
            count += 1
            return VideoDecodeTicket(owner: self, generation: generation)
        }
    }

    fileprivate func release() { lock.withLock { count -= 1 } }

    /// Recovery callbacks use this to avoid acting on a replacement stream.
    public func isCurrent(_ candidate: UInt64) -> Bool {
        lock.withLock { generation == candidate }
    }

    /// Old tickets retain their slots until the decoder actually finishes.
    /// Reset must not permit new work to exceed the shared in-flight bound.
    public func reset() { lock.withLock { generation &+= 1; discontinuity = false } }

    /// Records a decoder-level error or dropped frame, even when submission
    /// itself returned success. The returned generation identifies recovery.
    public func breakChain() -> UInt64 {
        lock.withLock {
            generation &+= 1
            discontinuity = true
            return generation
        }
    }

    public func consumeDiscontinuity() -> Bool {
        lock.withLock {
            let result = discontinuity
            discontinuity = false
            return result
        }
    }
}

/// Immutable generation plus a locked, once-only admission release.
/// Validity remains queryable after finish for delayed recovery callbacks.
public final class VideoDecodeTicket: @unchecked Sendable {
    private let lock = NSLock()
    private let owner: VideoDecodeAdmissions
    private var finished = false
    private let generation: UInt64

    fileprivate init(owner: VideoDecodeAdmissions, generation: UInt64) {
        self.owner = owner
        self.generation = generation
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
