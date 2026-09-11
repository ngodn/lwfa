# lwfa patches to Smithay 0.7.0

This directory contains the crates.io Smithay 0.7.0 source, under its original
MIT license (LICENSE.txt). The workspace uses it through a Cargo patch.

The local change fixes XWM active-window publication. Root/ancestor FocusIn
events and stale FocusOut events previously replaced `_NET_ACTIVE_WINDOW`
with the event window, which could make Wine consider a focused game inactive.
Expedition 33 then muted itself on controller-only Big Picture launches.

Regression runner: `LWFA_TEST_XVFB=/path/to/Xvfb node scripts/test-xwm-focus.mjs`.
It uses bubblewrap with private mount/network namespaces and fails closed if
isolation is unavailable. It never starts an X server in the host namespaces.

Keep changes localized to src/xwayland/xwm/active_window.rs and its integration
in mod.rs. Replace this patch with an upstream release once the same protocol
regressions pass there. Do not update the global Cargo registry source.
