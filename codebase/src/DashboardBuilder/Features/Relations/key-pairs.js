// Pure rules for a compound join key (no DOM): the extra column pairs beside a relationship's first, and which pairs to
// suggest. Unit-tested in tests/js/key-pairs.test.mjs. A pair is { from, to }: a column of the first table and one of the second.
import { keysCompatible, isOwnKey, singular } from "./relation-rules.js";

/** Extra pairs beside the first (server ApiLimits.MaxJoinPairs is 4 in all; mirrored in Core/validate.js LIMITS.joinExtraPairs). */
export const MAX_EXTRA_PAIRS = 3;

const norm = (name) => name.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Column pairs that probably mean the same thing: the same name (exactly, else ignoring case and `_` `-` spaces) and a joinable kind.
 * `fromCols` / `toCols` are `[{ name, category }]`; `used` is `{ from: [names], to: [names] }` (columns already in a relationship, the first pair included).
 * Each column is offered once. Exact names come first, then column order. At most `limit` pairs.
 */
export function suggestPairs(fromCols, toCols, used = {}, limit = MAX_EXTRA_PAIRS) {
  const usedFrom = new Set(used.from ?? []), usedTo = new Set(used.to ?? []);
  const free = (cols, set) => cols.filter((c) => !set.has(c.name));
  const out = [], takenFrom = new Set(), takenTo = new Set();
  const pass = (exact) => {
    for (const f of free(fromCols, usedFrom)) {
      if (takenFrom.has(f.name)) continue;
      const t = free(toCols, usedTo).find((c) => !takenTo.has(c.name) && keysCompatible(f.category, c.category) && (exact ? c.name === f.name : norm(c.name) === norm(f.name)));
      if (!t) continue;
      takenFrom.add(f.name); takenTo.add(t.name);
      out.push({ from: f.name, to: t.name, exact: f.name === t.name });
    }
  };
  pass(true); pass(false);
  return out.slice(0, Math.max(0, limit));
}

/**
 * Add one pair to `pairs`: { ok: true, pairs } or { ok: false, problem }. `ctx` is `{ fromCols, toCols, used: { from, to } }`
 * (`used` = columns already in a relationship, the first pair included; `pairs` themselves are checked here).
 */
export function addPair(pairs, from, to, ctx) {
  if (!from || !to) return { ok: false, problem: "Pick a column from each table." };
  if (pairs.length >= MAX_EXTRA_PAIRS) return { ok: false, problem: `A relationship can match on at most ${MAX_EXTRA_PAIRS + 1} column pairs.` };
  const inUse = (side, name) => (ctx.used?.[side] ?? []).includes(name) || pairs.some((p) => p[side] === name);
  for (const [side, name] of [["from", from], ["to", to]]) {
    if ((ctx.used?.[side] ?? []).includes(name)) return { ok: false, problem: `${name} is already in a relationship. A column can be in only one.` };
    if (inUse(side, name)) return { ok: false, problem: `${name} is already matched.` };
  }
  const a = ctx.fromCols.find((c) => c.name === from), b = ctx.toCols.find((c) => c.name === to);
  if (!a || !b || !keysCompatible(a.category, b.category)) return { ok: false, problem: `${from} and ${to} aren't the same kind of value, so they can't be matched.` };
  return { ok: true, pairs: [...pairs, { from, to }] };
}

export const pairText = (p) => `${p.from} = ${p.to}`;

/** The key's column list in words for one side ("id + region"); `side` is "from" or "to". */
export const compoundName = (first, pairs = [], side = "from") => [first, ...pairs.map((p) => p[side])].join(" + ");

/**
 * While relating from `source` ({ name, category }): the one column of another table (`cols`, `[{ name, category }]`) that most likely
 * means the same thing — the same name (exactly, else ignoring case and `_` `-` spaces) and a joinable kind, not already in a
 * relationship (`used`: names). An exact name wins; null when nothing matches. It only highlights; the user still chooses.
 */
export function suggestTarget(source, cols, used = []) {
  const taken = new Set(used);
  const ok = (c) => !taken.has(c.name) && keysCompatible(source.category, c.category);
  return (cols.find((c) => ok(c) && c.name === source.name) ?? cols.find((c) => ok(c) && norm(c.name) === norm(source.name)))?.name ?? null;
}

// --- relating two tables at once (D127): the key the names point to -------------------------------------------------------------
/** A column name that reads as a key: ends in id / key / code / no / num (customer_id, StoreKey, sku_code). */
export const isKeyish = (name) => /(^|[_\s-])(id|key|code|no|num)$/i.test(String(name)) || /[a-z0-9](Id|ID|Key|Code|No|Num)$/.test(String(name));
const generic = (name) => ["id", "key"].includes(String(name).toLowerCase()); // every table has one: orders.id = customers.id is no key

/**
 * The key two tables most likely join on, read from their column names, or null. `a` / `b` are `{ table, columns: [{ name, category }] }`;
 * `used` is `{ from: [names of a], to: [names of b] }`, columns already in a relationship. Returns `{ first: { from, to }, pairs, score, confident }`:
 * - a foreign key to the other table's own key (orders.customer_id → customers.id, either way round) is the first pair, score 3;
 * - else every same-named key column (store_id = store_id, sku = sku; not a bare id / key) makes the key: the first, then up to three more pairs, score 2;
 * - else the first same-named, same-kind column of any name (suggestPairs), score 1, not confident.
 * Only a confident proposal is offered on the canvas; any one may open the dialog, where the user still decides.
 */
export function proposeKey(a, b, used = {}) {
  const uf = new Set(used.from ?? []), ut = new Set(used.to ?? []);
  const freeA = (a.columns ?? []).filter((c) => !uf.has(c.name)), freeB = (b.columns ?? []).filter((c) => !ut.has(c.name));
  const fk = (cols, other, keys) => {
    const names = new Set([other, singular(other)].filter(Boolean).flatMap((n) => [`${n}_id`, `${n}id`, `${n}_key`].map(norm)));
    for (const c of cols) {
      if (!names.has(norm(c.name))) continue;
      const k = keys.find((x) => isOwnKey(x.name, other) && keysCompatible(c.category, x.category));
      if (k) return [c.name, k.name];
    }
    return null;
  };
  const ab = fk(freeA, String(b.table ?? "").toLowerCase(), freeB);
  if (ab) return { first: { from: ab[0], to: ab[1] }, pairs: [], score: 3, confident: true };
  const ba = fk(freeB, String(a.table ?? "").toLowerCase(), freeA);
  if (ba) return { first: { from: ba[1], to: ba[0] }, pairs: [], score: 3, confident: true };
  const all = suggestPairs(freeA, freeB, {}, Infinity);
  const keys = all.filter((p) => p.exact && isKeyish(p.from) && !generic(p.from));
  if (keys.length) return { first: { from: keys[0].from, to: keys[0].to }, pairs: keys.slice(1, 1 + MAX_EXTRA_PAIRS).map(({ from, to }) => ({ from, to })), score: 2, confident: true };
  const loose = all.find((p) => !generic(p.from));
  return loose ? { first: { from: loose.from, to: loose.to }, pairs: [], score: 1, confident: false } : null;
}

export const keyText = (k) => [k.first, ...k.pairs].map(pairText).join(", ");
