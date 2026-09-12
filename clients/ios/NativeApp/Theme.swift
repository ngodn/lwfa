#if os(iOS)
import SwiftUI
import UIKit

/// The shell's design tokens, transcribed from `packages/shell/src/index.css`
/// and `brand/README.md`. Every colour resolves per trait collection so one
/// token is correct in both themes. See docs/research/browser-shell-design-map.md.
enum LWFATheme {
    // MARK: Brand
    /// Signal orange: the only accent. Lifted a little on ink so it carries.
    static let primary = dynamic(light: 0xE8552D, dark: 0xFB6B44)
    /// Ink on the accent, not white: 5.25:1 against orange versus 3.7:1.
    static let primaryForeground = solid(0x0C0D10)
    /// Ink. Also the engine's own backdrop, so browser and display agree.
    static let backdrop = solid(0x0C0D10)

    // MARK: Surfaces
    static let background = dynamic(light: 0xF2EFE9, dark: 0x090A0E)
    static let foreground = dynamic(light: 0x0A0A0A, dark: 0xF2F2F2)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x111217)
    static let popover = dynamic(light: 0xFFFFFF, dark: 0x141519)
    static let muted = dynamic(light: 0xF0F0F0, dark: 0x202126)
    static let mutedForeground = dynamic(light: 0x666666, dark: 0x97989C)
    static let accent = dynamic(light: 0xF0F0F0, dark: 0x27292E)
    static let border = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(0.11) : UIColor(rgb: 0xDEDEDE)
    })
    static let input = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(0.14) : UIColor(rgb: 0xDEDEDE)
    })
    static let destructive = dynamic(light: 0xE7000B, dark: 0xEA3C3F)
    static let destructiveForeground = dynamic(light: 0xFAFAFA, dark: 0xF8F8F8)
    static let success = dynamic(light: 0x269F4C, dark: 0x4CB86A)
    static let warning = dynamic(light: 0xE68D00, dark: 0xEFA831)
    static let sidebar = dynamic(light: 0xFAFAFA, dark: 0x0F1015)
    static let sidebarAccent = dynamic(light: 0xF0F0F0, dark: 0x222429)

    // MARK: Radii (`--radius: 0.65rem` = 10.4pt)
    static let radius: CGFloat = 10.4
    static let radiusSmall: CGFloat = 6.4
    static let radiusMedium: CGFloat = 8.4
    static let radiusLarge: CGFloat = 10.4
    static let radiusExtraLarge: CGFloat = 14.4
    static let panelGroupRadius: CGFloat = 12
    static let controlRadius: CGFloat = 9

    // MARK: Sizing
    /// Floor for every hit target.
    static let hit: CGFloat = 44
    static let panelWidth: CGFloat = 480
    static let panelHeight: CGFloat = 512
    static let panelHeaderHeight: CGFloat = 64

    // MARK: Type
    /// Sizes match the CSS point for point. The face is San Francisco: the
    /// system font renders through glass and Dynamic Type correctly, and Inter
    /// and SF are the same grotesque at these sizes.
    static let title = Font.system(size: 18, weight: .semibold)
    static let sectionHeading = Font.system(size: 11, weight: .semibold)
    static let body = Font.system(size: 14)
    static let label = Font.system(size: 13.5, weight: .medium)
    static let readout = Font.system(size: 13.5)
    static let control = Font.system(size: 13)
    static let hint = Font.system(size: 12)
    static let badge = Font.system(size: 12, weight: .medium)
    static let tiny = Font.system(size: 10)
    static let mono = Font.system(size: 12, design: .monospaced)
    static let monoLog = Font.system(size: 11, design: .monospaced)

    // MARK: Motion (`WINDOW_SPRING` in generated/config.ts; damping ratio 1.04, no overshoot)
    static let windowSpring = Animation.interpolatingSpring(mass: 1, stiffness: 1000, damping: 66)
    static let panelOpen = Animation.easeInOut(duration: 0.5)
    static let panelClose = Animation.easeInOut(duration: 0.3)
    static let quick = Animation.easeInOut(duration: 0.16)

    private static func solid(_ rgb: UInt32) -> Color { Color(uiColor: UIColor(rgb: rgb)) }
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { trait in trait.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
    }
}

extension UIColor {
    convenience init(rgb: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                  blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
    }
}

// MARK: - Panel building blocks (mirrors `panels/parts.tsx` and `.shell-panel` CSS)

/// Section: 11pt uppercase tracked heading, optional 12pt description, content.
struct PanelSection<Content: View>: View {
    var title: String?
    var description: String?
    @ViewBuilder var content: Content
    init(_ title: String? = nil, description: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title; self.description = description; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if title != nil || description != nil {
                VStack(alignment: .leading, spacing: 3) {
                    if let title {
                        Text(title.uppercased()).font(LWFATheme.sectionHeading).kerning(0.66)
                            .foregroundStyle(LWFATheme.mutedForeground)
                    }
                    if let description {
                        Text(description).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground)
                    }
                }.padding(.horizontal, 2)
            }
            content
        }
    }
}

/// `.panel-group`: a card with inset dividers between children.
struct PanelGroup<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        Group(subviews: content) { subviews in
            VStack(spacing: 0) {
                ForEach(subviews) { subview in
                    subview
                    if subview.id != subviews.last?.id {
                        Rectangle().fill(LWFATheme.border).frame(height: 1).padding(.horizontal, 12)
                    }
                }
            }
        }
        .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.panelGroupRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: LWFATheme.panelGroupRadius, style: .continuous).strokeBorder(LWFATheme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: LWFATheme.panelGroupRadius, style: .continuous))
    }
}

/// `FieldRow`: 44pt minimum, label + hint on the left, a control on the right.
struct FieldRow<Control: View>: View {
    var label: String
    var hint: String?
    @ViewBuilder var control: Control
    init(_ label: String, hint: String? = nil, @ViewBuilder control: () -> Control) {
        self.label = label; self.hint = hint; self.control = control()
    }
    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(LWFATheme.label).foregroundStyle(LWFATheme.foreground)
                if let hint { Text(hint).font(LWFATheme.hint).foregroundStyle(LWFATheme.mutedForeground) }
            }
            Spacer(minLength: 0)
            control
        }
        .frame(minHeight: LWFATheme.hit)
        .padding(.horizontal, 12).padding(.vertical, 6)
    }
}

/// `ReadoutRow`: 38pt, label left, tabular value right.
struct ReadoutRow: View {
    var label: String
    var value: String
    var tone: Color?
    init(_ label: String, value: String, tone: Color? = nil) { self.label = label; self.value = value; self.tone = tone }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text(label).font(LWFATheme.readout).foregroundStyle(LWFATheme.mutedForeground)
            Spacer(minLength: 0)
            Text(value).font(LWFATheme.readout).monospacedDigit().multilineTextAlignment(.trailing)
                .foregroundStyle(tone ?? LWFATheme.foreground)
        }
        .frame(minHeight: 38)
        .padding(.horizontal, 12).padding(.vertical, 6)
    }
}

/// A switch row inside a panel group.
struct SwitchRow: View {
    var label: String
    var hint: String?
    @Binding var isOn: Bool
    var body: some View {
        FieldRow(label, hint: hint) {
            Toggle("", isOn: $isOn).labelsHidden().tint(LWFATheme.primary)
        }
    }
}

/// The dashed note card (`rounded-xl border border-dashed p-4 text-sm text-muted-foreground`).
struct DashedNote: View {
    var text: String
    var padding: CGFloat = 16
    var body: some View {
        Text(text).font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4])).foregroundStyle(LWFATheme.border))
    }
}

/// `border-warning/30 bg-warning/10 text-warning` note.
struct WarningNote<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .font(LWFATheme.hint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(LWFATheme.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous).strokeBorder(LWFATheme.warning.opacity(0.4)))
    }
}

/// The shell's toggle group: muted track, card-coloured selected item with a
/// small shadow. Used for every "pick one" control, matching the browser.
struct SegmentedChoice<Value: Hashable, Label: View>: View {
    var options: [Value]
    @Binding var selection: Value
    var label: (Value) -> Label
    var isEnabled = true
    init(_ options: [Value], selection: Binding<Value>, isEnabled: Bool = true, @ViewBuilder label: @escaping (Value) -> Label) {
        self.options = options; _selection = selection; self.isEnabled = isEnabled; self.label = label
    }
    var body: some View {
        HStack(spacing: 3) {
            ForEach(options, id: \.self) { option in
                let selected = option == selection
                Button { selection = option } label: {
                    label(option)
                        .font(.system(size: 13, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? LWFATheme.foreground : LWFATheme.mutedForeground)
                        .frame(maxWidth: .infinity, minHeight: LWFATheme.hit)
                        .padding(.horizontal, 8)
                        .background(selected ? LWFATheme.card : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .shadow(color: selected ? .black.opacity(0.16) : .clear, radius: 1.5, y: 1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(LWFATheme.muted, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
    }
}

/// `Badge`: 12pt medium pill. Outline or solid.
struct PanelBadge: View {
    var text: String
    var icon: String?
    var solid = false
    var tint: Color?
    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 11, weight: .medium)) }
            Text(text)
        }
        .font(LWFATheme.badge)
        .foregroundStyle(solid ? LWFATheme.primaryForeground : (tint ?? LWFATheme.foreground))
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(solid ? LWFATheme.primary : .clear, in: Capsule())
        .overlay(Capsule().strokeBorder(solid ? .clear : LWFATheme.border))
    }
}

/// Button styles that match `components/ui/button.tsx` inside `.shell-panel`:
/// 44pt tall, 9pt radius, 13pt text.
enum PanelButtonKind { case primary, outline, ghost, destructive, secondary }

struct PanelButtonStyle: ButtonStyle {
    var kind: PanelButtonKind = .outline
    var fullWidth = false
    var danger = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .font(LWFATheme.control)
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: LWFATheme.hit)
            .frame(minWidth: LWFATheme.hit)
            .background(background(pressed), in: RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous)
                .strokeBorder(kind == .outline ? LWFATheme.border : .clear))
            .opacity(enabled ? 1 : 0.5)
            .contentShape(RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous))
            .animation(LWFATheme.quick, value: pressed)
    }
    private var foreground: Color {
        switch kind {
        case .primary: LWFATheme.primaryForeground
        case .destructive: LWFATheme.destructiveForeground
        default: danger ? LWFATheme.destructive : LWFATheme.foreground
        }
    }
    private func background(_ pressed: Bool) -> Color {
        switch kind {
        case .primary: LWFATheme.primary.opacity(pressed ? 0.85 : 1)
        case .destructive: LWFATheme.destructive.opacity(pressed ? 0.85 : 1)
        case .secondary: pressed ? LWFATheme.accent : LWFATheme.muted
        case .outline: pressed ? LWFATheme.accent : LWFATheme.card
        case .ghost: pressed ? LWFATheme.accent : .clear
        }
    }
}

extension View {
    func panelButton(_ kind: PanelButtonKind = .outline, fullWidth: Bool = false, danger: Bool = false) -> some View {
        buttonStyle(PanelButtonStyle(kind: kind, fullWidth: fullWidth, danger: danger))
    }
}

/// 44pt square ghost icon button.
struct IconButton: View {
    var systemImage: String
    var label: String
    var tint: Color = LWFATheme.foreground
    var size: CGFloat = LWFATheme.hit
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.system(size: 16, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: size, height: size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Text input styled like `components/ui/input.tsx` inside a panel: 44pt, 9pt radius.
struct PanelTextFieldStyle: TextFieldStyle {
    var mono = false
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(mono ? LWFATheme.mono : LWFATheme.body)
            .padding(.horizontal, 12)
            .frame(minHeight: LWFATheme.hit)
            .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.controlRadius, style: .continuous).strokeBorder(LWFATheme.input))
    }
}

/// A brand-consistent status light for the rail and the Session panel.
enum StatusTone { case good, busy, bad
    var color: Color {
        switch self { case .good: LWFATheme.success; case .busy: LWFATheme.warning; case .bad: LWFATheme.destructive }
    }
}

struct StatusDot: View {
    var tone: StatusTone
    var size: CGFloat = 8
    @State private var pulsing = false
    var body: some View {
        Circle().fill(tone.color).frame(width: size, height: size)
            .opacity(pulsing ? 0.4 : 1)
            // `animate-pulse` while busy. Scoped to this dot; nothing else joins in.
            .animation(pulsing ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default, value: pulsing)
            .onChange(of: tone, initial: true) { _, tone in pulsing = tone == .busy }
    }
}

extension View {
    /// The card treatment of `rounded-xl border bg-card p-3`.
    func panelCard(padding: CGFloat = 12) -> some View {
        self.padding(padding)
            .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusExtraLarge, style: .continuous).strokeBorder(LWFATheme.border))
    }
}
#endif
