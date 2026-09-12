import Foundation

/// Independent input surfaces retain ownership of their holds.
public struct InputMixer: Sendable {
    private var buttons: [UInt32: Set<String>] = [:]
    private var keys: [UInt32: Set<String>] = [:]
    private var pointerButtons: [UInt32: Set<String>] = [:]
    private var axes: [UInt32: [String: Double]] = [:]
    public init() {}

    public mutating func button(_ code: UInt32, pressed: Bool, source: String) -> ClientCommand? {
        guard code <= 16, let value = hold(&buttons, code: code, pressed: pressed, source: source) else { return nil }
        return .gamepadButton(button: code, pressed: value)
    }
    public mutating func key(_ code: UInt32, pressed: Bool, source: String) -> ClientCommand? {
        guard let value = hold(&keys, code: code, pressed: pressed, source: source) else { return nil }
        return .key(key: code, pressed: value)
    }
    public mutating func pointerButton(_ code: UInt32, pressed: Bool, source: String) -> ClientCommand? {
        guard let value = hold(&pointerButtons, code: code, pressed: pressed, source: source) else { return nil }
        return .pointerButton(button: code, pressed: value)
    }
    public mutating func axis(_ code: UInt32, value: Double, source: String) -> ClientCommand? {
        guard code <= 5, value.isFinite else { return nil }
        let old = axisValue(code)
        axes[code, default: [:]][source] = min(1, max(code >= 4 ? 0 : -1, value))
        let new = axisValue(code)
        return old == new ? nil : .gamepadAxis(axis: code, value: new)
    }
    public mutating func release(source: String) -> [ClientCommand] {
        var result: [ClientCommand] = []
        for code in buttons.keys.sorted() { if let c = button(code, pressed: false, source: source) { result.append(c) } }
        for code in keys.keys.sorted() { if let c = key(code, pressed: false, source: source) { result.append(c) } }
        for code in pointerButtons.keys.sorted() { if let c = pointerButton(code, pressed: false, source: source) { result.append(c) } }
        for code in axes.keys.sorted() {
            let old = axisValue(code)
            axes[code]?.removeValue(forKey: source)
            let new = axisValue(code)
            if new != old { result.append(.gamepadAxis(axis: code, value: new)) }
        }
        return result
    }
    public mutating func releaseAll() -> [ClientCommand] {
        var result = buttons.keys.sorted().filter { !(buttons[$0]?.isEmpty ?? true) }.map { ClientCommand.gamepadButton(button: $0, pressed: false) }
        result += keys.keys.sorted().filter { !(keys[$0]?.isEmpty ?? true) }.map { .key(key: $0, pressed: false) }
        result += pointerButtons.keys.sorted().filter { !(pointerButtons[$0]?.isEmpty ?? true) }.map { .pointerButton(button: $0, pressed: false) }
        result += axes.keys.sorted().filter { axisValue($0) != 0 }.map { .gamepadAxis(axis: $0, value: 0) }
        self = .init()
        return result
    }
    private func axisValue(_ code: UInt32) -> Double {
        // Largest deflection wins. Source ordering makes ties deterministic.
        (axes[code] ?? [:]).sorted { $0.key < $1.key }.reduce(0) { abs($1.value) > abs($0) ? $1.value : $0 }
    }
}

private func hold(_ owners: inout [UInt32: Set<String>], code: UInt32, pressed: Bool, source: String) -> Bool? {
    let old = !(owners[code]?.isEmpty ?? true)
    if pressed { owners[code, default: []].insert(source) }
    else { owners[code]?.remove(source) }
    let new = !(owners[code]?.isEmpty ?? true)
    return old == new ? nil : new
}
