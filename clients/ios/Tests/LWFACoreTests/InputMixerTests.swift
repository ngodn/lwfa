import XCTest
@testable import LWFACore

final class InputMixerTests: XCTestCase {
    func testVirtualReleaseCannotReleasePhysicalHold() {
        var input = InputMixer()
        XCTAssertEqual(input.button(5, pressed: true, source: "physical"), .gamepadButton(button: 5, pressed: true))
        XCTAssertNil(input.button(5, pressed: true, source: "virtual"))
        XCTAssertTrue(input.release(source: "virtual").isEmpty)
        XCTAssertEqual(input.release(source: "physical"), [.gamepadButton(button: 5, pressed: false)])
    }
    func testOverlappingKeyboardChordsKeepSharedModifier() {
        var input = InputMixer()
        _ = input.key(29, pressed: true, source: "copy")
        _ = input.key(46, pressed: true, source: "copy")
        _ = input.key(29, pressed: true, source: "paste")
        _ = input.key(47, pressed: true, source: "paste")
        XCTAssertEqual(input.release(source: "copy"), [.key(key: 46, pressed: false)])
        XCTAssertEqual(input.releaseAll(), [.key(key: 29, pressed: false), .key(key: 47, pressed: false)])
    }
    func testAnalogReturnsToOtherSourceBeforeNeutral() {
        var input = InputMixer()
        XCTAssertEqual(input.axis(0, value: 0.6, source: "physical"), .gamepadAxis(axis: 0, value: 0.6))
        XCTAssertEqual(input.axis(0, value: -1, source: "touch"), .gamepadAxis(axis: 0, value: -1))
        XCTAssertEqual(input.release(source: "touch"), [.gamepadAxis(axis: 0, value: 0.6)])
        XCTAssertEqual(input.releaseAll(), [.gamepadAxis(axis: 0, value: 0)])
    }
}
