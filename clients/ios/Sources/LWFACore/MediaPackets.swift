import Foundation

public enum VideoFormat: UInt8, Sendable { case jpeg = 0, h264 = 1, hevc = 2 }
public enum AudioFormat: UInt8, Sendable { case pcm16 = 0, opus = 1 }

public struct VideoPacket: Sendable, Equatable {
    public let window: UInt64
    public let width: UInt32
    public let height: UInt32
    public let format: VideoFormat
    public let keyframe: Bool
    public let payload: Data
    public static let headerLength = 24
    public static let maximumPacketBytes = 64 * 1024 * 1024

    public static func parse(_ data: Data) throws -> Self {
        guard data.count > headerLength, data.count <= maximumPacketBytes else { throw ProtocolError.invalidPacket }
        return try data.withUnsafeBytes { bytes in
            guard bytes[0] == 0x4c, bytes[1] == 0x57, bytes[2] == 0x46, bytes[3] == 0x41,
                  bytes[4] == 0, let format = VideoFormat(rawValue: bytes[5]) else {
                throw ProtocolError.invalidPacket
            }
            let width = UInt32(readLE(bytes, at: 16, count: 4))
            let height = UInt32(readLE(bytes, at: 20, count: 4))
            // Bound decoder allocations independently of compressed payload size.
            guard width > 0, height > 0, width <= 16_384, height <= 16_384,
                  UInt64(width) * UInt64(height) <= 67_108_864 else { throw ProtocolError.invalidPacket }
            return Self(window: readLE(bytes, at: 8, count: 8), width: width, height: height,
                        format: format, keyframe: bytes[6] & 1 != 0,
                        payload: Data(data.dropFirst(headerLength)))
        }
    }
}

public struct AudioPacket: Sendable, Equatable {
    public let format: AudioFormat
    public let channels: UInt8
    public let sampleRate: UInt32
    public let frames: UInt32
    public let payload: Data
    public static let headerLength = 16
    public static let maximumPacketBytes = 8 * 1024 * 1024

    public static func parse(_ data: Data) throws -> Self {
        guard data.count > headerLength, data.count <= maximumPacketBytes else { throw ProtocolError.invalidPacket }
        return try data.withUnsafeBytes { bytes in
            guard bytes[0] == 0x4c, bytes[1] == 0x57, bytes[2] == 0x46, bytes[3] == 0x50,
                  bytes[4] == 0, let format = AudioFormat(rawValue: bytes[5]) else { throw ProtocolError.invalidPacket }
            let channels = bytes[6]
            let sampleRate = UInt32(readLE(bytes, at: 8, count: 4))
            let frames = UInt32(readLE(bytes, at: 12, count: 4))
            guard channels > 0, channels <= 8, sampleRate > 0, sampleRate <= 384_000,
                  frames > 0, frames <= sampleRate else { throw ProtocolError.invalidPacket }
            if format == .pcm16 {
                guard UInt64(data.count - headerLength) == UInt64(frames) * UInt64(channels) * 2 else {
                    throw ProtocolError.invalidPacket
                }
            }
            return Self(format: format, channels: channels, sampleRate: sampleRate, frames: frames,
                        payload: Data(data.dropFirst(headerLength)))
        }
    }
}

// Bytewise access works for Data slices and unaligned WebSocket buffers on ARM.
private func readLE(_ bytes: UnsafeRawBufferPointer, at offset: Int, count: Int) -> UInt64 {
    var result: UInt64 = 0
    for i in 0..<count { result |= UInt64(bytes[offset + i]) << (i * 8) }
    return result
}

public enum AnnexB {
    /// NAL units without start codes, accepting both three- and four-byte prefixes.
    public static func nalUnits(_ data: Data) throws -> [Data] {
        guard !data.isEmpty, data.count <= VideoPacket.maximumPacketBytes else { throw ProtocolError.invalidAnnexB }
        return try data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            var starts: [(prefix: Int, payload: Int)] = []
            var zeros = 0
            for i in bytes.indices {
                if bytes[i] == 0 { zeros += 1; continue }
                if bytes[i] == 1, zeros >= 2 {
                    starts.append((i - zeros, i + 1))
                    guard starts.count <= 4096 else { throw ProtocolError.invalidAnnexB }
                }
                zeros = 0
            }
            guard let first = starts.first, first.prefix == 0 else { throw ProtocolError.invalidAnnexB }
            var units: [Data] = []
            for i in starts.indices {
                var end = i + 1 < starts.count ? starts[i + 1].prefix : bytes.count
                // Annex B trailing_zero_8bits are framing, not part of the NAL.
                while end > starts[i].payload, bytes[end - 1] == 0 { end -= 1 }
                guard end > starts[i].payload else { throw ProtocolError.invalidAnnexB }
                units.append(Data(bytes: bytes.baseAddress!.advanced(by: starts[i].payload), count: end - starts[i].payload))
            }
            return units
        }
    }

    /// The four-byte big-endian lengths expected by a VideoToolbox sample buffer.
    public static func lengthPrefixed(_ data: Data) throws -> Data {
        let units = try nalUnits(data)
        var result = Data()
        result.reserveCapacity(data.count + units.count)
        for unit in units {
            let count = UInt32(unit.count)
            result.append(contentsOf: [UInt8(truncatingIfNeeded: count >> 24), UInt8(truncatingIfNeeded: count >> 16),
                                       UInt8(truncatingIfNeeded: count >> 8), UInt8(truncatingIfNeeded: count)])
            result.append(unit)
        }
        return result
    }
}
