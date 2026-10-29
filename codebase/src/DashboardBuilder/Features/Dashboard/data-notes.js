// Data notes for a worksheet's status bar and print header (pure): when the data was last queried and how the
// calculated fields it uses are defined.
import { pillSlots, isCalcPill } from "../Calc/calc-pill.js";

const MAX_FORMULA = 200;
const pad = (n) => String(n).padStart(2, "0");

/** "Updated 14:32:05" (local time) for a result's `queriedAt` (epoch ms), or null when there is none. */
export function updatedText(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return `Updated ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The calculations a sheet depends on — on any shelf or mark, in a Top-N filter, or referenced as `[Name]` by one
 *  of those — in the workbook's calculation order. */
export function usedCalculations(sheet, calcs) {
  const byId = new Map((calcs ?? []).map((c) => [c.id, c]));
  const byName = new Map((calcs ?? []).map((c) => [c.name, c]));
  const used = new Set();
  const add = (c) => {
    if (!c || used.has(c.id)) return;
    used.add(c.id);
    for (const m of c.formula.matchAll(/\[([^\]]+)\]/g)) add(byName.get(m[1]));
  };
  for (const f of pillSlots(sheet)) if (isCalcPill(f)) add(byId.get(f.calc));
  for (const f of sheet.filters ?? []) if (f?.op === "top" && f.topBy?.calc) add(byId.get(f.topBy.calc));
  return (calcs ?? []).filter((c) => used.has(c.id));
}

/** One "Name = formula" line per used calculation (long formulas cut). */
export function calcDefinitionLines(sheet, calcs) {
  return usedCalculations(sheet, calcs).map((c) => {
    const f = c.formula.replace(/\s+/g, " ").trim();
    return `${c.name} = ${f.length > MAX_FORMULA ? `${f.slice(0, MAX_FORMULA)}…` : f}`;
  });
}
