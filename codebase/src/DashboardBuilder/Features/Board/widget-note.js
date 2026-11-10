// A worksheet widget's note — pure, DOM-free (tests/js/widget-note.test.mjs). An optional `note` string on a sheet widget (at most
// LIMITS.widgetNote characters, client-side only; specification text, never data). Over the limit is rejected, never cut. Shown with
// textContent only, and listed in the dashboard's print header.
import { LIMITS, text } from "../Core/validate.js";

/** A note as typed -> { ok, value } | { ok, error }. Empty is fine. */
export function validateWidgetNote(raw) {
  if (typeof raw !== "string") return { ok: false, error: "The note must be text." };
  return text(raw, { label: "The note", max: LIMITS.widgetNote });
}

/** Import: a saved widget `note` -> a string. Absent is empty; one `validateWidgetNote` refuses is dropped with an issue (rejected, not cut). */
export function cleanWidgetNote(raw, where, issues) {
  if (raw == null) return "";
  const r = validateWidgetNote(raw);
  if (!r.ok) { issues.push(`${where}: a worksheet widget's note was ignored (${r.error.replace(/\.$/, "")}).`); return ""; }
  return r.value;
}

/** The print-header lines for the widgets' notes: "Note on <worksheet>: <note>", reading order (top to bottom, left to right). */
export function widgetNoteLines(widgets, nameOf) {
  return widgets.filter((w) => w.kind === "sheet" && w.note)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((w) => `Note on ${nameOf(w) ?? "a closed worksheet"}: ${w.note}`);
}
