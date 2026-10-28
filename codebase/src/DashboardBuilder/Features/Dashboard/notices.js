import { resolveRange, rangeLabel } from "./period-model.js";
import { approxNotice } from "./speed-notice.js";
import { checkFilter } from "./filter-rules.js";

// The one-line notices under a worksheet (period range, approximate / cached result, skipped filters), as pure text
// builders. worksheet-view.js re-exports them.

/** Notices join with " · "; null when none. */
export const joinNotices = (...parts) => parts.filter(Boolean).join(" · ") || null;

/** The range line for the notice: "1 Sep – 30 Sep 2026 vs 2 Aug – 31 Aug 2026". */
export function periodNotice(s, cmp) {
  const range = s.period ? resolveRange(s.period) : null;
  if (!range) return s.period ? "Date range not applied — pick both days." : null;
  return `${rangeLabel(range)}${cmp ? ` vs ${rangeLabel(cmp.range)}` : ""}`;
}

/** P33: say when a result is approximate or came from the server's cache. */
export function speedNotice(result, plan) {
  const parts = [];
  if (result.approx) parts.push(approxNotice(result.approx, plan.measures));
  if (result.cached) parts.push("From the server cache (under a minute old) — Refresh re-runs it");
  return parts.join(" · ") || null;
}
/** Invalid filters are skipped by the query, so say so. */
export function invalidFilterNotice(sheet) {
  const n = sheet.filters.filter((f) => checkFilter(f).state === "invalid").length;
  return n ? `${n} filter${n === 1 ? "" : "s"} not applied — fix the highlighted value.` : null;
}
