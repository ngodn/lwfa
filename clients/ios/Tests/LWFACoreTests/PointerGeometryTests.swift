import XCTest
@testable import LWFACore

final class PointerGeometryTests: XCTestCase {
    func testParkUsesBrowserMarginAndPixelBounds() {
        XCTAssertEqual(PointerGeometry.park(x: 24, y: 400, width: 1324, height: 838), PointerPoint(x: 0, y: 400))
        XCTAssertEqual(PointerGeometry.park(x: 1300, y: 830, width: 1324, height: 838), PointerPoint(x: 1323, y: 837))
        XCTAssertEqual(PointerGeometry.park(x: 25, y: 25, width: 1324, height: 838), PointerPoint(x: 25, y: 25))
        XCTAssertEqual(PointerGeometry.park(x: -200, y: 1000, width: 1324, height: 838), PointerPoint(x: 0, y: 837))
    }
    func testFastLeaveSnapsOnlyNearestAxis() {
        XCTAssertEqual(PointerGeometry.leave(x: 800, y: 810, width: 1324, height: 838, elapsedMilliseconds: 100), PointerPoint(x: 800, y: 837))
        XCTAssertEqual(PointerGeometry.leave(x: 1100, y: 80, width: 1324, height: 838, elapsedMilliseconds: 250), PointerPoint(x: 1100, y: 0))
        XCTAssertEqual(PointerGeometry.leave(x: 40, y: 400, width: 1324, height: 838, elapsedMilliseconds: 0), PointerPoint(x: 0, y: 400))
        XCTAssertEqual(PointerGeometry.leave(x: 1300, y: 400, width: 1324, height: 838, elapsedMilliseconds: 50), PointerPoint(x: 1323, y: 400))
    }
    func testIdleCenterAndCapturedDragDoNotStartPan() {
        XCTAssertNil(PointerGeometry.leave(x: 20, y: 400, width: 1324, height: 838, elapsedMilliseconds: 251))
        XCTAssertNil(PointerGeometry.leave(x: 662, y: 419, width: 1324, height: 838, elapsedMilliseconds: 10))
        XCTAssertNil(PointerGeometry.leave(x: 20, y: 400, width: 1324, height: 838, elapsedMilliseconds: 10, holdingButton: true))
    }
    func testInvalidGeometryNeverGeneratesMotion() {
        for bad in [Double.nan, .infinity, -.infinity] {
            XCTAssertNil(PointerGeometry.park(x: bad, y: 1, width: 100, height: 100))
            XCTAssertNil(PointerGeometry.leave(x: 1, y: 1, width: 100, height: 100, elapsedMilliseconds: bad))
        }
        XCTAssertNil(PointerGeometry.park(x: 1, y: 1, width: 0, height: 100))
        XCTAssertEqual(PointerGeometry.park(x: 1, y: 1, width: 1, height: 1), PointerPoint(x: 0, y: 0))
    }
}
