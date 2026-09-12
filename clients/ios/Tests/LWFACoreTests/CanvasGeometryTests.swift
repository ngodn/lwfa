import XCTest
@testable import LWFACore

final class CanvasGeometryTests: XCTestCase {
    func testViewportUsesLogicalPointsFloorsEvenAndClamps() {
        XCTAssertEqual(CanvasGeometry.viewport(width: 1325.9, height: 839.1), Output(width: 1324, height: 838))
        XCTAssertEqual(CanvasGeometry.viewport(width: 0.5, height: 1), Output(width: 2, height: 2))
        XCTAssertEqual(CanvasGeometry.viewport(width: 100_000, height: 8193), Output(width: 8192, height: 8192))
        for invalid in [Double.nan, .infinity, -.infinity, 0, -1] {
            XCTAssertNil(CanvasGeometry.viewport(width: invalid, height: 500))
            XCTAssertNil(CanvasGeometry.viewport(width: 1000, height: invalid))
        }
    }

    func testLetterboxCoordinatesAndCorners() throws {
        let frame = CanvasGeometry.fit(contentWidth: 1920, contentHeight: 1080, availableWidth: 1000, availableHeight: 1000)
        XCTAssertEqual(frame, Rect(x: 0, y: 218.75, width: 1000, height: 562.5))
        let topLeft = try XCTUnwrap(CanvasGeometry.normalizedPoint(x: 0, y: 218.75, in: frame))
        XCTAssertEqual(topLeft.x, 0); XCTAssertEqual(topLeft.y, 0)
        let bottomRight = try XCTUnwrap(CanvasGeometry.normalizedPoint(x: 1000, y: 781.25, in: frame))
        XCTAssertEqual(bottomRight.x, 1); XCTAssertEqual(bottomRight.y, 1)
        let center = try XCTUnwrap(CanvasGeometry.normalizedPoint(x: 500, y: 500, in: frame))
        XCTAssertEqual(center.x, 0.5); XCTAssertEqual(center.y, 0.5)
        XCTAssertNil(CanvasGeometry.normalizedPoint(x: 500, y: 218, in: frame))
        XCTAssertNil(CanvasGeometry.normalizedPoint(x: 500, y: 782, in: frame))
        XCTAssertNil(CanvasGeometry.normalizedPoint(x: .nan, y: 500, in: frame))
        XCTAssertEqual(CanvasGeometry.fit(contentWidth: 100, contentHeight: 200, availableWidth: 300, availableHeight: 200),
                       Rect(x: 100, y: 0, width: 100, height: 200))
    }

    func testEmptyAndInvalidGeometryCannotGenerateInput() {
        let zero = CanvasGeometry.fit(contentWidth: 0, contentHeight: 1080, availableWidth: 1000, availableHeight: 1000)
        XCTAssertEqual(zero.width, 0)
        XCTAssertNil(CanvasGeometry.normalizedPoint(x: 0, y: 0, in: zero))
        XCTAssertEqual(CanvasGeometry.fit(contentWidth: 1, contentHeight: 1, availableWidth: .infinity, availableHeight: 1).height, 0)
    }

    func testLayoutRetainsEveryWindowAndInactiveSizes() {
        let old: [WindowLayout] = [
            .init(id: 1, rect: .init(x: 12, y: 12, width: 600, height: 400)),
            .init(id: UInt64.max, rect: .init(x: 624, y: 12, width: 900, height: 700)),
        ]
        let layout = CanvasGeometry.layout(windowIDs: [1, UInt64.max, 3], selected: UInt64.max,
                                           output: Output(width: 1324, height: 838), previous: old)
        XCTAssertEqual(layout.map(\.id), [1, UInt64.max, 3])
        XCTAssertEqual(layout[1].rect, Rect(x: 0, y: 0, width: 1324, height: 838))
        XCTAssertGreaterThan(layout[1].z, layout[0].z)
        XCTAssertGreaterThan(layout[1].z, layout[2].z)
        XCTAssertEqual(layout[0].rect.width, 600)
        XCTAssertEqual(layout[0].rect.height, 400)
        XCTAssertGreaterThanOrEqual(layout[0].rect.x, 1388)
        XCTAssertGreaterThanOrEqual(layout[2].rect.x, 1388)
        XCTAssertEqual(layout[2].rect.width, 1324)
        XCTAssertEqual(layout[2].rect.height, 838)
    }

    func testClosedSelectionAndDuplicateNotificationsStaySafe() {
        let output = Output(width: 1000, height: 500)
        XCTAssertTrue(CanvasGeometry.layout(windowIDs: [], selected: 4, output: output, previous: []).isEmpty)
        let result = CanvasGeometry.layout(windowIDs: [1, 1, 2], selected: 4, output: output, previous: [])
        XCTAssertEqual(result.map(\.id), [1, 2])
        XCTAssertEqual(result[0].rect, Rect(x: 0, y: 0, width: 1000, height: 500))
        XCTAssertEqual(result[1].rect.x, 1064)
    }
}
