---
components: [src/DashboardBuilder/Features/Calc/group-dialog.js, src/DashboardBuilder/Features/Calc/group-model.js, tests/live/group-smoke.mjs, tests/live/labels-ui.mjs]
---
# Calculated fields — group fields

A group field is a calculation whose tree is generated, not parsed. The rest of the feature: [calculated-fields.md](calculated-fields.md).

A field's **⋯** menu has **Group…** (T02-30). It puts a text, whole-number or true/false column's members into named groups, saved as a **group calculation**: `{ id, name: "region (groups)", formula: "", group: { field, kind?, groups: [{ name, members }] } }`. `kind` is absent for text, `"number"` or `"boolean"`; the result is always text.

### The Group dialog

Code: `group-dialog.js`; rules in `group-model.js`.

- It names the field and adds groups (≤ 50, 1–80 characters, unique).
- Each member (the field's top 200, from the distinct-values read; NULL is skipped; see the NULL label) goes in a group or stays **not grouped**. A true/false field lists exactly `false` and `true` (not the server's `False` / `True` text); a whole-number field lists its values as the server writes them, and a member must read as an integer.
- **Label ungrouped members** (optional, default "Other", ≤ 80 characters) folds every ungrouped non-NULL member into that one label; NULL stays NULL. The 80-character cap is client-side, like group names; the server accepts up to 100. The label may not be a group's name or an ungrouped member.
- **Label empty (NULL) values** (optional, default "(none)", ≤ 80 characters; saved as `group.nullLabel`) shows the empty value under that label. A label equal to a group's name puts NULL into that group; it may not equal an ungrouped member. [D94](../../decisions/decisions-calculated-fields.md).
- **Cancel / Esc:** an untouched dialog closes at once; one whose name, groups, assignments or labels changed asks twice before dropping the draft (`confirmDeleteTwice`, "Discard your changes to these groups?", rule 12), and answering no keeps the dialog and its draft. The comparison is `groupDraftKey()` in `group-model.js`. Browser check: `tests/live/labels-ui.mjs`.
- **Refused:**
  - date fields; decimal and floating-point fields (the member list writes `Decimal(10,2)` as `1.50` but ClickHouse's `toString` gives `1.5`, so a listed member would never match; pinned by `tests/live/group-smoke.mjs`); UUID, IP address and enum columns (the engine compares text only; ClickHouse has no common type for those, same smoke);
  - a group name equal to a member that stays ungrouped (it would merge their rows).

### Using a group field

It is an ordinary calculated dimension afterwards: a chip in the pane (Edit… reopens this dialog, Duplicate copies the groups), a pill, and a text value in formulas (`[region (groups)]`).

- A member in no group keeps its own value (without the label). NULL stays NULL unless the NULL label is on.
- A group-calculation pill takes no click-selection ([D33](../../decisions/decisions-calculated-fields.md#d33--calculated-fields-are-refused-wherever-a-plain-column-is-assumed)), and member labels do not apply to it.

### How it compiles

- `compileCalculation` takes the tree straight from `groupTree`, never formula text, so the 500-character limit does not apply.
- The tree is `CASE WHEN member = 'a' OR … THEN 'Group' … ELSE <the field> END`: one WHEN per group, each an OR (balanced, so shallow) of `=` against `str` literals. These are bound parameters; nothing is quoted into SQL.
- With a NULL label, a **first** `WHEN isnull(field) THEN '<label>'` is added (3 nodes).
- With the label on, a last `WHEN NOT isnull(field) THEN '<label>'` is added.
- **Whole-number fields** read the column as `TEXT(field)` in every comparison and in the `ELSE`, so members stay exact text; no server change.
- **True/false fields:** `TEXT()` refuses a boolean, so a group tests the column itself (`field` for true, `NOT field` for false) and the `ELSE` is a small `CASE` that reads the value back as `'true'` / `'false'`; NULL fails both tests and stays NULL. A field has at most two members.
- **Size limit:** the **node limit (200)** bounds it at 2 + 4 nodes per member — **49 members across all groups**, **48** with the remainder label or the NULL label, **47** with both (`maxMembersFor`); a whole-number field costs 3 + 5 per member (**39**, **38** with the label). The dialog footer reads `0 of 5 members grouped · 0 groups · up to 49 allowed` (listed members, then the limit), says `over the limit` and disables Save, and the server refuses a bigger tree too.
- Code: `Calc/group-model.js`.
