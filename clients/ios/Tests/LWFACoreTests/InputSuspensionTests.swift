import XCTest
@testable import LWFACore

final class InputSuspensionTests: XCTestCase {
    func testClosingEditorDoesNotResumeBehindConfirmation() {
        var state = InputSuspension()
        XCTAssertTrue(state.set(true, owner: "editor"))
        XCTAssertFalse(state.set(true, owner: "confirmation"))
        XCTAssertFalse(state.set(false, owner: "editor"))
        XCTAssertTrue(state.isSuspended)
        XCTAssertTrue(state.set(false, owner: "confirmation"))
        XCTAssertFalse(state.isSuspended)
    }

    func testRepeatedViewUpdatesDoNotRearmInput() {
        var state = InputSuspension()
        XCTAssertTrue(state.set(true, owner: "panel"))
        XCTAssertFalse(state.set(true, owner: "panel"))
        XCTAssertFalse(state.set(false, owner: "unrelated"))
        XCTAssertTrue(state.set(false, owner: "panel"))
        XCTAssertFalse(state.set(false, owner: "panel"))
    }
}
