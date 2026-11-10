// Dashboard data notes — pure, DOM-free (tests/js/board-notes.test.mjs). A dashboard carries one free-text note (`notes`, at most
// LIMITS.dashboardNotes characters; client-side only, stored in the workbook as specification text, never data). Over the limit is rejected,
// never cut. The note is shown with textContent only. The print header lines are built here too.
import { LIMITS, text } from "../Core/validate.js";

/** A note as typed -> { ok, value } | { ok, error }. Empty is fine. */
export function validateNotes(raw) {
  if (typeof raw !== "string") return { ok: false, error: "The notes must be text." };
  return text(raw, { label: "The notes", max: LIMITS.dashboardNotes });
}

/** Import: saved `notes` -> a string. Absent is empty; anything `validateNotes` refuses is dropped with an issue (rejected, not cut). */
export function cleanNotes(raw, where, issues) {
  if (raw == null) return "";
  const r = validateNotes(raw);
  if (!r.ok) { issues.push(`${where}: the saved notes were ignored (${r.error.replace(/\.$/, "")}).`); return ""; }
  return r.value;
}

/** The saved fragment: `{ notes }` when there is a note, `{}` otherwise. */
export const savedNotes = (notes) => (typeof notes === "string" && notes ? { notes } : {});

/** The lines a dashboard's print header shows under its title, only those present: the worksheets, the selection filter, the print time, the widget notes, the note. */
export function printLines({ sheets, filter, printedAt, widgetNotes, notes }) {
  const lines = [];
  if (sheets?.length) lines.push(`Worksheets: ${sheets.join(", ")}`);
  if (filter) lines.push(`Filtered by ${filter}`);
  if (printedAt) lines.push(printedAt);
  if (widgetNotes?.length) lines.push(...widgetNotes);
  if (notes) lines.push(notes);
  return lines;
}
