import { roleOf } from "./show-me-rules.js";
import { checkFilter, serverFilter } from "./filter-rules.js";
import { withParamValue, effectiveTopN } from "../Core/parameters-model.js";
import { LIMITS } from "../Core/validate.js";
import { resolveRange, rangeFilter } from "./period-model.js";
import { withCasts } from "./cast-model.js";
import { scalePlan } from "./scale-model.js";
import { havingPlan } from "./having-model.js";
import { planJoinType } from "../Relations/relation-rules.js";
import { catalogFromEntities } from "../Calc/calc-resolve.js";
import { isCalcPill, calcPillId } from "../Calc/calc-pill.js";
import { sourceOfTable, sourceProblem, wireSource } from "../Core/source-model.js";
import { wireDim, wireMeasure, planTables, measureLabel, wireTopBy, wireCalcFilter, resolveSortTarget } from "../Calc/calc-plan.js";

// The worksheet query plan — pure and DOM-free (tests/js/sheet-plan.test.mjs). Everything the plan reads
// beyond the sheet arrives in an explicit context, so one worksheet or several can be planned side by side:
//   ctx = { calculations, entities (Map), relationships (Map), sharedFilters, parameters, metaOf(field),
//           nameOf(field), columnType(db, table, column) -> type string | "" }
// The canonical query shape lives in planDims()/planMeasures(): buildPlan sends exactly these, and the renderer
// re-derives the same ordering to know which result column is a series vs. a mark channel.

export const keyOf = (db, table) => `${db}\u0000${table}`;
export const splitKey = (k) => k.split("\u0000");
const EMPTY_MARKS = { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null };
export const marksOf = (s) => s.marks ?? EMPTY_MARKS;
// Scatter-family types (scatter + square/circle marks): point charts that plot two measures.
export const SCATTER_TYPES = new Set(["scatter", "square", "circle"]);
export const isNumericField = (f) => Boolean(f) && f.category === "numeric";
// Chart types that consume a Color dimension; the rest ignore a Color pill (the lane says so).
export const COLOR_USES = new Set(["bar", "stacked", "line", "area", "table"]);

/** Calculated fields: the context the pure plan seam (Calc/calc-plan.js) compiles pills against. */
export const calcContext = (ctx) => ({ calcs: ctx.calculations, catalog: catalogFromEntities([...ctx.entities.values()]), params: ctx.parameters });
/** Shared filters that actually reach the query. */
export const appliedShared = (ctx) => ctx.sharedFilters.filter((f) => checkFilter(f).state === "ok");
/** A parameter-bound filter takes the parameter's current value. */
export const withParams = (f, ctx) => withParamValue(f, ctx.parameters);

/** A Date / Date32 column holds days only (no time) — its range filter is sent as plain days. */
export const isDateOnlyType = (t) => /^(Nullable\()?(LowCardinality\()?Date(32)?\)*$/.test(t ?? "");
const dateOnly = (ctx, db, table, column) => isDateOnlyType(ctx.columnType(db, table, column));

/** A client filter as the server QueryFilter (relative dates -> a bound `between`, top-N with its ranking measure). */
export const toServerFilter = (f, ctx) => serverFilter(f, {
  resolve: (preset) => resolveRange({ preset }), dateOnly: dateOnly(ctx, f.db, f.table, f.column), wireTopBy: (t) => wireTopBy(t, calcContext(ctx)), wireCalc: (c) => wireCalcFilter(c, calcContext(ctx)) });

/** Display name of a measure — matches the server's measure naming (alias; a calculated field is just its name). */
export const measureName = (f, ctx) => measureLabel(f, ctx.calculations, ctx.metaOf(f).alias);
/** Stable identity for a pill, so a stored sort target survives re-renders. */
export const fieldId = (f, kind) => (isCalcPill(f) ? calcPillId(f, kind) : `${kind}:${f.db}.${f.table}.${f.column}:${f.agg ?? ""}${f.agg === "percentile" ? `@${f.p}` : ""}`);

/** Colour encoding: a numeric Colour field ramps a CONTINUOUS gradient; a categorical one splits DISCRETE series. */
export function colorMode(sheet) {
  const cf = (sheet.color ?? [])[0];
  if (!cf) return "none";
  return isNumericField(cf) ? "continuous" : "discrete";
}

// --- drill hierarchy and pages ---------------------------------------------------------------
/** A hierarchy is "active" once it has at least two ordered levels; a single level isn't a hierarchy. */
export function isDrillActive(sheet) { return (sheet.drill?.levels?.length ?? 0) >= 2; }
/** The level currently shown (a plain dimension pill descriptor); null when no hierarchy is active. */
export function drillActiveDim(sheet) {
  if (!isDrillActive(sheet)) return null;
  const d = sheet.drill;
  const lvl = d.levels[Math.min(d.depth, d.levels.length - 1)];
  return { db: lvl.db, table: lvl.table, column: lvl.column, category: lvl.category, role: "dimension" };
}
/** Each pinned ancestor as a bound-parameter equality filter (same table as the drill — never forces a join). */
export function drillPathFilters(sheet) {
  if (!isDrillActive(sheet)) return [];
  const d = sheet.drill;
  const t = d.levels[0]; // all levels share one table
  return (d.path ?? []).map((p) => ({ db: t.db, table: t.table, column: p.column, op: "=", value: String(p.value), values: null }));
}
/** The current Pages member as a bound `=` filter, or null (no pages / not loaded / a null member). */
export function pagesFilter(sheet) {
  const p = sheet.pages;
  if (!p || !Array.isArray(p.members) || !p.members.length) return null;
  const v = p.members[Math.max(0, Math.min(p.index ?? 0, p.members.length - 1))];
  if (v == null) return null;
  return { db: p.db, table: p.table, column: p.column, op: "=", value: String(v), values: null };
}

/** A click selection as the bound-parameter filter it becomes (`=` keep, `!=` exclude): the one shape the worksheet and the dashboard share. */
export const selectionFilter = (sel, op) => ({ db: sel.db, table: sel.table, column: sel.column, op, value: String(sel.value), values: null });

/** The tables a sheet's query involves ("db\0table" keys), in query order — the base first (the fields, filters and period bring them in). */
function involvedKeys(sheet, rangeFilters, cctx, keyOrder, mplan) {
  const involved = [];
  const addKey = (k) => { if (!involved.includes(k)) involved.push(k); };
  const add = (ref) => {
    if (!ref) return;
    if (isCalcPill(ref)) { planTables(ref, cctx).forEach((k) => { const i = k.indexOf("."); addKey(keyOf(k.slice(0, i), k.slice(i + 1))); }); return; } // none for a constant
    addKey(keyOf(ref.db, ref.table));
  };
  keyOrder.forEach(add); mplan.forEach((e) => add(e.field)); sheet.filters.forEach(add);
  rangeFilters.forEach(add);
  return involved;
}
export function involvedTables(sheet, periodRange, ctx) {
  const { keyOrder } = planDims(sheet);
  return involvedKeys(sheet, periodFilters(sheet, periodRange, ctx), calcContext(ctx), keyOrder, planMeasures(sheet));
}

/** Group-by dimensions in SELECT key order: [drill?, rows-dims, cols-dims, Detail-dims, discrete-Color]. Discrete Colour stays last. */
export function planDims(sheet) {
  const dd = drillActiveDim(sheet);
  const rowDims = [
    ...(dd ? [dd] : []),
    ...sheet.rows.filter((f) => roleOf(f) === "dimension"),
  ];
  const m = marksOf(sheet);
  const detail = m.detail ?? [];
  // Shape: a dimension -> distinct point shapes; it's a group-by only on the scatter family.
  const shapeDim = m.shape && SCATTER_TYPES.has(sheet.chartType) ? [m.shape] : [];
  const cf = (sheet.color ?? [])[0];
  const colorDiscrete = cf && colorMode(sheet) === "discrete" && COLOR_USES.has(sheet.chartType) ? [cf] : [];
  const colDims = [
    ...sheet.columns.filter((f) => roleOf(f) === "dimension"),
    ...detail,
    ...shapeDim,
    ...colorDiscrete, // discrete Colour MUST remain the last key (renderColorSplit)
  ];
  return { rowDims, colDims, keyOrder: [...rowDims, ...colDims] };
}

/**
 * Measures in SELECT value order, each tagged with its role: "shelf" (a series), "size", "color" (continuous
 * gradient) or "aux" (a numeric Label/Tooltip/Path field). Shelf measures come first so their aliases (v0,v1,…)
 * and series indices are unchanged when no marks are set. A Table shows only shelf measures.
 */
export function planMeasures(sheet) {
  const shelf = [
    ...sheet.columns.filter((f) => roleOf(f) === "measure"),
    ...sheet.rows.filter((f) => roleOf(f) === "measure"),
  ].map((f) => ({ field: f, role: "shelf", agg: f.agg ?? "sum" }));
  if (sheet.chartType === "table") return shelf; // crosstab shows shelf measures only
  const out = [...shelf];
  const m = marksOf(sheet);
  if (isNumericField(m.size)) out.push({ field: m.size, role: "size", agg: m.size.agg ?? "sum" });
  if (colorMode(sheet) === "continuous") { const cf = sheet.color[0]; out.push({ field: cf, role: "color", agg: cf.agg ?? "sum" }); }
  // Numeric Label / Tooltip / Path fields ride along as extra measures so their aggregated value is available per mark.
  for (const f of [m.label, m.path, ...(m.tooltip ?? [])]) if (isNumericField(f)) out.push({ field: f, role: "aux", agg: f.agg ?? "sum" });
  return out;
}

/**
 * The orderable output columns, in the order the query selects them: all group-by dimensions as k0,k1,…; then the
 * SHELF measures as v0,v1,…. Marks-only measures (size/colour/aux) aren't sort targets but keep aliases past them.
 */
export function sortTargets(sheet, ctx) {
  const { keyOrder } = planDims(sheet);
  const shelf = planMeasures(sheet).filter((e) => e.role === "shelf");
  const out = [];
  keyOrder.forEach((f, i) => out.push({ alias: `k${i}`, id: fieldId(f, "dimension"), label: ctx.nameOf(f) }));
  shelf.forEach((e, i) => out.push({ alias: `v${i}`, id: fieldId(e.field, "measure"), label: measureName(e.field, ctx) }));
  return out;
}

/** The period's range filter for a plan (its own range, or `range` for the comparison query). */
export function periodFilters(sheet, range, ctx) {
  const p = sheet.period;
  const r = range ?? resolveRange(p);
  return p && r ? [rangeFilter(p, r, dateOnly(ctx, p.db, p.table, p.column))] : [];
}

/**
 * The bounded, identifier-safe query for a sheet, or null (nothing from a table / tables with no relationship).
 * Fields split by shelf AND type: categorical pills are dimensions (Rows = the crosstab's left stub, Columns = the
 * top header), numeric pills are measures sent column-shelf-first so the result's measure order lines up with the
 * renderer. a date pill's part rides along (auto = left to the chart-wide Group dates).
 */
export function buildPlan(sheet, periodRange, ctx, { crossFilter = null } = {}) {
  const cctx = calcContext(ctx); // calculated fields: pills compile to trees (Calc/calc-plan.js)
  const toDim = (f) => wireDim(f, cctx);
  const pv = (f) => withParams(f, ctx);
  const toFilter = (f) => toServerFilter(f, ctx);
  // Drill + marks fold into the canonical query shape: the drill level and any Detail dims are group-bys;
  // Size / continuous-Colour / numeric Label+Tooltip are measures.
  const { rowDims, colDims, keyOrder } = planDims(sheet);
  const rowDimensions = rowDims.map(toDim);
  const columnDimensions = colDims.map(toDim);
  const mplan = planMeasures(sheet);
  const measures = mplan.map((e) => wireMeasure(e, cctx));

  const rangeFilters = periodFilters(sheet, periodRange, ctx); // like a filter, it may bring its table in
  const involved = involvedKeys(sheet, rangeFilters, cctx, keyOrder, mplan);
  if (!involved.length) return null;
  const base = involved[0];
  if (sourceProblem(involved, ctx.entities)) return null; // a union / unpivot is read alone (worksheet-view says why)
  const joins = buildJoins(base, involved.slice(1), ctx);
  if (joins === null) return null;
  const [db, table] = splitKey(base);
  // A click selection with an action (keep/exclude) becomes a bound-parameter filter — but only when its table
  // is already in the query, so it never forces an unresolved join. keep -> `col = value`, exclude -> `col != value`.
  // A dashboard's selection (crossFilter) is the same bound `=` on the same terms, and takes that one slot: it replaces
  // the worksheet's own selection when its table is in the query, and is simply not sent when it isn't.
  const sel = sheet.selection;
  const crossApplies = Boolean(crossFilter) && involved.includes(keyOf(crossFilter.db, crossFilter.table));
  const selFilters = crossApplies ? [selectionFilter(crossFilter, "=")]
    : (sel && sel.action && sel.value != null && involved.includes(keyOf(sel.db, sel.table)))
      ? [selectionFilter(sel, sel.action === "keep" ? "=" : "!=")]
      : [];
  // Shared filters: applied when their table is already in the query (never forcing a join).
  const shared = ctx.sharedFilters.map(pv).filter((f) => checkFilter(f).state === "ok" && involved.includes(keyOf(f.db, f.table))).map(toFilter).filter(Boolean);
  // Pages: the current member as a bound `=` filter, only when its table is already in the query.
  const pf = pagesFilter(sheet);
  const pageFilters = (pf && involved.includes(keyOf(pf.db, pf.table))) ? [pf] : [];
  // Resolve the sort selection to a SELECT alias (k{n}/v{n}); default = first field, ascending.
  const targets = sortTargets(sheet, ctx);
  let sortColumn = targets.length ? targets[0].alias : "v0";
  if (sheet.sort && sheet.sort.by) {
    const t = resolveSortTarget(targets, sheet.sort.by); // a calc pill matches whatever agg it had
    if (t) sortColumn = t.alias;
  }
  const source = sourceOfTable(ctx.entities, db, table); // a union / unpivot the query reads instead of a catalog table
  const having = havingPlan(mplan); // a filter on an aggregated measure: HAVING, after grouping and before Top-N's cap
  const scale = scalePlan(sheet.chartType, { ...sheet.format, topN: effectiveTopN(sheet.format, ctx.parameters, LIMITS.rows) }, rowDimensions.length + columnDimensions.length);
  if (having.length) delete scale.otherBucket; // the "Other" total is of the groups past the cap; with a measure filter it can't be (D84)
  return withCasts({
    from: { db, table },
    ...(source ? { source: wireSource(source) } : {}),
    joins,
    rowDimensions,
    columnDimensions,
    measures,
    filters: [...sheet.filters.map(pv).filter((f) => checkFilter(f).state === "ok").map(toFilter).filter(Boolean), ...selFilters, ...shared, ...drillPathFilters(sheet), ...pageFilters, ...rangeFilters],
    // Top-N caps a chart's groups (server sorts, then limits; "All" = the 5,000 cap) — plus the "Other" mark and
    // date grouping; the table pages instead (scale-model.js).
    ...scale,
    ...(having.length ? { having } : {}),
    ...(sheet.format?.approximate ? { approximate: true } : {}),
    sort: { column: sortColumn, desc: sheet.sort?.dir === "desc" },
  }, (f) => ctx.metaOf(f).cast); // each plain column ref carries its field's cast
}

// Join path over the relationship graph: connect every involved table back to the base.
function buildJoins(baseKey, targets, ctx) {
  if (!targets.length) return [];
  const graph = relationshipGraph(ctx);
  const included = new Set([baseKey]);
  const joins = [];
  for (const target of targets) {
    if (included.has(target)) continue;
    const path = bfs(graph, included, target);
    if (!path) return null;
    for (const edge of path) {
      if (!included.has(edge.to.key)) {
        joins.push({ left: col(edge.from), right: col(edge.to), ...(edge.type !== "inner" ? { type: edge.type } : {}), ...(edge.pairs.length ? { pairs: edge.pairs } : {}), ...(edge.aggregate ? { aggregate: true, ...(edge.direction === "single" ? { filterDirection: "single" } : {}) } : {}) });
        included.add(edge.to.key);
      }
    }
  }
  return joins;
}
function relationshipGraph(ctx) {
  const g = new Map();
  let type = "inner", fixed = false, pairs = [], aggregate = false, direction = "both";
  const link = (a, b, forward) => {
    if (!g.has(a.key)) g.set(a.key, []);
    // FROM is the left side; a compound key's extra pairs are {left, right} on the edge's own sides
    g.get(a.key).push({ from: a, to: b, type: planJoinType(type, forward, fixed), pairs: pairs.map((p) => (forward ? { left: p.from, right: p.to } : { left: p.to, right: p.from })), aggregate, direction });
  };
  for (const rel of ctx.relationships.values()) {
    const fe = ctx.entities.get(rel.from.entityId), te = ctx.entities.get(rel.to.entityId);
    if (!fe || !te) continue;
    const a = { key: keyOf(fe.db, fe.table), db: fe.db, table: fe.table, column: rel.from.column };
    const b = { key: keyOf(te.db, te.table), db: te.db, table: te.table, column: rel.to.column };
    if (a.key === b.key) continue;
    type = rel.joinType; fixed = rel.joinFixed === true; pairs = rel.pairs ?? []; aggregate = rel.aggregateFirst === true; direction = rel.filterDirection;
    link(a, b, true); link(b, a, false);
  }
  return g;
}
function bfs(graph, included, target) {
  const queue = [...included].map((k) => ({ key: k, path: [] }));
  const seen = new Set(included);
  while (queue.length) {
    const { key, path } = queue.shift();
    for (const edge of graph.get(key) ?? []) {
      if (seen.has(edge.to.key)) continue;
      const next = [...path, edge];
      if (edge.to.key === target) return next;
      seen.add(edge.to.key);
      queue.push({ key: edge.to.key, path: next });
    }
  }
  return null;
}
const col = (node) => ({ db: node.db, table: node.table, column: node.column });
