// Tooltip behaviour (Format → Show tooltips, Command buttons, Responsive / On hover) — pure, DOM-free (tests/js/tooltip-behaviour.test.mjs).
//   Show tooltips     on by default. Off: no hover tooltip on any chart type (the marks, labels and the table view are unchanged: a value is never only in a tooltip).
//   Command buttons   off by default. On: the tooltip of a mark that selects by a dimension value is enterable and carries Keep only / Exclude / View data for that
//                     mark. They run the selection chip's own actions (dashboards.js `tooltipCommand`): no filter logic lives here.
//   Responsive        (default) hover tooltips are today's; a click on a mark pins that mark's tooltip, with the buttons, until it is dismissed (click the mark
//                     again, click empty chart, Esc, the chip's ✕, or a command). While pinned, other marks show no hover tooltip.
//   On hover          the buttons are in every hover tooltip.
// Stored on `format` only when they differ from the default (`showTooltips: false`, `tooltipButtons: true`, `tooltipMode: "hover"`), so older files round-trip unchanged.
import { TOOLTIP_MODES } from "../Core/sheet-schema.js";
import { primaryDim } from "./result-model.js";
import { planDims, isDrillActive, marksOf, colorMode, SCATTER_TYPES } from "./sheet-plan.js";
import { isGroupingPart } from "./date-parts.js";
import { BUCKET_TYPES, DATE_BUCKET_CHOICES } from "./scale-model.js";
import { selectedIndicesOf } from "./dashboard-select.js";

export const TOOLTIP_MODE_CHOICES = [["responsive", "Responsive"], ["hover", "On hover"]];
/** The command buttons, in order: [command, label]. */
export const COMMANDS = [["keep", "Keep only"], ["exclude", "Exclude"], ["data", "View data"]];
const COMMAND_KEYS = new Set(COMMANDS.map(([k]) => k));
/** The chart types whose marks select by their primary dimension value one to one with a tooltip's data index. A Gantt row can hold several bars (colour members),
 *  so a tooltip's index is not a row: it keeps its hover tooltip and its click, and has no buttons. */
export const BUTTON_TYPES = new Set(["bar", "stacked", "line", "area", "combo", "pie", "donut", "scatter"]);
/** Chart types that draw an ECharts hover tooltip at all (a table, text or scorecard has none). */
const TOOLTIP_TYPES = new Set(["bar", "stacked", "line", "area", "pie", "donut", "scatter", "combo", "square", "circle", "heatmap", "treemap", "histogram", "boxplot", "waterfall", "funnel", "gauge", "bullet", "sankey", "multiples", "gantt"]);
const HIDE_DELAY = 400; // ms: long enough to move the pointer onto the tooltip, short enough that it never lingers

const DEFAULTS = { showTooltips: true, tooltipButtons: false, tooltipMode: "responsive" };

export const tooltipsOn = (format) => format?.showTooltips !== false;
export const commandButtonsOn = (format) => format?.tooltipButtons === true;
export const tooltipModeOf = (format) => (TOOLTIP_MODES.has(format?.tooltipMode) ? format.tooltipMode : "responsive");

export const showTooltipsError = (v) => (typeof v === "boolean" ? null : "Show tooltips must be on or off.");
export const tooltipButtonsError = (v) => (typeof v === "boolean" ? null : "Command buttons must be on or off.");
export const tooltipModeError = (v) => (TOOLTIP_MODES.has(v) ? null : "Tooltip mode must be Responsive or On hover.");

/** `format` with `key` set to `value` — or without it when `value` is the default, so a default is never stored. */
export function withTooltipSetting(format, key, value) {
  const next = { ...format };
  if (value === DEFAULTS[key]) delete next[key]; else next[key] = value;
  return next;
}

// ---- the Format controls --------------------------------------------------------------------------------------------------------

/** Said where the first field's dates are grouped into periods: a mark is then a period, not a value a filter could match. */
export const DATE_GROUPED_NOTE = "the first field's dates are grouped into periods (Format → Group dates, or a date part), so a mark has no value to keep or exclude. Choose Group dates → Exact to show them.";
const grainLabel = (g) => DATE_BUCKET_CHOICES.find(([v]) => v === g)?.[1] ?? g;

/** Why command buttons would do nothing on this worksheet, or null when they would work. `i` = { type, hasDim, drilling, firstKeyGrouped, split, dateBucket?, firstKeyDated? }. */
export function buttonGate(i) {
  if (!BUTTON_TYPES.has(i.type)) return "Command buttons need a chart whose marks select by a field value (bar, line, area, pie, point).";
  if (!i.hasDim) return "Add a dimension: a mark needs a field value to keep or exclude.";
  if (i.drilling) return "A drill hierarchy is active: a click steps down instead of selecting a mark.";
  if (i.firstKeyGrouped) return "A date part groups the first field, so a mark has no value to keep or exclude.";
  if (i.firstKeyDated && i.dateBucket && i.dateBucket !== "auto" && i.dateBucket !== "exact") return `Group dates is ${grainLabel(i.dateBucket)}, so a mark is a period, not a value to keep or exclude. Choose Group dates → Exact.`;
  if (i.split) return "A point chart split by Colour or Shape does not select its marks.";
  return null;
}

/** A note (not a reason to disable) for a first field that is a date the server may group on its own (Group dates: Auto): the buttons then appear only when it does not. */
export const buttonNote = (i) => (i.firstKeyDated && (i.dateBucket ?? "auto") === "auto" ? "On a date axis, Group dates → Auto may group the dates into periods; the buttons then do not appear (the chart says so). Choose Group dates → Exact to always have them." : null);

/** The worksheet as `buttonGate` wants it (the same rules the click uses: render-handlers.js `selectHandler`, worksheet-render.js). */
export function gateInputs(sheet) {
  const dims = planDims(sheet);
  const first = dims.keyOrder[0];
  return {
    type: sheet.chartType,
    hasDim: Boolean(primaryDim(sheet)),
    drilling: isDrillActive(sheet),
    firstKeyGrouped: isGroupingPart(first?.datePart ?? null),
    // a temporal first field the server groups by Format → Group dates (a calculated field, an exact / non-grouping part and a chart type with no grouping are never bucketed)
    firstKeyDated: Boolean(first) && first.category === "temporal" && first.calc === undefined && (first.datePart == null || first.datePart === "auto") && BUCKET_TYPES.has(sheet.chartType),
    dateBucket: sheet.format?.dateBucket ?? "auto",
    split: SCATTER_TYPES.has(sheet.chartType) && Boolean(marksOf(sheet).shape || dims.colourDims.length > 0 || colorMode(sheet) === "discrete"),
  };
}

/** The Format panel's controls for a chart: [{ key, label, kind: "check" | "select", value, choices?, disabled? }] — none for a chart with no hover tooltip.
 *  A control that does nothing here is disabled and says why. `gate` = buttonGate(...) of the worksheet. */
export function tooltipControlSpecs({ type, format, gate, note = null }) {
  if (!TOOLTIP_TYPES.has(type)) return [];
  const on = tooltipsOn(format);
  const buttons = commandButtonsOn(format);
  const noTips = "Turn on Show tooltips first.";
  const why = !on ? noTips : gate;
  return [
    { key: "showTooltips", label: "Show tooltips", kind: "check", value: on },
    { key: "tooltipButtons", label: "Command buttons", kind: "check", value: buttons, ...(why ? { disabled: why } : note ? { note } : {}) },
    { key: "tooltipMode", label: "Tooltip mode", kind: "select", value: tooltipModeOf(format), choices: TOOLTIP_MODE_CHOICES,
      ...(why ? { disabled: why } : !buttons ? { disabled: "Responsive or On hover only matters with command buttons." } : {}) },
  ];
}

// ---- the tooltip itself ---------------------------------------------------------------------------------------------------------

/** The mark a tooltip's params name: an axis tooltip hands an array (its first entry), an item tooltip one entry. */
export const dataIndexOf = (p) => { const e = Array.isArray(p) ? p[0] : p; return Number.isInteger(e?.dataIndex) ? e.dataIndex : -1; };

/** The command buttons' markup for mark `idx`: fixed labels and a whole number, nothing a user typed. "" for an index that is not a whole number. */
export function commandsHtml(idx) {
  if (!Number.isInteger(idx) || idx < 0) return "";
  return `<div class="ws-tip__cmds">${COMMANDS.map(([cmd, label]) => `<button type="button" class="ws-select__btn" data-tt-cmd="${cmd}" data-tt-idx="${idx}">${label}</button>`).join("")}</div>`;
}

/** A click's target -> { cmd, idx } when it is (inside) a command button; null for anything else, an unknown command or a bad index. */
export function commandOf(target) {
  const b = target && typeof target.closest === "function" ? target.closest("button[data-tt-cmd]") : null;
  if (!b?.dataset) return null;
  const { ttCmd, ttIdx } = b.dataset;
  if (!COMMAND_KEYS.has(ttCmd) || !/^\d+$/.test(String(ttIdx))) return null;
  return { cmd: ttCmd, idx: Number(ttIdx) };
}

/** Responsive: the mark to pin — the first mark of the value `pin` ({ db, table, column, value }) names; null in On hover or when no mark carries it. */
export function pinnedIndex(mode, rawByIndex, pin, dim) {
  if (mode !== "responsive" || !pin) return null;
  const at = selectedIndicesOf(rawByIndex, pin, dim)[0];
  return at === undefined ? null : at;
}

// An enterable tooltip follows the pointer by default, so reaching it moves it (and on an axis tooltip, crossing the next category swaps its content). This
// anchors it once per hovered mark, a few px from where the pointer entered; `reset` forgets the anchor when the pointer leaves the chart.
function anchored() {
  let idx = null, pos = null;
  const position = (point, params) => {
    const i = dataIndexOf(params);
    if (i !== idx || !pos) { idx = i; pos = [point[0] + 6, point[1] + 6]; }
    return pos;
  };
  position.reset = () => { idx = null; pos = null; };
  return position;
}

/**
 * Apply the worksheet's tooltip settings to a built ECharts option (in place; also returned). `spec` = the chart spec: `format`, `type` and, when the render
 * path can act on the buttons, `tooltipButtons` = { can(idx), pinned (an index or null) }. Nothing set = the option untouched.
 */
export function applyTooltipBehaviour(option, spec = {}) {
  const tip = option?.tooltip;
  if (!tip || Array.isArray(tip)) return option;
  const format = spec.format ?? {};
  if (!tooltipsOn(format)) { option.tooltip = { show: false, trigger: "none" }; return option; } // no content, no axis pointer
  const b = spec.tooltipButtons;
  if (!b || !commandButtonsOn(format) || !BUTTON_TYPES.has(spec.type) || typeof tip.formatter !== "function") return option;
  const hoverMode = tooltipModeOf(format) === "hover";
  if (!hoverMode && !Number.isInteger(b.pinned)) return option; // Responsive with nothing pinned: today's tooltip
  const pinnedNow = () => (!hoverMode && Number.isInteger(b.pinned) ? b.pinned : null); // read live: dismissing the pin (tooltip-commands.js) clears it
  const can = (i) => i >= 0 && (typeof b.can !== "function" || b.can(i) !== false);
  const base = tip.formatter;
  option.tooltip = {
    ...tip, enterable: true, confine: true, className: "ws-tip", hideDelay: HIDE_DELAY, position: anchored(),
    ...(hoverMode ? {} : { triggerOn: "none", alwaysShowContent: true }), // pinned: nothing else shows or hides it
    formatter: (p, ...rest) => {
      const html = base(p, ...rest);
      const i = dataIndexOf(p);
      return can(i) && (hoverMode || i === pinnedNow()) ? html + commandsHtml(i) : html;
    },
  };
  return option;
}
