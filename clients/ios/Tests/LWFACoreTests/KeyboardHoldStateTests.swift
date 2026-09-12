import XCTest
@testable import LWFACore

final class KeyboardHoldStateTests: XCTestCase {
    func testChangingLatchDuringHoldStillReleasesOriginalModifier() {
        var keyboard = KeyboardHoldState()
        keyboard.toggleModifier(42)
        XCTAssertEqual(keyboard.press(30), [.key(key: 42, pressed: true), .key(key: 30, pressed: true)])
        keyboard.toggleModifier(42)
        XCTAssertEqual(keyboard.lift(30, sticky: true), [.key(key: 30, pressed: false), .key(key: 42, pressed: false)])
    }

    func testOverlappingKeysRetainSharedModifierUntilLastRelease() {
        var keyboard = KeyboardHoldState()
        keyboard.toggleModifier(42)
        _ = keyboard.press(30)
        XCTAssertEqual(keyboard.press(48), [.key(key: 48, pressed: true)])
        XCTAssertEqual(keyboard.lift(30, sticky: true), [.key(key: 30, pressed: false)])
        XCTAssertEqual(keyboard.lift(48, sticky: true), [.key(key: 48, pressed: false), .key(key: 42, pressed: false)])
    }

    func testNormalModeUsesModifierForOnePressOnly() {
        var keyboard = KeyboardHoldState()
        keyboard.toggleModifier(42)
        _ = keyboard.press(30)
        XCTAssertEqual(keyboard.lift(30, sticky: false), [.key(key: 30, pressed: false), .key(key: 42, pressed: false)])
        XCTAssertTrue(keyboard.latched.isEmpty)
        XCTAssertEqual(keyboard.press(48), [.key(key: 48, pressed: true)])
    }

    func testResetClearsLatchAndObsoleteTouchReleases() {
        var keyboard = KeyboardHoldState()
        keyboard.toggleModifier(29)
        _ = keyboard.press(30)
        keyboard.reset()
        XCTAssertTrue(keyboard.latched.isEmpty)
        XCTAssertTrue(keyboard.held.isEmpty)
        XCTAssertTrue(keyboard.lift(30, sticky: true).isEmpty)
        XCTAssertEqual(keyboard.press(30), [.key(key: 30, pressed: true)])
    }
}
