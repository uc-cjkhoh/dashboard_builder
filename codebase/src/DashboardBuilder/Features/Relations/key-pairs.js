// Pure rules for a compound join key (no DOM): the extra column pairs beside a relationship's first, and which pairs to
// suggest. Unit-tested in tests/js/key-pairs.test.mjs. A pair is { from, to }: a column of the first table and one of the second.
import { keysCompatible } from "./relation-rules.js";

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
