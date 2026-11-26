---
components: [src/DashboardBuilder/Features/Canvas/, src/DashboardBuilder/Features/Dashboard/, src/DashboardBuilder/Features/Relations/]
---
# Relationships & cardinality

A relationship is a logical link between a column of one entity and a column of another, drawn on the Data Source canvas.
It is the **user's declaration**, used for joins and layout. ClickHouse never creates or validates it
([golden rule 5](../../development/coding-standards.md#5-relationships-are-logical-declarations-not-database-facts)).
Shape: [data-model.md](../../reference/data-model.md#relationship).

**Code:** `Features/Relations/` — `relations.js`, `relation-rules.js`, `link-drag.js`, `link-keys.js`, `relation-describe.js`, `key-pairs.js`, `key-pairs-ui.js`, `relations.css`.

A **union or unpivot card** ([query-sources.md](query-sources.md)) takes no relationship. Its rows aren't draggable, and dropping a
table column on one toasts "A union or unpivot can't be related to a table yet."

## At a glance

- **Drag a column onto a column** of another card to relate them, then pick the join type and cardinality in a dialog. [From the keyboard](#drawing-a-link--keyboard) the same link is made with Enter on two columns.
- **Shortcuts** ([relating-tables.md](relating-tables.md)): a proposed link with **Relate on customer_id = id** for each card that **Needs a partner**, drawn when you point at the card. It opens the dialog filled with the key the column names point to.
- **One relationship per table pair** ([D127](../../decisions/decisions-relationships.md#d127--a-table-pair-holds-one-relationship-related-in-few-steps)): relating two more columns of related tables adds a key pair to it.
- **One relationship per column** (extra key pairs included). Kinds must match (number↔number, text↔text, date↔date, boolean↔boolean).
- **Every table card needs a partner** once there are two or more; an unrelated card is held out of worksheets.
- **Join type** is inner, left, right or full, shown as radio cards with the SQL names only (see [Join type](#join-type-p31-t02-12-t02-13)).
- **A relationship can match on several column pairs** ([compound key](#compound-keys-and-key-suggestion)): up to four, joined with AND.
- **Total each table by the key before joining** (optional, per relationship) stops a measure being repeated when the other table repeats the key; a filter direction goes with it ([below](#aggregate-before-joining-many-to-many)).
- **A suggestion shows by default** in the dialog: the cardinality the data reads as, with its evidence (which side repeats, match shares,
  a counts table) and any warnings ([below](relationship-suggestion.md)). It never blocks saving or changes the choice
  by itself; when it differs from the chosen cardinality a **Use N:1** button (`.join-check__use`) selects it (Confirm still saves).
- **Cardinality is intent, not a data guarantee** — joins can still fan out.

## Drawing a link — drag a column

Relationships are made by **drag and drop or from the keyboard**. There are no connector handles and no join-key checkboxes;
the columns a relationship uses are simply the ones it joins.

1. Drag a column row (`.col-row`, `draggable`; payload MIME type `application/x-ch-column`) and drop it on a row of another card.
2. While dragging, the dragged row dims. The row under the pointer shows whether the drop is allowed:
   - a solid accent outline when the link is allowed;
   - a dashed red (`--danger-solid`) outline and a not-allowed cursor (drop effect none) when it isn't.
3. A refused drop is reported (see [What may be linked](#what-may-be-linked)).
4. An allowed drop is checked first, then opens the join + cardinality dialog (`<dialog>`; cardinality is a radio group `name=cardinality`: `1:1 | 1:N | N:1 | N:M`).
   The dialog **starts on a cardinality read from the two column names** (`guessCardinality()`, `relation-rules.js`, pure): a column is
   its table's own key when it is `id` / `key` or `<table>_id` (singular or plural). A non-key column dropped on a key starts on **N:1**
   (`orders.customer_id` → `customers.id`), the reverse on **1:N**, key to key on **1:1**; names that say nothing start on 1:N.
5. Picking one draws the link. Cancelling changes nothing.

`link-drag.js` (pure) holds the payload parse and `dropDecision()`, which reuses `linkIssue()`.

To remove a link, click its line or badge (with [quiet badges](#rendering) a badge shows on hover), then Delete. **Remove** in the dialog asks once (`confirmDestructive`, button **Remove**: "Remove the orders → customers relationship? This can't be undone."; [D133](../../decisions/decisions-destructive-actions.md#d133--no-undo-one-confirmation-before-every-destructive-delete)), then toasts "Removed the orders → customers relationship.". There is no undo; relate the tables again to bring it back (a table pair holds one relationship, [D127](../../decisions/decisions-relationships.md#d127--a-table-pair-holds-one-relationship-related-in-few-steps)). Removing a key pair inside the open dialog is a draft until **Confirm** and is not confirmed separately.

**The how-to line.** While any table card has no relationship, a pill at the foot of the Data Source (`.rel-guide`) says
"Drag a column onto a column in another table, or click a proposed link." while a proposal is drawn at rest, "…or point at a card that needs a partner to see its proposed link." while proposals wait for the pointer, and only the drag when no card has one. It goes once every card has a relationship. While a toast shows (it owns the centre of the foot) the pill steps up to sit one 8px gap above it (`--toast-h`). The lift is one variable, `--rel-foot`, that moves the pill and the keyboard hint above it together; the Data Source's data preview raises it by the panel's height ([canvas.md § Data preview](canvas.md#data-preview)).

## Drawing a link — keyboard

Both paths end in the same `proposeLink()` in `relations.js` (check with `dropDecision()`, then the dialog), so the same links are refused
for the same reasons.

1. Table-column rows are named groups (`role="group"`, `aria-label` "column, type, in table", `aria-describedby` a hidden help line;
   not buttons, since a row holds the Profile button, which stays a tab stop). Tabindex roves: one row per card is the tab stop
   (the last focused, else the first), so `Tab` reaches the next card. `↑` / `↓` / `Home` / `End` move within a card; `]` / `[` jump to the next / previous card (wrapping, left to right).
   A union or unpivot's rows are not part of this.
2. `Enter` or `Space` on a row picks it as the source (`aria-current`). It shows a solid accent outline and the word "From".
3. Move to a row of another card (arrows, `]`, `Tab`, or click). The status line (`.rel-keyhint`, `role="status"`, always rendered,
   visually hidden while empty, wraps) says what `Enter` will do, or leads with why that column is refused (same table, kind mismatch, already related), and names `[` `]`.
4. `Enter` or `Space` on that row opens the join + cardinality dialog (a kind mismatch opens the type warning); after the link is made
   focus returns to that row, now in its key strip. `Enter` on the source again, `Esc` anywhere on the page, moving focus out of the column rows, removing a table or changing view cancels the pick.

`link-keys.js` (pure) holds the key map, `stepIndex()`, `cardIndex()`, the status wording and the row labels. Focus shows as an inset ring on the row.

### Editing and removing a link from the keyboard

Each drawn link's line is a tab stop (`tabindex="0"`, `role="button"`; DOM order puts links after the ground and before the cards). Its name says what it joins, every key pair included ("Relationship orders.cust_id to customers.id, many to one. Enter edits it, Delete removes it."); the badge repeats the link for the eye and is `aria-hidden`.

- **Focus reads like hover:** the line goes `--accent` and thicker (3px) with a faint `--focus` halo under it (never colour alone), the badge shows even in the quiet mode of many links, and every key row of the link takes the accent wash.
- `Enter` / `Space` open the relationship dialog (`editRelationship`); `Delete` / `Backspace` remove it through the same confirm as the dialog's Remove button (`removeRelationship`, [rule 12](../../development/coding-standards.md#13-destructive-deletes-ask-once-there-is-no-undo)); after a removal focus lands on the ground.
- `render()` redraws every link, so a focused link is refocused by its id after each redraw; closing or saving the dialog leaves focus on the link.
- Pure parts in `link-keys.js`: `linkEdgeAction()` (the keys) and `linkLabel()` (the name). Browser checks: `tests/live/kbd-relate-ui.mjs` (focus, Enter, Cancel, save, Delete).

## What may be linked

`linkIssue()` in `relation-rules.js` (pure; `linkProblem()` is its message) blocks a link, with no cardinality dialog, when:

- both ends are on the **same table**;
- the same two columns are **already related** (either direction);
- the two tables already match on **four column pairs** (another pair between related tables otherwise [extends that relationship](relating-tables.md#one-more-column-of-related-tables));
- the key **kinds differ** — only number↔number, text↔text, date↔date and boolean↔boolean link
  (`keysCompatible`); `compound` and `other` columns never link;
- a column is **already in a relationship** (see Rules below).

**How a refusal shows.**

- A **type mismatch** opens a warning modal (`type-warning.js`, `.dialog--warn`):
  - the title "Data types don't match" with a warning icon;
  - both columns as `table.column`, with their exact ClickHouse type and kind (`Float64 · number`);
  - one sentence on why: a join compares values, so both must be the same kind;
  - for a number / text / date / boolean key, the free columns of the other table that would fit (or that it has none).

  A single **Got it** button closes it; Esc does too.
- Every other refusal (same table, already related, column already used, a union / unpivot card) stays a toast — an **info**
  toast that hides after 5 s: a refusal is a notice, not a failure, so it is never red (golden rule 7).

## Rendering

**Lines and badges**

- Links are **elbow lines with rounded corners** between the two column rows, drawn in two SVG overlays:
  - the lines (`.rel-svg`, `.rel-link`) sit **under** the cards, so a link to a far card slips under the cards between;
  - the badges (`.rel-svg--labels`) sit **over** them, so a badge wider than the gutter is never clipped; a badge with no free spot beside the cards moves to the line layer instead (see below).
- A wider invisible hit path (`.rel-link__hit`) makes the line easy to click. Line and badge act as one link (hover, click).
- A **cardinality badge** (`.rel-badge`, a pill) sits on the link's middle run: "1:N", or "1:N · left" / "· right" / "· full" for an outer join.
  - **Quiet badges:** with 4 or more links on the canvas, below 125 % zoom (`quietBadges` in `link-route.js`), badges rest hidden (`.rel-quiet` on the canvas, opacity 0, no pointer events) and show only on the hovered or focused links. The end shapes still carry the cardinality, and the Relationships card lists every join.
- **Shape-coded endpoints** (`.rel-end`) show cardinality without colour: a tick for "one", a crow's foot for "many", square to the card edge.
- **Colour:** resting links use `--ink-3`. A link is `--accent` while **hovered or being drawn**, and the two key rows it joins take the
  accent wash (`.col-row--linked`), so which columns a line connects reads at a glance. Hover and keyboard focus on a link highlight it; a selected link (clicked, with its dialog open) draws no highlight of its own.
- **Focus:** while a link or a card that has links is hovered, the links it doesn't touch fade to 20 % (`.rel-focus` on the canvas, `.rel-link--focus` on the kept ones, `markLinkedRows`). Hovering a card keeps all of that card's links, with their badges.
- **A new link arrives** (`arrival()` in `relations.js`; CSS `.is-arriving` in `relations.css`): `render()` rebuilds every link on each zoom, drag and resize, so a plain CSS animation would replay each time. `createRelationship` records the link's birth time instead; a redraw inside 450ms marks the line and its badge `is-arriving` and sets `--age`, which `animation-delay: calc(… - var(--age))` turns into a resume. Line fade, then end shapes, then badge (timings: [motion](../../reference/design/motion-accessibility.md#motion)). `restoreRelationship` (workbook open) records nothing, so a restored link never animates. Reduced motion draws it at once.

**Routing** (`link-route.js`, pure)

- A link leaves a card's side straight out, turns at right angles and enters the other card straight in.
- Cards with a gutter of at least 32px face each other, and the link turns in the middle of the gutter, so its badge sits equally far from both cards.
- Closer or overlapping cards both use the right edge, and the link loops out past the farther one.
- **Lanes** (`assignLanes`): links that turn in the same gutter and whose vertical runs overlap (or come within 8px) form a cluster, and each takes its own lane, with no limit on the count. A link that overlaps nothing runs on the middle.
  - A cluster's lanes are centred on the gutter's middle, 8px apart, squeezed (to 3px at least) when the gutter is too narrow to hold them.
  - Lanes are ordered to cross as little as possible: each link is inserted where it adds the fewest crossings (`laneCrossings`: a horizontal run that passes another link's lane inside that link's span). A fact table linked to a column of stacked dimensions draws them nested, with no crossings.
  - `render()` measures every link first, then assigns lanes, then draws.
- A badge never covers a card or another badge. It starts at the middle of the link's vertical run and slides along the run to the nearest free spot. If the whole run is blocked (the link passes behind a card), the badge drops into the line layer, **under** the cards, at the middle, stepping clear of other badges (`placeBadge` in `link-route.js`).

**Rules.**

- A column is in at most one relationship (`relationshipOf` in `relation-rules.js`).
  The click, drag and workbook-import paths all refuse a second one, naming the column.
- Every table card belongs to a relationship. Once the model holds two or more table cards, one with none is marked **Needs a partner**
  (`.entity__need`, dashed `--warn` outline — text and outline, not colour alone).
  A union / unpivot takes no relationship and is exempt; a lone card is not flagged.
- **Consequence:** such a card is held out of worksheets.
  - Its fields don't appear in the field pane. With every table held out, the pane says to relate them first.
  - A view or dashboard widget that still reads one (`heldOutProblem`, `worksheet-view.js`) sends no query and shows
    "<table> isn't related to another table yet. Relate it in the Data Source to use its fields."
  - Relating the card restores it.
- A card may relate to several others (star schemas and chains are fine).

**Pinned keys.**

- A column in a relationship moves out of the scrolling list into the card's key strip above it (`.entity__keys`: no fill at rest, a rule beneath it, accent bold names, the accent wash on hover — [D140](../../decisions/decisions-design.md#d140--the-data-source-gives-the-next-step-the-strongest-mark-a-cards--rests-muted-and-the-key-strip-has-no-fill)).
  It goes back to its place when the link goes. So a link's end is always on a visible row, however far the list is scrolled.
  Pinning runs at the start of every redraw, before the link ends are measured: pinning changes card heights, so measuring first left
  links on first load or restore pointing at the old row positions until a card was moved.
- Pinned rows are ordered by their **partner**, not by column order (`pinOrder`, `orderStrip` in `relations.js`):
  by the partner card's top edge, then by the order the relationships were made.
- Both cards of a pair see the same order, so their links run parallel: straight when the cards' tops line up, never crossing.
  A card with partners above and below lists the upper partner's keys first.
- The order is recomputed when a card moves.

**Magnetic alignment.**

- While a card is dragged, its top edge is pulled onto the position that puts a pinned key row level with its partner's,
  when the pointer is within 12px of it. The link then becomes one straight line (`straightenTops` in `canvas.js`, `snapTop` in `align-snap.js`, pure).
- Hold **Alt** to drag without the pull. Collapsed cards don't pull.

## Editing & cleanup

- Clicking a link opens the edit/delete dialog: change the cardinality or join type, or remove it.
- **Dialog layout.** The relationship dialog is landscape (`dialog.dialog--sm.dialog--rel`, up to 1216 px wide, never wider than the window less 16 px each side; golden ratio: its height is the width × 0.618, 752 px at full width, but never under 600 px (a shorter frame makes both panels scroll for nothing: at 700 px wide the ratio alone gave 413 px) and never past the window less 16 px top and bottom; two equal panels, settings left and **What this link does** with the suggestion and its evidence right, so the divider runs down the middle; the divider is an inset shadow so it adds no width. **Each panel scrolls on its own** inside the fixed body (never a scroll inside a scroll), and the 24 px of air above and below is each panel's own padding, so text slides under the head and foot hairlines. Under 880 px the panels stack into one column and the whole body scrolls once (the frame then takes the window's height, up to 752 px); under 640 px it goes back to its content height with `height: fit-content`, the browser's modal default, because `auto` stretches a modal to the window).
  It shares the column profile's frame (`.col-profile`) without its cells: a head with the title **Relationship**, the two tables as a subtitle (`orders → customers`) and an X; a body on the colour wash, with head and foot staying put; a 24 px side gutter shared by head, body and foot (the X sits on it); a foot with **Delete** (left, edit only), **Cancel** and the primary **Confirm**. Nothing inside the body closes the dialog: the cardinality buttons only select (`aria-pressed`), and **Confirm** saves cardinality, join, totals and key pairs together. Group headings (**Join**, **Totals**, **Also match on**, **Cardinality**) use one voice (600, `--ink-2`) with 24 px between groups.
  The left panel (`.rel-dialog__left`) has four `.rel-sec` sections straight on the wash, split by one hairline and 24 px of space, in this order: **Join**, **Cardinality**, **Totals** (one switch row: a checkbox drawn as a switch by `.form-check`) and **Also match on** (suggestions, then the two selects on one line and **Add pair** under them on the right). Join and Cardinality are the same control, built by `radioCards()`: one choice of four as radio cards in a 2 × 2 grid (`.choice-cards` / `.choice-card`, one column under 420 px). Each card is a bordered surface with a round radio and a bold name, no hint; the radio and the name are vertically centred in the card (`align-items: center`); the chosen card takes the accent border, the accent tint and a filled dot, so it never relies on colour alone. Cardinality's choices come from `cardinalityChoices()` (`relation-rules.js`): the kind in words with its code on one line, e.g. **One to many (1:N)** (the code is what the canvas badge and the suggestion show). Picking only selects; Confirm saves. DOM order is reading order.
  The right panel (`.rel-dialog__right`) holds the **Suggestion** and its evidence. It never makes the dialog taller: the row is the body's height (`grid-template-rows: minmax(0, 1fr)`) and the panel scrolls inside when its text is longer. **What this link does** is pinned to the panel's top (`position: sticky`, opaque `--bg`), so the consequence of a pick stays in view while the evidence scrolls under it; stacked under 880 px it is an ordinary block above the suggestion. The left panel scrolls the same way when the settings grow (more key pairs, the Filters choice). Both scrollbars are the app's one scrollbar ([layout.md](../../reference/design/layout.md): 10px, no arrow buttons, `--line-2` thumb, accent on hover; no per-dialog rules) in its own lane (`scrollbar-gutter: stable`, so nothing shifts when it appears), with a 16 px gutter between the content and that lane; the panel reaches 16 px into the body's side gutter so the lane sits there instead of narrowing the content.
  A dialog with no key data has no right panel. Built in `openCardinalityDialog()` (`relations.js`); styles in `relations.css`.
- Links re-route live on `entity:moved`.
- **Collapsed cards.** A link ends on its card's edge at the **vertical centre of the card** while the card is collapsed (the title bar), and at the
  related column's row once it is expanded (`anchor` in `relations.js`). While a card folds or unfolds, `canvas.js` (`followFold`) fires
  `entity:collapsing` every frame for 300ms, so the link slides with the edge instead of jumping. Collapsing is not a model change: the workbook is not marked changed.
- Removing an entity prunes its links, and `rel:changed` fires.

## Join type (P31, T02-12, T02-13)

The dialog's **Join** choice shows the SQL join names only, with no hint (**What this link does** beside it says in words which rows are shown). It is one choice of four, so it is drawn as radio cards (2 × 2, one column under 420 px), not switches: a switch reads as "pick several". The chosen card has the accent border, tint and a filled dot. Cardinality uses the same cards. The link runs from the first-clicked key to the second, so the first table is the **left** side.

| Choice | Join type | Rows shown |
|---|---|---|
| **Inner join** | `inner` | only rows that match |
| **Left join** | `left` | all rows of the first table |
| **Right join** | `right` | all rows of the second table |
| **Full outer join** | `full` | all rows of both |

- Unmatched rows have NULL for the other side's fields (they read "—").
- The badge says it in words ("1:N · left", "· right", "· full").
- The choice is saved per relationship (`joinType`). A workbook without one, or with an unknown one, reads as inner.

**Preserved-side rule.**

- A link saved with the current dialog is *fixed* (`joinFixed`): it keeps the table it names, whichever table the view starts from.
  The plan walks outward from the base, and a fixed link crossed second-to-first swaps `left`/`right` (`planJoinType`).
- **Older links** (saved by an earlier build: `joinFixed` absent, type `left`) keep the old rule: `LEFT JOIN`, keeping the base-side table in either direction.
  The edit dialog shows such a link as "Left join (older link)" (hint: All rows of the base table).
- Saving the dialog with any choice (including re-saving that one) is what fixes it.
  Picking **Left join** or **Right join** converts it; picking the older-link choice leaves it legacy.
- Right and full are always fixed.

**Behaviours chosen** (see [clickhouse-integration.md](../../reference/clickhouse-integration.md#worksheet-query-queryasync)):

- A filter on a table whose rows were NULL-extended drops those rows, so the outer join then acts inner for that filter.
- `count()` counts NULL-extended rows.
- A NULL join key never matches, so such rows appear unmatched on both sides of a full join.
- Grouping by the *non-preserved* table's key shows NULL for the unmatched rows.
- **Refused (400):** a top-N filter on a view with a right or full join; right/full joins on a connection whose server refuses settings
  (`join_use_nulls` is required).
- Approximate mode reads such a view exactly (no sample).

## Compound keys and key suggestion

The relationship dialog (new link and edit) has an **Also match on** section; the [suggestion](relationship-suggestion.md) sits in the right panel. The link's first pair is the one dragged
or picked; the section adds up to **three more pairs**, so the join is `a.k1 = b.k1 AND a.k2 = b.k2 …` (4 in all; more is refused,
`LIMITS.joinExtraPairs` ↔ `ApiLimits.MaxJoinPairs`). Saved with the dialog's cardinality choice, like the join type.

- **Suggestions.** Buttons "+ Add Region = region" offer free column pairs with the same name (exact first, else ignoring case and `_` `-` spaces)
  and the same kind. Nothing is added until one is pressed. Pure: `suggestPairs()` in `key-pairs.js`.
- **First pair.** While a column is being dragged or picked from the keyboard, each other table's best-matching free column (same name, exact
  first, same kind) is flagged: dotted outline, the word **Match** and "suggested match" in its accessible name. It is only a hint; any
  column can still be chosen, and the keyboard path (roving rows, `[` `]`, Enter) is unchanged. Pure: `suggestTarget()` in `key-pairs.js`.
- **By hand.** One row reading `column of orders = column of customers`, then **Add pair** under it on the right (so the two selects share the whole line, ≈ 270 px each at the full dialog width): two selects (one per table, free columns only), their prompt just the table's name (`orders`, muted until a column is picked, not listed in the open list; the accessible name is `Column of orders`) and an `=` between them, the sign the added rows use. Each option is the **name** and, apart from it, the **kind** in `--ink-3` (`order_id (number)`): in the closed control and in the open list only the name can end in an ellipsis, the kind stays whole at the right; a row's `title` carries the full text. The open lists are drawn like the app's menus (`.select--menu`, [components.md](../../reference/design/components.md)), as wide as their longest row but at most 32 rem (and never wider than the window less a 16 px gutter); the right-hand select's list lines up with its right edge, so it grows leftwards and stays over the left panel. A pair of different kinds, a column already in a relationship or an already matched column is refused in a warning note under the row: glyph beside the words, `--warn-*` tokens, never colour alone (`addPair()`, `.key-pairs__problem`).
- **Remove.** Each added pair is a 32 px row `a = b` (the controls' height) with a quiet × icon button flush right, named `Remove a = b`.
- **At the limit.** With three extra pairs (four in all) the suggestions and the selects go, and the line "A relationship matches on at most 4 pairs of columns." says why (`.key-pairs__full`).
- **Keyboard.** Relate two columns [from the keyboard](#drawing-a-link--keyboard); the dialog then opens with focus inside it, and the
  suggestion buttons, selects (arrow keys), Add pair and Remove are all native controls reached with `Tab` and `Enter`.
- **On the canvas.** Every pair's columns are pinned in the key strips (accent bold names); one line (the first pair) is drawn.
  The badge counts the keys ("N:1 · 2 keys", "N:1 · left · 3 keys").
- **In worksheets.** The join sends the extra pairs (`joins[].pairs`, swapped when the link is crossed second-to-first); the server ANDs them into `ON`
  ([clickhouse-integration.md](../../reference/clickhouse-integration.md#worksheet-query-queryasync)).
- **The suggestion** reads the pairs as they stand in the dialog and runs again (300 ms after the last change) when a pair is added or removed; the result names the key "a + b". A NULL in any part is a NULL key.
- **Saved** as optional `pairs` on the relationship ([workbook.md](../workbook/workbook.md)); a file without it is a one-pair link. On open, a malformed pair,
  one past the limit or one reusing a column already in a relationship is skipped with an import issue.

- **By drag.** Relating two more columns of the two tables (drag or keyboard) adds a pair without the dialog ([relating-tables.md](relating-tables.md#one-more-column-of-related-tables)); the link button dragged onto a card fills every same-named key column in.

## Aggregate before joining (many-to-many)

A join repeats a row of one table once per matching row of the other, so with a one-to-many or many-to-many link a sum or count over the repeated
side double-counts. The dialog's **Totals** section has a switch row (a checkbox drawn as a switch by `.form-check`), **Total each table by the key before joining, so a total isn't repeated**
(off by default; `aggregateFirst` on the relationship, [D86](../../decisions/decisions-dashboards.md#d86--aggregate-before-joining-is-a-per-relationship-option-on-a-two-table-view)).
Ticking it shows **Filters**, a two-way choice (`filterDirection`, "both" is the default and is not stored):

- **A filter on either table also limits the other** — the other table keeps only keys the filtered table still has.
- **A filter changes only its own table** — each table is filtered on its own, and the join type decides what happens to the other side's rows
  (with an outer join they stay, with no match for the filtered side).

In a worksheet each table becomes a subquery grouped to the join key plus the fields the view groups by, carrying a partial total per measure; the
query joins those and combines the partials ([clickhouse-integration.md](../../reference/clickhouse-integration.md#worksheet-query-queryasync)).
Fields from both tables still pair up as in any join (a field of the other table that has several values per key shows each). Built for a view of
**exactly two tables**; the server refuses (400) a view of more tables with a flagged link, a calculated field, a top-N filter and an aggregation that
can't be recombined (distinct count, median, percentile, standard deviation, variance, Attr). Sum, Count, Count (non-null), Min, Max and Average work;
an average is the sum of sums over the sum of counts, so it is the average over rows. Approximate mode reads such a view exactly.
With no measure, the implicit count is the base table's row count (not the joined rows). A NULL key never matches, also in the "either table" filter.

**What this link does** swaps its "may be counted more than once" line for the two sentences above. Pure: `applyAggregate()`, `aggregateChoice()`,
`normalizeFilterDirection()` in `relation-rules.js`; the dialog control is `buildAggregateChoice()` in `relations.js`; browser check `tests/live/agg-ui.mjs`.

Not done: a view of more than two tables, calculations and top-N filters with it, and a per-field choice instead of a per-relationship one ([backlog](../../development/backlog/data-model.md)).

## Relationship suggestion (join safety preview)

The dialog's right panel suggests a cardinality from the data, with its evidence, as soon as it opens. It never blocks saving
or changes the choice by itself. Full detail: [relationship-suggestion.md](relationship-suggestion.md).

## What this link does (in the dialog)

The relationship dialog's right panel opens with **What this link does** (`.rel-sum`, built by `buildSummary()` in `relations.js`), above the data's Suggestion ([D142](../../decisions/decisions-design.md#d142--the-relationship-dialog-says-in-words-what-the-link-does-no-relationships-card)). It is a polite live region and is rewritten after every pick: Join, Cardinality, Totals, Filters and the key pairs, before anything is saved, from the dialog's own state (`describeRelationship()` over a relationship-shaped draft). There is no separate list of relationships on the Data Source: a link is opened by clicking its line or badge.

Each sentence names `table.column` (a compound key reads `orders.user_id + orders.day`) and says one thing:

- **How rows match:** "Many orders rows can match many users rows. Matched on orders.user_id and users.id." for N:M; "One orders row can match many users rows. …" for 1:N; two short sentences, who matches whom, then the key columns.
- **Which rows are shown:** "All orders rows, even with no match in users."; an inner join says "Only rows with a match. The others are left out."
- **Totals:** for 1:N and N:M without Totals, a caution: "Heads up: totals from orders may be counted more than once. Turn on Totals to count each once." With Totals on it says "Each table is totalled by the key first, so nothing is counted twice." and whether filtering one table also filters the other.

The text is written for people who skim: short lines, "row" and "match" only (no "join" or "cardinality" in the sentences), US-style "the other way around", and "totalled" as the Totals control says it. There are no section titles: each sentence says what it is about. Names are bold (`.rel-ref`, from the `refs` list `describeRelationship()` returns, set by `summaryLine()`); the one colour is the caution, in the warning ink, starting "Heads up:" (`tones` = `warn`), so colour never carries it alone. Sentences are 8px apart, and a 16px hairline separates the block from the Suggestion, as between the left sections. Under 640px the panel stacks under the controls. Wording is pure and unit-tested: `relation-describe.js` (`tests/js/relation-describe.test.mjs`); browser check `tests/live/agg-ui.mjs`.

## What cardinality means

`1:N` from A→B means "one row in A relates to many rows in B, matched on the chosen columns."
It drives the endpoint markers and the join direction.

It is **intent, not a data guarantee**. ClickHouse won't stop A's "one" side from having duplicates, so worksheet joins can fan out on the many side
([D12](../../decisions/decisions-platform.md#d12--subtabs-are-dashboards-over-one-shared-data-source)).
