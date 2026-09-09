# Immersive mode

Investigated on 9 September 2026. This feature uses browser fullscreen for the
whole shell. The existing window Fullscreen action continues to control remote
window layout independently.

## Browser support and limits

- Safari supports the unprefixed Fullscreen API on iPadOS from 16.4. Fullscreen
  applies to DOM content, so the shell can include its own navigation and input
  overlays. Browser exit gestures remain available.
  [WebKit 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/).
- Entry requires user activation and can be rejected. The request is made
  directly from the button handler. Browser-driven exits are handled through
  `fullscreenchange`; lwfa does not try to force re-entry.
  [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).
- Safari 26.0 release notes retain fullscreen exit on text-entry focus. Opening
  a shell text field can therefore leave fullscreen on affected Safari builds.
  This is handled as an ordinary exit, preserving navigation and input access.
  [WebKit 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).
- Installed standalone web apps already omit browser navigation. In this case
  immersive mode hides lwfa navigation without making an additional fullscreen
  request. This does not promise removal of OS status bars or home indicators.
  [WebKit Home Screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Code decisions

- Request fullscreen on `document.documentElement`, so Radix overlays portalled
  into `document.body` remain inside the fullscreen subtree.
- `ShellChrome` preserves the desktop, connection and input dock. `NavRail`
  becomes a fixed overlay during immersive mode. Revealing navigation does not
  change the desktop dimensions or trigger a new engine viewport.
- Entry, exit and rotation use the existing 150 ms `Desktop` resize reporting.
  Only the primary device sends a viewport; follower devices keep their existing
  behavior. No protocol or engine changes are needed.
- The 48 px logo button uses pointer capture and a drag threshold. Dragging
  updates its transform directly. Its normalized position is saved after drag
  completion and clamped to the safe area after resizing.
- A rejected request leaves the ordinary navigation visible. Unsupported
  browsers receive an explanation rather than a fake fullscreen state.
- The floating controls explicitly own their keyboard events, preventing Enter
  or Space from reaching the remote application.

## Verification

`scripts/e2e-immersive.mjs` serves the built shell on a temporary loopback port
with an entirely mocked engine connection. It exercises Chromium's actual
Fullscreen API, mouse and native touch dragging, navigation overlay geometry,
rotation, browser and UI exit, rejected fullscreen requests, follower clients
and installed standalone behavior. It checks that
the app canvas and controller stay mounted and navigation toggles do not send
viewport changes or game input. Keyboard Enter and Space operate the floating
controls without sending game keys. Results are written to `target/immersive-e2e/`.

The controller lifecycle and position bounds also have unit tests. Physical
iPad browser behavior still requires testing on the device; desktop browser
tests do not establish iPadOS keyboard or OS gesture behavior.
