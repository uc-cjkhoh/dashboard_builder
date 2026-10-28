// Calculated fields — the "How this is computed" explainer text (pure, DOM-free; tests/js/eval-order.test.mjs).
// Six stages in the order the sheet is really evaluated; plain text generated from a summary of the sheet.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `s = { ownFilters, sharedFilters, drillDepth, hasPage, hasSelection, hasPeriod, hasTopFilter, rowLevelCalcs,
 *        aggregateCalcs, dimensions, displayCap, otherBucket, tableCalcs }`
 * Returns six `{ n, title, text }` entries.
 */
export function describeEvaluation(s) {
  const filters = [];
  if (s.ownFilters > 0) filters.push(`${s.ownFilters} own`);
  if (s.sharedFilters > 0) filters.push(`${s.sharedFilters} shared`);
  if (s.drillDepth > 0) filters.push(`drill ${plural(s.drillDepth, "level")}`);
  if (s.hasPage) filters.push("page");
  if (s.hasSelection) filters.push("selection");
  if (s.hasPeriod) filters.push("date range");
  if (s.hasTopFilter) filters.push("Top-N filter");
  const stage1 = filters.length === 0
    ? "No filters."
    : `ClickHouse first narrows the rows with ${filters.join(", ")}.`;

  const stage2 = s.rowLevelCalcs > 0
    ? `${plural(s.rowLevelCalcs, "row-level calculation")} ${s.rowLevelCalcs === 1 ? "is" : "are"} worked out for each remaining row.`
    : "There are no row-level calculations to work out.";

  const stage3 = s.dimensions.length > 0
    ? `Rows are grouped by ${s.dimensions.join(", ")}.`
    : "There are no dimensions, so all rows form a single group.";

  const stage4 = s.aggregateCalcs > 0
    ? `Each group is aggregated, including ${plural(s.aggregateCalcs, "aggregate calculation")}.`
    : "Each group is aggregated.";

  const stage5 = `Results are capped at ${s.displayCap} groups${s.otherBucket ? ", and the groups past the cap are combined into an Other bucket" : ""}.`;

  const stage6 = s.tableCalcs.length > 0
    ? `Table calculations (${s.tableCalcs.join(", ")}) run in the browser on the returned groups.`
    : "There are no table calculations to run in the browser.";

  return [
    { n: 1, title: "Filters", text: stage1 },
    { n: 2, title: "Row-level calculations", text: stage2 },
    { n: 3, title: "Group by", text: stage3 },
    { n: 4, title: "Aggregates", text: stage4 },
    { n: 5, title: "Cap and Other", text: stage5 },
    { n: 6, title: "Table calculations", text: stage6 },
  ];
}
