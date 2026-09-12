import XCTest
@testable import LWFACore

final class FloatingControlPositionTests: XCTestCase {
    func testTranslationFollowsFingerWithoutAccumulatingEarlierSamples() {
        let start = FloatingControlPosition(x: 0.5, y: 0.5)
        let initial = start.center(width: 1000, height: 700)
        for dx in [6.0, 12, 28, 44, -10] {
            let next = start.translated(x: dx, y: 15, width: 1000, height: 700)
            let point = next.center(width: 1000, height: 700)
            XCTAssertEqual(point.x, initial.x + dx, accuracy: 1e-9)
            XCTAssertEqual(point.y, initial.y + 15, accuracy: 1e-9)
        }
        XCTAssertEqual(start, FloatingControlPosition(x: 0.5, y: 0.5))
    }

    func testClampsEdgesAndCanReturnAfterDraggingPastThem() {
        let start = FloatingControlPosition(x: 0.5, y: 0.5)
        let edge = start.translated(x: 10000, y: -10000, width: 1000, height: 700)
        XCTAssertEqual(edge.center(width: 1000, height: 700).x, 964)
        XCTAssertEqual(edge.center(width: 1000, height: 700).y, 36)
        XCTAssertEqual(start.translated(x: 0, y: 0, width: 1000, height: 700), start)
    }

    func testSavedPositionAdaptsToRotationAndTinyViewports() {
        let saved = FloatingControlPosition(x: 1, y: 1)
        XCTAssertEqual(saved.center(width: 700, height: 1000).x, 664)
        XCTAssertEqual(saved.center(width: 700, height: 1000).y, 964)
        let tiny = saved.translated(x: 100, y: -100, width: 40, height: 20)
        XCTAssertEqual(tiny.center(width: 40, height: 20).x, 20)
        XCTAssertEqual(tiny.center(width: 40, height: 20).y, 10)
    }
}
