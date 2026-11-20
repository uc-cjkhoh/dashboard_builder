---
components: [src/DashboardBuilder/Features/Core/core.css, src/DashboardBuilder/Features/Relations/relations.css]
---
# Decisions: design review outcomes

Visual-emphasis decisions that came out of reviewing a screen against a design standard. The design language itself is [D22](decisions-platform.md#d22--fluent-glass-design-language); the rules are in [design/index.md](../reference/design/index.md).

### D140 — The Data Source gives the next step the strongest mark: a card's ✕ rests muted and the key strip has no fill
A review against the 13 graphic design principles (2026-11-18) found the connected Data Source had no focal point: every card's ✕ was the same saturated red, every pinned key strip was a full-width olive fill, and the pending proposal was a 1px dashed pill, so nothing led.
- **How:** a card's ✕ (`.entity .iconbtn--danger`) rests in `--ink-3` like the ☰ and caret beside it and turns `--danger-ink` on hover and keyboard focus. The pinned key strip (`.entity__keys`) has no fill at rest: the rule beneath it, the accent name and its 600 weight mark a key, and the `--accent-soft` wash shows on hover and on the hovered link's rows. Dashboard widgets keep their always-red ✕.
- **Why:** red means danger (rule 7), not "the thing you can click most easily". Removing a card is rare, still asks twice (rule 12) and is named by the icon and its "Remove …" label; four always-red marks made danger the loudest thing on the canvas. A strip fill on every card repeated the proposal's accent.
- **Rejected:** a visible title above the canvas (design rule 6: the tab pill already names it); a key icon on each key row (a new icon and JS for what weight, colour and position already say); a new treatment for the proposal pill, because removing the competing marks was tried first (see [backlog](../development/backlog/data-source-hardening.md)).
- **Never colour alone:** the ✕ glyph and label carry the meaning at rest; a key is still told by position, weight and the rule, not only the accent.

### D142 — The relationship dialog says in words what the link does (no Relationships card)
The description of each relationship lived in a card at the Data Source's top right: first open over the canvas, then (this decision's first form) a corner button that opened a popover. It covered table cards or floated over them, and it was a second account of a link beside the dialog that edits it.
- **How:** the card, button and popover are gone. The relationship dialog's right panel opens with **What this link does** (`.rel-sum`): the plain sentences from `describeRelationship()`, rewritten after every pick (Join, Cardinality, Totals, Filters, key pairs) before anything is saved, above the data's Suggestion. A link is opened by clicking its line or badge (or a proposed link / the keyboard relate path), as before.
- **Why:** the sentences answer "what will this choice do" (an inner join's "Only rows with a match" is in no badge), which is a question asked while choosing, and the dialog is where the choosing happens. One place says it once; nothing sits over the cards at rest. The caution now ends with what to do ("Turn on Totals to count each once.") because the Totals control is beside it.
- **Trade-off:** the canvas no longer lists every relationship in words; to read one, open its dialog. The old popover was also the only text account of the links (the SVG links are click-only, so a screen-reader or keyboard user cannot list or open them: see "Edit and remove a relationship from the keyboard" in the [backlog](../development/backlog/data-source-hardening.md)).
- **Rejected:** the summary under the saved link only (it would describe the saved state while the controls show unsaved picks); a summary spanning the dialog above both panels (pushes the controls down).
- **Replaces:** the popover form of this decision and "open by default" in [relationships.md](../concepts/data-source/relationships.md#what-this-link-does-in-the-dialog). D141 was withdrawn before it landed and is not reused.

### D145 — Edit SQL's code uses three hues and the verdict's colours stay the verdict's
Strings were green (`--ok-ink`) and quoted names amber (`--warn-ink`), the same colours as "Valid query" and a warning, so a line of ordinary code read like a status. Syntax now uses keywords purple (bold), types teal and literals (strings, numbers, `true` / `false` / `null`) blue; names stay plain ink, comments muted italic.
- **Also:** the "ClickHouse SQL that will run" box, a permanent row in MySQL syntax that few people open, became a **ClickHouse SQL** toggle at the right of the verdict row (28 px tall for the pointer); the translated query still opens below the warnings, and by itself when ClickHouse refuses the translation. One chrome row instead of two in the idle dialog.
- **Why:** colour that means something (ok, warn, danger) should mean it everywhere on the screen; the verdict is the thing the eye is checking.
- **Rejected:** a monochrome editor (strings and names would blur together); keeping the box and only shortening its label (the row stays in the way).
