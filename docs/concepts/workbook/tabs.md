---
components: [src/DashboardBuilder/Features/Board/, src/DashboardBuilder/Features/Canvas/, src/DashboardBuilder/Features/Core/, src/DashboardBuilder/Features/Dashboard/, src/DashboardBuilder/Features/Relations/, src/DashboardBuilder/Features/Story/, src/DashboardBuilder/Features/Tabs/]
---
# Tabs — Data Source, worksheets, dashboards and stories

The tab strip runs across the top of the content area and switches between the Data Source, worksheets, dashboards and stories.

- Why one shared model: [D12](../../decisions/decisions-platform.md#d12--subtabs-are-dashboards-over-one-shared-data-source).
- Why two tab kinds: [D61](../../decisions/decisions-dashboards.md#d61--worksheets-and-dashboards-are-separate-tab-kinds-workbook-format-v2).

**Code:**

- `Features/Tabs/` — `tabs.js`, `tabs.css`, `duplicate-model.js`, `tab-groups-model.js` (groups, display order, shrink solver; node-tested)
- `Core/store.js` — the shared state the tabs sit over
- `Features/Board/` — the dashboard tab's body
- `Features/Story/` — the story tab's body ([stories.md](stories.md))

## The strip

- **Look.** Tabs are frosted pills (tier-2 glass controls). The active tab has an accent fill and bold text.
  It carries `aria-current`.
- **Data Source tab.** A pinned **Data Source** tab (`.tab--model`) comes first: the shared entity canvas
  ([canvas.md](../data-source/canvas.md) + [relationships.md](../data-source/relationships.md)). It cannot be closed.
- **Worksheets and dashboards.** After it comes **one ordered list** of three tab kinds.
  Each tab shows its kind's icon (`.tab__kind`, decoration only), and its accessible name includes the kind
  (`aria-label` "Sales (worksheet)" / "Overview (dashboard)" / "Tour (story)").
  - **Worksheet** (`.tab--worksheet`, icon `chart-bar`) — one Tableau-style worksheet ([worksheet.md](../worksheet/worksheet.md)).
  - **Dashboard** (`.tab--dashboard`, icon `dashboard`) — a board of worksheet, text, image, button and spacer widgets ([dashboards.md](dashboards.md)).
    Its data (widgets, limits, validation, save and open) is in [data-model.md](../../reference/data-model.md#tabs-and-dashboards).
  - **Story** (`.tab--story`, icon `story`) — ordered, captioned steps over worksheets and dashboards ([stories.md](stories.md)).

### One row

The strip never wraps ([D152](../../decisions/decisions-tab-strip.md#d152--the-tab-strip-is-one-row-tabs-shrink-then-the-list-scrolls-inside-the-bar)).

- **Shrinking.** While the tabs fit they keep their natural width. When they outgrow the bar, `tabs.js` measures the inactive tabs at natural width and sets one shared cap (`--tab-w` on `.tabs__scroll`, from the pure `fitTabWidth`): short tabs keep their width, longer ones share what is left, the label shrinking first. The **active tab is never capped.**
- **Crowded.** An inactive tab capped under 96px drops its duplicate and close buttons (`.tabs--dense`; activate it first to close it). Under 60px its label collapses and it is an icon (`.tabs--icons`; every tab has a `title` "<name> (<kind>)", so the pointer still finds it; the label stays in the DOM, the accessible name still names the tab, and keyboard focus shows the app's neutral wash on the tab, as everywhere, never an outline). The floor is 36px.
- **Scrolling.** Past the floor `.tabs__scroll` scrolls sideways **inside the bar**; the page never scrolls. A vertical wheel turn over it scrolls it sideways (its scrollbar is hidden). The active tab is scrolled into view whenever the strip redraws. **Data Source and `[+]`** sit outside the scroller and stay in view.
- **Clicking.** The whole tab switches (an icon-only tab's label can be 0px wide); the duplicate and close buttons and the rename input do not.

### Groups

A dashboard that shows worksheets is drawn as a **group** ([D153](../../decisions/decisions-tab-strip.md#d153--a-dashboard-that-holds-worksheets-is-a-derived-group-on-the-strip)); the grouping is derived from the dashboards' widgets, never edited by hand.

- **Members.** A group is a dashboard plus the worksheets its widgets show. A worksheet on several dashboards belongs to the **first of them in stored order**. A dashboard that owns no worksheet, a worksheet on no dashboard and every story stay ordinary tabs.
- **Look.** The **dashboard's own tab heads the group** (`.tab--head`, with a fold button `.tab__fold` — a chevron — at its left), then the group's worksheet tabs, all under one coloured underline (`.tab-group::after`; an underline on the wrapper, because the shared button styles zero borders and shadows on `.tab`). The colour is `--chart-cat-1…7` by the dashboard's `groupSlot` (slot 8 is the neutral grey, skipped); the dashboard's name on its tab (drawn once, there is no separate label) keeps colour from being the only cue. A group header is never width-capped, like the active tab. The wrapper is `role="presentation"` (transparent, so the tablist still owns every tab and a screen reader counts positions across the whole strip); the fold button's name carries the group ("<dashboard> group, N tabs, expanded").
- **Order.** The group sits at its **dashboard's** slot in the strip: the dashboard first, then its worksheets in stored order. This is a display order only; `store.tabs` and the saved tab order do not change.
- **Collapse.** The fold button (`aria-expanded`, `aria-label` "<dashboard> group, N tabs, collapsed") hides the group's worksheet tabs; the dashboard tab stays and shows the count of hidden tabs (`.tab__count`). A collapsed group still shows the **active** worksheet, so collapsing never changes the view; moving elsewhere hides it. Focus stays on the fold button. Navigating into a collapsed group shows that tab and leaves the group collapsed. The state is the dashboard's `collapsed` flag and is saved.
- **Colour.** A new dashboard takes the lowest slot in use least among the dashboards; the slot is stored (`groupSlot`), so closing one dashboard never repaints the others. A file without slots gets them on open.
- **Redraw.** A widget added to or removed from a dashboard emits `dashboard:changed`, not `tabs:changed`; the strip redraws on it only when the groups changed (`groupKey`), so dragging a widget never rebuilds the strip.

### New tab

- **`[+]`** (`.tab-add`, `aria-haspopup="menu"`) opens a menu: **New worksheet / New dashboard / New story**.
  The menu is `Core/menu.js`: arrows move, Esc closes and returns focus to `[+]`, and Enter / Space on a focused item acts.
- A new tab is active, and its label is focused.
- Default names are **"Worksheet N" / "Dashboard N" / "Story N"**, where N is the first number not in use by a tab of that kind.
- **Limit:** a workbook holds at most **50 tabs of either kind** (`LIMITS.tabs`).
  Creating one past it toasts "A workbook holds at most 50 tabs — close one first.", adds nothing and keeps focus on `[+]`.
  Import caps it the same way ([workbook.md](workbook.md#validation-parseworkbook)).

### Rename

- Double-click a tab (the label, or anywhere on an icon-only tab; not its buttons), or focus its label and press `F2` (or `Enter` on the active tab), to edit it inline (`.tab__rename`, `maxlength` 60).
- The name is trimmed and must be 1–60 characters. An empty name reverts and toasts "Tab name is required."
- Keyboard focus returns to the tab's label afterwards.
- Clicking the tab that is already open does nothing.
- The double-click listener sits on the strip (`#tabs`), not the label. Every switch rebuilds the strip, so a label-level listener would lose the double-click.

### Close

The close icon (`.tab__close`, `aria-label` "Close <name>") closes a tab.

- **A worksheet used by dashboards** confirms by name: "Close the worksheet “Sales”? Used on: Overview, Ops. It will be removed
  from those dashboards." Once closed, its widgets are removed from them, and each dashboard is notified with `dashboard:changed`.
- **A worksheet on no dashboard** confirms only when it holds content.
- **A dashboard with widgets** confirms ("The worksheets on it are not affected."). Closing a dashboard never touches a worksheet.
- **A worksheet or dashboard shown by story steps** leaves those steps (each story is notified with `story:changed`); the confirm names the stories, and a worksheet or dashboard shown only by stories confirms too.
- **A story with steps** confirms ("The worksheets and dashboards it shows are not affected.").
- **Dashboard buttons** that go to the closed worksheet or dashboard are unlinked, and the confirm names those dashboards ("Buttons that go to it will be unlinked on: …").
- **One confirm:** every close that asks (the cases above) asks **once** (`confirmDestructive`, button **Close**, the question ending "This can't be undone."; [D133](../../decisions/decisions-destructive-actions.md#d133--no-undo-one-confirmation-before-every-destructive-delete)).
  An empty tab (a worksheet with no content that no dashboard or story uses, a dashboard with no widgets and no users, a story with no steps) closes at once with no prompt.
  There is no undo: a closed tab, and the widgets, steps and button links it removed, are gone.

### Duplicate

The duplicate icon (`.tab__dup`, `aria-label` "Duplicate <name>") appears on **worksheets only**. A dashboard is not duplicated (build another).

- `store.duplicateWorksheet` deep-copies the sheet: shelves, calculated-field pills, filters, marks, format and chart type.
- It resets the transient state: the selection is cleared, drill goes back to its first level, and pages go to the first member (members reload).
- **Name:** `<name> copy`, then `<name> copy 2`, … A copy of a copy reuses the base name. The name is trimmed to 60 characters.
- The copy is inserted right after the source and made active.
- At the tab limit it toasts "A workbook holds at most 50 tabs." and adds nothing.
- The naming, limit check and sheet copy are pure (`Tabs/duplicate-model.js`).

## How views switch

- **Current view.** `store.currentView()` is `{ kind: "model" }`, `{ kind: "worksheet", id }`, `{ kind: "dashboard", id }` or `{ kind: "story", id }`.
- **Who renders what:**
  - `canvas.js` / `relations.js` render `#model-view` when the model is active.
  - `dashboards.js` renders the active worksheet into `#worksheet-view` (`isWorksheetActive()`).
  - `board.js` shows `#board-view` for a dashboard (`isDashboardActive()`). It renders only the active one and destroys its views when you leave it.
  - `story.js` shows `#story-view` for a story (`isStoryActive()`), likewise.
- **Events:**
  - Each module shows/hides its own view on `view:changed`.
  - The strip redraws on `tabs:changed`, and on `dashboard:changed` when a dashboard's group changed.
  - `worksheet:changed { id }` means a worksheet's sheet was replaced.
  - `dashboard:changed { id }` means a dashboard's widgets changed.
  - `story:changed { id }` means a story's steps changed.
- Closing the active tab activates its right-hand neighbour **as the strip draws it** (else the left one, else the Data Source) — with groups, that is not always the next one in `tabs`.
- All tabs build from the **same** entities and relationships: a table added while on a worksheet still lands in the shared model.

## Persistence

- Tabs (in strip order), entities, relationships, worksheets and dashboards are saved as the browser **workbook** and restored on reconnect. A dashboard also saves its group's `groupSlot` and `collapsed` ([workbook.md](workbook.md)).
- The strip's right end holds one **Workbook** overflow menu (Import / Export) — [workbook.md](workbook.md).
