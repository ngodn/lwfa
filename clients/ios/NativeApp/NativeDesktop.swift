#if os(iOS)
import SwiftUI
import LWFACore

/// `Desktop.tsx`: the placed windows over the ink backdrop, and the arrange
/// overview that zooms the whole strip out with 44pt controls in screen space.
struct NativeDesktop: View {
    var session: NativeSession
    private var preferences: NativePreferences
    private var layout: NativeLayoutController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var carrying: UInt64?
    init(session: NativeSession) {
        self.session = session; preferences = session.preferences; layout = session.layout
    }
    var body: some View {
        GeometryReader { geometry in
            let transform = sceneTransform(in: geometry.size)
            let ready = session.displayOutput.width > 1 && session.displayOutput.height > 1
            let motion: Animation? = preferences.state.animate && !reduceMotion && session.layoutAnimated
                ? LWFATheme.windowSpring : nil
            ZStack(alignment: .topLeading) {
                LWFATheme.backdrop
                if !ready {
                    Text("Waiting for the engine’s output size…").font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                ForEach(session.placedWindows, id: \.id) { placed in
                    windowCell(placed, transform: transform, motion: motion)
                }
                if ready && session.placedWindows.isEmpty {
                    Text("This workspace is empty.").font(LWFATheme.body).foregroundStyle(LWFATheme.mutedForeground)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if session.arranging { arrangeBar }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            .clipped()
        }
    }


    private struct SceneTransform { let scale: Double; let x: Double; let y: Double }

    @ViewBuilder private func windowCell(_ placed: WindowLayout, transform: SceneTransform, motion: Animation?) -> some View {
        let width = max(1, placed.rect.width * transform.scale)
        let height = max(1, placed.rect.height * transform.scale)
        let filling = fillsOutput(placed.rect)
        let focused = placed.id == session.selected
        let card = !filling || session.arranging
        let shape = RoundedRectangle(cornerRadius: card ? LWFATheme.radiusExtraLarge : 0, style: .continuous)
        let ring: Color = focused ? LWFATheme.primary.opacity(0.7) : .white.opacity(0.10)
        let shadowOpacity: Double = card ? (focused ? 0.35 : 0.25) : 0
        let shadowRadius: CGFloat = card ? (focused ? 14 : 8) : 0
        let x = transform.x + placed.rect.x * transform.scale
        let y = transform.y + placed.rect.y * transform.scale
        NativeWindowSurface(session: session, id: placed.id, size: CGSize(width: width, height: height))
            .frame(width: width, height: height)
            .clipShape(shape)
            .overlay { if session.arranging { arrangementCard(placed.id) } }
            // `rounded-xl shadow-lg ring-1 ring-white/10`, `ring-primary/70 shadow-xl` when
            // focused, and nothing at all for a window that fills the output.
            // `transition-shadow`: only the ring and shadow ease on focus; the box itself snaps.
            .animation(.easeInOut(duration: 0.15)) { content in
                content
                    .overlay { if card && !session.arranging { shape.strokeBorder(ring, lineWidth: 1).allowsHitTesting(false) } }
                    .shadow(color: .black.opacity(shadowOpacity), radius: shadowRadius, y: shadowRadius * 0.7)
            }
            // Keep the video, input view and decoration in one moving group.
            // As in lib/motion.ts, spring the top-left corner, not the center:
            // resizing a stationary window must not invent a positional move.
            .geometryGroup()
            .animation(motion) { $0.offset(x: x, y: y) }
            .zIndex(Double(placed.z) + (carrying == placed.id ? 100 : 0))
    }

    /// `fillsOutput`: one window covering the whole output is not a card.
    private func fillsOutput(_ rect: Rect) -> Bool {
        abs(rect.x) < 1 && abs(rect.y) < 1 &&
            abs(rect.width - Double(session.displayOutput.width)) < 2 &&
            abs(rect.height - Double(session.displayOutput.height)) < 2
    }

    /// Whole strip, inset 56pt, never upscaled past 1:1 (`ARRANGE_INSET`).
    private func sceneTransform(in size: CGSize) -> SceneTransform {
        var bounds = CGRect(x: 0, y: 0, width: Double(session.displayOutput.width), height: Double(session.displayOutput.height))
        if session.arranging {
            for window in session.placedWindows {
                bounds = bounds.union(CGRect(x: window.rect.x, y: window.rect.y, width: window.rect.width, height: window.rect.height))
            }
        }
        let inset = session.arranging ? 56.0 : 0.0
        let scale = min(1, max(1, size.width - inset * 2) / max(1, bounds.width), max(1, size.height - inset * 2) / max(1, bounds.height))
        return SceneTransform(scale: scale, x: (size.width - bounds.width * scale) / 2 - bounds.minX * scale,
                              y: (size.height - bounds.height * scale) / 2 - bounds.minY * scale)
    }

    private var activeWorkspace: Int { Int(layout.state["focus"].uintValue) }
    private var workspaces: [WireValue] { layout.state["workspaces"].arrayValue }
    private var columns: [WireValue] {
        workspaces.indices.contains(activeWorkspace) ? workspaces[activeWorkspace]["columns"].arrayValue : []
    }

    /// `ArrangeBar.tsx`: workspace chips as drop targets, Done on the right.
    private var arrangeBar: some View {
        VStack {
            HStack(spacing: 8) {
                newColumnTarget("New column before", index: 0)
                Spacer()
                newColumnTarget("New column after", index: columns.count)
            }
            .padding(16)
            Spacer()
            HStack(spacing: 8) {
                ForEach(workspaces.indices, id: \.self) { index in
                    let current = index == activeWorkspace
                    Button(String(index + 1)) { session.layoutAction("workspace", args: [.int(Int64(index))]) }
                        .panelButton(current ? .primary : .secondary)
                        .dropDestination(for: String.self) { values, _ in
                            guard let id = droppedID(values) else { return false }
                            session.layoutAction("sendWorkspace", args: [.uint(id), .int(Int64(index))]); return true
                        }
                        .accessibilityLabel("Workspace \(index + 1)")
                }
                Spacer()
                Button { session.arranging = false } label: { Label("Done", systemImage: "checkmark") }.panelButton(.primary)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            .background(LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom))
        }
    }

    private func newColumnTarget(_ label: String, index: Int) -> some View {
        Label(label, systemImage: "rectangle.split.2x1").font(LWFATheme.control).foregroundStyle(.white)
            .padding(.horizontal, 12).frame(height: LWFATheme.hit)
            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous).strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6, 4])).foregroundStyle(LWFATheme.primary))
            .dropDestination(for: String.self) { values, _ in
                guard let id = droppedID(values) else { return false }
                move(id, kind: "newColumn", index: index); return true
            }
    }

    /// `ArrangeLayer.tsx` window card: title pill on top, caps along the bottom.
    private func arrangementCard(_ id: UInt64) -> some View {
        let column = columns.firstIndex { $0["windows"].arrayValue.contains(.uint(id)) } ?? 0
        let rows = columns.indices.contains(column) ? columns[column]["windows"].arrayValue.map(\.uintValue) : []
        let row = rows.firstIndex(of: id) ?? 0
        let focused = layout.focused == id
        return VStack {
            HStack {
                Text(session.windows.first { $0.id == id }?.title ?? "Window").font(LWFATheme.hint).foregroundStyle(.white.opacity(0.9))
                    .lineLimit(1).padding(.horizontal, 8).padding(.vertical, 4)
                    .background(.black.opacity(0.5), in: RoundedRectangle(cornerRadius: LWFATheme.radiusMedium, style: .continuous))
                Spacer(minLength: 0)
            }
            .padding(6)
            .background(LinearGradient(colors: [.black.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom))
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                cap("arrow.up.left.and.arrow.down.right", label: "Fullscreen") {
                    session.layoutAction("focus", args: [.uint(id)]); session.layoutAction("fullscreen"); session.arranging = false
                }
                if rows.count > 1 {
                    cap("chevron.up", label: "Move up in column") { move(id, kind: "column", index: column, row: max(0, row - 1)) }.disabled(row == 0)
                    cap("chevron.down", label: "Move down in column") { move(id, kind: "column", index: column, row: row + 1) }.disabled(row >= rows.count - 1)
                }
                Spacer(minLength: 0)
                cap("xmark", label: "Close", danger: true) { session.send(.closeWindow(id: id)) }
            }
            .padding(6)
            .background(LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom))
        }
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(focused ? LWFATheme.primary : .white.opacity(0.25), lineWidth: 2))
        .background(carrying == id ? LWFATheme.primary.opacity(0.2) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { session.layoutAction("focus", args: [.uint(id)]); session.arranging = false }
        .draggable("lwfa-window:\(id)") {
            Text(session.windows.first { $0.id == id }?.title ?? "Window").font(LWFATheme.hint).padding(8)
                .background(LWFATheme.card, in: RoundedRectangle(cornerRadius: 8))
        }
        .dropDestination(for: String.self) { values, position in
            guard let moving = droppedID(values), moving != id else { return false }
            move(moving, kind: "column", index: column, row: position.y < 44 ? row : row + 1)
            return true
        }
        .opacity(carrying == id ? 0.9 : 1)
    }

    private func cap(_ symbol: String, label: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18, weight: .medium)).foregroundStyle(.white)
                .frame(width: LWFATheme.hit, height: LWFATheme.hit)
                .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: LWFATheme.radiusLarge, style: .continuous).strokeBorder(.white.opacity(0.2)))
        }
        .buttonStyle(.plain)
        .tint(danger ? LWFATheme.destructive : .white)
        .accessibilityLabel(label)
    }

    private func droppedID(_ values: [String]) -> UInt64? {
        guard session.primary, session.canInteract, let value = values.first,
              value.hasPrefix("lwfa-window:"), let id = UInt64(value.dropFirst(12)),
              session.windows.contains(where: { $0.id == id }) else { return nil }
        return id
    }
    private func move(_ id: UInt64, kind: String, index: Int, row: Int? = nil) {
        var target: [String: WireValue] = ["kind": .string(kind), "index": .int(Int64(index))]
        if let row { target["row"] = .int(Int64(row)) }
        session.layoutAction("move", args: [.uint(id), .object(target)])
    }
}

/// One window: its Metal surface fitted to the placed rectangle, and the
/// input view mapped to exactly the displayed pixels.
private struct NativeWindowSurface: View {
    var session: NativeSession
    let id: UInt64
    let size: CGSize
    var body: some View {
        let windowMedia = session.media(for: id)
        let hasFrame = session.frameSizes[id] != nil
        ZStack {
            Color.black.opacity(0.4)
            NativeVideoView(media: windowMedia)
                .id(ObjectIdentifier(windowMedia))
            if !hasFrame {
                // No "paused" badge for unfocused windows on purpose: with pause-inactive
                // on, a frozen side window is the normal state of the desktop.
                Text(!session.streamedWindows.contains(id) ? "Off screen"
                     : session.blankWindowIDs.contains(id) ? "This window has never drawn anything" : "Waiting for pixels…")
                    .font(LWFATheme.body).foregroundStyle(.white.opacity(0.5)).multilineTextAlignment(.center).padding(16)
                    .allowsHitTesting(false)
            }
            if session.pendingCloseIDs.contains(id) {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Closing window…") }
                    .font(LWFATheme.hint).padding(10)
                    .glassEffect(.regular, in: Capsule())
                    .allowsHitTesting(false)
            }
            NativeInputView(
                onMotion: { session.pointer(window: id, x: $0, y: $1) },
                onButton: { session.pointerButton(window: id, $0, pressed: $1) },
                onKey: { session.key(window: id, $0, pressed: $1) },
                onScroll: { session.scroll(window: id, horizontal: $0, vertical: $1) },
                enabled: session.acceptsCanvasInput && !session.arranging,
                onRelease: { session.releasePointerInput(window: id) },
                onTouch: { session.touch(window: id, type: $0, id: $1, x: $2, y: $3) },
                onLeave: { session.pointerLeave(window: id) },
                mouseMode: session.dock == "mouse",
                mouseButton: session.preferences.state.mouseButton,
                mouseHover: session.mouseHover,
                fillsCanvas: fillsCanvas,
                keyboardFocused: session.selected == id
            )
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }
    private var fillsCanvas: Bool {
        guard let placed = session.placedWindows.first(where: { $0.id == id }) else { return false }
        return abs(placed.rect.x) < 1 && abs(placed.rect.y) < 1 &&
            abs(placed.rect.width - Double(session.displayOutput.width)) < 2 &&
            abs(placed.rect.height - Double(session.displayOutput.height)) < 2
    }
}
#endif
