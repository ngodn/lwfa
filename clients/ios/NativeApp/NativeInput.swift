#if os(iOS)
import SwiftUI
import UIKit
import GameController
import LWFACore

/// GameController callbacks run in order on the main queue, without polling.
@MainActor
final class NativeController {
    private let button: @MainActor (UInt32, Bool) -> Void
    private let axis: @MainActor (UInt32, Double) -> Void
    private let release: @MainActor () -> Void
    private var controller: GCController?
    private var observers: [NSObjectProtocol] = []
    private var enabled = false
    private var stopped = false
    private var buttons: [UInt32: Bool] = [:]
    private var axes: [UInt32: Double] = [:]

    init(button: @escaping @MainActor (UInt32, Bool) -> Void,
         axis: @escaping @MainActor (UInt32, Double) -> Void,
         release: @escaping @MainActor () -> Void) {
        self.button = button
        self.axis = axis
        self.release = release
        for name in [Notification.Name.GCControllerDidConnect, .GCControllerDidDisconnect] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.rescan() }
            })
        }
    }

    func setEnabled(_ enabled: Bool) {
        guard !stopped, self.enabled != enabled else { return }
        self.enabled = enabled
        if enabled { rescan() } else { detach() }
    }

    func rescan() {
        guard enabled, !stopped else { return }
        let available = GCController.controllers().filter { $0.extendedGamepad != nil }
        if let controller, available.contains(where: { $0 === controller }) { return }
        detach()
        guard let next = available.first, let pad = next.extendedGamepad else { return }
        controller = next
        next.handlerQueue = .main
        for (code, input) in mappedButtons(pad) {
            input.pressedChangedHandler = { [weak self, weak next] _, _, pressed in
                MainActor.assumeIsolated {
                    guard let self, self.enabled, self.controller === next else { return }
                    self.sendButton(code, pressed)
                }
            }
            sendButton(code, input.isPressed)
        }
        for (code, input, sign) in mappedAxes(pad) {
            input.valueChangedHandler = { [weak self, weak next] _, value in
                MainActor.assumeIsolated {
                    guard let self, self.enabled, self.controller === next else { return }
                    self.sendAxis(code, Double(value) * sign)
                }
            }
            sendAxis(code, Double(input.value) * sign)
        }
        for (code, input) in [(UInt32(4), pad.leftTrigger), (UInt32(5), pad.rightTrigger)] {
            input.valueChangedHandler = { [weak self, weak next] _, value, _ in
                MainActor.assumeIsolated {
                    guard let self, self.enabled, self.controller === next else { return }
                    self.sendAxis(code, Double(value))
                }
            }
            sendAxis(code, Double(input.value))
        }
    }

    func stop() {
        stopped = true
        enabled = false
        detach()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
    }

    private func detach() {
        if let pad = controller?.extendedGamepad {
            mappedButtons(pad).forEach { $0.1.pressedChangedHandler = nil }
            mappedAxes(pad).forEach { $0.1.valueChangedHandler = nil }
            pad.leftTrigger.valueChangedHandler = nil
            pad.rightTrigger.valueChangedHandler = nil
            release()
        }
        controller = nil
        buttons.removeAll()
        axes.removeAll()
    }

    private func sendButton(_ code: UInt32, _ pressed: Bool) {
        guard buttons[code, default: false] != pressed else { return }
        buttons[code] = pressed
        button(code, pressed)
    }

    private func sendAxis(_ code: UInt32, _ value: Double) {
        guard value.isFinite, axes[code, default: 0] != value else { return }
        axes[code] = value
        axis(code, value)
    }

    private func mappedButtons(_ pad: GCExtendedGamepad) -> [(UInt32, GCControllerButtonInput)] {
        var result: [(UInt32, GCControllerButtonInput)] = [
            (0, pad.buttonA), (1, pad.buttonB), (2, pad.buttonX), (3, pad.buttonY),
            (4, pad.leftShoulder), (5, pad.rightShoulder),
            (6, pad.leftTrigger), (7, pad.rightTrigger), (9, pad.buttonMenu),
            (12, pad.dpad.up), (13, pad.dpad.down), (14, pad.dpad.left), (15, pad.dpad.right)
        ]
        if let input = pad.buttonOptions { result.append((8, input)) }
        if let input = pad.leftThumbstickButton { result.append((10, input)) }
        if let input = pad.rightThumbstickButton { result.append((11, input)) }
        if let input = pad.buttonHome { result.append((16, input)) }
        return result
    }

    private func mappedAxes(_ pad: GCExtendedGamepad) -> [(UInt32, GCControllerAxisInput, Double)] {
        [(0, pad.leftThumbstick.xAxis, 1), (1, pad.leftThumbstick.yAxis, -1),
         (2, pad.rightThumbstick.xAxis, 1), (3, pad.rightThumbstick.yAxis, -1)]
    }
}

@MainActor
struct NativeInputView: UIViewRepresentable {
    var onMotion: (Double, Double) -> Void
    var onButton: (UInt32, Bool) -> Void
    var onKey: (UInt32, Bool) -> Void
    var onScroll: (Double, Double) -> Void
    var enabled: Bool
    var onRelease: () -> Void
    var onTouch: ((String, Int32, Double, Double) -> Void)? = nil
    var onLeave: () -> Void = {}
    var mouseMode = false
    var mouseButton: UInt32 = 272
    var mouseHover = false
    var fillsCanvas = false
    var keyboardFocused = false

    func makeUIView(context: Context) -> CanvasInputView { CanvasInputView(input: self) }
    func updateUIView(_ view: CanvasInputView, context: Context) { view.update(self) }
    static func dismantleUIView(_ view: CanvasInputView, coordinator: ()) { view.stop() }
}

@MainActor
final class CanvasInputView: UIView {
    private var input: NativeInputView
    private struct Finger {
        var id: Int32
        var origin: CGPoint
        var point: CGPoint
        var done = false
        var moved = false
        var direct = false
        var button: UInt32
    }
    private var fingers: [ObjectIdentifier: Finger] = [:]
    private var nextTouchID: Int32 = 0
    private var longPress: Task<Void, Never>?
    private var buttonOwners: [UInt32: Set<String>] = [:]
    private var heldKeys: Set<UInt32> = []
    private var gestureControl = false
    private var multipleFingers = false
    private var gestureOrigin: (center: CGPoint, distance: CGFloat)?
    private var gesturePrevious: (center: CGPoint, distance: CGFloat)?
    private var gestureKind: String?
    private var lastHover: (point: CGPoint, time: TimeInterval)?

    init(input: NativeInputView) {
        self.input = input
        super.init(frame: .zero)
        backgroundColor = .clear
        isMultipleTouchEnabled = true
        isUserInteractionEnabled = input.enabled
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
        addGestureRecognizer(hover)
        let scroll = UIPanGestureRecognizer(target: self, action: #selector(scrolled(_:)))
        scroll.allowedScrollTypesMask = .all
        scroll.allowedTouchTypes = []
        scroll.cancelsTouchesInView = false
        addGestureRecognizer(scroll)
        NotificationCenter.default.addObserver(self, selector: #selector(suspended), name: UIApplication.willResignActiveNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use init(input:)") }
    override var canBecomeFirstResponder: Bool { input.enabled }

    func update(_ input: NativeInputView) {
        let lostFocus = self.input.keyboardFocused && !input.keyboardFocused
        if lostFocus || (self.input.enabled && !input.enabled) || self.input.mouseMode != input.mouseMode || self.input.mouseButton != input.mouseButton || self.input.mouseHover != input.mouseHover {
            releaseInput()
            if lostFocus || !input.enabled { _ = resignFirstResponder() }
        }
        self.input = input
        isUserInteractionEnabled = input.enabled
    }

    func stop() {
        releaseInput()
        input.onLeave()
        _ = resignFirstResponder()
        NotificationCenter.default.removeObserver(self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { releaseInput(); input.onLeave() }
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { releaseInput() }
        return resigned
    }

    @objc private func suspended() { releaseInput(); input.onLeave(); _ = resignFirstResponder() }

    private func releaseInput() {
        longPress?.cancel()
        longPress = nil
        let hadInput = !buttonOwners.isEmpty || !heldKeys.isEmpty || gestureControl || !fingers.isEmpty
        for finger in fingers.values where finger.direct && !finger.done { touch("touchUp", finger) }
        buttonOwners.keys.sorted().forEach { input.onButton($0, false) }
        var keys = heldKeys
        if gestureControl { keys.insert(29) }
        keys.sorted().forEach { input.onKey($0, false) }
        buttonOwners.removeAll()
        heldKeys.removeAll()
        fingers.removeAll()
        lastHover = nil
        gestureControl = false
        multipleFingers = false
        gestureOrigin = nil
        gesturePrevious = nil
        gestureKind = nil
        if hadInput { input.onRelease() }
    }

    private func normalized(_ point: CGPoint) -> (Double, Double) {
        guard bounds.width > 0, bounds.height > 0 else { return (0, 0) }
        return (Double(max(0, min(1, point.x / bounds.width))), Double(max(0, min(1, point.y / bounds.height))))
    }

    private func motion(_ point: CGPoint) {
        guard input.enabled, bounds.width > 0, bounds.height > 0 else { return }
        let (x, y) = normalized(point)
        input.onMotion(x, y)
    }

    private func touch(_ phase: String, _ finger: Finger) {
        let (x, y) = normalized(finger.point)
        input.onTouch?(phase, finger.id, x, y)
    }

    private func button(_ code: UInt32, _ pressed: Bool, owner: String) {
        let wasPressed = !(buttonOwners[code] ?? []).isEmpty
        if pressed { buttonOwners[code, default: []].insert(owner) }
        else { buttonOwners[code]?.remove(owner) }
        let isPressed = !(buttonOwners[code] ?? []).isEmpty
        if !isPressed { buttonOwners.removeValue(forKey: code) }
        if isPressed != wasPressed { input.onButton(code, isPressed) }
    }

    private func control(_ pressed: Bool) {
        guard pressed != gestureControl else { return }
        gestureControl = pressed
        if !heldKeys.contains(29) { input.onKey(29, pressed) }
    }

    private func physicalMotion(_ point: CGPoint) {
        lastHover = (point, ProcessInfo.processInfo.systemUptime)
        if input.fillsCanvas, let parked = PointerGeometry.park(x: point.x, y: point.y, width: bounds.width, height: bounds.height) {
            motion(CGPoint(x: parked.x, y: parked.y))
        } else { motion(point) }
    }

    @objc private func hovered(_ recognizer: UIHoverGestureRecognizer) {
        switch recognizer.state {
        case .began, .changed: physicalMotion(recognizer.location(in: self))
        case .ended, .cancelled:
            // A captured drag keeps its button until the actual release.
            guard !buttonOwners.values.contains(where: { $0.contains("pointer") }) else { return }
            if recognizer.state == .ended, input.fillsCanvas, let lastHover,
               let edge = PointerGeometry.leave(x: lastHover.point.x, y: lastHover.point.y, width: bounds.width, height: bounds.height,
                                                elapsedMilliseconds: (ProcessInfo.processInfo.systemUptime - lastHover.time) * 1000) {
                // Retain the edge motion for fullscreen RTS/MOBA panning.
                motion(CGPoint(x: edge.x, y: edge.y))
            } else { input.onLeave() }
        default: break
        }
    }

    @objc private func scrolled(_ recognizer: UIPanGestureRecognizer) {
        guard input.enabled else { return }
        let offset = recognizer.translation(in: self)
        recognizer.setTranslation(.zero, in: self)
        if offset != .zero { input.onScroll(Double(-offset.x), Double(-offset.y)) }
    }

    private func pointerButtons(_ mask: UIEvent.ButtonMask) {
        for (bit, code): (Int, UInt32) in [(0, 272), (1, 273), (2, 274), (3, 275), (4, 276)] {
            button(code, mask.rawValue & (1 << bit) != 0, owner: "pointer")
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard input.enabled else { return }
        // Claim keyboard focus only after deliberate input, never during hover.
        becomeFirstResponder()
        for value in touches {
            let point = value.location(in: self)
            if value.type == .indirectPointer {
                physicalMotion(point)
                pointerButtons(event?.buttonMask ?? .primary)
                continue
            }
            nextTouchID = nextTouchID == Int32.max ? 1 : nextTouchID + 1
            let finger = Finger(id: nextTouchID, origin: point, point: point,
                                direct: !input.mouseMode && input.onTouch != nil, button: input.mouseButton)
            fingers[ObjectIdentifier(value)] = finger
            if finger.direct { touch("touchDown", finger) }
            else { motion(point) }
        }
        longPress?.cancel()
        if fingers.count == 1, let (identifier, _) = fingers.first {
            longPress = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
                self?.rightClick(identifier)
            }
        } else if fingers.count > 1, input.mouseMode {
            multipleFingers = true
            for (identifier, var finger) in fingers {
                button(finger.button, false, owner: "touch:\(finger.id)")
                finger.done = true
                fingers[identifier] = finger
            }
            gestureOrigin = gestureMeasurement()
            gesturePrevious = gestureOrigin
        }
    }

    private func rightClick(_ identifier: ObjectIdentifier) {
        guard input.enabled, fingers.count == 1, var finger = fingers[identifier], !finger.done, !finger.moved, !multipleFingers else { return }
        if finger.direct { touch("touchUp", finger) }
        button(finger.button, false, owner: "touch:\(finger.id)")
        motion(finger.point)
        button(273, true, owner: "longPress")
        button(273, false, owner: "longPress")
        finger.done = true
        fingers[identifier] = finger
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard input.enabled else { return }
        for value in touches {
            let point = value.location(in: self)
            if value.type == .indirectPointer {
                physicalMotion(point)
                if let event { pointerButtons(event.buttonMask) }
                continue
            }
            let identifier = ObjectIdentifier(value)
            guard var finger = fingers[identifier] else { continue }
            finger.point = point
            if hypot(point.x - finger.origin.x, point.y - finger.origin.y) > 10 {
                finger.moved = true
                longPress?.cancel()
            }
            fingers[identifier] = finger
            if multipleFingers { continue }
            guard !finger.done else { continue }
            if finger.direct { touch("touchMotion", finger) }
            else {
                motion(point)
                if finger.moved && !input.mouseHover { button(finger.button, true, owner: "touch:\(finger.id)") }
            }
        }
        if multipleFingers { updateGesture() }
    }

    private func gestureMeasurement() -> (center: CGPoint, distance: CGFloat)? {
        let values = fingers.values.sorted { $0.id < $1.id }
        guard values.count >= 2 else { return nil }
        let a = values[0].point, b = values[1].point
        return (CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2), hypot(a.x - b.x, a.y - b.y))
    }

    private func updateGesture() {
        guard let current = gestureMeasurement(), let origin = gestureOrigin, let previous = gesturePrevious else { return }
        if gestureKind == nil {
            let distance = abs(current.distance - origin.distance)
            let travel = hypot(current.center.x - origin.center.x, current.center.y - origin.center.y)
            if distance > 8 && distance > travel { gestureKind = "pinch"; control(true) }
            else if travel > 8 { gestureKind = "scroll" }
        }
        if gestureKind == "pinch" {
            input.onScroll(0, Double(-(current.distance - previous.distance) * 0.35))
        } else if gestureKind == "scroll" {
            input.onScroll(Double(previous.center.x - current.center.x), Double(previous.center.y - current.center.y))
        }
        gesturePrevious = current
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { finish(touches, event: event, cancelled: false) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { finish(touches, event: event, cancelled: true) }

    private func finish(_ touches: Set<UITouch>, event: UIEvent?, cancelled: Bool) {
        longPress?.cancel()
        for value in touches {
            let point = value.location(in: self)
            if value.type == .indirectPointer {
                physicalMotion(point)
                let remaining = event?.allTouches?.contains { $0.type == .indirectPointer && $0.phase != .ended && $0.phase != .cancelled } ?? false
                pointerButtons(remaining ? (event?.buttonMask ?? []) : [])
                if !bounds.contains(point) || cancelled { input.onLeave() }
                continue
            }
            guard var finger = fingers.removeValue(forKey: ObjectIdentifier(value)) else { continue }
            finger.point = point
            if finger.direct && !finger.done { touch("touchUp", finger) }
            else if !finger.direct && !finger.done && !multipleFingers && !cancelled && !input.mouseHover {
                motion(point)
                if !finger.moved { button(finger.button, true, owner: "touch:\(finger.id)") }
            }
            button(finger.button, false, owner: "touch:\(finger.id)")
        }
        if fingers.count < 2 {
            control(false)
            gestureOrigin = nil
            gesturePrevious = nil
            gestureKind = nil
        }
        // Remaining fingers from a two-finger gesture must not become taps.
        if fingers.isEmpty { multipleFingers = false }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard input.enabled else { super.pressesBegan(presses, with: event); return }
        var unhandled = presses
        for press in presses {
            guard let usage = press.key?.keyCode.rawValue, let code = Self.evdev[usage] else { continue }
            unhandled.remove(press)
            if heldKeys.insert(code).inserted && !(code == 29 && gestureControl) { input.onKey(code, true) }
        }
        if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandled = presses
        for press in presses {
            guard let usage = press.key?.keyCode.rawValue, let code = Self.evdev[usage] else { continue }
            unhandled.remove(press)
            if heldKeys.remove(code) != nil && !(code == 29 && gestureControl) { input.onKey(code, false) }
        }
        if !unhandled.isEmpty { super.pressesEnded(unhandled, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        pressesEnded(presses, with: event)
    }

    // USB HID keyboard usage IDs to Linux evdev. Position-based, like the web client.
    private static let evdev: [Int: UInt32] = [
        4:30, 5:48, 6:46, 7:32, 8:18, 9:33, 10:34, 11:35, 12:23, 13:36,
        14:37, 15:38, 16:50, 17:49, 18:24, 19:25, 20:16, 21:19, 22:31,
        23:20, 24:22, 25:47, 26:17, 27:45, 28:21, 29:44,
        30:2, 31:3, 32:4, 33:5, 34:6, 35:7, 36:8, 37:9, 38:10, 39:11,
        40:28, 41:1, 42:14, 43:15, 44:57, 45:12, 46:13, 47:26, 48:27,
        49:43, 50:43, 51:39, 52:40, 53:41, 54:51, 55:52, 56:53, 57:58,
        58:59, 59:60, 60:61, 61:62, 62:63, 63:64, 64:65, 65:66, 66:67,
        67:68, 68:87, 69:88, 70:99, 71:70, 72:119, 73:110, 74:102,
        75:104, 76:111, 77:107, 78:109, 79:106, 80:105, 81:108, 82:103,
        83:69, 84:98, 85:55, 86:74, 87:78, 88:96, 89:79, 90:80, 91:81,
        92:75, 93:76, 94:77, 95:71, 96:72, 97:73, 98:82, 99:83,
        100:86, 101:127, 127:113, 128:115, 129:114,
        224:29, 225:42, 226:56, 227:125, 228:97, 229:54, 230:100, 231:126
    ]
}
#endif
