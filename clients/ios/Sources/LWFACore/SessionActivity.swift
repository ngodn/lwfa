/// Foreground inactivity pauses input without discarding the connection.
public struct SessionActivity: Sendable {
    public enum Phase: Sendable { case active, inactive, background }
    public enum Transition: Sendable { case none, pauseInput, resumeInput, suspend, resume }
    public private(set) var phase: Phase = .inactive
    private var needsResume = false
    public var acceptsInput: Bool { phase == .active }
    public var allowsTransport: Bool { phase != .background && !needsResume }
    public init() {}

    public mutating func move(to next: Phase) -> Transition {
        guard phase != next else { return .none }
        phase = next
        switch next {
        case .background: needsResume = true; return .suspend
        case .active:
            defer { needsResume = false }
            return needsResume ? .resume : .resumeInput
        case .inactive: return .pauseInput
        }
    }
}
