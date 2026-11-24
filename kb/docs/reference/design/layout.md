---
components: [src/DashboardBuilder/Features/Board/board-layout.js, src/DashboardBuilder/Features/Core/menu.js, src/DashboardBuilder/Features/Core/ui.js, src/DashboardBuilder/Features/Dashboard/dashboards.js, src/DashboardBuilder/Features/Shell/perf-panel.js, src/DashboardBuilder/Features/Shell/appearance.js, src/DashboardBuilder/Features/Shell/sidebar.js]
---
# Layout rules

How the one page is laid out, what scrolls where, and how elements align. Read it before changing
any region's size, spacing or position. Regions and their behaviour are in
[features/](../../concepts/worksheet/worksheet.md); tokens in [tokens.md](tokens.md).

## The fixed shell

- `html, body { height: 100%; overflow: hidden }` — **the page never scrolls**
  ([golden rule 8](../../development/coding-standards.md#8-keep-the-shell-fixed-scroll-inside-panels)).
- The shell is a full-screen grid: **glass sidebar** (`var(--sidebar-w)`) + **content area**. Both sit
  over the body's flat `--bg` (`--wash` is `none`). Chrome is glass; data
  surfaces (entity cards, chart area, crosstab, field list) are solid `--surface`.
- Scrolling happens **inside regions**: the sidebar's table list, each entity card's column list, the
  worksheet field pane and the chart area. Every scroller in the app shares one scrollbar: a 10px lane, no arrow buttons, a pill thumb in `--line-2`
  (accent on hover; the sidebar's table list uses muted ink on its glass). One universal rule in `core.css`
  (`*::-webkit-scrollbar…`, plus the custom select's `::picker(select)`) draws it for Chrome and Safari, so a new
  scroller needs no scrollbar CSS and feature stylesheets set none. `scrollbar-width` / `scrollbar-color` are set
  only where those rules are unsupported (`@supports not selector(::-webkit-scrollbar)`, Firefox), because Chrome
  would otherwise ignore the rules and show its native arrows.

## Alignment grid

Related items share one edge, measured on what the eye sees (glyphs and text), not on hit boxes.

- **One 16px gutter (`--s4`) everywhere.** It applies to the sidebar brand row and sections,
  `.canvas__bar`, `.view` padding, the worksheet field pane (`--ws-fields-w`, default 236px; `--s2 --s4`
  padding), `.ws-shelves` and the `.ws-chart-card` margin.
  - On the left, the tabs' edge, the first entity card and the field-pane rows line up.
  - On the right, the appearance toggle, the shelves and the chart card line up.
  - `+`-placed entity cards start on the gutter
    ([canvas.md](../../concepts/data-source/canvas.md#dragging-a-table-onto-the-canvas)).
- **Full-width lists align with their siblings.** `.table-list` keeps 2px shadow room with a matching
  `-4px` inline margin (equal to its padding), so table chips share the search box's edges.
  - A chip is a flat 32px row: no border or shadow, and an ink wash on hover / focus. It is
    `flex: none`, so a long list scrolls instead of squeezing every row to its text height (which
    pushed the icon, name and the absolutely placed buttons out of line).
  - Its table icon sits on the 8px left gutter. The hover grip overlays the icon.
  - The preview and `+` buttons overlay the row's right end on hover / focus instead of reserving space.
- **Entity cards** are measured on ink, not boxes (checked on the Data Source with the glyph's drawn
  bounds):
  - **One 16px gutter (`--s4`) on both sides**, so the space left of the content equals the space right
    of it. The head's title, the column names and a source card's note start on it. The type text, the
    head's ✕ ink and the pinned strip's type text end on it. A union / unpivot card uses the same lanes.
  - Head order: title, **Needs a partner** while shown, ☰ (the card's actions menu), caret, ✕. The caret sits just left of the ✕, and the title takes the left gutter; the card's width counts every part that shows. The ✕
    is pulled out by its 12px slack (`margin-right: -(--s2 + --s1)`) so its ink ends on the gutter. The
    glyph is a 16px box in a 32px button, with strokes 4px inside.
  - The scrolling list reserves its scrollbar (`scrollbar-gutter: stable`) and its rows give up that
    much right padding. The width is measured, not assumed (`--sb-w` on the canvas, from a hidden probe
    list; 0 for an overlay scrollbar), so a thin, classic or overlay scrollbar all end the type text on the gutter. The type text therefore ends on the same line whether or not the list overflows.
  - Vertical: caret, title, name and type text all share one optical centre (the cap-height midpoint of
    the 14px text) within 0.5px. The first and last rows sit 4px inside the list's top and bottom edges.
    A failed card's status line uses the same 16px gutter.
- **Nothing touches.**
  - Menu lists (`.menu__list`, including the two-column chart picker) have a 4px gap between items and size to their content (`width: max-content`, capped to the window), so an item never wraps.
  - Stacked `<details>` field rows are spaced 4px apart (`.ws-group > :not(summary) + *`).
  - Single-choice `<select>`s show a chevron on the 16px gutter instead of the UA arrow; pill selects
    keep the native one.
- **The field pane's table cards scroll first; the pane only when there are too many tables.** `#ws-fields` is `overflow-y: auto` (`overflow-x: hidden`) — it scrolls only when the cards' two-row minimums together exceed it; each `details.ws-fieldset` is as tall as its visible fields and, when they don't all fit, the cards that need less keep their full height while the taller ones share what is left equally (`flex: 1 1 0` capped at `max-content` — hiding fields from one table never makes its card scroll while another still has spare room); never under header + two rows and scrolls inside itself with a sticky header (the card has no top padding — the header carries its 4px — so scrolled rows never show above the title) (a collapsed card, or one with every field hidden, is just its header — the two-row minimum applies only while it shows fields), and an open Marks card is capped at 45 % of the pane. A context popup opened over a modal dialog lives inside it (`popover`), so it draws above the dialog.
- **Icon-button rows use an 8px gap**, in the worksheet view bar and the dashboard bar alike. The field pane's rhythm is 8px too: Marks grid, search box and first table are 8px apart, and a 1px `--line-2` divider (16px below Marks) plus the **Fields** title separate the Marks section from the search + tables section (`.ws-fieldtools` keeps 4px of padding for its sticky background and takes it back with a `-4px` block margin, so the net gap is 8px, not 12px).
- **Ghost icon buttons at a row's end overhang by their 8px glyph slack** (`margin-inline: -8px`), so
  the glyph meets the edge. This applies to `#sidebar-toggle`, the appearance toggle (`.scheme`), the
  view bar's chart picker and last icon button, the tool-panel ✕, and both `.entity__head` buttons (the
  caret and ✕ in the head's right end). Reset the overhang wherever the button is centred (collapsed rail).
- **Checkboxes carry no UA margin** (`.form-check input`: 14px, `margin: 0`). A sub-option
  (`.form-check--sub`, `.form-warn`) indents by checkbox + gap, i.e. to its parent's label text.
  `.entity__title` is padded so it starts at the column-name x.
- **Buttons centre their label** (`.btn { justify-content: center }`), including stretched ones.

## Sidebar

- **Resizable:** a right-edge handle (`.sidebar__resizer`, `Shell/sidebar.js`) drags `--sidebar-w`
  (**330px** by default; it shows in full only on the connected Data Source tab, the other tabs use the rail) between a minimum and **30% of the viewport**. The shared `.resizer` shows its 2px `--accent` line on
  hover, focus, or while that handle is dragged (`.resizer.is-active`, set by `Core/resizer.js`) — never
  from `body.is-resizing` alone, which the data preview's column grips also set.
- **Collapsible:** the toggle at the right of the brand row (`#sidebar-toggle`, `sidebar` icon) collapses
  the sidebar to a **rail `--topbar-h` wide** holding only that button (`.app.is-sidebar-collapsed`).
  - The Connection/Schema body (`#sidebar-body`) and the resizer get `hidden`.
  - `aria-expanded` and the label ("Collapse sidebar" / "Expand sidebar") follow the state.
  - The chosen width survives a collapse. The state is remembered in this browser (`localStorage`
    `dashboardbuilder.sidebar.collapsed`, read/write wrapped in `try`).
  - Anything that focuses a sidebar control first calls `expandSidebar()`; the canvas empty-state
    button does.
- **The body follows the tab.** `Shell/sidebar.js` sets `.app[data-view="model"|"sheet"|"board"]` from
  `view:changed`.
  - **Data Source:** the full sidebar, with connection, database and tables — while connected. Disconnected (`.app[data-disconnected]`, set by `connection.js`), it is the dashboard's brand-only rail: the connect form is on the start card ([connection.md](../../concepts/data-source/connection.md#while-disconnected)). Until the first connection answer after a load it is that same rail (`.app[data-connecting]`), so it never flashes wide then narrows.
  - **Worksheet and dashboard:** the sidebar shrinks to a `--topbar-h` rail that holds the brand mark.
    The brand name, toggle, resizer and the connection / database / tables are `display: none`.
  - On a **worksheet** the rail also carries the tool icons in one column, 1 × N (`#ws-tools`,
    `.sidebar__tool`, 40px, filled by `dashboards.js`). They use the frosted control tier: `--ctl-edge`
    ≥ 3:1 border, full-ink icon, accent on hover. The tools are **Calculated fields** (`calc` icon),
    **Parameters** (`param`) and **Hierarchies** (`hierarchy`); the **Performance** tile (`chart-gauge`) closes the rail. Each has its name as `aria-label` / tooltip and opens a dialog.
  - A dashboard's rail has the mark and the Performance tile.
  - The user's own collapse choice is untouched and returns with the Data Source tab.
- The brand name is one line (ellipsis), so the toggle never makes the brand row taller
  than `--topbar-h`.
- Glass rail in the active theme (light or dark). Its section headings (screen-reader-only, below) are sentence case.
- Contents: **Connection** (form or one-row summary; see [connection.md](../../concepts/data-source/connection.md)), the
  **Database** picker, then **Tables** with a search box ([schema-browser.md](../../concepts/data-source/schema-browser.md)).
- The empty Data Source shows one centred sentence + one button that focuses the control for the next
  step ([canvas.md](../../concepts/data-source/canvas.md#empty-state)).

The sidebar's headings (Connection, Databases and tables) are screen-reader-only: the tiles say what they are. Below the brand row are two tiles,
the connected summary and the **database tree** (its search box above the databases and their table rows). The connected summary is a flat row: status slot on the gutter (green dot, grey ring or red cross — the last liveness probe),
host, then change and disconnect icon buttons right-aligned on the row (no menu). A flexible gap with an edge-to-edge hairline (`.sidebar__divider`) separates the connection tile from the database tree.

The **performance** gauge tile (`#perf-btn`) closes the body: the same 40px sidebar tool tile as the worksheet tools, pinned to the bottom and centred in the rail on a worksheet or dashboard (where the body shows only the tools, or only this tile). It is **not in the DOM on the Data Source tab** (`Shell/sidebar.js` removes it there, which has no queries to time, and appends it back on a worksheet or dashboard tab), nor shown while the sidebar is collapsed.

## Tab bar

A glass bar across the top of the content area (`.canvas__bar`). From left to right it holds:

1. Frosted-pill tabs; the active one has an accent fill and bold text.
2. The quiet autosave text.

The **performance** gauge button (`#perf-btn`, `Shell/perf-panel.js`) is not in this bar: it is a sidebar tool tile in the sidebar body (see § Sidebar).

The bar's contents are vertically centred. It shares `--topbar-h` with the sidebar brand block, so the
two bottom borders line up across the shell. The tabs never wrap: they shrink, then scroll inside the bar ([tabs.md](../../concepts/workbook/tabs.md#one-row)), so the bar keeps its height. A dashboard group's underline hangs in the bar's bottom padding.

## Sidebar foot

Two 40px glass tiles at the foot of the sidebar (`.sidebar__foot`, `#sidebar-foot`): **Appearance** first, then **Settings** (`#settings-dock-btn`, the auto-backup dialog). The foot is a child of `aside.sidebar` after `#sidebar-body`, not inside it, so it stays when the body is hidden (collapsed rail, dashboard tab, disconnected). The tiles are `.iconbtn.sidebar__tool`, the same tile as the Performance tile, so every sidebar button on glass looks alike. Nothing floats over the canvas.

- **Wide sidebar** (Data Source, connected): its own section under a full-width 1px hairline (`border-top: 1px solid var(--line)`, the same line as the divider under the connection tile). The tiles are a row on the 16px gutter (`--s4`), 8px apart, 16px below the hairline and 16px above the sidebar's bottom edge; the body above keeps its 16px padding, so the table list is 16px from the hairline.
- **Rail** (collapsed, worksheet, dashboard, story, disconnected, connecting): one centred column at the bottom, 8px apart, under the Performance tile where it shows, 16px above the bottom edge; no hairline (the rail is 60px wide, and the tiles already stand apart). `--foot-rise` lowers the Appearance card's height cap by the Settings tile below it.
- **Fit all cards** is not in the foot: it acts on the Data Source's cards, so it is the tab bar's right-most control (`.canvas__fit` in `.canvas__bar`, `margin-left: auto`, 16px gutter), hidden on every other tab.
- The activity chip sits at the window's bottom right (16px) with nothing to step around, and the data preview panel no longer moves any control.
- Probe (light, dark, One Dark; wide, 900px, collapsed rail, worksheet rail): no alignment, gap, rhythm, contrast, type, radius or target findings. On the whole `.sidebar` the probe also lists parts this change did not touch: the brand row's space-between gap (mark, name, toggle), the screen-reader-only `h2.sidebar__title` (21px, clipped on purpose) and a 1px offset of the table chip's hover grip. The foot's hairline is `--line`, no finding. The one `colour` finding is the tile fill, `color-mix(ink 9%, glass-ctl)` from `buttons.css`, shared with the Performance tile and the worksheet tools (a tint reads as off-token to the probe).
- `.sidebar` is `z-index: 4`, above the tab bar (3) and the data preview (2), so the Appearance card paints over the canvas.

**Appearance** (`#scheme-btn`, `Shell/appearance.js`) is an icon button whose glyph shows the current mode (sun / moon; label "Appearance: Light"). It opens one
314px card on the menu surface: a two-segment mode row (Light / Dark), then Dark look, Accent, Chart colours and Reset theme
([tokens.md § Light and dark](tokens.md#light-and-dark), [workbook.md](../../concepts/workbook/workbook.md)). It scrolls inside when the window is short (checked at a 420px-high window: the card scrolls, the page does not). Spacing: 8px card padding; 4px between rows of one group; 8px each side of a separator; a group heading carries 8px above and none below, so it sits with its own rows. Every left edge (heading, row, strip, swatch, picker) is 16px in from the card's edge, every right edge (tick, swatch, hex field, accent name) 16px; the tick and the Reset icon are pulled 2px so their ink, not their box, meets those edges. The nine swatches have exact 8px gaps (the width is 2 + 2×8 + 2×8 + 9×24 + 8×8). The custom-colour row is one 32px field (a 24px swatch that opens the picker, the name “Custom” and the hex, right-aligned; the swatch sits 3px from the field's edge on every side), its outer edges on the swatch row's; Left / Right walk the mode row and the accent swatches.

The card opens **upward** from its tile (`top: auto; bottom: calc(100% + 8px); left: 0`) and grows from the tile's bottom left (`Core/menu.js` reads the computed `top` to pick the animation direction); its height is capped to the room above the foot (`100vh − 80px`, less `--foot-rise` on a rail). Checked at 900px and at a 420px-high window on a rail: the card is inside the window, above its tile and on top of the canvas.

## Entity cards

- **Structure:** a head on `--surface-2` (table name alone in 600 weight) over an internally scrolling
  column list up to 240px tall. The column type is plain muted text.
- **Surface:** a solid card lifted off the wash, with a visible `--line-2` stroke, the two-layer
  `--elev-card` shadow (`--elev-card-hover` on hover) and a 1px `--card-rim` highlight along the head's
  top edge.
- **Placement:** the Data Source ground is a 24px dot grid whose dots sit on the cards' lattice (a card's top-left corner lands on a dot). Cards snap to 8px and are placed on a 312px
  slot with a 144px gutter between columns and 96px between rows, which holds a link's elbow and badge
  ([canvas.md](../../concepts/data-source/canvas.md#canvas-ground)). The gutter is canvas placement, not
  component spacing, so it sits outside the 4 / 8 / 16 / 24 steps.
- **No data rows on the card.** A card's rows show in the data preview docked under the canvas ([canvas.md](../../concepts/data-source/canvas.md#data-preview)); a table's rows also open in a dialog from its schema-browser chip.
- A caret in the head collapses the card to its title bar. A key column's name turns accent. The ✕ rests muted (`--ink-3`) like the ☰ and caret and turns danger red on hover and keyboard focus; the key strip has no fill, only the rule under it and accent bold names, with the wash on hover ([D140](../../decisions/decisions-design.md#d140--the-data-source-gives-the-next-step-the-strongest-mark-a-cards--rests-muted-and-the-key-strip-has-no-fill)).
- **States** (each shown by more than colour):
  - Hover: the border deepens to `--ink-3` and the shadow to `--elev-card-hover`.
  - In no relationship while the model has other cards: a dashed `--warn-line` outline and the **Needs a partner** label (`.entity--unlinked`).
  - Already added (a repeat drop or `＋`): a 2px accent outline while the card is brought into view and focused (`.is-flash`).
  - Link button dragged over it, when it would accept: a solid accent outline (`.entity--relate-ok`).
  - Dragging by the head: `--elev-16`, no rise-in; resizing the list: the edge strip shows a 2px accent line.

## Worksheet — data header and chart card

Data controls sit in the glass header; view controls sit on the chart card they act on
([worksheet.md](../../concepts/worksheet/worksheet.md#layout)):

1. **Data header** (`.ws-shelves`, glass): **Columns**, **Rows** and **Marks** lanes.
   - Each lane is a fixed label column + zone (`88px 1fr`, wide enough for "COLUMNS"), so every lane
     starts at the same x.
   - Pills are 24px, so a filled lane stays as tall as an empty one.
   - The Marks slots sit in the field pane
     ([Marks slots](../../concepts/worksheet/worksheet-marks.md#marks-slots)).
   - One Marks editor (`.ws-toolpanel`, in `.ws-toolfly`) is open at a time, floating beside the field pane — see [worksheet-marks.md](../../concepts/worksheet/worksheet-marks.md).
     Inside it: the host (`.ws-toolfly`) carries the 1px `--line-2` frame and the `--elev-28` lift (a shadow on the panel inside would be clipped by the host's scroll overflow), and the panel is a stack of **full-bleed sections** on one 16 px grid: a recessed title band (`--surface-2`, sticky while a long editor scrolls), the **slot** (pills over the drop zone, then Add field), then the editor's groups, and a note as a quiet footer band. Every section has 16 px gutters, and every box and glyph starts on that one edge: the drop zone, selects, labels and checkboxes by box, the Add field button by ink (its hover background reaches 8 px into the gutter and its plus is nudged 2 px so the stroke, not the empty space inside the icon, sits on the edge; so are the field-type glyphs in its open list). The design probe reports these deliberate 2 px nudges as `align`; that is the box, not the ink. It is split from the one above by an edge-to-edge `--line` hairline. Inside a group a label sits 4 px over its control, and the rows of a group that holds label-over-control pairs are 16 px apart, so a label reads with its own control; groups of single rows keep 8 px. A filter card in the flyout is the panel's own content (no frame, an inset hairline between cards, so sections read as the primary divisions); one that is not applied keeps its dashed edge. **The Color flyout's Add field list** is not inside the host (its overflow would clip it): it is a sibling layer in `.worksheet` (`.ws-picker__box--side`, z-index 4, under the flyout's 5), its left edge on the flyout's right edge so the two frames share one hairline, level with the Color section, 240 px wide and shrinking to 120 on a narrow worksheet; it never sits on the flyout's left, over the field pane.
2. **Chart card** (`.ws-chart-card`, solid): a head (`.ws-chart-head`) with the **view bar**
   (`.ws-viewbar`), then the Format card when open, the result notice, and the chart pane.
   - View bar, left: the field-pane toggle, the chart-type picker.
   - View bar, right: the sort picker and a tight icon group (**Format** · **Analytics** · **Export** ·
     **Refresh** · **⋯ sheet actions** · **Full screen**, 4px apart).
   - The card has no margin or radius and isn't overflow-clipped, so its menus can extend past it.

**Pickers** (`.ws-pick`) are ghost buttons whose label *is* the current value, with no field captions.

- Chart type shows its icon + name (`▮ Bar ⌄`) and opens a two-column grid of every type.
- Sort shows direction + field (`↑ customers.name ⌄`) and opens "Sort by" (fields) + Ascending/Descending.
- Choices are `menuitemradio` items; the chosen one is bold and ticked.

New view controls extend the view bar or the Format card; new data channels become Marks tools. Every
control is `--ctl-h` tall.

**Resizable field pane:** a handle on its right edge (`#ws-fields-resizer`, the shared `.resizer` look)
sets `.worksheet`'s `--ws-fields-w` (default 236px) between 180px and 40% of the worksheet. Drag it, or
press `←`/`→` for 16px steps. The width is remembered in this browser (`dashboardbuilder.fields.width`).

**Expandable table cards:** the bottom border of an open `.ws-fieldset` is its own grip — no separate handle, so nothing is drawn at rest. The hit strip is the card's last 6px (`EDGE` in `Core/edge-resize.js`); on hover the card gets `.is-edge` (`cursor: ns-resize`, a 2px `--accent` inset line under the bottom edge), and while dragging `body.is-resizing-y` keeps the cursor and stops text selection. A dragged card gets `.is-sized` (`flex: none; height: var(--ws-h)`), still capped by its `max-height: max-content` and floored by its two-row `min-height`. Mouse and pen only — touch keeps scrolling the card. Double-click the border resets; `Alt+↑/↓` on the header resizes from the keyboard (16px steps). Heights are remembered per table (`dashboardbuilder.fields.heights`).

## Dashboard board

The dashboard tab (`.view--board`, padding 0, no scroll of its own) is a two-column grid:

- **Side panel:** 240px, in the worksheet's field-pane slot.
- **Main column:** a bar over `#board-scroll`, which scrolls inside itself while the page stays fixed.
  The bar holds the name, widget count, the edit status line, Full screen and Print. The
  status line reserves two lines so the canvas never shifts.

**Canvas:** 12 columns with rows of `calc(var(--ctl-h) * 2)` and `var(--s2)` gaps. Widgets are absolutely
positioned from the pure `board-layout.js`.

**Widget:** a surface card (`--r`, `--elev-2`) with:

- a `--surface-2` header (grab cursor; the neutral focus wash on a focused widget);
- a 16px corner grip;
- while dragging, a dashed ghost with an `--ink-2` border. When the drop is refused, the ghost shows a
  `--danger-solid` border and a `--danger-bg` label with an icon and text.

Behaviour: [dashboards.md](../../concepts/workbook/dashboards.md).

## Full screen & print

- **Full screen** (view bar, last icon): the chart card alone, edge to edge, through the Fullscreen API.
  Where the API is refused, a fixed overlay with an `Esc` handler stands in. `Esc` or the button leaves
  full screen, and so does switching views.
- **Print / PDF** (Export menu → **Print / PDF…**, or the browser's print): landscape, only the active
  chart card.
  - A print header (`.ws-print-head`, added on `beforeprint`, removed on `afterprint`) shows the
    worksheet name, the Date range and applied filters, the notice line and the print time.
  - The chart is drawn at 1000 × 560 for the page (`sizeChart`); a crosstab repeats its header on each page.
  - Output is black on white (`--print-paper` / `--print-ink`) whatever the scheme.

## The `hidden` attribute

`[hidden] { display: none !important }`. Interactive regions carry an author `display` (flex/grid)
that would otherwise beat the UA `[hidden]` rule. The `!important` makes the `hidden` attribute the
single show/hide switch app-wide: empty states, inline errors, the dropzone hint, the connect-first
gate, the cert warning. **Toggle via `hidden`, never `style.display`**
([golden rule 6](../../development/coding-standards.md#6-toggle-visibility-with-the-hidden-attribute-not-styledisplay)).

## Dialogs

Modals use native `<dialog>` (focus trap, `Esc` closes): a solid `--surface` panel with `--elev-28`
over a plain `--scrim` (no blur). A styled confirm `<dialog>` replaces `window.confirm`, for example when
removing an entity that has relationships or closing a non-empty dashboard.

`listDialog(title, items)` (`Core/ui.js`) shows a titled list with one OK button. It is used for
workbook import / restore issue reports.

## Menus

`Core/menu.js` `wireMenu(button, list)` turns a button plus a `[role=menu]` solid list (`.menu`,
`.menu__list`, `.menu__item`) into a keyboard-operable popover:

- click toggles it, and arrow keys move focus;
- `Esc`, an outside click, focus leaving or choosing an item closes it;
- opening one menu closes the others.

Visibility is the `hidden` attribute.

The **context popup** (`openContextMenu` / `wireContextMenu`) is the same list with no button.

- It opens at the pointer on right-click, or under the element on the ContextMenu key, `Shift+F10` or
  `Enter`.
- It sits on `<body>` (`.ctx-menu`, fixed, kept inside the viewport).
- It holds items, radio / tick rows and custom rows (such as a filter's value editor).
- `Esc`, `Tab`, an outside click, scroll or resize close it; `Esc` returns focus to the element.
