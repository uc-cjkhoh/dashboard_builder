// A text widget's inline edit — pure (tests/js/text-edit.test.mjs). Heading ≤ 80 characters and body ≤ 2 000 (LIMITS); both are
// plain text. The heading may be empty (the widget then reads "Text"); surrounding blanks are trimmed.
import { LIMITS, text } from "../Core/validate.js";

/** { heading, body } as typed → { ok: true, value: { heading, body } } or { ok: false, errors: { heading?, body? } }. */
export function validateTextEdit({ heading, body }) {
  const h = text(heading, { label: "The heading", max: LIMITS.widgetHeading });
  const b = text(body, { label: "The text", max: LIMITS.widgetBody });
  if (h.ok && b.ok) return { ok: true, value: { heading: h.value, body: b.value } };
  return { ok: false, errors: { ...(h.ok ? {} : { heading: h.error }), ...(b.ok ? {} : { body: b.error }) } };
}

/** Does saving `value` change the widget? (An unchanged save is not an undo step.) */
export const textChanged = (widget, value) => (widget.heading ?? "") !== value.heading || (widget.body ?? "") !== value.body;
