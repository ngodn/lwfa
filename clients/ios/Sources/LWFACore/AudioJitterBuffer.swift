import Foundation
import Synchronization

/// Interleaved float PCM ring for a pull-model audio output.
///
/// One producer (the decoder) writes packets; one consumer (the audio render
/// callback) reads fixed-size blocks. The consumer path takes no locks and
/// allocates nothing, so it is safe inside a real-time render callback. The
/// producer side is serialized with a lock so any thread may write or reset.
///
/// Latency policy: output stays silent until `cushionFrames` are queued
/// (priming), so a burst of late packets does not stutter. An underrun
/// re-primes. If the queue grows past `ceilingFrames`, the consumer skips
/// ahead to the cushion, trading one audible seam for latency that would
/// otherwise stay for the rest of the session.
public final class AudioJitterBuffer: @unchecked Sendable {
    public struct Statistics: Sendable, Equatable {
        public var queuedFrames: Int
        public var underruns: UInt64
        public var overflows: UInt64
        public var primed: Bool
        public var queuedMilliseconds: Double { Double(queuedFrames) / 48 }
    }

    public let channels: Int
    public let capacityFrames: Int
    public let cushionFrames: Int
    public let ceilingFrames: Int
    private let storage: UnsafeMutablePointer<Float>
    private let mask: Int
    private let producerLock = NSLock()
    // Monotonic frame counters. `written - read` is the queue depth.
    private let written = Atomic<Int>(0)
    private let read = Atomic<Int>(0)
    // Absolute frame boundaries, not relative counts. A concurrent render may
    // already have consumed some of the frames that the producer observed.
    private let pendingSkip = Atomic<Int>(0)
    private let pendingReset = Atomic<Int>(-1)
    private let primed = Atomic<Bool>(false)
    private let underruns = Atomic<UInt64>(0)
    private let overflows = Atomic<UInt64>(0)

    /// `capacityFrames` rounds up to a power of two. Defaults are tuned for
    /// 20 ms Opus packets at 48 kHz: prime at 60 ms, skip ahead past 150 ms.
    public init(channels: Int = 2, capacityFrames: Int = 32_768, cushionFrames: Int = 2_880, ceilingFrames: Int = 7_200) {
        precondition(channels > 0 && channels <= 8)
        var capacity = 1024
        while capacity < capacityFrames { capacity <<= 1 }
        self.channels = channels
        self.capacityFrames = capacity
        self.cushionFrames = max(0, min(cushionFrames, capacity / 2))
        self.ceilingFrames = max(self.cushionFrames + 1, min(ceilingFrames, capacity - 1))
        mask = capacity - 1
        storage = .allocate(capacity: capacity * channels)
        storage.initialize(repeating: 0, count: capacity * channels)
    }

    deinit { storage.deallocate() }

    public var queuedFrames: Int { max(0, written.load(ordering: .acquiring) - read.load(ordering: .acquiring)) }

    public var statistics: Statistics {
        Statistics(queuedFrames: queuedFrames, underruns: underruns.load(ordering: .relaxed),
                   overflows: overflows.load(ordering: .relaxed), primed: primed.load(ordering: .relaxed))
    }

    /// Appends interleaved frames. Returns false and drops the packet only when
    /// it cannot fit even after the pending skip is applied; normal overflow is
    /// handled by asking the consumer to skip ahead.
    @discardableResult
    public func write(_ samples: UnsafeBufferPointer<Float>) -> Bool {
        let frames = samples.count / channels
        guard frames > 0, frames <= capacityFrames / 2, let source = samples.baseAddress else { return false }
        return producerLock.withLock {
            let head = written.load(ordering: .relaxed)
            let tail = read.load(ordering: .acquiring)
            let queued = head - tail
            if queued + frames > ceilingFrames {
                // Skip ahead so the cushion is what remains after this packet.
                let target = max(0, cushionFrames - frames)
                let boundary = head - target
                if boundary > tail {
                    pendingSkip.store(boundary, ordering: .releasing)
                    overflows.wrappingAdd(1, ordering: .relaxed)
                }
            }
            guard queued + frames <= capacityFrames else { return false }
            let start = head & mask
            let firstFrames = min(frames, capacityFrames - start)
            (storage + start * channels).update(from: source, count: firstFrames * channels)
            if firstFrames < frames {
                storage.update(from: source + firstFrames * channels, count: (frames - firstFrames) * channels)
            }
            written.store(head + frames, ordering: .releasing)
            return true
        }
    }

    public func write(_ samples: [Float]) -> Bool {
        samples.withUnsafeBufferPointer { write($0) }
    }

    /// Fills `frames` interleaved frames. Frames that could not be served are
    /// zeroed. Returns how many carried sound. Real-time safe.
    public func read(into destination: UnsafeMutablePointer<Float>, frames: Int) -> Int {
        guard frames > 0 else { return 0 }
        var tail = read.load(ordering: .relaxed)
        // Acquire requests before the write position: each boundary refers
        // only to frames that had already been published with release ordering.
        let reset = pendingReset.exchange(-1, ordering: .acquiringAndReleasing)
        let skip = pendingSkip.exchange(0, ordering: .acquiringAndReleasing)
        let head = written.load(ordering: .acquiring)
        tail = max(tail, min(head, max(reset, skip)))
        let available = head - tail
        if reset >= 0 { primed.store(false, ordering: .relaxed) }
        var served = 0
        if !primed.load(ordering: .relaxed) {
            if available >= cushionFrames, cushionFrames > 0 || available > 0 { primed.store(true, ordering: .relaxed) }
        }
        if primed.load(ordering: .relaxed) {
            served = min(frames, available)
            if served > 0 {
                let start = tail & mask
                let firstFrames = min(served, capacityFrames - start)
                destination.update(from: storage + start * channels, count: firstFrames * channels)
                if firstFrames < served {
                    (destination + firstFrames * channels).update(from: storage, count: (served - firstFrames) * channels)
                }
                tail += served
            }
            if served < frames {
                underruns.wrappingAdd(1, ordering: .relaxed)
                primed.store(false, ordering: .relaxed)
            }
        }
        if served < frames {
            (destination + served * channels).update(repeating: 0, count: (frames - served) * channels)
        }
        read.store(tail, ordering: .releasing)
        return served
    }

    /// Discards everything queued and returns to the priming state. Safe from
    /// any producer-side thread while the consumer keeps rendering.
    public func reset() {
        producerLock.withLock {
            // Discard only audio queued before this reset. Fresh audio can
            // arrive before a stopped engine invokes the consumer again.
            pendingReset.store(written.load(ordering: .relaxed), ordering: .releasing)
        }
    }

    public func resetStatistics() {
        underruns.store(0, ordering: .relaxed)
        overflows.store(0, ordering: .relaxed)
    }
}
