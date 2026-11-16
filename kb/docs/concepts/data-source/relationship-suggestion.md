---
components: [src/DashboardBuilder/Features/Relations/join-check.js, src/DashboardBuilder/Features/Relations/join-preview-model.js, src/DashboardBuilder/ClickHouse/JoinPreview.cs]
---
# Relationship suggestion (join safety preview)

Part of the relationship dialog ([relationships.md](relationships.md)).

The relationship dialog (new link and edit) shows a **Suggestion** in its right panel as soon as it opens ([D125](../../decisions/decisions-relationships.md#d125--the-relationship-dialog-suggests-a-cardinality-with-its-evidence-as-it-opens)).
It makes one bounded, read-only call (`POST /api/relationships/preview`, [api.md](../../reference/api.md#relationship-preview))
that reads at most the first 1,000,000 rows of each table. Pure wording: `join-preview-model.js`; DOM: `join-check.js`.

**When it runs.** On open (a busy note "Checking the data…" first), again 300 ms after a key pair is added or removed, and on the
refresh icon button beside the heading (`.join-check__rerun`, "Check the data again"; also the way to retry after an error). A newer
run cancels an older one, and closing the dialog cancels the request. Picking a cardinality sends nothing: the panel re-reads the last
result against the new choice (`redescribe()`), so warnings and the **Use** button follow the live choice, on a new link too.

**What it shows**, top to bottom:

- **Suggested cardinality**: the shape the data shows as a headline, `N:1 · many-to-one` (`1:1`, `1:N`, `N:1`, `N:M`; the first letter
  is the first table). Under it, a green "Matches your choice." note (check icon) or a **Use N:1** button that only selects. It never
  changes the choice by itself, on a new link or an edit. A new link still starts from the key names (`guessCardinality`).
- **Notes and warnings** (below), sampling note first.
- **Evidence**: one line per side saying why it reads as one or many, tagged **One** or **Many** in words ("cust_id repeats in orders:
  up to 14 rows for one key (about 5 on average), so orders is the "many" side."); two **Match** lines with each table's matched share
  ("94% of the rows in orders have a match in customers; 6% don't"); then a counts table, one column per side (`table.column`): rows read,
  rows with no key (NULL), distinct keys, keys found in the other table, rows with a match, most rows for one key, average rows per key.
  Pure: `joinEvidence()`, `suggestionLabel()`. An empty table gives no evidence, only its note.
- A one-line hint: "Read from a bounded sample of each table. Any choice can be saved."

**Sampled results** (a side reached the row bound):

- The note comes first: "Based on the first N rows of each table, in no particular order".
- The shares are worded "within the sample".
- Nothing that needs the two slices to overlap is raised as a warning. "No keys match" becomes a neutral "can't tell from a sample" note,
  and keys repeating on both sides becomes "may be many-to-many".
- A declared "one" side whose keys repeat still warns, because a repeat is a fact about that table.
- The preview reads each table twice (its own stats, and as the other side's key set) with no `ORDER BY`, so on a table being written to the two reads can differ.

**Warnings** (icon + text, amber) never block saving; the relationship stays the user's declaration. They are:

- keys repeat **materially** on **both** sides — an average of at least 1.1 rows per key on each (`MATERIAL_AVG`).
  Many-to-many fan-out means sums and counts can double-count. A lone stray duplicate is only a note.
  This is one combined warning that also names a conflicting declaration.
- a side declared "one" whose keys repeat. Edit dialog only: a new link has no declaration yet, so it gets the reading instead.
- no keys match at all.

**States:**

- While running, the button is disabled and a busy note shows.
- The result area is an always-present `role="status"` region.
- A failure shows the server message with an error icon. Examples: incompatible key kinds, ClickHouse refusing to compare the two types (a plain 400), or a timeout.
- Closing the dialog cancels the request.

Not done: no hint on the drawn line, and nothing is saved with the relationship.
