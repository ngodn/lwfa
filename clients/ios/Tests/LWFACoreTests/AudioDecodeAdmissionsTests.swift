import XCTest
@testable import LWFACore

final class AudioDecodeAdmissionsTests: XCTestCase {
    func testBurstKeepsAcceptedSoundAndResetsHistoryOnlyAfterGap() throws {
        let queue = AudioDecodeAdmissions(capacity: 2)
        let first = try XCTUnwrap(queue.acquire())
        let second = try XCTUnwrap(queue.acquire())
        XCTAssertNil(queue.acquire())
        XCTAssertTrue(first.isCurrent)
        XCTAssertTrue(second.isCurrent)
        XCTAssertFalse(first.discontinuity)
        XCTAssertFalse(second.discontinuity)
        first.finish()
        let afterGap = try XCTUnwrap(queue.acquire())
        XCTAssertTrue(afterGap.discontinuity)
        second.finish()
        let next = try XCTUnwrap(queue.acquire())
        XCTAssertFalse(next.discontinuity)
    }

    func testResetInvalidatesOldSoundWithoutReleasingBusySlots() throws {
        let queue = AudioDecodeAdmissions(capacity: 1)
        let old = try XCTUnwrap(queue.acquire())
        queue.reset()
        XCTAssertFalse(old.isCurrent)
        XCTAssertNil(queue.acquire())
        old.finish()
        let next = try XCTUnwrap(queue.acquire())
        XCTAssertTrue(next.isCurrent)
        XCTAssertTrue(next.discontinuity)
    }

    func testFinishingTwiceCannotExceedBound() throws {
        let queue = AudioDecodeAdmissions(capacity: 1)
        let old = try XCTUnwrap(queue.acquire())
        old.finish()
        old.finish()
        let current = try XCTUnwrap(queue.acquire())
        XCTAssertNil(queue.acquire())
        XCTAssertTrue(current.isCurrent)
    }
}
