#if os(iOS)
import SwiftUI
import LWFACore

/// The navigation rail from `NavRail.tsx`: three zones with flexible space
/// between them, four collapse tiers measured against the rail's length, and
/// a translucent surface in the browser's sidebar colour, rendered as glass.
struct NavRail: View {
    var session: NativeSession
    var prefs: NativePreferences
    var edge: String
    var active: String?
    var tone: StatusTone
    /// The room along the rail's axis, from the parent, so the first frame lays
    /// out correctly instead of collapsing until the rail has measured itself.
    var available: CGFloat
    var onSelect: (NativeNavigationLayout.Slot) -> Void
    @State private var measured: CGFloat = 0
    @State private var fired: String?
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var vertical: Bool { edge == "left" || edge == "right" }
    private var innerAlignment: Alignment {
        switch edge { case "left": .trailing; case "right": .leading; case "top": .bottom; default: .top }
    }

    var body: some View {
        let vertical = self.vertical
        let metrics = prefs.metrics
        let length = measured > 0 ? measured : available
        let visible = prefs.state.order.filter { !prefs.state.hidden.contains($0) && ($0 != "access" || session.isOwner) }
        let slots = NativeNavigationLayout.resolve(visible: visible, metrics: metrics, available: length)
        let zones = NativeNavigationLayout.zones(slots, prefs: prefs.state)
        let stack = vertical ? AnyLayout(VStackLayout(spacing: metrics.gap)) : AnyLayout(HStackLayout(spacing: metrics.gap))
        let needsScrolling = !NativeNavigationLayout.fits(count: slots.count, metrics: metrics, available: length)
        Group {
                if needsScrolling {
                    ScrollView(vertical ? .vertical : .horizontal) {
                        stack { ForEach(zones.all) { button($0, metrics: metrics) } }
                    }
                    .scrollIndicators(.automatic)
                } else {
                    stack {
                        ForEach(zones.start) { button($0, metrics: metrics) }
                        Spacer(minLength: 0)
                        ForEach(zones.centre) { button($0, metrics: metrics) }
                        Spacer(minLength: 0)
                        ForEach(zones.end) { button($0, metrics: metrics) }
                    }
                }
            }
            .padding(metrics.pad)
            .frame(width: vertical ? metrics.rail : nil, height: vertical ? nil : metrics.rail)
            .frame(maxWidth: vertical ? nil : .infinity, maxHeight: vertical ? .infinity : nil)
            // `bg-sidebar/80 backdrop-blur-xl` with a hairline on the inner side. The glass
            // goes on the rail itself so its buttons render above the material; a glass
            // background inside a container is composited over sibling content.
            .background { if reduceTransparency { Rectangle().fill(LWFATheme.sidebar) } }
            .glassEffect(reduceTransparency ? .identity : .regular.tint(LWFATheme.sidebar.opacity(0.8)), in: Rectangle())
            .overlay(alignment: innerAlignment) {
                Rectangle().fill(LWFATheme.border).frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
            }
        .onGeometryChange(for: CGFloat.self) { proxy in vertical ? proxy.size.height : proxy.size.width } action: { measured = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Navigation")
    }

    private func button(_ slot: NativeNavigationLayout.Slot, metrics: NativeRailMetrics) -> some View {
        let item = NativeNavigationItem.item(slot.id) ?? NativeNavigationItem(id: slot.id, title: slot.id, hint: "", icon: "questionmark")
        let group = slot.isGroup
        // Panel buttons reflect the open panel; dock buttons reflect their surface (`isActive` in NavRail.tsx).
        let isActive = active == slot.id || (group && slot.members.contains(active ?? ""))
            || (item.kind == .dock && session.dock == slot.id)
        let carriesStatus = slot.id == "info" || (group && slot.members.contains("info"))
        return Button {
            if item.kind == .action { flash(slot.id) }
            onSelect(slot)
        } label: {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let glyph = item.glyph {
                        Text(glyph).font(.system(size: (metrics.icon * 0.62).rounded(), weight: .semibold)).kerning(-0.3)
                    } else {
                        Image(systemName: item.icon).font(.system(size: metrics.icon, weight: .regular))
                    }
                }
                .foregroundStyle(foreground(active: isActive, fired: fired == slot.id, glyph: item.glyph != nil))
                .frame(width: metrics.button, height: metrics.button)
                .background(background(active: isActive, fired: fired == slot.id, glyph: item.glyph != nil),
                            in: RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
                .shadow(color: isActive ? .black.opacity(0.21) : .clear, radius: 1.5, y: 1)
                if carriesStatus {
                    StatusDot(tone: tone, size: 6).padding(4)
                }
                if group {
                    Circle().fill(.primary).opacity(0.6).frame(width: 4, height: 4).padding(4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .frame(width: metrics.button, height: metrics.button)
                }
            }
            .frame(width: metrics.hitTarget, height: metrics.hitTarget)
            .contentShape(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(item.title)
        .accessibilityHint(item.hint)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private func foreground(active: Bool, fired: Bool, glyph: Bool) -> Color {
        if fired { return LWFATheme.primaryForeground }
        if active { return LWFATheme.primary }
        return glyph ? LWFATheme.foreground.opacity(0.75) : LWFATheme.foreground.opacity(0.65)
    }
    private func background(active: Bool, fired: Bool, glyph: Bool) -> Color {
        if fired { return LWFATheme.primary }
        if active { return LWFATheme.card }
        return glyph ? LWFATheme.foreground.opacity(0.08) : .clear
    }
    private func flash(_ id: String) {
        fired = id
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(180))
            if fired == id { fired = nil }
        }
    }
}
#endif
