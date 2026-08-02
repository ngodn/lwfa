# lwfa brand assets

Mark: **Across the panels**. Three columns of the scrollable strip, the middle one square on, with the spring curve running across them.

## Colour
- Signal orange `#E8552D` — the curve, and the only accent. One accent, never two.
- Ink `#0C0D10` — backgrounds, app tiles.
- Paper `#F2EFE9` — light ground.
- Panels are never their own colour. They are the ink or paper colour at 30% opacity.

## Rules
- Full mark down to 32px. At 24px and below use the curve on its own (`mark-curve*.svg`, `favicon-16/32/48`).
- Clear space on every side is the width of one turned column, roughly 16% of the mark's width.
- Do not recolour the curve, outline it, add a second accent, or place the mark on a busy photograph.
- One colour print, engraving and stencils: `mark-mono-black.svg` / `mark-mono-white.svg`.

## Files

### svg/ (master artwork, scales to any size)
- `mark-on-dark.svg`, `mark-on-light.svg` — the full mark
- `mark-curve.svg`, `mark-curve-black.svg`, `mark-curve-white.svg` — the reduction
- `mark-mono-black.svg`, `mark-mono-white.svg` — one colour
- `icon-tile-ink.svg`, `icon-tile-accent.svg` — rounded app tiles
- `lockup-horizontal-on-dark.svg`, `lockup-horizontal-on-light.svg` — mark plus wordmark. The wordmark is live text in JetBrains Mono Bold, so install the font or ask for a version with the letters converted to outlines.

### png/
- Web: `favicon-16/32/48/64`, plus `../favicon.ico` (16, 32 and 48 in one file)
- Apple: `apple-touch-icon-120/152/180`
- Android and PWA: `android-chrome-192`, `android-chrome-512`, `maskable-512` (46% safe zone)
- Desktop apps: `app-icon-256/512/1024`, `app-icon-macos-1024` (rounded)
- Print and decks: `mark-on-dark-2048`, `mark-on-light-2048`, transparent background
- Social: `social-card-1200x630`

### site.webmanifest
Drop in at the web root and adjust the icon paths.

## HTML head

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/png/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/png/apple-touch-icon-180.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0C0D10">
```

Not included yet, say the word: Windows `.ico` at 256, macOS `.icns`, Linux hicolor theme directories, and a wordmark with outlined letters.
