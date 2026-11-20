---
components: []
---
# Design review

The check that runs after every UI change, for the components the change touched. Four metrics, three ways of measuring them. The Stop hook (`design-gate.py`, [hooks.md](hooks.md)) asks for it whenever a turn changed what a user sees; anyone changing UI by hand follows the same steps.

| Metric | Measured by |
|---|---|
| 1. Design principles | The checklist [below](#1-the-13-principles), answered per component |
| 2. Theme match with the rest of the app | Static lint + the checklist [below](#2-theme-match), against the component's neighbours |
| 3. Component and nested-item misalignment | The probe: sibling and nested edges, gaps, rhythm |
| 4. Colour theme mismatch | The probe in every scheme, plus the lint's token rules |

## Procedure

1. **Name the targets.** The hook lists the BEM roots of the changed selectors (`.key-pairs`); add any component the change affects without a selector of its own.
2. **Lint** (automatic). `design-lint.py` runs after each Write/Edit and `design-gate.py` re-runs it over every line added this turn: colour literals, undefined tokens, spacing off 4 / 8 / 16 / 24, radius, font sizes, `style.display`. A deliberate exception takes a `design-lint-ignore` comment that says why.
3. **Render and probe.** Put the component on screen with the app's CDP harness ([testing.md](../how-to/testing.md), `tests/live/cdp.mjs`), in every state the change touches (open list, error, empty, long text), then:

   ```js
   import { designProbe, formatProbe } from './design-probe.mjs';
   console.log(formatProbe(await designProbe(ev, '.key-pairs', { sleep: b.sleep })));
   ```

   It runs in light, dark and the One Dark look. Run it at the narrowest and widest width the component ships at, and look at a screenshot of each scheme as well: the probe measures, it does not see.
4. **Answer the checklists** below, with the component next to a sibling that already ships.
5. **Fix, or accept with a reason.** Report per metric as `pass`, `fixed` or `accepted: <why>`. Nothing is `pass` unless it was measured or looked at.

## What the probe reports

| Rule | Flags | Tolerance |
|---|---|---|
| `align` | A child 0.5–3 px off its parent's content edge; siblings on one line that miss a shared centre, top or bottom by 0.5–3 px; stacked siblings 0.5–3 px off a shared left edge | 4 px and more reads as an indent, not a miss |
| `gap`, `rhythm` | Gaps between siblings off 0 / 1 / 2 / 4 / 8 / 16 / 24 px; three or more gaps that differ | Skipped under `space-*` justification and for flowing text |
| `colour` | Text, fill, border, SVG fill or stroke that matches no `:root` colour token in the active scheme | ±2 per channel, ±0.03 alpha |
| `contrast` | Text under 4.5:1 (3:1 from 24 px, or 18.66 px bold) over the real backdrop | Disabled and faded text skipped |
| `type`, `radius` | Font size off 14 / 16 / 24 / 32; radius other than 8 px, pill or 50% | |
| `overflow`, `target` | Clipping without an ellipsis, a component outside the window, a control under 24 px (a wrapping label counts as the target) | |
| truncated list | Text that ends in an ellipsis: confirm the full text is reachable (title, tooltip, wider container) | Information, not a failure |

A finding is evidence. A tint made with `color-mix()` reads as off-token; a label that sits closer to its field than its fields sit to each other is proximity, not uneven rhythm. Decide, and say which.

## 1. The 13 principles

After [Figma's graphic design principles](https://www.figma.com/resource-library/graphic-design-principles/). Answer each for the targeted component; `n/a` needs a one-line reason.

| Principle | Ask of the component |
|---|---|
| Alignment | Do text and controls share a left edge or baseline, nested items included? (probe `align`) |
| Contrast | Is the primary value or action distinct from secondary text by size, weight or colour? |
| Balance | Does one side carry all the weight (dark fills, large icons, charts)? |
| Hierarchy | Is the most important value or heading the boldest or largest thing in it? |
| Color | Is any state carried by colour alone, with no icon or words? (golden rule 9) |
| White space | Are gaps between siblings one token, not varying per item? (probe `gap`) |
| Proportion | Do sizes follow a deliberate scale, heading to body? (probe `type`) |
| Repetition | Do like items share font, radius and padding with their siblings elsewhere in the app? |
| Rhythm | Are repeated rows or tiles at a regular interval? (probe `rhythm`) |
| Movement | Does the eye meet the important element first, left to right and top to bottom? |
| Emphasis | Is there exactly one focal element? Is red reserved for danger? |
| Proximity | Is each label nearer its own field than the next one, with more space between groups? |
| Unity | Do fonts, colours and shapes all come from the shared tokens? |

## 2. Theme match

Compare with a sibling that already ships (same dialog, panel or toolbar), not with the brief. Rules: [index.md](../reference/design/index.md), [tokens.md](../reference/design/tokens.md), [components.md](../reference/design/components.md).

- Is it built from an existing component class (`.btn`, `.select`, `.menu__*`, `.choice-card`) before a new one?
- Same radius (`--r`), border weight and edge colour as its neighbours? One accent, no new hue?
- Does it hold up with the sidebar open and shut, and at the dialog's stacked width (under 880 px)?
- Does the page still never scroll, with panels scrolling inside ([layout.md](../reference/design/layout.md))?
- Is state shown with icon, words and colour, and is hover, focus, disabled and error each drawn?
- Does it copy the neighbours' motion tokens, with no motion under `prefers-reduced-motion`?

## 3. Colour theme

- Probe `colour` and `contrast` empty in light, dark **and** One Dark. A finding marked `[only: dark]` is a token that is wrong or missing in that scheme.
- No literal in markup, script or a rule: tokens only (golden rule 7). New tokens go in `core.css` `:root` and in both dark blocks.
- Status colours keep their meaning: red is danger, nothing else.

## Reporting

End the reply with a `Design check:` section: one line per metric (principles, theme match, alignment, colour), each `pass`, `fixed` or `accepted: <why>`, naming the components, schemes and widths measured. If the probe or a screenshot could not run, say so instead of claiming a pass.
