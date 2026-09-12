import Foundation
import XCTest
@testable import LWFACore

final class GamepadLayoutTests: XCTestCase {
    func testBrowserBackupImportsAndExportsExactSchema() throws {
        let data = Data(browserBackup.utf8)
        let backup = try GamepadBackup.read(data)
        XCTAssertEqual(backup.pads, GamepadLayout.defaultPads)
        XCTAssertEqual(backup.settings, .init(skin: "xbox", opacity: 0.7, haptics: false, mode: "controller"))
        let before = try JSONSerialization.jsonObject(with: data) as? NSDictionary
        let after = try JSONSerialization.jsonObject(with: backup.encoded()) as? NSDictionary
        XCTAssertEqual(before, after)
    }
    func testLegacyArrayAndFutureBackupVersionPreservePads() throws {
        let bare = try JSONEncoder().encode(GamepadLayout.defaultPads)
        XCTAssertEqual(try GamepadBackup.read(bare).settings, GamepadBackupSettings())
        let future = browserBackup.replacingOccurrences(of: "\"version\":1", with: "\"version\":42")
        XCTAssertEqual(try GamepadBackup.read(Data(future.utf8)).version, 1)
    }
    func testMalformedAndOverlargeBackupsAreRejectedWithoutPartialRestore() throws {
        for data in [Data(), Data("null".utf8), Data("[]".utf8), Data(#"{"kind":"another.app","pads":[]}"#.utf8), Data(count: 1_048_577)] {
            XCTAssertThrowsError(try GamepadBackup.read(data))
        }
        let pads = Array(repeating: GamepadLayout.defaultPads[0], count: 129)
        XCTAssertThrowsError(try GamepadBackup.read(JSONEncoder().encode(pads)))
    }
    func testClampAndInvalidControlFiltering() throws {
        var pad = GamepadLayout.defaultPads[0]
        pad.x = -30; pad.y = 300; pad.size = 0
        var invalid = pad; invalid.id = "invalid"; invalid.chord = [9999]
        let data = try JSONEncoder().encode([pad, invalid, pad])
        let result = try GamepadBackup.read(data)
        XCTAssertEqual(result.pads.count, 1)
        XCTAssertEqual(result.pads[0].x, 3)
        XCTAssertEqual(result.pads[0].y, 97)
        XCTAssertEqual(result.pads[0].size, 6)
    }
    func testBackupSettingsFallbackIndependently() throws {
        var root = try WireValue.decode(Data(browserBackup.utf8)).objectValue
        root["settings"] = .object(["skin": .string("alien"), "opacity": .double(50), "haptics": .bool(false), "mode": .string("keyboard")])
        let backup = try GamepadBackup.read(WireValue.object(root).encoded())
        XCTAssertEqual(backup.settings, .init(skin: "neutral", opacity: 1, haptics: false, mode: "keyboard"))
    }
    func testEveryStandardButtonIsReachable() {
        var buttons = Set<UInt32>()
        for pad in GamepadLayout.defaultPads {
            for (x,y) in [(0.0,0.0),(0,-1),(1,0),(0,1),(-1,0)] {
                for command in GamepadLayout.commands(pad, mode: "controller", pressed: true, x: x, y: y) {
                    if case .gamepadButton(let button, true) = command { buttons.insert(button) }
                }
            }
        }
        XCTAssertEqual(buttons, Set(0...16))
    }
    func testTriggerIncludesDigitalAndAnalogRelease() throws {
        let pad = try XCTUnwrap(GamepadLayout.defaultPads.first { $0.id == "r2" })
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "controller", pressed: true), [.gamepadButton(button: 7, pressed: true), .gamepadAxis(axis: 5, value: 1)])
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "controller", pressed: false), [.gamepadButton(button: 7, pressed: false), .gamepadAxis(axis: 5, value: 0)])
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "keyboard", pressed: true), [.key(key: 18, pressed: true)])
    }
    func testStickBoundsDirectionAndNeutral() throws {
        let pad = try XCTUnwrap(GamepadLayout.defaultPads.first { $0.id == "rstick" })
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "controller", pressed: true, x: 10, y: 0), [.gamepadAxis(axis: 2, value: 1), .gamepadAxis(axis: 3, value: 0)])
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "controller", pressed: false, x: 1, y: -1), [.gamepadAxis(axis: 2, value: 0), .gamepadAxis(axis: 3, value: 0)])
        XCTAssertTrue(GamepadLayout.commands(pad, mode: "controller", pressed: true, x: .nan).isEmpty)
        let keys = GamepadLayout.commands(pad, mode: "keyboard", pressed: true, x: 1, y: -1)
        XCTAssertEqual(keys, [.key(key: 103, pressed: true), .key(key: 106, pressed: true), .key(key: 108, pressed: false), .key(key: 105, pressed: false)])
    }
    func testKeyboardChordPressAndReverseRelease() {
        let pad = GamepadPad(id: "custom", kind: "key", face: "key", x: 50, y: 60, size: 11, chord: [29, 42, 35])
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "controller", pressed: true), [.key(key: 29, pressed: true), .key(key: 42, pressed: true), .key(key: 35, pressed: true)])
        XCTAssertEqual(GamepadLayout.commands(pad, mode: "controller", pressed: false), [.key(key: 35, pressed: false), .key(key: 42, pressed: false), .key(key: 29, pressed: false)])
        XCTAssertEqual(GamepadLayout.label(pad, skin: "neutral"), "Ctrl+Shift+H")
    }
    func testVirtualReleaseCannotClearPhysicalHold() {
        var mixer = InputMixer()
        XCTAssertEqual(mixer.button(5, pressed: true, source: "physical"), .gamepadButton(button: 5, pressed: true))
        XCTAssertNil(mixer.button(5, pressed: true, source: "pad:r1"))
        XCTAssertTrue(mixer.release(source: "pad:r1").isEmpty)
        XCTAssertEqual(mixer.release(source: "physical"), [.gamepadButton(button: 5, pressed: false)])
    }
    // Generated from packages/shell/src/gamepad/model.ts DEFAULT_LAYOUT using Node.
    private let browserBackup = #"{"kind":"lwfa.gamepad","version":1,"savedAt":"2026-09-12T00:00:00.000Z","settings":{"skin":"xbox","opacity":0.7,"haptics":false,"mode":"controller"},"pads":[{"id":"l2","kind":"trigger","face":"l2","x":8,"y":9,"size":13,"code":42},{"id":"l1","kind":"trigger","face":"l1","x":8,"y":23,"size":13,"code":29},{"id":"r2","kind":"trigger","face":"r2","x":92,"y":9,"size":13,"code":18},{"id":"r1","kind":"trigger","face":"r1","x":92,"y":23,"size":13,"code":33},{"id":"dpad","kind":"dpad","face":"dpad","x":15,"y":44,"size":22,"directions":[103,106,108,105]},{"id":"lstick","kind":"stick","face":"lstick","x":18,"y":78,"size":22,"directions":[17,32,31,30]},{"id":"north","kind":"button","face":"north","x":86,"y":40,"size":12,"code":19},{"id":"west","kind":"button","face":"west","x":77,"y":51,"size":12,"code":34},{"id":"east","kind":"button","face":"east","x":94,"y":51,"size":12,"code":48},{"id":"south","kind":"button","face":"south","x":86,"y":62,"size":12,"code":57},{"id":"rstick","kind":"stick","face":"rstick","x":80,"y":82,"size":22,"directions":[103,106,108,105]},{"id":"l3","kind":"button","face":"l3","x":5,"y":36,"size":11,"code":46},{"id":"r3","kind":"button","face":"r3","x":95,"y":36,"size":11,"code":50},{"id":"select","kind":"button","face":"select","x":42,"y":12,"size":9,"code":15},{"id":"guide","kind":"button","face":"guide","x":50,"y":12,"size":9,"code":125},{"id":"start","kind":"button","face":"start","x":58,"y":12,"size":9,"code":1}]}"#
}

final class StickShapingTests: XCTestCase {
    func testAnalogDeadZoneExpoAndQuantisation() {
        XCTAssertEqual(GamepadLayout.stickValue(x: 0.03, y: 0.02, pressed: true, analog: true).x, 0, "Inside the 5% dead zone")
        let half = GamepadLayout.stickValue(x: 0.5, y: 0, pressed: true, analog: true)
        // linear = (0.5 - 0.05) / 0.95 ≈ 0.4737; shaped = linear · (0.45 + 0.55 · linear) ≈ 0.3366; quantised to 1/64.
        XCTAssertEqual(half.x, (0.3366 * 64).rounded() / 64, accuracy: 1 / 128)
        XCTAssertEqual(half.y, 0)
        XCTAssertEqual(GamepadLayout.stickValue(x: 3, y: 4, pressed: true, analog: true).x, 0.6, accuracy: 1 / 64, "Past the rim is clamped to a unit vector")
        XCTAssertEqual(GamepadLayout.stickValue(x: 1, y: 1, pressed: false, analog: true).x, 0)
    }
    func testDigitalUsesWiderDeadZoneAndUnitDirections() {
        XCTAssertEqual(GamepadLayout.stickValue(x: 0.2, y: 0, pressed: true, analog: false).x, 0, "Inside the 25% dead zone")
        let diagonal = GamepadLayout.stickValue(x: 1, y: 1, pressed: true, analog: false)
        XCTAssertEqual(diagonal.x, 0.7071, accuracy: 0.001)
        XCTAssertEqual(diagonal.y, 0.7071, accuracy: 0.001)
    }
}
