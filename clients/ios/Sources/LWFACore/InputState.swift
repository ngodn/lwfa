import Foundation

/// Owned by the UI/controller actor. Release before disconnecting or losing app activity.
public struct InputState: Sendable {
    private var buttons: Set<UInt32> = []
    private var axes: [UInt32: Double] = [:]
    private var pointerButtons: Set<UInt32> = []
    private var keys: Set<UInt32> = []
    public init() {}

    public mutating func updateButton(_ button: UInt32, pressed: Bool) -> ClientCommand? {
        guard button <= 16, set(&buttons, code: button, pressed: pressed) else { return nil }
        return .gamepadButton(button: button, pressed: pressed)
    }
    public mutating func updateAxis(_ axis: UInt32, value: Double) -> ClientCommand? {
        guard axis <= 5, value.isFinite else { return nil }
        let bounded = max(axis >= 4 ? 0 : -1, min(1, value))
        guard axes[axis, default: 0] != bounded else { return nil }
        axes[axis] = bounded
        return .gamepadAxis(axis: axis, value: bounded)
    }
    public mutating func updatePointerButton(_ button: UInt32, pressed: Bool) -> ClientCommand? {
        guard set(&pointerButtons, code: button, pressed: pressed) else { return nil }
        return .pointerButton(button: button, pressed: pressed)
    }
    public mutating func updateKey(_ key: UInt32, pressed: Bool) -> ClientCommand? {
        guard set(&keys, code: key, pressed: pressed) else { return nil }
        return .key(key: key, pressed: pressed)
    }
    public mutating func releaseAll() -> [ClientCommand] {
        var commands = buttons.sorted().map { ClientCommand.gamepadButton(button: $0, pressed: false) }
        commands += axes.keys.sorted().filter { axes[$0] != 0 }.map { .gamepadAxis(axis: $0, value: 0) }
        commands += pointerButtons.sorted().map { .pointerButton(button: $0, pressed: false) }
        commands += keys.sorted().map { .key(key: $0, pressed: false) }
        buttons.removeAll(); axes.removeAll(); pointerButtons.removeAll(); keys.removeAll()
        return commands
    }
}
private func set(_ codes: inout Set<UInt32>, code: UInt32, pressed: Bool) -> Bool {
    if pressed { return codes.insert(code).inserted }
    return codes.remove(code) != nil
}
