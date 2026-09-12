/// Independent presentations and text editors must release only their own block.
public struct InputSuspension: Sendable {
    private var owners: Set<String> = []
    public var isSuspended: Bool { !owners.isEmpty }
    public init() {}

    @discardableResult
    public mutating func set(_ suspended: Bool, owner: String) -> Bool {
        let previous = isSuspended
        if suspended { owners.insert(owner) } else { owners.remove(owner) }
        return previous != isSuspended
    }
}
