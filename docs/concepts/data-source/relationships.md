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
- **One relationship per column** (extra key pairs included). Kinds must match (number↔number, text↔text, date↔date, boolean↔boolean).
- **Every table card needs a partner** once there are two or more; an unrelated card is held out of worksheets.
- **Join type** is inner, left, right or full, worded with the table names.
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
   - a dashed muted outline (drop effect none) when it isn't.
3. A refused drop is reported (see [What may be linked](#what-may-be-linked)).
4. An allowed drop is checked first, then opens the join + cardinality dialog (`<dialog>`; cardinality is a radio group `name=cardinality`: `1:1 | 1:N | N:1 | N:M`).
   The dialog **starts on a cardinality read from the two column names** (`guessCardinality()`, `relation-rules.js`, pure): a column is
   its table's own key when it is `id` / `key` or `<table>_id` (singular or plural). A non-key column dropped on a key starts on **N:1**
   (`orders.customer_id` → `customers.id`), the reverse on **1:N**, key to key on **1:1**; names that say nothing start on 1:N.
5. Picking one draws the link. Cancelling changes nothing.

`link-drag.js` (pure) holds the payload parse and `dropDecision()`, which reuses `linkIssue()`.

To remove a link, click its badge, then Delete. A toast "Removed the orders → customers relationship." carries **Undo** (10 s),
which puts it back as it was unless the same pair was related again meanwhile.

**The how-to line.** While any table card has no relationship, a pill at the foot of the Data Source (`.rel-guide`) says
"Drag a column onto a column in another table to relate them." It goes once every card has one. While a toast shows (it owns the centre of the foot) the pill steps up to sit one 8px gap above it (`--toast-h`).

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

## What may be linked

`linkIssue()` in `relation-rules.js` (pure; `linkProblem()` is its message) blocks a link, with no cardinality dialog, when:

- both ends are on the **same table**;
- the same two columns are **already related** (either direction);
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
- **Shape-coded endpoints** (`.rel-end`) show cardinality without colour: a tick for "one", a crow's foot for "many", square to the card edge.
- **Colour:** resting links use `--ink-3`. A link is `--accent` while **hovered or being drawn**, and the two key rows it joins take the
  accent wash (`.col-row--linked`), so which columns a line connects reads at a glance. Only hover highlights: a selected link (clicked, with its dialog open) and keyboard focus draw no highlight of their own (focus keeps its ring).

**Routing** (`link-route.js`, pure)

- A link leaves a card's side straight out, turns at right angles and enters the other card straight in.
- Cards with a gutter of at least 32px face each other, and the link turns in the middle of the gutter, so its badge sits equally far from both cards.
- Closer or overlapping cards both use the right edge, and the link loops out past the farther one.
- Links sharing a gutter take lanes 8px apart: the first runs on the middle, the next two either side.
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

- A column in a relationship moves out of the scrolling list into the card's key strip above it (`.entity__keys`, accent wash).
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
- **Dialog layout.** The relationship dialog is landscape (`dialog.dialog--sm.dialog--rel`, up to 1216 px wide, never wider than the window less 16 px each side; golden ratio: its height is the width × 0.618, 752 px at full width, capped only by the window less 16 px top and bottom, and both panels stretch to that height so the suggestion panel scrolls in all of it (the body scrolls when the settings are taller); under 640 px it goes back to its content height with `height: fit-content`, the browser's modal default, because `auto` stretches a modal to the window; two equal panels, settings left and the suggestion with its evidence right, so the divider runs down the middle; the divider is an inset shadow so it adds no width; one column under 640 px).
  It shares the column profile's frame (`.col-profile`) without its cells: a head with the title **Relationship**, the two tables as a subtitle (`orders → customers`) and an X; a body on the colour wash that scrolls on its own while head and foot stay put; a 24 px side gutter shared by head, body and foot (the X sits on it); a foot with **Delete** (left, edit only), **Cancel** and the primary **Confirm**. Nothing inside the body closes the dialog: the cardinality buttons only select (`aria-pressed`), and **Confirm** saves cardinality, join, totals and key pairs together. Group headings (**Join**, **Totals**, **Also match on**, **Cardinality**) use one voice (600, `--ink-2`) with 24 px between groups.
  The left panel (`.rel-dialog__left`) has four `.rel-sec` sections straight on the wash, split by one hairline and 24 px of space, in this order: **Join**, **Cardinality**, **Totals** (a switch row) and **Also match on** (two selects and Add pair on one line). Join and Cardinality are the same control, built by `radioCards()`: one choice of four as radio cards in a 2 × 2 grid (`.choice-cards` / `.choice-card`, one column under 420 px). Each card is a bordered surface with a round radio and a bold name, no hint; the radio and the name are vertically centred in the card (`align-items: center`); the chosen card takes the accent border, the accent tint and a filled dot, so it never relies on colour alone. Cardinality's choices come from `cardinalityChoices()` (`relation-rules.js`): the kind in words with its code on one line, e.g. **One to many (1:N)** (the code is what the canvas badge and the suggestion show). Picking only selects; Confirm saves. DOM order is reading order.
  The right panel (`.rel-dialog__right`) holds the **Suggestion** and its evidence. It never makes the dialog taller: the row fills the golden-ratio body (`align-content: stretch`), `contain: size` keeps the panel's own text from stretching it, and the panel scrolls inside when its text is longer (one column under 640 px, where it flows normally). Its scrollbar is the thin themed one (`--line-2` thumb, accent on hover) in its own lane (`scrollbar-gutter: stable`, so nothing shifts when it appears), with a 16 px gutter between the content and that lane; the panel reaches 16 px into the body's side gutter so the lane sits there instead of narrowing the content.
  A dialog with no key data has no right panel. Built in `openCardinalityDialog()` (`relations.js`); styles in `relations.css`.
- Links re-route live on `entity:moved`.
- Removing an entity prunes its links, and `rel:changed` fires.

## Join type (P31, T02-12, T02-13)

The dialog's **Join** choice shows the SQL join names only, with no hint (the Relationships card says in words which rows are shown). It is one choice of four, so it is drawn as radio cards (2 × 2, one column under 420 px), not switches: a switch reads as "pick several". The chosen card has the accent border, tint and a filled dot. Cardinality uses the same cards. The link runs from the first-clicked key to the second, so the first table is the **left** side.

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
- **By hand.** Two selects (one per table, free columns only, each with its kind) and **Add pair**. A pair of different kinds, a column already
  in a relationship or an already matched column is refused with a line of text beside a warning icon (`addPair()`).
- **Remove.** Each added pair is a row `a = b` with a Remove button.
- **Keyboard.** Relate two columns [from the keyboard](#drawing-a-link--keyboard); the dialog then opens with focus inside it, and the
  suggestion buttons, selects (arrow keys), Add pair and Remove are all native controls reached with `Tab` and `Enter`.
- **On the canvas.** Every pair's columns are pinned in the key strips and take the accent wash; one line (the first pair) is drawn.
  The badge counts the keys ("N:1 · 2 keys", "N:1 · left · 3 keys").
- **In worksheets.** The join sends the extra pairs (`joins[].pairs`, swapped when the link is crossed second-to-first); the server ANDs them into `ON`
  ([clickhouse-integration.md](../../reference/clickhouse-integration.md#worksheet-query-queryasync)).
- **The suggestion** reads the pairs as they stand in the dialog and runs again (300 ms after the last change) when a pair is added or removed; the result names the key "a + b". A NULL in any part is a NULL key.
- **Saved** as optional `pairs` on the relationship ([workbook.md](../workbook/workbook.md)); a file without it is a one-pair link. On open, a malformed pair,
  one past the limit or one reusing a column already in a relationship is skipped with an import issue.

Not done: no pair added by dragging or relating two more columns of already-related tables.

## Aggregate before joining (many-to-many)

A join repeats a row of one table once per matching row of the other, so with a one-to-many or many-to-many link a sum or count over the repeated
side double-counts. The dialog's **Totals** section has a checkbox, **Total each table by the key before joining, so a total isn't repeated**
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

The Relationships card swaps its "may be counted more than once" line for the two sentences above. Pure: `applyAggregate()`, `aggregateChoice()`,
`normalizeFilterDirection()` in `relation-rules.js`; the dialog control is `buildAggregateChoice()` in `relations.js`; browser check `tests/live/agg-ui.mjs`.

Not done: a view of more than two tables, calculations and top-N filters with it, and a per-field choice instead of a per-relationship one ([backlog](../../development/backlog/data-model.md)).

## Relationship suggestion (join safety preview)

The dialog's right panel suggests a cardinality from the data, with its evidence, as soon as it opens. It never blocks saving
or changes the choice by itself. Full detail: [relationship-suggestion.md](relationship-suggestion.md).

## The Relationships card

A solid card (`.rel-notes`, a collapsible `<details>`, open by default) sits at the Data Source's top right, under the tab bar. It appears once there is
at least one relationship and lists each one as a dropdown (a nested `<details class="rel-note__more">`, closed by default, chevron right of the title). The
collapsed row is one line, `from → to · badge`, truncated with an ellipsis; opening it explains the link for a non-technical reader, every sentence naming `table.column` (a compound key reads `orders.user_id + orders.day`): what the cardinality means
("Many orders rows can match many users rows. Matched on orders.user_id and users.id." for N:M; "One orders row can match many users rows. …" for 1:N: two short sentences, who matches whom, then the key columns), which rows are shown ("All orders rows, even with no match in users."; an inner link says "Only rows with a match. The others are left out."), and — for 1:N and N:M — a caution ("Heads up: totals from orders may be counted more than once."). With aggregate-before-join it says "Each table is added up first, so nothing is counted twice." and whether filtering one table also filters the other. The text is written for people who skim: short lines, "row" and "match" only (no "join" or "cardinality"), US-style "the other way around". The closed row (`.rel-note__title`) names only the tables, `orders → users`; the kind ("one to many"), join type and key count are not repeated there, since "How rows match" and "Rows shown" say them (the canvas badge keeps the short `1:N · left`; `describeRelationship()` still returns `kind` from `kindWords()`). A closed row's title is vertically centred in its row (8px above and below): the hidden content slot is still a grid item, so `.rel-note__more:not([open])` drops the 8px grid gap that would otherwise sit under the title. Paragraphs are 16px apart (one line of air; 8px grid gap + 8px `.rel-note__part + .rel-note__part` margin), the title sits tight above its own text. Each paragraph sits under a short bold title naming its purpose — "How rows match", "Rows shown", then "Double counting" (the 1:N / N:M caution), or "No double counting" and "Filtering" (aggregate-before-join) — returned as `heads`, parallel to `sentences` and `tones`, and drawn by `notePart()` as a `.rel-note__label` above the paragraph (same ink as the card title; the title also lets the "Heads up:" caution read at a glance). There is no separate key line: the sentences carry the columns. Important words change text colour, never colour alone: table and column names are bold in the ok ink (`.rel-ref`, built by `noteLine()` from the `refs` list `describeRelationship()` returns); the double-counting caution is in the warning ink and starts "Heads up:" (`tones` = `warn`). No chips or boxes. Which entries are open survives re-renders (`openNotes` in `relations.js`). Hovering an entry lights its link and key rows like hovering the link; only the hovered entry is washed (selection does not).
The card is as tall as its text: opening a dropdown grows it, and the list scrolls inside only once the card would pass the bottom of the Data Source (`max-height: 100% - top bar - 2 × 16px`, so it stops 16px above the bottom edge). A `<details>` slots its content in one anonymous box, so `.rel-notes[open]::details-content { display: contents }` makes the list a flex child that can shrink (`flex: 0 1 auto; min-height: 0; overflow-y: auto`). The rule is scoped to `[open]`: a closed `<details>` hides its content through `content-visibility: hidden` on `::details-content`, which a `display: contents` box ignores, so an unscoped rule left the list showing after the header was clicked; a browser without `::details-content` falls back to a viewport-based cap on the list (`@supports not selector(::details-content)`). Browser check: `tests/live/rel-notes-ui.mjs`. The card's width fits the longest title (`width: max-content`, 288px minimum, capped to the Data Source's width minus gutters); the sentence lines take no intrinsic width, so opening a row never widens it — they wrap. Hidden on other tabs. Wording is pure and unit-tested: `relation-describe.js` (`tests/js/relation-describe.test.mjs`); the card is built by `renderNotes()` in `relations.js`.

## What cardinality means

`1:N` from A→B means "one row in A relates to many rows in B, matched on the chosen columns."
It drives the endpoint markers and the join direction.

It is **intent, not a data guarantee**. ClickHouse won't stop A's "one" side from having duplicates, so worksheet joins can fan out on the many side
([D12](../../decisions/decisions-platform.md#d12--subtabs-are-dashboards-over-one-shared-data-source)).
