// Several fields on Colour — pure, DOM-free (tests/js/colour-fields.test.mjs). The Colour slot holds either ONE measure (a continuous colour) or
// up to COLOUR_FIELDS_MAX categorical fields; with several, a mark's colour is its COMBINATION of members ("EU · web"), each combination its own
// colour, legend entry and member colour. The fields are group-by keys at the end of the query (sheet-plan.js `planDims`), last field last.
import { LIMITS } from "../Core/validate.js";

export const COLOUR_FIELDS_MAX = LIMITS.colourFields;
/** Chart types whose marks split by every Colour field (a Gantt and a Table read the first only). */
export const MULTI_COLOUR_TYPES = new Set(["bar", "stacked", "line", "area", "pie", "donut", "scatter", "square", "circle"]);

const isNumeric = (f) => Boolean(f) && f.category === "numeric";
const isCalc = (f) => Boolean(f) && typeof f.calc === "string"; // a calculated-field pill (Calc/calc-pill.js; not imported here to keep this module cycle-free)
const sameField = (a, b) => (isCalc(a) || isCalc(b) ? isCalc(a) && isCalc(b) && a.calc === b.calc : a.db === b.db && a.table === b.table && a.column === b.column);
const nameOf = (f) => (isCalc(f) ? f.column : `${f.table}.${f.column}`);

/** The categorical fields of a Colour list: none when the first is a measure (a continuous colour). */
export const colourDimensions = (list) => { const l = list ?? []; return l.length && !isNumeric(l[0]) ? l.filter((f) => !isNumeric(f)) : []; };

/** The Colour list after dropping `f` on it: a measure replaces everything; a dimension joins the dimensions (it replaces a measure); a repeat or one past the cap is refused. -> { ok, list } | { ok: false, error } */
export function addColourField(list, f) {
  const cur = list ?? [];
  if (isNumeric(f)) return { ok: true, list: [f] };
  const dims = colourDimensions(cur);
  if (!dims.length) return { ok: true, list: [f] };
  if (dims.some((d) => sameField(d, f))) return { ok: false, error: `${nameOf(f)} is already on Colour.` };
  if (dims.length >= COLOUR_FIELDS_MAX) return { ok: false, error: `Colour can hold at most ${COLOUR_FIELDS_MAX} fields — remove one first.` };
  return { ok: true, list: [...dims, f] };
}

/** A combined member's name: its members' names joined with " · " (a missing member reads "—"). */
export const memberText = (names) => names.map((n) => (n == null ? "—" : String(n))).join(" · ");
/** A combined member's storage identity: the raw values as a JSON array, so a name that itself holds " · " cannot collide with another combination. */
export const memberRaw = (raws) => JSON.stringify(raws.map((r) => (r == null ? null : String(r))));
/** The pseudo-field a combined Colour is keyed by (Format → member colours): `fieldColorKey` encodes its fields in order. */
export const combinedField = (fields) => ({ combined: fields });

/** The field Format → member colours is keyed by for these Colour fields: null for none or a calculated field (unsupported), the field itself for one, the combination for several. */
export const memberColourField = (fields) => (!fields.length || fields.some(isCalc) ? null : fields.length === 1 ? fields[0] : combinedField(fields));

/** A saved Colour list cleaned for import -> { list, issues }: a leading measure keeps only itself; otherwise the categorical fields, no repeats, at most the cap — what is dropped is reported. */
export function cleanColourList(list) {
  const cur = list ?? [];
  const issues = [];
  if (!cur.length) return { list: [], issues };
  if (isNumeric(cur[0])) {
    if (cur.length > 1) issues.push("Colour keeps its measure; the other Colour fields were dropped.");
    return { list: [cur[0]], issues };
  }
  const out = [];
  let mixed = 0, repeats = 0, over = 0;
  for (const f of cur) {
    if (isNumeric(f)) mixed++;
    else if (out.some((d) => sameField(d, f))) repeats++;
    else if (out.length >= COLOUR_FIELDS_MAX) over++;
    else out.push(f);
  }
  if (mixed) issues.push("A measure can't share Colour with fields — it was dropped.");
  if (repeats) issues.push("A repeated Colour field was dropped.");
  if (over) issues.push(`Colour holds at most ${COLOUR_FIELDS_MAX} fields — the rest were dropped.`);
  return { list: out, issues };
}
