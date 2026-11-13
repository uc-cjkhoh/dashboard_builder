// The Format panel's Line pattern and Line markers controls: what each shows comes from the pure `lineControlSpecs` (line-style-model.js), so the
// panel and the drawing agree on when a control does something; this file reads the worksheet into those inputs and puts the controls on the panel.
import { planMeasures, colorMode } from "./sheet-plan.js";
import { lineControlSpecs } from "./line-style-model.js";

const DEFAULTS = { linePattern: "solid", lineMarkers: "auto" }; // not stored: absent reads as the default, so older files round-trip unchanged

// The points the sheet's line chart last drew (series x categories): the Format panel needs it for the same Size rule the drawing applies (a straight line over
// LINE_WIDTH_MAX_POINTS draws Size as marker size, not thickness). The drawing records it per sheet object; a sheet never drawn counts as within the bound.
const drawnPoints = new WeakMap();
/** Record how many points `sheet`'s line chart drew (called by the cartesian render path). */
export const noteLinePoints = (sheet, points) => { if (sheet && typeof sheet === "object") drawnPoints.set(sheet, points); };

/** The worksheet as `lineControlSpecs` wants it: shelf measures (a colour / Size / Label measure is not one), a colour *measure*, a Size field. */
export const lineControlInputs = (sheet) => ({
  type: sheet.chartType,
  format: sheet.format ?? {},
  shelfCount: planMeasures(sheet).filter((e) => e.role === "shelf").length,
  colourMeasure: colorMode(sheet) === "continuous",
  hasSize: Boolean(sheet.marks?.size), // a Size field is set (the panel's view); the drawing also needs its values, which a drawn chart has whenever the field is valid
  points: drawnPoints.get(sheet) ?? 0,
});

/** `format` with `key` set to `value` — or without it when `value` is the default, so a default is never stored. */
export function withLineSetting(format, key, value) {
  const next = { ...format };
  if (value === DEFAULTS[key]) delete next[key]; else next[key] = value;
  return next;
}

/**
 * Append Line pattern / Line markers to `panel` (nothing for a chart that draws no lines). `fmtSelect` is the panel's select builder;
 * `replaceFormat(next)` commits a whole new format. A control that does nothing is disabled and says why (its title); a note rides the same way.
 */
export function wireLineControls(panel, sheet, fmtSelect, replaceFormat) {
  for (const c of lineControlSpecs(lineControlInputs(sheet))) {
    const field = fmtSelect(c.label, c.choices, c.value, (v) => replaceFormat(withLineSetting(sheet.format ?? {}, c.key, v)));
    const select = field.querySelector("select");
    const hint = c.disabled ?? c.note;
    if (select && hint) { select.title = hint; select.setAttribute("aria-description", hint); field.title = hint; }
    if (select && c.disabled) select.disabled = true;
    panel.append(field);
  }
}
