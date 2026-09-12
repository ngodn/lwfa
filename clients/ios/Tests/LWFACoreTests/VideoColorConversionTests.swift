import XCTest
@testable import LWFACore

final class VideoColorConversionTests: XCTestCase {
    func testBlackWhiteAndNeutralAcrossDepthsRangesAndMatrices() {
        for tenBit in [false, true] {
            let packing: Float = tenBit ? 64 : 1
            let maximum: Float = tenBit ? 65_535 : 255
            let scale: Float = tenBit ? 4 : 1
            let neutral = 128 * scale * packing / maximum
            for fullRange in [false, true] {
                let black: Float = fullRange ? 0 : 16 * scale * packing / maximum
                let white = (fullRange ? (tenBit ? 1_023 : 255) : 235 * scale) * packing / maximum
                for matrix: VideoColorConversion.Matrix in [.bt601, .bt709, .bt2020] {
                    let conversion = VideoColorConversion(matrix: matrix, fullRange: fullRange, tenBit: tenBit)
                    for (y, expected) in [(black, Float(0)), (white, Float(1)), ((black + white) / 2, Float(0.5))] {
                        let result = conversion.rgb(y: y, cb: neutral, cr: neutral)
                        for channel in 0..<3 {
                            XCTAssertEqual(result[channel], expected, accuracy: 0.000_01,
                                           "depth=\(tenBit ? 10 : 8), fullRange=\(fullRange), matrix=\(matrix)")
                        }
                    }
                }
            }
        }
    }

    func testBT709VideoRangePrimaries() {
        let conversion = VideoColorConversion(matrix: .bt709, fullRange: false, tenBit: false)
        // BT.709 YCbCr values calculated from unit R, G, B, without integer
        // quantization. This also catches transposed shader matrix columns.
        for rgb in [SIMD3<Float>(1, 0, 0), SIMD3<Float>(0, 1, 0), SIMD3<Float>(0, 0, 1)] {
            let luma = 0.2126 * rgb.x + 0.7152 * rgb.y + 0.0722 * rgb.z
            let cb = (rgb.z - luma) / (2 * (1 - 0.0722))
            let cr = (rgb.x - luma) / (2 * (1 - 0.2126))
            let result = conversion.rgb(y: (16 + 219 * luma) / 255,
                                        cb: (128 + 224 * cb) / 255,
                                        cr: (128 + 224 * cr) / 255)
            for channel in 0..<3 { XCTAssertEqual(result[channel], rgb[channel], accuracy: 0.000_01) }
        }
    }
}
