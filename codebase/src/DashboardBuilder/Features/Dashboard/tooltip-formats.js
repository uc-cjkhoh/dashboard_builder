// Per-field formats for the tooltip template (tooltip modal) — pure, DOM-free (unit-tested under tests/js/).
// A sheet's `tooltipFormats` is null or { [field name]: { number?, decimals?, date? } }: `number` / `decimals` format a measure
// value, `date` a date group-by value. They reuse the worksheet Format code (Core/format.js); absent = the view's own formats.
import { LIMITS } from "../Core/validate.js";
import { NUMBER_FORMATS, DATE_FORMATS, MAX_DECIMALS } from "../Core/sheet-schema.js";
import { makeValueFormatter, makeCategoryFormatter } from "../Core/format.js";

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const TIP_NUMBER_FORMATS = [...NUMBER_FORMATS];
export const TIP_DATE_FORMATS = [...DATE_FORMATS].filter((d) => d !== "auto");
export const MAX_FIELD_NAME = 200;

/** Validate a stored spec → { ok, value } (value null when nothing is formatted; defaults and empty entries are dropped). Never clamps. */
export function checkTooltipFormats(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Tooltip formats must be an object." };
  const out = {};
  let n = 0;
  for (const name of Object.keys(raw)) {
    if (!name || name.length > MAX_FIELD_NAME || name === "__proto__") return { ok: false, error: "A tooltip format names a field of 1 to 200 characters." };
    const e = raw[name];
    if (e == null) continue;
    if (typeof e !== "object" || Array.isArray(e)) return { ok: false, error: "Each tooltip field format must be an object." };
    for (const k of Object.keys(e)) if (!["number", "decimals", "date"].includes(k)) return { ok: false, error: `Unknown tooltip field format "${k}".` };
    const s = {};
    if (e.number != null) { if (typeof e.number !== "string" || !NUMBER_FORMATS.has(e.number)) return { ok: false, error: "Tooltip number format must be Auto, Compact, Currency or Percent." }; s.number = e.number; }
    if (e.decimals != null) { if (!Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > MAX_DECIMALS) return { ok: false, error: `Tooltip decimals must be a whole number from 0 to ${MAX_DECIMALS}.` }; s.decimals = e.decimals; }
    if (e.date != null) { if (typeof e.date !== "string" || !DATE_FORMATS.has(e.date)) return { ok: false, error: "Tooltip date format must be Date, Date and time, Month or Year." }; if (e.date !== "auto") s.date = e.date; }
    if (s.number === "auto" && s.decimals == null) delete s.number;
    if (!Object.keys(s).length) continue;
    if (++n > LIMITS.tooltipFormats) return { ok: false, error: `Tooltip formats cover at most ${LIMITS.tooltipFormats} fields.` };
    out[name] = s;
  }
  return { ok: true, value: n ? out : null };
}

/** Keep only the entries of fields the template uses (a draft's stale entries fall away). */
export const pruneFormats = (formats, fields) => {
  if (!formats) return null;
  const out = {};
  for (const f of fields) if (has(formats, f)) out[f] = formats[f];
  return Object.keys(out).length ? out : null;
};

/** A date group-by sample worth offering a date format for (a ClickHouse Date / DateTime value). */
export const looksDate = (s) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(String(s ?? ""));

/** The tooltip's name → text lookup. `measures`: { name: raw number | ready text }, `dims`: Map name → value text,
 *  `formats`: the sheet's tooltipFormats, `fmtVal(raw)`: the view's value formatter, `format`: the view's Format config
 *  (an override starts from it, so a currency symbol or suffix still applies). */
export function tipLookup({ measures, dims, formats, fmtVal, format = {} }) {
  const cache = new Map();
  const numFmt = (name) => {
    const f = formats && has(formats, name) ? formats[name] : null;
    if (!f || (f.number == null && f.decimals == null)) return fmtVal;
    if (!cache.has(name)) cache.set(name, makeValueFormatter({ ...format, numberFormat: f.number ?? format.numberFormat, decimals: f.decimals ?? format.decimals }));
    return cache.get(name);
  };
  return (name) => {
    if (has(measures, name)) { const v = measures[name]; return typeof v === "number" || v == null ? numFmt(name)(v) : v; }
    if (!dims.has(name)) return undefined;
    const v = dims.get(name);
    const d = formats && has(formats, name) ? formats[name].date : null;
    return d && v != null ? makeCategoryFormatter({ dateFormat: d })(String(v)) : v;
  };
}

/** The editors' sample lookup over the catalog ([{ name, sample, kind, raw? }] from tooltipCatalog): a measure with a per-field format
 *  is formatted from its raw first-mark value, otherwise it shows the view's already formatted sample text. */
export function sampleLookup(catalog, formats, format = {}) {
  const measures = {};
  const dims = new Map();
  for (const f of catalog ?? []) {
    if (f.kind === "measure") measures[f.name] = formats && has(formats, f.name) && typeof f.raw === "number" ? f.raw : f.sample;
    else dims.set(f.name, f.sample);
  }
  return tipLookup({ measures, dims, formats, fmtVal: (v) => String(v), format });
}
