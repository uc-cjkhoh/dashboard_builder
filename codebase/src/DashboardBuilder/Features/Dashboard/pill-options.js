// Dashboard/pill-options.js — which options a pill offers in its context popup, and the Marks slot grid (pure, DOM-free).
// An entry is { id, type: "radio" | "check" | "item" | "custom" | "sep", label, checked?, disabled? }; dashboards.js maps an id to its action.

/** Drop leading, trailing and doubled separators. */
function tidy(list) {
  const out = [];
  for (const e of list) { if (e.type === "sep" && (!out.length || out.at(-1).type === "sep")) continue; out.push(e); }
  while (out.at(-1)?.type === "sep") out.pop();
  return out;
}
const sep = { type: "sep" };

/** A Columns / Rows field pill. `aggs` null = nothing to aggregate with; `roleFlip` = may switch dimension <-> measure. */
export function fieldPillOptions({ measure, aggs, agg, roleFlip, numeric, tableCalc, temporal, parts = [], part, finer, coarser, dateLabelsAll, choicesOk }) {
  const r = [];
  if (measure && aggs) for (const a of aggs) r.push({ id: `agg:${a}`, type: "radio", label: a === "percentile" ? "Percentile…" : a, checked: (agg ?? aggs[0]) === a });
  if (measure && aggs && agg === "percentile") r.push({ id: "percent", type: "custom" });
  if (roleFlip && numeric) r.push(sep, { id: "dc:continuous", type: "radio", label: "Continuous", checked: Boolean(measure) }, { id: "dc:discrete", type: "radio", label: "Discrete", checked: !measure });
  else if (roleFlip) r.push(sep, { id: "role", type: "item", label: measure ? "Use as dimension" : "Use as measure" });
  if (measure) r.push(sep, { id: "tablecalc", type: "check", label: "Table calculation…", checked: Boolean(tableCalc) });
  if (temporal && !measure) {
    r.push(sep);
    for (const [v, label] of parts) r.push({ id: `part:${v}`, type: "radio", label, checked: (part ?? "auto") === v });
    r.push(sep, { id: "finer", type: "item", label: "Finer", disabled: !finer }, { id: "coarser", type: "item", label: "Coarser", disabled: !coarser },
      sep, { id: "labels", type: "check", label: "Show all date labels", checked: Boolean(dateLabelsAll) });
  }
  if (choicesOk) r.push(sep, { id: "choices", type: "item", label: "Field choices…" });
  return tidy(r);
}

/** A filter pill: operator, shared across dashboards, and the value editor (a custom row). */
export function filterPillOptions({ ops, op, shared, canShare = true }) {
  return [...ops.map(([v, label]) => ({ id: `op:${v}`, type: "radio", label, checked: v === op })),
    sep, ...(canShare ? [{ id: "share", type: "check", label: "Apply on every dashboard", checked: Boolean(shared) }, sep] : []),
    { id: "value", type: "custom" }].filter((e, i, a) => !(e.type === "sep" && a[i + 1]?.type === "sep"));
}

/** The Marks slots as rows of `cols` (the last row padded with null). */
export function markGrid(slots, cols = 3) {
  const rows = [];
  for (let i = 0; i < slots.length; i += cols) { const row = slots.slice(i, i + cols); while (row.length < cols) row.push(null); rows.push(row); }
  return rows;
}

/** The operand of a filter, short enough to sit in its pill ("" when none is set yet). */
export function filterSummary(f) {
  if (f.param) return "parameter";
  if (f.op === "in" || f.op === "notin") return f.values?.length ? String(f.values.length) : "";
  if (f.op === "between") return f.values?.some((v) => String(v ?? "").trim()) ? `${f.values[0] ?? ""} – ${f.values[1] ?? ""}` : "";
  if (f.op === "top") return String(f.value ?? "");
  return String(f.value ?? "");
}
