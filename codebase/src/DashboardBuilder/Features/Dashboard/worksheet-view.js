import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { toggle, makeButton, toast } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { defaultFormat } from "../Core/store.js";
import { disposeChart, animateNextChart } from "./chart.js";
import { renderWorksheet } from "./worksheet-render.js";
import { renderHistogram, renderBoxplot } from "./render-special.js";
import { outlierNotice } from "./box-model.js";
import { boxPlan } from "./box-plan.js";
import { perfLog, queryKindOf, rowCountOf } from "../Core/perf-log.js";
import { createLatestGate, isAbortError, requestKey, truncationNotice } from "./query-runner.js";
import { STAT_SINGLE_TABLE, statFieldHint } from "./show-me-rules.js";
import { statFilters, withCategories } from "./filter-rules.js";
import { statCastProblem } from "./cast-model.js";
import { sourceProblem, sourceOfTable } from "../Core/source-model.js";
import { heldOutProblem } from "../Relations/relation-rules.js";
import { resolveRange, compareRange, compareName, COMPARE_TYPES } from "./period-model.js";
import { tableProgress, needsNextPage, OTHER_TYPES, bucketNotice } from "./scale-model.js";
import { havingNotice } from "./having-model.js";
import { planDims, planMeasures, measureName, buildPlan, involvedTables, calcContext, appliedShared, withParams, toServerFilter, isDrillActive, COLOR_USES } from "./sheet-plan.js";
import { appliesTo, notAppliedNote, statNote, crossSignature } from "./dashboard-select.js";
import { planTables, calcProblem, statCalcProblem } from "../Calc/calc-plan.js";
import { isCalcPill, pillSlots } from "../Calc/calc-pill.js";
import { el, hint, warn } from "./render-dom.js";
import { joinNotices, periodNotice, speedNotice, invalidFilterNotice } from "./notices.js";
import { BACKGROUND_CHOICES, backgroundClass } from "./background-model.js";

// The worksheet's query-and-render lifecycle: plan -> latest-wins fetch (shared result cache) -> draw into one
// container. One view owns one container, one latest-wins gate and its own table pager and fresh flag, so several
// views never abort or overwrite each other; the chart itself is keyed by the container (chart.js). The drawing of a
// result is worksheet-render.js, so a view needs no editor to show a worksheet.
//
//   createWorksheetView(container, getContext, options) -> { run(), sync(), refresh(), cancel(), destroy() }
//   getContext() -> { dash: { id, sheet } | null, noticeEl | null, results (createResultCache), plan (the sheet-plan.js context),
//                     categoryOf(db, table, column), castOf(field) }
//   options (static for the view's life; every one optional):
//     interactive      true (default) = the editor: mark selection, drill, legend, status bar;  "select" = a dashboard widget that
//                      selects but never drills (only onSelect is called; the legend highlights, no status bar, no editor panels);
//                      false = a static, non-selectable widget: no mark selection, drill or legend handlers, no status bar
//     cross() -> { filter: selection } | { selected: selection } | null  the dashboard selection this view obeys (dashboard-select.js):
//                      `filter` = a bound `=` added to its query where the selected table is already in it (else a note, never a join);
//                      `selected` = this is the source: it highlights that mark and is never filtered. sync() re-runs when it changed.
//     onUnselectable()  a select-only view's click on a NULL member / the "Other" group (nothing is selected; the host says why)
//     onSelect(dimField, raw)  a mark click selects (the host stores the selection);  onDrill(raw)  a click on a drill hierarchy
//     onLegend({ sheet, field, name, raw, bucketed })  a legend click;  legendFocus() -> the highlighted legend item or null
//     onTooltipFields(sheet, list), onMemberColors(sheet, field, members)  the editor panels that learn what the chart offers
//     statusBar(sheet, result | null)  the host's status line (marks, rows x columns, selection)
//     notices(sheet) -> string | null  a host line joined into the notice (the editor: shared filters not applied here)
//     cancelLabel() -> a name for the loading state's Cancel button (aria-label "Cancel loading <name>"); default: none
//     draw(container, sheet, result, cmp, renderOptions)  the drawing function (default renderWorksheet; a test seam)

export { el, hint, warn };

export { joinNotices, periodNotice, speedNotice, invalidFilterNotice };

export function createWorksheetView(container, getContext, options = {}) {
  const mode = options.interactive ?? true; // true | "select" | false
  const interactive = mode === true;
  const draw = options.draw ?? renderWorksheet;
  const statusBar = interactive ? options.statusBar ?? (() => {}) : () => {};
  const hostNotice = (sheet) => options.notices?.(sheet) ?? null;
  let cross = null;   // the dashboard selection this run obeys (options.cross() read when a run begins)
  let crossSig = null; // what that selection made the view show — sync() compares against it
  // What the drawing may do with the editor-only state around it (render-handlers.js): nothing when not interactive, and a
  // "select" view hands the host only onSelect.
  const renderOptions = () => ({ plan: getContext().plan, interactive: mode, selected: cross?.selected ?? null,
    hooks: mode === "select" ? { onSelect: options.onSelect, onUnselectable: options.onUnselectable } : {
      onSelect: options.onSelect, onDrill: options.onDrill, onLegend: options.onLegend, legendFocus: options.legendFocus,
      onTooltipFields: options.onTooltipFields, onMemberColors: options.onMemberColors, onCollapse: options.onCollapse, onCollapseAll: options.onCollapseAll } });
  // The tables the sheet's query involves (never throws: a sheet that can't be planned reaches nothing).
  const statSourceProblem = (s, entities) => ([...s.columns, ...s.rows].some((f) => sourceOfTable(entities, f.db, f.table)) ? "A histogram reads one table — it can't read a union or unpivot yet." : null);
  const involvedOf = (c, s) => { try { return involvedTables(s, undefined, c.plan); } catch { return []; } };
  let extraNotice = null; // the line the last drawing wants in the notice (small-multiples cap, calculations on partial rows)
  let renderTimed = false; // set by fetchCached: the next draw is the one to time (not a table scroll-page redraw)
  // The Format → Background shade: set at the start of every run (so a saved shade shows before the first result and
  // loading / empty / error states carry the current one) and again on each draw.
  const applyBackground = (s) => {
    const bg = backgroundClass(s.format?.background);
    for (const [id] of BACKGROUND_CHOICES) container.classList.toggle(`ws-bg-${id}`, `ws-bg-${id}` === bg);
  };
  const drawResult = (s, result, cmp) => {
    applyBackground(s);
    extraNotice = null;
    const t0 = performance.now();
    extraNotice = draw(container, s, result, cmp ?? null, renderOptions())?.extraNotice ?? null;
    if (renderTimed) { renderTimed = false; perfLog.attachRender(performance.now() - t0); } // only the draw that follows a fetch; timing only — Core/perf-log.js
  };
  const gate = createLatestGate();
  // Table scroll-loading: the pages loaded so far for the table on screen (re-used while its plan stays the same, so a
  // format tweak keeps what was loaded). { sheetId, key, plan, rows, total, loading, ctl, first }.
  let tablePager = null;
  let freshNext = false; // the next query skips the server's result cache (Refresh)

  const setNotice = (noticeEl, text) => {
    if (!noticeEl) return;
    noticeEl.replaceChildren(...(text ? [icon("info", { size: 14 }), el("span", null, text)] : []));
    toggle(noticeEl, Boolean(text));
  };
  // A result straight from ClickHouse animates in (ECharts' entrance, or a fade for the table/KPI); a re-render from the
  // cache (format tweaks, theme flip) repaints without motion.
  function markFresh(fresh) {
    animateNextChart(container, fresh);
    container.classList.toggle("is-fresh", fresh);
  }
  // "Loading…" with a Cancel button — it aborts the request (and the server stops the ClickHouse query when the
  // browser goes away), leaving a note to run it again.
  function loadingView(noticeEl) {
    const box = el("div", "ws-loading");
    box.append(el("span", null, "Loading…"));
    const cancel = makeButton("Cancel", "btn ws-loading__cancel");
    const named = options.cancelLabel?.(); // a widget names its worksheet so several Cancel buttons differ
    if (named) cancel.setAttribute("aria-label", `Cancel loading ${named}`);
    cancel.addEventListener("click", () => {
      gate.cancel();
      container.replaceChildren(hint("Query cancelled — Refresh runs it again."));
      setNotice(noticeEl, null);
    });
    box.append(cancel);
    return box;
  }
  // Serve a request from the result cache, or run it under the latest-wins ticket. Resolves to the result, or null when
  // the request was superseded (silently) or failed (the error is shown in the container).
  async function fetchCached(c, ticket, key, run) {
    const cached = c.results.get(c.dash.id, key);
    if (cached) { renderTimed = true; perfLog.record({ kind: queryKindOf(key), ms: 0, rows: rowCountOf(cached), cached: true }); markFresh(false); return cached; }
    container.replaceChildren(loadingView(c.noticeEl));
    const t0 = performance.now();
    try {
      const result = await run(ticket.signal);
      if (!ticket.isCurrent()) return null;
      renderTimed = true;
      perfLog.record({ kind: queryKindOf(key), ms: performance.now() - t0, rows: rowCountOf(result), cached: false });
      result.queriedAt = Date.now(); // kept in the cache with the result: the status bar and print header say when the data was read
      c.results.set(c.dash.id, key, result);
      markFresh(true);
      return result;
    } catch (err) {
      if (!ticket.isCurrent() || isAbortError(err)) return null;
      container.replaceChildren(warn(err.message));
      return null;
    }
  }
  // The comparison result for the current view, or null (no comparison / not drawn for this chart / failed).
  // undefined = superseded by a newer query.
  async function fetchCompare(c, s, ticket) {
    const p = s.period;
    if (!p || !COMPARE_TYPES.has(s.chartType)) return null;
    const range = compareRange(p, resolveRange(p));
    if (!range) return null;
    const plan = buildPlan(s, range, c.plan, { crossFilter: cross?.filter ?? null });
    if (!plan) return null;
    const key = requestKey("query", plan);
    let result = c.results.get(c.dash.id, key);
    if (!result) {
      try { result = await api.query(plan, { signal: ticket.signal }); }
      catch (err) { if (!ticket.isCurrent() || isAbortError(err)) return undefined; toast(`Comparison failed: ${err.message}`, "danger"); return null; }
      if (!ticket.isCurrent()) return undefined;
      c.results.set(c.dash.id, key, result);
    }
    return { result, range, name: compareName(p.compare) };
  }

  async function run() {
    const c = getContext();
    const dash = c.dash;
    if (!dash) return;
    const ticket = gate.begin(); // aborts any in-flight query for the previous state
    disposeChart(container); // tear down any live ECharts instance before we repaint
    container.onscroll = null; // only the Table view loads on scroll (runTable sets it)
    statusBar(null, null);
    const s = dash.sheet;
    applyBackground(s);
    cross = options.cross?.() ?? null;
    crossSig = crossSignature(cross, involvedOf(c, s));
    const crossNote = cross?.filter && !appliesTo(involvedOf(c, s), cross.filter) ? notAppliedNote(cross.filter) : null; // C3: its table isn't here — say so, never join
    withCategories(s.filters, c.categoryOf);
    const statChart = STAT_SINGLE_TABLE.has(s.chartType);
    const havingNote = statChart ? ((s.columns ?? []).concat(s.rows ?? []).some((f) => f.having) ? "Measure filters don't apply to this chart." : null) : havingNotice(planMeasures(s).filter((e) => e.role === "shelf").map((e) => ({ label: measureName(e.field, c.plan), having: e.field.having })), planDims(s).keyOrder.map((f) => c.plan.nameOf(f)));
    const filterNote = joinNotices(invalidFilterNotice(s), crossNote, havingNote);
    setNotice(c.noticeEl, filterNote);
    const heldOut = heldOutProblem(involvedOf(c, s), c.plan.entities, c.plan.relationships); // a table with no relationship stays out of every view
    if (heldOut) { container.replaceChildren(warn(heldOut)); return; }
    // Box plot: its own quantile endpoint over the worksheet's joins, filters and calculations.
    if (s.chartType === "boxplot") { await runBox(c, s, ticket, filterNote); return; }
    // Histogram: a single-table endpoint that knows nothing of calculations, casts or sources.
    if (s.chartType === "histogram") {
      const noCalc = statCalcProblem(s);
      if (noCalc) { container.replaceChildren(hint(noCalc)); return; }
      const noSource = statSourceProblem(s, c.plan.entities);
      if (noSource) { container.replaceChildren(hint(noSource)); return; }
      const noCast = statCastProblem(s, c.castOf);
      if (noCast) { container.replaceChildren(hint(noCast)); return; }
      await runStat(c, s, ticket, joinNotices(filterNote, cross?.filter && !crossNote ? statNote(cross.filter) : null)); return; }
    const colorInPlay = s.color?.length && COLOR_USES.has(s.chartType);
    const drillInPlay = isDrillActive(s); // a hierarchy alone can drive a view (implicit count on the level)
    const m = s.marks ?? {};
    const marksInPlay = Boolean(m.detail?.length || m.size || m.label || m.tooltip?.length || m.shape || m.path || m.angle || s.color?.length);
    if (!s.columns.length && !s.rows.length && !colorInPlay && !drillInPlay && !marksInPlay) {
      container.replaceChildren(hint("Drag fields onto Columns and Rows to build a chart — categorical fields group, numeric fields aggregate."));
      return;
    }
    const cctx = calcContext(c.plan);
    const problem = calcProblem(s, cctx, appliedShared(c.plan)); // a calculation that can't be computed — say why, send nothing
    if (problem) { container.replaceChildren(warn(problem)); return; }
    const mixed = sourceProblem(involvedOf(c, s), c.plan.entities); // a union / unpivot is read alone: say so, send nothing
    if (mixed) { container.replaceChildren(warn(mixed)); return; }
    const plan = buildPlan(s, undefined, c.plan, { crossFilter: cross?.filter ?? null });
    if (!plan) {
      // Only field-less calculations (e.g. 1+2) and nothing from a table: there is nothing to relate, so say what to add.
      const tableInvolved = [...pillSlots(s)].some((f) => !isCalcPill(f) || planTables(f, cctx).length)
        || s.filters.length || s.drill?.levels?.length || s.pages || s.period;
      container.replaceChildren(tableInvolved
        ? warn("These fields come from tables with no relationship between them — draw one in the Data Source.")
        : hint("Add a field from a table — a calculation with no field in it has nothing to group or total."));
      return;
    }
    const key = requestKey("query", plan);
    if (s.chartType === "table") { await runTable(c, s, plan, key, ticket, filterNote); return; }
    const fresh = freshNext; freshNext = false;
    const result = await fetchCached(c, ticket, key, (signal) => api.query(fresh ? { ...plan, fresh: true } : plan, { signal }));
    if (!result) return;
    const cmp = await fetchCompare(c, s, ticket);
    if (cmp === undefined) return; // superseded while the comparison ran
    try {
      drawResult(s, result, cmp);
      statusBar(s, result);
      // An "Other" mark already says how much is past the limit, so no truncation line on top of it.
      const shownOther = result.other && OTHER_TYPES.has(s.chartType);
      setNotice(c.noticeEl, joinNotices(filterNote, speedNotice(result, plan), hostNotice(s), periodNotice(s, cmp), extraNotice, shownOther ? null : truncationNotice({ truncated: result.truncated, chartType: s.chartType, limit: plan.limit }), bucketNotice(result.bucket)));
    } catch (err) {
      console.error(err);
      container.replaceChildren(warn("This view couldn't be drawn — try another chart type or remove a field."));
    }
  }

  // Table view: the first page (cached like any result), then each further page as the pane scrolls near its end. Every
  // page is the same ordered query with a growing OFFSET, so they line up exactly; the crosstab is redrawn from all
  // loaded rows (a pivot row split across two pages fills in).
  async function runTable(c, s, plan, key, ticket, filterNote) {
    const dash = c.dash;
    const reuse = tablePager && tablePager.sheetId === dash.id && tablePager.key === key ? tablePager : null;
    if (tablePager && !reuse) tablePager.ctl?.abort();
    const first = await fetchCached(c, ticket, key, (signal) => api.query(plan, { signal }));
    if (!first) return;
    tablePager = reuse ?? { sheetId: dash.id, key, plan, rows: first.rows, total: first.total ?? first.rows.length, loading: false, ctl: null, first };
    const draw = () => {
      const top = container.scrollTop;
      try { drawResult(s, { ...tablePager.first, rows: tablePager.rows, partial: tablePager.rows.length < tablePager.total }); statusBar(s, { ...tablePager.first, rows: tablePager.rows }); }
      catch (err) { console.error(err); container.replaceChildren(warn("This view couldn't be drawn — try another chart type or remove a field.")); }
      container.scrollTop = top;
      setNotice(c.noticeEl, joinNotices(filterNote, periodNotice(s, null), extraNotice, tableProgress(tablePager.rows.length, tablePager.total)));
    };
    draw();
    const pager = tablePager;
    const more = async () => {
      if (pager !== tablePager || pager.loading || !needsNextPage(container, pager.rows.length, pager.total)) return;
      pager.loading = true;
      pager.ctl = new AbortController();
      try {
        const page = await api.query({ ...pager.plan, offset: pager.rows.length, withTotal: false }, { signal: pager.ctl.signal });
        if (pager !== tablePager) return;
        pager.rows = pager.rows.concat(page.rows);
        if (!page.rows.length) pager.total = pager.rows.length; // the data shrank under us — stop asking
        draw();
      } catch (err) {
        if (!isAbortError(err) && pager === tablePager) toast(err.message, "danger");
        pager.total = pager.rows.length; // don't retry in a loop; Refresh starts over
      } finally {
        pager.loading = false;
      }
      if (pager === tablePager) more(); // a tall pane may need another page straight away
    };
    container.onscroll = more;
    more();
  }

  // Histogram: buckets one numeric column through its own single-table endpoint (a bucketing query shape), so it reads
  // fields directly rather than through buildPlan. All fields must live on ONE table (the endpoint doesn't join).
  async function runStat(c, s, ticket, filterNote = null) {
    const allFields = [...s.columns, ...s.rows];
    const numeric = allFields.find((f) => f.category === "numeric");
    if (!numeric) { container.replaceChildren(hint(statFieldHint(s.chartType))); return; }
    const { db, table } = numeric;
    // Only same-table, usable filters apply (the single-table endpoints take in/between too); the rest are counted and
    // reported in the notice.
    const { apply: filters, ignored } = statFilters(s.filters.map((f) => withParams(f, c.plan)), db, table, (f) => toServerFilter(f, c.plan));
    const ignoredNote = ignored > 0 ? `${ignored} filter${ignored === 1 ? "" : "s"} on other tables or calculated fields ${ignored === 1 ? "doesn't" : "don't"} apply to a histogram.` : null;
    const format = s.format ?? defaultFormat();
    // Reuse Top-N as the bucket count when set (else the server default); server clamps 1..100.
    const req = { column: numeric.column, buckets: s.format?.topN ?? null, filters };
    const result = await fetchCached(c, ticket, requestKey("histogram", { db, table, req }), (signal) => api.histogram(db, table, req, { signal }));
    if (!result) return;
    if (!result.bins?.length) { container.replaceChildren(hint("No data for this field.")); setNotice(c.noticeEl, joinNotices(filterNote, ignoredNote)); return; }
    renderHistogram(container, result.bins, format);
    setNotice(c.noticeEl, joinNotices(filterNote, ignoredNote));
  }

  // Box plot: the worksheet's own plan with the numeric field as the value and the first other field as the group
  // (box-plan.js), so joined tables, calculations, casts and a union / unpivot work as in any chart.
  async function runBox(c, s, ticket, filterNote) {
    if (!s.columns.concat(s.rows).some((f) => f.category === "numeric")) { container.replaceChildren(hint(statFieldHint("boxplot"))); return; }
    const problem = calcProblem(s, calcContext(c.plan), appliedShared(c.plan)); // a calculation that can't be computed — say why, send nothing
    if (problem) { container.replaceChildren(warn(problem)); return; }
    const mixed = sourceProblem(involvedOf(c, s), c.plan.entities);
    if (mixed) { container.replaceChildren(warn(mixed)); return; }
    const req = boxPlan(s, c.plan, { crossFilter: cross?.filter ?? null });
    if (!req) { container.replaceChildren(warn("These fields come from tables with no relationship between them — draw one in the Data Source.")); return; }
    const format = s.format ?? defaultFormat();
    const result = await fetchCached(c, ticket, requestKey("boxplot", req), (signal) => api.boxplot(req, { signal }));
    if (!result) return;
    if (!result.groups?.length) { container.replaceChildren(hint("No data for this field.")); setNotice(c.noticeEl, filterNote); return; }
    renderBoxplot(container, result.groups, format, result.outliers);
    setNotice(c.noticeEl, joinNotices(filterNote, truncationNotice({ truncated: result.truncated, chartType: "boxplot", limit: req.limit }), outlierNotice(result.outliersTruncated)));
  }

  return {
    run,
    /** Run again only if the dashboard selection changed what this view shows — a widget it can't reach, or the same selection, stays put. */
    sync() {
      const c = getContext();
      if (!c.dash) return Promise.resolve();
      const next = options.cross?.() ?? null;
      return crossSignature(next, involvedOf(c, c.dash.sheet)) === crossSig ? Promise.resolve() : run();
    },
    /** Re-run against ClickHouse, bypassing the result cache (data may have changed). */
    refresh() {
      const c = getContext();
      if (c.dash) c.results.clear(c.dash.id);
      tablePager?.ctl?.abort(); tablePager = null; freshNext = true;
      return run();
    },
    /** Abort the in-flight query and make its answer stale. */
    cancel() { gate.cancel(); },
    /** Stop everything and release the container's chart. */
    destroy() { gate.cancel(); tablePager?.ctl?.abort(); tablePager = null; container.onscroll = null; disposeChart(container); },
  };
}
