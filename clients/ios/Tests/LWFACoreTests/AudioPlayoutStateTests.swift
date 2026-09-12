import XCTest
@testable import LWFACore

final class AudioPlayoutStateTests: XCTestCase {
    func testDrainRequiresFreshPrerollBeforeRestart() throws {
        var state = AudioPlayoutState()
        let first = try XCTUnwrap(state.enqueue(frames: 960))
        let second = try XCTUnwrap(state.enqueue(frames: 960))
        let third = try XCTUnwrap(state.enqueue(frames: 960))
        XCTAssertFalse(first.start)
        XCTAssertFalse(second.start)
        XCTAssertTrue(third.start)
        XCTAssertFalse(state.rendered(first))
        XCTAssertFalse(state.rendered(second))
        XCTAssertTrue(state.rendered(third))
        XCTAssertFalse(state.playing, "A drained player must rebuffer even if AVAudioPlayerNode.isPlaying stays true")
        XCTAssertFalse(try XCTUnwrap(state.enqueue(frames: 960)).start)
        XCTAssertFalse(try XCTUnwrap(state.enqueue(frames: 960)).start)
        XCTAssertTrue(try XCTUnwrap(state.enqueue(frames: 960)).start)
    }

    func testOverflowFlushesOldSoundAndIgnoresItsCompletions() throws {
        var state = AudioPlayoutState()
        let old = try XCTUnwrap(state.enqueue(frames: 4_800))
        let fresh = try XCTUnwrap(state.enqueue(frames: 960))
        XCTAssertTrue(fresh.flush)
        XCTAssertFalse(fresh.start)
        XCTAssertFalse(state.rendered(old))
        XCTAssertEqual(state.queuedFrames, 960)
        XCTAssertFalse(try XCTUnwrap(state.enqueue(frames: 960)).start)
        XCTAssertTrue(try XCTUnwrap(state.enqueue(frames: 960)).start)
    }

    func testGraphResetRejectsOldCompletionsDuringNewPlayback() throws {
        var state = AudioPlayoutState()
        let old = try XCTUnwrap(state.enqueue(frames: 2_880))
        state.reset()
        let new = try XCTUnwrap(state.enqueue(frames: 2_880))
        XCTAssertFalse(state.rendered(old))
        XCTAssertEqual(state.queuedFrames, 2_880)
        XCTAssertTrue(state.rendered(new))
    }

    func testInvalidDurationsDoNotDisturbPlayback() throws {
        var state = AudioPlayoutState()
        _ = state.enqueue(frames: 2_880)
        for frames in [0, -1, 4_801, Int.max] { XCTAssertNil(state.enqueue(frames: frames)) }
        XCTAssertEqual(state.queuedFrames, 2_880)
        XCTAssertTrue(state.playing)
    }
}
