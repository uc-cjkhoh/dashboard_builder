---
components: [src/DashboardBuilder/Features/Relations/join-check.js, src/DashboardBuilder/Features/Relations/join-preview-model.js]
---
# Decisions — relationships on the Data Source

## D125 — The relationship dialog suggests a cardinality, with its evidence, as it opens

- **Chosen:** the join preview runs when the relationship dialog opens (new link and edit), not on a **Check this join** click. The right panel is a **Suggestion**: the cardinality the data reads as (`N:1 · many-to-one`), then notes and warnings, then the **Evidence**: why each side is one or many, the matched share of each table, and a counts table per side (rows read, NULL keys, distinct keys, keys found in the other table, rows with a match, most and average rows per key). Pure: `joinEvidence()`, `suggestionLabel()` in `join-preview-model.js`; DOM in `join-check.js`; [relationships.md](../concepts/data-source/relationship-suggestion.md).
- **It suggests and never decides** (golden rule 5): the dialog's choice is untouched; **Use N:1** only selects, "Matches your choice." when they agree, and Confirm saves whatever is chosen, error or not. A new link still starts from the key names (`guessCardinality`).
- **The comparison follows the live choice.** Each cardinality pick re-reads the last result with no new query, so the "declared one side repeats" warning now works on a new link too (it was blind there, since a new link had no saved cardinality). Warnings say "You chose" instead of "You declared".
- **Re-runs:** 300 ms after a key pair is added or removed, and on a refresh icon button (also the retry after an error). A newer run cancels an older one; closing the dialog cancels the request. A pending run drops the last result at once, so a cardinality pick never shows numbers read for the old key pairs.
- **A sample is worded as a sample:** the sampling note sits above the suggestion, the label says "from a sample", and a side with no repeat in the sample "looks like" the one side (a sample can show a repeat, never uniqueness).
- **Cost accepted:** every opening of the dialog runs one bounded, time-limited, read-only query (at most 1,000,000 rows per side, the same request the button sent). Opening a link to read it now costs a query; the evidence is the reason to open it.
- **Rejected:** applying the suggestion automatically (it would turn a sample's reading into the user's declaration, and on edit silently change a saved link); keeping the button and only adding evidence (the user asked for the suggestion shown by default); a server change for example keys (the existing counts carry the evidence).
