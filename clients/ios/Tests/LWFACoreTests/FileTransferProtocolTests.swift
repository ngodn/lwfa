import Foundation
import XCTest
import LWFACore

final class FileTransferProtocolTests: XCTestCase {
    func testTicketEndpointPreservesProxyPrefixAndEscapesFormValues() throws {
        let result = try FileTransferProtocol.endpoint(base: URL(string: "https://example.test/lwfa/")!,
            operation: "upload", query: ["request": "4", "ticket": "a+b&c= d"])
        XCTAssertEqual(result.scheme, "wss")
        XCTAssertEqual(result.path, "/lwfa/engine/upload")
        XCTAssertTrue(result.absoluteString.contains("%2B"))
        XCTAssertEqual(URLComponents(url: result, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "ticket" })?.value, "a+b&c= d")
        XCTAssertFalse(result.absoluteString.contains("token="))
        let clip = try FileTransferProtocol.endpoint(base: URL(string: "http://192.0.2.1:6734")!,
            operation: "clip", query: ["channel": "8", "ticket": "safe", "id": "9"])
        XCTAssertEqual(clip.scheme, "http")
        XCTAssertEqual(clip.port, 6734)
        XCTAssertEqual(clip.path, "/engine/clip")
    }

    func testCredentialBearingOrUnknownEndpointsAreRejected() {
        for base in ["https://user:pass@example.test", "https://example.test?token=secret", "file:///tmp/a"] {
            XCTAssertThrowsError(try FileTransferProtocol.endpoint(base: URL(string: base)!, operation: "upload", query: [:]))
        }
        XCTAssertThrowsError(try FileTransferProtocol.endpoint(base: URL(string: "https://example.test")!,
                                                               operation: "engine", query: [:]))
    }

    func testUploadFramingAndResumeBounds() throws {
        let begin = try WireValue.decode(FileTransferProtocol.begin(request: 10, file: "opaque-id", name: "file.bin",
                                                                    relative: ["folder"], size: UInt64.max))
        XCTAssertEqual(begin["type"], .string("uploadBegin"))
        XCTAssertEqual(begin["size"], .uint(UInt64.max))
        XCTAssertEqual(begin["rel"], .array([.string("folder")]))
        let end = try WireValue.decode(FileTransferProtocol.end(request: 10, file: "opaque-id", sha256: String(repeating: "a", count: 64)))
        XCTAssertEqual(end["type"], .string("uploadEnd"))
        let reply = WireValue.object(["type": .string("uploadOffset"), "request": .uint(10),
                                     "file": .string("opaque-id"), "offset": .uint(23)])
        XCTAssertEqual(try FileTransferProtocol.offset(reply, request: 10, file: "opaque-id", size: 24), 23)
        XCTAssertThrowsError(try FileTransferProtocol.offset(reply, request: 10, file: "opaque-id", size: 22))
        XCTAssertThrowsError(try FileTransferProtocol.offset(reply, request: 11, file: "opaque-id", size: 24))
        XCTAssertThrowsError(try FileTransferProtocol.offset(reply, request: 10, file: "another-file", size: 24))
        XCTAssertEqual(FileTransferProtocol.chunkBytes, 262_144)
    }
}
