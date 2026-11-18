---
components: [src/DashboardBuilder/Features/Core/buttons.css, src/DashboardBuilder/Features/Core/core.css, src/DashboardBuilder/Features/Core/theme-model.js, tests/js/contrast.test.mjs, tests/live/button-states-ui.mjs]
---
# Decisions — buttons

D134. Edit an entry in place when it changes. The lookup for every decision is in [README.md](README.md#where-each-decision-lives).

### D134 — Hover and pressed are brighter than rest, in every scheme
Every button's hover is brighter than its rest state, and pressed is brighter still, in light and dark. This reverses the earlier "deeper fill, deeper still" ladder.
- **Brighter = higher relative luminance.** Dark: `--ink` is light, so more ink is brighter (unchanged for neutral buttons). Light: `--ink` is dark, so *less* ink is brighter; `.btn` lifts from 8 % grey toward white. Tokens: `--btn-fill-hover` / `-active`, `--lift` / `--lift-active`, `--danger-hover` / `-active` (`Core/buttons.css`, a `:root` and a `:root[data-scheme="dark"]` block).
- **Primary buttons:** `--accent-hover` / `--accent-pressed` are the accent lifted 14 % / 28 % toward white, derived in `theme-model.js` (presets and custom colours alike — no hand-set hex). A lighter fill can outgrow white text, so each state carries its own text colour, `--on-accent-hover` / `--on-accent-pressed`: white where it holds ≥ 4.5:1, else dark `#12130f`; in the mid-tones where neither holds the lift goes on (brighter still) until one does.
- **Light scheme, nothing lighter than white:** a control that rests transparent on a white surface cannot get brighter, so it lifts to a solid fill and gains a hairline (`--lift-edge`). Rule: no hover or pressed state is identical to the surface under it. This reverses the old `--glass-ctl-hover` note that white on near-white glass "would not show"; the edge is what makes it show.
- **Rejected:** capping the lift so white text stays legible (hover would be near-invisible on seven of nine dark presets); an accent-tinted hover (changes every button's look, not just its lightness); loosening the 4.5:1 contrast rule for hover text.
- **Not changed:** list rows, menu items, cards and pickers (selection washes), selected / open states, and the pill / select / chip-clear icon buttons (flat, turn accent).
- **Pinned by:** `tests/js/contrast.test.mjs` and `tests/js/theme-model.test.mjs` (text contrast on hover and pressed; accent < hover < pressed in brightness) and `tests/live/button-states-ui.mjs` (computed styles under a real pointer: rest < hover ≤ pressed, and a visible hover, in light / dark × Signal / Blue).
