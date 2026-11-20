---
components: [src/DashboardBuilder/Features/Core/, src/DashboardBuilder/Features/Dashboard/, tests/js/]
---
# Design tokens

Every colour, size and depth value, with its light and dark values and its role. Look a token up here
before styling anything. Each is a CSS custom property in the `:root` block of `Features/Core/core.css`
(loaded before every feature stylesheet). **Use the variables — never hardcode a hex**
([golden rule 7](../../development/coding-standards.md#7-use-the-design-tokens--never-hardcode-a-hex)).

- The block defines the **light** theme; `:root[data-scheme="dark"]` overrides the colour and
  elevation tokens ([Light and dark](#light-and-dark)).
- Ink/background pairs are chosen for ≥ 4.5:1 (WCAG AA) in both themes.
- `tests/js/tokens.test.mjs` fails on a retired token, a hex outside `:root`, a dark block that stops
  redefining the surfaces, or a menu / popover / toast / dialog styled as glass.
- `tests/js/contrast.test.mjs` fails on any token text pair below 4.5:1 in either theme.

## Light and dark

The viewer picks **Light** (the default) or **Dark** in the Appearance card at the right end of the tab bar
([layout.md § Tab bar](layout.md#tab-bar)). The app does not read the OS setting. The choice is a
per-browser preference (`localStorage` `dashboardbuilder.scheme`), never saved in the workbook; a missing, unknown
or retired `"system"` value reads as Light ([D148](../../decisions/decisions-design.md#d148--the-appearance-card-has-no-system-mode)).

- **One switch:** `<html data-scheme="light|dark">` is the only thing the stylesheets key off. No
  stylesheet reads `prefers-color-scheme` (`tokens.test.mjs` enforces it). `color-scheme` follows the
  attribute, so native controls and scrollbars match.
- **No flash:** `Core/scheme-boot.js`, a classic script in `<head>`, sets the attribute before first paint.
  It repeats `normalizePref` from the pure `Core/scheme-model.js`; `tests/js/scheme.test.mjs` runs the
  boot script against it for every stored value. If storage is blocked, the choice is Light.
- **Runtime:** `Core/scheme.js` owns the attribute (`isDark()`, `schemePref()`, `setSchemePref()`). It
  never reads the OS. It emits `scheme:changed` on the bus when the
  painted scheme flips, and the workbook theme (`Core/theme.js`) and the active chart (`dashboards.js`)
  re-apply on it.
- **Specificity:** `:root[data-scheme="dark"]` outweighs a bare `:root`, so the opaque-glass fallbacks
  (`@supports not (backdrop-filter…)`, `prefers-reduced-transparency`) also list `:root[data-scheme]`.

Colours below are capped at HSL saturation 70 %.

## Surfaces & ink

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#efefec` | `#0b0b0c` | app background (under the wash) |
| `--surface` / `--surface-2` / `--surface-3` | `#ffffff` / `#f6f6f3` / `#ebebe7` | `#1a1b1d` / `#232426` / `#2e2f32` | cards, overlays and data / subtle fill / hover |
| `--ink` / `--ink-2` / `--ink-3` | `#1c1719` / `#423a3d` / `#6b6165` | `#f3eeef` / `#d8cfd2` / `#a89ea2` | primary / muted / caption text |
| `--line` / `--line-2` | `#ebe4e5` / `#d9cfd1` | `#2e282c` / `#42393e` | strokes |
| `--scrim` | `rgb(28 23 25 / .38)` | `rgb(0 0 0 / .55)` | dialog backdrop (plain dim, no blur) |

The neutrals are charcoal, almost colourless (ink `#141516` / `#ececea`, rules `#e3e3df` / `#2b2c2f`). The dark ground is deliberately darker than every surface on it (`#0b0b0c` under `#1a1b1d` cards and `#2e2f32` hover fills) so cards, shelves and buttons stand off the page. Captions (`--ink-3`) reach ≥ 5.1:1
on every surface in both themes.

`--wash` is `none`: the app background is flat `--bg`, with no ambient light or tint (it was three accent-coloured radial gradients until 2026-11-18). The token stays as the one place a background image would go; `body` and the dialog bodies read it. The glass chrome still blurs whatever is beneath it, which is now the flat colour.
on `--bg`. It is set as `background-color` + `background-image`, because a colour cannot sit in the
first layer of a multi-layer `background` shorthand; the whole declaration would be dropped.

## Glass

| Token | Light | Dark | Role |
|---|---|---|---|
| `--glass` | `rgb(255 255 255 / .72)` | `rgb(28 24 27 / .70)` | tint |
| `--glass-line` | `rgb(60 20 28 / .10)` | `rgb(255 170 180 / .10)` | 1px stroke |
| `--glass-rim` | `rgb(255 255 255 / .9)` | `rgb(255 190 198 / .08)` | inset top highlight (tinted, never pure white, in dark) |
| `--glass-blur` | `blur(20px) saturate(150%)` | same | backdrop filter |
| `--glass-ctl` | `rgb(255 255 255 / .80)` | `rgb(43 37 41 / .85)` | fill of a control on glass (tier 2) |
| `--glass-ctl-hover` | `#ffffff` | `rgb(58 60 64 / .96)` | its hover fill — brighter than `--glass-ctl` in both schemes; in light the hover edge `--lift-edge` (`buttons.css`) keeps solid white visible on near-white glass |
| `--ctl-edge` | `#8f8487` | `#7d7377` | outline of a control on glass — ≥ 3:1 against the panel and the control fill (WCAG 1.4.11) |

**Where glass is allowed — only where nothing but the wash is beneath it:**

- **Allowed:** the sidebar, the tab bar (`.canvas__bar`) and the worksheet header (`.ws-shelves`).
- **Never:** menus, popovers (Export, the context popup), toasts or dialogs. They float over content,
  and blurred text behind would read through the text on top.
- The tint stays ≥ 70 % so text on glass keeps AA contrast whatever the wash does beneath it.
- Without `backdrop-filter`, or under `prefers-reduced-transparency: reduce`, `--glass` becomes the
  opaque `--surface-2` and `--glass-ctl` the opaque `--surface`.

### Buttons have no border

`Core/buttons.css` (loaded last) removes the border of every button: `button`, `.btn`, `.iconbtn`,
`.tab`, `.tab-add`, `.ws-tool`, `[role=button|tab]`. (Radio cards are labels, not buttons, so they keep their border.) It uses `!important`, because
feature sheets set their own.

The fill carries the edge instead:

- `.btn`: `--btn-fill` at rest (8 % ink over `--surface`); `--btn-fill-hover` / `--btn-fill-active` are **brighter** — light 4 % / 2 % ink (the grey lifts toward white), dark 14 % / 20 % ink (more light ink) ([D134](../../decisions/decisions-buttons.md#d134--hover-and-pressed-are-brighter-than-rest-in-every-scheme));
- the glass tiers and the sidebar tools: `--btn-fill`-tinted frosted fills;
- a danger button: `--danger-bg`;
- a primary button: the accent.

Where the ≥ 3:1 edge rule below mentions a border, read it as "a fill that stands out from the glass".

### Button states

**No button or field has a `box-shadow`**, of any colour or in any state (`Core/buttons.css` forces it off). Panels, menus, dialogs and cards keep their elevation (see below).

Every button runs the same ladder (`Core/buttons.css`): **rest → hover** (brighter fill) **→ pressed** (brighter still, and it sinks: `translateY(1px)` for text buttons, `scale(.96)` for icon buttons) **→ focus** (the neutral wash) **→ disabled** (faded, `not-allowed`). "Brighter" means higher relative luminance in **both** schemes ([D134](../../decisions/decisions-buttons.md#d134--hover-and-pressed-are-brighter-than-rest-in-every-scheme)):

| Control | Light | Dark |
|---|---|---|
| `.btn` | `--btn-fill-hover` / `-active` (4 % / 2 % ink: grey lifts toward white) | 14 % / 20 % ink |
| `.btn--primary` | `--accent-hover` / `--accent-pressed`, the accent **lifted toward white** by 14 % / 28 % (`LIFT_HOVER` / `LIFT_PRESSED`, `theme-model.js`); text `--on-accent-hover` / `-pressed` | same lift |
| `.btn--danger`, `.iconbtn--danger` | `--danger-hover` / `-active` (toward `--surface`); a transparent danger icon button lifts to `--surface` with a `--danger-line` hairline | `--danger-ink` 16 % / 24 % over `--danger-bg` |
| transparent at rest (`.iconbtn`, `.btn--ghost`, `.ws-tool`, `.story-chip`, `.ws-select__btn`, `.ws-pages__btn`, `.ws-drill__crumb`, `.ws-pick__btn`, `.xt-toggle`, `.ws-titleblock__btn`, `.toast__close`) | solid `--lift` (= `--surface`; on glass `--glass-ctl-hover`, `#ffffff`) **plus a hairline `--lift-edge`** (`--ink-3`) — nothing is lighter than white, so the edge keeps the state off the surface | `--lift` / `--lift-active` (12 % / 18 % ink); no edge |
| `.tab`, `.tab-add`, `.sidebar__tool` (glass) | `--glass-ctl-hover` (`#ffffff`) + `--lift-edge` | `--glass-ctl-hover` (brighter than `--glass-ctl`) |

A selected or open control (`.is-active`, `.is-set`, `aria-selected` / `-pressed` / `-expanded`) keeps its own fill. List rows, menu items, cards and pickers are selection washes, not buttons with a fill of their own, so they keep `--surface-2` / `-3`. The pill, select and chip-clear icon buttons stay flat and turn accent.

- **Weight is the hierarchy:** the primary action is 600, every other `.btn` is 500.
- **Side padding:** a text `.btn` has 16px each side; with a leading icon, 8px on that side so the glyph sits level with the text above it.
- **`.btn--ghost`:** no fill at rest, a 1px outline for the edge (buttons have no border and no shadow), and the `.btn` fill on hover.
- **Reduced motion:** transitions and the pressed sink are switched off.

### Controls on glass — three tiers and a state ladder

Blur does not signal "clickable", so interactivity is carried by solidity, edge and feedback.

| Tier | What | Look |
|---|---|---|
| 1 · panel | sidebar, tab bar, worksheet header | `--glass` + `--glass-line` |
| 2 · control on glass | tabs, table chips, inputs / selects on glass | `--glass-ctl` + `--ctl-edge` border (no shadow on a button or field) |
| 3 · primary action | Connect, Apply | solid `--accent`, never glass |

Ghost controls on glass (`.ws-tool` encoding tools, `.iconbtn`) have no fill at rest; the icon + label
identify them. They become a tier-2 frosted pill on hover. Every state changes at least two of fill /
edge / shadow / ink / weight:

| State | Treatment |
|---|---|
| hover | `--glass-ctl-hover` (brighter), hairline edge `--lift-edge` in light (ghost: gains fill), icon turns accent |
| pressed | brighter still (never darker than hover), `scale(.96–.98)` or a 1px sink |
| selected (active tab, open tool, Format on) | `--accent-soft` fill + weight 600 (no accent shadow or underline on a button) |
| focus | a neutral wash (12 % `--ink`, 6 % on a text field) laid over the element's own fill — no ring, outline or border change |
| dragging (table chip) | `--accent` edge + `--elev-16`, grip shown |
| disabled | `opacity .5`, no shadow, `not-allowed`, no hover change |

Only `background`, `border-color`, `color` and `transform` transition (`--dur-fast`). The
blur is never animated.
`tests/js/contrast.test.mjs` pins `--ctl-edge` at ≥ 3:1 against the glass over the base and the strongest
wash tint, in both themes.

## Accent — one sage-lime

| Token | Light | Dark | Role |
|---|---|---|---|
| `--accent` / `-hover` / `-pressed` | `#566a17` / `#748541` / `#8c9a61` | `#a9bd6a` / `#b5c67f` / `#c1cf94` | primary fill; hover and pressed are **brighter** (lifted toward white). Text is `--on-accent` / `--on-accent-hover` / `--on-accent-pressed` — each ≥ 4.5:1 on its fill: white where it holds, else `#12130f` (the dark Signal lime always, and Signal's light hover / pressed; most dark presets and some light ones flip to dark text on hover / pressed, because a lighter fill outgrows white text). Active tab underline, selected relationship, single chart series |
| `--accent-ink` | `#566a17` | `#a9bd6a` | accent **text** |
| `--accent-soft` / `--accent-line` | `#f1f4e2` / `#d3dbae` | `#262a17` / `#4a5427` | tint / stroke |
| `--focus` | `--ink` | `--ink` | neutral focus colour (kept for outlines a feature may still draw by hand; `:focus-visible` outlines are forced off) |

Inputs on focus get the neutral wash and their caret; the border does not change. An invalid input uses
`--danger-solid` and always has its icon + message below.

### Workbook themes (P41)

P41 in the heading is the product phase ID for workbook themes. A workbook may carry a **theme**
(`{ accent, palette, surface? }`, the **Appearance** card) that overrides the accent set above and
`--chart-cat-1…8`, and may select a **look** (dark-mode surfaces).

- `Core/theme.js` sets the overrides inline on `:root` and re-applies them on `scheme:changed`. The
  default theme sets nothing.
- The values live in `Core/theme-model.js`, the second token source after `core.css :root`.

What a theme can change:

- **Accents:** Signal (the default, with the values above), Ultramarine, Monospace (violet on slate), Blue, Crimson, Teal, Violet and Graphite, each with
  light and dark sets; or a **custom** `#rrggbb`. Every set keeps:
  - white `--on-accent` ≥ 4.5:1 on the accent and hover;
  - `--accent-ink` ≥ 4.5:1 on the surface **and** on `--accent-soft`;
  - the accent ≥ 3:1 against the surface.

  This is unit-tested for every preset and for derived custom colours. A custom colour too light for
  white text is refused with the reason. In dark mode it is lifted until it stands 3:1 off the surface.
- **Palettes:** Default, **Colour-blind safe** (Okabe–Ito), Muted — eight distinct colours per scheme.
- **Look:** Default, or **One Dark Pro**. It is the one thing that changes surfaces, ink, status colours and glass,
  and only in dark mode: `Core/theme.js` sets `<html data-look="onedark">`, and `core.css`
  `:root[data-scheme="dark"][data-look="onedark"]` overrides the dark tokens. Picking it also picks the One Dark accent
  (`#456fc8`, text `#6aa8e0`) and chart colours (`#6aa8e0` `#98c379` `#c678dd` `#e5c07b` `#56b6c2` `#d19a66` `#abb2bf` `#d68fc0`);
  both stay changeable. Surfaces are `--bg #181a1f`, `--surface #21252b`, `--surface-2 #282c34`, `--surface-3 #2c313a`;
  ink `#d7dae0` / `#abb2bf` / `#9aa2af`; lines `#3e4451` / `#4b5263`. Blue is desaturated to `#6aa8e0` (rule: HSL S ≤ 70 %),
  and the same AA / 3:1 checks run on this block (`tests/js/contrast.test.mjs`). The default look is Signal on charcoal.
- A saved theme with no `surface` is the default look (older workbooks open unchanged).

`--print-paper` / `--print-ink` (`#ffffff` / `#000000`) are the print stylesheet's colours in every scheme.

## Status & field roles

Green = connected / success · amber = connecting / loading / notice · **vermilion = error or destructive**
· grey = idle. Status is always **icon + text + colour**
([golden rule 9](../../development/coding-standards.md#9-never-colour-alone)); that is what keeps danger apart
from the accent.

| Token group | Light (bg / ink / line) | Dark (bg / ink / line) | Meaning |
|---|---|---|---|
| `--ok-*` | `#edfcf3` / `#136945` / `#abefc6` | `#112a1d` / `#75e0a7` / `#1f5c3c` | connected, success |
| `--warn-*` | `#fbf5ea` / `#7e3d16` / `#edcf9b` | `#2d2210` / `#e9c080` / `#6a4a13` | connecting, loading, notices; drill breadcrumb |
| `--danger-*` | `#fcf3f1` / `#95221a` / `#f3c9be`, `--danger-solid` `#af491f` | `#341a14` / `#eeae9d` / `#7a3322`, solid `#e47f65` | failed, invalid, destructive |
| `--dim-*` | `#eef4fc` / `#205fb7` / `#bfd5f4` | `#172235` / `#9dbfee` / `#2c4a78` | dimension pills (blue) |
| `--meas-*` | `#e9f8f8` / `#13676d` / `#a6e3e6` | `#10292b` / `#6fdde3` / `#1d5a5e` | measure pills (teal) |
| `--enc-*` | `#f4f1fd` / `#5b2fc9` / `#d9d2f7` | `#231d3a` / `#cac0f4` / `#4b3c8a` | Marks-encoding pills (violet; an encoding tint, not a status) |

Dark status tints are opaque (not translucent) so their contrast is fixed. `--up` = `--ok-ink` and
`--down` = `--danger-ink` colour KPI deltas and sparklines.

## Chart tokens

`chart.js` reads these off `:root` at render, resolving one level of `var()`. It re-renders the active
chart on `scheme:changed` (a cache hit, no query), so charts follow light / dark. **Text wears ink tokens; only the
mark wears the series colour.**

| Token | Maps to | Role |
|---|---|---|
| `--chart-series` | `--accent` | a single data series (blue) |
| `--chart-axis` | `--line-2` | axis lines |
| `--chart-grid` | `--line` | value-axis gridlines |
| `--chart-label` | `--ink-2` | primary chart text |
| `--chart-muted` | `--ink-3` | tick labels |
| `--chart-div-low` / `--chart-div-high` | light `#d98a4a` / `#2b62b8`; dark `#e2b48c` / `#5a8ad6`; One Dark Pro `#e0b084` / `#5c9ddb` | diverging colour: warm below the centre, cool above (theme-stable; HSL S ≤ 70 %; the warm end is lighter than the cool end, so the pair also differs in lightness: simulated CIE L* gap light 27 / 15, dark 23 / 14 for deuteranopia / protanopia; One Dark Pro is the weakest at 17 / 8) |
| `--chart-div-amber` / `-violet` / `-green` | light `#b8803a` / `#6b52c9` / `#3f8f5a`; dark `#e0b060` / `#9b86e6` / `#6fc486`; One Dark Pro `#e5c07b` / `#c678dd` / `#98c379`; the hue pairs of Format → Diverging colours (never red) |
| `--chart-cat-1..8` | light `#72872a` `#b8559c` `#d9a03a` `#7c63d6` `#2f9ea8` `#3f7fd0` `#4aa66a` `#6a6d72`; dark `#a9bd6a` `#d98ac2` `#deb062` `#9b86e6` `#5cc0c8` `#7aa3dc` `#6fc486` `#8e9094` | categorical ramp, fixed order; no red slot — red means danger only ([D97](../../decisions/decisions-dashboards.md#d97--no-red-in-the-categorical-palette-and-a-calm-dark-accent)) |

- **One series** wears the accent. **≥2 series** (multiple measures, or a Colour split) draw
  `--chart-cat-*` in order, with a legend. Beyond 8 values the ramp repeats; the legend disambiguates.
- **Colour-by-category** (Format panel) colours a single-measure bar chart's bars from the same ramp.
- **Heatmap** and **continuous Colour** use a single-hue `--accent-soft` → `--accent` scale.
- **Treemap tile labels** pick black or white per tile with `Dashboard/contrast.js` (`pickInk`) so the
  label meets contrast on every `--chart-cat-*` fill.

## Type scale

Font (`--font`): `"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui,
sans-serif`, system fonts only. UI text is weight **400 / 600**. There are two content sizes and two title
sizes, and no ad-hoc sizes.

| Token | Size | Role |
|---|---|---|
| `--fs-title` | 24px | dashboard and worksheet titles, dialog titles |
| `--fs-lead` | 16px | lead text: the empty-worksheet hint (`.ws-hint--lead`, full-strength `--ink`, the one next action on an empty surface, centred under a dashed ghost chart) |
| `--fs-body` | 14px | everything else: body, rows, chips, captions, badges, chart text |
| `--fs-display` | 32px | KPI numbers |

## Spacing, radius, sizing

- Spacing: `--s1` 4 · `--s2` 8 · `--s4` 16 · `--s6` 24 — nothing between ([design rule 2](../../development/coding-standards.md#12-design-rules)).
- Radius: one `--r` 8px for every shape, inner or outer · `--r-pill` 999px.
- `--toast-h`: 42px (`16px + 24px + 2px`) — a one-line toast: its 8px padding twice, the 24px close button and the 1px border twice. Anything that must clear the toast (the Data Source guide pill) offsets by it.
- `--sidebar-w`: 330px default (resizable — [layout.md](layout.md#sidebar)).
- `--topbar-h`: 60px — the shared `min-height` of the sidebar brand (`.sidebar__brand`) and the tab bar
  (`.canvas__bar`), so their bottom borders form one continuous line ([layout.md](layout.md#tab-bar)).
- **`--ctl-h`: 32px** — the shared control height for inputs, selects, `.btn`, toolbar buttons, icon buttons, the brand mark and
  shelf drop zones, so a row of mixed controls aligns on one baseline.

## Elevation & focus

- **Elevation (indigo-tinted ramp).** Following Flat 2.0, shadows are soft and short, and there are no
  hover-lift transforms.
  - `--elev-card` / `--elev-card-hover` / `--card-rim`: Data Source cards (two-layer shadow + head
    highlight, light and dark).
  - `--elev-2`: other cards at rest.
  - `--elev-8`: hovered cards.
  - `--elev-16`: menus, popovers, toast and the card being dragged.
  - `--elev-28`: dialogs.
- **Glass:** see [Glass](#glass) — chrome only.
- **Focus:** no outline or border highlight on `:focus-visible` anywhere (`Core/buttons.css` forces it off). Keyboard focus is a
  neutral ink wash over the element's own fill, so a focused control is still visible in every theme.
- **Motion tokens** live with the motion rules: [motion-accessibility.md](motion-accessibility.md).
