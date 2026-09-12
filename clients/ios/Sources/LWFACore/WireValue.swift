import Foundation

/// Extensible administrative payloads, preserving integer identifiers exactly.
public enum WireValue: Codable, Equatable, Sendable {
    case null, bool(Bool), int(Int64), uint(UInt64), double(Double), string(String)
    case array([WireValue]), object([String: WireValue])

    public init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(UInt64.self) { self = .uint(v) }
        else if let v = try? value.decode(Int64.self) { self = .int(v) }
        else if let v = try? value.decode(Double.self) { self = .double(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([WireValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: WireValue].self)) }
    }
    public func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let v): try value.encode(v)
        case .int(let v): try value.encode(v)
        case .uint(let v): try value.encode(v)
        case .double(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        }
    }
    public subscript(_ key: String) -> WireValue { objectValue[key] ?? .null }
    public var objectValue: [String: WireValue] { if case .object(let v) = self { v } else { [:] } }
    public var arrayValue: [WireValue] { if case .array(let v) = self { v } else { [] } }
    public var stringValue: String { if case .string(let v) = self { v } else { "" } }
    public var boolValue: Bool { if case .bool(let v) = self { v } else { false } }
    public var uintValue: UInt64 {
        switch self {
        case .uint(let v): v
        case .int(let v): UInt64(clamping: v)
        default: 0
        }
    }
    public var doubleValue: Double {
        switch self {
        case .double(let v): v
        case .uint(let v): Double(v)
        case .int(let v): Double(v)
        default: 0
        }
    }
    public static func decode(_ data: Data) throws -> WireValue { try JSONDecoder().decode(Self.self, from: data) }
    public func encoded() throws -> Data { try JSONEncoder().encode(self) }
}
