/// Scheduling state for a 48 kHz live stream. The adapter applies the returned
/// playback actions on its serial audio queue, outside the render callback.
public struct AudioPlayoutState: Sendable {
    public struct Admission: Sendable {
        public let generation: UInt64
        public let frames: Int
        public let flush: Bool
        public let start: Bool
    }

    public private(set) var queuedFrames = 0
    public private(set) var playing = false
    private var generation: UInt64 = 0
    public init() {}

    public mutating func enqueue(frames: Int) -> Admission? {
        guard frames > 0, frames <= 4_800 else { return nil }
        let flush = queuedFrames + frames > 4_800
        if flush { reset() }
        queuedFrames += frames
        let start = !playing && queuedFrames >= 2_880
        if start { playing = true }
        return Admission(generation: generation, frames: frames, flush: flush, start: start)
    }

    /// Returns true when the adapter must pause and wait for its preroll again.
    public mutating func rendered(_ admission: Admission) -> Bool {
        guard admission.generation == generation else { return false }
        queuedFrames = max(0, queuedFrames - admission.frames)
        guard queuedFrames == 0, playing else { return false }
        playing = false
        return true
    }

    public mutating func reset() {
        generation &+= 1
        queuedFrames = 0
        playing = false
    }
}
