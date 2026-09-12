import Foundation

public struct PointerPoint: Sendable, Equatable {
    public let x: Double
    public let y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// Matches the browser's fullscreen pointer edge behavior in input.ts.
public enum PointerGeometry {
    public static func park(x: Double, y: Double, width: Double, height: Double, margin: Double = 24) -> PointerPoint? {
        guard let point = clamped(x: x, y: y, width: width, height: height), margin.isFinite, margin >= 0 else { return nil }
        let maxX = width - 1, maxY = height - 1
        return PointerPoint(x: point.x <= margin ? 0 : point.x >= maxX - margin ? maxX : point.x,
                            y: point.y <= margin ? 0 : point.y >= maxY - margin ? maxY : point.y)
    }

    public static func leave(x: Double, y: Double, width: Double, height: Double,
                             elapsedMilliseconds: Double, holdingButton: Bool = false, reach: Double = 200) -> PointerPoint? {
        guard !holdingButton, elapsedMilliseconds.isFinite, elapsedMilliseconds >= 0, elapsedMilliseconds <= 250,
              reach.isFinite, reach >= 0, let point = clamped(x: x, y: y, width: width, height: height) else { return nil }
        let maxX = width - 1, maxY = height - 1
        let left = point.x, right = maxX - point.x, top = point.y, bottom = maxY - point.y
        let nearest = min(left, right, top, bottom)
        guard nearest <= reach else { return nil }
        if nearest == left { return PointerPoint(x: 0, y: point.y) }
        if nearest == right { return PointerPoint(x: maxX, y: point.y) }
        if nearest == top { return PointerPoint(x: point.x, y: 0) }
        return PointerPoint(x: point.x, y: maxY)
    }

    private static func clamped(x: Double, y: Double, width: Double, height: Double) -> PointerPoint? {
        guard [x, y, width, height].allSatisfy(\.isFinite), width >= 1, height >= 1 else { return nil }
        return PointerPoint(x: max(0, min(width - 1, x)), y: max(0, min(height - 1, y)))
    }
}
