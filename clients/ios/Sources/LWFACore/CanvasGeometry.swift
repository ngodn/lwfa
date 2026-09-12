import Foundation

public struct NormalizedPoint: Sendable, Equatable {
    public let x: Double
    public let y: Double
}

/// Logical canvas coordinates. Display pixel density does not change app geometry.
public enum CanvasGeometry {
    public static func viewport(width: Double, height: Double) -> Output? {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
        func dimension(_ value: Double) -> UInt32 {
            UInt32(min(8192, max(2, value)).rounded(.down)) & ~1
        }
        return Output(width: dimension(width), height: dimension(height), scale: 1)
    }

    /// Matches an aspect-fit renderer, including the exact letterbox offset.
    public static func fit(contentWidth: Double, contentHeight: Double,
                           availableWidth: Double, availableHeight: Double) -> Rect {
        let zero = Rect(x: 0, y: 0, width: 0, height: 0)
        guard [contentWidth, contentHeight, availableWidth, availableHeight].allSatisfy({ $0.isFinite && $0 > 0 }) else { return zero }
        let scale = min(availableWidth / contentWidth, availableHeight / contentHeight)
        // Floating-point multiplication can exceed the fitted bound by an ulp.
        let width = min(availableWidth, contentWidth * scale)
        let height = min(availableHeight, contentHeight * scale)
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return zero }
        return Rect(x: (availableWidth - width) / 2, y: (availableHeight - height) / 2,
                    width: width, height: height)
    }

    /// Ignore input in letterbox bars instead of turning it into an edge click.
    public static func normalizedPoint(x: Double, y: Double, in rect: Rect) -> NormalizedPoint? {
        guard [x, y, rect.x, rect.y, rect.width, rect.height].allSatisfy(\.isFinite),
              rect.width > 0, rect.height > 0 else { return nil }
        let nx = (x - rect.x) / rect.width
        let ny = (y - rect.y) / rect.height
        guard (0...1).contains(nx), (0...1).contains(ny) else { return nil }
        return NormalizedPoint(x: nx, y: ny)
    }

    /// Primary sessions submit every window. Omitting one would minimize it.
    public static func layout(windowIDs: [UInt64], selected: UInt64, output: Output,
                              previous: [WindowLayout]) -> [WindowLayout] {
        var known: [UInt64: WindowLayout] = [:]
        for window in previous { known[window.id] = window }
        var seen = Set<UInt64>()
        let ids = windowIDs.filter { seen.insert($0).inserted }
        // A close can race a layout. Keep a visible app while selection catches up.
        let active = ids.contains(selected) ? selected : ids.first
        let width = Double(output.width)
        let height = Double(output.height)
        let offscreenX = width + 64
        return ids.enumerated().map { index, id in
            if id == active {
                return WindowLayout(id: id, rect: Rect(x: 0, y: 0, width: width, height: height),
                                    z: Int32(clamping: ids.count))
            }
            let previousRect = known[id]?.rect
            let oldWidth = previousRect?.width ?? width
            let oldHeight = previousRect?.height ?? height
            return WindowLayout(id: id,
                                rect: Rect(x: offscreenX, y: 0,
                                           width: oldWidth.isFinite && oldWidth > 0 ? oldWidth : width,
                                           height: oldHeight.isFinite && oldHeight > 0 ? oldHeight : height),
                                z: Int32(clamping: index))
        }
    }
}
