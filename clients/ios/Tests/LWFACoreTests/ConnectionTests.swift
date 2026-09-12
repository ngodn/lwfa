import Foundation
import XCTest
@testable import LWFACore

final class ConnectionTests: XCTestCase {
    func testBackgroundKeepsEstablishedWorkspaceUntilExplicitDisconnect() {
        var state = ConnectionProgress()
        state.begin(); state.accepted(); state.pause()
        XCTAssertTrue(state.established)
        XCTAssertTrue(state.showsWorkspace, "Backgrounding must not replace the workspace with the login form")
        state.startAttempt()
        XCTAssertEqual(state.phase, .reconnecting)
        state.cancel()
        XCTAssertFalse(state.showsWorkspace)
    }

    func testHTTPSAddressesKeepTheirSchemePortAndHandshakeTimeout() throws {
        for address in ["https://192.168.1.51:8443", "https://example.tail123.ts.net"] {
            let endpoint = try ServerEndpoint(address)
            let request = try endpoint.request(token: "private+token", clientID: "native-test")
            XCTAssertEqual(request.timeoutInterval, 20)
            XCTAssertEqual(request.url?.scheme, "wss")
            XCTAssertEqual(request.url?.port, endpoint.publicURL.port)
            XCTAssertEqual(request.url?.host, endpoint.publicURL.host)
            XCTAssertEqual(request.url?.path, "/engine")
        }
    }

    func testFailedFirstHandshakeNeverShowsWorkspaceOrRetries() {
        for code in [URLError.timedOut, .serverCertificateUntrusted, .cannotFindHost] {
            var state = ConnectionProgress()
            state.begin()
            XCTAssertEqual(state.phase, .connecting)
            XCTAssertFalse(state.showsWorkspace)
            XCTAssertFalse(state.failed(retryable: ConnectionFailure(URLError(code)).retryable))
            XCTAssertEqual(state.phase, .idle)
            XCTAssertFalse(state.showsWorkspace)
        }
    }

    func testEstablishedSessionRetriesAndExhaustionReturnsToForm() {
        var state = ConnectionProgress()
        state.begin(); state.accepted()
        for attempt in 1...6 {
            XCTAssertTrue(state.failed(retryable: true))
            XCTAssertEqual(state.retries, attempt)
            state.startAttempt()
            XCTAssertEqual(state.phase, .reconnecting)
            XCTAssertTrue(state.showsWorkspace)
        }
        XCTAssertFalse(state.failed(retryable: true))
        XCTAssertFalse(state.showsWorkspace)
    }

    func testCancelAndNewServerDiscardPreviousConnectionHistory() {
        var state = ConnectionProgress()
        state.begin(); state.accepted(); state.cancel()
        XCTAssertEqual(state.phase, .idle)
        state.begin()
        XCTAssertFalse(state.failed(retryable: true))
        state.begin(); state.accepted(); state.begin()
        XCTAssertFalse(state.showsWorkspace)
        XCTAssertFalse(state.failed(retryable: true))
    }

    func testResumeDistinguishesInitialHandshakeFromEstablishedSession() {
        var state = ConnectionProgress()
        state.begin(); state.pause(); state.startAttempt()
        XCTAssertEqual(state.phase, .connecting)
        state.accepted(); state.pause(); state.startAttempt()
        XCTAssertEqual(state.phase, .reconnecting)
        XCTAssertTrue(state.failed(retryable: true))
        state.accepted()
        XCTAssertEqual(state.retries, 0)
        XCTAssertFalse(state.failed(retryable: false))
        XCTAssertFalse(state.showsWorkspace)
    }

    func testErrorDescriptionsAreSpecificAndNeverExposeCredentials() {
        let secret = "https://example.test/engine?token=TOPSECRET"
        let error = NSError(domain: NSURLErrorDomain, code: URLError.cannotFindHost.rawValue,
                            userInfo: [NSLocalizedDescriptionKey: secret, NSURLErrorFailingURLStringErrorKey: secret])
        let dns = ConnectionFailure(error)
        XCTAssertTrue(dns.message.contains("resolved"))
        XCTAssertFalse(dns.message.contains("TOPSECRET"))
        XCTAssertTrue(dns.message.contains("-1003"))
        XCTAssertFalse(ConnectionFailure(URLError(.serverCertificateUntrusted)).retryable)
        XCTAssertTrue(ConnectionFailure(URLError(.serverCertificateUntrusted)).message.contains("not trusted"))
        XCTAssertTrue(ConnectionFailure(URLError(.timedOut)).message.contains("timed out"))
        XCTAssertFalse(ConnectionFailure(error, httpStatus: 401).retryable)
        XCTAssertTrue(ConnectionFailure(error, httpStatus: 401).message.contains("password"))
        XCTAssertTrue(ConnectionFailure(error, httpStatus: 502).retryable)
        XCTAssertFalse(ConnectionFailure(error, httpStatus: 404).retryable)
        XCTAssertFalse(ConnectionFailure(error, replaced: true).retryable)
    }
}
