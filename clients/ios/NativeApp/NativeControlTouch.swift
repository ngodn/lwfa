#if os(iOS)
import SwiftUI
import UIKit

/// A real UIControl above the remote input surface, including its empty padding.
struct NativeControlButton: UIViewRepresentable {
    var label: String
    var icon: String? = nil
    var selected = false
    var action: () -> Void

    func makeUIView(context: Context) -> ControllerActionButton {
        let button = ControllerActionButton(type: .system)
        button.addTarget(button, action: #selector(ControllerActionButton.activate), for: .primaryActionTriggered)
        return button
    }

    func updateUIView(_ button: ControllerActionButton, context: Context) {
        button.action = action
        button.accessibilityLabel = label
        button.accessibilityTraits = selected ? [.button, .selected] : [.button]
        var configuration = UIButton.Configuration.plain()
        configuration.baseForegroundColor = .white.withAlphaComponent(0.9)
        configuration.background.backgroundColor = selected ? .white.withAlphaComponent(0.16) : .clear
        configuration.cornerStyle = .small
        configuration.contentInsets = .init(top: 0, leading: 4, bottom: 0, trailing: 4)
        if let icon {
            configuration.image = UIImage(systemName: icon)
            configuration.preferredSymbolConfigurationForImage = .init(pointSize: 15, weight: .medium)
        } else {
            configuration.title = label
        }
        button.configuration = configuration
    }
}

@MainActor
final class ControllerActionButton: UIButton {
    var action: () -> Void = {}
    @objc func activate() { action() }
}

/// Owns controller touches before the canvas can forward a mouse/touch down.
/// SwiftUI draws the pad; this UIView is its actual UIKit hit-test target.
struct NativeControlTouch: UIViewRepresentable {
    var enabled = true
    var generation: UInt64 = 0
    var interaction = ""
    var changed: (CGPoint, CGSize) -> Void = { _, _ in }
    var ended: (_ cancelled: Bool) -> Void = { _ in }

    func makeUIView(context: Context) -> ControlTouchView { ControlTouchView(input: self) }
    func updateUIView(_ view: ControlTouchView, context: Context) { view.update(self) }
    static func dismantleUIView(_ view: ControlTouchView, coordinator: ()) { view.stop() }
}

@MainActor
final class ControlTouchView: UIView {
    private var input: NativeControlTouch
    private var contact: ObjectIdentifier?
    private var origin = CGPoint.zero

    init(input: NativeControlTouch) {
        self.input = input
        super.init(frame: .zero)
        backgroundColor = .clear
        // Each pad tracks one finger. Other pads can be held simultaneously.
        isMultipleTouchEnabled = false
        isExclusiveTouch = false
        NotificationCenter.default.addObserver(self, selector: #selector(cancelContact),
            name: UIApplication.willResignActiveNotification, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(input:)") }

    func update(_ next: NativeControlTouch) {
        if input.enabled != next.enabled || input.generation != next.generation || input.interaction != next.interaction {
            cancelContact()
        }
        input = next
        // Disabled controls still absorb hits instead of clicking the game.
        isUserInteractionEnabled = true
    }
    func stop() { cancelContact(); NotificationCenter.default.removeObserver(self) }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { cancelContact() }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard input.enabled, contact == nil, let touch = touches.first else { return }
        contact = ObjectIdentifier(touch)
        origin = touch.location(in: window)
        input.changed(touch.location(in: self), .zero)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first(where: { ObjectIdentifier($0) == contact }) else { return }
        let point = touch.location(in: window)
        input.changed(touch.location(in: self), CGSize(width: point.x - origin.x, height: point.y - origin.y))
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard touches.contains(where: { ObjectIdentifier($0) == contact }) else { return }
        contact = nil
        input.ended(false)
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { cancelContact() }

    @objc private func cancelContact() {
        guard contact != nil else { return }
        contact = nil
        input.ended(true)
    }
}
#endif
