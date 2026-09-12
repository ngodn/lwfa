#if os(iOS)
import SwiftUI
import LWFACore

/// The non-modal side sheet from `PanelHost.tsx`. It opens from the rail's
/// edge, starts where the rail ends, and never blocks the desktop: the rail
/// stays reachable so panels can be switched without closing one first.
struct PanelHost<Content: View>: View {
    var slot: NativeNavigationLayout.Slot
    @Binding var tab: String
    var edge: String
    var onClose: () -> Void
    @ViewBuilder var content: (String) -> Content

    private var vertical: Bool { edge == "left" || edge == "right" }
    private var group: NativeNavigationGroup? { slot.isGroup ? NativeNavigationGroup.group(slot.id) : nil }
    private var current: String { group == nil ? slot.id : (slot.members.contains(tab) ? tab : slot.members.first ?? slot.id) }

    var body: some View {
        VStack(spacing: 0) {
            header
                .layoutPriority(1)
            if let group {
                SegmentedChoice(slot.members, selection: Binding(get: { current }, set: { tab = $0 })) { id in
                    Text(NativeNavigationItem.item(id)?.title ?? id)
                }
                .padding(.horizontal, 14).padding(.top, 14)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(group.title)
            }
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 15) {
                    content(current)
                }
                .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 22)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .id(current)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(LWFATheme.background)
        .overlay(alignment: innerEdgeAlignment) {
            Rectangle().fill(LWFATheme.border)
                .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
        }
        .shadow(color: .black.opacity(0.35), radius: 20, x: edge == "right" ? -12 : edge == "left" ? 12 : 0, y: edge == "top" ? 12 : edge == "bottom" ? -12 : 0)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(group?.title ?? NativeNavigationItem.item(slot.id)?.title ?? "Panel")
    }

    private var innerEdgeAlignment: Alignment {
        switch edge { case "left": .trailing; case "right": .leading; case "top": .bottom; default: .top }
    }

    private var header: some View {
        let item = NativeNavigationItem.item(current)
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(group?.title ?? item?.title ?? "").font(LWFATheme.title).kerning(-0.18)
                    .foregroundStyle(LWFATheme.foreground)
                Text(group?.hint ?? item?.hint ?? "").font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
            }
            Spacer(minLength: 0)
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 15, weight: .bold))
                    .foregroundStyle(LWFATheme.foreground)
                    .frame(width: 34, height: 34)
                    .background(LWFATheme.muted, in: Circle())
                    .frame(width: LWFATheme.hit, height: LWFATheme.hit)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverEffect(.lift)
            .accessibilityLabel("Close")
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 20)
        .frame(height: LWFATheme.panelHeaderHeight)
        .overlay(alignment: .bottom) { Rectangle().fill(LWFATheme.border).frame(height: 1) }
    }
}
#endif
