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
    if (c === "'" || c === '"' || c === "`") { // a repeated quote inside the run, or (not for `) a backslash, does not end it
      let j = i + 1, closed = false;
      for (; j < n; j++) {
        if (text[j] === "\\" && c !== "`") { j++; continue; }
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
    else if (t.kind === "word" && BLOCKED_FUNCTIONS.has(t.value.toLowerCase()) && tokens[i + 1]?.kind === "symbol" && tokens[i + 1].value === "(")
      add(t.from, t.to, `'${t.value}' reads outside this connection's tables and can't be used here.`);
  });
  for (const open of stack) add(open.from, open.to, "This '(' is never closed.");
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
