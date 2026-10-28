// Line styles (T03-05) — pure, DOM-free (tests/js/charts1.test.mjs). Format → Line style on a line, area
// or combo chart: Straight (point to point), Step (each value holds until the next category, then
// changes) or Step (centred) (the value changes half-way between two categories). The stored key stays "jump".
import { LINE_STYLES } from "../Core/sheet-schema.js";

export const LINE_STYLE_CHOICES = [["straight", "Straight"], ["step", "Step"], ["jump", "Step (centred)"]];
const STEPS = { step: "end", jump: "middle" }; // ECharts `step` values

/** ECharts' `step` setting for a style: false (straight, unset or unknown) or "end" / "middle". */
export const lineStep = (style) => (LINE_STYLES.has(style) ? STEPS[style] ?? false : false);

/** The chart types that draw lines and so offer Line style. */
export const linesTakeStyle = (type) => type === "line" || type === "area" || type === "combo";
