// Showing all of a large result without asking for it all at once — pure, DOM-free (unit-tested in
// tests/js/scale-model.test.mjs):
//  • the Table view loads a page at a time as it scrolls, and knows the total ("of N rows");
//  • a one-dimension bar / pie / donut / treemap folds everything past its limit into one "Other" mark;
//  • charts group a long date/time axis by a calendar grain (Format → Group dates, "auto" by default).
import { LIMITS } from "../Core/validate.js";

/** Rows per Table page. */
export const TABLE_PAGE = 500;
/** Chart types that show an "Other" mark for groups past the limit (one category axis, additive marks). */
export const OTHER_TYPES = new Set(["bar", "pie", "donut", "treemap"]);
/** Chart types whose date/time axis is grouped by Format → Group dates. */
export const BUCKET_TYPES = new Set(["bar", "stacked", "line", "area", "combo", "heatmap", "pie", "donut", "treemap", "kpi",
  "waterfall", "funnel", "bullet", "multiples", "gantt"]);
/** Format → Group dates choices, in menu order. */
export const DATE_BUCKET_CHOICES = [["auto", "Auto"], ["exact", "Exact"], ["hour", "Hour"], ["day", "Day"],
  ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]];

/**
 * The paging / Other / date-grouping part of a worksheet query plan.
 * @param chartType the sheet's chart type
 * @param format the sheet's format (topN, dateBucket)
 * @param dimCount dimensions in the query (rows + columns)
 */
export function scalePlan(chartType, format = {}, dimCount = 0) {
  if (chartType === "table") return { limit: TABLE_PAGE, offset: 0, withTotal: true };
  const plan = { limit: format.topN ?? LIMITS.rows };
  if (OTHER_TYPES.has(chartType) && dimCount === 1) plan.otherBucket = true;
  const bucket = format.dateBucket ?? "auto";
  if (BUCKET_TYPES.has(chartType) && bucket !== "exact") plan.dateBucket = bucket;
  return plan;
}

/** The label of the "Other" mark. */
export const otherLabel = (groups) => `Other (${Number(groups).toLocaleString("en-US")} more)`;

/**
 * Rows plus one "Other" row (keys: [label], values: the server's aggregates) when the result has one;
 * `isOther` marks it so clicks and colours can treat it apart.
 */
export function withOther(rows, other) {
  if (!other || !(other.groups > 0)) return rows;
  return [...rows, { keys: [otherLabel(other.groups)], values: other.values, isOther: true }];
}

/** The notice for a grouped date axis, or null. */
export const bucketNotice = (bucket) => (bucket?.grain ? `Dates grouped by ${bucket.grain} — set Group dates in Format to change.` : null);

/** The Table's progress line: how many rows are loaded out of how many. */
export function tableProgress(loaded, total) {
  const n = (v) => Number(v).toLocaleString("en-US");
  if (total == null) return null;
  if (loaded >= total) return `${n(total)} row${total === 1 ? "" : "s"}`;
  return `Rows 1–${n(loaded)} of ${n(total)} — scroll to load more`;
}

/** Should the Table fetch its next page? Near the bottom (within `margin` px) and more to load. */
export function needsNextPage({ scrollTop, clientHeight, scrollHeight }, loaded, total, margin = 400) {
  if (total == null || loaded >= total) return false;
  return scrollTop + clientHeight >= scrollHeight - margin;
}
