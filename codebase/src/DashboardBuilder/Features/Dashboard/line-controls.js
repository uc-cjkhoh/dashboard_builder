// The Line pattern (Format) and Line markers (Color flyout) controls: what each shows comes from the pure `lineControlSpecs` (line-style-model.js), so the
// panel and the drawing agree on when a control does something; this file reads the worksheet into those inputs and puts the controls on the panel.
import { planMeasures, colorMode } from "./sheet-plan.js";
import { primaryDim } from "./result-model.js";
import { selectionRefusal } from "./dashboard-select.js";
import { gateInputs } from "./tooltip-behaviour-model.js";
import { selectGate, selectNote } from "./line-marker-model.js";
import { lineControlSpecs } from "./line-style-model.js";

const DEFAULTS = { linePattern: "solid", lineMarkers: "auto" }; // not stored: absent reads as the default, so older files round-trip unchanged

// The points the sheet's line chart last drew (series x categories): the Format panel needs it for the same Size rule the drawing applies (a straight line over
// LINE_WIDTH_MAX_POINTS draws Size as marker size, not thickness). The drawing records it per sheet object; a sheet never drawn counts as within the bound.
const drawnPoints = new WeakMap();
/** Record how many points `sheet`'s line chart drew (called by the cartesian render path). */
export const noteLinePoints = (sheet, points) => { if (sheet && typeof sheet === "object") drawnPoints.set(sheet, points); };

/** Whether Line markers → Selected could ever select a mark on this sheet: { reason, note } (line-marker-model.js `selectGate`; the same rules as the tooltip's command buttons). */
function selectInputs(sheet) {
  const d = primaryDim(sheet), g = gateInputs(sheet);
  const i = { hasDim: Boolean(d), refusal: d ? selectionRefusal(d) : null, drilling: g.drilling, firstKeyGrouped: g.firstKeyGrouped, firstKeyDated: g.firstKeyDated, dateBucket: g.dateBucket };
  return { reason: selectGate(i), note: selectNote(i) };
}

/** The worksheet as `lineControlSpecs` wants it: shelf measures (a colour / Size / Label measure is not one), a colour *measure*, a Size field. */
export const lineControlInputs = (sheet) => ({
  type: sheet.chartType,
  format: sheet.format ?? {},
  shelfCount: planMeasures(sheet).filter((e) => e.role === "shelf").length,
  colourMeasure: colorMode(sheet) === "continuous",
  hasSize: Boolean(sheet.marks?.size), // a Size field is set (the panel's view); the drawing also needs its values, which a drawn chart has whenever the field is valid
  points: drawnPoints.get(sheet) ?? 0,
  select: selectInputs(sheet), // Line markers → Selected needs a mark a click can select
});

/** The inputs as `lineControlSpecs` takes them: the select gate's reason and note ride as `selectReason` / `selectNote`. */
export const controlArgs = (sheet) => { const { select, ...rest } = lineControlInputs(sheet); return { ...rest, selectReason: select.reason, selectNote: select.note }; };

/** `format` with `key` set to `value` — or without it when `value` is the default, so a default is never stored. */
export function withLineSetting(format, key, value) {
  const next = { ...format };
  if (value === DEFAULTS[key]) delete next[key]; else next[key] = value;
  return next;
}

/**
 * Append Line pattern / Line markers to `panel` (nothing for a chart that draws no lines). `fmtSelect` is the panel's select builder;
 * `replaceFormat(next)` commits a whole new format. A control that does nothing is disabled and says why (its title); a note rides the same way.
 * `keys` (optional) limits it to those controls: Format wires `["linePattern"]`, the Color flyout `["lineMarkers"]`; without it both are appended.
 */
export function wireLineControls(panel, sheet, fmtSelect, replaceFormat, keys) {
  for (const c of lineControlSpecs(controlArgs(sheet))) {
    if (keys && !keys.includes(c.key)) continue;
    const field = fmtSelect(c.label, c.choices, c.value, (v) => replaceFormat(withLineSetting(sheet.format ?? {}, c.key, v)));
    const select = field.querySelector("select");
    const hint = c.disabled ?? c.note;
    if (select && hint) { select.title = hint; select.setAttribute("aria-description", hint); field.title = hint; }
    if (select && c.disabled) select.disabled = true;
    for (const o of select?.options ? [...select.options] : []) { const why = c.disabledChoices?.[o.value]; if (why) { o.disabled = true; o.title = why; } } // a choice that could never work: disabled with its reason, the others stay usable
    panel.append(field);
  }
}
