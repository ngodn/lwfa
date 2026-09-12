import Foundation
import COpus

/// One stateful decoder per audio stream. The caller owns serialization.
public final class OpusAudioDecoder {
    private var decoder: OpaquePointer

    public init() throws {
        var status: Int32 = 0
        guard let decoder = opus_decoder_create(48_000, 2, &status), status == OPUS_OK else {
            throw ProtocolError.invalidPacket
        }
        self.decoder = decoder
    }

    deinit { opus_decoder_destroy(decoder) }

    public func reset() { _ = opus_decoder_init(decoder, 48_000, 2) }

    /// lwfa sends one 20 ms stereo packet, without an Ogg container or OpusHead.
    public func decode(_ packet: AudioPacket) throws -> [Float] {
        guard packet.format == .opus, packet.sampleRate == 48_000, packet.channels == 2,
              packet.frames == 960, !packet.payload.isEmpty, packet.payload.count <= 65_536 else {
            throw ProtocolError.invalidPacket
        }
        var samples = [Float](repeating: 0, count: 1_920)
        let decoded: Int32 = packet.payload.withUnsafeBytes { bytes in
            let input = bytes.bindMemory(to: UInt8.self).baseAddress!
            guard opus_packet_get_nb_samples(input, Int32(bytes.count), 48_000) == 960 else { return OPUS_INVALID_PACKET }
            return opus_decode_float(decoder, input, Int32(bytes.count), &samples, 960, 0)
        }
        guard decoded == 960, samples.allSatisfy(\.isFinite) else {
            reset()
            throw ProtocolError.invalidPacket
        }
        return samples
    }
}
