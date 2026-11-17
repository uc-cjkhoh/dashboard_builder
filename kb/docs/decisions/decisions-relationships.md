---
components: [src/DashboardBuilder/Features/Relations/join-check.js, src/DashboardBuilder/Features/Relations/join-preview-model.js, src/DashboardBuilder/Features/Relations/link-route.js, src/DashboardBuilder/Features/Relations/relations.js]
---
# Decisions — relationships on the Data Source

## D127 — A table pair holds one relationship; related in few steps

- **Chosen:** the relationship is between two *tables*, holding one to four column pairs. Relating two more columns of tables that are already related
  adds a key pair to that relationship (no dialog, a toast with Undo) instead of making a second relationship. Shortcuts open the same dialog filled in:
  a proposed link (dashed line + **Relate on customer_id = id**) on each card that needs a partner, **Needs a partner** as a button, a link button on
  every card (click for a table picker, or drag onto another card). The key comes from column names (`proposeKey`): a foreign key onto the other
  table's own key, else every same-named key column as a compound key. [relating-tables.md](../concepts/data-source/relating-tables.md).
- **Why:** users did not find the column drag (one pill at the foot said how), and a compound key took the dialog's last section: two selects and
  Add pair per column. Dragging a second column between related tables made a second, separate relationship, which looked like a compound key and was not.
- **Kept:** the stored shape (`from` / `to` + `pairs`, D79), so workbooks are unchanged; the first pair still draws the line. Nothing is saved without
  Confirm except the extra pair, which is the user's own drag and has Undo. Proposals use names only, are never saved, and can be closed.
- **Overrides:** D79's "extra pairs are added only in the dialog". A file with two relationships for one table pair still opens and joins as before.
- **Deferred:** a single **Match columns** list at the top of the dialog (the first pair no longer special); proposals from key or value signals;
  remembering a closed proposal.

## D126 — Many links: a lane each, ordered to cross least; focus on hover; badges only on demand

- **Chosen:** links that turn in one gutter and overlap vertically each take their own lane (no limit; 8px apart, squeezed to 3px at least in a narrow gutter), ordered so each link adds the fewest crossings (`assignLanes`, `laneCrossings` in `link-route.js`). Hovering a link, a Relationships card entry or a card with links fades every link it doesn't touch to 20 %. With 4 or more links below 125 % zoom (`quietBadges`), cardinality badges rest hidden and show on the hovered or focused links. [relationships.md](../concepts/data-source/relationships.md#rendering).
- **Why:** with more tables the old fixed 3-lane cycle put the 4th link exactly on the 1st, and one badge per link crowded the gutter, so which line went where could not be read.
- **Kept readable without the badge:** the end shapes (tick, crow's foot) still carry the cardinality at rest (golden rule 9), and the Relationships card lists every join with its join type. A badge is a fade (opacity, no pointer events), not a visibility toggle, so it animates in on hover.
- **Rejected for now (backlog-worthy):** bundling links from one card side into a trunk, obstacle-avoiding routing, an Arrange (auto-layout) button, table-level links when zoomed out, a relationships matrix view. Each is larger; the three chosen changes fix the stacking with no data-model change.

## D125 — The relationship dialog suggests a cardinality, with its evidence, as it opens

- **Chosen:** the join preview runs when the relationship dialog opens (new link and edit), not on a **Check this join** click. The right panel is a **Suggestion**: the cardinality the data reads as (`N:1 · many-to-one`), then notes and warnings, then the **Evidence**: why each side is one or many, the matched share of each table, and a counts table per side (rows read, NULL keys, distinct keys, keys found in the other table, rows with a match, most and average rows per key). Pure: `joinEvidence()`, `suggestionLabel()` in `join-preview-model.js`; DOM in `join-check.js`; [relationships.md](../concepts/data-source/relationship-suggestion.md).
- **It suggests and never decides** (golden rule 5): the dialog's choice is untouched; **Use N:1** only selects, "Matches your choice." when they agree, and Confirm saves whatever is chosen, error or not. A new link still starts from the key names (`guessCardinality`).
- **The comparison follows the live choice.** Each cardinality pick re-reads the last result with no new query, so the "declared one side repeats" warning now works on a new link too (it was blind there, since a new link had no saved cardinality). Warnings say "You chose" instead of "You declared".
- **Re-runs:** 300 ms after a key pair is added or removed, and on a refresh icon button (also the retry after an error). A newer run cancels an older one; closing the dialog cancels the request. A pending run drops the last result at once, so a cardinality pick never shows numbers read for the old key pairs.
- **A sample is worded as a sample:** the sampling note leads the notes card under the suggestion, the label says "from a sample", and a side with no repeat in the sample "looks like" the one side (a sample can show a repeat, never uniqueness).
- **Cost accepted:** every opening of the dialog runs one bounded, time-limited, read-only query (at most 1,000,000 rows per side, the same request the button sent). Opening a link to read it now costs a query; the evidence is the reason to open it.
- **Rejected:** applying the suggestion automatically (it would turn a sample's reading into the user's declaration, and on edit silently change a saved link); keeping the button and only adding evidence (the user asked for the suggestion shown by default); a server change for example keys (the existing counts carry the evidence).
