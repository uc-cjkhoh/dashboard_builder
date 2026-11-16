// A card column's type label: the ClickHouse type as it is, minus LowCardinality(…) wrappers — a storage encoding,
// not the data type, and its long name would push the real type past the label's ellipsis. The full type stays the
// tooltip. Pure; tests/js/column-type.test.mjs.
export function cardType(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  for (let i = s.indexOf("LowCardinality("); i >= 0; i = s.indexOf("LowCardinality(")) {
    const open = i + "LowCardinality(".length;
    let depth = 1, j = open;
    for (; j < s.length && depth > 0; j++) { if (s[j] === "(") depth++; else if (s[j] === ")") depth--; }
    if (depth !== 0) return raw.trim(); // unbalanced: show it as it came
    s = s.slice(0, i) + s.slice(open, j - 1).trim() + s.slice(j);
  }
  return s;
}
