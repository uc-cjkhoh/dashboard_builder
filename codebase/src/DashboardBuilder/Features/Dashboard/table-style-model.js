// Table look (T01-23) — pure, DOM-free (tests/js/table-style.test.mjs). Format → Align, Row height and Shading on a
// table / text worksheet. Every choice is a CSS class on the table; the values come from the design tokens in
// dashboard.css (spacing 4 / 8 / 16, --surface-2), so nothing here is a free size or colour.
import { TABLE_ALIGNS, TABLE_DENSITIES, TABLE_SHADES } from "../Core/sheet-schema.js";

export const TABLE_ALIGN_CHOICES = [["auto", "Auto"], ["left", "Left"], ["center", "Centre"], ["right", "Right"]];
export const TABLE_DENSITY_CHOICES = [["standard", "Standard"], ["compact", "Compact"], ["roomy", "Roomy"]];
export const TABLE_SHADE_CHOICES = [["none", "None"], ["banded", "Banded rows"], ["header", "Header"], ["both", "Both"]];

/** The classes a table takes for a sheet's format; none at the defaults, so an untouched table is unchanged. */
export function tableStyleClasses(format) {
  const f = format ?? {};
  const out = [];
  if (f.tableAlign !== "auto" && TABLE_ALIGNS.has(f.tableAlign)) out.push(`xt-a-${f.tableAlign}`);
  if (f.tableDensity !== "standard" && TABLE_DENSITIES.has(f.tableDensity)) out.push(`xt-d-${f.tableDensity}`);
  if (TABLE_SHADES.has(f.tableShade) && f.tableShade !== "none") {
    if (f.tableShade !== "header") out.push("xt-s-banded");
    if (f.tableShade !== "banded") out.push("xt-s-header");
  }
  return out;
}
