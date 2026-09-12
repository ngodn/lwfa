import Foundation
import XCTest
@testable import LWFACore

final class CoreTests: XCTestCase {
    private func fixture(_ folder: String, _ name: String) throws -> Data {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try Data(contentsOf: root.appendingPathComponent("fixtures/proto/\(folder)/\(name).json"))
    }
    private func equalJSON(_ command: ClientCommand, fixture name: String) throws {
        let actual = try JSONSerialization.jsonObject(with: command.encoded()) as? NSDictionary
        let expected = try JSONSerialization.jsonObject(with: fixture("to-engine", name)) as? NSDictionary
        XCTAssertEqual(actual, expected, name)
    }
    func testCanonicalRustGreetings() throws {
        guard case let .hello(hello) = try ServerMessage.decode(fixture("to-shell", "hello")) else { return XCTFail() }
        XCTAssertEqual(hello.protocolVersion, 2)
        XCTAssertEqual(hello.output, Output(width: 1920, height: 1080))
        XCTAssertEqual(hello.windows.map(\.id), [1, 2])
        XCTAssertEqual(hello.permissions.mode, .interact)
        XCTAssertNil(hello.permissions.allowedApps)
        XCTAssertEqual(hello.peers.first?.device, "iPad")
        guard case let .hello(empty) = try ServerMessage.decode(fixture("to-shell", "hello-empty")) else { return XCTFail() }
        XCTAssertTrue(empty.windows.isEmpty)
        XCTAssertNil(empty.focused)
        XCTAssertEqual(empty.permissions.mode, .view)
        XCTAssertEqual(empty.permissions.allowedApps, ["org.example.Thing"])
    }
    func testCanonicalRustWindowEvents() throws {
        for name in ["output-changed", "window-opened", "window-changed", "window-closed", "focus-changed", "focus-cleared", "layout", "role", "peers", "engine-version", "window-blank", "pong"] {
            let message = try ServerMessage.decode(fixture("to-shell", name))
            if case .unknown = message { XCTFail("Missing decoder for \(name)") }
        }
        guard case let .layout(windows, output) = try ServerMessage.decode(fixture("to-shell", "layout")) else { return XCTFail() }
        XCTAssertEqual(output.height, 1080)
        XCTAssertEqual(windows.first?.rect, Rect(x: 12, y: 12, width: 640, height: 1056))
    }
    func testCanonicalRustCommands() throws {
        try equalJSON(.setLayout(windows: []), fixture: "set-layout-empty")
        try equalJSON(.setLayout(windows: [.init(id: 1, rect: .init(x: 0, y: 0, width: 1920, height: 1080))]), fixture: "set-layout-immediate")
        try equalJSON(.setStreams(windows: [1, 2], codecs: [.hevc, .h264]), fixture: "set-streams")
        try equalJSON(.setStreams(windows: [], codecs: [.hevc, .h264]), fixture: "set-streams-none")
        try equalJSON(.setAudio(enabled: true, local: false, opus: true, quality: .auto), fixture: "set-audio")
        try equalJSON(.gamepadButton(button: 10, pressed: true), fixture: "gamepad-button")
        try equalJSON(.gamepadAxis(axis: 1, value: -0.75), fixture: "gamepad-axis")
        try equalJSON(.ping, fixture: "ping")
        try equalJSON(.takeControl, fixture: "take-control")
    }
    func testIntegerIDsAreNeverRoutedThroughDouble() throws {
        XCTAssertEqual(try ServerMessage.decode(Data(#"{"type":"windowClosed","id":18446744073709551615}"#.utf8)), .windowClosed(UInt64.max))
        let command = try ClientCommand.focusWindow(id: UInt64.max).encoded()
        XCTAssertTrue(String(decoding: command, as: UTF8.self).contains("18446744073709551615"))
        for id in ["-1", "1.5", "18446744073709551616"] {
            XCTAssertThrowsError(try ServerMessage.decode(Data("{\"type\":\"windowClosed\",\"id\":\(id)}".utf8)))
        }
    }
    func testMalformedJSONAndFutureProtocol() throws {
        XCTAssertThrowsError(try ServerMessage.decode(Data("{".utf8)))
        XCTAssertThrowsError(try ServerMessage.decode(Data(#"{"type":"windowOpened"}"#.utf8)))
        let hello = String(decoding: try fixture("to-shell", "hello"), as: UTF8.self)
        XCTAssertThrowsError(try ServerMessage.decode(Data(hello.replacingOccurrences(of: "\"protocolVersion\": 2", with: "\"protocolVersion\": 99").utf8))) { error in
            XCTAssertEqual(error as? ProtocolError, .unsupportedVersion(99))
        }
        XCTAssertEqual(try ServerMessage.decode(Data(#"{"type":"futureOptionalNotification"}"#.utf8)), .unknown("futureOptionalNotification"))
    }
    func testRustVideoHeaderAndUnalignedDataSlice() throws {
        var raw = video()
        raw.replaceSubrange(8..<16, with: Array(repeating: 0xff, count: 8))
        let packet = try VideoPacket.parse(raw)
        XCTAssertEqual(packet.window, UInt64.max)
        XCTAssertEqual(packet.width, 1261)
        XCTAssertEqual(packet.height, 1390)
        XCTAssertEqual(packet.format, .jpeg)
        XCTAssertTrue(packet.keyframe)
        XCTAssertEqual(packet.payload, Data([0xff, 0xd8, 0xff, 0xe0]))
        var padded = Data([0xff]); padded.append(raw)
        XCTAssertEqual(try VideoPacket.parse(padded.dropFirst()), packet)
    }
    func testVideoRejectsTruncatedOversizedUnknownAndZeroDimensions() {
        let good = video()
        for count in 0...24 { XCTAssertThrowsError(try VideoPacket.parse(Data(good.prefix(count)))) }
        for (offset, value) in [(0, 0), (4, 1), (5, 255)] {
            var bad = good; bad[offset] = UInt8(value)
            XCTAssertThrowsError(try VideoPacket.parse(bad))
        }
        for offset in [16, 20] {
            var bad = good; bad.replaceSubrange(offset..<offset+4, with: [0, 0, 0, 0])
            XCTAssertThrowsError(try VideoPacket.parse(bad))
            bad.replaceSubrange(offset..<offset+4, with: [255, 255, 255, 255])
            XCTAssertThrowsError(try VideoPacket.parse(bad))
        }
        XCTAssertThrowsError(try VideoPacket.parse(Data(count: VideoPacket.maximumPacketBytes + 1)))
    }
    func testH264AndHEVCFlags() throws {
        for format in [VideoFormat.h264, .hevc] {
            var raw = video(); raw[5] = format.rawValue; raw[6] = 0
            let packet = try VideoPacket.parse(raw)
            XCTAssertEqual(packet.format, format)
            XCTAssertFalse(packet.keyframe)
        }
    }
    func testPCMHasExactFrameSizeAndOpusDoesNot() throws {
        let raw = audio()
        let packet = try AudioPacket.parse(raw)
        XCTAssertEqual(packet.format, .pcm16)
        XCTAssertEqual(packet.channels, 2)
        XCTAssertEqual(packet.sampleRate, 48_000)
        XCTAssertEqual(packet.frames, 2)
        XCTAssertEqual(packet.payload.count, 8)
        XCTAssertThrowsError(try AudioPacket.parse(raw.dropLast()))
        var long = raw; long.append(0)
        XCTAssertThrowsError(try AudioPacket.parse(long))
        var opus = raw; opus[5] = 1
        XCTAssertEqual(try AudioPacket.parse(opus.dropLast()).format, .opus)
    }
    func testAudioRejectsMalformedHeadersAndAllocationBombs() {
        let good = audio()
        for count in 0...16 { XCTAssertThrowsError(try AudioPacket.parse(Data(good.prefix(count)))) }
        for (offset, value) in [(0, 0), (4, 1), (5, 255), (6, 0), (6, 9)] {
            var bad = good; bad[offset] = UInt8(value)
            XCTAssertThrowsError(try AudioPacket.parse(bad))
        }
        for offset in [8, 12] {
            var bad = good; bad.replaceSubrange(offset..<offset+4, with: [255, 255, 255, 255])
            XCTAssertThrowsError(try AudioPacket.parse(bad))
        }
        XCTAssertThrowsError(try AudioPacket.parse(Data(count: AudioPacket.maximumPacketBytes + 1)))
        XCTAssertThrowsError(try AudioPacket.parse(video()))
        XCTAssertThrowsError(try VideoPacket.parse(audio()))
    }
    func testAnnexBMixedPrefixesEmulationPreventionAndTrailingZeros() throws {
        let data = Data([0, 0, 0, 1, 0x67, 0x42, 0, 0, 3, 1, 0x80, 0, 0, 1, 0x68, 0x80, 0, 0])
        XCTAssertEqual(try AnnexB.nalUnits(data), [Data([0x67, 0x42, 0, 0, 3, 1, 0x80]), Data([0x68, 0x80])])
        XCTAssertEqual(try AnnexB.lengthPrefixed(data), Data([0, 0, 0, 7, 0x67, 0x42, 0, 0, 3, 1, 0x80, 0, 0, 0, 2, 0x68, 0x80]))
    }
    func testAnnexBRejectsMissingPrefixesAndEmptyNALs() {
        for bytes: [UInt8] in [[], [0, 0], [0, 0, 1], [9, 0, 0, 1, 0x65], [0, 0, 1, 0, 0, 1, 0x65]] {
            XCTAssertThrowsError(try AnnexB.nalUnits(Data(bytes)))
        }
        XCTAssertThrowsError(try AnnexB.nalUnits(Data(Array(repeating: [UInt8](arrayLiteral: 0, 0, 1, 0x65), count: 4097).flatMap { $0 })))
    }
    func testInputReleasePreservesHoldsAndResetsAllSources() {
        var state = InputState()
        XCTAssertEqual(state.updateButton(5, pressed: true), .gamepadButton(button: 5, pressed: true))
        XCTAssertNil(state.updateButton(5, pressed: true))
        XCTAssertEqual(state.updateAxis(5, value: 0.75), .gamepadAxis(axis: 5, value: 0.75))
        _ = state.updateAxis(0, value: -0.4)
        _ = state.updatePointerButton(272, pressed: true)
        _ = state.updateKey(30, pressed: true)
        XCTAssertEqual(state.releaseAll(), [.gamepadButton(button: 5, pressed: false), .gamepadAxis(axis: 0, value: 0), .gamepadAxis(axis: 5, value: 0), .pointerButton(button: 272, pressed: false), .key(key: 30, pressed: false)])
        XCTAssertTrue(state.releaseAll().isEmpty)
        XCTAssertNotNil(state.updateButton(5, pressed: true))
    }
    func testInputFiltersInvalidAxesAndClampsTriggers() {
        var state = InputState()
        XCTAssertNil(state.updateAxis(6, value: 1))
        XCTAssertNil(state.updateAxis(0, value: .nan))
        XCTAssertNil(state.updateAxis(0, value: .infinity))
        XCTAssertNil(state.updateAxis(4, value: -1))
        XCTAssertEqual(state.updateAxis(4, value: 4), .gamepadAxis(axis: 4, value: 1))
        XCTAssertEqual(state.updateAxis(2, value: -4), .gamepadAxis(axis: 2, value: -1))
        XCTAssertNil(state.updateButton(17, pressed: true))
    }
    func testEndpointKeepsSecretsOutOfDisplayAndEncodesQueryExactly() throws {
        let endpoint = try ServerEndpoint("https://example.test/lwfa/")
        let token = "a&b+%?#雪"
        let request = try endpoint.request(token: token, clientID: "test-client")
        let url = try XCTUnwrap(request.url)
        let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.scheme, "wss")
        XCTAssertEqual(parts.path, "/lwfa/engine")
        XCTAssertFalse(parts.percentEncodedQuery!.contains("+"))
        XCTAssertTrue(parts.percentEncodedQuery!.contains("%2B"))
        XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "token" })?.value, token)
        XCTAssertEqual(endpoint.description, "https://example.test/lwfa/")
        XCTAssertFalse(endpoint.description.contains(token))
        XCTAssertEqual(try ServerEndpoint("wss://example.test").request(token: "a", clientID: "b").url?.path, "/engine")
    }
    func testEndpointRejectsCredentialsAndRequiresInsecureOptIn() throws {
        for url in ["https://user:secret@example.test", "https://example.test?token=secret", "https://example.test/#secret", "file:///tmp/a", "example.test", "https://example.test:99999"] {
            XCTAssertThrowsError(try ServerEndpoint(url))
        }
        XCTAssertThrowsError(try ServerEndpoint("http://192.168.1.2:8080"))
        XCTAssertEqual(try ServerEndpoint("http://192.168.1.2:8080", allowInsecure: true).request(token: "a", clientID: "b").url?.scheme, "ws")
    }

    private func video() -> Data {
        Data([0x4c, 0x57, 0x46, 0x41, 0, 0, 1, 0, 7, 0, 0, 0, 0, 0, 0, 0,
              0xed, 4, 0, 0, 0x6e, 5, 0, 0, 0xff, 0xd8, 0xff, 0xe0])
    }
    private func audio() -> Data {
        Data([0x4c, 0x57, 0x46, 0x50, 0, 0, 2, 0, 0x80, 0xbb, 0, 0, 2, 0, 0, 0,
              0, 0, 0xff, 0x7f, 0, 0x80, 1, 0])
    }
}
