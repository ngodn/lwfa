# Native controller touch ownership and window movement

2026-09-13, iPad app 0.2.11 (11), Swift 6.3.3 and iOS 26 SDK.

## Controller touches reaching the game

The user reports that pressing an on-screen pad clicks a control in the remote
application underneath instead. The old pads relied on SwiftUI DragGesture,
while CanvasInputView forwards raw UIKit touches immediately. A gesture that
recognizes later cannot retract a mouse-down already sent to the engine.
The old shield similarly relied on an empty tap gesture and only covered the
bottom controller band.

The pads now have a transparent UIViewRepresentable touch target above their
visuals. UIKit owns each pad's touch sequence from touchesBegan through move,
end, or cancellation. The view overrides all four touch methods and does not
forward them to the responder chain. Different pads accept simultaneous touches;
one pad tracks its first finger, following normal UIKit single-touch behavior.
Dragging off the pad does not turn that contact into a canvas touch. Controller
release/reset handlers remain on cancellation, removal, input reset and edit/mode
changes. Local pad coordinates drive the sticks and D-pad, and window coordinates
provide stable editor drag translation while the pad itself moves.

The shield now uses a UIKit touch target across the full overlay, including the
space above the pad band in portrait. Pads and toolbar remain above that target.
With the shield off, gaps retain the existing canvas interaction.

This addresses a concrete event-routing risk in the implementation. UIKit event
routing in the full SwiftUI hierarchy has not yet been verified by an automated
physical-device touch test. The reported failure must be retested on device.

## Window movement parity

The current React implementation is `packages/shell/src/lib/motion.ts`:
`set()` springs x/y and snaps width/height, with reduced-motion support. Its
introductory comments mention resizing, but the implementation explicitly avoids
animating pixel dimensions because it stretches decoded frames.

The native desktop used the same configured spring but animated the window's
center point and disabled all motion while arranging. It now animates the
top-left offset and permits motion in Arrange mode. Sizes still snap. A
geometryGroup keeps the Metal view, UIKit input view and decoration under the
same geometric transformation. Panel transactions remain separate. Motion stays
disabled for reduced motion, the user's motion preference, and viewport resync.

This uses SwiftUI's native animation scheduling, with no new per-frame network
messages, controller timers, or decoder recreation loop. SwiftUI's spring is not
claimed to be numerically identical to the browser's custom spring integrator.

## Verification

- ARM64 release build and IPA validation passed for 0.2.11 (11).
- Native UI behavior cannot be established by the Linux core test suite.
- The previous attempt to automate an installed-app launch via xtool failed with
  DebugserverClient.Error.unknown, so no physical-device UI test passed here.
- Device checks: press a pad over a clickable game control with shield off;
  hold a stick and another pad together; release outside the pad; cancel through
  backgrounding; check portrait shield coverage and editor dragging. The remote
  application must not receive pointer input from the pad's contact.
- Movement checks: switch focused columns, move windows in Arrange mode, change
  column width and toggle fullscreen; repeat a move before the previous move
  finishes. Verify video and input geometry stay together. Repeat with reduced
  motion enabled and with the window movement preference off.

## Apple documentation read

- [UIView.hitTest(_:with:)](https://developer.apple.com/documentation/uikit/uiview/hittest(_:with:)):
  the frontmost eligible view receives the hit; transparent content can receive it.
- [UIResponder.touchesBegan(_:with:)](https://developer.apple.com/documentation/uikit/uiresponder/touchesbegan(_:with:)):
  manual handlers must override the remaining touch methods when not forwarding.
- [UIResponder.touchesCancelled(_:with:)](https://developer.apple.com/documentation/uikit/uiresponder/touchescancelled(_:with:)):
  clean up touch state when the system interrupts a sequence.
- [UIView.isMultipleTouchEnabled](https://developer.apple.com/documentation/uikit/uiview/ismultipletouchenabled):
  single-touch handling on one view does not exclude touches on other views.
- [geometryGroup()](https://developer.apple.com/documentation/swiftui/view/geometrygroup()):
  resolve parent geometry once so child views remain together during animation.
- [animation(_:body:)](https://developer.apple.com/documentation/swiftui/view/animation(_:body:)):
  scope animation to the modifiers in its body.
- [Explore SwiftUI animation, WWDC23](https://developer.apple.com/videos/play/wwdc2023/10156/):
  animation scheduling, transactions and scoped modifiers.

The desktop container is explicitly constrained to its GeometryReader viewport
before clipping, so an oversized window cannot enlarge the absolute-layout
container when using top-left offsets.

The final artifact (including the viewport constraint) installed successfully
with xtool verification and exit code 0. Installation-proxy independently
reports version 0.2.11, build 11. Physical touch and animation checks remain
pending user verification.

## Toolbar follow-up

The first change left Edit, Show/Hide, Guard, Settings and Close as SwiftUI
buttons. The user reported those still did not activate. They now use
`UIButton` targets through `UIViewRepresentable`, including their full 64 by
44 point bounds. Editor resize controls use the same path. The toolbar sits
above the editor and pad touch views, its decorative border does not hit-test,
and pad opacity can no longer make the toolbar disappear. Native buttons
provide press tracking, drag-out cancellation and accessibility activation.
See Apple's [UIButton documentation](https://developer.apple.com/documentation/uikit/uibutton)
and [primaryActionTriggered](https://developer.apple.com/documentation/uikit/uicontrol/event/primaryactiontriggered).

This addresses the remaining distinct control path. The exact UIKit view tree
of the reported device failure was not captured, so physical toolbar activation
still needs verification on the iPad; compilation is not that verification.
