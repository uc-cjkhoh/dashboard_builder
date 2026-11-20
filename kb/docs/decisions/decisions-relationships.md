---
components: [src/DashboardBuilder/Features/Relations/join-check.js, src/DashboardBuilder/Features/Relations/join-preview-model.js, src/DashboardBuilder/Features/Relations/link-route.js, src/DashboardBuilder/Features/Relations/relations.js]
---
# Decisions — relationships on the Data Source

## D127 — A table pair holds one relationship; related in few steps

- **Amended 2026-11-18 (proposals on demand):** a proposed link is drawn only while the pointer or focus is on one of its cards, or after a click on one, except the one proposal of a model with no relationship yet. Why: with real links on the canvas, an always-drawn proposal crossed them and its pill covered one, and several proposals made a thicket of dashes before any link existed. Resting, it fades (opacity, no pointer events; never `hidden`, so the button stays in the Tab order). Rejected: hiding it with `hidden` (out of Tab order and the accessibility tree); routing proposals around real links (the crossing is forced when the two interleave in one gutter), which stays in the backlog.

- **Chosen:** the relationship is between two *tables*, holding one to four column pairs. Relating two more columns of tables that are already related
  adds a key pair to that relationship (no dialog, a toast) instead of making a second relationship. Shortcuts open the same dialog filled in:
  a proposed link (dashed line + **Relate on customer_id = id**) on each card that needs a partner, **Needs a partner**, a link button on
  every card (since D129 the drag is gone; since D132 so is the table picker, and Needs a partner is a plain label). The key comes from column names (`proposeKey`): a foreign key onto the other
  table's own key, else every same-named key column as a compound key. [relating-tables.md](../concepts/data-source/relating-tables.md).
- **Why:** users did not find the column drag (one pill at the foot said how), and a compound key took the dialog's last section: two selects and
  Add pair per column. Dragging a second column between related tables made a second, separate relationship, which looked like a compound key and was not.
- **Kept:** the stored shape (`from` / `to` + `pairs`, D79), so workbooks are unchanged; the first pair still draws the line. Nothing is saved without
  Confirm except the extra pair, which is the user's own drag. (Its Undo is superseded by [D133](decisions-destructive-actions.md#d133--no-undo-double-confirmation-before-every-destructive-delete): the app has no Undo.) Proposals use names only, are never saved, and can be closed.
- **Overrides:** D79's "extra pairs are added only in the dialog". A file with two relationships for one table pair still opens and joins as before.
- **Deferred:** a single **Match columns** list at the top of the dialog (the first pair no longer special); proposals from key or value signals;
  remembering a closed proposal.

## D129 — A card's actions sit in one ☰ menu

- **Chosen:** a Data Source card's head is the name, **Needs a partner** while shown, a ☰ button, the collapse caret and ✕. The ☰ opens the shared context
  popup (`openContextMenu`, `Core/menu.js`) under it with **Edit SQL** and **Preview data** (**Relate to another table** was here until D132) (a check item, ticked while the data
  preview shows the card). A union or unpivot card's menu holds Preview data only. [canvas.md § The ☰ menu](../concepts/data-source/canvas.md#the--menu-card-actions).
- **Why:** the user asked for it: three icon buttons (pencil, link, table) crowded the head and widened every card; one menu with words names each action.
- **How:** the popup lives on `<body>`, so canvas zoom never shrinks it and no card clips it. `openContextMenu` gained `onClose`, which keeps the ☰'s
  `aria-expanded` true while it is open; pressing the ☰ again closes it instead of reopening.
- **Overrides:** D127's link-button drag onto another card (the menu item can't be a drag source) and D128's "table button". Relating stays one click away
  through a proposed link; the column drag still works.
- **Rejected:** a menu list inside the card (`wireMenu`: scaled by zoom and clipped by neighbouring cards); keeping a draggable link button beside the ☰
  (the head would still carry an extra icon).

## D126 — Many links: a lane each, ordered to cross least; focus on hover; badges only on demand

- **Chosen:** links that turn in one gutter and overlap vertically each take their own lane (no limit; 8px apart, squeezed to 3px at least in a narrow gutter), ordered so each link adds the fewest crossings (`assignLanes`, `laneCrossings` in `link-route.js`). Hovering a link or a card with links fades every link it doesn't touch to 20 %. With 4 or more links below 125 % zoom (`quietBadges`), cardinality badges rest hidden and show on the hovered or focused links. [relationships.md](../concepts/data-source/relationships.md#rendering).
- **Why:** with more tables the old fixed 3-lane cycle put the 4th link exactly on the 1st, and one badge per link crowded the gutter, so which line went where could not be read.
- **Kept readable without the badge:** the end shapes (tick, crow's foot) still carry the cardinality at rest (golden rule 9), and the relationship dialog (one click on the link, [D142](decisions-design.md#d142--the-relationship-dialog-says-in-words-what-the-link-does-no-relationships-card)) says in words which rows the join shows. A badge is a fade (opacity, no pointer events), not a visibility toggle, so it animates in on hover.
- **Rejected for now (backlog-worthy):** bundling links from one card side into a trunk, obstacle-avoiding routing, an Arrange (auto-layout) button, table-level links when zoomed out, a relationships matrix view. Each is larger; the three chosen changes fix the stacking with no data-model change.

## D125 — The relationship dialog suggests a cardinality, with its evidence, as it opens

- **Chosen:** the join preview runs when the relationship dialog opens (new link and edit), not on a **Check this join** click. The right panel is a **Suggestion**: the cardinality the data reads as (`N:1 · many-to-one`), then notes and warnings, then the **Evidence**: why each side is one or many, the matched share of each table, and a counts table per side (rows read, NULL keys, distinct keys, keys found in the other table, rows with a match, most and average rows per key). Pure: `joinEvidence()`, `suggestionLabel()` in `join-preview-model.js`; DOM in `join-check.js`; [relationships.md](../concepts/data-source/relationship-suggestion.md).
- **It suggests and never decides** (golden rule 5): the dialog's choice is untouched; **Use N:1** only selects, "Matches your choice." when they agree, and Confirm saves whatever is chosen, error or not. A new link still starts from the key names (`guessCardinality`).
- **The comparison follows the live choice.** Each cardinality pick re-reads the last result with no new query, so the "declared one side repeats" warning now works on a new link too (it was blind there, since a new link had no saved cardinality). Warnings say "You chose" instead of "You declared".
- **Re-runs:** 300 ms after a key pair is added or removed, and on a refresh icon button (also the retry after an error). A newer run cancels an older one; closing the dialog cancels the request. A pending run drops the last result at once, so a cardinality pick never shows numbers read for the old key pairs.
- **A sample is worded as a sample:** the sampling note leads the notes card under the suggestion, the label says "from a sample", and a side with no repeat in the sample "looks like" the one side (a sample can show a repeat, never uniqueness).
- **Cost accepted:** every opening of the dialog runs one bounded, time-limited, read-only query (at most 1,000,000 rows per side, the same request the button sent). Opening a link to read it now costs a query; the evidence is the reason to open it.
- **Rejected:** applying the suggestion automatically (it would turn a sample's reading into the user's declaration, and on edit silently change a saved link); keeping the button and only adding evidence (the user asked for the suggestion shown by default); a server change for example keys (the existing counts carry the evidence).

## D132 — No Relate to another table menu item or table picker

- **Chosen:** the card's ☰ menu holds **Edit SQL** and **Preview data** only. **Relate to another table** and the **Relate X to** picker dialog behind it
  are gone, and **Needs a partner** is a plain label (it opened the same picker). Relating is a proposed link or the column drag.
- **Why:** the user found the menu item and its modal gave little information and did not need them: the picker restated what a proposed link already
  shows on the canvas (the table and the key).
- **Kept:** proposed links, `relateTables`, the relationship dialog, the column drag and keyboard pick, and the extra-pair drag (D127).
- **Overrides:** D127's table picker and Needs a partner as a button; D129's menu list.

