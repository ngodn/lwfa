import XCTest
@testable import LWFACore

final class NavigationLayoutTests: XCTestCase {
    private let order = ["info", "connections", "access", "theme", "settings", "apps", "escape", "gamepad", "mouse", "keyboard", "clipboard", "workspaces"]

    func testCollapsedTabsStayCanonicalWhileExpandedControlsFollowUserOrder() throws {
        let collapsed = NavigationLayout.resolve(visible: order) { $0 <= 5 }
        XCTAssertEqual(collapsed.map(\.id), ["more", "apps", "escape", "input", "workspaces"])
        XCTAssertEqual(try XCTUnwrap(collapsed.first { $0.id == "input" }).members, ["keyboard", "mouse", "gamepad"])
        XCTAssertEqual(try XCTUnwrap(collapsed.first { $0.id == "more" }).members, ["clipboard", "info", "connections", "access", "theme", "settings"])
        let expanded = NavigationLayout.resolve(visible: order) { $0 <= 7 }
        XCTAssertEqual(expanded.map(\.id), ["more", "apps", "escape", "gamepad", "mouse", "keyboard", "workspaces"])
    }

    func testMixedZoneGroupKeepsAnchoredControlAtTheEnd() throws {
        let collapsed = NavigationLayout.resolve(visible: order) { $0 <= 5 }
        // Clipboard comes last in the user's order but anchors the whole More group.
        let zones = NavigationLayout.zones(collapsed, anchored: ["clipboard", "gamepad"], centred: ["apps", "info", "keyboard"])
        XCTAssertEqual(zones.end.map(\.id), ["more", "input"])
        XCTAssertEqual(zones.centre.map(\.id), ["apps"])
        XCTAssertEqual(zones.start.map(\.id), ["escape", "workspaces"])
        let centre = NavigationLayout.zones(collapsed, anchored: [], centred: ["settings"])
        XCTAssertEqual(centre.centre.map(\.id), ["more"])
    }

    func testHiddenAndUnavailableItemsDoNotReappearInGroups() throws {
        let visible = order.filter { !["access", "keyboard", "mouse"].contains($0) }
        let collapsed = NavigationLayout.resolve(visible: visible) { $0 <= 5 }
        XCTAssertFalse(collapsed.contains { $0.id == "input" })
        XCTAssertTrue(collapsed.contains { $0.id == "gamepad" })
        XCTAssertFalse(collapsed.flatMap(\.members).contains("access"))
        XCTAssertEqual(try XCTUnwrap(collapsed.first { $0.id == "more" }).members, ["clipboard", "info", "connections", "theme", "settings"])
    }

    func testTinyViewportRetainsFloorForScrollingAndWideViewportRestoresAll() {
        let narrow = NavigationLayout.resolve(visible: order) { $0 <= 1 }
        XCTAssertEqual(narrow.map(\.id), ["more", "apps", "workspaces"])
        XCTAssertEqual(NavigationLayout.resolve(visible: order) { $0 <= 20 }.map(\.id), order)
        XCTAssertEqual(NavigationLayout.resolve(visible: []) { $0 <= 0 }, [])
    }
}
