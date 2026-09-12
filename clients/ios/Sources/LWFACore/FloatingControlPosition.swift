import Foundation

/// A saved fraction of the available travel, independent of screen orientation.
public struct FloatingControlPosition: Sendable, Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x.isFinite ? min(1, max(0, x)) : 1
        self.y = y.isFinite ? min(1, max(0, y)) : 0.18
    }

    private func travel(_ length: Double) -> Double { max(0, length - 72) }
    private func inset(_ length: Double) -> Double { min(36, max(0, length / 2)) }

    public func center(width: Double, height: Double) -> (x: Double, y: Double) {
        (inset(width) + x * travel(width), inset(height) + y * travel(height))
    }

    /// Always apply the total gesture translation to the saved starting point.
    public func translated(x dx: Double, y dy: Double, width: Double, height: Double) -> Self {
        Self(x: x + (travel(width) > 0 ? dx / travel(width) : 0),
             y: y + (travel(height) > 0 ? dy / travel(height) : 0))
    }
}
