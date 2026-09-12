# Immersive floating button drag

The user reports jumping and lag while dragging the iPad floating button.

The previous gesture used its moving view's default local coordinate space.
It also wrote `prefs.state.immersivePosition` on every update. That state calls
`save()` and `onChange`, so dragging repeatedly persisted preferences and
triggered session configuration work.

The gesture now measures total translation in the stationary immersive
overlay's named coordinate space. Temporary `GestureState` drives only the
button position. It resets when the gesture finishes or is cancelled. Only a
completed drag updates the saved normalized position. No position animation
runs during a drag; the button follows the finger directly. A normal tap still
uses the existing Button action.

This follows Apple's definitions of
[DragGesture translation](https://developer.apple.com/documentation/swiftui/draggesture/value/translation),
[gesture state](https://developer.apple.com/documentation/swiftui/gesturestate),
and [named coordinate spaces](https://developer.apple.com/documentation/swiftui/coordinatespace/named(_:)).
The shared preferences observer and prior gesture are local code evidence;
the documentation does not establish the device's measured frame time.

Portable tests check direct finger displacement without accumulated samples,
edge clamping, returning from an edge, rotation, and viewports too small for
normal button margins. SwiftUI gesture arbitration and perceived smoothness
still require an iPad check.
