// The Format panel's tooltip controls (Show tooltips, Command buttons, Tooltip mode): what each shows, and why one is disabled, comes from the pure
// `tooltipControlSpecs` (tooltip-behaviour-model.js), so the panel and the drawing agree on when a control does something.
import { tooltipControlSpecs, buttonGate, buttonNote, gateInputs, withTooltipSetting } from "./tooltip-behaviour-model.js";

/**
 * Append the controls to `panel` (nothing for a chart with no hover tooltip). `fmtCheck` / `fmtSelect` are the panel's builders; `replaceFormat(next)` commits a
 * whole new format. A control that does nothing here is disabled and says why (its title).
 */
export function wireTooltipControls(panel, sheet, { fmtCheck, fmtSelect }, replaceFormat) {
  const format = sheet.format ?? {};
  const inputs = gateInputs(sheet);
  for (const c of tooltipControlSpecs({ type: sheet.chartType, format, gate: buttonGate(inputs), note: buttonNote(inputs) })) {
    const set = (v) => replaceFormat(withTooltipSetting(sheet.format ?? {}, c.key, v));
    const field = c.kind === "check" ? fmtCheck(c.label, c.value, set) : fmtSelect(c.label, c.choices, c.value, set);
    const control = field.querySelector("input, select");
    if (control && c.note) { control.title = c.note; control.setAttribute("aria-description", c.note); field.title = c.note; }
    if (control && c.disabled) { control.disabled = true; control.title = c.disabled; control.setAttribute("aria-description", c.disabled); field.title = c.disabled; }
    panel.append(field);
  }
}
