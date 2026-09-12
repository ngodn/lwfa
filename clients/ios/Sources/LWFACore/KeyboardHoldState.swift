/// Modifier latches are UI choices. Each held key owns the modifiers that
/// were selected when that press began, until that same key is released.
public struct KeyboardHoldState: Sendable {
    public private(set) var latched: [UInt32] = []
    public private(set) var held: Set<UInt32> = []
    public static let modifierOrder: [UInt32] = [29, 56, 42, 125]
    private var mixer = InputMixer()
    private var modifiersByKey: [UInt32: [UInt32]] = [:]

    public init() {}

    public mutating func toggleModifier(_ code: UInt32) {
        guard Self.modifierOrder.contains(code) else { return }
        if latched.contains(code) { latched.removeAll { $0 == code } }
        else { latched.append(code) }
    }

    public mutating func press(_ code: UInt32) -> [ClientCommand] {
        guard held.insert(code).inserted else { return [] }
        let modifiers = Self.modifierOrder.filter { latched.contains($0) }
        modifiersByKey[code] = modifiers
        let source = "key:\(code)"
        var result = modifiers.compactMap {
            mixer.key($0, pressed: true, source: source)
        }
        if let command = mixer.key(code, pressed: true, source: source) { result.append(command) }
        return result
    }

    public mutating func lift(_ code: UInt32, sticky: Bool) -> [ClientCommand] {
        guard held.remove(code) != nil else { return [] }
        let source = "key:\(code)"
        let modifiers = modifiersByKey.removeValue(forKey: code) ?? []
        var result: [ClientCommand] = []
        if let command = mixer.key(code, pressed: false, source: source) { result.append(command) }
        for modifier in modifiers.reversed() {
            if let command = mixer.key(modifier, pressed: false, source: source) { result.append(command) }
        }
        if !sticky { latched.removeAll() }
        return result
    }

    public mutating func reset() {
        self = .init()
    }
}
