import Foundation
import XCTest
import COpus
@testable import LWFACore

final class OpusAudioDecoderTests: XCTestCase {
    private func packet(_ payload: Data, frames: UInt32 = 960) -> AudioPacket {
        AudioPacket(format: .opus, channels: 2, sampleRate: 48_000, frames: frames, payload: payload)
    }

    func testRawPacketSilenceAndReset() throws {
        let decoder = try OpusAudioDecoder()
        let silence = packet(Data([0xf8, 0xff, 0xfe]))
        let first = try decoder.decode(silence)
        XCTAssertEqual(first.count, 1_920)
        XCTAssertTrue(first.allSatisfy { $0.isFinite && abs($0) < 0.001 })
        _ = try decoder.decode(silence)
        decoder.reset()
        XCTAssertEqual(try decoder.decode(silence), first)
    }

    func testActualStereoEncoderPacketsPreserveChannels() throws {
        var error: Int32 = 0
        let encoder = try XCTUnwrap(opus_encoder_create(48_000, 2, OPUS_APPLICATION_AUDIO, &error))
        defer { opus_encoder_destroy(encoder) }
        XCTAssertEqual(error, OPUS_OK)
        let decoder = try OpusAudioDecoder()
        var output: [Float] = []
        for block in 0..<8 {
            let input: [Float] = (0..<960).flatMap { frame -> [Float] in
                let t = Double(block * 960 + frame) / 48_000
                return [Float(sin(t * 440 * 2 * .pi)) * 0.5, Float(sin(t * 880 * 2 * .pi)) * 0.2]
            }
            var bytes = [UInt8](repeating: 0, count: 4_000)
            let size = opus_encode_float(encoder, input, 960, &bytes, Int32(bytes.count))
            XCTAssertGreaterThan(size, 0)
            output = try decoder.decode(packet(Data(bytes.prefix(Int(size)))))
        }
        let left = stride(from: 0, to: output.count, by: 2).reduce(Float(0)) { $0 + output[$1] * output[$1] }
        let right = stride(from: 1, to: output.count, by: 2).reduce(Float(0)) { $0 + output[$1] * output[$1] }
        XCTAssertGreaterThan(left, 50)
        XCTAssertGreaterThan(right, 5)
        XCTAssertGreaterThan(left, right * 3)
    }

    func testRejectsMalformedAndMismatchedDurationWithoutOversizedOutput() throws {
        let decoder = try OpusAudioDecoder()
        for bad in [packet(Data()), packet(Data([0xff])), packet(Data([0xf8, 0xff, 0xfe]), frames: 4_800),
                    packet(Data(repeating: 0, count: 65_537)), packet(Data([0x80, 0xff, 0xfe]))] {
            XCTAssertThrowsError(try decoder.decode(bad))
        }
        XCTAssertEqual(try decoder.decode(packet(Data([0xf8, 0xff, 0xfe]))).count, 1_920)
    }
}
