import Foundation
import XCTest
@testable import LWFACore

final class SessionRestorationTests: XCTestCase {
    func testTemporaryInactivityDoesNotRequestTransportRestart() {
        var activity = SessionActivity()
        XCTAssertEqual(activity.move(to: .active), .resumeInput)
        XCTAssertEqual(activity.move(to: .inactive), .pauseInput)
        XCTAssertFalse(activity.acceptsInput)
        XCTAssertTrue(activity.allowsTransport)
        XCTAssertEqual(activity.move(to: .active), .resumeInput)
        XCTAssertEqual(activity.move(to: .active), .none)
    }

    func testBackgroundThroughInactiveResumesExactlyOnce() {
        var activity = SessionActivity()
        _ = activity.move(to: .active)
        _ = activity.move(to: .inactive)
        XCTAssertEqual(activity.move(to: .background), .suspend)
        XCTAssertFalse(activity.allowsTransport)
        _ = activity.move(to: .inactive)
        XCTAssertFalse(activity.allowsTransport)
        XCTAssertEqual(activity.move(to: .active), .resume)
        XCTAssertEqual(activity.move(to: .active), .none)
    }

    func testCredentialIdentityMatchesEquivalentURLsButIsolatesServers() throws {
        let endpoint = try ServerEndpoint("https://EXAMPLE.test:443/")
        XCTAssertEqual(endpoint.credentialKey, try ServerEndpoint("https://example.test").credentialKey)
        XCTAssertTrue(endpoint.credentialAliases.contains("https://example.test/"))
        XCTAssertNotEqual(endpoint.credentialKey, try ServerEndpoint("https://example.test:8443").credentialKey)
        XCTAssertNotEqual(endpoint.credentialKey, try ServerEndpoint("http://example.test", allowInsecure: true).credentialKey)
        XCTAssertNotEqual(endpoint.credentialKey, try ServerEndpoint("https://example.test/another").credentialKey)
        XCTAssertEqual(try ServerEndpoint("https://example.test/app///").credentialKey, "https://example.test/app")
    }

    func testAuthenticatedSessionSurvivesStoreRecreationAndExplicitClear() throws {
        let suite = "lwfa-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let endpoint = try ServerEndpoint("https://example.test")
        let bookmark = SessionBookmark(endpoint: endpoint, selectedWindow: 7, immersive: true)
        try SessionBookmarkStore(defaults: defaults).save(bookmark)
        let relaunched = SessionBookmarkStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertEqual(relaunched.load(), bookmark)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(bookmark)) as? [String: Any])
        XCTAssertEqual(Set(fields.keys), ["address", "allowInsecure", "selectedWindow", "immersive"])
        relaunched.clear()
        XCTAssertNil(SessionBookmarkStore(defaults: defaults).load())
    }
}
