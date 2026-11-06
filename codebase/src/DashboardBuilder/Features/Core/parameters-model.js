// Parameters — pure, DOM-free (unit-tested in tests/js/parameters-model.test.mjs). A workbook holds up to
// 20 named, typed values: { id, name, type: number | text | date, value, allowed: { kind: any | list | range,
// list?, min?, max?, step? } }. A filter value or a top-N count can read one; Format → Top N can follow a
// number parameter; a calculated field reads one as [@Name] (Calc/calc-params.js). The value reaches ClickHouse only ever as a bound filter value / validated limit.
import { number, dateTime, text } from "./validate.js";

export const PARAM_TYPES = ["number", "text", "date"];
export const MAX_PARAMS = 20;
export const MAX_LIST = 50;

/** Check a raw value against a parameter's type and allowed values: { ok, value } or { ok: false, error }. */
export function checkValue(p, raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: `${p.name} needs a value.` };
  let v;
  if (p.type === "number") { const r = number(s); if (!r.ok) return { ok: false, error: `${p.name}: ${r.error}` }; v = r.value; }
  else if (p.type === "date") { const r = dateTime(s); if (!r.ok) return { ok: false, error: `${p.name}: ${r.error}` }; v = r.value; }
  else { const r = text(s, { label: p.name, max: 1000, required: true }); if (!r.ok) return r; v = r.value; }
  const a = p.allowed ?? { kind: "any" };
  if (a.kind === "list" && !(a.list ?? []).map(String).includes(String(v))) return { ok: false, error: `${p.name} must be one of its listed values.` };
  if (a.kind === "range" && p.type === "number") {
    if (a.min != null && v < a.min) return { ok: false, error: `${p.name} must be at least ${a.min}.` };
    if (a.max != null && v > a.max) return { ok: false, error: `${p.name} must be at most ${a.max}.` };
  }
  return { ok: true, value: v };
}

/** A parameter name: 1-60 characters, no `[` or `]` (a formula could not name it). { ok, value } or { ok: false, error }. */
export function checkParamName(raw) {
  const n = text(raw, { label: "Name", max: 60, required: true });
  if (!n.ok) return n;
  if (/[[\]]/.test(n.value)) return { ok: false, error: "Name can't contain '[' or ']'." };
  return n;
}

/** A step-size input: empty is no step; otherwise a positive finite number. { ok, value } or { ok: false, error }. */
export function checkStep(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, value: null };
  const r = number(s);
  if (!r.ok || !(r.value > 0)) return { ok: false, error: "Step must be a positive number." };
  return { ok: true, value: r.value };
}

/** The parameter types a filter on a field of `category` can read. */
export const paramTypeFor = (category) => (category === "numeric" ? "number" : category === "temporal" ? "date" : category === "text" ? "text" : null);

/** A filter with its parameter's current value filled in (unchanged without a parameter). */
export function withParamValue(f, params) {
  if (!f?.param) return f;
  const p = params.find((x) => x.id === f.param);
  return p ? { ...f, value: String(p.value) } : { ...f, value: "" }; // a missing parameter reads as empty (not applied)
}

/** Top-N for a chart: the number parameter's value when Format follows one (clamped to 1..cap), else topN. */
export function effectiveTopN(format, params, cap) {
  if (format?.topNParam) {
    const p = params.find((x) => x.id === format.topNParam && x.type === "number");
    const n = p ? Math.round(Number(p.value)) : NaN;
    if (Number.isFinite(n)) return Math.max(1, Math.min(cap, n));
  }
  return format?.topN ?? null;
}

/** A saved parameter, checked — or null (with an issue). */
export function cleanParameter(raw, issues) {
  const name = raw && typeof raw === "object" ? checkParamName(raw.name) : { ok: false };
  if (!name.ok || !/^prm\d{1,6}$/.test(raw.id ?? "") || !PARAM_TYPES.includes(raw.type)) { issues.push("Skipped a parameter with no name, id or type."); return null; }
  const a = raw.allowed && typeof raw.allowed === "object" ? raw.allowed : { kind: "any" };
  let allowed = { kind: "any" };
  if (a.kind === "list" && Array.isArray(a.list) && a.list.length) {
    const list = a.list.slice(0, MAX_LIST).map(String).filter((x) => checkValue({ name: name.value, type: raw.type }, x).ok);
    if (list.length) allowed = { kind: "list", list };
  } else if (a.kind === "range" && raw.type === "number") {
    const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const step = n(a.step);
    allowed = { kind: "range", min: n(a.min), max: n(a.max), step: step !== null && step > 0 ? step : null };
  }
  const p = { id: raw.id, name: name.value, type: raw.type, allowed, value: null };
  const v = checkValue(p, raw.value);
  p.value = v.ok ? v.value : allowed.kind === "list" ? allowed.list[0] : raw.type === "number" ? (allowed.min ?? 0) : "";
  if (!v.ok) issues.push(`Parameter "${name.value}": its value was invalid — reset.`);
  return p;
}

/** What reads the parameter `id`: a list of plain phrases ("Sheet 1: a filter on region"), for the delete confirmation. `sheets` = [{ name, sheet }]. */
export function paramRefs(sheets, shared, id) {
  const out = [];
  for (const { name, sheet } of sheets) {
    const w = `${name}: `;
    for (const f of sheet?.filters ?? []) if (f.param === id) out.push(`${w}a filter on ${f.column ?? "a field"}`);
    if (sheet?.format?.topNParam === id) out.push(`${w}Top N`);
    if (sheet?.analytics?.ref?.param === id) out.push(`${w}the reference line`);
    for (const k of ["fromParam", "toParam"]) if (sheet?.analytics?.band?.[k] === id) out.push(`${w}the band's ${k === "fromParam" ? "from" : "to"} end`);
    if (sheet?.paramAction?.param === id) out.push(`${w}the parameter action`);
  }
  for (const f of shared ?? []) if (f.param === id) out.push(`a shared filter on ${f.column ?? "a field"}`);
  return out;
}

/** Clear every reference a worksheet holds to the parameter `id` (a filter, Top N, reference line, band end, parameter action); true when anything changed.
 *  Ids are reused after a save and reopen, so a stale one would bind to an unrelated new parameter. Mutates `sheet`. */
export function dropParamRefs(sheet, id) {
  let changed = false;
  const drop = (o, k) => { if (o && o[k] === id) { delete o[k]; changed = true; } };
  for (const f of sheet?.filters ?? []) drop(f, "param");
  drop(sheet?.format, "topNParam");
  drop(sheet?.analytics?.ref, "param");
  drop(sheet?.analytics?.band, "fromParam");
  drop(sheet?.analytics?.band, "toParam");
  if (sheet?.paramAction?.param === id) { sheet.paramAction = null; changed = true; }
  return changed;
}
