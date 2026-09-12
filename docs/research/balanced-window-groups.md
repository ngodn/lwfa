# Balanced window groups

Research date: 2026-09-13.

## What Hyprland and Omarchy actually do

Hyprland dwindle maintains a binary tree. Each insertion splits an existing leaf selected using the active window or pointer. Its default axis follows the parent rectangle's proportions; preserving a split locks that orientation. `smart_split` selects an insertion direction from pointer position, rather than balancing the complete workspace. There is no documented rule that six windows must form two rows of three or eight must form two rows of four. [Hyprland dwindle documentation](https://wiki.hypr.land/Configuring/Layouts/Dwindle-Layout/)

Omarchy's current default branch is `quattro`. Its configuration selects dwindle with `preserve_split = true` and `force_split = 2`, so new siblings go right or below and existing split directions remain fixed. It does not enable an automatic equal-grid layout. The inspected repository redirected from `basecamp/omarchy` to `omacom/omarchy`. [Omarchy configuration at inspected commit](https://github.com/omacom/omarchy/blob/31bd80daa4613ffdee995ac27467fce5a2990806/default/hypr/looknfeel.lua)

These defaults explain why a particular arrangement can look balanced after manually placing windows, but do not establish the user's observed counts as a universal dwindle rule. No host configuration was changed for this investigation.

## What is wrong in lwfa

The existing `tile()` in `packages/shell/src/strip.ts` borrowed the longer-axis decision but rebuilt a balanced count tree every time. Each branch received half the rectangle even when the two branches contained different numbers of windows. This is neither faithful Hyprland insertion behavior nor consistently equal window sizing.

Two reproducible geometry cases with a 12-pixel gap:

- Six windows inside 1200 × 800: two cells are 594 × 394, while four are 291 × 394. Some windows get roughly twice the area of others.
- Eight windows inside 799 × 800: adjacent branches cross the axis threshold because their widths differ by one pixel. Four cells become 393 × 191 and four become 191 × 394. At 800 × 800, all eight instead have the same 191 × 394 shape. Independent axis decisions amplify a one-pixel difference into a different arrangement.

The existing tests check bounds, overlaps and broad aspect-ratio limits, but not equal area or consistent row/column structure. Regression checks now cover these cases directly.

## Implemented lwfa policy

Use a balanced group layout selected for the whole group before assigning individual rectangles. This is a deliberate lwfa policy, not an exact implementation of Hyprland dwindle.

1. Evaluate row and column counts against the group's actual width and height. Prefer compact cells over thin horizontal bands or narrow vertical slivers.
2. Distribute windows evenly between lanes, with lane counts differing by at most one. When counts divide evenly, give every window equal dimensions except integer pixel remainder.
3. Score the worst cell aspect ratio together with the area imbalance between lanes. This discourages a sparse final lane with oversized windows while preserving aligned row heights.
4. Select the lane arrangement before pixel rounding. Use one consistent reading order and deterministic tie-breaking, so sibling cells cannot choose conflicting axes from a one-pixel remainder.
5. Keep gap arithmetic within the available rectangle. Small viewports must not produce overlaps, negative sizes or off-canvas cells.

Two rows of three and two rows of four are reasonable landscape outcomes where they produce useful cell proportions. A portrait or narrow group may need the transposed arrangement. The tests should cover both orientations and nearly square rectangles, rather than mandate the same row count for every shape.

## Shared implementation and validation

The browser imports the canonical TypeScript layout. `scripts/build-ios-layout.mjs` bundles `clients/ios/LayoutBridge.ts`, which imports that same policy, into `clients/ios/NativeApp/Resources/layout.js`. The native app executes it with JavaScriptCore through `NativeLayout`. Fix the TypeScript policy and regenerate the resource instead of writing an independent Swift algorithm.

Required checks: six/eight windows, odd counts, near-square dimensions differing by one pixel, landscape/portrait groups, stable window order, non-overlap and containment, existing group/focus navigation, and native bridge parity. The geometry investigation above is source-level evidence, not a claim that the resulting UI has already been verified on the iPad.
