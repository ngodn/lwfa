import Foundation

public let protocolVersion = 2
public enum ProtocolError: Error, Equatable, Sendable {
    case unsupportedVersion(Int)
    case invalidPacket
    case invalidAnnexB
    case invalidEndpoint
    case insecureEndpoint
}

public struct Output: Codable, Sendable, Equatable {
    public let width: UInt32
    public let height: UInt32
    public let scale: Double
    public init(width: UInt32, height: UInt32, scale: Double = 1) {
        self.width = width; self.height = height; self.scale = scale
    }
}
public struct Rect: Codable, Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}
public struct WindowInfo: Codable, Identifiable, Sendable, Equatable {
    public let id: UInt64
    public let appId: String?
    public let title: String?
    public let fullscreen: Bool
    public let xwayland: Bool?
}
public struct WindowLayout: Codable, Sendable, Equatable {
    public let id: UInt64
    public let rect: Rect
    public let z: Int32
    public init(id: UInt64, rect: Rect, z: Int32 = 0) {
        self.id = id; self.rect = rect; self.z = z
    }
}
public enum SessionMode: String, Codable, Sendable { case view, interact }
public struct Permissions: Codable, Sendable, Equatable {
    public let mode: SessionMode
    public let allowedApps: [String]?
}
public struct PeerInfo: Codable, Identifiable, Sendable, Equatable {
    public let id: UInt64
    public let account: String
    public let mode: SessionMode
    public let primary: Bool
    public let device: String
}
public struct Hello: Decodable, Sendable, Equatable {
    public let protocolVersion: Int
    public let output: Output
    public let windows: [WindowInfo]
    public let focused: UInt64?
    public let permissions: Permissions
    public let account: String
    public let session: UInt64
    public let primary: Bool
    public let peers: [PeerInfo]
}

public enum ServerMessage: Decodable, Sendable, Equatable {
    case hello(Hello)
    case outputChanged(Output)
    case layout([WindowLayout], Output)
    case windowOpened(WindowInfo)
    case windowChanged(WindowInfo)
    case windowClosed(UInt64)
    case focusChanged(UInt64?)
    case role(Bool)
    case peers([PeerInfo])
    case fullscreenRequest(window: UInt64, fullscreen: Bool)
    case engineVersion(String)
    case windowBlank(id: UInt64, blank: Bool)
    case error(request: String, message: String)
    case pong
    case administration(type: String, value: WireValue)
    case unknown(String)

    public static func decode(_ data: Data) throws -> Self {
        try JSONDecoder().decode(Self.self, from: data)
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: WireKey.self)
        switch try c.decode(String.self, forKey: .type) {
        case "hello":
            let hello = try Hello(from: decoder)
            guard hello.protocolVersion == protocolVersion else {
                throw ProtocolError.unsupportedVersion(hello.protocolVersion)
            }
            self = .hello(hello)
        case "outputChanged": self = .outputChanged(try c.decode(Output.self, forKey: .output))
        case "layout": self = .layout(try c.decode([WindowLayout].self, forKey: .windows), try c.decode(Output.self, forKey: .output))
        case "windowOpened": self = .windowOpened(try c.decode(WindowInfo.self, forKey: .window))
        case "windowChanged": self = .windowChanged(try c.decode(WindowInfo.self, forKey: .window))
        case "windowClosed": self = .windowClosed(try c.decode(UInt64.self, forKey: .id))
        case "focusChanged": self = .focusChanged(try c.decode(UInt64?.self, forKey: .id))
        case "role": self = .role(try c.decode(Bool.self, forKey: .primary))
        case "peers": self = .peers(try c.decode([PeerInfo].self, forKey: .peers))
        case "fullscreenRequest": self = .fullscreenRequest(window: try c.decode(UInt64.self, forKey: .window), fullscreen: try c.decode(Bool.self, forKey: .fullscreen))
        case "engineVersion": self = .engineVersion(try c.decode(String.self, forKey: .version))
        case "windowBlank": self = .windowBlank(id: try c.decode(UInt64.self, forKey: .id), blank: try c.decode(Bool.self, forKey: .blank))
        case "error": self = .error(request: try c.decode(String.self, forKey: .request), message: try c.decode(String.self, forKey: .message))
        case "pong": self = .pong
        case "gaming", "apps", "appIcons", "accounts", "alreadyRunning", "windowless", "fileChooser", "fileChooserClosed",
             "dirListing", "pathInfo", "clipReady", "clipAdded", "clipDropped", "clipCleared", "clipHistory", "keyBinding":
            self = .administration(type: try c.decode(String.self, forKey: .type), value: try WireValue(from: decoder))
        default: self = .unknown(try c.decode(String.self, forKey: .type))
        }
    }
}

public enum Codec: String, Codable, Sendable { case hevc, h264 }
public enum AudioQuality: String, Codable, Sendable { case auto, high, medium, low }
public enum ClientCommand: Encodable, Sendable, Equatable {
    case administration(type: String, fields: [String: WireValue])
    case setViewport(width: UInt32, height: UInt32, scale: Double)
    case setLayout(windows: [WindowLayout])
    case setStreams(windows: [UInt64], codecs: [Codec])
    case setAudio(enabled: Bool, local: Bool, opus: Bool, quality: AudioQuality)
    case setGamepad(enabled: Bool)
    case gamepadButton(button: UInt32, pressed: Bool)
    case gamepadAxis(axis: UInt32, value: Double)
    case pointerMotion(window: UInt64, x: Double, y: Double, normalized: Bool)
    case pointerButton(button: UInt32, pressed: Bool)
    case pointerAxis(horizontal: Double, vertical: Double)
    case pointerLeave
    case key(key: UInt32, pressed: Bool)
    case focusWindow(id: UInt64)
    case closeWindow(id: UInt64)
    case spawn(command: String, terminal: Bool)
    case takeControl
    case ping

    public func encoded() throws -> Data { try JSONEncoder().encode(self) }
    public func encode(to encoder: any Encoder) throws {
        if case .administration(let type, var fields) = self {
            fields["type"] = .string(type)
            try WireValue.object(fields).encode(to: encoder)
            return
        }
        var c = encoder.container(keyedBy: WireKey.self)
        func tag(_ type: String) throws { try c.encode(type, forKey: .type) }
        switch self {
        case .administration: break
        case let .setViewport(width, height, scale):
            try tag("setViewport"); try c.encode(width, forKey: .width); try c.encode(height, forKey: .height); try c.encode(scale, forKey: .scale)
        case let .setLayout(windows):
            try tag("setLayout"); try c.encode(windows, forKey: .windows); try c.encodeNil(forKey: .animate)
        case let .setStreams(windows, codecs):
            try tag("setStreams"); try c.encode(windows, forKey: .windows); try c.encode(codecs, forKey: .codecs)
        case let .setAudio(enabled, local, opus, quality):
            try tag("setAudio"); try c.encode(enabled, forKey: .enabled); try c.encode(local, forKey: .local); try c.encode(opus, forKey: .opus); try c.encode(quality, forKey: .quality)
        case let .setGamepad(enabled): try tag("setGamepad"); try c.encode(enabled, forKey: .enabled)
        case let .gamepadButton(button, pressed): try tag("gamepadButton"); try c.encode(button, forKey: .button); try c.encode(pressed, forKey: .pressed)
        case let .gamepadAxis(axis, value): try tag("gamepadAxis"); try c.encode(axis, forKey: .axis); try c.encode(value, forKey: .value)
        case let .pointerMotion(window, x, y, normalized):
            try tag("pointerMotion"); try c.encode(window, forKey: .window); try c.encode(x, forKey: .x); try c.encode(y, forKey: .y); try c.encode(normalized, forKey: .normalized)
        case let .pointerButton(button, pressed): try tag("pointerButton"); try c.encode(button, forKey: .button); try c.encode(pressed, forKey: .pressed)
        case let .pointerAxis(horizontal, vertical): try tag("pointerAxis"); try c.encode(horizontal, forKey: .horizontal); try c.encode(vertical, forKey: .vertical)
        case .pointerLeave: try tag("pointerLeave")
        case let .key(key, pressed): try tag("key"); try c.encode(key, forKey: .key); try c.encode(pressed, forKey: .pressed)
        case let .focusWindow(id): try tag("focusWindow"); try c.encode(id, forKey: .id)
        case let .closeWindow(id): try tag("closeWindow"); try c.encode(id, forKey: .id)
        case let .spawn(command, terminal): try tag("spawn"); try c.encode(command, forKey: .command); try c.encode(terminal, forKey: .terminal)
        case .takeControl: try tag("takeControl")
        case .ping: try tag("ping")
        }
    }
}
private enum WireKey: String, CodingKey {
    case type, output, windows, window, id, primary, peers, fullscreen, version, blank, request, message
    case width, height, scale, animate, codecs, enabled, local, opus, quality, button, pressed, axis, value
    case x, y, normalized, horizontal, vertical, key, command, terminal
}
