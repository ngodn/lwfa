# iPad panel animation and workspace sizing

2026-09-13. Reported against native app 0.2.9, using
`ScreenRecording_09-13-2026 03-40-45_1.mp4`. The user identifies the shifting
and stretching when tapping the controller navigation button as the bug.

## Change

`ShellView.setPanel` previously used `withAnimation` around the shared panel
binding. The desktop, panel, and navigation were siblings in the same ZStack.
The panel's clipping and expanded frame were inside the conditional insertion,
so its container was inserted and removed along with its contents. The only
explicit animation guard was on the navigation rail.

The workspace now establishes the shell size, with separate overlays for the
scrim, drawer, rail, and immersive controls. The drawer's clipped viewport stays
mounted at the available size. Its panel has explicit width and height, and
only the panel's insertion/removal and scrim opacity receive the panel animation.
The shared binding update no longer starts an animated transaction for the
entire shell. The desktop clears incoming chrome animation; its own scoped
window placement animations remain.

No engine resize policy, stream codec, or controller transport was changed.
Actual dock changes, rotation, and immersive mode still update the canvas size.

## Validation

- Examined the 26.56-second recording as overview frames and four frames per
  second around repeated controller-panel taps.
- Swift 6.3.3: all 90 core tests passed on Linux. These do not render SwiftUI.
- ARM64 iOS release build and IPA validation passed.
- Visual device validation remains necessary: repeatedly open/close Gamepad,
  switch directly to another panel, close using the canvas, and repeat with the
  rail on each edge and in immersive mode. The canvas and rail should stay fixed
  while the drawer slides, including rapid reversals. Dock toggles should still
  resize the canvas when their placement is stacked.

## Apple references

- [overlay(alignment:content:)](https://developer.apple.com/documentation/swiftui/view/overlay(alignment:content:))
  makes the modified view the layout anchor for secondary content.
- [animation(_:value:)](https://developer.apple.com/documentation/swiftui/view/animation(_:value:))
  applies animation to the affected view when the observed value changes.
- [transaction(_:)](https://developer.apple.com/documentation/swiftui/view/transaction(_:))
  controls animation transactions within a view subtree.
- [Explore SwiftUI animation, WWDC23](https://developer.apple.com/videos/play/wwdc2023/10156/)
  explains transaction propagation and scoped animation modifiers.

## Follow-up: missing Gamepad scrolling (0.2.10)

The user reproduced another failure after the first patch: Gamepad's header
was above the visible area, the settings exceeded the panel height, and the
panel could not scroll. The first patch was incomplete.

`ShellView.scrollingPanels` included every navigation panel except Gamepad.
That exception belonged to an older Form-based implementation. The current
`NativeGamepadPanel` is a plain VStack, including its Proton, LSFG, and Framegen
content. The exception left that VStack outside any outer ScrollView. A fixed
frame cannot make oversized non-scrolling content fit.

All eleven navigation panels were inspected. Their root content can use the
shared scrolling host. Bounded inner lists (such as key search and application
selection) are separate controls; file chooser Forms are separate native sheets.
The shared PanelHost now always owns the outer vertical ScrollView. There is
no per-panel opt-out or duplicated registry to forget during a restyle. A VStack
inside the scroll view defines the content layout; the header and grouped tabs
remain outside it. The header has layout priority, and scroll identity follows
the selected panel to reset stale offsets when switching panels.

Apple documentation consulted directly:

- [ScrollView](https://developer.apple.com/documentation/swiftui/scrollview)
  describes the scrollable region and standard VStack-based content.
- [frame(width:height:alignment:)](https://developer.apple.com/documentation/swiftui/view/frame(width:height:alignment:))
  explicitly notes that content can extend outside a fixed frame.
- [layoutPriority(_:)](https://developer.apple.com/documentation/swiftui/view/layoutpriority(_:))
  describes how sibling views share available space.
- [ProposedViewSize](https://developer.apple.com/documentation/swiftui/proposedviewsize)
  explains that views choose their sizes in response to parent proposals.
- [Swift 6.3.3 announcement](https://forums.swift.org/t/announcing-swift-6-3-3/87888)
  confirms the toolchain release; `mise current` selects Swift 6.3.3 locally.

Device automation was attempted with xtool against the installed signed bundle
identifier (which has xtool's team prefix). The app was found, but its launch
failed with `DebugserverClient.Error.unknown`. Therefore an automated native
layout/scroll test was not run. Linux core tests cannot substitute for that test.
The ARM64 iOS release build and IPA validation passed for 0.2.10 (10).
Required device check: header remains visible, controller settings scroll to the
bottom, other tabs/panels remain reachable, and the canvas stays stationary.

Installation completed with xtool's verification stage and exit code 0.
A separate installation-proxy query confirmed the device has version 0.2.10,
build 10. Device scrolling and animation still require visual verification.
