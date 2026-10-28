// Live spikes: can ClickHouse run the SQL shapes the calculated-field compiler will emit?
// SELECT only, inline sources. Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

async function query(sql, params = {}) {
  const qs = new URLSearchParams({ default_format: 'JSON', readonly: '2' });
  for (const [k, v] of Object.entries(params)) qs.set(`param_${k}`, String(v));
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, {
    method: 'POST', headers: { Authorization: auth }, body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return { text, json: JSON.parse(text) };
}

// ---- S1: bound parameter inside a GROUP BY select expression
{
  const src = 'FROM (SELECT arrayJoin([toUInt32(1), 2, 2]) AS q)';
  const forms = {
    alias: `SELECT toFloat64(q) * {c0p0:Float64} AS k0, count() AS v0 ${src} GROUP BY k0 ORDER BY k0`,
    expression: `SELECT toFloat64(q) * {c0p0:Float64} AS k0, count() AS v0 ${src} GROUP BY toFloat64(q) * {c0p0:Float64} ORDER BY k0`,
  };
  const worked = [];
  for (const [name, sql] of Object.entries(forms)) {
    try {
      const { json } = await query(sql, { c0p0: 10 });
      assert.deepEqual(json.data.map(r => [Number(r.k0), Number(r.v0)]), [[10, 1], [20, 2]]);
      worked.push(name);
    } catch (e) { console.log(`S1 form "${name}" failed: ${e.message}`); }
  }
  console.log(`S1 forms that work: ${worked.join(', ') || 'none'}`);
  assert.ok(worked.includes('alias'), 'S1: GROUP BY alias form must work');
  console.log('ok S1');
}

// ---- S2: toFloat64 over Nullable(Float64), Decimal(18,2), UInt32
{
  const { json } = await query(`SELECT
      toFloat64(toUInt32(2)) - toFloat64(toDecimal64(10, 2)) AS diff,
      toFloat64(CAST(NULL AS Nullable(Float64))) AS nf,
      toFloat64(CAST(NULL AS Nullable(Decimal(18, 2)))) AS nd,
      toFloat64(CAST(NULL AS Nullable(Float64))) + toFloat64(toUInt32(1)) AS nadd,
      toFloat64(toUInt32(1)) * toFloat64(CAST(NULL AS Nullable(Decimal(18, 2)))) AS nmul`);
  const r = json.data[0];
  assert.equal(Number(r.diff), -8);
  assert.equal(r.nf, null);
  assert.equal(r.nd, null);
  assert.equal(r.nadd, null);
  assert.equal(r.nmul, null);
  console.log('ok S2');
}

// ---- S3: division by zero -> JSON null with nullIf
{
  const src = 'FROM (SELECT arrayJoin([toUInt32(1), 2, 3]) AS x, toUInt32(0) AS y)';
  const withNullIf = await query(`SELECT sum(toFloat64(x)) / nullIf(sum(toFloat64(y)), 0) AS r ${src}`);
  assert.ok(/"r":\s*null/.test(withNullIf.text), `S3: expected JSON null, got ${withNullIf.text}`);
  assert.equal(withNullIf.json.data[0].r, null);
  const without = await query(`SELECT sum(toFloat64(x)) / sum(toFloat64(y)) AS r ${src}`);
  console.log(`S3 (info) without nullIf: ${JSON.stringify(without.json.data[0].r)} (raw: ${without.text.match(/"r":\s*[^\s,}]+/)?.[0]})`);
  console.log('ok S3');
}
