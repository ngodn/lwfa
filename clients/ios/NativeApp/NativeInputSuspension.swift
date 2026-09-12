#if os(iOS)
import SwiftUI
import UIKit

extension View {
    func gameInputSuspended(_ session: NativeSession, while suspended: Bool) -> some View {
        modifier(GameInputSuspension(session: session, suspended: suspended))
    }

    func protectNativeTextInput(_ session: NativeSession) -> some View {
        modifier(NativeTextInputProtection(session: session))
    }
}

private struct GameInputSuspension: ViewModifier {
    let session: NativeSession
    let suspended: Bool
    @State private var owner = UUID().uuidString

    func body(content: Content) -> some View {
        content
            .onChange(of: suspended, initial: true) { _, value in
                session.setInputSuspended(value, source: owner)
            }
            .onDisappear { session.setInputSuspended(false, source: owner) }
    }
}

/// Editing notifications also cover hardware keyboards, which do not show an
/// on-screen keyboard. Track the editor identity so an old field ending cannot
/// resume gameplay while its replacement is already editing.
private struct NativeTextInputProtection: ViewModifier {
    let session: NativeSession
    @State private var editors: Set<ObjectIdentifier> = []
    @State private var owner = UUID().uuidString

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { update($0, editing: true) }
            .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidEndEditingNotification)) { update($0, editing: false) }
            .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { update($0, editing: true) }
            .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidEndEditingNotification)) { update($0, editing: false) }
            .onDisappear {
                editors.removeAll()
                session.setInputSuspended(false, source: owner)
            }
    }

    private func update(_ notification: Notification, editing: Bool) {
        guard let view = notification.object as? UIView else { return }
        let id = ObjectIdentifier(view)
        if editing { editors.insert(id) } else { editors.remove(id) }
        session.setInputSuspended(!editors.isEmpty, source: owner)
    }
}
#endif
