---
components: [src/DashboardBuilder/Features/Core/core.css, src/DashboardBuilder/Features/Relations/relations.css, src/DashboardBuilder/Features/Shell/appearance.js, src/DashboardBuilder/Features/Shell/shell.css, src/DashboardBuilder/Features/Canvas/canvas.js]
---
# Decisions: design review outcomes

Visual-emphasis decisions that came out of reviewing a screen against a design standard. The design language itself is [D22](decisions-platform.md#d22--fluent-glass-design-language); the rules are in [design/index.md](../reference/design/index.md).

### D140 — The Data Source gives the next step the strongest mark: a card's ✕ rests muted and the key strip has no fill
A review against the 13 graphic design principles (2026-11-18) found the connected Data Source had no focal point: every card's ✕ was the same saturated red, every pinned key strip was a full-width olive fill, and the pending proposal was a 1px dashed pill, so nothing led.
- **How:** a card's ✕ (`.entity .iconbtn--danger`) rests in `--ink-3` like the ☰ and caret beside it and turns `--danger-ink` on hover and keyboard focus. The pinned key strip (`.entity__keys`) has no fill at rest: the rule beneath it, the accent name and its 600 weight mark a key, and the `--accent-soft` wash shows on hover and on the hovered link's rows. Dashboard widgets keep their always-red ✕.
- **Why:** red means danger (rule 7), not "the thing you can click most easily". Removing a card is rare, still asks twice (rule 12) and is named by the icon and its "Remove …" label; four always-red marks made danger the loudest thing on the canvas. A strip fill on every card repeated the proposal's accent.
- **Rejected:** a visible title above the canvas (design rule 6: the tab pill already names it); a key icon on each key row (a new icon and JS for what weight, colour and position already say); a new treatment for the proposal pill, because removing the competing marks was tried first (see [backlog](../development/backlog/data-source-hardening.md)).
- **Never colour alone:** the ✕ glyph and label carry the meaning at rest; a key is still told by position, weight and the rule, not only the accent.

### D142 — The relationship dialog says in words what the link does (no Relationships card)
The description of each relationship lived in a card at the Data Source's top right: first open over the canvas, then (this decision's first form) a corner button that opened a popover. It covered table cards or floated over them, and it was a second account of a link beside the dialog that edits it.
- **How:** the card, button and popover are gone. The relationship dialog's right panel opens with **What this link does** (`.rel-sum`): the plain sentences from `describeRelationship()`, rewritten after every pick (Join, Cardinality, Totals, Filters, key pairs) before anything is saved, above the data's Suggestion. A link is opened by clicking its line or badge (or a proposed link / the keyboard relate path), as before.
- **Why:** the sentences answer "what will this choice do" (an inner join's "Only rows with a match" is in no badge), which is a question asked while choosing, and the dialog is where the choosing happens. One place says it once; nothing sits over the cards at rest. The caution now ends with what to do ("Turn on Totals to count each once.") because the Totals control is beside it.
- **Trade-off:** the canvas no longer lists every relationship in words; to read one, open its dialog. The old popover was also the only text account of the links (the SVG links are click-only, so a screen-reader or keyboard user cannot list or open them: see "Edit and remove a relationship from the keyboard" in the [backlog](../development/backlog/data-source-hardening.md)).
- **Rejected:** the summary under the saved link only (it would describe the saved state while the controls show unsaved picks); a summary spanning the dialog above both panels (pushes the controls down).
- **Replaces:** the popover form of this decision and "open by default" in [relationships.md](../concepts/data-source/relationships.md#what-this-link-does-in-the-dialog). D141 was withdrawn before it landed and is not reused.

### D145 — Edit SQL's code uses three hues and the verdict's colours stay the verdict's
Strings were green (`--ok-ink`) and quoted names amber (`--warn-ink`), the same colours as "Valid query" and a warning, so a line of ordinary code read like a status. Syntax now uses keywords purple (bold), types teal and literals (strings, numbers, `true` / `false` / `null`) blue; names stay plain ink, comments muted italic.
- **Also:** the "ClickHouse SQL that will run" box, a permanent row in MySQL syntax that few people open, became a **ClickHouse SQL** toggle at the right of the verdict row (28 px tall for the pointer); the translated query still opens below the warnings, and by itself when ClickHouse refuses the translation. One chrome row instead of two in the idle dialog.
- **Why:** colour that means something (ok, warn, danger) should mean it everywhere on the screen; the verdict is the thing the eye is checking.
- **Rejected:** a monochrome editor (strings and names would blur together); keeping the box and only shortening its label (the row stays in the way).

### D146 — One Appearance card replaces the mode menu and the theme dialog
The tab bar had two icons for one idea: **Appearance** (a three-row menu for System / Light / Dark) and **Colour theme** (a modal dialog with three long-titled groups, a Done button and a Reset button). They were two different cards, one for each half of "how this looks".
- **How:** one **Appearance** button opens one card on the menu surface. Mode is a segmented row at the top (Light / Dark; D148); Dark look, Accent and Chart colours follow as short headings (the long legends are gone); **Reset theme** closes it. Accents are 24px swatches whose chosen one carries a tick, and the heading names it. Looks and palettes are menu rows with a colour strip and the tick. Picking applies at once and the card stays open (`wireMenu(…, { stayOpen: true })`); Esc, an outside click or Tab closes it. The Colour theme button, its dialog (`Workbook/theme-dialog.js`) and the Done button are removed.
- **Why:** a choice that applies live needs no confirmation step, so the modal (and its interruption and protected focus) bought nothing; both halves are the same task, so they share one door and one card style.
- **Trade-off:** the card is about 520px tall, so it scrolls inside on a window shorter than that. Accent names live in a tooltip and the heading's value, not beside each swatch.
- **Rejected:** keeping two buttons and only restyling the dialog as a popover (two doors for one task); a row per accent (nine more rows, a card taller than most windows).
- **Replaces:** the Settings → Theme… / Colour theme dialog in [workbook.md](../concepts/workbook/workbook.md) and the System / Light / Dark-only menu.

### D147 — The Data Source's zoom pill is one Fit button
A pill at the ground's top right held Zoom out (−), a percentage readout, Zoom in (+) and Fit all cards. It floated over cards, and three of its four parts repeated what the ground already does.
- **How:** the pill is gone. One **Fit all cards** icon button stays at the same spot (`.canvas__fit`); zoom is the wheel on empty ground and `+` / `-` / `0` on the focused ground, and `F` fits.
- **Why:** the wheel is the natural zoom and the buttons only zoomed about the centre; nothing needs the percentage (zoom is not saved, links and badges do not scale). Fit is the one action with no pointer-only equivalent, so a pointer user who has panned away keeps a visible way back to every card.
- **Trade-off:** a trackpad or mouse user who wants a one-step zoom has the wheel only; the keys are not shown on screen (an `sr-only` line describes them).
- **Rejected:** removing Fit as well (no visible way back); keeping the readout without the buttons (a number nobody acts on).

### D148 — The Appearance card has no System mode
Mode had three choices, and System (the default) followed the OS `prefers-color-scheme` and re-painted when the OS flipped. A third segment for "no choice" made the row wider than the question it asks.
- **How:** the mode is **Light** or **Dark**, two segments. Light is the default. The OS setting is not read anywhere: no `matchMedia` in `Core/scheme.js` or `Core/scheme-boot.js`, no `monitor` icon. A stored `"system"` (or any unknown value) reads as Light, so a browser that had System stays usable and lands on Light until its viewer picks. Live tests switch scheme through the card's own rows (`tests/live/cdp.mjs` `setScheme`), not by emulating the OS.
- **Why:** one explicit choice is easier to explain and to test than a third state that depends on a setting outside the app, and the page no longer changes by itself while it is open.
- **Trade-off:** a viewer whose OS is dark starts on Light the first time and has to pick Dark once (it is then remembered in that browser).
- **Rejected:** keeping System but hiding it (a state that still exists but cannot be chosen); defaulting to the OS's value once at first load and never again (still reads the OS, and a first paint that differs by machine is harder to test).
- **Replaces:** the System default in [tokens.md § Light and dark](../reference/design/tokens.md#light-and-dark) and the three-choice toggle in [D22](decisions-platform.md#d22--fluent-glass-design-language).

### D149 — Appearance and Fit sit in a bottom-right dock
Appearance was the right-most icon of the tab bar and Fit all cards floated at the Data Source's top right: two global controls in two corners, one of them over the cards.
- **How:** both live in one column at the canvas's bottom right (`#canvas-dock`, `.canvas__dock`): Appearance on top, Fit all cards under it, 16px from the edges and 8px apart, solid with a hairline edge. The Appearance card opens upward. The bar keeps only the tabs and the workbook text; the activity chip moves left of the dock; the dock rises above the data preview panel.
- **Why:** the corner is quiet on every tab, so the controls are in one known place whatever the view, and the top-right corner is left to the content. Fit stays visible because it has no pointer-only equivalent ([D147](#d147--the-data-sources-zoom-pill-is-one-fit-button)).
- **Trade-off:** the dock floats over the bottom-right 32px × 72px of every view (a chart, a dashboard, a story); a card or chart edge can sit under it.
- **Rejected:** keeping Appearance in the bar and moving only Fit (two corners again); a dock that hides until hover (a control with no visible door).
- **Replaced by:** [D151](#d151--appearance-and-settings-sit-in-the-sidebar-foot-fit-moves-to-the-tab-bar) (the dock is gone).
- **Replaces:** the bar-end placement in [D146](#d146--one-appearance-card-replaces-the-mode-menu-and-the-theme-dialog) and the top-right Fit in D147.

### D151 — Appearance and Settings sit in the sidebar foot; Fit moves to the tab bar
The dock of [D149](#d149--appearance-and-fit-sit-in-a-bottom-right-dock) floated three buttons over the bottom-right of every view. It could cover a chart corner or the last card, pushed the activity chip aside and had to ride above the data preview panel.
- **How:** Appearance and Settings are two 40px sidebar tool tiles in `#sidebar-foot`, a child of the sidebar after the body (so it stays on the collapsed rail and on the worksheet, dashboard, story and disconnected rails): a row on the 16px gutter on the wide sidebar, a centred column on a rail. The Appearance card opens upward from its tile over the canvas. **Fit all cards** is the tab bar's right-most control, on the Data Source tab only. The dock, its data-preview lift and the activity chip's offset are gone.
- **Why:** both tiles are app-wide, so they sit with the brand and connection controls, in the same place on every tab and never over data. Fit acts on the Data Source's cards, so it sits with the canvas's own bar, and no longer shows (and does nothing visible) on other tabs.
- **Trade-off:** the Appearance card, opened from the sidebar, covers the table list while it is open; on a rail the two tiles are 40px glass tiles beside the 40px Performance tile, not the 32px solid buttons of the dock. `.sidebar` is raised to z-index 4 so the card paints over the canvas.
- **Rejected:** one cluster at the top right of the tab bar (the bar grows when tabs wrap, and the cluster competes with the tabs); a row at the canvas's bottom left (still floats over content).
- **Replaces:** [D149](#d149--appearance-and-fit-sit-in-a-bottom-right-dock), including the Settings tile that joined its dock with [D150](decisions-workbook-backup.md); the Settings button's id `settings-dock-btn` is kept for stability.
