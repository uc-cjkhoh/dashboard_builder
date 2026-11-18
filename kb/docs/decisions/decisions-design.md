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
