// Instant syntax checks for a card's custom SQL (pure, no DOM): the editor underlines these as you type, before anything is sent. It mirrors
// the server's guard (ClickHouse/CustomSql.cs — keep the two in step, like validate.js and RequestValidation.cs), so a text that passes here is
// not refused by the guard for a rule listed here; the server still checks everything and says what ClickHouse itself objects to.
import { LIMITS } from "./validate.js";

/** Table functions the server refuses (they read outside ClickHouse's own tables): CustomSql.BlockedFunctions. */
export const BLOCKED_FUNCTIONS = new Set([
  "url", "urlcluster", "file", "filecluster", "s3", "s3cluster", "hdfs", "hdfscluster", "remote", "remotesecure",
  "cluster", "clusterallreplicas", "mysql", "postgresql", "mongodb", "redis", "jdbc", "odbc", "sqlite", "executable",
  "input", "azureblobstorage", "azureblobstoragecluster", "deltalake", "iceberg", "hudi", "gcs", "oss", "cosn",
]);

/** The only table functions allowed where a table goes (after FROM / JOIN, or a comma in a FROM list): CustomSql.AllowedTableFunctions. */
export const ALLOWED_TABLE_FUNCTIONS = new Set([
  "numbers", "numbers_mt", "zeros", "zeros_mt", "generate_series", "generateseries", "generaterandom", "values", "view", "merge", "null",
]);
const SORT_WORDS = new Set(["asc", "desc", "ascending", "descending", "nulls", "collate", "with"]);
// Clause words that end a FROM list at its depth: CustomSql.EndsFrom.
const ENDS_FROM = new Set(["where", "prewhere", "group", "having", "order", "limit", "union", "except", "intersect", "window", "qualify", "on", "using",
  "array", "sample", "final", "offset", "select", "with"]);

/** The name a word or a quoted name (` or ") stands for, quotes and escapes undone; null for anything else. */
export function nameOf(t) {
  if (!t) return null;
  if (t.kind === "word") return t.value;
  if (t.kind !== "quoted" || t.value[0] === "'" || t.open) return null;
  const q = t.value[0], v = t.value;
  let out = "";
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] === "\\" && i + 1 < v.length - 1) { out += v[++i]; continue; }
    if (v[i] === q && v[i + 1] === q) { out += q; i++; continue; }
    out += v[i];
  }
  return out;
}
const isWord = (t, w) => t?.kind === "word" && t.value.toLowerCase() === w;
const isSym = (t, c) => t?.kind === "symbol" && t.value === c;

/**
 * Cut `text` into tokens with their offsets: words, numbers, symbols, quoted runs, and the comments (kept, so a problem can sit on one).
 * An unterminated quote or block comment ends at the end of the text and carries `open: true`.
 * @returns {{ kind: "word"|"number"|"symbol"|"quoted"|"comment", from: number, to: number, value: string, open?: boolean }[]}
 */
export function tokenize(text) {
  const out = [];
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"' || c === "`") { // a repeated quote inside the run, or a backslash (in ` too, as ClickHouse reads it), does not end it
      let j = i + 1, closed = false;
      for (; j < n; j++) {
        if (text[j] === "\\") { j++; continue; }
        if (text[j] === c) { if (text[j + 1] === c) { j++; continue; } closed = true; j++; break; }
      }
      const to = Math.min(j, n);
      out.push({ kind: "quoted", from: i, to, value: text.slice(i, to), ...(closed ? {} : { open: true }) });
      i = to; continue;
    }
    if ((c === "-" && text[i + 1] === "-") || c === "#") {
      let j = i; while (j < n && text[j] !== "\n") j++;
      out.push({ kind: "comment", from: i, to: j, value: text.slice(i, j) }); i = j; continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? n : end + 2;
      out.push({ kind: "comment", from: i, to, value: text.slice(i, to), ...(end < 0 ? { open: true } : {}) }); i = to; continue;
    }
    if (/[\p{L}_]/u.test(c)) { let j = i + 1; while (j < n && /[\p{L}\p{N}_]/u.test(text[j])) j++; out.push({ kind: "word", from: i, to: j, value: text.slice(i, j) }); i = j; continue; }
    if (/\d/.test(c)) { let j = i + 1; while (j < n && /[\p{L}\p{N}._]/u.test(text[j])) j++; out.push({ kind: "number", from: i, to: j, value: text.slice(i, j) }); i = j; continue; }
    out.push({ kind: "symbol", from: i, to: i + 1, value: c }); i++;
  }
  return out;
}

/** A name (bare or quoted) followed by "(": a blocked table function anywhere, and where a table goes, anything not allowed (CustomSql.CheckFunctions). */
function checkFunctions(tokens, add) {
  const fromAt = new Set(), query = [true]; // query: per depth, the top level or brackets that start with SELECT / WITH (not a call such as EXTRACT(YEAR FROM d))
  let depth = 0;
  const outside = (t) => add(t.from, t.to, `'${nameOf(t)}' reads outside this connection's tables and can't be used here.`);
  const isSource = (at) => nameOf(tokens[at]) !== null && isSym(tokens[at + 1], "(");
  const checkSource = (at) => { if (!ALLOWED_TABLE_FUNCTIONS.has(nameOf(tokens[at]).toLowerCase())) outside(tokens[at]); return true; };
  const flagged = new Set();
  tokens.forEach((t, i) => {
    if (isSym(t, "(")) { depth++; query.push(isWord(tokens[i + 1], "select") || isWord(tokens[i + 1], "with")); return; }
    if (isSym(t, ")")) { fromAt.delete(depth); depth--; if (query.length > 1) query.pop(); return; }
    const arrayJoin = isWord(tokens[i - 1], "array") || (isWord(tokens[i - 1], "left") && isWord(tokens[i - 2], "array"));
    if (query.at(-1) && (isWord(t, "from") || (isWord(t, "join") && !arrayJoin))) { fromAt.add(depth); if (isSource(i + 1)) flagged.add(i + 1) && checkSource(i + 1); return; }
    if (t.kind === "word" && ENDS_FROM.has(t.value.toLowerCase())) { fromAt.delete(depth); return; }
    if (isSym(t, ",") && fromAt.has(depth) && isSource(i + 1)) { flagged.add(i + 1); checkSource(i + 1); return; }
    const name = nameOf(t);
    if (name !== null && !flagged.has(i) && isSym(tokens[i + 1], "(") && BLOCKED_FUNCTIONS.has(name.toLowerCase())) outside(t);
  });
}

/** The problems in `text` as `{ from, to, message }` offsets (empty text has none: Save asks for a query). Order: by position. */
export function checkSql(text) {
  const problems = [];
  const add = (from, to, message) => problems.push({ from, to: Math.max(to, from + 1), message });
  if (!text.trim()) return problems;
  if (text.length > LIMITS.customSql) add(LIMITS.customSql, text.length, `The query can be at most ${LIMITS.customSql.toLocaleString("en-US")} characters.`);
  const all = tokenize(text);
  const tokens = all.filter((t) => t.kind !== "comment");
  for (const t of all) {
    if (t.kind === "quoted" && t.open) add(t.from, t.to, t.value[0] === "'" ? "This text value is missing its closing quote (')." : `This name is missing its closing quote (${t.value[0]}).`);
    if (t.kind === "comment" && t.open) add(t.from, t.to, "This /* comment is never closed.");
  }
  if (!tokens.length) return problems.sort((a, b) => a.from - b.from);
  const head = tokens[0];
  if (!(head.kind === "word" && /^(select|with)$/i.test(head.value))) add(head.from, head.to, "The query must start with SELECT (or WITH).");
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].kind === "symbol" && tokens[last].value === ";") last--; // trailing semicolons are just habit
  const stack = [];
  tokens.forEach((t, i) => {
    if (t.kind === "symbol" && t.value === ";" && i <= last) add(t.from, t.to, "Only one query can be saved; remove the extra ';'.");
    else if (t.kind === "symbol" && t.value === "(") stack.push(t);
    else if (t.kind === "symbol" && t.value === ")") { if (stack.pop() === undefined) add(t.from, t.to, "This ')' has no '(' before it."); }
    else if (t.kind === "word" && t.value.toLowerCase() === "settings") add(t.from, t.to, "A query can't change settings; remove the SETTINGS part.");
  });
  for (const open of stack) add(open.from, open.to, "This '(' is never closed.");
  checkFunctions(tokens, add);
  const end = tokens.slice(0, last + 1);
  // not a column called format at the end of an ORDER BY (… BY format DESC, …, format ASC) or an alias (AS format x): CustomSql.CheckOutput
  if (end.length >= 3 && isWord(end.at(-2), "format") && nameOf(end.at(-1)) !== null && !SORT_WORDS.has(nameOf(end.at(-1)).toLowerCase())
    && !isWord(end.at(-3), "as") && !isWord(end.at(-3), "by") && !isSym(end.at(-3), ","))
    add(end.at(-2).from, end.at(-1).to, "A query can't choose its output format; remove the FORMAT part.");
  tokens.forEach((t, i) => { if (isWord(t, "into") && isWord(tokens[i + 1], "outfile")) add(t.from, tokens[i + 1].to, "A query can't write a file; remove the INTO OUTFILE part."); });
  return problems.sort((a, b) => a.from - b.from);
}

/**
 * `EXPLAIN SYNTAX` text made comparable: ClickHouse keeps the case a function was written in (`COUNT()` and `count()`), which the translation round trip changes
 * without changing the query, so everything outside quoted text is lower-cased, whitespace is collapsed, and `coalesce(` is read as `ifnull(` (what a
 * two-argument ifNull becomes in MySQL and back). Two texts that are equal afterwards mean the same to ClickHouse. Case is only ignored here AFTER ClickHouse
 * has accepted both queries, which is what proves every case-sensitive function name was right.
 */
export function canonSyntax(text) {
  let out = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { out += c; if (c === "\\") out += text[++i] ?? ""; else if (c === "'") quoted = false; continue; }
    if (c === "'") { quoted = true; out += c; continue; }
    out += c.toLowerCase();
  }
  return out.replace(/\s+/g, " ").replace(/\bcoalesce\(/g, "ifnull(").trim();
}

/** `offset` → `{ line, ch }` (0-based, as CodeMirror positions). */
export function posOf(text, offset) {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = before.split("\n").length - 1;
  return { line, ch: before.length - (before.lastIndexOf("\n") + 1) };
}

/**
 * Where ClickHouse's own refusal points, when its message says so ("… (line 3, col 8)"): the server describes `DESCRIBE TABLE (⏎query⏎)`, so
 * its line 1 is that wrapper and the query starts on line 2; comments written as `/* … *\/` collapse lines, so with one the position is unknown.
 * @returns {{ line: number, ch: number } | null} a CodeMirror position in `sql` (the text as typed), or null when it can't be placed.
 */
export function serverErrorPos(message, sql) {
  const m = /\(line (\d+), col (\d+)\)/.exec(message);
  if (!m || sql.includes("/*")) return null;
  const lead = /^\s*/.exec(sql)[0];
  const leadLines = lead.split("\n").length - 1;
  let line = Number(m[1]) - 2 + leadLines;
  let ch = Number(m[2]) - 1;
  if (Number(m[1]) === 2 && leadLines === 0) ch += lead.length; // the trimmed text lost its leading spaces on that first line
  else if (Number(m[1]) === 2) ch += lead.length - (lead.lastIndexOf("\n") + 1);
  const lines = sql.split("\n");
  if (line < 0 || line >= lines.length) return null;
  return { line, ch: Math.min(Math.max(ch, 0), lines[line].length) };
}
