/// The browser shell's navigation collapse policy, independent of UI geometry.
public enum NavigationLayout {
    public struct Slot: Identifiable, Equatable, Sendable {
        public let id: String
        public let members: [String]
        public var isGroup: Bool { NavigationLayout.groupMembers[id] != nil && members.count > 1 }
        public init(id: String, members: [String]) { self.id = id; self.members = members }
    }

    public struct Zones: Equatable, Sendable {
        public var start: [Slot] = []
        public var centre: [Slot] = []
        public var end: [Slot] = []
        public var all: [Slot] { start + centre + end }
    }

    public static let groupMembers = [
        "input": ["keyboard", "mouse", "gamepad"],
        "more": ["clipboard", "info", "connections", "access", "theme", "settings"],
    ]
    private static let tiers: [[String]] = [
        [],
        ["info", "connections", "access", "theme", "settings", "apps", "escape", "input", "clipboard", "workspaces"],
        ["apps", "escape", "workspaces", "input", "more"],
        ["apps", "workspaces", "more"],
    ]

    /// Select the roomiest tier, then restore direct controls in priority order.
    /// A group uses canonical panel tab order; restored buttons use rail order.
    public static func resolve(visible: [String], fits: (Int) -> Bool) -> [Slot] {
        let tier = tiers.first { fits(slots(tier: $0, visible: visible).count) } ?? tiers[tiers.count - 1]
        var expanded: Set<String> = []
        for group in ["input", "more"] {
            let candidate = expanded.union([group])
            if fits(slots(tier: tier, visible: visible, expanded: candidate).count) { expanded = candidate }
        }
        return slots(tier: tier, visible: visible, expanded: expanded)
    }

    private static func slots(tier: [String], visible: [String], expanded: Set<String> = []) -> [Slot] {
        if tier.isEmpty { return visible.map { Slot(id: $0, members: [$0]) } }
        var result: [Slot] = []
        var emitted: Set<String> = []
        let visibleIDs = Set(visible)
        for id in visible {
            guard let owner = tier.first(where: { $0 == id || groupMembers[$0]?.contains(id) == true }),
                  emitted.insert(owner).inserted else { continue }
            if let canonical = groupMembers[owner] {
                let members = canonical.filter { visibleIDs.contains($0) }
                if members.count == 1 || expanded.contains(owner) {
                    result += visible.filter { members.contains($0) }.map { Slot(id: $0, members: [$0]) }
                } else if !members.isEmpty {
                    result.append(Slot(id: owner, members: members))
                }
            } else {
                result.append(Slot(id: owner, members: [owner]))
            }
        }
        return result
    }

    /// Any anchored member anchors the group; centre is the next priority.
    public static func zones(_ slots: [Slot], anchored: [String], centred: [String]) -> Zones {
        let ends = Set(anchored), middles = Set(centred)
        var result = Zones()
        for slot in slots {
            if slot.members.contains(where: ends.contains) { result.end.append(slot) }
            else if slot.members.contains(where: middles.contains) { result.centre.append(slot) }
            else { result.start.append(slot) }
        }
        return result
    }
}
