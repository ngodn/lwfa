<!-- Extracted 2026-09-12 from a code-exploration pass over packages/shell and brand/. Reference for the native iPad client's 1:1 visual and behavioral parity. -->

# lwfa Browser Shell — Design & Structure Reference for a 1:1 iPad SwiftUI Client

Source of truth: `/home/eins0fx/development/lwfa/packages/shell` (React 19 + Vite 8 + Tailwind v4 + shadcn/ui on Radix) and `/home/eins0fx/development/lwfa/brand`. Shell version `1.5.10` (`/home/eins0fx/development/lwfa/packages/shell/src/generated/config.ts`).

---

## 1. Visual design system

### 1.1 Where tokens live

Every token is a CSS custom property in **oklch**, declared in `/home/eins0fx/development/lwfa/packages/shell/src/index.css`:

- `:root { … }` — light theme (lines ~30–75)
- `.dark { … }` — dark theme (lines ~77–108)
- `@theme inline { … }` — maps them onto Tailwind's scale plus radii and font families (lines ~110–155)
- `@layer base`, `@layer components`, `@layer utilities`, then un-layered `.panel-group` / `.shell-panel` rules (lines ~157–422)

Theme class is applied to `<html>` by `/home/eins0fx/development/lwfa/packages/shell/src/components/ThemeProvider.tsx` (also sets `style.colorScheme`). `--rail-size` and `--rail-edge` are set on `document.documentElement` by `ShellChrome` (`/home/eins0fx/development/lwfa/packages/shell/src/components/ShellChrome.tsx`).

### 1.2 Colour tokens — light (`:root`)

| Token | oklch | hex | rgb |
|---|---|---|---|
| `--background` | `oklch(0.953 0.009 84.6)` | `#F2EFE9` | 242,239,233 |
| `--foreground` | `oklch(0.145 0 0)` | `#0A0A0A` | 10,10,10 |
| `--card`, `--popover` | `oklch(1 0 0)` | `#FFFFFF` | 255,255,255 |
| `--card-foreground`, `--popover-foreground` | `oklch(0.145 0 0)` | `#0A0A0A` | |
| `--primary` | `oklch(0.641 0.19 35.7)` | `#E8552D` | 232,85,45 |
| `--primary-foreground` | `oklch(0.159 0.007 271)` | `#0C0D10` | 12,13,16 |
| `--secondary`, `--muted`, `--accent` | `oklch(0.955 0 0)` | `#F0F0F0` | 240,240,240 |
| `--secondary-foreground`, `--accent-foreground` | `oklch(0.205 0 0)` | `#171717` | 23,23,23 |
| `--muted-foreground` | `oklch(0.51 0 0)` | `#666666` | 102,102,102 |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `#E7000B` | 231,0,11 |
| `--destructive-foreground` | `oklch(0.985 0 0)` | `#FAFAFA` | |
| `--border`, `--input` | `oklch(0.9 0 0)` | `#DEDEDE` | 222,222,222 |
| `--ring` | `oklch(0.641 0.19 35.7)` | `#E8552D` | |
| `--success` | `oklch(0.62 0.16 149)` | `#269F4C` | 38,159,76 |
| `--warning` | `oklch(0.72 0.17 70)` | `#E68D00` | 230,141,0 |
| `--backdrop` | `oklch(0.159 0.007 271)` | `#0C0D10` | 12,13,16 |
| `--sidebar` | `oklch(0.985 0 0)` | `#FAFAFA` | |
| `--sidebar-foreground` | `oklch(0.145 0 0)` | `#0A0A0A` | |
| `--sidebar-accent` | `oklch(0.955 0 0)` | `#F0F0F0` | |
| `--sidebar-accent-foreground` | `oklch(0.205 0 0)` | `#171717` | |
| `--sidebar-border` | `oklch(0.9 0 0)` | `#DEDEDE` | |

### 1.3 Colour tokens — dark (`.dark`)

| Token | oklch | hex | rgb |
|---|---|---|---|
| `--background` | `oklch(0.145 0.008 275)` | `#090A0E` | 9,10,14 |
| `--foreground` | `oklch(0.96 0 0)` | `#F2F2F2` | 242,242,242 |
| `--card` | `oklch(0.185 0.009 275)` | `#111217` | 17,18,23 |
| `--popover` | `oklch(0.195 0.009 275)` | `#141519` | 20,21,25 |
| `--primary` | `oklch(0.70 0.185 36)` | `#FB6B44` | 251,107,68 |
| `--primary-foreground` | `oklch(0.159 0.007 271)` | `#0C0D10` | |
| `--secondary`, `--muted` | `oklch(0.25 0.009 275)` | `#202126` | 32,33,38 |
| `--secondary-foreground`, `--accent-foreground`, `--card-foreground` | `oklch(0.96 0 0)` | `#F2F2F2` | |
| `--muted-foreground` | `oklch(0.68 0.006 275)` | `#97989C` | 151,152,156 |
| `--accent` | `oklch(0.28 0.011 275)` | `#27292E` | 39,41,46 |
| `--destructive` | `oklch(0.62 0.21 25)` | `#EA3C3F` | 234,60,63 |
| `--destructive-foreground` | `oklch(0.98 0 0)` | `#F8F8F8` | |
| `--border` | `oklch(1 0 0 / 11%)` | white @ 11% | |
| `--input` | `oklch(1 0 0 / 14%)` | white @ 14% | |
| `--ring` | `oklch(0.70 0.185 36)` | `#FB6B44` | |
| `--success` | `oklch(0.7 0.15 150)` | `#4CB86A` | 76,184,106 |
| `--warning` | `oklch(0.78 0.15 75)` | `#EFA831` | 239,168,49 |
| `--backdrop` | `oklch(0.159 0.007 271)` | `#0C0D10` | (same both themes) |
| `--sidebar` | `oklch(0.175 0.009 275)` | `#0F1015` | 15,16,21 |
| `--sidebar-accent` | `oklch(0.26 0.01 275)` | `#222429` | 34,36,41 |
| `--sidebar-border` | `oklch(1 0 0 / 11%)` | white @ 11% | |

Two notes that matter for parity: `--primary-foreground` is **ink, not white** (white gives 3.7:1 on signal orange, ink gives 5.25:1); and `--backdrop` deliberately equals the engine's `[window].backdrop` so the browser and the physical display agree.

### 1.4 Radii

`--radius: 0.65rem` (10.4 px). Derived in `@theme inline`:

- `--radius-sm = calc(var(--radius) - 4px)` = 6.4 px
- `--radius-md = calc(var(--radius) - 2px)` = 8.4 px
- `--radius-lg = var(--radius)` = 10.4 px
- `--radius-xl = calc(var(--radius) + 4px)` = 14.4 px

Concrete radii used in components: nav rail buttons `rounded-xl` (14.4 px), panel group `border-radius: 12px`, toggle-group/tabs-list `10px` container with `7px` items, panel buttons `9px`, panel inputs/select triggers `9px`, cards/dialog `rounded-xl`/`rounded-lg`, badges/pills `rounded-full`, gamepad pads `rounded-full` (`rounded-lg` for triggers and key pads).

### 1.5 Spacing / sizing conventions

- **44 px is the floor for every hit target.** `.shell-panel` forces `min-width:44px; min-height:44px` on toggle-group items, tabs triggers, and buttons; `input`/`select-trigger` get `min-height:44px`; sliders get `min-height:44px`; switches get a `::before` pseudo-element `44×44` centred on the visual 18 px control. A `.panel-row` button is drawn 32 px tall with an `::after` pseudo-element of `height: max(100%,44px)` to keep the hit area 44.
- Panel body padding: `px-3.5 pt-3.5 pb-[max(1.375rem, env(safe-area-inset-bottom))]` (`PanelHost.PanelBody`).
- Panel section vertical rhythm: `space-y-[15px]` between sections in most panels; `space-y-4` in Session/Connections/Access/Apps/Clipboard.
- `FieldRow`: `min-h-11 items-center justify-between gap-3.5 px-3 py-1.5`.
- `ReadoutRow`: `min-h-[38px] … px-3 py-1.5 text-[13.5px]`, value right-aligned with `font-variant-numeric: tabular-nums`.
- Panel header: `h-16 shrink-0 … border-b px-5 py-0`.
- Safe-area utilities: `.pt-safe/.pb-safe/.pl-safe/.pr-safe` → `env(safe-area-inset-*)`. `ShellChrome` applies `pt-safe pl-safe pr-safe` only — never bottom, because the home indicator is a floating overlay; only a docked keyboard pads itself (`pb-safe` in `InputDock`).

### 1.6 Shadows, blur, opacity

- `.shell-panel { box-shadow: 12px 0 40px -16px rgb(0 0 0 / 35%); }`
- Active nav rail button: `shadow-[0_1px_3px_#00000035]`
- Active toggle-group item / tabs trigger inside a panel: `box-shadow: 0 1px 3px rgb(0 0 0 / 16%)`
- Sheet content: Tailwind `shadow-lg`; dialog content `shadow-lg`
- Immersive FAB: `box-shadow: 0 2px 10px rgb(0 0 0 / 18%)`
- Nav rail: `bg-sidebar/80 backdrop-blur-xl` (24 px blur, sidebar at 80 %)
- Stacked input dock: `bg-card/95 backdrop-blur-xl`; floating keyboard: `bg-card/85 backdrop-blur-xl`
- Floating surface toolbar (gamepad/mouse header): `bg-black/45 backdrop-blur-sm border-b border-l border-white/20 rounded-bl-md px-0.5 py-0.5`
- Sheet overlay is **overridden** in `index.css`: `[data-slot="sheet-overlay"] { pointer-events:none; background: color-mix(in oklab, var(--background) 45%, transparent); }` — the panel is non-modal and the desktop behind stays watchable and clickable. Dialog overlay stays `bg-black/50` and is modal.
- Gamepad pads deliberately carry **no backdrop blur** (a blur pass per video frame read as stream lag); they use a flat `bg-black/50` with `border-white/20`.
- `body` background is `color-mix(in oklab, var(--background) 99%, transparent)` — 99 % opaque so iOS 26 routes the fixed layer through the compositor; `html` is painted `var(--backdrop)`.

### 1.7 Typography

Fonts are **self-hosted** (`@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`), imported in `index.css`:

- `--font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif`
- `--font-mono: "JetBrains Mono Variable", ui-monospace, monospace`

`body` is `font-sans antialiased`, `user-select: none` globally (re-enabled on `input`, `textarea`, `[data-selectable]`), `-webkit-tap-highlight-color: transparent`.

Sizes seen in the shell (SwiftUI equivalents should be point-for-point):

| Use | Size / weight |
|---|---|
| Panel title (`SheetTitle`) | 18 px (`text-lg`), `font-semibold`, `tracking-[-0.01em]` |
| Section heading (`PanelSection`) | 11 px, `font-semibold`, `uppercase`, `tracking-[0.06em]`, muted |
| Section description | 12 px (`text-xs`), `leading-snug`, muted |
| Field label | 13.5 px, `font-medium`, `leading-snug` |
| Field hint | 12 px, muted |
| Readout row | 13.5 px |
| Body / list rows | 14 px (`text-sm`) |
| Buttons | 14 px default; 13 px inside `.shell-panel` |
| Toggle/tabs item inside panel | 13 px |
| Badges | 12 px `font-medium`; small variants `text-[10px]` |
| Log entries | `font-mono text-[11px] leading-relaxed` |
| Clipboard text preview | `font-mono text-xs`, `line-clamp-3` |
| "On the clipboard" pill | `text-[10.5px] font-semibold uppercase tracking-wide text-primary` |
| Tooltip | 12 px on `bg-foreground` / `text-background` |
| Nav rail glyph (ESC) | `round(icon × 0.62)` px → 10 / 11 / 12 px by rail size, `font-semibold tracking-tight` |

Keyboard key legends are fluid: `clamp(9px, min(48cqh|40cqh, (95/(0.55·chars))cqw), 22px)` per key container (`legendSize` in `/home/eins0fx/development/lwfa/packages/shell/src/keyboard/Keyboard.tsx`). Gamepad pad labels: `labelSize()` returns `pad.size × min(0.34 | 0.30, 0.9/(0.68·len))` expressed in `cqmin`.

### 1.8 Brand (from `/home/eins0fx/development/lwfa/brand/README.md`)

Mark concept: *"Across the panels. Three columns of the scrollable strip, the middle one square on, with the spring curve running across them."*

**Colour**
- Signal orange `#E8552D` — the curve, and the only accent. *"One accent, never two."*
- Ink `#0C0D10` — backgrounds and app tiles.
- Paper `#F2EFE9` — the light ground.
- *"Panels are never their own colour. They are the ink or paper colour at 30% opacity."*

**Rules**
- Full mark down to 32 px. At 24 px and below use the curve alone (`mark-curve*.svg`, `favicon-16/32/48`).
- Clear space on every side = the width of one turned column, ≈ **16 % of the mark's width**.
- Do not recolour the curve, outline it, add a second accent, or place the mark on a busy photograph.
- One-colour print / engraving / stencil: `mark-mono-black.svg` / `mark-mono-white.svg`.

**Asset files**

`/home/eins0fx/development/lwfa/brand/svg/` (all `viewBox="0 0 100 100"` unless noted, nominal `512×512`):
`mark-on-dark.svg`, `mark-on-light.svg` (full mark), `mark-curve.svg`, `mark-curve-black.svg`, `mark-curve-white.svg` (reduction), `mark-mono-black.svg`, `mark-mono-white.svg`, `icon-tile-ink.svg`, `icon-tile-accent.svg` (rounded tiles, `rx=22` on a 100-unit square = 22 % corner radius, mark scaled 0.68), `lockup-horizontal-on-dark.svg`, `lockup-horizontal-on-light.svg` (`viewBox="0 0 340 100"`, nominal `680×200`; wordmark is **live text** in JetBrains Mono Bold, `font-size:58`, `letter-spacing:-3`, at `x=116 y=70`).

Mark geometry, for a native redraw: three columns drawn at 30 % opacity in the ground colour with `stroke-width:5`, `stroke-linejoin:round` — left `M12 33 L28 26 L28 74 L12 81 Z`, right `M72 26 L88 33 L88 81 L72 74 Z`, centre `rect x=39 y=18 w=22 h=64 rx=3`. The curve over them is `M6 74 C 20 74, 22 26, 38 26 C 54 26, 54 66, 70 66 C 82 66, 84 48, 94 50`, `fill:none`, `stroke:#E8552D`, `stroke-width:11` (12 in the standalone curve files), `stroke-linecap:round`.

`/home/eins0fx/development/lwfa/brand/png/`: `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon-64.png`; `apple-touch-icon-120.png`, `-152.png`, `-180.png`; `android-chrome-192.png`, `android-chrome-512.png`, `maskable-512.png` (46 % safe zone); `app-icon-256.png`, `app-icon-512.png`, `app-icon-1024.png`, `app-icon-macos-1024.png` (rounded); `mark-on-dark-512.png`, `mark-on-dark-2048.png`, `mark-on-light-512.png`, `mark-on-light-2048.png` (transparent); `social-card-1200x630.png`. Plus `/home/eins0fx/development/lwfa/brand/favicon.ico` (16/32/48 in one file) and `site.webmanifest` (`name: "lwfa"`, `description: "Literally work from anywhere"`, `background_color`/`theme_color`: `#0C0D10`, `display: standalone`).

The shell ships a subset at `/home/eins0fx/development/lwfa/packages/shell/public/brand/`: `mark-on-dark.svg`, `mark-on-light.svg`, `mark-curve.svg`, `lockup-horizontal-on-dark.svg`, `lockup-horizontal-on-light.svg`, plus the full `png/` set. `index.html` sets `<meta name="theme-color" content="#0C0D10">`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title: lwfa`, `viewport-fit=cover`.

---

## 2. Layout and chrome

### 2.1 Shell root — `/home/eins0fx/development/lwfa/packages/shell/src/components/ShellChrome.tsx`

Root div: `pt-safe pl-safe pr-safe flex h-full w-full overflow-hidden bg-backdrop` plus a flex direction derived from the rail edge (`shellDirection`): `left → flex-row`, `right → flex-row-reverse`, `top → flex-col`, `bottom → flex-col-reverse`. Children in order: `NavRail`, `<main class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">` containing the desktop then `InputDock`, then `PanelHost`, `AlreadyRunning`, `FileDialog`, `ImmersiveControls`. Everything sits inside a `TooltipProvider delayDuration={400} skipDelayDuration={200}`.

`--rail-size` is written to `<html>`: **sm 52 px, md 64 px, lg 76 px**.

### 2.2 Nav rail — `/home/eins0fx/development/lwfa/packages/shell/src/components/NavRail.tsx`

A single strip against one viewport edge, chosen by `prefs.nav.edge` (`auto | left | right | top | bottom`; `auto` resolves to `bottom` in portrait, `left` in landscape — `resolveEdge` in `lib/prefs.ts`).

**Container:** `z-30 flex shrink-0 items-center bg-sidebar/80 backdrop-blur-xl`. Vertical edges add `h-full flex-col border-r border-sidebar-border`; horizontal add `w-full flex-row border-b border-sidebar-border`. `right` swaps to `border-l`, `bottom` to `border-t`. Only the inner side gets a border. Inline `padding` and `gap` come from the size table.

**Size table (`SIZES`):**

| size | button | gap | pad | icon |
|---|---|---|---|---|
| `sm` | 36 | 4 | 8 | 16 |
| `md` (default) | 44 | 6 | 10 | 18 |
| `lg` | 52 | 8 | 12 | 20 |

**Three zones with `flex-1` spacers between them.** `start` (configuration, far from the thumb), `centre` (the launcher), `end` (anchored, under the thumb). Defaults (`DEFAULT_PREFS.nav` in `lib/prefs.ts`): `anchored = ["escape","gamepad","mouse","keyboard","clipboard","workspaces"]`, `centred = ["apps"]`, everything else falls to `start`. Spacers render even when a zone is empty so the remaining clusters do not slide.

**Button look (`RailButton`):** shadcn `Button variant={active ? "secondary" : "ghost"} size="icon"`, forced to `width/height = metrics.button`, `relative shrink-0 rounded-xl text-sidebar-foreground/65 transition-colors`, hover `bg-sidebar-accent text-sidebar-accent-foreground`. Active: `bg-card text-primary shadow-[0_1px_3px_#00000035]`. A glyph button (Escape) idle: `bg-foreground/[0.08] text-foreground/75`. Fired (Escape flash, 180 ms): `bg-primary text-primary-foreground`. Icons render at `size={metrics.icon}` with `strokeWidth={1.9}`.

**Badges on the button:** a group button gets a dot at `absolute right-1 bottom-1 size-1 rounded-full bg-current opacity-60`. The `info` button (or the group containing it) carries a connection light at `absolute top-1 right-1 size-1.5 rounded-full`, coloured `bg-success` / `bg-warning animate-pulse` / `bg-destructive` from `describeStatus().tone`.

**Tooltip:** side is the opposite of the rail edge (`left→right`, `right→left`, `top→bottom`, `bottom→top`), `max-w-56`, content is `<p class="font-medium">{label}</p>`.

**Collapse rules — `/home/eins0fx/development/lwfa/packages/shell/src/nav/registry.ts`.** A `ResizeObserver` measures the rail; `fitsIn` says `count·button + (count−1)·gap + 12 ≤ available − 2·pad`. `pickTier` picks the roomiest tier that fits, then `expandGroups` un-merges groups in order `["input","more"]` while they still fit.

Tiers:
0. everything, in the user's order.
1. `info, connections, access, theme, settings, apps, escape, **input**, clipboard, workspaces`
2. `apps, escape, workspaces, **input**, **more**`
3. `apps, workspaces, **more**` (the floor; below this the rail scrolls, it does not collapse further).

Groups: `input` = *"Input" / "Keyboard, mouse and gamepad"* / `SlidersHorizontal`, members `["keyboard","mouse","gamepad"]`; `more` = *"More" / "Session and settings"* / `MoreHorizontal`, members `["clipboard","info","connections","access","theme","settings"]`. A group inherits its members' zone (`zoneOf`), so `input` stays anchored. A group with one surviving member is rendered as that member.

**Immersive mode positioning:** when immersive, the rail becomes `position: fixed`, pinned to its edge with `env(safe-area-inset-*)`, and `visibility: hidden` + `inert` + `aria-hidden` when concealed.

### 2.3 Panel host — `/home/eins0fx/development/lwfa/packages/shell/src/components/PanelHost.tsx` + `components/ui/sheet.tsx`

**It is a non-modal side sheet (`Sheet modal={false}`), not a popover and not a modal.** It opens from the same edge the rail is on, starting where the rail ends, so you can switch panels without closing one. Panels are `React.lazy`.

Geometry (inline style, deliberately beating the variant classes):

- Vertical edge (`left`/`right`): `[side]: calc(var(--rail-size) + env(safe-area-inset-<side>, 0px))`, `width: min(30rem, calc(100vw − var(--rail-size) − env(safe-area-inset-<side>,0px)))`, `maxWidth: none`, `top: env(safe-area-inset-top,0px)`, `height: auto`. → **480 pt wide max.**
- Horizontal edge: `top: calc(var(--rail-size) + env(safe-area-inset-top,0px))` (or `bottom: var(--rail-size)`), `height: min(32rem, calc(100dvh − var(--rail-size) − env(safe-area-inset-top,0px)))`, `maxHeight: none`. → **512 pt tall max.**

Classes: `shell-panel flex flex-col gap-0 overflow-hidden p-0` plus `h-full` (vertical) or `w-full` (horizontal). Surface is `bg-background` with a border on the inner side, plus `.shell-panel`'s `box-shadow: 12px 0 40px -16px rgb(0 0 0 / 35%)`.

**Animation:** Radix data-state driven — open `animate-in` + `slide-in-from-<side>` with `duration-500`; close `animate-out` + `slide-out-to-<side>` with `duration-300`; overlay fades in/out. `.shell-panel` sets `animation: none; transition: none` under `prefers-reduced-motion: reduce`.

**Header (`PanelHeader`):** 64 px tall, `border-b px-5`, title left (18 px semibold), close button right — a 44 px hit area containing a 34 px `rounded-full bg-muted` circle with a 15 px `X` at `strokeWidth 2.2`, hover `bg-accent`. Description is `sr-only`.

**Group view:** if a merged group is opened, the header shows the group label/hint and a `TabsList` (`mx-3.5 mt-3.5 max-w-[calc(100%-1.75rem)] shrink-0 justify-start overflow-x-auto`) with one trigger per member, defaulting to the first.

**Body:** Radix `ScrollArea` (`min-h-0 flex-1`) wrapping `div.panel-body` with the padding above, `data-selectable`. Suspense fallback: `Loader2` spinner + "Loading…" at `text-sm text-muted-foreground py-10`.

**Dismiss guards:** `onPointerDownOutside` / `onInteractOutside` are prevented when the target is inside `[data-shell-nav]` or `[data-shell-panel-trigger]`, so rail and dock-gear taps switch panels instead of racing a close.

**Shared panel chrome CSS (`index.css`):**
- `.panel-group` — `overflow:hidden; border:1px solid var(--border); border-radius:12px; background:var(--card); color:var(--card-foreground)`, with each child after the first drawing an inset top divider via `::before { inset: 0 12px auto; border-top: 1px solid var(--border) }`.
- `.shell-panel [data-slot="toggle-group"] / [data-slot="tabs-list"]` — `gap:3px; padding:3px; border:0; border-radius:10px; background:var(--muted); box-shadow:none`.
- items — `min 44×44; padding:6px 8px; border-radius:7px; background:transparent; color:var(--muted-foreground); font-size:13px`; selected — `background:var(--card); color:var(--foreground); box-shadow:0 1px 3px rgb(0 0 0/16%); font-weight:600`; a selected item's `svg` turns `var(--primary)`.

### 2.4 Top/bottom bars

There is no conventional title bar. The chrome is exactly: the rail (one edge), the panel sheet (same edge), the input dock (bottom of the content area), and the arrange bar (bottom, only while arranging).

**Input dock** — `/home/eins0fx/development/lwfa/packages/shell/src/components/InputDock.tsx`. `z-20 flex flex-col pb-safe`. Stacked: `relative shrink-0 border-t border-border bg-card/95 backdrop-blur-xl`, height `calc(var(--dock) * 100%)` with `--dock` defaulting to **0.42**, draggable between **0.20 and 0.75** via a `GripHorizontal` handle (`size-4`, `cursor-ns-resize`, `touch-action:none`, aria-label "Resize the keyboard") that writes `--dock` straight to the DOM. Floating keyboard: `absolute inset-x-0 bottom-0 border-t border-border bg-card/85 backdrop-blur-xl`. Floating gamepad/mouse: `pointer-events-none absolute inset-0` with each control opting back in.

Dock header buttons (gamepad): `h-11 min-w-14 px-3 text-white/90`; Edit/Done, Show/Hide controls (`Eye`/`EyeOff`), shield (`Shield`/`ShieldOff`), Settings (`Settings2`, `data-shell-panel-trigger`), Hide (`X`). Header opacity tracks the pad opacity exactly. Mouse header uses `h-8 px-2.5` with a `after:-inset-1.5` hit expander.

**Arrange bar** — `/home/eins0fx/development/lwfa/packages/shell/src/components/ArrangeBar.tsx`. `pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/60 to-transparent`. Left: workspace chips (`h-11 min-w-11 px-3`, `variant default` when current else `secondary`, `data-workspace-drop={index}`; while carrying a window they grow `scale-110 ring-2 ring-primary ring-offset-2`). Right: `Done` button with `Check` icon, `h-11 gap-1.5 px-5`. Escape key exits arrange mode.

### 2.5 Immersive mode & logo FAB — `/home/eins0fx/development/lwfa/packages/shell/src/components/ImmersiveMode.tsx` + `lib/immersive.ts` + `.immersive-fab*` in `index.css`

Entered from `ImmersiveButton` (a 44 px `size-11` icon button with the `Scan` glyph at 16 px; label *"Enter immersive mode"* / *"Exit immersive mode"*), which appears in the Windows panel (both in each window's expanded actions and next to the text "Immersive mode" when following another device).

**FAB area:** `position: fixed; inset: max(12px, env(safe-area-inset-*)) on all four sides; z-index: 40; pointer-events: none`.

**FAB:** `position:absolute; top:0; left:0; display:grid; place-items:center; width:48px; height:48px; border:1px solid rgb(255 255 255 / 12%); border-radius:50%; background: rgb(12 13 16 / 65%); box-shadow: 0 2px 10px rgb(0 0 0 / 18%); opacity: 0.45; pointer-events:auto; touch-action:none; cursor:grab; transition: opacity 160ms ease, background-color 160ms ease.` Hover / focus-visible / `aria-expanded="true"` → `opacity: 1`. Focus ring `outline: 2px solid var(--ring); outline-offset: 3px`. Active → `cursor: grabbing; opacity: 1`. Content is `<img src="/brand/mark-on-dark.svg" class="size-7">` — a **28 px mark**, never the lockup.

Behaviour: tap toggles the nav rail (`aria-controls="shell-navigation"`, label "Show navigation"/"Hide navigation", title *"Tap to toggle navigation. Drag to move."*). Drag moves it; a movement of `hypot(dx,dy) ≥ 6 px` starts the drag and suppresses the click. Position is stored normalised `{x,y}` in `localStorage["lwfa.immersive.position"]`, clamped 0–1, **default `{ x: 1, y: 0.18 }`** (right edge, 18 % down).

**Exit affordance:** when navigation is revealed, a `.immersive-exit` secondary button appears — `position:fixed; z-index:40; right: max(12px, safe-area-right); bottom: max(12px, safe-area-bottom); min-height:44px; gap:8px` — `LogOut` icon + "Exit immersive mode".

**Error banner:** `role="alert"`, `fixed inset-x-4 top-4 z-[70] mx-auto max-w-lg flex items-center gap-3 rounded-xl border bg-card p-3 text-sm shadow-lg` with a ghost `X` dismiss. Verbatim messages from `lib/immersive.ts`:
- *"Could not exit fullscreen. Use the browser's exit control."*
- *"Browser fullscreen is unavailable here. Open lwfa in a supported browser or add it to your Home Screen."*
- *"The browser could not enter fullscreen. Tap Immersive mode to try again."*

Modes are `off | fullscreen | standalone`; installed-to-home-screen (`display-mode: standalone`) counts as immersive without a fullscreen request.

### 2.6 Login / connect screen — `/home/eins0fx/development/lwfa/packages/shell/src/Login.tsx`

Rendered instead of the whole shell when there is no stored password. Composition, top to bottom:

- `<main class="grid min-h-full place-items-center bg-background p-6">`
- `<form class="w-full max-w-sm space-y-6">` (max 384 pt)
- `<header class="space-y-3 text-center">`:
  - the **lockup**, not the mark: `/brand/lockup-horizontal-on-light.svg` shown in light (`mx-auto h-10 w-auto dark:hidden`) and `/brand/lockup-horizontal-on-dark.svg` in dark (`hidden … dark:block`). **40 pt tall.** Two files, because the mark is drawn for its ground — do not recolour one. No `<h1>`: the name is in the picture.
  - `<p class="text-sm text-muted-foreground">` — verbatim: **"Enter the password from this machine's `.env`"** (`.env` in `<code class="font-mono">`, curly apostrophe).
- Field block `space-y-2`: `<Label for="password">` **"Password"**; `<Input type="password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" required>`, `aria-invalid` when errored. Input style: `h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs`, focus `border-ring ring-[3px] ring-ring/50`, dark `bg-input/30`.
- Error, when present: `<p id="password-error" role="alert" class="text-sm text-destructive">{error}</p>`. Note: in the current `App.tsx` the `authError` state is only ever cleared (`setAuthError(undefined)`), so this slot is wired but unused — refused passwords surface through the session status instead (see §3.1).
- Submit: full-width primary `Button` labelled **"Connect"**, disabled while the field is empty or `busy`; when busy it prefixes a `Loader2` spinner (`size-4 animate-spin`).
- Footer: `<p class="text-center text-xs text-muted-foreground">` — verbatim: **"The engine prints a one-tap link at startup if you would rather not type it."**

The input is focused on mount and again after every rejection.

### 2.7 Status indicators — `/home/eins0fx/development/lwfa/packages/shell/src/lib/status.ts`

One table drives the rail dot and the Session panel so they cannot disagree. `Tone` is `good | busy | bad` → `--success` / `--warning` (pulsing) / `--destructive`.

| Status | Label | Hint | Tone |
|---|---|---|---|
| `connected` | "Connected" | "The desktop is live." | good |
| `connecting` | "Connecting" | "Opening a connection to the engine." | busy |
| `waiting` | "Another tab has it" | "This desktop is open in another tab. Close it to use this one instead." | busy |
| `disconnected` | "Reconnecting" | "The connection dropped. Trying again." | busy |
| `unreachable` | "No answer" | "The engine did not accept the connection. It may not be running." | bad |
| `unauthorized` | "Password refused" | "The engine rejected this password." | bad |
| `incompatible` | "Version mismatch" | "The engine and this page speak different protocol versions." | bad |
| `replaced` | "Taken over" | "Another tab took this session. Reload to use it here." | bad |

---

## 3. Panels — every control, in order

Panel registry (`PanelHost.PANELS`): `theme→Appearance`, `settings→Settings`, `info→Session`, `connections→Connections`, `access→Access`, `apps→Apps`, `workspaces→Windows`, `clipboard→Clipboard`, `keyboard→Keyboard`, `gamepad→Gamepad`, `mouse→Mouse`. `escape` has no panel (action); `keyboard`/`mouse` rail taps toggle their dock, not the panel — only the dock gear opens those panels.

### 3.1 Session — `/home/eins0fx/development/lwfa/packages/shell/src/panels/SessionPanel.tsx`

Title "Session", hint "Connection and stream status". Everything here is *observed*, never chosen.

**Connection** (readout rows in a `panel-group` `<dl>`): `Status` (coloured dot + `capitalize` label), `Decode` (`describeFormat`), `Windows` (count), `Viewport` (`W × H` or "Unavailable"). When tone ≠ good the hint sentence prints below in 12 px muted. If H.264 is unsupported: a warning card `rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning` reading **"H.264 unavailable. A supported browser and HTTPS are required."**

**Video**: if `stream.enabled` is false → dashed card **"Video paused. Enable it in Stream."** Otherwise rows: `Frame rate` (`N /s` or "Nothing yet", tinted warning below 20 fps), `Bitrate` (`N kbit/s` under 1000, else `N.N Mbit/s`, else "Nothing yet"), `Largest frame`, `Keyframes` (`k of fps`). Below 20 fps adds a dashed note **"Low frame rate."**

**Sound**: when audio is off → a row with "Muted" and an outline `Enable` button (`h-11`). When on, renders `AudioReadout` (`/home/eins0fx/development/lwfa/packages/shell/src/panels/AudioReadout.tsx`), polled every 700 ms: `Audio context`, `Playback path` ("Audio worklet" / "Scheduled buffers (no HTTPS)" / "None"), `Incoming audio` ("nothing yet" / "Opus, N kbit/s" / "Opus, measuring" / "raw PCM, 1536 kbit/s"), `Playback buffer` (ms), `Chunks received`, `Dropouts`. The whole block turns `text-warning` when stalled, starved, or buffered > 150 ms, and appends one of: "Uncompressed audio fallback is active." / "Playback buffer is high." / "Tap to start audio." / "No audio received yet."

**Session**: `Engine` (endpoint in `<code class="font-mono text-xs">`), `Account` (`name · mode · all apps|N apps`), `Workspace` (`i of n · k columns`), `Devices` (`This one only|N attached · driving here|following`), `Focus` (window title or "Nothing focused"), `Version` (`SHELL_VERSION`, or warning-coloured `1.5.10 · machine has X`). If stale, a warning card: **"Reload to match engine version {v}. Windows stay open."** + primary button **"Reload to update"** (`RefreshCw`, `h-11 w-full`). If not primary: outline **"Arrange from this device"** (`Gamepad2`).

**Log** (description "Newest first."): empty → dashed **"Nothing yet."**; else an `<ol>` in `rounded-xl border bg-card px-3 py-2.5 font-mono text-[11px]` with timestamp + message, warn rows `text-warning`, error rows `text-destructive`.

**Footer actions:** outline **"Sign out of this device"** (`LogOut`, `h-11 w-full`). Owners also get outline **"Restart lwfa"** (`RefreshCw`, spinning and reading **"Restarting lwfa…"** while pending; disabled unless owner + engine ≥ 1.5.4 + connected). If unsupported: **"Requires engine 1.5.4 or newer."** Confirm dialog — title **"Restart lwfa?"**, body **"Everyone will disconnect, and running apps and games may close. Save your work first. This page will reconnect automatically."**, buttons `Cancel` (outline) and `Restart lwfa` (destructive), both `h-11`.

### 3.2 Connections — `/home/eins0fx/development/lwfa/packages/shell/src/panels/ConnectionsPanel.tsx`

Title "Connections", hint "Saved connections".

- **Connected to** — a card `flex items-center gap-3 rounded-xl border bg-card p-3` with a `size-2` dot (`bg-success` / `bg-destructive`), label + endpoint (`font-mono text-xs`), and an outline `Badge` with the account name. If the current machine is not saved: outline button **"Save this machine"** (`Plus`, `h-11 w-full`).
- **Attached devices**, description "One device controls the layout." Empty → dashed "No other devices." Each peer row: device icon (`Tablet` for iPad, `Smartphone` for iPhone/Android, else `Monitor`), device name with `(this one)` suffix for self, account name beneath, an outline `Viewing` badge (`Eye`) and/or a solid `Driving` badge (`Gamepad2`). Owners get two `h-11 flex-1` outline buttons per other peer: **"Allow input"** / **"Viewing only"** (`Pencil`/`Eye`) and **"Disconnect"** (`LogOut`, hover `text-destructive`). If not primary: **"Drive from this device"** (`Gamepad2`, `h-11 w-full`).
- **Saved**, description "Stored on this device. Switching reloads the page." Empty → dashed "No saved machines." Rows sorted by `lastUsed` desc: `Monitor` icon, label + `font-mono` URL, ghost trash button (`size-11`, hover `text-destructive`, label `Forget {label}`).
- **Add a machine** — outline `h-11 w-full` with `Plus`. Opens an inline form in `rounded-xl border bg-card p-3`: heading "Add a machine" + ghost `X` Cancel; `Address` input (placeholder `192.168.1.51`, `font-mono`, `autoCapitalize=none`) with hint **"Port 6734 is assumed. `ws://host:port` also works."**; `Password` input; `Name (optional)` input (placeholder `desktop`); submit `h-11 w-full` **"Save"** with `Check`.

### 3.3 Access — `/home/eins0fx/development/lwfa/packages/shell/src/panels/AccessPanel.tsx`

Title "Access", hint "Accounts and permissions".

Non-owners see only **This session** and a dashed note **"Sign in as the owner to manage accounts."**

- **This session** — card with `ShieldCheck` in `text-primary size-5`, the account name (or "not connected"), and a muted line `Interact|View only · all apps` or `· N application(s)`.
- **Accounts**, description "Each account has its own password and permissions." Loading → spinner + "Loading…". Empty → dashed "No additional accounts." Each row: name, outline badge with `Hand`/`Eye` and the mode word, and a ghost `h-11` **Edit**/**Done** toggle. Expanded (`border-t bg-primary/3 p-3`): a `View`/`Interact` toggle group (`h-11 flex-1`, icons `Eye`/`Hand`), then the app allow-list, then a ghost destructive **"Delete account"** (`Trash2`).
- **Applications** sub-control: a `FieldRow` with label "Applications" and a two-item toggle group `All` / `Selected` (`h-11`). When `Selected`, a `max-h-48 divide-y overflow-y-auto rounded-lg border bg-card` list of apps; each is a `min-h-11` button, selected rows `bg-primary/15 text-primary` with a `✓`. Placeholder while loading: "Reading applications…".
- **Add an account** — outline `h-11 w-full` `Plus`. Form: heading "New account", `Name` (placeholder `tablet`), `Password` with hint **"Use this password to sign in to the account."**, a `View`/`Interact` toggle group (default **view**), submit **"Create"**. New accounts start with `allowedApps: []` — able to launch nothing.

### 3.4 Appearance — `/home/eins0fx/development/lwfa/packages/shell/src/panels/AppearancePanel.tsx`

Title "Appearance", hint "Theme and feedback".

- **Theme** — toggle group, `variant="outline"`, full width, three items each `flex-1 gap-2` with a `size-4` icon: **Light** (`Sun`), **Dark** (`Moon`), **System** (`Monitor`). Default `system`.
- **Motion** — `panel-group` with two switch rows: **"Animate window movement"** (default on) and **"Mirror the desktop's scroll"** (default off).
- **Haptics** — two switch rows labelled **Keyboard** (default on) and **Gamepad** (default on), both at 13.5 px `font-medium`.

### 3.5 Settings — `/home/eins0fx/development/lwfa/packages/shell/src/panels/SettingsPanel.tsx`

Title "Settings", hint "Navigation and streaming". Three tabs in a **sticky** `TabsList` (`sticky top-0 z-10 w-full`), each trigger `flex-1`: **Navigation**, **Buttons**, **Stream**. Default `navigation`. `Tabs` gap is `15px`.

**Navigation tab**
- **Position**, description "Auto follows the shape of the screen." — a 5-column outline toggle group, each item `flex-col gap-1 py-2 h-auto` with a `size-4` icon and an 11 px label: **Auto** (`Wand2`), **Left** (`PanelLeft`), **Top** (`PanelTop`), **Right** (`PanelRight`), **Bottom** (`PanelBottom`). Default `auto`.
- **Button size** — outline toggle group, `flex-1` items: **"36 px"** (`sm`), **"44 px"** (`md`, default), **"52 px"** (`lg`).

**Buttons tab**
- **Buttons** — a `panel-group` `<ul>` of all twelve nav items in the user's order. Each row `flex min-h-11 items-center gap-1 px-3 py-1`: item icon (`size-4`, `opacity-40` if hidden), label (13.5 px, `line-through text-muted-foreground` if hidden), then four `size-11` ghost icon buttons — `ArrowUp` ("Move X earlier", disabled first), `ArrowDown` ("Move X later", disabled last), anchor toggle (`ArrowDownToLine text-primary` when anchored / `ArrowUpToLine opacity-60` when not; labels "Anchor X to the far end" / "Move X to the near end"), visibility toggle (`Eye` / `EyeOff opacity-60`; "Hide X" / "Show X").

**Stream tab** (`StreamSettings`)
- **Video**, description "Pausing video keeps the connection open."
  - **"Show the desktop"** switch, hint "Receiving video" / "Paused". Default on.
  - **"Pause inactive windows"** switch, hint "Only the focused window streams live" / "Every visible window streams live". Default **on**. Turning it **off** opens an inline confirm in `bg-warning/10 p-3`: **"Streaming all visible windows uses more bandwidth and battery."** with `Stream all windows` (outline) and `Keep pausing` (primary), both `h-11 flex-1`. Turning it back on never asks.
- **Video quality**, description "Video uses less bandwidth. JPEG keeps text sharper." — outline toggle group of `h-11 flex-1` items: **Auto** (default), **HEVC** (only if decodable), **H.264** (only if decodable), **JPEG**. Disabled when video is off. If no hardware decoder: a dashed note **"No supported video decoder detected. Using JPEG. HTTPS is required for H.264 and HEVC."**
- **Sound**
  - **"Enable audio"** switch, hint "Streaming" / "Muted". Default **off**.
  - When on: **"Also play on the desktop's speakers"** switch, hint "Plays on the host and this device" / "Plays on connected devices only". Default off.
  - When on: **Volume** row, hint `{N}%`, slider `min 0 max 1 step 0.05`, width `w-[min(40%,150px)]`, default 1. The slider writes to the audio engine on every move but persists only on commit.
  - On Apple mobile: dashed note **"If audio is silent on iOS, check Silent Mode."**
  - **Sound quality** field, hint "Adapts to the connection" / "128 kbit/s" / "96 kbit/s" / "64 kbit/s"; outline toggle group `h-11 flex-1`: **Auto** (default), **High**, **Medium**, **Low**.
- **Reset** (outside the tabs, always visible): row **"Restore defaults"**, hint **"Resets this device only."**, outline `Reset` button with `RotateCcw`.

### 3.6 Apps — `/home/eins0fx/development/lwfa/packages/shell/src/panels/AppsPanel.tsx`

Title "Apps", hint "Launch apps".

- Search field: `Input` `h-11 pl-9` with a `Search` icon absolutely positioned at `left-3`, placeholder **"Search applications"**, aria-label the same.
- Loading: spinner + **"Reading installed applications…"**. No matches: dashed card **"Nothing matches “{query}”."** (curly quotes) or **"No applications found."**
- Result section heading: **"{n} application"** / **"{n} applications"**. Rows are `panel-group` list items with `content-visibility:auto; contain-intrinsic-size:auto 52px`; each row is a `min-h-11 w-full` button with a 32 px icon (`size-8 rounded-lg object-contain`) or, if no icon resolved, a coloured initial tile (`oklch(0.55 0.13 {hash%360})`, white semibold letter). Name 14 px medium, description 12 px muted, truncated. While launching: `Loader2` spinner and `bg-accent/60` (not dimmed). Terminal apps get an outline badge `term` with `TerminalSquare`. Launch timeout 20 s.
- **Running with no window** (when present): note **"Background applications."**, rows `program` + pid, with a `secondary h-11` **Quit** button.
- **Run a command**: a form `flex gap-2 rounded-xl border bg-card p-2` with a `font-mono h-11` input (placeholder `alacritty`, aria-label "Command to run") and an outline `h-11` **Run** button.

Ranking (`filter`): name prefix (0) > word start (1) > name substring (2) > id substring (3) > description (4) > category (5), ties broken alphabetically.

### 3.7 Escape

No panel. `NavItem` `{ id: "escape", label: "Escape", hint: "Send Escape", kind: "action", glyph: "ESC", icon: CornerUpLeft }`. Pressing it sends evdev key `1` down then up, fires a haptic `tap(8)` if `keyboard.haptics`, and flashes the button `bg-primary text-primary-foreground` for **180 ms** (`ShellChrome.select`).

### 3.8 Gamepad — `/home/eins0fx/development/lwfa/packages/shell/src/panels/GamepadPanel.tsx`

Title "Gamepad", hint "Controller and gaming settings". Sticky `TabsList` with four `flex-1 px-2` triggers: **Controller** (default), **Proton**, **LSFG**, **Framegen**.

**Controller tab** (`ControllerControls`)
- `panel-group`: **"Show the gamepad"** switch (bound to the dock). **"Edit layout"** row, hint "Drag the controls to rearrange them." / "Turn the gamepad on first." with a `Pencil` **Edit**/**Done** button (`sm`, `default` variant when editing), disabled unless visible.
- **Labels** — 3-column outline toggle group, each item `h-auto flex-col gap-0.5 px-1 py-2` with a 12 px name and a 10 px `opacity-70` sample: **PlayStation** `△ ✕ ○ □`, **Xbox** `Y A B X`, **Neutral** `N S E W` (default **neutral**).
- **Opacity** — slider `min 0.2 max 1 step 0.05`, `flex-1`, plus a `w-10 text-right tabular-nums` percentage. Default **0.85**.
- **Placement**, description "Stacked reduces the desktop to make room for the gamepad." — `PlacementChoice` (see §3.11). Default **overlay**.
- **Stray taps** — **"Block taps outside the pads"** switch, hint "Overlay only, never while editing." / "Only applies to an overlay controller."; disabled unless placement is overlay. Default **off**.
- **Haptics** — **"Vibrate on press"** switch, default on. Description appended when the platform is limited: "Vibration may be unavailable in this browser." or "Vibration is unavailable in this browser."
- **Layout**:
  - A `<details>` whose summary is **"Keyboard buttons"** with a right-hand `Plus` + **"Add a key"** affordance; body note **"A key or a chord as a button on the pad."** then `CustomKeys`.
  - `Backup`: row **"Save a backup"**, hint "Layout and controller settings.", buttons `File` (`Download`) and `Copy` (`Copy`, becomes "Copied" for 1.5 s). Row **"Restore"**, hint "Replaces the controller with a saved one.", buttons `File` (`Upload`, hidden `<input type=file accept=application/json>`) and `Paste` (`ClipboardPaste`, toggles a 4-row `font-mono text-xs` textarea with placeholder **"Paste a backup here"** and a full-width **"Restore from text"** button). Failure: destructive-tinted note; success: dashed note **"Controller restored."** (auto-clears after 2.5 s).
  - Row **"Restore the default arrangement"** with outline **Reset** (`RotateCcw`) → `DEFAULT_LAYOUT`.
- **Physical controller**, description "Release the controller buttons before resetting." — row **"Clear held input"** with outline **Reset**; row **"Record input"**, hint **"Last 4,096 samples, about 33 seconds."**, outline button **Record** / **"Stop and save"** (downloads `lwfa-controller-trace.json`).

**CustomKeys** (`/home/eins0fx/development/lwfa/packages/shell/src/panels/CustomKeys.tsx`): existing key pads in a `divide-y rounded-lg border bg-muted/20` list with a `size-11` ghost `Trash2`; four modifier toggles **Ctrl / Shift / Alt / Super** (`h-11 min-w-11 flex-1 rounded-lg`); a key grid `grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1 max-h-56 overflow-y-auto rounded-md border p-1.5` built from `MAIN_ROWS + FUNCTION_ROW + EXTRA_KEYS` minus modifiers, selected key `border-primary bg-primary/15 font-medium`; a footer row whose label is the chord name or **"Pick a key"**, hint "Drag to reposition in edit mode." / "Modifiers are optional.", with a `Plus` **Add** button. New pads land at `x:50, y:62, size:11`.

**Proton / LSFG / Framegen tabs** (`/home/eins0fx/development/lwfa/packages/shell/src/panels/GamingPanel.tsx`). Non-owners see **"Gaming components are managed by the session owner."** Header: the component name (**"lwfa Proton"** / **"lwfa LSFG"** / **"lwfa Framegen"**) and a ghost `RefreshCw` "Refresh gaming components".

- Install row: label **"GE-Proton + Canvas"** / **"lsfg-vk {version}"** / **"OptiScaler {version}"**, hint "Installed" / "Not installed", with an outline `Download` **Install** button when absent.
- Proton copy, verbatim: *"Includes the original GE runtime and lwfa's window sizing fixes. Host games use the original runtime. The base download is about 509 MiB."* … per-tool rows with hint `Self-contained` / `Uses a separate GE installation` plus `· In use` … *"After installation, restart Steam when your games are closed. Choose the lwfa Canvas tool in the game's Properties → Compatibility."*
- LSFG copy: *"Requires your purchased Lossless Scaling. Interpolates game images to make motion smoother. For a 60 FPS stream, start with a stable 30 FPS game limit and 2× generation."* Fallback: *"Install Lossless Scaling through Steam to provide its required DLL."*
- Framegen copy: *"Experimental, for compatible games with frame-generation hooks. Uses an isolated game-file overlay and preserves native NVIDIA upscaling. Support varies by game and Steam Input setup."* Fallback: *"This host needs Bubblewrap with overlay support."*
- **Game** section: a native `<select>` (`h-10 w-full rounded-md border border-input bg-background px-3 text-sm`), empty option **"No installed Steam games"**.
- Per-game: switch **"Use LSFG"** / **"Use Framegen"**, hint "One frame generation provider per game." or "Currently set to LSFG/Framegen."
  - LSFG options: **Multiplier** select `2× / 3× / 4×` (default 2); **Motion detail** select `Full` (1) / `Balanced` (0.75) / `Reduced GPU load` (0.5) / `Lowest GPU load` (0.25); switch **"Performance mode"**, hint "Reduces processing cost and image detail." (default off).
  - Framegen options: **Game integration** select — `DLSS frame generation` (dlssg, default), `FSR 3.1 frame generation`, `FSR 3.0 frame generation`, `Upscaler integration`, `DLSSG-to-FSR3`; **Frame generation backend** select — `FSR` (default) / `XeSS`, or pinned to `DLSSG-to-FSR3`.
- Full-width **"Save for next launch"**; saved note *"Saved: … Applies on the next launch."*; footer *"Close and relaunch the game to apply changes. Turn off other frame-generation layers first; keep native upscaling if supported."*
- **Steam launch option** section: *"Add this once in the game's Properties → General. The wrapper applies its profile only inside lwfa. Host launches pass through unchanged."*, the option itself in `<code class="block break-all rounded-md bg-muted p-2 text-xs select-text">`, and an outline `Copy` **"Copy launch option"** (notice "Launch option copied." / "Copy the launch option shown below.").

### 3.9 Mouse — `/home/eins0fx/development/lwfa/packages/shell/src/panels/MousePanel.tsx`

Title "Mouse", hint "Show mouse controls" (rail button docks the surface; this panel is behind the dock gear).

- Row **"Show the mouse"**, hint **"A tap becomes a real click."**, with a `Mouse`-icon `Show`/`Hide` button.
- **Default button**, description **"Change it live from the buttons on the mouse surface."** — 3-column toggle group `Left` / `Right` / `Middle`. Default **left**.
- **Scrolling**: row **"Scroll speed"**, hint **"Matches the desktop by default."**, slider `min 0.1 max 1.5 step 0.05`, default **0.4** (mirrors the desktop's `scroll_factor`), `w-[min(40%,150px)]`. Row **"Natural scrolling"**, hint **"Contents follow your finger."**, switch, default off.
- **Placement**, description "Stacked reduces the desktop to make room for the mouse." Default **overlay**.
- **Haptics**: **"Vibrate on press"**, default on.

### 3.10 Keyboard — `/home/eins0fx/development/lwfa/packages/shell/src/panels/KeyboardPanel.tsx`

Title "Keyboard", hint "Show keyboard".

- Row **"Show the keyboard"** with a `Keyboard`-icon `Show`/`Hide` button.
- **Keys**: **"Show the Escape button"**, hint **"A one-tap Escape button in the navigation bar."** (writes the same `nav.hidden` set Settings edits). **"Start in combo mode"**, hint **"Holds modifiers until you tap them again."**, default **on**.
- **Placement**, description "Stacked reduces the desktop to make room for the keyboard." Default **stacked**.
- **Haptics**: **"Vibrate on press"**, default on.

### 3.11 Shared placement control — `/home/eins0fx/development/lwfa/packages/shell/src/panels/placement.tsx`

Two-column outline toggle group, items `h-auto flex-col gap-0.5 px-1 py-2`:
- **Overlay** — `Layers` icon `size-[15px]`, 12 px label, 10 px `opacity-70` sub-label **"Floats on top"**.
- **Stacked** — `PanelBottom` icon, sub-label **"Takes its own space"**.

### 3.12 Clipboard — `/home/eins0fx/development/lwfa/packages/shell/src/panels/ClipboardPanel.tsx`

Title "Clipboard", hint "Clipboard history". Guards: **"Clipboard access requires permission to interact."**, **"Not connected to the machine."**, **"Connecting…"** (all in a dashed `rounded-xl border p-4` card).

**Send**: two `h-11 flex-1` outline buttons — **"Send clipboard"** (`ClipboardPaste`, spinner while asking) and **"Choose files"** (`Upload`). A `min-h-16 resize-y rounded-xl border bg-card p-2 text-sm` textarea, placeholder **"Paste text or a file here"**, aria-label "Text or files to send"; pasting files intercepts them. A primary `h-11` **Send** button (`Send` icon). Status line, 12 px muted: "Clipboard is empty." / "Image sent." / "Text sent." / **"Clipboard access was denied. Paste into the box below."**

Outgoing rows: state icon (`Check text-success` / `SquareDashed text-destructive` / spinning `Loader2`), name, and a right-hand status — "On the machine", the error, `Paused at N%`, `N% · 1.2 MB/s`, or "Waiting". A `h-1 rounded-full bg-muted` progress bar with a `bg-primary transition-[width] duration-200` fill. A `size-11` dismiss button with `Trash2` once done or failed.

**History**: loading → three skeleton rows (`animate-pulse bg-muted`). Empty → **"No clipboard history."** Each entry is `overflow-hidden rounded-xl border bg-card`; the newest also gets `border-primary/50` and a header bar `border-b bg-primary/10 px-3 py-1.5` reading **"ON THE CLIPBOARD"** (10.5 px, semibold, uppercase, `text-primary`) with the relative time on the right. Body: 48 px thumbnail (lazy-loaded image, or a dashed box with `ImageIcon`/`FileIcon`/`Type`), a `font-mono text-xs line-clamp-3` preview for text (with a trailing `…` when truncated) or a single truncated line otherwise, then a meta line `{origin} · {size}` plus `· W×H` and `· {ago}`. Origins read **"Session window"**, **"Machine desktop"**, or the device name / "Device". Relative time: "just now" (<45 s), "N min ago", "N h ago", else `D Mon`.

Actions per entry, all `h-11 sm` outline: **"Copy here"** (→ "Copied here" for 1.5 s), **"Put back"** (`Monitor`, hidden on the current entry), **"Download"** (when savable), plus an `ml-auto size-11` ghost `Trash2` "Forget this entry". Paging: outline `h-11 w-full` **"Show older"** / **"Loading"**.

### 3.13 Windows — `/home/eins0fx/development/lwfa/packages/shell/src/panels/WindowsPanel.tsx`

Title "Windows", hint "Window layout". When another device is driving, a warning card (`rounded-xl border border-warning/40 bg-warning/10 p-3`) reads **"{device} is driving."** + muted **"Input remains available."** with a full-width **"Arrange from this device"** button; and an `ImmersiveButton` next to the text "Immersive mode". Everything else is wrapped in a `fieldset disabled` (`display: contents`) when not primary.

- Primary full-width `h-11` button **"Arrange windows"** with `LayoutGrid size-5`.
- **Workspace**: a wrapping row of chips, each `h-12 min-w-12 flex-1 flex-col rounded-xl border px-3` showing the index and `empty` / `N win` at 10 px; current chip `border-primary bg-primary text-primary-foreground`, others `bg-card hover:bg-accent`. Then **"Fit to screen"** switch, whose hint is one of: "Nothing open on this workspace" / "{n} columns will not fit; the strip keeps scrolling" / "Columns share the screen; all windows stream" / "Columns keep their width; the strip scrolls".
- **Windows**: empty → dashed `p-8` card **"No windows in this workspace."** with an outline **"Open a terminal"** button (`Plus`, spawns `alacritty`). Otherwise a `panel-group` list.
  - A **column with >1 window** gets its own header row on `bg-muted/40`: a 4 px focus bar (`bg-primary` when it holds focus, else `bg-border`), `Columns2` icon, "{n} windows", an optional `MonitorPlay` + count pill in `bg-primary/15 text-primary`, a width pill (`bg-muted text-[10px] tabular-nums`, e.g. `90%`), and a `min-h-11 w-11` chevron that rotates 180° when open. Expanded: **Column width** toggle group over `WIDTH_PRESETS` — `33 / 50 / 67 / 90 / 99` (labels are the rounded percentages, items `h-11 min-w-10 flex-1 text-xs tabular-nums`), disabled while fitted; plus a `MonitorPlay` icon toggle whose label is one of "Only one window in this column" / "Every visible window already streams" / "Stream only the focused window of this column" / "Stream all N windows in this column".
  - **Window rows**: title (or a pulsing skeleton bar while unnamed), `CornerDownRight` marker when stacked, focus tint `bg-primary/5`, chevron for actions. Expanded actions are a wrapping row of 44 px `IconAction` buttons with tooltips: `ImmersiveButton`, **Fullscreen** / **Exit fullscreen** (`Maximize2`/`Minimize2`), **"Stack onto the column to the left"** (`ArrowLeftToLine`), **"Move into its own column"** (`ArrowRightToLine`), **Close** (`X`, danger), **"Quit the application"** (`Power`, danger). Below: **"Send to"** label plus one `h-11 min-w-11` outline button per workspace (current one disabled). A solo column adds a `COLUMN` sub-heading with the column controls.
  - **Spawning**: dashed rows **"Opening {name}…"** with a spinner ring.
- **Layout**, description **"Saved on this device."** — **Direction** field, hint **"Auto follows the screen orientation."**, toggle group `Auto` / `Rows` / `Columns` (default `auto`); **New window size** toggle group over the same width presets (default index **3** = 90 %); **"Keep focus centred"** switch (default **on**).

### 3.14 Info / diagnostics

There is no separate Info panel — `info` *is* the Session panel (§3.1). Diagnostic surfaces elsewhere: `AudioReadout`, the Session log, the controller trace recorder, and the crash screen `/home/eins0fx/development/lwfa/packages/shell/src/components/Crashed.tsx` (heading **"The shell keeps stopping"**, body *"It restarted itself N times and hit the same problem, so it has stopped trying."* / *"It could not restart itself, so it has stopped rather than risk a reload loop."* + *"The desktop is still running: reloading picks it up where it was."*, the error message in a `max-h-40 rounded-lg bg-muted p-3 font-mono text-xs` block, and buttons **Reload** (primary, `h-11 flex-1`) and **"Try again"** (outline `h-11`)).

`AlreadyRunning` (`/home/eins0fx/development/lwfa/packages/shell/src/components/AlreadyRunning.tsx`) is a modal dialog with three phases:
- *asking*: `MonitorSmartphone` icon, title **"{program} is already open on the desktop"**, body *"Apps that share a profile reuse their open window instead of starting a second copy, so it opened on the desktop rather than here."*, buttons `Cancel` (outline) / **"Close it and open here"**.
- *closing*: spinner, title **"Waiting for {program} to close"**, body *"It may be asking to save something on the desktop screen."*, a disabled **"Waiting…"** button.
- *stubborn*: `TriangleAlert text-warning`, title **"{program} has not closed"**, body *"It is most likely asking to save something on the desktop screen. Answer it there, or force it to quit and lose those changes."*, buttons **"Leave it open"**, **"Keep waiting"**, **"Force quit"** (destructive).

### 3.15 File dialog — `/home/eins0fx/development/lwfa/packages/shell/src/components/FileDialog.tsx` + `FileDetails.tsx`

A modal `Dialog`. Sizing: `max-h-[90dvh] w-[min(80rem,94vw)] sm:max-w-none`; on small screens it becomes a bottom sheet (`max-sm:top-auto max-sm:bottom-0 max-sm:w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:border-b-0`).

- Title: the app's own, else **"Save file"** / **"Save files"** / **"Choose a folder"** / **"Choose files"**.
- Description: `{who} wants to save a file` / `wants to save N files` / `is asking for a folder` / `is asking for files` / `is asking for a file`, plus ` · {filter names}` and ` · N more waiting`.
- Paused banner: `border-warning/50 bg-warning/10` with `TriangleAlert` — **"Connection lost, upload paused. It resumes where it stopped."**
- Two tabs (`grid-cols-2`, `h-10`): **"From this device"** and **"On the desktop"** (hidden for save modes).
- **Upload pane**: a dashed drop zone (`border-primary bg-primary/5` while dragging) reading **"Drop files here, or"** with outline `h-11` buttons **"Pick files"** (`Upload`) and **"Pick a folder"** (`FolderOpen`). Upload rows with `Check`/`CircleAlert`/`Loader2`/`FileIcon`, name, status, and an inline progress bar. An **Overall** progress line when >1 file.
- **Browse pane**: an "Up one folder" `size-9` button, a `w-40 h-9 pl-7` Filter input (`Search` icon), a hidden-files toggle ("Show hidden files"/"Hide hidden files"), a breadcrumb path, a `w-44` Places sidebar (`sm:block`, `Home`/`Folder` icons), and a table with sortable headers **Name / Modified / Size**. Rows use `content-visibility:auto; contain-intrinsic-size:auto 44px`, a `Check text-primary` for selected, `Folder`/`FileIcon` otherwise, and per-row "Open {name}" / "About {name}" actions. Footer: **"Folder too large to list fully; showing the first 3000."** / `N selected` / **"Saving into this folder."** plus `N hidden by filter` / `N hidden`, and a `Show all` / `Apply filter` link.
- **Save mode** adds a `Name` label + `h-11` input, with a warning line **"A file with this name already exists here and will be overwritten."** (`CircleAlert text-warning`). `saveFiles` mode shows **"Saving into the folder above: {names}"**.
- Details pane (`FileDetails.tsx`): a `w-72` aside with the name, kind, a close `×`, and two tabs **Preview** / **Properties**; previews handle image (`object-contain`), video, audio, iframe, and a `font-mono text-xs whitespace-pre-wrap` text block; properties are a `dl` with a `w-24` muted term column plus a **Where** row in `font-mono break-all`.
- Footer: `Cancel` (outline `h-11`) and the confirm button `h-11` labelled **"Save here"** / **"Save them here"** / **"Choose selected"** / **"Choose N items"** / **"Use upload"** / **"Use N uploads"** / **"Choose"**.

---

## 4. Input docks and overlays

### 4.1 On-screen keyboard — `/home/eins0fx/development/lwfa/packages/shell/src/keyboard/layout.ts` + `keyboard/Keyboard.tsx`

Keys are **evdev keycodes**, not characters — the remote machine owns the keymap. Legends are US-layout labels only.

**Container:** `flex h-full min-h-0 flex-col gap-1.5 p-2`.

**Toolbar** (`flex shrink-0 items-center gap-1.5`):
- Mode button `h-8 gap-1.5` with `Zap size-3.5`, reading **"Normal"** (outline) or **"Combo"** (primary), title *"Keep modifiers held until tapped again"*.
- **"More keys"** button `h-8` (outline / secondary when on), title *"Insert, Home, Page Up and other full-size keys"*.
- When modifiers are latched: a `rounded-md bg-primary/15 px-2 py-1 font-mono text-xs text-primary` chip reading e.g. `Ctrl + Alt + ...`, tapping clears (aria-label "Clear held modifiers").
- Right-aligned, horizontally scrollable: the **first six combos** as `rounded-md border bg-card px-2 py-1 font-mono text-[10px]` chips.

**Combos (`COMBOS`, first six shown):** `Ctrl C` "Copy, or interrupt", `Ctrl V` "Paste", `Ctrl X` "Cut", `Ctrl Z` "Undo", `Ctrl A` "Select all", `Ctrl S` "Save", then `Ctrl W` "Close", `Ctrl D` "End of input", `Ctrl L` "Clear", `Ctrl R` "Reverse search", `Alt Tab` "Switch window", `Alt F4` "Quit", `Ctrl Alt Del`, `Ctrl Alt T` "Terminal".

**Rows** (`flex min-h-0 flex-1 flex-col gap-1`; every row is `flex min-h-0 flex-1 gap-1` and a size container). Function row is **always visible**, then the five main rows, then the extras row when toggled. Width is `flexGrow = key.width ?? 1`, `flexBasis: 0`.

- **FUNCTION_ROW** (13 keys, width 1): `Esc(1) F1(59) F2(60) F3(61) F4(62) F5(63) F6(64) F7(65) F8(66) F9(67) F10(68) F11(87) F12(88)`
- **Row 1** (14): `` ` ``(41,~) 1(2,!) 2(3,@) 3(4,#) 4(5,$) 5(6,%) 6(7,^) 7(8,&) 8(9,*) 9(10,`(`) 0(11,`)`) -(12,_) =(13,+) **Bksp**(14, w2)
- **Row 2** (14): **Tab**(15, w1.5) q w e r t y u i o p `[`(26,{) `]`(27,}) `\`(43,|, w1.5)
- **Row 3** (13): **Caps**(58, w1.75) a s d f g h j k l ;(39,:) '(40,") **Enter**(28, w2.25 — drawn as a `CornerDownLeft` icon at `size-[1.3em]`)
- **Row 4** (13): **Shift**(42, modifier, w2.25) z x c v b n m ,(51,<) .(52,>) /(53,?) ↑(103) Del(111)
- **Row 5** (7): **Ctrl**(29, w1.5) **Super**(125, w1.5) **Alt**(56, w1.5) **Space**(57, w6) ←(105) ↓(108) →(106)
- **EXTRA_KEYS** (10, behind "More keys"): `Ins(110) Home(102) PgUp(104) End(107) PgDn(109) PrtSc(99) ScrLk(70) Pause(119) Menu(127) NumLk(69)`

**Key look:** `rounded-md border bg-background font-medium tracking-tight tabular-nums select-none`, `active:bg-accent active:scale-95`, hover only under `@media(hover:hover)`. A latched modifier: `border-primary bg-primary/15 text-primary`. Keys fire on **pointerdown**, not click. Legend swaps to `shifted ?? legend.toUpperCase()` while Shift is held.

**Modifier semantics:** Normal mode latches for exactly one keypress; Combo mode (`stickyModifiers`, default on) keeps them until tapped off. Order: press modifiers in `["ctrl","alt","shift","super"]` order, then the key down/up, then release modifiers in reverse. Haptic `tap(8)` per press when enabled. `MODIFIER_CODES = { shift: 42, ctrl: 29, alt: 56, super: 125 }`.

### 4.2 Virtual mouse cluster — `/home/eins0fx/development/lwfa/packages/shell/src/mouse/MouseOverlay.tsx` + `lib/mouse.ts`

`absolute inset-0 select-none pointer-events-none` — the middle passes taps through to the window (that tap **is** the click). In edit mode the whole area becomes `pointer-events-auto bg-black/30` with a top hint pill `bg-black/60 px-3 py-1 text-xs text-white/80 backdrop-blur-sm` reading **"Drag the clusters to rearrange. Tap Done when finished."**

Three draggable clusters, positioned as percentages of the surface (`prefs.mouse.positions`), translated `-50% -50%`, each `pointer-events-auto absolute touch-none`; while editing they get `cursor-move rounded-xl p-2 ring-2 ring-primary/70`. Defaults:

| Cluster | Default position | Contents |
|---|---|---|
| `selector` | `x: 92, y: 50` | Vertical `gap-3` stack of three 44 px round buttons: **Left click** (`MousePointer2`), **Right click** (`MousePointerClick`), **Middle click** (`MousePointer`) |
| `tools` | `x: 8, y: 50` | Vertical `gap-3` stack: a **scroll strip** `h-24 w-9 rounded-full border-white/20 bg-black/45 backdrop-blur-sm` with a `size-4 rounded-full bg-white/50` dot; **"Back (side button)"** (`ChevronLeft`, evdev `0x113`); **"Forward (side button)"** (`ChevronRight`, evdev `0x114`); **"Drag lock"** (`Hand`); **"Hover (move without clicking)"** (`MousePointer2`) |
| `modifiers` | `x: 50, y: 90` | Horizontal `gap-2` row of `h-9 min-w-14 rounded-md` chips: **Ctrl** (29), **Shift** (42), **Alt** (56) |

Button styling: inactive `border-white/20 bg-black/45 text-white/80 backdrop-blur-sm`; active/latched `border-primary bg-primary text-primary-foreground`. Every one carries `HIT_AREA = "relative after:absolute after:-inset-2 after:content-['']"`. Drag clamps clusters to 4–96 %. Scroll is coalesced to one `requestAnimationFrame` send, multiplied by `scrollSpeed` and negated when `naturalScroll`. Opening the surface calls `resetMouseMode()`; closing releases any held modifiers.

### 4.3 Virtual gamepad — `/home/eins0fx/development/lwfa/packages/shell/src/gamepad/model.ts` + `gamepad/GamepadOverlay.tsx`

**Play area:** an outer `absolute inset-0 z-10 select-none` size container, and an inner `absolute inset-x-0 bottom-0` box whose height is `min(100cqh, (100/(16/9))cqw)` — i.e. never taller than 16:9, anchored to the bottom. Pads size themselves in `cqmin` of that inner box, so a portrait phone gets a controller-shaped band across the bottom holding the landscape arrangement.

**Pad geometry:** `left: clamp(size/2 cqmin, x%, calc(100% − size/2 cqmin))`, same for `top`, `width: {size}cqmin`, `aspectRatio: 1`, `transform: translate(-50%,-50%)`, `pointerEvents: auto`, `touchAction: none`. **The hit target is the full square; the visible circle is an inert inner span** — a deliberate fix so near misses don't fall through the rounded corners to the game.

**DEFAULT_LAYOUT** (x, y as % of the area; size as % of the shorter side):

| id | kind | face | x | y | size | keyboard fallback |
|---|---|---|---|---|---|---|
| `l2` | trigger | l2 | 8 | 9 | 13 | 42 (Shift) |
| `l1` | trigger | l1 | 8 | 23 | 13 | 29 (Ctrl) |
| `r2` | trigger | r2 | 92 | 9 | 13 | 18 (E) |
| `r1` | trigger | r1 | 92 | 23 | 13 | 33 (F) |
| `dpad` | dpad | dpad | 15 | 44 | 22 | `[103,106,108,105]` (↑→↓←) |
| `lstick` | stick | lstick | 18 | 78 | 22 | `[17,32,31,30]` (W D S A) |
| `north` | button | north | 86 | 40 | 12 | 19 (R) |
| `west` | button | west | 77 | 51 | 12 | 34 (G) |
| `east` | button | east | 94 | 51 | 12 | 48 (B) |
| `south` | button | south | 86 | 62 | 12 | 57 (Space) |
| `rstick` | stick | rstick | 80 | 82 | 22 | `[103,106,108,105]` |
| `l3` | button | l3 | 5 | 36 | 11 | 46 (C) |
| `r3` | button | r3 | 95 | 36 | 11 | 50 (M) |
| `select` | button | select | 42 | 12 | 9 | 15 (Tab) |
| `guide` | button | guide | 50 | 12 | 9 | 125 (Super) |
| `start` | button | start | 58 | 12 | 9 | 1 (Esc) |

`clampPad` keeps `x,y ∈ [3,97]` and `size ∈ [6,40]`.

**Skins (`SKIN_LABELS`):**
- `playstation`: north `△`, south `✕`, east `○`, west `□`, `L1 R1 L2 R2 L3 R3`, start `OPTIONS`, select `SHARE`, guide `PS`
- `xbox`: `Y A B X`, `LB RB LT RT LS RS`, start `MENU`, select `VIEW`, guide `XBOX`
- `neutral` (default): `N S E W`, `L1 R1 L2 R2 L3 R3`, start `START`, select `SELECT`, guide `HOME`

**Pad visuals:** the inner span is `border border-white/20 bg-black/50 text-white/90`, `rounded-full` (buttons/sticks) or `rounded-lg` (triggers and key pads, key pads also `px-1 leading-tight break-all`), `transition-transform group-active:scale-95 group-active:bg-white/25`, `overflow-hidden`. **Deliberately no backdrop blur.** D-pad is a 3×3 grid of segments — `border border-white/20 bg-black/50 text-[10px] text-white/80`, `active:bg-white/25`, arrows `▲ ◀ ▶ ▼`, corner segments blank, centre `border-white/10 bg-black/30`, each edge segment rounded on its outer side. Sticks: a `rounded-full border-white/20 bg-black/40` ring with a nub `size-[45%] rounded-full border-white/30 bg-white/25` moved by transform.

**Stick feel:** dead zone **5 %** in analog mode (25 % in keyboard mode), re-centre clamp `RECENTRE = 0.45` of the radius, response curve `shaped = linear·(1 − 0.55 + 0.55·linear)` (`EXPO = 0.55`), axis sends coalesced to one rAF and quantised at 1/64. Keyboard mode quantises to 8 directions at ±22.5°.

**Controller mapping:** `FACE_TO_BUTTON = { south:0, east:1, west:2, north:3, l1:4, r1:5, l2:6, r2:7, select:8, start:9, l3:10, r3:11, guide:16 }`; `DPAD_BUTTONS = [12,15,13,14]`; `TRIGGER_AXES = { l2:4, r2:5 }`; `STICK_AXES = { lstick:[0,1], rstick:[2,3] }`.

**Edit mode:** React Flow canvas with a dotted `Background` (`gap 24`, `size 1.5`, `opacity-60`), panning/zooming disabled so 1 px = 1 px. Pads become dashed nodes: `border-2 border-dashed border-primary/70 bg-primary/25 text-xs text-primary`, `rounded-full` (or `rounded-lg` for triggers), labelled `✛` for dpad, `◉` for stick. Bottom hint (no selection): **"Drag a control to move it. Tap one to resize."** With a selection, a floating bar `rounded-lg border bg-card/95 p-1 backdrop-blur-md` shows the pad id and `−` / `+` buttons (`size-8 rounded-md border`, ±16 px per press).

### 4.4 Arrange overview — `/home/eins0fx/development/lwfa/packages/shell/src/components/Desktop.tsx` + `ArrangeLayer.tsx` + `ArrangeBar.tsx`

Entering arrange mode closes any open panel (`ShellChrome`) and zooms the desktop out to the **whole strip's bounding box**, inset by `ARRANGE_INSET = 56` px on all sides, never upscaled past 1:1. The scene is one scaled element (`transform: translate(var(--ox),var(--oy)) scale(var(--fit))`, `origin-top-left`); the controls live **outside** it in screen pixels so they stay 44 px at any zoom.

Each window card: `pointer-events-auto absolute flex flex-col justify-between overflow-hidden rounded-xl ring-2`, ring `ring-primary` when focused else `ring-white/25`; a drop-highlighted card becomes `bg-primary/20 ring-primary`; a carried card gets `z-10 opacity-90` and `pointerEvents: none` so the release can hit-test what's beneath. Top band: `bg-gradient-to-b from-black/70 to-transparent p-1.5` with the title in a `rounded-md bg-black/50 px-2 py-1 text-xs text-white/90 backdrop-blur-sm` pill. Bottom band: `bg-gradient-to-t from-black/70 to-transparent p-1.5` with 44 px `Cap` buttons — `grid size-11 place-items-center rounded-lg border border-white/20 bg-black/60 text-white backdrop-blur-sm [&>svg]:size-5`, danger variants hover to `bg-destructive`. Caps: **Fullscreen** (`Maximize2`), **"Move up in column"** / **"Move down in column"** (`ChevronUp`/`ChevronDown`, only when stacked), **Close** (`X`, danger). A drop indicator renders as `absolute rounded-lg border-2 border-dashed border-primary bg-primary/20`. Drag threshold is 6 px; tapping a card focuses it and leaves arrange mode.

---

## 5. Icon set → SF Symbols mapping

The library is **lucide-react `^1.41.0`** (`/home/eins0fx/development/lwfa/packages/shell/package.json`). Rail icons are drawn at `strokeWidth 1.9`; most in-panel icons at lucide's default 2.

| Where | lucide name | Suggested SF Symbol |
|---|---|---|
| Nav · Session (`info`) | `Info` | `info.circle` |
| Nav · Connections | `Network` | `network` |
| Nav · Access | `Users` | `person.2` |
| Nav · Appearance (`theme`) | `SunMoon` | `circle.lefthalf.filled` |
| Nav · Settings | `Settings` | `gearshape` |
| Nav · Apps | `Grid3x3` | `square.grid.3x3` |
| Nav · Escape | *(glyph "ESC")* | text glyph "ESC", not a symbol |
| Nav · Gamepad | `Gamepad2` | `gamecontroller` |
| Nav · Mouse | `Mouse` | `computermouse` |
| Nav · Keyboard | `KeyboardIcon` | `keyboard` |
| Nav · Clipboard | `ClipboardList` | `list.clipboard` |
| Nav · Windows (`workspaces`) | `AppWindow` | `macwindow` |
| Group · Input | `SlidersHorizontal` | `slider.horizontal.3` |
| Group · More | `MoreHorizontal` | `ellipsis` |
| Panel close | `X` | `xmark` |
| Loading | `Loader2` (spin) | `ProgressView` |
| Theme Light / Dark / System | `Sun` / `Moon` / `Monitor` | `sun.max` / `moon` / `desktopcomputer` |
| Rail position Auto/L/T/R/B | `Wand2`, `PanelLeft`, `PanelTop`, `PanelRight`, `PanelBottom` | `wand.and.stars`, `sidebar.left`, `rectangle.topthird.inset.filled`, `sidebar.right`, `rectangle.bottomthird.inset.filled` |
| Buttons list reorder | `ArrowUp`, `ArrowDown` | `arrow.up`, `arrow.down` |
| Anchor toggle | `ArrowDownToLine` / `ArrowUpToLine` | `arrow.down.to.line` / `arrow.up.to.line` |
| Show/hide | `Eye` / `EyeOff` | `eye` / `eye.slash` |
| Reset | `RotateCcw` | `arrow.counterclockwise` |
| Refresh / reload | `RefreshCw` | `arrow.clockwise` |
| Sign out / disconnect | `LogOut` | `rectangle.portrait.and.arrow.right` |
| Placement Overlay / Stacked | `Layers` / `PanelBottom` | `square.stack.3d.up` / `rectangle.bottomthird.inset.filled` |
| Edit layout | `Pencil` | `pencil` |
| Add | `Plus` | `plus` |
| Delete / forget | `Trash2` | `trash` |
| Download / upload | `Download` / `Upload` | `arrow.down.circle` / `arrow.up.circle` |
| Copy / paste | `Copy` / `ClipboardPaste` | `doc.on.doc` / `doc.on.clipboard` |
| Send | `Send` | `paperplane` |
| Search | `Search` | `magnifyingglass` |
| Terminal badge | `TerminalSquare` | `terminal` |
| Confirm / done | `Check` | `checkmark` |
| Shield on/off | `Shield` / `ShieldOff` | `shield` / `shield.slash` |
| Dock gear | `Settings2` | `slider.horizontal.3` |
| Dock resize grip | `GripHorizontal` | `line.3.horizontal` |
| Immersive enter/exit | `Scan` / `LogOut` | `arrow.up.left.and.arrow.down.right` / `arrow.down.right.and.arrow.up.left` |
| Arrange windows | `LayoutGrid` | `square.grid.2x2` |
| Fullscreen / restore | `Maximize2` / `Minimize2` | `arrow.up.left.and.arrow.down.right` / `arrow.down.right.and.arrow.up.left` |
| Stack left / expel right | `ArrowLeftToLine` / `ArrowRightToLine` | `arrow.left.to.line` / `arrow.right.to.line` |
| Quit app | `Power` | `power` |
| Column marker / stacked child | `Columns2` / `CornerDownRight` | `rectangle.split.2x1` / `arrow.turn.down.right` |
| Live column | `MonitorPlay` | `play.rectangle` |
| Expand row | `ChevronDown` (rotates 180°) | `chevron.down` |
| Device kinds | `Tablet`, `Smartphone`, `Monitor` | `ipad`, `iphone`, `display` |
| Permissions | `ShieldCheck`, `Hand` | `checkmark.shield`, `hand.raised` |
| Mouse buttons | `MousePointer2`, `MousePointerClick`, `MousePointer` | `cursorarrow`, `cursorarrow.click`, `cursorarrow.rays` |
| Mouse side buttons | `ChevronLeft` / `ChevronRight` | `chevron.left` / `chevron.right` |
| Drag lock | `Hand` | `hand.draw` |
| Keyboard combo mode | `Zap` | `bolt` |
| Enter key | `CornerDownLeft` | `return` |
| Warnings / errors | `TriangleAlert`, `CircleAlert` | `exclamationmark.triangle`, `exclamationmark.circle` |
| File dialog | `Folder`, `FolderOpen`, `FileIcon`, `Home`, `FileQuestion` | `folder`, `folder.badge.plus`, `doc`, `house`, `doc.questionmark` |
| Clipboard kinds | `Image`, `FileIcon`, `Type`, `SquareDashed` | `photo`, `doc`, `textformat`, `rectangle.dashed` |
| Already-running dialog | `MonitorSmartphone` | `macbook.and.iphone` |

---

## 6. Motion

### 6.1 Window springs — `/home/eins0fx/development/lwfa/packages/shell/src/lib/motion.ts`

Windows are animated by an integrated spring, the **identical parameters the Rust engine uses** (`crates/lwfa-engine/src/layout.rs`), shared through `@lwfa/spring` and parity-tested:

```
WINDOW_SPRING = { stiffness: 1000, damping: 66, mass: 1 }   // generated/config.ts, from [animation] in configs/defaults.toml
```

That is a damping ratio of `66 / (2·√(1000·1)) ≈ 1.04` — critically damped, no overshoot. Four axes per window (`x`, `y`, `width`, `height`) each integrate independently. A redirect mid-flight carries the in-flight velocity (`velocityAt`) into the new spring. Arriving is arriving: if the integrated value passes the target in the direction of travel, it snaps (`tick()`), so a redirected move can never bounce off the target. One shared `requestAnimationFrame` loop samples `performance.now()` once and advances every window from that instant, so windows moving together cannot drift apart. Values are written as `transform` plus a size change on an absolutely positioned element — composited only, no layout. A window seen for the first time snaps rather than animating.

SwiftUI equivalent: `.spring(response:dampingFraction:)` won't reproduce this exactly — use `Animation.interpolatingSpring(mass: 1, stiffness: 1000, damping: 66, initialVelocity: v)` and drive position/size, matching the "never overshoot" clamp yourself if you redirect.

### 6.2 Durations and easing

| Thing | Value | Where |
|---|---|---|
| Panel sheet open | 500 ms, slide-in from edge + overlay fade | `components/ui/sheet.tsx` |
| Panel sheet close | 300 ms, slide-out + fade | same |
| Dialog open/close | 200 ms (`duration-200`), fade + `zoom-95` | `components/ui/dialog.tsx` |
| Tooltip | `fade-in-0 zoom-in-95` + 2 px slide from the trigger side; show delay **400 ms**, skip-delay **200 ms** | `components/ui/tooltip.tsx`, `ShellChrome` |
| Immersive FAB opacity/background | **160 ms ease** | `.immersive-fab` in `index.css` |
| Escape button flash | **180 ms** | `ShellChrome.select` |
| Progress bar fill | `transition-[width] duration-200` | Clipboard/FileDialog |
| Key press | `active:scale-95` + `transition-colors` (Tailwind default 150 ms) | `keyboard/Keyboard.tsx` |
| Gamepad pad press | `transition-transform group-active:scale-95` | `gamepad/GamepadOverlay.tsx` |
| Nav rail button | `transition-colors` | `NavRail` |
| Chevron rotation | `transition-transform` + `rotate-180` | `WindowsPanel` |
| Copy/"Copied" feedback | 1500 ms | Clipboard, Gamepad backup |
| "Controller restored." notice | 2500 ms | `GamepadPanel` |
| Viewport report debounce | 150 ms | `Desktop` |
| Audio diagnostics poll | 700 ms | `AudioReadout` |
| Busy spinners | `animate-spin` (1 s linear) | everywhere |
| Connecting status dot | `animate-pulse` (2 s) | `NavRail` |

Tailwind's default easing (`cubic-bezier(0.4, 0, 0.2, 1)`) applies unless stated; the FAB uses plain `ease`; Radix sheet/dialog use `ease-in-out`.

### 6.3 Reduced motion

Two independent gates, both honoured:

1. **OS setting** — `matchMedia("(prefers-reduced-motion: reduce)")`, read live by `Motion.reducedMotion`. When true, `Motion.set()` snaps every window instead of springing, regardless of preference. In CSS: `@media (prefers-reduced-motion: reduce)` disables the FAB transition (`.immersive-fab { transition: none }`) and all `.shell-panel` animation/transition.
2. **User preference** — `prefs.motion.animate` (Appearance → Motion → "Animate window movement", default **on**). This is a *separate* switch "for someone who wants motion in general and not here"; the OS setting is always obeyed on top of it.

There is no third reduced-motion path: spinners, pulses and colour transitions are left alone.

---

### Quick parity checklist for the SwiftUI port

- Ship Inter Variable and JetBrains Mono Variable in-bundle; never a font CDN.
- One accent only: `#E8552D` light / `#FB6B44` dark, with **ink** (`#0C0D10`) as its foreground.
- `#0C0D10` fills every inset and the area behind the window strip, in both themes.
- 44 pt minimum hit target everywhere, even where the drawn control is 18 pt or 32 pt.
- The panel is a non-modal side sheet starting after the rail, ≤ 480 pt wide (or ≤ 512 pt tall on a horizontal edge), with a 45 %-background scrim that does not eat touches.
- The rail measures itself and collapses through four fixed tiers, never scrolls before the floor, and never moves an anchored control out from under the thumb.
- The immersive FAB is the 28 pt mark inside a 48 pt ink circle at 45 % opacity, draggable, position persisted normalised, default top-right at 18 % height.
- Windows move on `stiffness 1000 / damping 66 / mass 1`, one clock, no overshoot on redirect.
