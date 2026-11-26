---
components: [src/DashboardBuilder/Features/Core/motion.js]
---
# Motion & accessibility

How the app animates and the accessibility rules every UI change must keep. Read it before adding a
transition, a control or a status display.

## Motion

Interaction is calm: short, purposeful transitions, nothing decorative. The style follows Fluent
(WinUI 83/167/250ms steps; "fast out, slow in" for things arriving).

- **Entrances decelerate; exits accelerate and run quicker.**
- Durations stay within 100–300ms; past ~400ms feels slow.
- **Only `opacity` / `transform` animate.** These are compositor-only; never animate
  width/height/top/left. One deliberate exception: the dialog **morph** below also animates `clip-path`
  (paint-only, no layout), because a clip window reveals the dialog without stretching its text.
- Motion marks what changed. It never replays on routine re-renders.

Tokens:

- Durations: `--dur-exit` 100ms, `--dur-fast` 150ms, `--dur` 200ms, `--dur-slow` 250ms.
- Easing: `--ease` `cubic-bezier(.33,0,.67,1)` (standard), `--ease-out` `cubic-bezier(.1,.9,.2,1)`
  (entrances), `--ease-in` `cubic-bezier(.5,0,.75,0)` (exits).

JS-driven motion goes through `Core/motion.js` (`enter` / `exit`, same values; `morphIn` / `morphOut` for a modal growing out of its trigger: 300ms in on `easeMorph` `cubic-bezier(.2,0,0,1)`, 200ms out on `easeMorphOut` `cubic-bezier(.3,0,.8,.15)` — a morph covers distance, so `--ease-out`, which has arrived by 15% of its time, would read as a pop; JS-only, so no CSS token). Use it for what CSS
can't do: animating into `hidden`, or animating only the *first* appearance of something re-rendered
on every edit.

| Where | Motion |
|---|---|
| Switching tabs | the incoming view fades in and rises 4px (`--dur`); also between two dashboards |
| Menus | open: scale 97%→100% + fade from the button's corner (`--dur-fast`); close: fade out (`--dur-exit`) |
| Tool panel, Format card | slide down 4px + fade, only when opened |
| Pills | a newly added pill rises in; existing pills and dashboard switches don't animate |
| Chart | fresh data from ClickHouse: ECharts entrance 300ms `cubicOut` (not its 1s default); a re-render from the cache (format tweaks, theme flip) has no animation. Table/KPI fade in |
| Loading / notice | "Loading…" fades in after 150ms (no flash on fast queries); the result notice fades in |
| Disconnect | cards and dashboard tabs fade out (`--dur-exit`) before the workspace clears |
| Entity cards | rise in on drop; **removing** one (after the confirm) takes it out of the model at once, then it is `inert` and fades out with a 4px drop and 98 % scale (`--dur-exit`) before it leaves the DOM; collapse by animating `max-height`; no hover lift |
| Toasts / dialogs | toasts slide up from the bottom centre; dialogs scale in over a dimming scrim |
| Status | the loading pill glyph spins |
| Loading bar | a 4px indeterminate strip across the top (`.app-loading`) while the first connection answer is pending after a load: fades in after 200ms (a quick answer shows nothing), a 40% segment slides across (`translateX`, 1.2s loop); `role="progressbar"`, still and at 40% under reduced motion |
| Activity chip | any in-flight API request: appears after 300ms (rises 8px, `--dur`), its refresh glyph spins, the elapsed time ticks each second; gone when the last request ends |
| Column profile | **opens by morphing out of the Profile button** and folds back into it on close (`morphIn` / `morphOut`, below); then "Reading every row…" fades in after 150ms with a spinning refresh glyph; the result's cells rise 8px in turn (40ms apart), then each band's tint grows from the left (`scaleX`, 20ms apart, 250ms) |
| Dialog morph (column profile) | the dialog is revealed through a **clip window** that starts as the trigger's size, centred in the dialog, while the dialog itself starts centred on the trigger; both ease to rest together (`transform` + `clip-path`, 300ms), and head / body / foot fade in behind it (180ms, after 75ms). Close: the content fades out (100ms), then the bare surface folds into the button (200ms) as the scrim fades. The window reveals, it never scales, so text is never stretched. The dialog's own `dialog-in` entrance is switched off for it; `will-change` holds only for the length of the animation. Skipped (the plain entrance, instant close) under `prefers-reduced-motion`, with no usable trigger box, or when the trigger has left the page; a second Escape / Close during the fold-back is ignored |
| New relationship | a link the user just made **arrives once** ([relationships.md § Rendering](../../concepts/data-source/relationships.md#rendering)): the line fades in (`--dur`), its two end shapes settle from 60 % (`--dur-fast`, 100ms in), then the badge rises 4px (`--dur`, 150ms in); about 400ms. Only `opacity` / `transform`, each on the *inner* shape, never on the link group (that carries the focus fade). A redraw inside the window resumes the run; links restored from a workbook and every later redraw (zoom, drag, resize) never animate |
| Data preview panel | opens with the view fade (`--dur`); **closing** drops it 8px and fades it (`--dur-exit`, `inert` meanwhile) before the ground takes its height back; reopening during the exit keeps the panel (latest wins) |
| Relationship links | hovering a link or a card with links fades the links it doesn't touch to 20 % (`opacity`, `--dur`); with quiet badges a resting badge fades in on hover ([relationships.md](../../concepts/data-source/relationships.md#rendering)) |
| Controls | colour / border transitions on hover (`--dur-fast`); a picker's caret flips while its menu is open; a Marks flyout's field slot darkens its dashed edge (the Drop Field Here row's before a drop, the pills' zone's after) and fills the empty row with `--surface-2` on hover |
| Pages shelf | autoplay steps every 1.5s by default; the Pages flyout's Speed sets 3s, 1.5s or 0.8s (disabled under reduced motion, where Play is hidden) |

**All of it is gated by `prefers-reduced-motion: reduce`.** The CSS media query zeroes every duration,
and `Core/motion.js` and the chart's motion option skip their animations. Under reduced motion the
Pages **Play** control is omitted; stepping still works. Motion is an enhancement, never required to
understand state.

## Accessibility posture

- **Never colour alone** ([golden rule 9](../../development/coding-standards.md#9-never-colour-alone)):
  - status carries an icon + label + colour;
  - ≥2 chart series get a legend;
  - cardinality is shape-coded (tick vs. crow's foot);
  - Shape encodings give a second, non-colour channel;
  - an invalid pill has a dashed border **and** a warning icon and tooltip.
- **Icon-only buttons** carry an `aria-label` **and** a `title` (the same words). `Core/hover-tip.js` shows that `title` in one styled tip (`.hover-tip`, solid inverse ink-on-surface, in the top layer so it also draws over a modal dialog): after the pointer rests 400ms (at once when another tip is up or hid under 300ms ago, so a sweep along a toolbar reads straight through), and **at once on keyboard focus** (`:focus-visible` only). It hides on leave, press, scroll, Esc and window blur; touch shows none; it flips above near the bottom edge and keeps 8px inside the window (`Core/hover-tip-model.js`). While a button is armed its `title` is held back so the browser's own tooltip never doubles it, and put back when the tip hides. A **disabled** button keeps its native title (it gets no pointer events, and the title says why). No visible text labels on icons: design rule 6.
- **Forms:** an invalid field gets `aria-invalid="true"` and an inline message (`.field-error`: warning
  icon + text) linked by `aria-describedby`, cleared on the next edit. Applying is blocked and focus
  moves to the first invalid field (`ui.fieldError`).
- **ARIA:**
  - `aria-current` on the active tab;
  - `aria-label`s on every icon-only button (remove entity, close tab, disconnect, view-bar tools);
  - menus are `aria-haspopup="menu"` + `aria-expanded` with `role="menuitem"` items
    (`menuitemradio` + `aria-checked` for the chart-type and sort pickers);
  - resize handles are `role="separator"` with `aria-valuenow/min/max`;
  - `aria-pressed` on toggle buttons;
  - accessible names on the aggregation and filter-operator selects, and on each picker button
    ("Chart type: Bar", "Sort: customers.name, ascending").
- **Live regions:** one persistent visually-hidden `#toast-live` announces every toast, because a
  `hidden` container is never announced. Connection and save failures arrive as toasts. Danger toasts
  stay until dismissed; others close after 5 s.
- **Keyboard / non-drag paths:**
  - a `＋` on each table chip adds it to the canvas;
  - relationships: `Enter` on a focused column row picks it, `Enter` on a row of another card relates them (`↑` `↓` `Home` `End` within a card, `]` `[` between cards, `Esc` cancels) ([relationships.md](../../concepts/data-source/relationships.md#drawing-a-link--keyboard));
  - a `＋` on each field adds it to a shelf;
  - `F2` / `Enter` renames a tab;
  - `←`/`→` on a focused resize handle resizes the sidebar or field pane;
  - menus open on click and move with `ArrowUp` / `ArrowDown`; `Esc` closes and returns focus;
  - `Esc` clears the table search.
- **Contrast** is ≥ 4.5:1 for every ink/background pair in both themes (ratios in [tokens.md](tokens.md)).
- **Native `<dialog>`** for focus trapping and `Esc`-to-close.
