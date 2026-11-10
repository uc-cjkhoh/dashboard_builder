// A ClickHouse type as a plain kind for people (the raw type stays in a tooltip). Pure; tests/js/type-kind.test.mjs.
const unwrap = (t) => {
  let s = t.trim();
  for (;;) {
    const m = /^(Nullable|LowCardinality)\((.*)\)$/s.exec(s);
    if (!m) return s;
    s = m[2].trim();
  }
};

export function friendlyKind(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const base = /^[A-Za-z0-9_]+/.exec(unwrap(raw))?.[0] ?? "";
  if (base === "Bool" || base === "Boolean") return "true/false";
  if (/^U?Int\d+$/.test(base)) return "whole number";
  if (/^Float\d+$/.test(base) || base === "Decimal" || /^Decimal\d+$/.test(base)) return "number";
  if (base === "Date" || base === "Date32") return "date";
  if (base === "DateTime" || base === "DateTime64") return "date & time";
  if (["String", "FixedString", "UUID", "IPv4", "IPv6"].includes(base) || base.startsWith("Enum")) return "text";
  if (base === "Array") return "list";
  if (base === "Map") return "map";
  if (base === "Tuple") return "group";
  return raw;
}
