import Dispatch
import XCTest
import LWFACore

final class VideoDecodeAdmissionsTests: XCTestCase {
    func testOverflowRetiresEvenTheKeyframeQueuedBeforeTheGap() throws {
        let admissions = VideoDecodeAdmissions()
        let queuedKeyframe = try XCTUnwrap(admissions.acquire())
        let queuedDeltas = try (0..<5).map { _ in try XCTUnwrap(admissions.acquire()) }
        XCTAssertTrue(queuedKeyframe.isCurrent)
        XCTAssertTrue(queuedDeltas.allSatisfy(\.isCurrent))

        XCTAssertNil(admissions.acquire())
        XCTAssertFalse(queuedKeyframe.isCurrent)
        XCTAssertTrue(queuedDeltas.allSatisfy { !$0.isCurrent })

        queuedKeyframe.finish()
        queuedDeltas.forEach { $0.finish() }
        let postGap = try XCTUnwrap(admissions.acquire())
        XCTAssertTrue(postGap.isCurrent)
        XCTAssertTrue(admissions.consumeDiscontinuity())
        XCTAssertFalse(admissions.consumeDiscontinuity())
    }

    func testDecoderDropRetiresQueuedReferencesAndRecoveryExpiresOnReset() throws {
        let admissions = VideoDecodeAdmissions()
        let inFlight = try XCTUnwrap(admissions.acquire())
        let queued = try XCTUnwrap(admissions.acquire())
        let recoveryGeneration = admissions.breakChain()

        XCTAssertFalse(inFlight.isCurrent)
        XCTAssertFalse(queued.isCurrent)
        XCTAssertTrue(admissions.isCurrent(recoveryGeneration))
        XCTAssertTrue(admissions.consumeDiscontinuity())
        admissions.reset()
        XCTAssertFalse(admissions.isCurrent(recoveryGeneration))
        XCTAssertFalse(admissions.consumeDiscontinuity())
    }

    func testResetDoesNotReleaseDecoderResourcesThatAreStillInFlight() throws {
        let admissions = VideoDecodeAdmissions()
        let old = try (0..<6).map { _ in try XCTUnwrap(admissions.acquire()) }
        admissions.reset()
        XCTAssertTrue(old.allSatisfy { !$0.isCurrent })
        XCTAssertNil(admissions.acquire())

        old[0].finish()
        let new = try XCTUnwrap(admissions.acquire())
        XCTAssertTrue(new.isCurrent)
        old.dropFirst().forEach { $0.finish() }
        XCTAssertTrue(new.isCurrent)
    }

    func testDuplicateConcurrentCompletionCannotReleaseExtraSlots() throws {
        let admissions = VideoDecodeAdmissions()
        let ticket = try XCTUnwrap(admissions.acquire())
        DispatchQueue.concurrentPerform(iterations: 64) { _ in ticket.finish() }

        let next = try (0..<6).map { _ in try XCTUnwrap(admissions.acquire()) }
        XCTAssertNil(admissions.acquire())
        next.forEach { $0.finish() }
    }

    func testAbandonedTicketReleasesItsAdmission() throws {
        let admissions = VideoDecodeAdmissions()
        for _ in 0..<24 {
            let ticket = try XCTUnwrap(admissions.acquire())
            XCTAssertTrue(ticket.isCurrent)
        }
        let remaining = try (0..<6).map { _ in try XCTUnwrap(admissions.acquire()) }
        XCTAssertNil(admissions.acquire())
        remaining.forEach { $0.finish() }
    }

    func testDelayedRecoveryCanCheckGenerationAfterWorkHasFinished() throws {
        let admissions = VideoDecodeAdmissions()
        let ticket = try XCTUnwrap(admissions.acquire())
        ticket.finish()
        XCTAssertTrue(ticket.isCurrent)
        admissions.reset()
        XCTAssertFalse(ticket.isCurrent)
    }
}
