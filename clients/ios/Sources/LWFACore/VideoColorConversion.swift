/// YCbCr conversion for CoreVideo's 8-bit NV12 and 10-bit P010 planes sampled
/// through Metal's normalized 8-bit and 16-bit textures. P010 stores each
/// 10-bit code value in the upper bits of a 16-bit word.
public struct VideoColorConversion: Sendable {
    public enum Matrix: Sendable { case bt601, bt709, bt2020 }

    public let columns: (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)
    public let offset: SIMD3<Float>

    public init(matrix: Matrix, fullRange: Bool, tenBit: Bool) {
        let kr: Float, kb: Float
        switch matrix {
        case .bt601: (kr, kb) = (0.299, 0.114)
        case .bt709: (kr, kb) = (0.2126, 0.0722)
        case .bt2020: (kr, kb) = (0.2627, 0.0593)
        }
        let kg = 1 - kr - kb
        let textureMaximum: Float = tenBit ? 65_535 : 255
        let packing: Float = tenBit ? 64 : 1
        let codeMaximum: Float = tenBit ? 1_023 : 255
        let videoScale: Float = tenBit ? 4 : 1
        let ys = textureMaximum / ((fullRange ? codeMaximum : 219 * videoScale) * packing)
        let cs = textureMaximum / ((fullRange ? codeMaximum : 224 * videoScale) * packing)
        columns = (
            SIMD3<Float>(ys, ys, ys),
            SIMD3<Float>(0, -2 * kb * (1 - kb) / kg * cs, 2 * (1 - kb) * cs),
            SIMD3<Float>(2 * (1 - kr) * cs, -2 * kr * (1 - kr) / kg * cs, 0)
        )
        let black = fullRange ? 0 : 16 * videoScale * packing / textureMaximum
        let center = 128 * videoScale * packing / textureMaximum
        offset = SIMD3<Float>(black, center, center)
    }

    public func rgb(y: Float, cb: Float, cr: Float) -> SIMD3<Float> {
        let value = SIMD3<Float>(y, cb, cr) - offset
        return columns.0 * value.x + columns.1 * value.y + columns.2 * value.z
    }
}
