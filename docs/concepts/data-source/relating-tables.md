---
components: [src/DashboardBuilder/Features/Relations/relations.js, src/DashboardBuilder/Features/Relations/key-pairs.js, src/DashboardBuilder/Features/Relations/link-drag.js, src/DashboardBuilder/Features/Canvas/canvas.js]
---
# Relating two tables in few steps

Shortcuts to the relationship dialog of [relationships.md](relationships.md), so a relationship needs no knowledge of the column drag
([D127](../../decisions/decisions-relationships.md#d127--a-table-pair-holds-one-relationship-related-in-few-steps), [D132](../../decisions/decisions-relationships.md#d132--no-relate-to-another-table-menu-item-or-table-picker)). Every path ends in the same
dialog, and nothing is saved until **Confirm** (golden rule 5).

| Path | Steps |
|---|---|
| A proposed link: click **Relate on customer_id = id** | 1 click, then Confirm |
| Drag one more column of related tables onto the other | 1 drag; added at once |
| Drag a column onto a column ([relationships.md](relationships.md#drawing-a-link--drag-a-column)) | 1 drag, then Confirm |

## The key the names point to

`proposeKey(a, b, used)` in `key-pairs.js` (pure, `tests/js/relate-tables.test.mjs`) reads only column names and kinds. Columns already in a
relationship are skipped. In order:

1. **A foreign key onto the other table's own key**, either way round: `orders.customer_id` → `customers.id` (or `customers.customer_id`).
   The column is `<table>_id` / `<table>id` / `<table>_key` for the other table's name, singular or plural; the target is that table's own
   key (`isOwnKey`: `id`, `key`, `<table>_id`). Score 3, confident.
2. **Same-named key columns**, every one: `store_id = store_id` and `sku_code = sku_code` make one compound key (first pair plus up to three).
   A key column ends in `id`, `key`, `code`, `no` or `num` after `_`, `-`, a space or a camel-case capital (`isKeyish`); a bare `id` or `key` never matches
   another bare `id` (every table has one). Score 2, confident.
3. **Any same-named, same-kind column** (`suggestPairs`): the first one only. Score 1, not confident.

Only a confident key is proposed on the canvas. Any key may open the dialog; other same-named columns are still offered there as
**+ Add day = day** buttons. Cardinality starts from the names (`guessCardinality`), and the suggestion panel reads the data as usual.

## Proposed links

- For each card that **Needs a partner**, the confident key to another card with the highest score is drawn: a dashed accent line (`.rel-ghost__line`)
  between the two key rows, taking a lane like a real link, and a pill (`.rel-ghost`) with **Relate on customer_id = id** (`.rel-ghost__go`) and a close
  button (`.rel-ghost__no`). One proposal per table pair.
- The pill sits on the line's middle run when it fits; it is wider than most gutters, so usually it sits 16px under the lower of the two cards, centred on
  the gap, stepping down past another pill.
- Click (or Enter) opens the dialog filled with that key. Close hides that pair's proposal until the page reloads.
- The pill is HTML over the cards, so it is reached with Tab; it is kept across redraws so focus stays on it. Text plus a dashed line, never colour alone.
- Gone once the card is related. A proposal is not a relationship: worksheets don't see it.

## "Needs a partner"

- **Needs a partner** (`.entity__need`) is a plain label (a `span`, warning ink) beside the title while the card is in no relationship, with the dashed
  card outline. It does nothing on click: the way out is the card's **proposed link** above, or a column drag.
- There is no **Relate to another table** item in the ☰ menu and no table picker: it listed the other tables with a key each, which a proposed link
  already says on the canvas ([D132](../../decisions/decisions-relationships.md#d132--no-relate-to-another-table-menu-item-or-table-picker)).
- A table with no same-named key column gets no proposal; relate it by dragging a column onto a column ([relationships.md](relationships.md#drawing-a-link--drag-a-column)).

## One more column of related tables

A table pair holds one relationship. Dragging (or relating from the keyboard) a free column of one onto a free column of the other adds a key pair to
that relationship instead of making a second one (`dropDecision` returns `extend`, `link-drag.js`):

- No dialog: the pair is added, oriented to the relationship's sides (`pairFor`), and a toast says "Added region = region to orders → customers (2 keys)."
  To take the pair out, open the relationship and remove it there.
- The usual refusals come first (kinds differ, column already in a relationship). A fifth pair is refused: "orders and customers already match on 4 columns,
  the most a relationship can."
- The keyboard status line says "Press Enter to also match it on customers.region (one more key column)."
- The badge counts the keys (`N:1 · 2 keys`) and both columns are pinned in the key strips.

Browser check: `tests/live/relate-tables-ui.mjs` (also writes the screenshots used in the demo).

## Limits

- A workbook saved before this rule may hold two relationships between one table pair; it opens unchanged and both still join.
- Names only: no primary-key, sorting-key or value-overlap signal; dismissed proposals come back on reload. See the [backlog](../../development/backlog/data-model.md).
