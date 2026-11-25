import { test } from "node:test";
import assert from "node:assert/strict";
import { approxNotice, usesUnscaledAgg, UNSCALED_NOTE } from "../../src/DashboardBuilder/Features/Dashboard/speed-notice.js";

const plain = (agg) => ({ db: "s", table: "t", column: "c", agg });
test("the old text is byte-identical when no such measure is present", () => {
  assert.equal(approxNotice({ distinct: true, sample: 0.1 }, [plain("sum")]), "Approximate — distinct counts estimated; a 10% sample, scaled up");
  assert.equal(approxNotice({ distinct: false, sample: 0.1 }, []), "Approximate — a 10% sample, scaled up");
  assert.equal(approxNotice({ distinct: true, sample: null }, [plain("median")]), "Approximate — distinct counts estimated");
  assert.equal(approxNotice(undefined, [plain("median")]), null);
});
test("a sample plus a median / percentile / stddev / variance / ATTR measure appends the note", () => {
  for (const a of ["median", "stddev", "variance", "stddevPop", "variancePop", "attr"]) {
    assert.equal(approxNotice({ distinct: false, sample: 0.1 }, [plain("sum"), plain(a)]), `Approximate — a 10% sample, scaled up (${UNSCALED_NOTE})`);
  }
  const calc = { calc: { k: "bin", op: "+", l: { k: "num", v: 1 }, r: { k: "agg", fn: "percentile", arg: { k: "field" }, p: 0.5 } } };
  assert.ok(usesUnscaledAgg([calc]));
  assert.ok(!usesUnscaledAgg([{ calc: { k: "agg", fn: "sum", arg: { k: "field" } } }]));
});

test("an unscaled aggregate inside a text function call is found", () => {
  const calc = { k: "fn", fn: "lower", args: [{ k: "agg", fn: "attr", arg: { k: "field", db: "d", table: "t", column: "c" } }] };
  assert.equal(usesUnscaledAgg([{ calc }]), true);
});

test("unscaled aggregates in CASE arms and else are found; none means no caveat", () => {
  const med = { k: "agg", fn: "median", arg: { k: "field", db: "d", table: "t", column: "c" } };
  const sum = { ...med, fn: "sum" };
  const cond = { k: "cmp", op: ">", l: { k: "num", v: 1 }, r: { k: "num", v: 0 } };
  assert.equal(usesUnscaledAgg([{ calc: { k: "case", whens: [{ c: cond, t: med }], else: { k: "num", v: 0 } } }]), true);
  assert.equal(usesUnscaledAgg([{ calc: { k: "case", whens: [{ c: cond, t: { k: "num", v: 1 } }], else: med } }]), true);
  assert.equal(usesUnscaledAgg([{ calc: { k: "case", whens: [{ c: cond, t: sum }], else: { k: "num", v: 0 } } }]), false);
});
