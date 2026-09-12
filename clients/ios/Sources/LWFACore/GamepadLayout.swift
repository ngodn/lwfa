import Foundation

public struct GamepadPad: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: String
    public var face: String
    public var x: Double
    public var y: Double
    public var size: Double
    public var code: UInt32?
    public var directions: [UInt32]?
    public var clickCode: UInt32?
    public var chord: [UInt32]?
    public var label: String?

    public init(id: String, kind: String, face: String, x: Double, y: Double, size: Double,
                code: UInt32? = nil, directions: [UInt32]? = nil, clickCode: UInt32? = nil,
                chord: [UInt32]? = nil, label: String? = nil) {
        self.id = id; self.kind = kind; self.face = face; self.x = x; self.y = y; self.size = size
        self.code = code; self.directions = directions; self.clickCode = clickCode; self.chord = chord; self.label = label
    }
    public func clamped() -> Self {
        var pad = self
        pad.x = min(97, max(3, x)); pad.y = min(97, max(3, y)); pad.size = min(40, max(6, size))
        return pad
    }
}

public struct GamepadBackupSettings: Codable, Equatable, Sendable {
    public var skin = "neutral"
    public var opacity = 0.85
    public var haptics = true
    public var mode = "controller"
    public init(skin: String = "neutral", opacity: Double = 0.85, haptics: Bool = true, mode: String = "controller") {
        self.skin = skin; self.opacity = opacity; self.haptics = haptics; self.mode = mode
    }
}

public struct GamepadBackup: Codable, Equatable, Sendable {
    public var kind = "lwfa.gamepad"
    public var version = 1
    public var savedAt: String
    public var settings: GamepadBackupSettings
    public var pads: [GamepadPad]
    public init(pads: [GamepadPad], settings: GamepadBackupSettings, savedAt: String = ISO8601DateFormatter().string(from: Date())) {
        self.pads = pads; self.settings = settings; self.savedAt = savedAt
    }
    public func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 1_048_576 else { throw GamepadLayoutError.invalidBackup }
        let root = try WireValue.decode(data)
        let values: [WireValue]
        switch root {
        case .array(let pads): values = pads
        case .object(let object):
            if let kind = object["kind"], kind.stringValue != "lwfa.gamepad" { throw GamepadLayoutError.invalidBackup }
            guard case .array(let pads) = object["pads"] else { throw GamepadLayoutError.invalidBackup }
            values = pads
        default: throw GamepadLayoutError.invalidBackup
        }
        guard values.count <= 128 else { throw GamepadLayoutError.invalidBackup }
        var seen = Set<String>()
        let pads = values.compactMap { value -> GamepadPad? in
            guard let bytes = try? value.encoded(), let pad = try? JSONDecoder().decode(GamepadPad.self, from: bytes),
                  ["button", "trigger", "stick", "dpad", "key"].contains(pad.kind),
                  !pad.id.isEmpty, pad.id.count <= 128, pad.face.count <= 128,
                  pad.x.isFinite, pad.y.isFinite, pad.size.isFinite,
                  pad.directions == nil || pad.directions?.count == 4,
                  (pad.chord?.count ?? 0) <= 16,
                  (pad.label?.count ?? 0) <= 128,
                  [pad.code, pad.clickCode].compactMap({ $0 }).allSatisfy({ $0 <= 767 }),
                  (pad.directions ?? []).allSatisfy({ $0 <= 767 }),
                  (pad.chord ?? []).allSatisfy({ $0 <= 767 }),
                  seen.insert(pad.id).inserted else { return nil }
            return pad.clamped()
        }
        guard !pads.isEmpty else { throw GamepadLayoutError.invalidBackup }
        let raw = root["settings"]
        var settings = GamepadBackupSettings()
        if ["neutral", "xbox", "playstation"].contains(raw["skin"].stringValue) { settings.skin = raw["skin"].stringValue }
        if ["controller", "keyboard"].contains(raw["mode"].stringValue) { settings.mode = raw["mode"].stringValue }
        switch raw["opacity"] {
        case .double, .uint, .int:
            if raw["opacity"].doubleValue.isFinite { settings.opacity = min(1, max(0.2, raw["opacity"].doubleValue)) }
        default: break
        }
        if case .bool(let haptics) = raw["haptics"] { settings.haptics = haptics }
        // Browser backups permit old versions and bare pad arrays, then normalize.
        return Self(pads: pads, settings: settings, savedAt: root["savedAt"].stringValue)
    }
}
public enum GamepadLayoutError: Error { case invalidBackup }

public enum GamepadLayout {
    public static let buttons: [String: UInt32] = ["south": 0, "east": 1, "west": 2, "north": 3,
        "l1": 4, "r1": 5, "l2": 6, "r2": 7, "select": 8, "start": 9, "l3": 10, "r3": 11, "guide": 16]
    public static let dpadButtons: [UInt32] = [12, 15, 13, 14]
    public static let defaultPads: [GamepadPad] = [
        .init(id: "l2", kind: "trigger", face: "l2", x: 8, y: 9, size: 13, code: 42),
        .init(id: "l1", kind: "trigger", face: "l1", x: 8, y: 23, size: 13, code: 29),
        .init(id: "r2", kind: "trigger", face: "r2", x: 92, y: 9, size: 13, code: 18),
        .init(id: "r1", kind: "trigger", face: "r1", x: 92, y: 23, size: 13, code: 33),
        .init(id: "dpad", kind: "dpad", face: "dpad", x: 15, y: 44, size: 22, directions: [103, 106, 108, 105]),
        .init(id: "lstick", kind: "stick", face: "lstick", x: 18, y: 78, size: 22, directions: [17, 32, 31, 30]),
        .init(id: "north", kind: "button", face: "north", x: 86, y: 40, size: 12, code: 19),
        .init(id: "west", kind: "button", face: "west", x: 77, y: 51, size: 12, code: 34),
        .init(id: "east", kind: "button", face: "east", x: 94, y: 51, size: 12, code: 48),
        .init(id: "south", kind: "button", face: "south", x: 86, y: 62, size: 12, code: 57),
        .init(id: "rstick", kind: "stick", face: "rstick", x: 80, y: 82, size: 22, directions: [103, 106, 108, 105]),
        .init(id: "l3", kind: "button", face: "l3", x: 5, y: 36, size: 11, code: 46),
        .init(id: "r3", kind: "button", face: "r3", x: 95, y: 36, size: 11, code: 50),
        .init(id: "select", kind: "button", face: "select", x: 42, y: 12, size: 9, code: 15),
        .init(id: "guide", kind: "button", face: "guide", x: 50, y: 12, size: 9, code: 125),
        .init(id: "start", kind: "button", face: "start", x: 58, y: 12, size: 9, code: 1),
    ]
    public static func label(_ pad: GamepadPad, skin: String) -> String {
        if let label = pad.label, !label.isEmpty { return label }
        if pad.kind == "key" { return (pad.chord ?? pad.code.map { [$0] } ?? []).map { keyNames[$0] ?? "#\($0)" }.joined(separator: "+") }
        let neutral = ["north":"N", "south":"S", "east":"E", "west":"W", "l1":"L1", "r1":"R1", "l2":"L2", "r2":"R2", "l3":"L3", "r3":"R3", "start":"START", "select":"SELECT", "guide":"HOME", "lstick":"L", "rstick":"R", "dpad":"✛"]
        let xbox = ["north":"Y", "south":"A", "east":"B", "west":"X", "l1":"LB", "r1":"RB", "l2":"LT", "r2":"RT", "l3":"LS", "r3":"RS", "start":"MENU", "select":"VIEW", "guide":"XBOX"]
        let playstation = ["north":"△", "south":"✕", "east":"○", "west":"□", "start":"OPTIONS", "select":"SHARE", "guide":"PS"]
        return (skin == "xbox" ? xbox[pad.face] : skin == "playstation" ? playstation[pad.face] : nil) ?? neutral[pad.face] ?? pad.face
    }
    /// x/y are centered pad coordinates, with down positive, like browser axes.
    public static func commands(_ pad: GamepadPad, mode: String, pressed: Bool, x: Double = 0, y: Double = 0) -> [ClientCommand] {
        guard x.isFinite, y.isFinite else { return [] }
        if pad.kind == "key" {
            let chord = pad.chord ?? pad.code.map { [$0] } ?? []
            return (pressed ? chord : chord.reversed()).map { .key(key: $0, pressed: pressed) }
        }
        if pad.kind == "stick" || pad.kind == "dpad" {
            let stick = stickValue(x: x, y: y, pressed: pressed, analog: mode == "controller" && pad.kind == "stick")
            if mode == "controller", pad.kind == "stick" {
                let axis: UInt32 = pad.face == "rstick" ? 2 : 0
                return [.gamepadAxis(axis: axis, value: stick.x), .gamepadAxis(axis: axis + 1, value: stick.y)]
            }
            // Eight directions, each cardinal spanning ±67.5°, so diagonals
            // press two keys. sin(22.5°) is the threshold on the unit vector.
            let threshold = 0.38268343
            let directions = [stick.y < -threshold, stick.x > threshold, stick.y > threshold, stick.x < -threshold]
            if mode == "controller" { return zip(dpadButtons, directions).map { .gamepadButton(button: $0, pressed: $1) } }
            return zip(pad.directions ?? [], directions).map { .key(key: $0, pressed: $1) }
        }
        if mode == "keyboard" { return pad.code.map { [.key(key: $0, pressed: pressed)] } ?? [] }
        guard let button = buttons[pad.face] else { return [] }
        var result: [ClientCommand] = [.gamepadButton(button: button, pressed: pressed)]
        if pad.face == "l2" || pad.face == "r2" { result.append(.gamepadAxis(axis: pad.face == "l2" ? 4 : 5, value: pressed ? 1 : 0)) }
        return result
    }
    // Same evdev legends used by the browser's keyboard/chord picker.
    /// Stick feel from `gamepad/model.ts`: a 5% dead zone for analog sticks
    /// (25% when quantised to keys), an expo curve that keeps small movements
    /// fine, and values quantised to 1/64 so jitter does not become traffic.
    /// `x`/`y` are the thumb offset in radii; anything past 1 is clamped.
    public static func stickValue(x: Double, y: Double, pressed: Bool, analog: Bool) -> (x: Double, y: Double) {
        guard pressed, x.isFinite, y.isFinite else { return (0, 0) }
        let length = hypot(x, y)
        let magnitude = min(1, length)
        let deadZone = analog ? 0.05 : 0.25
        guard magnitude > deadZone else { return (0, 0) }
        let ux = x / length, uy = y / length
        guard analog else { return (ux, uy) }
        let linear = (magnitude - deadZone) / (1 - deadZone)
        let shaped = linear * (1 - 0.55 + 0.55 * linear)
        func quantise(_ value: Double) -> Double { (value * 64).rounded() / 64 }
        return (quantise(ux * shaped), quantise(uy * shaped))
    }

    public static let keyNames: [UInt32: String] = [
        1: "Esc",
        2: "1",
        3: "2",
        4: "3",
        5: "4",
        6: "5",
        7: "6",
        8: "7",
        9: "8",
        10: "9",
        11: "0",
        12: "-",
        13: "=",
        14: "Bksp",
        15: "Tab",
        16: "Q",
        17: "W",
        18: "E",
        19: "R",
        20: "T",
        21: "Y",
        22: "U",
        23: "I",
        24: "O",
        25: "P",
        26: "[",
        27: "]",
        28: "Enter",
        29: "Ctrl",
        30: "A",
        31: "S",
        32: "D",
        33: "F",
        34: "G",
        35: "H",
        36: "J",
        37: "K",
        38: "L",
        39: ";",
        40: "'",
        41: "`",
        42: "Shift",
        43: "\\",
        44: "Z",
        45: "X",
        46: "C",
        47: "V",
        48: "B",
        49: "N",
        50: "M",
        51: ",",
        52: ".",
        53: "/",
        54: "RShift",
        56: "Alt",
        57: "Space",
        59: "F1",
        60: "F2",
        61: "F3",
        62: "F4",
        63: "F5",
        64: "F6",
        65: "F7",
        66: "F8",
        67: "F9",
        68: "F10",
        87: "F11",
        88: "F12",
        97: "RCtrl",
        99: "PrtSc",
        100: "RAlt",
        102: "Home",
        103: "Up",
        104: "PgUp",
        105: "Left",
        106: "Right",
        107: "End",
        108: "Down",
        109: "PgDn",
        110: "Ins",
        111: "Del",
        119: "Pause",
        125: "Super",
        127: "Menu"
    ]
}
