import { api } from "../Core/api.js";
import { icon, PATHS } from "../Core/icons.js";
import { wireMenu } from "../Core/menu.js";
import { visibleTools } from "./toolbar-rules.js";
import { roleOf, STAT_SINGLE_TABLE, showMeOptions, placeFor, samePlacement } from "./show-me-rules.js";
import { toggle, makeButton, toast, fieldError, confirmDialog } from "../Core/ui.js";
import { LIMITS, number } from "../Core/validate.js";
import { aggsFor, checkAdd, checkFilter, viewCounts, withCategories, opsFor, OP_LABELS } from "./filter-rules.js";
import { entities, relationships, activeWorksheet, isWorksheetActive, updateSheet, bus, defaultFormat, defaultMarks, sharedFilters, metaOf, nameOf, setFieldMeta, emptySheet, parameters, updateParameter, calculations, worksheets, addCalculation, removeCalculation } from "../Core/store.js";
import { checkValue, paramTypeFor } from "../Core/parameters-model.js";
import { exportChart, hasChartInstance, sizeChart, focusSeries } from "./chart.js";
import { createWorksheetView, periodNotice } from "./worksheet-view.js";
import { el, hint, iconSpan } from "./render-dom.js";
import { ANALYTICS_TYPES, CLICK_TYPES, sameField, statusText, captionText } from "./result-model.js";
import { makeCategoryFormatter } from "../Core/format.js";
import { createResultCache } from "./query-runner.js";
import { CHART_TYPES, chartIcon, chartLabel, sortSummary } from "./viewbar-model.js";
import { enter, MOTION } from "../Core/motion.js";
import { wireResizer } from "../Core/resizer.js";
import { PRESET_CHOICES, COMPARE_CHOICES, COMPARE_TYPES, newPeriod, resolveRange, compareRange, rangeLabel } from "./period-model.js";
import { CF_MODE_CHOICES, CF_SCALE_CHOICES, CF_OP_CHOICES, CF_TONE_CHOICES, CF_MAX_RULES, measureKey, emptyRule, isActive } from "./conditional-model.js";
import { templateError, buildActionUrl, MAX_LABEL, MAX_TEMPLATE } from "./action-model.js";
import { DATE_PART_CHOICES, stepPart } from "./date-parts.js";
import { CALC_CHOICES, ALONG_CHOICES, WINDOW_CHOICES, isCalc, calcName } from "./table-calc.js";
import { tooltipHtml, lookupFrom, checkTooltipText, parseTooltip } from "./tooltip-model.js";
import { SWATCHES, memberKey, fieldColorKey, setMemberColor, clearFieldColors, colourOf } from "./colour-model.js";
import { createHistory } from "./history.js";
import { LINE_STYLE_CHOICES, linesTakeStyle } from "./line-style-model.js";
import { HEATMAP_SHAPE_CHOICES } from "./heatmap-model.js";
import { targetChoices, effectiveTargetMeasure } from "./bullet-model.js";
import { keyOf, SCATTER_TYPES, COLOR_USES, colorMode, isDrillActive, drillActiveDim, planDims, planMeasures, sortTargets as planSortTargets, measureName as planMeasureName, buildPlan as planQuery, periodFilters as planPeriodFilters, calcContext, appliedShared as planAppliedShared, withParams, toServerFilter, isDateOnlyType } from "./sheet-plan.js";
import { catalogFromEntities } from "../Calc/calc-resolve.js";
import { isCalcPill, makeCalcPill, refusal, syncCalcPills, pillSlots, clearCalcPills, clearFilterCalc, usesCalc, CALC_AGGS } from "../Calc/calc-pill.js";
import { openCalcDialog } from "../Calc/calc-dialog.js";
import { openRowsDialog } from "../Rows/rows-dialog.js";
import { buildRowsRequest } from "../Rows/rows-model.js";
import { evaluationInput } from "../Calc/eval-order.js";
import { explainControl } from "../Calc/explain-popover.js";
import { paneState, deleteCalcPlan, roleChoice, setRoleChoice } from "../Calc/calc-pane-model.js";
import { checkName } from "../Calc/calc-workbook.js";
import { calcParamNames } from "../Calc/calc-params.js";
import { calcProblem, topByRef, topByKey } from "../Calc/calc-plan.js";
import { REF_CHOICES, TREND_CHOICES, FORECAST_CHOICES, defaultAnalytics } from "./analytics-model.js";
import { castChoices, castLabel, effectiveCategory, syncCastCategories } from "./cast-model.js";
import { BUCKET_TYPES, DATE_BUCKET_CHOICES } from "./scale-model.js";

// Tableau-style worksheet: each worksheet tab is one sheet. Drag fields from the field pane onto the
// Columns (dimension), Rows (measure) and Filters shelves; the chart renders from a bounded,
// identifier-safe query. Fields from *different* tables are joined automatically along the
// relationships drawn in the Data Model (a join path found by BFS over the relationship graph).
const FIELD_MIME = "application/x-ch-field";
// Column category from the Data Model catalog (entity.columns), for filters saved without one.
// T02-34: a field's cast (field setting) decides the category its pills, filters and the field pane use.
export const castOf = (f) => metaOf(f).cast;
export const categoryOf = (db, table, column) => {
  const base = baseCategoryOf(db, table, column);
  return base ? effectiveCategory(base, castOf({ db, table, column })) : undefined;
};
function baseCategoryOf(db, table, column) {
  try {
    // The worksheet's own column cache is warm by render time (buildFields awaited it); the Data Model's
    // entity columns (loaded asynchronously by the canvas) are the fallback.
    const cached = columnsCache.get(keyOf(db, table))?.find((x) => x.name === column);
    if (cached?.category) return cached.category;
    for (const e of entities.values())
      if (e.db === db && e.table === table) { const c = e.columns?.find((x) => x.name === column); if (c?.category) return c.category; }
  } catch { /* total: an odd catalog just means "unknown" */ }
  return undefined;
}
// A column's type from the field pane's cache, else the Data Model's catalog ("" when unknown).
function columnType(db, table, column) {
  return columnsCache.get(keyOf(db, table))?.find((x) => x.name === column)?.type
    ?? [...entities.values()].find((e) => e.db === db && e.table === table)?.columns?.find((x) => x.name === column)?.type ?? "";
}
const isDateOnlyColumn = (db, table, column) => isDateOnlyType(columnType(db, table, column));
const FILTER_PLACEHOLDER = { numeric: "number", temporal: "YYYY-MM-DD", boolean: "true or false" };
const OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "notin", "between"];
// The plan inputs the pure planner reads (sheet-plan.js): live store state plus the field-pane column cache.
/** Recent query results per worksheet id — shared by the editor and the dashboard widgets, so a widget draws what the editor just ran. */
export const sharedResults = createResultCache();
export const planCtx = () => ({ calculations, entities, relationships, sharedFilters, parameters, metaOf, nameOf, columnType });
const calcFieldCtx = () => calcContext(planCtx());
const appliedShared = () => planAppliedShared(planCtx());
// A client filter as the server QueryFilter (only filters checkFilter() calls "ok" are sent; P30 relative dates, top-N).
const toFilter = (f) => toServerFilter(f, planCtx());
// A field's role can be overridden on its pill (Tableau's convert-to-dimension/measure). Default:
// numeric → measure (aggregated), everything else → dimension (grouped). A numeric field made a
// dimension groups by its raw values; any field made a measure is aggregated (count/countDistinct
// always valid, sum/avg only meaningful for numbers).
// (roleOf itself lives in show-me-rules.js.)

const measureName = (f) => planMeasureName(f, planCtx()); // P28 display name; a calculated field is just its name
const sortTargets = (sheet) => planSortTargets(sheet, planCtx());
const buildPlan = (sheet, periodRange) => planQuery(sheet, periodRange, planCtx());
const periodFilters = (sheet, range) => planPeriodFilters(sheet, range, planCtx());

// --- marks card + query-shape helpers (P18) --------------------------------
// The canonical query shape lives in planDims()/planMeasures(): buildPlan sends exactly these, and
// worksheet-render.js re-derives the same ordering to know which result column is a series vs. a mark channel.
// With no marks set, both reduce to the pre-P18 ordering, so existing charts are byte-identical.
const shelfMeasureCount = (sheet) => planMeasures(sheet).filter((e) => e.role === "shelf").length;
const CHART_LIKE = new Set([
  "bar", "stacked", "line", "area", "pie", "donut", "scatter", "combo", "square", "circle",
  "heatmap", "treemap", "histogram", "boxplot",
  "waterfall", "funnel", "gauge", "bullet", "sankey", "multiples", // P36
]);
// Charts without x / y axes: no axis-title controls in Format.
const NO_AXES = new Set(["pie", "donut", "funnel", "gauge", "sankey"]);
// Charts that read Format → Target (P35 scorecard; P36 gauge maximum / bullet target).
const TARGET_TYPES = new Set(["kpi", "gauge", "bullet"]);
// P22 Show Me: the field counts one candidate chart type sees — the same dims the chart hint counts
// (planDims with that type: drill, shelf, Detail, Shape, discrete Colour) and the shelf measures.
function showMeCounts(sheet, type) {
  const shelf = [...sheet.columns, ...sheet.rows];
  const measures = shelf.filter((f) => roleOf(f) === "measure");
  return {
    dims: planDims({ ...sheet, chartType: type }).keyOrder.length,
    shelfDims: (drillActiveDim(sheet) ? 1 : 0) + shelf.filter((f) => roleOf(f) === "dimension").length,
    measures: measures.length,
    hasDate: shelf.some((f) => roleOf(f) === "dimension" && f.category === "temporal"),
    textValue: measures.some((f) => f.category !== "numeric" && (f.agg === "min" || f.agg === "max")),
    discreteColor: colorMode(sheet) === "discrete",
    numericField: shelf.some((f) => f.category === "numeric"),
  };
}
const columnsCache = new Map();
let headerAbort = null; // aborts the menus wired during the previous header render
const TYPE_ICONS = { numeric: "type-number", text: "type-text", temporal: "type-date", boolean: "type-bool" };

export function initDashboards() {
  const view = document.getElementById("worksheet-view");
  const fieldsEl = document.getElementById("ws-fields");
  const shelvesEl = document.getElementById("ws-shelves");
  const chartEl = document.getElementById("ws-chart");
  const noticeEl = document.getElementById("ws-chart-notice");
  const headEl = document.getElementById("ws-chart-head");
  if (!view) return;
  initFieldResizer();

  // Latest-wins queries + recent results per worksheet: a superseded query is aborted (its answer can
  // never overwrite a newer chart), and presentation-only changes re-render from the cached result
  // instead of re-querying ClickHouse. The Refresh button drops the worksheet's cache and re-queries.
  const history = createHistory(); // P23 undo / redo per worksheet
  const lastSnap = new Map();       // worksheet id → the sheet as last committed (the "before" of the next edit)
  const results = sharedResults;
  // The editor's one worksheet view — created before anything (sync() below) can use it.
  // The query-and-render lifecycle is worksheet-view.js (P24a); the editor owns exactly one view, on #ws-chart, and
  // supplies the drawing of a result (worksheet-render.js) and the editor-only state around it.
  const sheetView = createWorksheetView(chartEl, () => ({
    dash: activeWorksheet(), noticeEl, results, plan: planCtx(), categoryOf, castOf,
  }), {
    interactive: true, onSelect: toggleSelection, onDrill: (raw) => drillDown(raw), onLegend: legendClick, legendFocus: () => legendFocus,
    onTooltipFields: (sheet, list) => setTooltipCat(sheet, list), onMemberColors: (sheet, field, members) => setMemberState(sheet, field, members),
    statusBar: setStatusBar, notices: sharedNote,
  });
  const runChart = () => sheetView.run();

  let legendFocus = null; // P29: the legend item the user clicked (highlighted), or null
  let calcFor = null;     // P27: the measure slot whose table-calculation editor is open — { shelf, index } or null
  let choicesFor = null;  // P40: the shelf slot whose field-choices editor is open — { shelf, index } or null
  let cfMeasure = null;   // which measure the Format card's conditional-formatting editor shows (P37)

  let formatOpen = false; // whether the Format panel (P10) is expanded — ephemeral UI state
  let analyticsOpen = false; // P21: whether the Analytics card is open
  let showMeOpen = false; // P22: whether the Show Me card is open
  let shownPanel = null;  // the tool/format panel on screen last render, so only a newly opened one animates in
  let shownPills = new Set(); // pill keys on screen last render, so only a newly added pill animates in
  let shownFor = null;        // the worksheet those were rendered for (switching worksheets animates nothing)
  let shownDash = null;       // the worksheet on screen, so switching between two replays the view entrance
  let freshResult = false; // the last result came from ClickHouse (not the cache): animate the chart in
  let openTool = null;    // which toolbar tool's editor panel is open (Color/Size/…/Filters/Drill/Pages), or null
  let pageTimer = null;   // P20 Pages autoplay interval id (transient; never persisted)

  bus.addEventListener("view:changed", sync);
  bus.addEventListener("worksheet:changed", () => {
    // A change from outside commit() (bookmark, workbook open, undo) becomes the new baseline.
    const d = activeWorksheet();
    // ...and a restored sheet's calculated pills take the live calculation's type / role (undo, bookmark, open).
    if (d && isWorksheetActive()) syncCalcPills(d.sheet, calculations, catalogFromEntities([...entities.values()]), parameters);
    if (d && isWorksheetActive()) lastSnap.set(d.id, structuredClone(d.sheet));
    if (isWorksheetActive()) { renderShelves(); runChart(); }
  });
  initUndoKeys();
  // Safety net: an entity's columns finishing after the first render may be the only source of a
  // restored filter's category — re-render once if any filter is still waiting for one.
  bus.addEventListener("entity:loaded", () => {
    const dash = activeWorksheet();
    if (!dash || !isWorksheetActive() || !dash.sheet.filters.some((f) => !f.category)) return;
    const missing = dash.sheet.filters.filter((f) => !f.category).length;
    withCategories(dash.sheet.filters, categoryOf);
    if (dash.sheet.filters.filter((f) => !f.category).length < missing) { renderShelves(); runChart(); }
  });
  // chart.js reads colours from :root at render time — redraw when light/dark flips (Core/scheme.js; a cache hit, no query).
  bus.addEventListener("scheme:changed", () => { if (isWorksheetActive()) runChart(); });
  bus.addEventListener("theme:changed", () => { if (isWorksheetActive()) runChart(); }); // P41: redraw in the new colours
  // P28: a rename / hide / default aggregation redraws the field pane, the pills and the chart's labels.
  // T02-34: a changed data type cast also re-categorises the pills / filters that read the field.
  bus.addEventListener("fields:changed", () => {
    const active = activeWorksheet();
    let activeChanged = false;
    for (const d of worksheets()) {
      if (!syncCastCategories(d.sheet, sharedFilters, castOf, baseCategoryOf)) continue;
      if (d === active && isWorksheetActive()) activeChanged = true; else commitQuiet(d, d.sheet);
    }
    if (!isWorksheetActive()) return;
    buildFields();
    if (activeChanged) commit(active, active.sheet); else { renderShelves(); runChart(); }
  });
  // Calculated fields: a new / edited / renamed / deleted calculation refreshes every sheet's pills (category, role, live name),
  // the field pane and the chart. An unchanged sheet is just redrawn; a changed one goes through commit().
  const refreshCalcs = () => {
    const catalog = catalogFromEntities([...entities.values()]);
    const active = activeWorksheet();
    let activeChanged = false;
    for (const d of worksheets()) {
      const before = JSON.stringify(d.sheet);
      syncCalcPills(d.sheet, calculations, catalog, parameters);
      if (JSON.stringify(d.sheet) === before) continue;
      if (d === active && isWorksheetActive()) activeChanged = true; else commitQuiet(d, d.sheet);
    }
    if (!isWorksheetActive()) return;
    buildFields();
    if (activeChanged) commit(active, active.sheet); else { renderShelves(); runChart(); }
  };
  bus.addEventListener("calculations:changed", refreshCalcs);
  // P32: a parameter's new value re-runs the view (its filters / Top N / calculated fields / reference line read it at plan time);
  // the same refresh re-types calculated pills (a parameter's type, or its deletion, changes what a formula compiles to).
  bus.addEventListener("parameters:changed", refreshCalcs);
  initPresentation();
  sync();

  async function sync() {
    stopPaging();  // switching view/worksheet halts any running Pages animation
    legendFocus = null; // P29: a highlight belongs to the chart it was made on
    openTool = null; // close any open tool editor when the view changes
    toggle(view, isWorksheetActive());
    if (!isWorksheetActive()) { sheetView.cancel(); shownDash = null; return; }
    const id = activeWorksheet()?.id ?? null;
    if (shownDash && id !== shownDash) enter(view.querySelector(".worksheet"), { y: 4, duration: MOTION.view });
    shownDash = id;
    const cur = activeWorksheet();
    if (cur && !lastSnap.has(cur.id)) lastSnap.set(cur.id, structuredClone(cur.sheet));
    await buildFields();
    renderShelves();
    runChart();
  }
  function stopPaging() { if (pageTimer) { clearInterval(pageTimer); pageTimer = null; } }

  // Drag the field pane's right edge (or ←/→ on the handle) to resize it: 180px … 40% of the
  // worksheet, remembered in this browser. The width lives in .worksheet's --ws-fields-w.
  function initFieldResizer() {
    const sheet = view.querySelector(".worksheet");
    const handle = document.getElementById("ws-fields-resizer");
    if (!sheet || !handle) return;
    wireResizer(handle, {
      min: 180,
      max: () => sheet.getBoundingClientRect().width * 0.4,
      origin: () => sheet.getBoundingClientRect().left,
      current: () => fieldsEl.getBoundingClientRect().width,
      apply: (w) => sheet.style.setProperty("--ws-fields-w", `${w}px`),
      storageKey: "dashboardbuilder.fields.width",
    });
  }

  // --- field pane ----------------------------------------------------------
  // Latest call wins: overlapping calls (e.g. while a workbook restores) each wait for columns, so the
  // pane is replaced once, by the newest build, instead of cleared then appended to twice.
  let fieldsSeq = 0;
  async function buildFields() {
    const seq = ++fieldsSeq;
    const tables = uniqueTables();
    if (!tables.length) {
      fieldsEl.replaceChildren(calcFieldGroup(), hint("Add tables to the Data Model, then drag their fields onto the shelves."));
      filterFields();
      return;
    }
    const groups = [];
    let hiddenCount = 0;
    for (const t of tables) {
      const cols = await columnsFor(t.db, t.table);
      const group = el("details", "ws-table ws-fieldset");
      group.open = true;
      group.append(el("summary", "ws-table__name", `${t.db}.${t.table}`));
      // P28: hidden fields stay out of the pane unless "Show hidden" is on.
      const visible = cols.filter((c) => { const h = metaOf({ ...t, column: c.name }).hidden; if (h) hiddenCount++; return !h || showHiddenFields; });
      const catOf = (c) => effectiveCategory(c.category, castOf({ ...t, column: c.name }));
      const dims = visible.filter((c) => catOf(c) !== "numeric");
      const meas = visible.filter((c) => catOf(c) === "numeric");
      if (dims.length) { group.append(el("div", "ws-field-group", "Dimensions")); for (const c of dims) group.append(fieldChip(t, c, "dimension")); }
      if (meas.length) { group.append(el("div", "ws-field-group", "Measures")); for (const c of meas) group.append(fieldChip(t, c, "measure")); }
      groups.push(group);
    }
    if (seq !== fieldsSeq) return;
    fieldsEl.replaceChildren(fieldTools(hiddenCount), calcFieldGroup(), ...groups);
    filterFields();
  }

  // P28: the field pane's search box + "Show hidden" toggle. Search matches the column name or its
  // display name; non-matching fields and empty groups get `hidden`.
  let fieldQuery = "";
  let showHiddenFields = false;
  function fieldTools(hiddenCount) {
    const box = el("div", "ws-fieldtools");
    const search = el("input", "input ws-fieldtools__search");
    search.type = "search"; search.placeholder = "Search fields"; search.value = fieldQuery;
    search.setAttribute("aria-label", "Search fields");
    search.addEventListener("input", () => { fieldQuery = search.value; filterFields(); });
    box.append(search);
    if (hiddenCount || showHiddenFields) {
      const t = makeButton(showHiddenFields ? `Hide hidden fields` : `Show hidden (${hiddenCount})`, "btn ws-fieldtools__hidden");
      t.setAttribute("aria-pressed", String(showHiddenFields));
      t.addEventListener("click", () => { showHiddenFields = !showHiddenFields; buildFields(); });
      box.append(t);
    }
    return box;
  }
  function filterFields() {
    const q = fieldQuery.trim().toLowerCase();
    for (const group of fieldsEl.querySelectorAll(".ws-fieldset")) {
      let any = false;
      for (const chip of group.querySelectorAll(".ws-field")) {
        const hit = !q || chip.dataset.search.includes(q);
        chip.hidden = !hit;
        any ||= hit;
      }
      for (const label of group.querySelectorAll(".ws-field-group")) {
        let n = label.nextElementSibling, shown = false;
        while (n && n.classList.contains("ws-field")) { if (!n.hidden) shown = true; n = n.nextElementSibling; }
        label.hidden = !shown;
      }
      group.hidden = !any && Boolean(q);
    }
  }

  // --- calculated fields (Plan B): the "Calculated fields" group above the tables ----------------------
  function calcFieldGroup() {
    const group = el("div", "calc-group");
    const head = el("div", "calc-group__title", "Calculated fields");
    head.id = "calc-group-title";
    const catalog = catalogFromEntities([...entities.values()]);
    const state = paneState(calculations, catalog, parameters);
    const add = makeButton("", "btn calc-group__new");
    add.append(icon("plus", { size: 14 }), document.createTextNode("New calculated field"));
    add.disabled = !state.canAdd;
    add.title = state.canAdd ? "Write a formula and use it like a field" : `A workbook can have at most ${LIMITS.calculations} calculated fields.`;
    add.addEventListener("click", () => openCalcDialog(null));
    const list = el("div", "ws-fieldset calc-group__list");
    list.setAttribute("role", "list"); list.setAttribute("aria-labelledby", head.id);
    for (const item of state.items) list.append(calcFieldChip(item));
    group.append(head, add, list);
    return group;
  }

  // The payload a calculated chip drags / adds: a calc pill, with the session's Use-as choice for a row-level number.
  const calcPayload = (item) => makeCalcPill(item.calc, item.info, roleChoice(item.calc.id) ?? undefined);

  function calcFieldChip(item) {
    const { calc, info, chip: kind, error } = item;
    const bad = Boolean(error);
    const aggregate = Boolean(info?.isAggregate);
    const chip = el("div", `ws-field calc-field calc-field--${bad ? "error" : aggregate ? "meas" : "dim"}`);
    chip.setAttribute("role", "listitem");
    chip.dataset.search = calc.name.toLowerCase();
    const typeIcon = icon(aggregate ? "analytics" : "detail", { size: 14 });
    typeIcon.classList.add("calc-field__type");
    chip.append(typeIcon, el("span", "ws-field__name", calc.name));
    if (bad) {
      chip.title = error;
      const badge = el("span", "calc-chip calc-chip--danger");
      badge.append(icon("warning", { size: 13 }), document.createTextNode("Error"));
      chip.append(badge);
    } else {
      chip.title = `${calc.name} · ${kind.text}`;
      const tag = el("span", `calc-chip ${aggregate ? "calc-chip--meas" : "calc-chip--dim"}`, kind.text);
      chip.append(tag);
    }
    chip.append(calcFieldMenu(calc));
    if (!bad) {
      chip.draggable = true;
      const payload = () => calcPayload(item);
      const shelfKey = payload().role === "measure" ? "rows" : "columns";
      const add = el("button", "ws-field__add");
      add.append(icon("plus", { size: 14 }));
      add.type = "button";
      add.setAttribute("aria-label", `Add ${calc.name} to ${shelfKey === "rows" ? "Rows" : "Columns"}`);
      add.title = `Add to ${shelfKey === "rows" ? "Rows" : "Columns"}`;
      add.addEventListener("click", () => { const dash = activeWorksheet(); if (dash) addField(dash, shelfKey, payload()); });
      chip.append(add);
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload()));
        e.dataTransfer.effectAllowed = "copy";
      });
    }
    return chip;
  }

  // A calculation's ⋯ menu: Edit…, Duplicate, Delete…
  function calcFieldMenu(calc) {
    const wrap = el("div", "menu ws-field__menu");
    const btn = iconButton("more", `Actions for ${calc.name}`);
    btn.classList.add("ws-field__more");
    const list = el("div", "menu__list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const item = (label, on) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", "menuitem");
      b.append(document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    list.append(item("Edit…", () => openCalcDialog(calc.id)));
    list.append(item("Duplicate", () => duplicateCalcField(calc)));
    list.append(el("div", "menu__sep"), item("Delete…", () => deleteCalcField(calc)));
    wireMenu(btn, list);
    wrap.append(btn, list);
    return wrap;
  }
  function duplicateCalcField(calc) {
    if (calculations.length >= LIMITS.calculations) { toast(`A workbook can have at most ${LIMITS.calculations} calculated fields.`, "info"); return; }
    let name = `${calc.name} copy`;
    for (let i = 2; !checkName(name, calculations, null).ok && i < 100; i++) name = `${calc.name} copy ${i}`;
    const ok = checkName(name, calculations, null);
    if (!ok.ok) { toast(ok.error, "info"); return; }
    const copy = addCalculation({ name: ok.value, formula: calc.formula });
    setRoleChoice(copy.id, roleChoice(calc.id));
  }
  // B4: refuse while another calculation uses it; ask first when worksheets use it; else just delete.
  async function deleteCalcField(calc) {
    const plan = deleteCalcPlan(calculations, worksheets().map((d) => d.sheet), calc.id, sharedFilters);
    if (plan.refusedBy) { toast(`Used by calculation '${plan.refusedBy.join("', '")}'.`, "info"); return; }
    if (plan.usedInSheets || plan.usedInShared) {
      const n = plan.usedInSheets, m = plan.usedInShared;
      const where = [
        n ? `${n} worksheet${n === 1 ? "" : "s"}` : "",
        m ? `${m} shared Top N filter${m === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" and ");
      const go = await confirmDialog(`“${calc.name}” is used in ${where}. Deleting it removes it from ${n + m === 1 ? "it" : "them"}.`, { danger: true, confirmText: "Delete" });
      if (!go) return;
      clearFilterCalc(sharedFilters, calc.id); // saved with the workbook by the calculations:changed below
      // Commit every sheet that lost pills (the calculations:changed sync below sees them already cleared and wouldn't).
      const active = activeWorksheet();
      for (const d of worksheets()) {
        if (!usesCalc(d.sheet, calc.id)) continue;
        clearCalcPills(d.sheet, calc.id);
        if (d === active && isWorksheetActive()) commit(d, d.sheet); else commitQuiet(d, d.sheet);
      }
    }
    setRoleChoice(calc.id, null);
    removeCalculation(calc.id);
  }

  function fieldChip(t, col, role) {
    const chip = el("div", `ws-field ws-field--${role}`);
    chip.draggable = true;
    chip.title = `${col.name} · ${col.type}`;
    const meta = metaOf({ db: t.db, table: t.table, column: col.name });
    const payload = { db: t.db, table: t.table, column: col.name, category: effectiveCategory(col.category, meta.cast) };
    const typeIcon = icon(TYPE_ICONS[payload.category] ?? "type-other", { size: 14 });
    typeIcon.classList.add("ws-field__type");
    const nameEl = el("span", "ws-field__name", meta.alias || col.name);
    if (meta.alias) { nameEl.title = `${meta.alias} — column ${col.name}`; chip.classList.add("is-renamed"); }
    if (meta.hidden) chip.classList.add("is-hidden");
    chip.dataset.search = `${col.name} ${meta.alias ?? ""}`.toLowerCase();
    chip.append(typeIcon, nameEl);
    if (meta.cast) { chip.classList.add("is-cast"); chip.append(castBadge(meta.cast, col.category, false)); }
    chip.append(fieldMenu(payload, col, nameEl));

    // Keyboard/non-drag path (a11y): a focusable plus button adds the field to its natural shelf without
    // dragging — measures to Rows, dimensions to Columns (mirrors the sidebar table chip's plus button).
    const shelfKey = role === "measure" ? "rows" : "columns";
    const shelfLabel = role === "measure" ? "Rows" : "Columns";
    const add = el("button", "ws-field__add");
    add.append(icon("plus", { size: 14 }));
    add.type = "button";
    add.setAttribute("aria-label", `Add ${col.name} to ${shelfLabel}`);
    add.title = `Add to ${shelfLabel}`;
    add.addEventListener("click", () => {
      const dash = activeWorksheet();
      if (dash) addField(dash, shelfKey, payload);
    });
    chip.append(add);

    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    });
    return chip;
  }

  // T02-34: the cast tag — icon + text (never colour alone); its title says what the field was.
  // On a field chip the leading type icon already shows the new type, so the tag there is text only.
  function castBadge(cast, from, withIcon = true) {
    const b = el("span", "ws-cast");
    if (withIcon) b.append(icon(TYPE_ICONS[effectiveCategory(from, cast)] ?? "type-other", { size: 12 }));
    b.append(document.createTextNode(`as ${castLabel(cast)}`));
    b.title = `Read as ${castLabel(cast).toLowerCase()} (stored as ${from === "numeric" ? "number" : from === "temporal" ? "date" : from})`;
    return b;
  }
  // P28: a field's ⋯ menu — Rename (inline), Default aggregation (numeric), Hide / Show.
  function fieldMenu(f, col, nameEl) {
    const wrap = el("div", "menu ws-field__menu");
    const btn = iconButton("more", `Options for ${col.name}`);
    btn.classList.add("ws-field__more");
    const list = el("div", "menu__list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const item = (label, on, extra = {}) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", extra.role ?? "menuitem");
      if (extra.checked !== undefined) { b.setAttribute("aria-checked", String(extra.checked)); b.append(icon("check", { size: 14 })); }
      b.append(document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    const meta = metaOf(f);
    list.append(item("Rename…", () => renameField(f, col, nameEl)));
    if (meta.alias) list.append(item("Use the column name", () => setFieldMeta(f, { alias: null })));
    const effCat = effectiveCategory(col.category, meta.cast); // T02-34: a text column cast to Number aggregates like a number
    if (effCat === "numeric") {
      list.append(el("div", "menu__sep"), el("div", "menu__heading", "Default aggregation"));
      for (const a of aggsFor(effCat))
        list.append(item(a, () => setFieldMeta(f, { agg: a === "sum" ? null : a }), { role: "menuitemradio", checked: (meta.agg ?? "sum") === a }));
    }
    // T02-34: read the field as another type (the server converts; a value that doesn't fit becomes empty).
    list.append(el("div", "menu__sep"), el("div", "menu__heading", "Data type"));
    // A stored default aggregation the new type doesn't offer is cleared with the cast.
    const setCast = (c) => setFieldMeta(f, { cast: c, ...(meta.agg && !aggsFor(effectiveCategory(col.category, c)).includes(meta.agg) ? { agg: null } : {}) });
    list.append(item("Original", () => setCast(null), { role: "menuitemradio", checked: !meta.cast }));
    for (const c of castChoices(col.category))
      list.append(item(castLabel(c), () => setCast(c), { role: "menuitemradio", checked: meta.cast === c }));
    list.append(el("div", "menu__sep"), item(meta.hidden ? "Show in the field list" : "Hide from the field list", () => setFieldMeta(f, { hidden: !meta.hidden })));
    wireMenu(btn, list);
    wrap.append(btn, list);
    return wrap;
  }
  // Inline rename, like a tab: Enter / blur saves (1–60 characters; blank = back to the column name), Esc cancels.
  function renameField(f, col, nameEl) {
    const input = el("input", "input ws-field__rename");
    input.value = metaOf(f).alias ?? col.name;
    input.maxLength = LIMITS.tabName;
    input.setAttribute("aria-label", `Display name for ${col.name}`);
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (!save) { input.replaceWith(nameEl); return; }
      setFieldMeta(f, { alias: !v || v === col.name ? null : v.slice(0, LIMITS.tabName) });
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("dragstart", (e) => e.preventDefault());
  }

  // --- shelves -------------------------------------------------------------
  function renderShelves() {
    const dash = activeWorksheet();
    if (!dash) return;
    const s = dash.sheet;
    withCategories(s.filters, categoryOf);
    withCategories(sharedFilters, categoryOf);
    // Data controls live in the glass header; view controls live on the chart card they act on.
    //  • Header: the PRIMARY shelves **Columns** and **Rows**, then **Marks** — every other encoding
    //    (Color/Label/…, Filters/Drill/Pages) as a compact icon+text toolbar on the same label grid;
    //    clicking a tool opens ONE small editor panel, and a field can be dropped straight onto a tool.
    //  • Chart card head: chart-type picker (left); sort picker · format · export · refresh (right).
    headerAbort?.abort(); headerAbort = new AbortController();

    const columns = shelf("Columns", "columns", s.columns.map((f, i) => fieldPill(dash, s, "columns", f, i)), (f) => addField(dash, "columns", f));
    const rows = shelf("Rows", "rows", s.rows.map((f, i) => fieldPill(dash, s, "rows", f, i)), (f) => addField(dash, "rows", f));

    const tools = buildTools(dash, s);
    const { visible, more } = visibleTools(s.chartType, tools);
    const toolbar = el("div", "ws-toolbar");
    for (const t of visible) toolbar.append(toolButton(dash, s, t));
    if (more.length) {
      const wrap = el("div", "menu ws-more");
      const btn = el("button", "ws-tool"); btn.type = "button";
      btn.append(icon("more"), el("span", "ws-tool__text", "More"));
      const list = el("div", "menu__list menu__list--start"); list.setAttribute("role", "menu"); list.hidden = true;
      for (const t of more) {
        const item = el("button", "menu__item"); item.type = "button"; item.setAttribute("role", "menuitem");
        item.append(icon(t.icon), document.createTextNode(t.label));
        item.addEventListener("click", () => { openTool = t.key; formatOpen = false; showMeOpen = false; renderShelves(); });
        list.append(item);
      }
      wrap.append(btn, list); toolbar.append(wrap);
      wireMenu(btn, list, { signal: headerAbort.signal });
    }
    const marks = el("div", "ws-shelf ws-shelf--marks");
    marks.append(el("span", "ws-shelf__label", "Marks"), toolbar);

    const children = [fieldsToggle(), columns, rows, marks];
    const active = tools.find((t) => t.key === openTool);
    const toolEl = calcFor ? calcPanel(dash, s) : choicesFor ? choicesPanel(dash, s) : active ? toolPanel(dash, s, active) : null;
    if (toolEl) children.push(toolEl);                        // the one open tool editor
    // Active-interaction chips (thin status bars for live drill / pages / click-selection state).
    if (isDrillActive(s)) children.push(drillChip(dash, s));  // P16 breadcrumb + drill-up
    if (s.pages) children.push(pagesControl(dash, s));        // P20 page/animate control
    if (s.selection) children.push(selectionChip(dash, s));   // P15 click-to-filter selection
    shelvesEl.replaceChildren(...children);

    const viewbar = el("div", "ws-viewbar");
    const vbRight = el("div", "ws-viewbar__group ws-viewbar__group--right");
    const vbIcons = el("div", "ws-viewbar__icons");
    vbIcons.append(formatToggle(), analyticsToggle(), exportControl(dash, s), refreshButton(dash), sheetActions(dash, s), fullScreenButton());
    vbRight.append(sortControl(dash, s), vbIcons);
    const vbLeft = el("div", "ws-viewbar__group");
    vbLeft.append(chartTypePicker(dash, s), showMeToggle(), undoButtons(dash),
      explainControl(() => evaluationInput(s, { sharedFilters: sharedFilters.filter((f) => checkFilter(f).state === "ok" && !sharedSkipped(s).includes(f)), parameters, calcs: calculations, isApplied: (f) => checkFilter(f).state === "ok", dimensions: planDims(s).keyOrder.filter(Boolean).map(nameOf) }), { signal: headerAbort.signal }));
    viewbar.append(vbLeft, vbRight);
    const fmtEl = showMeOpen ? showMePanel(dash, s) : formatOpen ? formatPanel(dash, s) : analyticsOpen ? analyticsPanel(dash, s) : null; // P10 format / P21 analytics card
    const swEl = switchers(dash, s); // P40
    const titleEl = s.showTitle === false ? null : titleBlock(dash, s); // P23
    const cardsEl = filterCards(dash, s); // P30
    const paramsEl = paramControls(s); // P32
    headEl.replaceChildren(viewbar, ...(swEl ? [swEl] : []), ...(fmtEl ? [fmtEl] : []), ...(titleEl ? [titleEl] : []), ...(paramsEl ? [paramsEl] : []), ...(cardsEl ? [cardsEl] : []));

    // Motion only for what is new since the last render (every edit re-renders the header).
    const panelKey = toolEl ? `tool:${openTool}` : fmtEl ? (showMeOpen ? "showme" : "format") : null;
    if (panelKey && panelKey !== shownPanel) enter(toolEl ?? fmtEl);
    shownPanel = panelKey;
    const pillKeys = new Set();
    for (const p of shelvesEl.querySelectorAll(".ws-pill[data-key]")) {
      const k = `${p.closest(".ws-shelf, .ws-toolpanel")?.className}|${p.dataset.key}`;
      if (shownFor === dash.id && !shownPills.has(k)) enter(p, { y: 4 });
      pillKeys.add(k);
    }
    shownPills = pillKeys;
    shownFor = dash.id;
  }

  // --- click-to-filter selection chip (P15) --------------------------------
  // Shows the mark the user clicked and lets them apply it as a filter: Keep only (col = value),
  // Exclude (col != value), or clear. Toggling an already-active action returns to a plain highlight.
  function selectionChip(dash, s) {
    const sel = s.selection;
    const wrap = el("div", "ws-select");
    wrap.append(iconSpan("ws-select__icon", "filter"), el("span", "ws-select__label", `Selected: ${sel.label}`));
    const setAction = (a) => { sel.action = sel.action === a ? null : a; commit(dash, s); };
    const btn = (label, a) => {
      const b = makeButton(label, `ws-select__btn${sel.action === a ? " is-active" : ""}`);
      b.setAttribute("aria-pressed", String(sel.action === a));
      b.addEventListener("click", () => setAction(a));
      return b;
    };
    const clear = iconButton("close", "Clear selection");
    clear.addEventListener("click", () => { s.selection = null; legendFocus = null; commit(dash, s); });
    wrap.append(btn("Keep only", "keep"), btn("Exclude", "exclude"));
    const rowsBtn = makeButton("View data", "ws-select__btn"); // the raw rows behind this mark
    rowsBtn.prepend(icon("eye", { size: 14 }));
    rowsBtn.addEventListener("click", () => viewData(dash, s, true));
    wrap.append(rowsBtn);
    // P39 URL action: open the sheet's link for the selected value (new tab, noopener, https only).
    if (s.urlAction && !templateError(s.urlAction.template)) {
      const go = makeButton(`${s.urlAction.label} ↗`, "ws-select__btn ws-select__link");
      go.prepend(icon("link", { size: 14 }));
      const r = buildActionUrl(s.urlAction.template, sel.value);
      go.title = r.url ?? r.error;
      go.addEventListener("click", () => {
        const now = buildActionUrl(s.urlAction.template, sel.value);
        if (now.error) { toast(now.error, "danger"); return; }
        window.open(now.url, "_blank", "noopener,noreferrer");
      });
      wrap.append(go);
    }
    wrap.append(clear);
    return wrap;
  }

  // --- drill-down hierarchy (P16) ------------------------------------------
  // Drop dimension fields (from one table) onto the Drill-down lane to declare an ordered hierarchy;
  // with ≥2 levels the chart groups by the current level and a click drills one level finer (see
  // selectHandler → drillDown). Each pinned ancestor rides along as a bound-parameter filter.
  function addDrillLevel(dash, f) {
    const refused = refusal(f, "drill");
    if (refused) { toast(refused, "info"); return; }
    const s = dash.sheet;
    const d = s.drill ?? (s.drill = { levels: [], depth: 0, path: [] });
    if (d.levels.length && (d.levels[0].db !== f.db || d.levels[0].table !== f.table)) {
      toast("Drill levels must all come from one table.", "info");
      return;
    }
    if (d.levels.some((l) => l.column === f.column)) return; // a level can't repeat
    if (d.levels.length >= LIMITS.drillLevels) {
      toast(`A drill hierarchy can have at most ${LIMITS.drillLevels} levels.`, "info");
      return;
    }
    d.levels.push({ db: f.db, table: f.table, column: f.column, category: f.category });
    d.depth = 0; d.path = []; // redefining the hierarchy resets the descent to the top level
    commit(dash, s);
  }

  // A level pill: ordinal + table.column, removable. Editing the levels resets the descent.
  function drillLevelPill(dash, s, level, i) {
    const remove = () => {
      s.drill.levels.splice(i, 1);
      if (!s.drill.levels.length) s.drill = null;
      else { s.drill.depth = 0; s.drill.path = []; }
      commit(dash, s);
    };
    const p = pill(`${i + 1}. ${level.table}.${level.column}`, remove);
    p.classList.add("ws-pill--drill");
    return p;
  }

  // Breadcrumb + drill-up. Crumb j targets depth j: "All" (top) then each pinned ancestor value; the
  // crumb at the current depth is inert. the Up button ascends one level. Clicking a crumb truncates the path.
  function drillChip(dash, s) {
    const d = s.drill;
    const wrap = el("div", "ws-drill");
    wrap.append(iconSpan("ws-drill__icon", "drill"), el("span", "ws-select__label", "Drill"));
    const crumbs = el("div", "ws-drill__crumbs");
    const labels = ["All", ...(d.path ?? []).map((p) => p.label)];
    labels.forEach((text, j) => {
      if (j) crumbs.append(el("span", "ws-drill__sep", "›"));
      if (j === d.depth) {
        crumbs.append(el("span", "ws-drill__crumb is-current", text));
      } else {
        const b = makeButton(text, "ws-drill__crumb");
        b.addEventListener("click", () => drillTo(d, dash, s, j));
        crumbs.append(b);
      }
    });
    wrap.append(crumbs);
    const showing = d.levels[Math.min(d.depth, d.levels.length - 1)]?.column;
    wrap.append(el("span", "ws-drill__level", `Showing: ${showing}`));
    const up = makeButton("Up", "ws-drill__crumb ws-drill__up");
    up.prepend(icon("chevron", { size: 14 }));
    up.firstChild.classList.add("icon--up");
    up.disabled = d.depth === 0;
    up.setAttribute("aria-label", "Drill up one level");
    up.addEventListener("click", () => drillTo(d, dash, s, d.depth - 1));
    wrap.append(up);
    return wrap;
  }

  // Jump to depth j (clamped): pin values above it stay, the rest are dropped.
  function drillTo(d, dash, s, j) {
    d.depth = Math.max(0, Math.min(j, d.levels.length - 1));
    d.path = (d.path ?? []).slice(0, d.depth);
    commit(dash, s);
  }

  // Descend one level, pinning the clicked value of the current level. A no-op at the finest level.
  function drillDown(rawValue) {
    const dash = activeWorksheet();
    if (!dash) return;
    const s = dash.sheet;
    if (!isDrillActive(s)) return;
    const d = s.drill;
    if (d.depth >= d.levels.length - 1) return; // nothing finer to drill into
    const fmtCat = makeCategoryFormatter(s.format ?? defaultFormat());
    d.path = [...(d.path ?? []).slice(0, d.depth), { column: d.levels[d.depth].column, value: rawValue, label: fmtCat(rawValue) }];
    d.depth += 1;
    s.selection = null; // a drill supersedes any P15 mark selection
    commit(dash, s);
  }

  // --- format panel (P10) --------------------------------------------------
  // A collapsible row of presentation controls that never touch the query (except Top-N, which
  // caps the LIMIT). All state lives on sheet.format so it persists for the session (O1).
  // Re-run the query against ClickHouse, bypassing the result cache (data may have changed).
  function refreshButton(dash) {
    const btn = iconButton("refresh", "Refresh");
    btn.title = "Re-run the query against ClickHouse";
    btn.addEventListener("click", () => sheetView.refresh());
    return btn;
  }

  // P21: the Analytics card toggle (like Format) and the card itself.
  function analyticsToggle() {
    const btn = iconButton("analytics", "Analytics");
    btn.className = `iconbtn ws-viewbar__btn${analyticsOpen ? " is-active" : ""}`;
    btn.setAttribute("aria-pressed", String(analyticsOpen));
    btn.setAttribute("aria-expanded", String(analyticsOpen));
    btn.title = "Analytics — reference lines, trend, forecast, totals";
    btn.addEventListener("click", () => { analyticsOpen = !analyticsOpen; if (analyticsOpen) { openTool = null; formatOpen = false; showMeOpen = false; } renderShelves(); });
    return btn;
  }
  function analyticsPanel(dash, s) {
    const a = { ...defaultAnalytics(), ...(s.analytics ?? {}) };
    const set = (patch) => { s.analytics = { ...a, ...patch }; commit(dash, s); };
    const panel = el("div", "ws-format ws-analytics");
    panel.append(el("span", "ws-shelf__label", "Analytics"));
    const isTable = s.chartType === "table" || s.chartType === "text";
    if (ANALYTICS_TYPES.has(s.chartType)) {
      panel.append(fmtSelect("Reference line", REF_CHOICES, a.ref.kind, (v) => set({ ref: { kind: v, ...(v === "constant" ? { value: a.ref.value ?? 0 } : {}) } })));
      if (a.ref.kind === "constant") {
        const numParams = parameters.filter((p) => p.type === "number");
        const bound = numParams.some((p) => p.id === a.ref.param) ? a.ref.param : "";
        if (bound) panel.append(fmtSelect("at", [["", "A typed value"], ...numParams.map((p) => [p.id, `Parameter: ${p.name}`])], bound, (v) => set({ ref: { kind: "constant", value: a.ref.value ?? 0, ...(v ? { param: v } : {}) } })));
        else {
          panel.append(fmtNumber("at", a.ref.value, "0", (v) => set({ ref: { kind: "constant", value: v ?? 0 } })));
          if (numParams.length) panel.append(fmtSelect("or follow", [["", "none"], ...numParams.map((p) => [p.id, p.name])], "", (v) => set({ ref: { kind: "constant", value: a.ref.value ?? 0, ...(v ? { param: v } : {}) } })));
        }
      }
      panel.append(fmtNumber("Band from", a.band?.from ?? null, "none", (v) => set({ band: v == null ? null : { from: v, to: a.band?.to ?? v } })),
        fmtNumber("to", a.band?.to ?? null, "none", (v) => set({ band: v == null ? null : { from: a.band?.from ?? v, to: v } })),
        fmtSelect("Trend", TREND_CHOICES, a.trend, (v) => set({ trend: v })));
      if (s.chartType === "line" || s.chartType === "area")
        panel.append(fmtSelect("Forecast", FORECAST_CHOICES, a.forecast, (v) => set({ forecast: Number(v) })));
      panel.append(el("span", "ws-shelf__note", "On the first measure, over the rows shown, in category order. A forecast extends the trend (linear if none is picked)."));
    } else if (isTable) {
      panel.append(fmtCheck("Grand totals", a.totals.grand, (v) => set({ totals: { ...a.totals, grand: v } })),
        fmtCheck("Subtotals", a.totals.sub, (v) => set({ totals: { ...a.totals, sub: v } })),
        el("span", "ws-shelf__note", "Sums and counts add up; min / max take the min / max; averages and distinct counts can't be totalled from their parts — they show —."));
    } else {
      panel.append(el("span", "ws-shelf__note", "Analytics work on Bar, Line and Area charts, and totals on Table / Text."));
    }
    return panel;
  }

  function formatToggle() {
    const btn = iconButton("format", "Format");
    btn.className = `iconbtn ws-viewbar__btn${formatOpen ? " is-active" : ""}`;
    btn.setAttribute("aria-pressed", String(formatOpen));
    btn.title = "Format";
    btn.setAttribute("aria-expanded", String(formatOpen));
    btn.addEventListener("click", () => { formatOpen = !formatOpen; if (formatOpen) { openTool = null; analyticsOpen = false; showMeOpen = false; } renderShelves(); });
    return btn;
  }
  // P22 Show Me: every chart type, greyed with the reason when the sheet's fields can't draw it, the best
  // one outlined; a click sets the type and lays Columns / Rows out for it (one commit = one undo step).
  function showMeToggle() {
    const btn = iconButton("show-me", "Show Me");
    btn.className = `iconbtn ws-viewbar__btn ws-showme-toggle${showMeOpen ? " is-active" : ""}`;
    btn.append(el("span", null, "Show Me"));
    btn.setAttribute("aria-pressed", String(showMeOpen));
    btn.setAttribute("aria-expanded", String(showMeOpen));
    btn.title = "Show Me — chart types that fit these fields";
    btn.addEventListener("click", () => {
      showMeOpen = !showMeOpen; if (showMeOpen) { openTool = null; formatOpen = false; analyticsOpen = false; }
      renderShelves();
      headEl.querySelector(".ws-showme-toggle")?.focus(); // the re-render replaced this button
    });
    return btn;
  }
  function showMePanel(dash, s) {
    const panel = el("div", "ws-format ws-showme");
    panel.append(el("span", "ws-shelf__label", "Show Me"));
    const status = el("p", "ws-shelf__note ws-showme__status");
    status.setAttribute("aria-live", "polite");
    const empty = !s.columns.length && !s.rows.length; // a drill level alone isn't "fields to suggest for"
    if (empty) status.textContent = "Add fields to Columns or Rows to see suggestions.";
    const grid = el("div", "ws-showme__grid");
    for (const o of showMeOptions(CHART_TYPES.map(([id]) => id), (type) => showMeCounts(s, type))) {
      const tile = el("button", "ws-showme__tile"); tile.type = "button"; tile.dataset.type = o.id;
      tile.append(icon(chartIcon(o.id)), el("span", "ws-showme__label", chartLabel(o.id)));
      const current = o.id === s.chartType;
      tile.setAttribute("aria-pressed", String(current));
      if (current) { const tick = icon("check", { size: 14 }); tick.classList.add("ws-showme__check"); tile.append(tick); }
      if (o.recommended && !empty) { tile.classList.add("is-recommended"); tile.append(el("span", "ws-showme__badge", "Recommended")); }
      if (o.issue) {
        tile.setAttribute("aria-disabled", "true"); tile.title = o.issue;
        const why = el("span", null, o.issue); why.id = `ws-showme-why-${o.id}`; why.hidden = true;
        tile.setAttribute("aria-describedby", why.id); tile.append(why);
        tile.addEventListener("click", () => { status.textContent = `${chartLabel(o.id)}: ${o.issue}`; });
      } else {
        tile.addEventListener("click", () => {
          const placed = placeFor(o.id, s.columns, s.rows);
          if (current && samePlacement(placed, s)) return; // already laid out — no empty undo step
          s.chartType = o.id; s.columns = placed.columns; s.rows = placed.rows;
          commit(dash, s); // re-renders the header synchronously
          headEl.querySelector(`.ws-showme__tile[data-type="${o.id}"]`)?.focus();
        });
      }
      grid.append(tile);
    }
    panel.append(grid, status);
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); showMeOpen = false; renderShelves();
      headEl.querySelector(".ws-showme-toggle")?.focus();
    });
    return panel;
  }

  // --- export (P13) --------------------------------------------------------
  // A small menu offering the chart image (PNG/SVG from the live ECharts instance) and the rows behind
  // it as CSV (the bounded, identifier-safe /api/query/export.csv). Image export needs a chart instance
  // (Table/KPI render as native DOM, so it isn't offered there).
  function exportControl(dash, s) {
    const wrap = el("div", "menu ws-export");
    const btn = iconButton("export", "Export");
    btn.title = "Export";
    const menu = el("div", "menu__list");
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const item = (glyph, label, on) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", "menuitem");
      b.append(icon(glyph), document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    menu.append(
      item("chart-bar", "PNG image", () => exportImage(dash, s, "png")),
      item("chart-bar", "SVG image", () => exportImage(dash, s, "svg")),
      item("table", "CSV data", () => exportCsvRows(dash, s)),
      item("eye", "View data", () => viewData(dash, s, false)),
      item("print", "Print / PDF…", () => printView(dash, s)),
    );
    wireMenu(btn, menu, { signal: headerAbort?.signal }); // click toggles; Esc/outside/item click close; arrows move
    wrap.append(btn, menu);
    return wrap;
  }

  // Phone layout (P41): the field pane is an overlay opened from the data header (CSS shows this button
  // only on narrow screens; on wide ones the pane is always beside the shelves).
  function fieldsToggle() {
    const ws = view.querySelector(".worksheet");
    const open = ws.classList.contains("is-fields-open");
    const btn = makeButton(open ? "Hide fields" : "Fields", `btn ws-fields-toggle${open ? " is-active" : ""}`);
    btn.prepend(icon("table", { size: 16 }));
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-controls", "ws-fields");
    btn.addEventListener("click", () => { ws.classList.toggle("is-fields-open"); renderShelves(); });
    return btn;
  }

  // --- worksheet chrome (P23): undo / redo, sheet actions, title / caption, status bar ---
  function undoButtons(dash) {
    const wrap = el("div", "ws-undo");
    const u = iconButton("undo", "Undo (Ctrl+Z)"), r = iconButton("redo", "Redo (Ctrl+Shift+Z)");
    u.disabled = !history.canUndo(dash.id); r.disabled = !history.canRedo(dash.id);
    u.title = "Undo (Ctrl+Z)"; r.title = "Redo (Ctrl+Shift+Z)";
    u.addEventListener("click", () => step("undo")); r.addEventListener("click", () => step("redo"));
    wrap.append(u, r);
    return wrap;
  }
  function step(which) {
    const dash = activeWorksheet();
    if (!dash || !isWorksheetActive()) return;
    stopPaging();
    const target = history[which](dash.id, dash.sheet);
    if (!target) return;
    lastSnap.set(dash.id, structuredClone(target));
    updateSheet(dash.id, target);
  }
  function initUndoKeys() {
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || !isWorksheetActive() || view.hidden) return;
      if (e.target.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return; // the field's own undo
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); step("undo"); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); step("redo"); }
    });
  }
  // The ⋯ menu: Swap Rows ↔ Columns, Clear sheet…, Fit (radio), Show title.
  function sheetActions(dash, s) {
    const wrap = el("div", "menu ws-actions");
    const btn = iconButton("more", "Sheet actions");
    btn.title = "Sheet actions";
    const menu = el("div", "menu__list");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const item = (label, on, extra = {}) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", extra.role ?? "menuitem");
      if (extra.checked !== undefined) { b.setAttribute("aria-checked", String(extra.checked)); b.append(icon("check", { size: 14 })); }
      else if (extra.icon) b.append(icon(extra.icon));
      b.append(document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    const fit = s.format?.fit ?? "standard";
    menu.append(
      item("Swap Rows and Columns", () => swapShelves(dash, s), { icon: "swap" }),
      item("Clear sheet…", () => clearSheet(dash, s), { icon: "close" }),
      el("div", "menu__sep"), el("div", "menu__heading", "Fit"),
      ...[["standard", "Standard (scroll)"], ["width", "Fit width"], ["height", "Fit height"], ["entire", "Entire view"]].map(([v, t]) =>
        item(t, () => { s.format = { ...(s.format ?? defaultFormat()), fit: v }; commit(dash, s); }, { role: "menuitemradio", checked: fit === v })),
      el("div", "menu__sep"),
      item("Show title and caption", () => { s.showTitle = s.showTitle === false; commit(dash, s); }, { role: "menuitemcheckbox", checked: s.showTitle !== false }),
      item("Show filter cards", () => { s.showFilterCards = s.showFilterCards === false; commit(dash, s); }, { role: "menuitemcheckbox", checked: s.showFilterCards !== false }),
    );
    wireMenu(btn, menu, { signal: headerAbort?.signal });
    wrap.append(btn, menu);
    return wrap;
  }
  function swapShelves(dash, s) {
    [s.columns, s.rows] = [s.rows, s.columns];
    normaliseShelf(s, "columns"); normaliseShelf(s, "rows");
    choicesFor = null; calcFor = null;
    commit(dash, s);
  }
  async function clearSheet(dash, s) {
    if (dashboardHasContentSheet(s) && !(await confirmDialog("Clear this sheet? Fields, filters, marks and format go — Undo brings them back.", { danger: true, confirmText: "Clear" }))) return;
    const fresh = emptySheet();
    fresh.chartType = s.chartType;
    choicesFor = null; calcFor = null; openTool = null;
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, fresh);
    commit(dash, s);
  }
  const dashboardHasContentSheet = (s) => Boolean(s.columns.length || s.rows.length || s.filters.length || s.color?.length || s.period || s.drill || s.pages);
  // The automatic caption: "sum amount by customers.name, customers.country · 2 filters".
  const autoCaption = (s) => captionText(s, { measureName, nameOf });
  // Title (defaults to the tab name) and caption (defaults to autoCaption): click to edit, Enter saves,
  // Esc cancels; an empty value goes back to the automatic one.
  function titleBlock(dash, s) {
    const box = el("div", "ws-titleblock");
    const editable = (tag, cls, value, auto, max, key, label) => {
      const b = el("button", `ws-titleblock__btn ${cls}${value ? "" : " is-auto"}`);
      b.type = "button";
      b.append(el(tag, null, value || auto || (key === "caption" ? "Add a caption" : "")));
      b.title = `Edit the ${label}`;
      b.setAttribute("aria-label", `${label}: ${value || auto || "none"} — edit`);
      b.addEventListener("click", () => {
        const input = el("input", `input ws-titleblock__input ${cls}`);
        input.value = value ?? ""; input.placeholder = auto || label; input.maxLength = max;
        input.setAttribute("aria-label", label);
        b.replaceWith(input); input.focus(); input.select();
        let done = false;
        const finish = (save) => {
          if (done) return; done = true;
          if (!save) { renderShelves(); return; }
          const v = input.value.trim();
          s[key] = v && v !== auto ? v.slice(0, max) : null;
          commit(dash, s);
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
        input.addEventListener("blur", () => finish(true));
      });
      return b;
    };
    box.append(editable("h2", "ws-titleblock__title", s.title, dash.name, 80, "title", "Title"),
      editable("p", "ws-titleblock__caption", s.caption, autoCaption(s), 300, "caption", "Caption"));
    return box;
  }
  // The status bar under the chart: marks, rows × columns, the selection.
  function setStatusBar(s, result) {
    const bar = document.getElementById("ws-statusbar");
    if (!bar) return;
    if (!result) { bar.replaceChildren(); toggle(bar, false); return; }
    bar.textContent = statusText(s, result);
    toggle(bar, true);
  }

  // --- presentation (P41): full screen + print ------------------------------
  const card = chartEl.closest(".ws-chart-card");
  const isFull = () => document.fullscreenElement === card || card.classList.contains("is-presenting");
  // Full screen shows the chart card alone (view bar kept — Esc or the button leaves). Uses the browser's
  // Fullscreen API; where that's refused, a fixed overlay with the same look and an Esc handler.
  function fullScreenButton() {
    const on = isFull();
    const btn = iconButton(on ? "collapse" : "expand", on ? "Exit full screen" : "Full screen");
    btn.className = `iconbtn ws-viewbar__btn${on ? " is-active" : ""}`;
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Exit full screen (Esc)" : "Full screen";
    btn.addEventListener("click", () => toggleFullScreen());
    return btn;
  }
  async function toggleFullScreen() {
    if (isFull()) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      card.classList.remove("is-presenting");
    } else {
      try { await card.requestFullscreen(); }
      catch { card.classList.add("is-presenting"); }
    }
    renderShelves();
  }
  function initPresentation() {
    // Phone field pane: a tap outside it, or Esc, closes it.
    const ws = view.querySelector(".worksheet");
    const closeFields = () => { if (ws.classList.contains("is-fields-open")) { ws.classList.remove("is-fields-open"); renderShelves(); } };
    ws.querySelector(".ws-main")?.addEventListener("pointerdown", (e) => { if (!e.target.closest(".ws-fields-toggle")) closeFields(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ws.classList.contains("is-fields-open")) closeFields(); });
    document.addEventListener("fullscreenchange", () => { if (isWorksheetActive()) renderShelves(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && card.classList.contains("is-presenting") && !e.defaultPrevented) {
        card.classList.remove("is-presenting"); renderShelves();
      }
    });
    bus.addEventListener("view:changed", () => {
      if (card.classList.contains("is-presenting")) card.classList.remove("is-presenting");
      if (document.fullscreenElement === card) document.exitFullscreen().catch(() => {});
    });
    // Print: a header naming the worksheet, its filters / range and the notice; the chart drawn at page
    // size (print.css rules in dashboard.css hide everything else). Removed after printing.
    window.addEventListener("beforeprint", () => { if (isWorksheetActive()) beginPrint(); });
    window.addEventListener("afterprint", endPrint);
  }
  let printHead = null;
  function beginPrint() {
    const dash = activeWorksheet();
    if (!dash || printHead) return;
    const s = dash.sheet;
    printHead = el("div", "ws-print-head");
    printHead.append(el("h1", "ws-print-head__title", s.title || dash.name));
    if (s.showTitle !== false) printHead.append(el("p", "ws-print-head__line", s.caption || autoCaption(s)));
    const lines = [];
    const range = s.period ? periodNotice(s, null) : null;
    if (range) lines.push(`Date range: ${s.period.table}.${s.period.column} — ${range}`);
    for (const f of s.filters.filter((x) => checkFilter(x).state === "ok"))
      lines.push(`Filter: ${f.table}.${f.column} ${f.op === "notin" ? OP_LABELS.notin : f.op} ${f.values ? f.values.join(f.op === "between" ? " – " : ", ") : f.value}`);
    if (noticeEl && !noticeEl.hidden && noticeEl.textContent) lines.push(noticeEl.textContent);
    lines.push(`Printed ${new Date().toLocaleString()}`);
    for (const l of lines) printHead.append(el("p", "ws-print-head__line", l));
    card.prepend(printHead);
    sizeChart(chartEl, { width: 1000, height: 560 });
  }
  function endPrint() {
    printHead?.remove(); printHead = null;
    sizeChart(chartEl, null);
  }
  function printView() { window.print(); }

  async function exportImage(dash, s, kind) {
    if (!hasChartInstance(chartEl)) { toast("This view has no chart image to export — switch to a chart type (Table/KPI export as CSV).", "info"); return; }
    try {
      const out = await exportChart(chartEl, kind);
      if (!out) { toast(kind === "png" ? "Couldn't rasterise the chart — try SVG." : "Nothing to export yet.", "danger"); return; }
      downloadBlob(out.blob, `${exportBaseName(dash)}.${out.ext}`);
    } catch { toast("Image export failed.", "danger"); }
  }

  // View data: the raw rows of the view's base table behind the current view, or behind the selected mark
  // (rows-model.js decides what applies; whatever can't is named in the dialog).
  function viewData(dash, s, ofMark) {
    const problem = calcProblem(s, calcFieldCtx(), appliedShared());
    if (problem) { toast(problem, "danger"); return; }
    const plan = buildPlan({ ...s, selection: null }); // the mark is added back as a plain `=`, whatever Keep / Exclude did
    if (!plan) { toast("Add fields before viewing data.", "info"); return; }
    const { request, notes } = buildRowsRequest({ plan, selection: ofMark ? s.selection : null, castOf });
    openRowsDialog({ title: ofMark ? `Data behind ${s.selection.label}` : "Data behind this view", subtitle: `${request.db}.${request.table}`, request, notes, filename: `${exportBaseName(dash)}-data` });
  }

  async function exportCsvRows(dash, s) {
    if (STAT_SINGLE_TABLE.has(s.chartType)) { toast("CSV export isn't available for histogram / box plot yet — export the chart image instead.", "info"); return; }
    const problem = calcProblem(s, calcFieldCtx(), appliedShared());
    if (problem) { toast(problem, "danger"); return; }
    const view = buildPlan(s);
    if (!view) { toast("Add fields from related tables before exporting.", "info"); return; }
    // The whole result (up to 100,000 rows), not just what the view shows: no Top-N, no paging.
    const plan = { ...view, limit: LIMITS.exportRows, offset: undefined, withTotal: undefined, otherBucket: undefined };
    try {
      const csv = await api.exportCsv(plan);
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${exportBaseName(dash)}.csv`);
    } catch (err) { toast(err.message, "danger"); }
  }

  function formatPanel(dash, s) {
    const f = s.format ?? (s.format = defaultFormat());
    const isChart = CHART_LIKE.has(s.chartType);              // pie/donut/scatter/… get legend etc.
    const hasAxes = isChart && !NO_AXES.has(s.chartType);
    const canColourByCat = s.chartType === "bar" || s.chartType === "scatter";
    const set = (patch) => { s.format = { ...f, ...patch }; commit(dash, s); };

    const panel = el("div", "ws-format");
    panel.append(el("span", "ws-shelf__label", "Format"));
    // Number/date formats apply to every view (chart, crosstab, KPI).
    panel.append(
      fmtSelect("Number", [["auto", "Auto"], ["compact", "Compact"], ["currency", "Currency"], ["percent", "Percent"]],
        f.numberFormat, (v) => set({ numberFormat: v })),
      fmtSelect("Decimals", [["null", "Auto"], ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"]],
        f.decimals ?? "null", (v) => set({ decimals: v === "null" ? null : Number(v) })),
      fmtSelect("Dates", [["auto", "Auto"], ["date", "Date"], ["month", "Month"], ["year", "Year"], ["datetime", "Date+time"]],
        f.dateFormat, (v) => set({ dateFormat: v })),
    );
    // P35 scorecard: a KPI's target, and which way a change counts as good when a comparison runs.
    if (TARGET_TYPES.has(s.chartType))
      panel.append(fmtText("Target", f.target == null ? "" : String(f.target), (v) => {
        if (v == null) { set({ target: null }); return; }
        const r = number(v);
        if (!r.ok) { toast(r.error, "danger"); return; }
        set({ target: r.value });
      }));
    if (s.chartType === "bullet") { // T03-12: a measure on the shelf supplies each category's target
      const names = planMeasures(s).filter((e) => e.role === "shelf").map((e) => measureName(e.field));
      if (f.targetMeasure != null && effectiveTargetMeasure(f.targetMeasure, names.length) == null) f.targetMeasure = null; // stale: that measure is gone
      const choices = targetChoices(names);
      if (choices.length) panel.append(fmtSelect("Target field", [["null", "None (use Target)"], ...choices], f.targetMeasure ?? "null",
        (v) => set({ targetMeasure: v === "null" ? null : Number(v) })));
    }
    if (linesTakeStyle(s.chartType)) panel.append(fmtSelect("Line style", LINE_STYLE_CHOICES, f.lineStyle ?? "straight", (v) => set({ lineStyle: v }))); // T03-05
    if (s.chartType === "heatmap") panel.append(fmtSelect("Shape", HEATMAP_SHAPE_CHOICES, f.heatmapShape ?? "square", (v) => set({ heatmapShape: v }))); // T03-10
    if (s.period && s.period.compare !== "none")
      panel.append(fmtCheck("A fall is good", f.downIsGood, (v) => set({ downIsGood: v })));
    if (!STAT_SINGLE_TABLE.has(s.chartType))
      panel.append(fmtCheck("Approximate (faster)", f.approximate, (v) => set({ approximate: v }))); // P33
    if (s.chartType === "table" || s.chartType === "text") panel.append(conditionalEditor(dash, s));
    if (CLICK_TYPES.has(s.chartType)) panel.append(linkActionEditor(dash, s));
    // Chart-only controls.
    if (isChart) {
      panel.append(
        s.chartType === "histogram"
          ? fmtSelect("Bins", [["5", "5"], ["10", "10"], ["20", "20"], ["50", "50"], ["100", "100"]],
            f.topN ?? 20, (v) => set({ topN: Number(v) }))
          : fmtSelect("Top N", [["null", "All"], ["5", "5"], ["10", "10"], ["20", "20"], ["50", "50"], ["100", "100"],
              ...parameters.filter((p) => p.type === "number").map((p) => [`param:${p.id}`, `= ${p.name}`])], // P32
            f.topNParam ? `param:${f.topNParam}` : f.topN ?? "null",
            (v) => (v.startsWith("param:") ? set({ topNParam: v.slice(6) }) : set({ topN: v === "null" ? null : Number(v), topNParam: undefined }))),
        ...(BUCKET_TYPES.has(s.chartType)
          ? [fmtSelect("Group dates", DATE_BUCKET_CHOICES, f.dateBucket ?? "auto", (v) => set({ dateBucket: v }))] : []),
        fmtSelect("Legend", [["auto", "Auto"], ["hidden", "Hidden"], ["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]],
          f.legend, (v) => set({ legend: v })),
        fmtCheck("Data labels", f.dataLabels, (v) => set({ dataLabels: v })),
      );
      if (canColourByCat)
        panel.append(fmtCheck("Colour by category", f.colorByDimension, (v) => set({ colorByDimension: v })));
      panel.append(fmtCheck("Reverse palette", f.paletteReverse, (v) => set({ paletteReverse: v })), memberColourEditor(dash, s)); // T03-33, T01-20
      if (hasAxes)
        panel.append(
          fmtText("X title", f.xTitle, (v) => set({ xTitle: v })),
          fmtText("Y title", f.yTitle, (v) => set({ yTitle: v })),
        );
    }
    return panel;
  }

  // Sort picker: one quiet button showing the current order ("↑ customers.name"); its menu picks the
  // field (dimensions + measures in play) and the direction. Default: first field, ascending.
  // Choosing re-runs the query (server ORDER BY).
  function sortControl(dash, s) {
    const wrap = el("div", "menu ws-pick ws-pick--sort");
    const btn = el("button", "ws-pick__btn"); btn.type = "button";
    const targets = sortTargets(s);
    const sum = sortSummary(targets, s.sort);
    if (!sum) {
      btn.disabled = true; btn.title = "Add a field to sort";
      btn.append(icon("sort"), el("span", "ws-pick__text", "Sort"));
      wrap.append(btn);
      return wrap;
    }
    const { current, dir } = sum;
    const dirName = dir === "desc" ? "descending" : "ascending";
    btn.title = "Sort";
    btn.setAttribute("aria-label", `Sort: ${current.label}, ${dirName}`);
    btn.append(icon(`sort-${dir}`), el("span", "ws-pick__text", current.label), caret());
    const list = el("div", "menu__list"); list.setAttribute("role", "menu"); list.setAttribute("aria-label", "Sort"); list.hidden = true;
    list.append(el("div", "menu__heading", "Sort by"));
    for (const t of targets)
      list.append(radioItem(null, t.label, t === current, () => pickSort(dash, s, { by: t.id, dir })));
    list.append(menuSeparator());
    list.append(
      radioItem("sort-asc", "Ascending", dir === "asc", () => pickSort(dash, s, { by: current.id, dir: "asc" })),
      radioItem("sort-desc", "Descending", dir === "desc", () => pickSort(dash, s, { by: current.id, dir: "desc" })),
    );
    wrap.append(btn, list);
    wireMenu(btn, list, { signal: headerAbort.signal });
    return wrap;
  }
  function pickSort(dash, s, sort) {
    if (s.sort?.by === sort.by && (s.sort?.dir ?? "asc") === sort.dir) return;
    s.sort = sort;
    commit(dash, s);
    focusPicker("ws-pick--sort");
  }

  // Shared bits of the view-bar pickers.
  function caret() { const c = icon("chevron", { size: 14 }); c.classList.add("ws-pick__caret"); return c; }
  function menuSeparator() { const d = el("div", "menu__sep"); d.setAttribute("role", "separator"); return d; }
  function radioItem(glyph, label, checked, on) {
    const b = el("button", "menu__item"); b.type = "button";
    b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(checked));
    if (glyph) b.append(icon(glyph));
    b.append(el("span", "menu__label", label));
    const tick = icon("check", { size: 14 }); tick.classList.add("menu__check");
    b.append(tick);
    b.addEventListener("click", on);
    return b;
  }
  // A pick re-renders the chart head; put focus back on the (new) picker button.
  function focusPicker(cls) { headEl.querySelector(`.${cls} .ws-pick__btn`)?.focus(); }

  function shelf(label, kind, pills, onDrop, note) {
    const reorderable = kind === "columns" || kind === "rows"; // only field shelves reorder
    const wrap = el("div", `ws-shelf ws-shelf--${kind}`);
    wrap.append(el("span", "ws-shelf__label", label));
    const zone = el("div", "ws-shelf__zone");
    if (!pills.length) zone.append(el("span", "ws-shelf__hint", "drop a field"));
    for (const p of pills) zone.append(p);
    if (note) zone.append(el("span", "ws-shelf__note", note));
    zone.addEventListener("dragover", (e) => {
      if (hasField(e) || (reorderable && hasPill(e))) { e.preventDefault(); zone.classList.add("is-over"); }
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => {
      zone.classList.remove("is-over");
      // A reorder dropped on empty zone space (not on a pill) appends to the end of this shelf.
      if (reorderable && hasPill(e)) {
        const pl = readPill(e);
        if (pl) { e.preventDefault(); moveField(pl.shelf, pl.index, kind, pills.length); }
        return;
      }
      const field = readField(e);
      if (field) { e.preventDefault(); onDrop(field); }
    });
    wrap.append(zone);
    return wrap;
  }

  function pill(text, onRemove, extra) {
    const p = el("div", "ws-pill");
    p.dataset.key = text;
    p.append(el("span", "ws-pill__text", text));
    if (extra) p.append(extra);
    const x = iconButton("close", "Remove field");
    x.addEventListener("click", onRemove);
    p.append(x);
    return p;
  }
  // A field pill on the Columns/Rows shelves. Its role (dimension vs measure) follows roleOf() but can
  // be flipped with the convert button — so a numeric field can group as a dimension, or a field can be
  // aggregated as a measure. A measure pill shows an aggregation picker (with countDistinct for unique
  // counts); a dimension pill just groups.
  function fieldPill(dash, s, shelfKey, f, i) {
    const label = nameOf(f); // P28: the display name
    const remove = () => { s[shelfKey].splice(i, 1); commit(dash, s); };
    const isMeasure = roleOf(f) === "measure";
    const controls = el("span", "ws-pill__ctl");
    const calcPill = isCalcPill(f);
    // A calculated measure aggregates itself: only a row-level number (it carries `agg`) picks an aggregation, and only that
    // one may flip dimension <-> measure (E4); an aggregate or non-number calculation has nothing to choose.
    const rowLevelNumber = !calcPill || (f.category === "numeric" && (f.role === "dimension" || Boolean(f.agg)));
    if (isMeasure && (!calcPill || f.agg)) {
      const opts = calcPill ? CALC_AGGS : aggsFor(f.category); // a calculation never counts rows
      if (f.agg && !opts.includes(f.agg)) {
        toast(`${f.agg} isn't available for ${label}; switched to ${opts[0]}.`, "info");
        f.agg = opts[0]; // keep the screen in step with the query
      }
      const agg = select(opts, f.agg ?? opts[0], "ws-pill__agg", `Aggregation for ${calcPill ? label : `${f.table}.${f.column}`}`);
      agg.addEventListener("change", () => { f.agg = agg.value; commit(dash, s); });
      controls.append(agg);
    }
    // Convert button: → the role it will switch to. Title spells out the effect.
    const conv = iconButton(isMeasure ? "#" : "Σ",
      isMeasure ? "Use as dimension (group by values)" : "Use as measure (aggregate)");
    conv.classList.add("ws-pill__conv");
    conv.addEventListener("click", () => setRole(dash, s, f, isMeasure ? "dimension" : "measure"));
    if (rowLevelNumber) controls.append(conv);
    // P27: a measure's quick table calculation (opens its editor); the pill names the calculation when set.
    if (isMeasure) {
      const on = isCalc(f.tableCalc);
      const open = calcFor && calcFor.shelf === shelfKey && calcFor.index === i;
      const fx = iconButton("calc", on ? `Table calculation: ${calcName(f.tableCalc)} — change` : `Add a table calculation to ${label}`);
      fx.classList.add("ws-pill__calc");
      if (on) fx.classList.add("is-set");
      fx.setAttribute("aria-pressed", String(Boolean(open)));
      fx.addEventListener("click", () => { calcFor = open ? null : { shelf: shelfKey, index: i }; if (calcFor) { openTool = null; choicesFor = null; } formatOpen = false; showMeOpen = false; renderShelves(); });
      controls.append(fx);
    }
    // P26: a date dimension picks its part here, and +/− step through year → quarter → month → day → hour.
    if (!isMeasure && f.category === "temporal" && !calcPill) { // E12: a calculated dimension is never date-grouped
      const dateOnly = isDateOnlyColumn(f.db, f.table, f.column);
      const choices = DATE_PART_CHOICES.filter(([v]) => !(dateOnly && (v === "hour" || v === "hourOfDay")));
      const part = select(choices.map(([v]) => v), f.datePart ?? "auto", "ws-pill__part", `Date part for ${label}`);
      [...part.options].forEach((o) => { o.textContent = choices.find(([v]) => v === o.value)[1]; });
      part.addEventListener("change", () => { f.datePart = part.value; commit(dash, s); });
      const step = (dir) => {
        const next = stepPart(f.datePart ?? "auto", dir, dateOnly);
        const b = iconButton(dir > 0 ? "plus" : "−", dir > 0 ? `Finer: ${next ?? "none"}` : `Coarser: ${next ?? "none"}`);
        b.classList.add("ws-pill__step");
        b.disabled = !next;
        b.addEventListener("click", () => { if (next) { f.datePart = next; commit(dash, s); } });
        return b;
      };
      controls.append(step(-1), part, step(1));
    }
    // P40: alternative fields for this slot (opens the Choices editor).
    const n = f.choices?.length ?? 0;
    const sw = iconButton("swap", n >= 2 ? `Field choices for ${label} (${n})` : `Add field choices for ${label}`);
    sw.classList.add("ws-pill__swap");
    if (n >= 2) sw.classList.add("is-set");
    const open = choicesFor && choicesFor.shelf === shelfKey && choicesFor.index === i;
    sw.setAttribute("aria-pressed", String(Boolean(open)));
    sw.addEventListener("click", () => { choicesFor = open ? null : { shelf: shelfKey, index: i }; if (choicesFor) { openTool = null; calcFor = null; } formatOpen = false; showMeOpen = false; renderShelves(); });
    if (!isCalcPill(f)) controls.append(sw); // E12: a calculated field has no field choices
    const cast = calcPill ? null : castOf(f);
    if (cast) controls.prepend(castBadge(cast, baseCategoryOf(f.db, f.table, f.column) ?? f.category)); // T02-34
    const p = pill(label, remove, controls);
    p.classList.add(isMeasure ? "ws-pill--measure" : "ws-pill--dimension");

    // Drag-to-reorder (Columns/Rows). A dedicated grip is the only draggable part, so the agg select /
    // convert / remove controls keep working. Dropping onto this pill inserts the dragged pill before
    // it; the shelf then re-normalises so measures always sit behind dimensions.
    const grip = el("span", "ws-pill__grip", "⠿");
    grip.draggable = true;
    grip.setAttribute("aria-hidden", "true");
    grip.title = "Drag to reorder";
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(PILL_MIME, JSON.stringify({ shelf: shelfKey, index: i }));
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setDragImage(p, 12, 12); } catch { /* older engines */ }
      p.classList.add("is-dragging");
    });
    grip.addEventListener("dragend", () => p.classList.remove("is-dragging"));
    p.prepend(grip);

    p.addEventListener("dragover", (e) => { if (hasPill(e)) { e.preventDefault(); p.classList.add("is-drop-target"); } });
    p.addEventListener("dragleave", () => p.classList.remove("is-drop-target"));
    p.addEventListener("drop", (e) => {
      p.classList.remove("is-drop-target");
      const pl = readPill(e);
      if (pl) { e.preventDefault(); e.stopPropagation(); moveField(pl.shelf, pl.index, shelfKey, i); }
    });
    return p;
  }
  // Move a field pill within/between the Columns & Rows shelves, then enforce the invariant that
  // measures always follow dimensions (normaliseShelf). `toIndex` is the insertion slot in the target.
  function moveField(fromShelf, fromIndex, toShelf, toIndex) {
    if (fromShelf !== "columns" && fromShelf !== "rows") return;
    if (toShelf !== "columns" && toShelf !== "rows") return;
    const dash = activeWorksheet();
    if (!dash) return;
    const s = dash.sheet;
    const src = s[fromShelf];
    if (fromIndex < 0 || fromIndex >= src.length) return;
    if (fromShelf !== toShelf && s[toShelf].length >= LIMITS.pillsPerShelf) {
      toast(`The ${toShelf === "columns" ? "Columns" : "Rows"} shelf can hold at most ${LIMITS.pillsPerShelf} fields.`, "info"); return;
    }
    const [moved] = src.splice(fromIndex, 1);
    let ti = toIndex;
    if (fromShelf === toShelf && fromIndex < ti) ti -= 1; // removal shifted later slots left
    ti = Math.max(0, Math.min(ti, s[toShelf].length));
    s[toShelf].splice(ti, 0, moved);
    normaliseShelf(s, fromShelf);
    if (toShelf !== fromShelf) normaliseShelf(s, toShelf);
    commit(dash, s);
  }
  // Reorder a shelf so all dimensions (in their relative order) come before all measures (in theirs) —
  // the baseline rule. Reordering within either group is preserved; a measure dropped among dimensions
  // snaps behind them.
  function normaliseShelf(s, shelfKey) {
    const arr = s[shelfKey];
    s[shelfKey] = [...arr.filter((f) => roleOf(f) === "dimension"), ...arr.filter((f) => roleOf(f) === "measure")];
  }
  // Flip a field between dimension and measure. Becoming a measure gets a sensible default agg
  // (sum for numbers, count otherwise); becoming a dimension drops the agg.
  function setRole(dash, s, f, role) {
    const was = f.role;
    f.role = role;
    const c = viewCounts(s);
    f.role = was;
    if (role === "dimension" ? c.dims > LIMITS.dimensions : c.measures > LIMITS.measures) {
      toast(role === "dimension" ? `A view can group by at most ${LIMITS.dimensions} fields.` : `A view can show at most ${LIMITS.measures} measures.`, "info");
      return;
    }
    f.role = role;
    if (role === "measure") f.agg = f.agg ?? (f.category === "numeric" ? defaultAgg(f) : "count");
    else delete f.agg;
    // Converting a field can violate dims-before-measures — re-normalise both field shelves.
    normaliseShelf(s, "columns");
    normaliseShelf(s, "rows");
    commit(dash, s);
  }
  // A Color pill (P7 marks): a plain dimension — no aggregation, no role toggle. It splits the chart
  // into one coloured series per distinct value. The shelf holds at most one (Tableau's discrete
  // Color); dropping another replaces it (see addColor).
  function colorPill(dash, s, f, i) {
    const remove = () => { s.color.splice(i, 1); commit(dash, s); };
    // A numeric Colour field reads as a continuous gradient (P18); tag the pill so the label says so.
    const continuous = f.category === "numeric";
    const p = pill(`${f.table}.${f.column}${continuous ? " (gradient)" : ""}`, remove);
    p.classList.add("ws-pill--color");
    if (continuous) p.title = "Continuous colour — a sequential gradient (Bar/Scatter)";
    return p;
  }
  // Filter pill (P14). The operator select drives which value control shows: a single input for the
  // scalar ops, a distinct-values multi-select for `in`, and two bounds for `between`.
  function filterPill(dash, s, f, i, list) {
    const shared = list === sharedFilters;
    const ops = opsFor(f.category);
    const op = select(ops.includes(f.op) ? ops : [...ops, f.op], f.op, "ws-pill__op", `Filter operator for ${f.table}.${f.column}`);
    for (const o of op.options) if (OP_LABELS[o.value]) o.textContent = OP_LABELS[o.value];
    op.addEventListener("change", () => {
      f.op = op.value;
      if (f.op === "top" && !f.topBy) { // P30: rank by the first shelf measure until the user picks another
        const e = planMeasures(s).find((m) => m.role === "shelf");
        if (e) f.topBy = topByRef(e, calcFieldCtx());
      }
      if ((f.op === "in" || f.op === "notin") && !Array.isArray(f.values)) f.values = [];
      if (f.op === "between" && !Array.isArray(f.values)) f.values = ["", ""];
      commit(dash, s); // re-render so the matching value control appears
    });
    const cfg = el("span", "ws-pill__filter");
    cfg.append(op, filterValueControl(dash, s, f));
    const chk = checkFilter(pv(f));
    if (chk.state === "invalid") {
      const inputs = [...cfg.querySelectorAll("input")];
      // For a range, mark the bound that actually failed (a half range blames the empty one).
      const bad = f.op === "between" && inputs.length === 2
        ? (!String(f.values?.[0] ?? "").trim() ? inputs[0] : !String(f.values?.[1] ?? "").trim() ? inputs[1]
          : (checkFilter({ ...f, op: "=", value: f.values[0] }).state === "invalid" ? inputs[0] : inputs[1]))
        : inputs[0];
      if (bad) fieldError(bad, chk.error);
    }
    // P40: share with every dashboard (moves it to the workbook's shared list), or take it back.
    const share = iconButton("link", shared ? `Stop sharing the filter on ${f.table}.${f.column} (keep it on this dashboard)` : `Share the filter on ${f.table}.${f.column} with every dashboard`);
    share.classList.add("ws-pill__share");
    share.setAttribute("aria-pressed", String(shared));
    share.addEventListener("click", () => toggleShared(dash, s, f, list, i));
    cfg.append(share);
    const p = pill(nameOf(f), () => { list.splice(i, 1); commit(dash, s); }, cfg);
    p.classList.toggle("ws-pill--invalid", chk.state === "invalid");
    if (chk.state === "invalid") p.prepend(icon("warning", { size: 14 }));
    if (shared) { p.classList.add("ws-pill--shared"); p.prepend(el("span", "ws-pill__badge", "All dashboards")); }
    return p;
  }

  // --- shared filters & field choices (P40) --------------------------------
  function toggleShared(dash, s, f, list, i) {
    const refused = refusal(f, "sharedFilter");
    if (refused) { toast(refused, "info"); return; }
    const toShared = list !== sharedFilters;
    const target = toShared ? sharedFilters : s.filters;
    const cap = toShared ? LIMITS.sharedFilters : LIMITS.filters;
    if (target.length >= cap) {
      toast(toShared ? `At most ${LIMITS.sharedFilters} filters can be shared.` : `A view can have at most ${LIMITS.filters} filters.`, "info");
      return;
    }
    list.splice(i, 1);
    target.push(f);
    commit(dash, s);
  }
  // Shared filters whose table isn't in this view don't apply here — say which, never silently.
  function sharedSkipped(sheet) {
    const plan = buildPlan(sheet);
    if (!plan) return [];
    const inView = new Set([keyOf(plan.from.db, plan.from.table), ...plan.joins.map((j) => keyOf(j.right.db, j.right.table))]);
    return sharedFilters.filter((f) => checkFilter(f).state === "ok" && !inView.has(keyOf(f.db, f.table)));
  }
  function sharedNote(sheet) {
    const skipped = sharedSkipped(sheet);
    return skipped.length ? `${skipped.map((f) => `${f.table}.${f.column}`).join(", ")}: shared, but not applied here — its table isn't in this view.` : null;
  }

  // P27: the table-calculation editor for one measure slot.
  function calcPanel(dash, s) {
    const { shelf, index } = calcFor;
    const f = s[shelf]?.[index];
    if (!f || roleOf(f) !== "measure") { calcFor = null; return null; }
    const c = { type: "none", along: "auto", ...(f.tableCalc ?? {}) };
    const set = (patch) => {
      const next = { ...c, ...patch };
      if (next.type === "none") delete f.tableCalc;
      else f.tableCalc = { type: next.type, along: next.along, ...(next.type === "moving" ? { window: next.window ?? 3 } : {}) };
      commit(dash, s);
    };
    const panel = el("div", "ws-toolpanel ws-calc");
    const head = el("div", "ws-toolpanel__head");
    const title = el("span", "ws-toolpanel__title");
    title.append(icon("calc"), ` Table calculation · ${f.agg ?? "sum"} ${f.table}.${f.column}`);
    const close = iconButton("close", "Close editor");
    close.addEventListener("click", () => { calcFor = null; renderShelves(); });
    head.append(title, close);
    const row = el("div", "ws-cf__row");
    row.append(fmtSelect("Calculation", CALC_CHOICES, c.type, (v) => set({ type: v })));
    if (c.type !== "none") row.append(fmtSelect("Along", ALONG_CHOICES, c.along, (v) => set({ along: v })));
    if (c.type === "moving") row.append(fmtSelect("Window", WINDOW_CHOICES.map((n) => [n, `${n} values`]), c.window ?? 3, (v) => set({ window: Number(v) })));
    panel.append(head, row, el("span", "ws-shelf__note",
      "Computed in the browser over the rows returned, in the sort order — restarting for each member of the other shelf's dimensions."));
    return panel;
  }

  // Field choices: a shelf pill may carry alternative fields; the switcher on the chart card picks one.
  const sameRef = (a, b) => a.db === b.db && a.table === b.table && a.column === b.column;
  function choicesOf(f) { return f.choices?.length ? f.choices : [{ db: f.db, table: f.table, column: f.column, category: f.category }]; }
  function addChoice(dash, s, shelf, index, field) {
    const f = s[shelf][index];
    const refused = refusal(field, "choice") ?? (isCalcPill(f) ? refusal(f, "choice") : null); // E12: neither a calc dropped here nor a calc slot takes choices
    if (refused) { toast(refused, "info"); return; }
    const list = choicesOf(f);
    if (list.some((c) => sameRef(c, field))) return;
    if (list.length >= LIMITS.fieldChoices) { toast(`A slot can switch between at most ${LIMITS.fieldChoices} fields.`, "info"); return; }
    f.choices = [...list, { db: field.db, table: field.table, column: field.column, category: field.category }];
    commit(dash, s);
  }
  function removeChoice(dash, s, shelf, index, c) {
    const f = s[shelf][index];
    const rest = choicesOf(f).filter((x) => !sameRef(x, c));
    if (sameRef(f, c)) switchField(f, rest[0]); // removing the shown one shows the next
    if (rest.length >= 2) f.choices = rest; else delete f.choices;
    commit(dash, s);
  }
  // Put a choice in the slot: the field changes, the slot's role stays; a measure keeps its aggregation
  // when the new field supports it, else takes the first it does.
  function switchField(f, c) {
    Object.assign(f, { db: c.db, table: c.table, column: c.column, category: c.category });
    if (c.category !== "temporal") delete f.datePart; // a date part only means something on a date field
    if (f.agg && !aggsFor(c.category).includes(f.agg)) f.agg = aggsFor(c.category)[0];
  }
  function choicesPanel(dash, s) {
    const { shelf, index } = choicesFor;
    const f = s[shelf]?.[index];
    if (!f || isCalcPill(f)) { choicesFor = null; return null; }
    const panel = el("div", "ws-toolpanel ws-choices");
    const head = el("div", "ws-toolpanel__head");
    const title = el("span", "ws-toolpanel__title");
    title.append(icon("swap"), ` Choices for ${shelf === "columns" ? "Columns" : "Rows"} · ${f.table}.${f.column}`);
    const close = iconButton("close", "Close editor");
    close.addEventListener("click", () => { choicesFor = null; renderShelves(); });
    head.append(title, close);
    const zone = el("div", "ws-toolpanel__zone");
    for (const c of choicesOf(f)) {
      const p = pill(`${c.table}.${c.column}`, () => removeChoice(dash, s, shelf, index, c));
      p.classList.add("ws-pill--mark");
      if (sameRef(c, f)) p.prepend(el("span", "ws-pill__badge", "Showing"));
      zone.append(p);
    }
    wireFieldDrop(zone, (field) => addChoice(dash, s, shelf, index, field));
    panel.append(head, zone, el("span", "ws-shelf__note",
      choicesOf(f).length < 2 ? "Drop more fields here — then pick between them on the chart card." : "Pick the field to show with the switcher on the chart card."));
    return panel;
  }
  // The chart card's switchers: one "Show" select per slot that has choices.
  function switchers(dash, s) {
    const slots = [];
    for (const shelf of ["columns", "rows"]) s[shelf].forEach((f, index) => { if (f.choices?.length >= 2) slots.push({ shelf, index, f }); });
    if (!slots.length) return null;
    const row = el("div", "ws-switchers");
    for (const { shelf, f } of slots) {
      const opts = f.choices.map((c) => [`${c.db}.${c.table}.${c.column}`, `${c.table}.${c.column}`]);
      const label = `${shelf === "columns" ? "Columns" : "Rows"}: show`;
      row.append(fmtSelect(label, opts, `${f.db}.${f.table}.${f.column}`, (v) => {
        const c = f.choices.find((x) => `${x.db}.${x.table}.${x.column}` === v);
        if (c) { switchField(f, c); commit(dash, s); }
      }));
    }
    return row;
  }

  // The value editor for a filter, by operator (P14).
  // P32: a filter value can follow a parameter of the field's type (scalar / text-match / top-N count).
  const pv = (f) => withParams(f, planCtx());
  const PARAMABLE = new Set(["=", "!=", ">", ">=", "<", "<=", "contains", "startsWith", "endsWith", "top"]);
  function paramChoices(f) {
    const t = f.op === "top" ? "number" : paramTypeFor(f.category);
    return t ? parameters.filter((p) => p.type === t) : [];
  }
  function paramBinding(dash, s, f) {
    if (!PARAMABLE.has(f.op)) return null;
    const choices = paramChoices(f);
    const b = iconButton("param", f.param ? "Use a fixed value instead of the parameter" : "Use a parameter for this value");
    b.classList.add("ws-pill__param");
    b.setAttribute("aria-pressed", String(Boolean(f.param)));
    b.addEventListener("click", () => {
      if (f.param) { f.value = String(pv(f).value ?? ""); delete f.param; commit(dash, s); return; }
      if (!choices.length) { toast(`No ${f.op === "top" ? "number" : paramTypeFor(f.category) ?? ""} parameter yet — add one from Workbook → Parameters….`, "info"); return; }
      f.param = choices[0].id; commit(dash, s);
    });
    return b;
  }
  function filterValueControl(dash, s, f) {
    if (f.param && f.op !== "top") {
      const sel = el("select", "select select--light ws-pill__paramsel");
      sel.setAttribute("aria-label", `Parameter for ${f.table}.${f.column}`);
      for (const p of paramChoices(f)) sel.add(new Option(`= ${p.name} (${p.value})`, p.id, false, p.id === f.param));
      sel.addEventListener("change", () => { f.param = sel.value; commit(dash, s); });
      const wrap = el("span", "ws-pill__pwrap");
      wrap.append(sel, paramBinding(dash, s, f));
      return wrap;
    }
    if (f.op === "in" || f.op === "notin") {
      const sel = el("select", "select select--light ws-pill__in");
      sel.multiple = true; sel.size = 4;
      sel.setAttribute("aria-label", `Values for ${f.table}.${f.column}`);
      const wrap = el("span", "ws-pill__in-wrap");
      wrap.append(sel);
      populateDistinct(sel, f);                // async, cached; preselects f.values
      sel.addEventListener("change", () => { f.values = [...sel.selectedOptions].map((o) => o.value); commit(dash, s); });
      return wrap;
    }
    // P30: relative date — a period preset; top-N — n, the ranking measure, top or bottom.
    if (f.op === "relative") {
      const choices = PRESET_CHOICES.filter(([v]) => v !== "custom");
      const sel = select(choices.map(([v]) => v), f.value || "", "ws-pill__rel", `Date range for ${f.table}.${f.column}`);
      if (!f.value) { sel.prepend(new Option("Pick…", "")); sel.value = ""; }
      for (const o of sel.options) { const c = choices.find(([v]) => v === o.value); if (c) o.textContent = c[1].toLowerCase(); }
      sel.addEventListener("change", () => { f.value = sel.value; commit(dash, s); });
      return sel;
    }
    if (f.op === "top") return topControl(dash, s, f);
    if (f.op === "between") {
      const wrap = el("span", "ws-pill__range");
      const lo = el("input", "input ws-pill__val"); lo.placeholder = "from"; lo.value = f.values?.[0] ?? "";
      const hi = el("input", "input ws-pill__val"); hi.placeholder = "to"; hi.value = f.values?.[1] ?? "";
      lo.maxLength = hi.maxLength = LIMITS.filterValue;
      if (f.category === "numeric") lo.inputMode = hi.inputMode = "decimal";
      lo.setAttribute("aria-label", `From value for ${f.table}.${f.column}`);
      hi.setAttribute("aria-label", `To value for ${f.table}.${f.column}`);
      const sync = () => { f.values = [lo.value, hi.value]; commit(dash, s); };
      lo.addEventListener("change", sync); hi.addEventListener("change", sync);
      wrap.append(lo, el("span", "ws-pill__range-sep", "–"), hi);
      return wrap;
    }
    const val = el("input", "input ws-pill__val");
    val.value = f.value ?? ""; val.maxLength = LIMITS.filterValue;
    val.placeholder = FILTER_PLACEHOLDER[f.category] ?? "value";
    if (f.category === "numeric") val.inputMode = "decimal";
    val.setAttribute("aria-label", `Value for ${f.table}.${f.column}`);
    val.addEventListener("change", () => { f.value = val.value; commit(dash, s); });
    const bind = paramBinding(dash, s, f);
    if (!bind) return val;
    const wrap = el("span", "ws-pill__pwrap");
    wrap.append(val, bind);
    return wrap;
  }

  // P30 top-N editor: [top|bottom] [n] by [measure on the shelves].
  function topControl(dash, s, f) {
    const wrap = el("span", "ws-pill__top");
    const dir = select(["top", "bottom"], f.bottom ? "bottom" : "top", "ws-pill__topdir", `Top or bottom for ${f.table}.${f.column}`);
    dir.addEventListener("change", () => { f.bottom = dir.value === "bottom"; commit(dash, s); });
    let n;
    if (f.param) {
      n = el("select", "select select--light ws-pill__paramsel");
      n.setAttribute("aria-label", `Parameter for how many ${f.table}.${f.column}`);
      for (const p of paramChoices(f)) n.add(new Option(`${p.name} (${p.value})`, p.id, false, p.id === f.param));
      n.addEventListener("change", () => { f.param = n.value; commit(dash, s); });
    } else {
      n = el("input", "input ws-pill__val ws-pill__topn");
      n.value = f.value ?? ""; n.inputMode = "numeric"; n.placeholder = "10"; n.maxLength = 4;
      n.setAttribute("aria-label", `How many for ${f.table}.${f.column}`);
      n.addEventListener("change", () => { f.value = n.value.trim(); commit(dash, s); });
    }
    const measures = planMeasures(s).filter((e) => e.role === "shelf");
    const opts = measures.map((e) => [topByKey(e), measureName({ ...e.field, agg: e.agg })]);
    const cur = f.topBy ? topByKey({ field: typeof f.topBy.calc === "string" ? { calc: f.topBy.calc } : f.topBy, agg: f.topBy.agg ?? (typeof f.topBy.calc === "string" ? undefined : "sum") }) : "";
    const by = el("select", "select select--light ws-pill__topby");
    by.setAttribute("aria-label", `Rank ${f.table}.${f.column} by`);
    if (!opts.length) by.append(new Option("add a measure to rank by", ""));
    for (const [v, t] of opts) { const o = new Option(`by ${t}`, v); if (v === cur) o.selected = true; by.add(o); }
    // Default to the first shelf measure the first time.
    if (!f.topBy && measures[0]) { f.topBy = topByRef(measures[0], calcFieldCtx()); }
    by.addEventListener("change", () => {
      const e = measures.find((m) => topByKey(m) === by.value);
      if (e) { f.topBy = topByRef(e, calcFieldCtx()); commit(dash, s); }
    });
    wrap.append(dir, n, by);
    const bind = paramBinding(dash, s, f);
    if (bind) wrap.append(bind);
    return wrap;
  }

  // P32 parameter controls: one per parameter this sheet uses (its filters, shared filters, Top N) — a
  // select for a list, a slider + box for a number range, else a typed input. Every value is checked.
  function paramControls(s) {
    const used = new Set([...s.filters, ...sharedFilters].map((f) => f.param).filter(Boolean));
    if (s.format?.topNParam) used.add(s.format.topNParam);
    if (s.analytics?.ref?.param) used.add(s.analytics.ref.param);
    const calcNames = new Set();
    for (const f of pillSlots(s)) if (isCalcPill(f)) calcParamNames(calculations, f.calc).forEach((n) => calcNames.add(n));
    for (const p of parameters) if (calcNames.has(p.name)) used.add(p.id); // a calculated field reads it as [@Name]
    const ps = parameters.filter((p) => used.has(p.id));
    if (!ps.length) return null;
    const row = el("div", "ws-params");
    row.setAttribute("aria-label", "Parameters");
    for (const p of ps) {
      const wrap = el("label", "ws-param");
      wrap.append(el("span", "ws-param__name", p.name));
      const setValue = (raw) => {
        const r = checkValue(p, raw);
        if (!r.ok) { toast(r.error, "danger"); renderShelves(); return; }
        updateParameter(p.id, { value: r.value });
      };
      const a = p.allowed ?? { kind: "any" };
      if (a.kind === "list") {
        const sel = el("select", "select select--light");
        for (const v of a.list) sel.add(new Option(v, v, false, String(v) === String(p.value)));
        sel.addEventListener("change", () => setValue(sel.value));
        wrap.append(sel);
      } else if (p.type === "number" && a.kind === "range" && a.min != null && a.max != null) {
        const slider = el("input", "ws-param__range"); slider.type = "range";
        slider.min = a.min; slider.max = a.max; slider.step = a.step ?? (Number.isInteger(a.min) && Number.isInteger(a.max) ? 1 : "any");
        slider.value = p.value;
        const out = el("input", "input ws-param__num"); out.value = p.value; out.inputMode = "decimal";
        slider.addEventListener("input", () => { out.value = slider.value; });
        slider.addEventListener("change", () => setValue(slider.value));
        out.addEventListener("change", () => setValue(out.value));
        slider.setAttribute("aria-label", p.name); out.setAttribute("aria-label", `${p.name} value`);
        wrap.append(slider, out);
      } else {
        const i = el("input", "input ws-param__num");
        if (p.type === "date") i.type = "date";
        i.value = p.value; if (p.type === "number") i.inputMode = "decimal";
        i.addEventListener("change", () => setValue(i.value));
        wrap.append(i);
      }
      row.append(wrap);
    }
    return row;
  }

  // P30 filter cards: each of the sheet's filters (and the shared ones that apply here) as a card above
  // the chart — a checkbox list for `in`, the filter's own editor otherwise. Same objects as the Filters
  // tool, so the two always agree.
  function filterCards(dash, s) {
    const list = [...s.filters.map((f, i) => ({ f, i, src: s.filters })), ...sharedFilters.map((f, i) => ({ f, i, src: sharedFilters }))];
    if (!list.length || s.showFilterCards === false) return null;
    const row = el("div", "ws-filtercards");
    row.setAttribute("aria-label", "Filter cards");
    for (const { f, i, src } of list) {
      const card = el("div", `ws-fcard${checkFilter(f).state === "invalid" ? " is-invalid" : ""}`);
      const head = el("div", "ws-fcard__head");
      head.append(el("span", "ws-fcard__name", nameOf(f)));
      if (src === sharedFilters) head.append(el("span", "ws-pill__badge", "All dashboards"));
      const x = iconButton("close", `Remove the filter on ${nameOf(f)}`);
      x.addEventListener("click", () => { src.splice(i, 1); commit(dash, s); });
      head.append(x);
      card.append(head);
      if (f.op === "in" || f.op === "notin") {
        if (f.op === "notin") card.append(el("span", "ws-fcard__op", OP_LABELS.notin)); // Exclude says so; plain `in` is the default
        card.append(checklist(dash, s, f));
      }
      else {
        const body = el("div", "ws-fcard__body");
        if (f.op !== "top") body.append(el("span", "ws-fcard__op", OP_LABELS[f.op] ?? f.op)); // top-N names itself
        body.append(filterValueControl(dash, s, f));
        card.append(body);
      }
      row.append(card);
    }
    return row;
  }
  // An `in` filter as checkboxes over its distinct values (bounded, cached) with a quick search.
  function checklist(dash, s, f) {
    const box = el("div", "ws-fcard__list");
    box.append(el("span", "ws-note", "Loading…"));
    distinctFor(f.db, f.table, f.column).then((vals) => {
      box.replaceChildren();
      const chosen = new Set(f.values ?? []);
      for (const v of vals.slice(0, DISTINCT_SHOWN)) {
        const val = v == null ? "" : String(v);
        const row = el("label", "ws-fcard__item");
        const cb = el("input"); cb.type = "checkbox"; cb.checked = chosen.has(val);
        cb.addEventListener("change", () => {
          const set = new Set(f.values ?? []);
          if (cb.checked) set.add(val); else set.delete(val);
          f.values = [...set];
          commit(dash, s);
        });
        row.append(cb, el("span", null, v == null ? "—" : String(v)));
        box.append(row);
      }
      if (vals.length > DISTINCT_SHOWN) box.append(el("span", "ws-note", "Showing the first 200 values — more exist."));
      if (!vals.length) box.append(el("span", "ws-note", "(no values)"));
    }).catch(() => box.replaceChildren(el("span", "ws-note", "(couldn't load values)")));
    return box;
  }

  // Fill an `in`-filter multi-select from the column's distinct values (bounded, cached), preselecting
  // whatever is already chosen. Failures degrade to a disabled note rather than an error.
  async function populateDistinct(sel, f) {
    sel.append(new Option("Loading…", ""));
    let note = null; // "first 200" cap note, placed beside the select once it is in the DOM
    try {
      const vals = await distinctFor(f.db, f.table, f.column);
      sel.replaceChildren();
      const chosen = new Set(f.values ?? []);
      for (const v of vals.slice(0, DISTINCT_SHOWN)) {
        const opt = new Option(v == null ? "—" : String(v), v == null ? "" : String(v));
        if (chosen.has(opt.value)) opt.selected = true;
        sel.add(opt);
      }
      if (!vals.length) sel.append(new Option("(no values)", ""));
      if (vals.length > DISTINCT_SHOWN) note = el("p", "ws-note", "Showing the first 200 values — more exist.");
    } catch {
      sel.replaceChildren(new Option("(couldn't load values)", ""));
    }
    if (note && sel.parentNode) sel.parentNode.append(note);
  }
  const DISTINCT_SHOWN = 200, DISTINCT_FETCH = DISTINCT_SHOWN + 1; // ask for one extra to know whether more exist
  const distinctCache = new Map();
  async function distinctFor(db, table, column) {
    const k = `${db}.${table}.${column}`;
    if (!distinctCache.has(k)) {
      try { distinctCache.set(k, await api.distinct(db, table, column, DISTINCT_FETCH)); }
      catch (e) { distinctCache.delete(k); throw e; }
    }
    return distinctCache.get(k);
  }
  // Chart-type picker: the current type's icon + name; its menu is a two-column grid of every type.
  function chartTypePicker(dash, s) {
    const wrap = el("div", "menu ws-pick ws-pick--chart");
    const btn = el("button", "ws-pick__btn"); btn.type = "button";
    btn.title = "Chart type";
    btn.setAttribute("aria-label", `Chart type: ${chartLabel(s.chartType)}`);
    btn.append(icon(chartIcon(s.chartType)), el("span", "ws-pick__text", chartLabel(s.chartType)), caret());
    const list = el("div", "menu__list menu__list--start ws-charttypes");
    list.setAttribute("role", "menu"); list.setAttribute("aria-label", "Chart type"); list.hidden = true;
    for (const [v, lbl] of CHART_TYPES)
      list.append(radioItem(chartIcon(v), lbl, v === s.chartType, () => {
        if (s.chartType === v) return;
        s.chartType = v;
        commit(dash, s);
        focusPicker("ws-pick--chart");
      }));
    wrap.append(btn, list);
    wireMenu(btn, list, { signal: headerAbort.signal });
    return wrap;
  }

  // Drop a field onto Columns/Rows. Default role from type (numeric → measure with sum, else
  // dimension); the pill's convert button can change it. Not allowed twice on the same shelf.
  function addField(dash, shelfKey, f) {
    const list = dash.sheet[shelfKey];
    if (list.some((x) => sameField(x, f))) return;
    const entry = slotEntry(f);
    entry.role = isCalcPill(f) ? f.role : f.category === "numeric" ? "measure" : "dimension";
    if (!allowed(dash, shelfKey, f, entry.role)) return;
    if (entry.role === "measure") entry.agg = isCalcPill(f) ? f.agg : defaultAgg(f);
    if (entry.agg === undefined) delete entry.agg;
    list.push(entry);
    normaliseShelf(dash.sheet, shelfKey); // keep dimensions ahead of measures
    commit(dash, dash.sheet);
  }
  // The stored shape of a dropped field. A calculated field carries its calc id, role and agg through unchanged.
  const slotEntry = (f) => (isCalcPill(f)
    ? { calc: f.calc, db: "", table: "", column: f.column, category: f.category, ...(f.role ? { role: f.role } : {}), ...(f.agg ? { agg: f.agg } : {}) }
    : { db: f.db, table: f.table, column: f.column, category: f.category });
  // P28: a field's default aggregation (its setting when the column supports it, else sum).
  function defaultAgg(f) {
    const a = metaOf(f).agg;
    return a && aggsFor(f.category).includes(a) ? a : "sum";
  }
  // Refuse a drop that would break a shelf or view cap, telling the user why (same style as the filter cap).
  function allowed(dash, slot, f, role) {
    const r = checkAdd(dash.sheet, slot, f, role);
    if (!r.ok) toast(r.error, "info");
    return r.ok;
  }
  function addFilter(dash, f) {
    const refused = refusal(f, "filter");
    if (refused) { toast(refused, "info"); return; }
    if (dash.sheet.filters.length >= LIMITS.filters) { toast(`A view can have at most ${LIMITS.filters} filters.`, "info"); return; }
    dash.sheet.filters.push({ db: f.db, table: f.table, column: f.column, category: f.category, op: "=", value: "" });
    commit(dash, dash.sheet);
  }
  // Drop a field onto Color (P7/P18 marks). A categorical field is discrete (group-by → coloured
  // series); a numeric field is continuous (P18 gradient — see colorMode/planMeasures). Capped at one —
  // a second drop replaces the first, matching Tableau's single Colour slot.
  function addColor(dash, f) {
    if (!allowed(dash, "color", f, isCalcPill(f) ? f.role : "dimension")) return;
    dash.sheet.color = [isCalcPill(f) ? { ...slotEntry(f), role: f.role } : { ...slotEntry(f), role: "dimension" }];
    commit(dash, dash.sheet);
  }

  // --- encodings toolbar (redesign 2) --------------------------------------
  // All non-Columns/Rows encodings live in one compact icon+text toolbar. Each entry is a "tool": a
  // button that (a) is a drop target for a field, and (b) toggles a small editor panel showing/removing
  // its current field(s). Which tools stay visible vs. in "More" is decided by toolbar-rules.js.
  // Everything still feeds the SAME bounded query (planDims/planMeasures) — no new query shape.
  function buildTools(dash, s) {
    const m = s.marks ?? (s.marks = defaultMarks());
    const colorFields = s.color ?? (s.color = []);
    const drillLevels = s.drill?.levels ?? [];
    const one = (field, clear) => (field ? [markPill(field, clear)] : []); // single-field pill list
    return [
      { key: "color", icon: "color", label: "Color", count: colorFields.length,
        pills: colorFields.map((f, i) => colorPill(dash, s, f, i)), onDrop: (f) => addColor(dash, f),
        hint: "Drop a field — categorical = colour series, numeric = gradient",
        note: colorFields.length && colorMode(s) === "discrete" && !COLOR_USES.has(s.chartType)
          ? "Discrete colour needs Bar/Line/Area/Stacked/Table — or drop a numeric field for a gradient." : null },
      { key: "size", icon: "size", label: "Size", count: m.size ? 1 : 0,
        pills: one(m.size, () => { m.size = null; commit(dash, s); }), onDrop: (f) => addSize(dash, f),
        hint: "Drop a numeric field to size the marks (scatter bubbles)" },
      { key: "label", icon: "label", label: "Label", count: m.label ? 1 : 0,
        pills: one(m.label, () => { m.label = null; commit(dash, s); }), onDrop: (f) => addMarkSingle(dash, "label", f),
        hint: "Drop a field to write its value on each mark" },
      { key: "detail", icon: "detail", label: "Detail", count: (m.detail ?? []).length,
        pills: (m.detail ?? []).map((f, i) => markPill(f, () => { m.detail.splice(i, 1); commit(dash, s); })), onDrop: (f) => addMarkList(dash, "detail", f),
        hint: "Drop dimensions to add mark granularity (no visual channel)" },
      { key: "tooltip", icon: "tooltip", label: "Tooltip", count: (m.tooltip ?? []).length,
        pills: (m.tooltip ?? []).map((f, i) => markPill(f, () => { m.tooltip.splice(i, 1); commit(dash, s); })), onDrop: (f) => addMarkList(dash, "tooltip", f),
        hint: "Drop fields to list in each mark's tooltip", editor: tooltipEditor(dash, s) },
      { key: "shape", icon: "shape", label: "Shape", count: m.shape ? 1 : 0,
        pills: one(m.shape, () => { m.shape = null; commit(dash, s); }), onDrop: (f) => addShape(dash, f),
        hint: "Drop a categorical field for per-value point symbols (scatter)",
        note: m.shape && !SCATTER_TYPES.has(s.chartType) ? "Shape encodes Scatter / Square / Circle points." : null },
      { key: "path", icon: "path", label: "Path", count: m.path ? 1 : 0,
        pills: one(m.path, () => { m.path = null; commit(dash, s); }), onDrop: (f) => addMarkSingle(dash, "path", f),
        hint: "Drop a field to order a line/area's vertices" },
      { key: "angle", icon: "angle", label: "Angle", count: m.angle ? 1 : 0,
        pills: one(m.angle, () => { m.angle = null; commit(dash, s); }), onDrop: (f) => addAngle(dash, f),
        hint: "A radial magnitude — pie already maps its measure to angle" },
      { key: "filters", icon: "filter", label: "Filters", count: s.filters.length + sharedFilters.length,
        pills: [...s.filters.map((f, i) => filterPill(dash, s, f, i, s.filters)),
          ...sharedFilters.map((f, i) => filterPill(dash, s, f, i, sharedFilters))],
        onDrop: (f) => addFilter(dash, f),
        hint: "Drop a field to filter the view by it — share a filter (link button) to apply it on every dashboard",
        note: sharedNote(s) },
      { key: "period", icon: "calendar", label: "Date range", count: s.period ? 1 : 0,
        pills: s.period ? [markPill(s.period, () => { s.period = null; commit(dash, s); })] : [],
        onDrop: (f) => setPeriod(dash, f), editor: s.period ? periodEditor(dash, s) : null,
        hint: "Drop a date field to limit the view to a range — and compare it with another period" },
      { key: "drill", icon: "drill", label: "Drill", count: drillLevels.length,
        pills: drillLevels.map((f, i) => drillLevelPill(dash, s, f, i)), onDrop: (f) => addDrillLevel(dash, f),
        hint: "Drop ≥2 same-table fields to build a drill hierarchy (year → quarter → month)",
        note: drillLevels.length === 1 ? "Add another same-table field to drill." : null },
      { key: "pages", icon: "pages", label: "Pages", count: s.pages ? 1 : 0,
        pills: s.pages ? [pagesPill(dash, s)] : [], onDrop: (f) => addPages(dash, f),
        hint: "Drop a dimension to step/animate the view through its members" },
    ];
  }

  // A toolbar button: icon + short text, a count badge when it holds field(s), and drop-target + click.
  function toolButton(dash, s, tool) {
    const set = tool.count > 0;
    const btn = el("button", `ws-tool${openTool === tool.key ? " is-active" : ""}${set ? " is-set" : ""}`);
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(openTool === tool.key));
    btn.setAttribute("aria-label", `${tool.label}${set ? ` (${tool.count} field${tool.count > 1 ? "s" : ""})` : " (empty)"}`);
    btn.title = tool.hint || tool.label;
    btn.append(icon(tool.icon), el("span", "ws-tool__text", tool.label));
    if (set) btn.append(el("span", "ws-tool__badge", String(tool.count)));
    btn.addEventListener("click", () => { openTool = openTool === tool.key ? null : tool.key; choicesFor = null; calcFor = null; formatOpen = false; showMeOpen = false; renderShelves(); });
    btn.addEventListener("dragover", (e) => { if (hasField(e)) { e.preventDefault(); btn.classList.add("is-over"); } });
    btn.addEventListener("dragleave", () => btn.classList.remove("is-over"));
    btn.addEventListener("drop", (e) => {
      btn.classList.remove("is-over");
      const f = readField(e);
      if (f) { e.preventDefault(); openTool = tool.key; choicesFor = null; calcFor = null; tool.onDrop(f); } // set open BEFORE onDrop's commit re-renders
    });
    return btn;
  }

  // The editor panel for the open tool: a card with its current field pills over a drop zone (+ note).
  function toolPanel(dash, s, tool) {
    const panel = el("div", "ws-toolpanel");
    const head = el("div", "ws-toolpanel__head");
    const title = el("span", "ws-toolpanel__title");
    title.append(icon(tool.icon), ` ${tool.label}`);
    head.append(title);
    const close = iconButton("close", "Close editor");
    close.addEventListener("click", () => { openTool = null; renderShelves(); });
    head.append(close);
    panel.append(head);
    const zone = el("div", "ws-toolpanel__zone");
    if (!tool.pills.length) zone.append(el("span", "ws-shelf__hint", tool.hint || "Drag a field here"));
    for (const p of tool.pills) zone.append(p);
    wireFieldDrop(zone, tool.onDrop);
    panel.append(zone);
    if (tool.editor) panel.append(tool.editor);
    if (tool.note) panel.append(el("span", "ws-shelf__note", tool.note));
    return panel;
  }

  // --- Tooltip text (T01-19) ---------------------------------------------
  // The fields the last drawn chart offers ([{ name, sample }]) — the editor's chips and live preview.
  // Keyed by sheet and cleared at the start of each drawing (worksheet-render.js), so it only ever holds the drawn view's fields.
  let tooltipCatState = { sheet: null, list: [] };
  let tooltipRedraw = null; // the open editor's chip/preview redraw (the chart may finish after the panel opened)
  const setTooltipCat = (sheet, list) => { tooltipCatState = { sheet, list }; tooltipRedraw?.(); };
  function tooltipEditor(dash, s) {
    const cat = () => (tooltipCatState.sheet === s ? tooltipCatState.list : []);
    const box = el("div", "ws-tipedit");
    const label = el("label", "ws-fmt-field");
    label.append(el("span", "ws-fmt-label", "Tooltip text"));
    const ta = el("textarea", "input ws-tipedit__text");
    ta.rows = 3;
    ta.maxLength = LIMITS.tooltipText;
    ta.placeholder = "Sales for <field>: <measure> — empty keeps the automatic tooltip";
    ta.value = s.tooltipText ?? "";
    label.append(ta);
    box.append(label);
    const chips = el("div", "ws-tipedit__chips");
    const drawChips = () => {
    chips.replaceChildren();
    for (const f of cat()) {
      const b = el("button", "btn btn--ghost ws-tipedit__chip", f.name);
      b.type = "button";
      b.title = `Insert <${f.name}>`;
      b.addEventListener("click", () => {
        const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
        ta.value = `${ta.value.slice(0, a)}<${f.name}>${ta.value.slice(z)}`.slice(0, LIMITS.tooltipText);
        ta.focus(); refresh(); save();
      });
      chips.append(b);
    }
    if (!cat().length) chips.append(el("span", "ws-shelf__note", "Add fields to the view to insert them."));
    };
    box.append(chips);
    const preview = el("div", "ws-tipedit__preview");
    preview.setAttribute("aria-label", "Tooltip preview");
    const note = el("span", "ws-shelf__note");
    const refresh = () => {
      const r = checkTooltipText(ta.value);
      const sample = lookupFrom(Object.fromEntries(cat().map((f) => [f.name, f.sample])));
      preview.innerHTML = r.ok && r.value ? tooltipHtml(r.value, sample) : ""; // escaped parts only (tooltip-model.js)
      if (!r.ok || !r.value) preview.textContent = "Automatic tooltip";
      const unknown = r.ok && r.value ? parseTooltip(r.value).fields.filter((n) => sample(n) === undefined) : [];
      note.textContent = r.ok ? `${ta.value.length}/${LIMITS.tooltipText} · automatic tooltip kept on Table, Text, KPI, Heatmap, Treemap, discrete-colour splits, Scatter with Shape and the other special chart types${unknown.length ? ` · not in this view: ${unknown.map((n) => `<${n}>`).join(" ")}` : ""}` : r.error;
    };
    const save = () => {
      const r = checkTooltipText(ta.value);
      if (!r.ok || r.value === (s.tooltipText ?? null)) return;
      s.tooltipText = r.value; commit(dash, s);
    };
    ta.addEventListener("input", refresh);
    ta.addEventListener("change", save);
    box.append(preview, note);
    const redraw = () => { if (!box.isConnected) return; drawChips(); refresh(); };
    tooltipRedraw = redraw;
    drawChips();
    refresh();
    return box;
  }

  // --- Member colours (T01-20) ---------------------------------------------
  // The members the last drawn chart colours by a discrete field ({ field, members: [{ name, raw }] }), keyed
  // by sheet and cleared at the start of each drawing. The editor lists them; a pick stores a validated #rrggbb
  // in sheet.memberColors (Dashboard/colour-model.js) and re-draws.
  let memberState = { sheet: null, field: null, members: [] };
  let memberOpen = false;
  let memberRedraw = null;
  const setMemberState = (sheet, field, members) => { memberState = { sheet, field, members }; memberRedraw?.(); };
  function memberColourEditor(dash, s) {
    const box = el("div", "ws-memcol");
    const head = el("button", "btn btn--ghost ws-memcol__toggle"); head.type = "button";
    const body = el("div", "ws-memcol__body");
    const draw = () => {
      if (!box.isConnected && body.childElementCount) return;
      const st = memberState.sheet === s ? memberState : { field: null, members: [] };
      const fieldKey = st.field ? fieldColorKey(st.field) : "";
      const colours = Object.prototype.hasOwnProperty.call(s.memberColors ?? {}, fieldKey) ? s.memberColors[fieldKey] : {};
      head.textContent = `${memberOpen ? "Hide" : "Edit"} member colours`;
      head.setAttribute("aria-expanded", String(memberOpen));
      head.disabled = !st.field;
      head.title = st.field ? "" : "Colour by a field (Colour shelf, Pie slices, or Colour by category) to colour its members";
      body.hidden = !memberOpen || !st.field;
      body.replaceChildren();
      if (body.hidden) return;
      const pick = (m, hex) => {
        const r = setMemberColor(s.memberColors, fieldColorKey(st.field), memberKey(m.raw), hex);
        if (!r.ok) { toast(r.error, "danger"); return; }
        s.memberColors = r.value; commit(dash, s);
      };
      for (const m of st.members.slice(0, LIMITS.memberColors)) {
        const cur = colourOf(colours, memberKey(m.raw));
        const row = el("div", "ws-memcol__row");
        const dot = el("span", "ws-memcol__dot"); dot.dataset.colour = cur ?? "";
        if (cur) dot.style.backgroundColor = cur;
        row.append(dot, el("span", "ws-memcol__name", m.name));
        const sw = el("span", "ws-memcol__swatches");
        for (const hex of SWATCHES) {
          const b = el("button", "ws-memcol__swatch"); b.type = "button"; b.style.backgroundColor = hex;
          b.setAttribute("aria-label", `Colour ${m.name} ${hex}`); b.setAttribute("aria-pressed", String(cur === hex));
          if (cur === hex) b.textContent = "\u2713";
          b.addEventListener("click", () => pick(m, hex));
          sw.append(b);
        }
        const reset = el("button", "btn btn--ghost ws-memcol__reset", "Reset"); reset.type = "button"; reset.disabled = !cur;
        reset.addEventListener("click", () => pick(m, null));
        row.append(sw, reset);
        body.append(row);
      }
      const stored = Object.keys(colours).length;
      const clearAll = el("button", "btn btn--ghost ws-memcol__clear", `Reset all for this field (${stored})`); clearAll.type = "button"; clearAll.disabled = !stored;
      clearAll.title = "Also removes colours of members that are no longer in the view";
      clearAll.addEventListener("click", () => { s.memberColors = clearFieldColors(s.memberColors, fieldKey).value; commit(dash, s); });
      body.append(clearAll);
      if (st.members.length > LIMITS.memberColors) body.append(el("p", "ws-memcol__note", `Only the first ${LIMITS.memberColors} members can be coloured.`));
    };
    head.addEventListener("click", () => { memberOpen = !memberOpen; draw(); });
    box.append(head, body);
    memberRedraw = draw;
    draw();
    return box;
  }

  // --- Date range & comparison (P35) ---------------------------------------
  function setPeriod(dash, f) {
    const refused = refusal(f, "period");
    if (refused) { toast(refused, "info"); return; }
    if (f.category !== "temporal") { toast("Date range needs a date or date-time field.", "info"); return; }
    dash.sheet.period = newPeriod(f);
    commit(dash, dash.sheet);
  }
  // The Date range editor: preset (or custom days), comparison (or custom days), and the resolved ranges.
  function periodEditor(dash, s) {
    const p = s.period;
    const set = (patch) => { s.period = { ...p, ...patch }; commit(dash, s); };
    const box = el("div", "ws-period");
    const row = el("div", "ws-period__row");
    row.append(fmtSelect("Range", PRESET_CHOICES, p.preset, (v) => set({ preset: v })));
    if (p.preset === "custom") row.append(dayInput("From", p.from, (v) => set({ from: v })), dayInput("To", p.to, (v) => set({ to: v })));
    row.append(fmtSelect("Compare to", COMPARE_CHOICES, p.compare, (v) => set({ compare: v })));
    if (p.compare === "custom")
      row.append(dayInput("From", p.compareFrom, (v) => set({ compareFrom: v })), dayInput("To", p.compareTo, (v) => set({ compareTo: v })));
    box.append(row);
    const range = resolveRange(p);
    const cmp = compareRange(p, range);
    const summary = !range ? "Pick both days — From on or before To."
      : p.compare === "custom" && !cmp ? `${rangeLabel(range)} · pick both comparison days.`
      : `${rangeLabel(range)}${cmp ? ` vs ${rangeLabel(cmp)}` : ""}`;
    box.append(el("span", `ws-shelf__note${range ? "" : " ws-shelf__note--warn"}`, summary));
    if (cmp && !COMPARE_TYPES.has(s.chartType))
      box.append(el("span", "ws-shelf__note", "The comparison shows on Bar, Line, Area and KPI; this chart uses the range only."));
    return box;
  }
  function dayInput(labelText, value, onChange) {
    const wrap = el("label", "ws-fmt-field");
    wrap.append(el("span", "ws-fmt-label", labelText));
    const inp = el("input", "input ws-fmt-input");
    inp.type = "date";
    inp.value = value ?? "";
    inp.addEventListener("change", () => onChange(inp.value || null));
    wrap.append(inp);
    return wrap;
  }
  // Wire a zone as a field-only drop target (no pill reorder). Shared by the tool panel.
  function wireFieldDrop(zone, onDrop) {
    zone.addEventListener("dragover", (e) => { if (hasField(e)) { e.preventDefault(); zone.classList.add("is-over"); } });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => { zone.classList.remove("is-over"); const f = readField(e); if (f) { e.preventDefault(); onDrop(f); } });
  }
  // A marks-encoding pill: table.column + a remove button, tinted as a marks pill.
  function markPill(f, remove) {
    const p = pill(nameOf(f), remove);
    p.classList.add("ws-pill--mark");
    return p;
  }
  // Size takes one NUMERIC field (it scales the mark — a bubble); non-numeric is nudged away.
  function addSize(dash, f) {
    if (f.category !== "numeric") { toast("Size needs a numeric field (it scales the mark).", "info"); return; }
    if (!allowed(dash, "size", f)) return;
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m.size = isCalcPill(f) ? slotEntry(f) : { ...slotEntry(f), agg: "sum" };
    commit(dash, dash.sheet);
  }
  // Label holds one field of any kind (numeric → its aggregate; categorical → its grouped value).
  function addMarkSingle(dash, key, f) {
    if (!allowed(dash, key, f)) return;
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m[key] = isCalcPill(f) ? slotEntry(f) : { ...slotEntry(f), ...(f.category === "numeric" ? { agg: "sum" } : {}) };
    commit(dash, dash.sheet);
  }
  // Detail / Tooltip hold a list of fields (no duplicates). Detail adds group-by granularity.
  function addMarkList(dash, key, f) {
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    const list = m[key] ?? (m[key] = []);
    if (list.some((x) => sameField(x, f))) return;
    if (!allowed(dash, key, f)) return;
    list.push(isCalcPill(f) ? slotEntry(f) : { ...slotEntry(f), ...(f.category === "numeric" ? { agg: "sum" } : {}) });
    commit(dash, dash.sheet);
  }
  // Shape (P19) takes one CATEGORICAL field (distinct point symbols); numeric is nudged away.
  function addShape(dash, f) {
    const refused = refusal(f, "shape");
    if (refused) { toast(refused, "info"); return; }
    if (f.category === "numeric") { toast("Shape needs a categorical field (each value gets its own symbol).", "info"); return; }
    if (!allowed(dash, "shape", f)) return;
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m.shape = { db: f.db, table: f.table, column: f.column, category: f.category };
    commit(dash, dash.sheet);
  }
  // Angle (P19) takes one NUMERIC field (a radial magnitude — pie already maps its measure to angle).
  function addAngle(dash, f) {
    const refused = refusal(f, "angle");
    if (refused) { toast(refused, "info"); return; }
    if (f.category !== "numeric") { toast("Angle needs a numeric field (it drives a radial magnitude).", "info"); return; }
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m.angle = { db: f.db, table: f.table, column: f.column, category: f.category, agg: "sum" };
    commit(dash, dash.sheet);
  }

  // --- Pages shelf (P20) ---------------------------------------------------
  // One dimension whose members the view steps/animates through, one at a time. Each page is a
  // bound-parameter `=` filter on the current member (the P14 path); members come from the bounded
  // distinct-values query (shared with the `in` filter). Autoplay is suppressed under reduced-motion.
  function addPages(dash, f) {
    const refused = refusal(f, "pages");
    if (refused) { toast(refused, "info"); return; }
    stopPaging();
    dash.sheet.pages = { db: f.db, table: f.table, column: f.column, category: f.category, index: 0 };
    commit(dash, dash.sheet);
  }
  function pagesPill(dash, s) {
    const remove = () => { stopPaging(); s.pages = null; commit(dash, s); };
    const p = pill(`${s.pages.table}.${s.pages.column}`, remove);
    p.classList.add("ws-pill--mark");
    return p;
  }
  // Load the member list once (bounded, cached), store it on the pages state, then re-render/re-run so
  // the page filter applies. Failures leave members = [] (the control shows a note; view stays unfiltered).
  async function ensurePagesMembers(dash, s) {
    const p = s.pages;
    if (!p || Array.isArray(p.members)) return;
    p.members = []; // in-flight guard against re-entry
    try {
      const vals = await distinctFor(p.db, p.table, p.column);
      if (dash.sheet.pages === p) {
        p.more = vals.length > DISTINCT_SHOWN;
        p.members = vals.slice(0, DISTINCT_SHOWN); p.index = Math.min(p.index ?? 0, Math.max(0, p.members.length - 1)); commit(dash, s);
      }
    } catch (err) { p.loadError = `Couldn't load members: ${err.message}`; if (dash.sheet.pages === p) commit(dash, s); }
  }
  // The page control: current member + count, ◀ ▶ step (wrapping), and Play/Pause. Play is omitted
  // under prefers-reduced-motion (done-when: no autoplay when reduced motion is set).
  function pagesControl(dash, s) {
    const p = s.pages;
    const wrap = el("div", "ws-pages");
    wrap.append(el("span", "ws-pages__icon", "▤"), el("span", "ws-select__label", `Page: ${p.column}`));
    if (!Array.isArray(p.members)) { wrap.append(el("span", "ws-shelf__hint", "loading members…")); ensurePagesMembers(dash, s); return wrap; }
    if (!p.members.length) { wrap.append(el("span", "ws-shelf__hint", p.loadError ?? "couldn't load members")); return wrap; }

    const n = p.members.length;
    const idx = Math.max(0, Math.min(p.index ?? 0, n - 1));
    const cur = p.members[idx];
    const step = (d) => { stopPaging(); p.index = (idx + d + n) % n; commit(dash, s); };
    const prev = makeButton("◀", "ws-pages__btn"); prev.setAttribute("aria-label", "Previous page"); prev.addEventListener("click", () => step(-1));
    const next = makeButton("▶", "ws-pages__btn"); next.setAttribute("aria-label", "Next page"); next.addEventListener("click", () => step(1));
    wrap.append(prev, el("span", "ws-pages__member", `${cur == null ? "—" : cur}  ·  ${idx + 1}/${n}`), next);
    if (p.more) wrap.append(el("p", "ws-note", "Showing the first 200 values — more exist."));

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      const playing = Boolean(pageTimer);
      const play = makeButton(playing ? "❚❚ Pause" : "▶ Play", `ws-pages__btn${playing ? " is-active" : ""}`);
      play.setAttribute("aria-pressed", String(playing));
      play.addEventListener("click", () => {
        if (pageTimer) { stopPaging(); commit(dash, s); return; }
        pageTimer = setInterval(() => {
          const pg = dash.sheet.pages;
          if (!pg || !Array.isArray(pg.members) || !pg.members.length) { stopPaging(); return; }
          pg.index = ((pg.index ?? 0) + 1) % pg.members.length;
          commitQuiet(dash, s);
        }, 1500);
        commit(dash, s);
      });
      wrap.append(play);
    }
    return wrap;
  }
  // Every edit goes through commit() → worksheet:changed → renderShelves + runChart. P23: each commit also
  // records the previous committed sheet for undo (edits mutate the sheet in place, so the "before" is
  // the snapshot taken at the last commit). commitQuiet skips the history (Pages autoplay).
  const commit = (dash, sheet) => {
    const before = lastSnap.get(dash.id);
    if (before) history.record(dash.id, before);
    lastSnap.set(dash.id, structuredClone(sheet));
    updateSheet(dash.id, sheet);
  };
  const commitQuiet = (dash, sheet) => { lastSnap.set(dash.id, structuredClone(sheet)); updateSheet(dash.id, sheet); };

  // P29: a legend click highlights that item (a second click clears it); on a legend that lists a dimension's members
  // (`field` + `raw`) it also selects the member, so the selection bar offers Keep only / Exclude (the click-to-filter path).
  function legendClick({ sheet, field, name, raw, bucketed }) {
    const dash = activeWorksheet();
    const again = legendFocus === name;
    legendFocus = again ? null : name;
    if (field && !isCalcPill(field) && dash && raw !== undefined && raw !== null && bucketed === null) { // E12: a calculated field can't be click-filtered; the legend still highlights
      if (again) sheet.selection = null;
      else {
        const fmtCat = makeCategoryFormatter(sheet.format ?? defaultFormat());
        sheet.selection = { db: field.db, table: field.table, column: field.column, value: raw,
          label: `${nameOf(field)} = ${fmtCat(raw)}`, action: null };
      }
      commit(dash, sheet);
    } else {
      focusSeries(chartEl, legendFocus, sheet.chartType);
    }
  }

  // Toggle the click selection: a fresh click selects (action reset to a plain highlight); clicking the
  // already-selected value clears it. Keep-only / Exclude are chosen from the selection chip.
  function toggleSelection(dimField, rawValue) {
    const dash = activeWorksheet();
    if (!dash) return;
    const refused = refusal(dimField, "selection");
    if (refused) { toast(refused, "info"); return; }
    const s = dash.sheet;
    const cur = s.selection;
    const same = cur && cur.table === dimField.table && cur.column === dimField.column && String(cur.value) === String(rawValue);
    if (same) {
      s.selection = null;
    } else {
      const fmtCat = makeCategoryFormatter(s.format ?? defaultFormat());
      s.selection = {
        db: dimField.db, table: dimField.table, column: dimField.column, value: rawValue,
        label: `${dimField.table}.${dimField.column} = ${fmtCat(rawValue)}`, action: null,
      };
    }
    commit(dash, s);
  }

  // The Format card's editor: pick a measure, then its scale / bars and rules.
  function conditionalEditor(dash, s) {
    const f = s.format;
    const mplan = planMeasures(s);
    const box = el("div", "ws-cf");
    box.append(el("span", "ws-fmt-label ws-cf__title", "Conditional formatting"));
    if (!mplan.length) { box.append(el("span", "ws-shelf__note", "Add a measure to format its cells.")); return box; }
    const opts = mplan.map((e) => [measureKey(e), `${e.agg} ${e.field.column}`]);
    if (!opts.some(([k]) => k === cfMeasure)) cfMeasure = opts[0][0];
    const all = f.conditional ?? {};
    const cfg = { ...emptyRule(), ...(all[cfMeasure] ?? {}) };
    const save = (patch) => {
      const next = { ...cfg, ...patch };
      const conditional = { ...all };
      if (isActive(next) || next.mid != null) conditional[cfMeasure] = next; else delete conditional[cfMeasure];
      s.format = { ...f, conditional };
      commit(dash, s);
    };
    const row = el("div", "ws-cf__row");
    row.append(fmtSelect("Measure", opts, cfMeasure, (v) => { cfMeasure = v; renderShelves(); }));
    row.append(fmtSelect("Cells", CF_MODE_CHOICES, cfg.mode, (v) => save({ mode: v })));
    if (cfg.mode === "scale") {
      row.append(fmtSelect("Scale", CF_SCALE_CHOICES, cfg.scale, (v) => save({ scale: v })));
      if (cfg.scale === "diverging")
        row.append(fmtNumber("Midpoint", cfg.mid, "auto", (v) => save({ mid: v })));
    }
    box.append(row);
    cfg.rules.forEach((r, i) => {
      const rr = el("div", "ws-cf__row ws-cf__rule");
      const setRule = (patch) => save({ rules: cfg.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
      rr.append(fmtSelect(`Rule ${i + 1}: value`, CF_OP_CHOICES, r.op, (v) => setRule({ op: v })),
        fmtNumber("", r.value, "number", (v) => { if (v != null) setRule({ value: v }); }),
        fmtSelect("show as", CF_TONE_CHOICES, r.tone, (v) => setRule({ tone: v })));
      const del = iconButton("close", `Remove rule ${i + 1}`);
      del.addEventListener("click", () => save({ rules: cfg.rules.filter((_, j) => j !== i) }));
      rr.append(del);
      box.append(rr);
    });
    if (cfg.rules.length < CF_MAX_RULES) {
      const add = makeButton("+ Add rule", "btn ws-cf__add");
      add.addEventListener("click", () => save({ rules: [...cfg.rules, { op: ">", value: 0, tone: "good" }] }));
      box.append(add);
    }
    return box;
  }
  // P39: the sheet's link action — a label and an https:// template with {value}. Blank template = none.
  function linkActionEditor(dash, s) {
    const a = s.urlAction ?? { label: "", template: "" };
    const box = el("div", "ws-cf ws-link");
    box.append(el("span", "ws-fmt-label ws-cf__title", "Link action"));
    const row = el("div", "ws-cf__row");
    const labelF = fmtText("Label", a.label || null, (v) => {
      if (!s.urlAction) return; // a label alone does nothing until there is a link
      s.urlAction = { ...s.urlAction, label: (v ?? "").slice(0, MAX_LABEL) || "Open link" }; commit(dash, s);
    });
    labelF.querySelector("input").maxLength = MAX_LABEL;
    labelF.querySelector("input").placeholder = "Open link";
    const tplF = fmtText("Link", a.template || null, (v) => {
      if (v == null) { s.urlAction = null; commit(dash, s); return; }
      const err = templateError(v);
      if (err) { fieldError(tplF.querySelector("input"), err); return; }
      s.urlAction = { label: s.urlAction?.label || labelF.querySelector("input").value.trim() || "Open link", template: v };
      commit(dash, s);
    });
    const tplIn = tplF.querySelector("input");
    tplIn.maxLength = MAX_TEMPLATE; tplIn.placeholder = "https://example.com/item/{value}"; tplIn.classList.add("ws-link__tpl");
    tplIn.inputMode = "url"; tplIn.spellcheck = false;
    row.append(labelF, tplF);
    box.append(row, el("span", "ws-shelf__note", "Click a mark, then use the link on the selection bar. {value} becomes the clicked value; only https:// links open, in a new tab."));
    return box;
  }

  // A number field for the Format card: blank → null; a non-number toasts and keeps the old value.
  function fmtNumber(labelText, value, placeholder, onChange) {
    const wrap = el("label", "ws-fmt-field");
    if (labelText) wrap.append(el("span", "ws-fmt-label", labelText));
    const inp = el("input", "input ws-fmt-input ws-cf__num");
    inp.type = "text"; inp.inputMode = "decimal";
    inp.value = value == null ? "" : String(value);
    inp.placeholder = placeholder;
    if (!labelText) inp.setAttribute("aria-label", "Threshold");
    inp.addEventListener("change", () => {
      const raw = inp.value.trim();
      if (!raw) { onChange(null); return; }
      const r = number(raw);
      if (!r.ok) { toast(r.error, "danger"); inp.value = value == null ? "" : String(value); return; }
      onChange(r.value);
    });
    wrap.append(inp);
    return wrap;
  }

  function uniqueTables() {
    const seen = new Set(), out = [];
    for (const e of entities.values()) {
      const k = keyOf(e.db, e.table);
      if (!seen.has(k)) { seen.add(k); out.push({ db: e.db, table: e.table }); }
    }
    return out;
  }
  async function columnsFor(db, table) {
    const k = keyOf(db, table);
    if (!columnsCache.has(k)) {
      try { columnsCache.set(k, await api.columns(db, table)); }
      catch { columnsCache.set(k, []); }
    }
    return columnsCache.get(k);
  }
  function iconButton(glyph, label) {
    const b = el("button", "iconbtn"); b.append(PATHS[glyph] ? icon(glyph) : glyph); b.type = "button"; b.setAttribute("aria-label", label);
    return b;
  }
}

// --- DnD + DOM helpers ------------------------------------------------------
function hasField(e) { return e.dataTransfer && Array.from(e.dataTransfer.types).includes(FIELD_MIME); }
function readField(e) {
  const raw = e.dataTransfer?.getData(FIELD_MIME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
// A pill-reorder drag carries { shelf, index } under its own MIME, distinct from a new field dragged
// from the field pane (FIELD_MIME), so a shelf can tell "reorder an existing pill" from "add a field".
const PILL_MIME = "application/x-ch-pill";
function hasPill(e) { return e.dataTransfer && Array.from(e.dataTransfer.types).includes(PILL_MIME); }
function readPill(e) {
  const raw = e.dataTransfer?.getData(PILL_MIME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}


// --- export helpers (P13) ---------------------------------------------------
// Trigger a browser download of a Blob, cleaning up the object URL afterwards.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
// A safe file base name from the dashboard name (fallback "worksheet").
function exportBaseName(dash) {
  const raw = (dash?.name || "worksheet").trim().toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "worksheet";
}

function select(options, selected, className, label) {
  const sel = el("select", `select select--light ${className ?? ""}`.trim());
  if (label) sel.setAttribute("aria-label", label); // accessible name (a11y — no visible <label>)
  for (const o of options) { const opt = new Option(o, o); if (o === selected) opt.selected = true; sel.add(opt); }
  return sel;
}

// --- format-panel controls (P10). Each wraps its control in a <label> so the visible text is the
// control's accessible name. `options` is [value, text] pairs; `current` matches by string value. ---
function fmtSelect(labelText, options, current, onPick) {
  const wrap = el("label", "ws-fmt-field");
  wrap.append(el("span", "ws-fmt-label", labelText));
  const sel = el("select", "select select--light ws-fmt-select");
  for (const [val, text] of options) {
    const opt = new Option(text, String(val));
    if (String(val) === String(current)) opt.selected = true;
    sel.add(opt);
  }
  sel.addEventListener("change", () => onPick(sel.value));
  wrap.append(sel);
  return wrap;
}
function fmtCheck(labelText, checked, onToggle) {
  const wrap = el("label", "ws-fmt-field ws-fmt-check");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = !!checked;
  cb.addEventListener("change", () => onToggle(cb.checked));
  wrap.append(cb, el("span", "ws-fmt-label", labelText));
  return wrap;
}
function fmtText(labelText, value, onChange) {
  const wrap = el("label", "ws-fmt-field");
  wrap.append(el("span", "ws-fmt-label", labelText));
  const inp = el("input", "input ws-fmt-input");
  inp.type = "text";
  inp.value = value ?? "";
  inp.placeholder = "auto"; inp.maxLength = LIMITS.axisTitle;
  inp.addEventListener("change", () => onChange(inp.value.trim() || null));
  wrap.append(inp);
  return wrap;
}
