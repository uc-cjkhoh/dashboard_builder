// Calculated fields — the formula parser (pure, DOM-free; tests/js/calc-cases.test.mjs).
//
//   expr      := and ("OR" and)*
//   and       := not ("AND" not)*
//   not       := "NOT" not | compare
//   compare   := sum (("=" | "!=" | "<>" | "<" | "<=" | ">" | ">=") sum
//                     | ["NOT"] "IN" "(" expr ("," expr)* ")"       -- node { k: "in", arg, list }; check() demands literal values
//                     | ["NOT"] "BETWEEN" sum "AND" sum)?           -- sugar for x >= a AND x <= b (NOT wraps it)      (no chaining)
//   sum       := term (("+" | "-") term)*
//   term      := factor (("*" | "/") factor)*
//   factor    := "-" factor | number | string | "TRUE" | "FALSE" | "NULL" | "(" expr ")" | aggregate | logic | ref
//   aggregate := ("SUM" | "AVG" | "MIN" | "MAX" | "COUNT" | "COUNTD" | "MEDIAN" | "STDDEV" | "VARIANCE" | "ATTR") "(" expr ")"
//              | "PERCENTILE" "(" expr "," number ")"      -- the fraction is a literal number (range-checked by check())
//   logic     := ("IF" | "IIF") "(" expr "," expr "," expr ")" | "IFNULL" "(" expr "," expr ")"
//              | "ISNULL" "(" expr ")" | "ZN" "(" expr ")"
//              | "CASE" [expr] ("WHEN" expr "THEN" expr)+ ["ELSE" expr] "END"
//              | "IF" expr "THEN" expr ("ELSEIF" expr "THEN" expr)* ["ELSE" expr] "END"      -- the same node as CASE WHEN
//   text      := ("TEXT" | "STR" | "LOWER" | "UPPER" | "TRIM" | "LTRIM" | "RTRIM" | "LEN" | "LEFT" | "RIGHT" | "MID" | "FIND" | "REPLACE" | "CONCAT" | "CONTAINS" | "STARTSWITH" | "ENDSWITH" | "ICONTAINS" | "ISTARTSWITH" | "IENDSWITH" | "SPLIT")
//                "(" expr ("," expr)* ")"        -- argument count and kinds are checked by check(), not here
//   date      := ("DATEDIFF" | "DATEADD" | "YEAR" | "MONTH" | "DAY" | "QUARTER" | "WEEK" | "WEEKDAY" | "DATE") "(" expr ("," expr)* ")"   -- same shape as text
//   string    := "'" text "'"        (a quote inside is doubled: 'it''s')
//   ref       := "[" name "]"  |  "[@" parameter "]"      -- a workbook parameter (Calc/calc-params.js substitutes its value)
//
// Hand-written tokenizer + recursive descent. Function names are case-insensitive; references are matched
// case-sensitively by the caller's `resolve`. Nodes are exactly the wire shapes (field | num | str | bool | null | un | bin | agg |
// cmp | logic | not | in | case | ifnull | isnull | fn), plus the client-only `{ k: "calc", name }` for a reference to another calculation (expanded by
// calc-model.js before anything is sent) and `{ k: "param", name }` for a parameter (replaced by a literal by calc-params.js).
import { CALC_LIMITS, FUNCTIONS, ROW_FUNCTIONS } from "./calc-types.js";

class ParseError extends Error {
  constructor(message, pos) { super(message); this.pos = pos; }
}

const CMP_OPS = ["=", "!=", "<", "<=", ">", ">="];
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const WHITESPACE = /\s/;
const match = (re, text, at) => { re.lastIndex = at; const m = re.exec(text); return m ? m[0] : null; };

// Tokens: { t: "num" | "str" | "ref" | "id" | "op" | "(" | ")" | "," | "end", text, pos, v? }; for "ref", `text` is the
// name between the brackets; for "str", `text` is the unescaped value. A comparison is an "op" token whose text is
// one of CMP_OPS (`<>` is normalised to `!=`).
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (WHITESPACE.test(ch)) { i++; continue; }
    if (ch === "[") {
      let j = i + 1;
      while (j < text.length && text[j] !== "]" && text[j] !== "[") j++;
      const name = text.slice(i + 1, j);
      if (text[j] !== "]") throw new ParseError(`Missing ] after ${name}`, i);
      tokens.push({ t: "ref", text: name, raw: text.slice(i, j + 1), pos: i });
      i = j + 1;
    } else if ("+-*/".includes(ch)) {
      tokens.push({ t: "op", text: ch, raw: ch, pos: i }); i++;
    } else if ("=!<>".includes(ch)) {
      const two = text.slice(i, i + 2);
      const raw = ["!=", "<=", ">=", "<>"].includes(two) ? two : ch;
      if (raw === "!") throw new ParseError("Unexpected character !", i);
      tokens.push({ t: "op", text: raw === "<>" ? "!=" : raw, raw, pos: i }); i += raw.length;
    } else if (ch === "'") {
      let j = i + 1, value = "";
      for (;;) {
        if (j >= text.length) throw new ParseError("Missing ' to close the text", i);
        if (text[j] === "'") {
          if (text[j + 1] !== "'") break;
          value += "'"; j += 2;
        } else { value += text[j]; j++; }
      }
      if (value.length > CALC_LIMITS.string) throw new ParseError(`A text value can be at most ${CALC_LIMITS.string} characters.`, i);
      tokens.push({ t: "str", text: value, raw: text.slice(i, j + 1), pos: i });
      i = j + 1;
    } else if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ t: ch, text: ch, raw: ch, pos: i }); i++;
    } else if (/[0-9.]/.test(ch)) {
      const raw = match(NUMBER, text, i);
      if (raw === null) throw new ParseError(`Unexpected character ${ch}`, i);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new ParseError("That number is out of range.", i);
      tokens.push({ t: "num", text: raw, raw, v, pos: i });
      i += raw.length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const raw = match(IDENT, text, i);
      tokens.push({ t: "id", text: raw, raw, pos: i });
      i += raw.length;
    } else {
      throw new ParseError(`Unexpected character ${ch}`, i);
    }
  }
  tokens.push({ t: "end", text: "", raw: "", pos: text.length });
  return tokens;
}

/**
 * Parses `text` into an expression tree. `resolve(parts)` receives the dot-split reference
 * (`[orders.amount]` -> ["orders", "amount"], `[Net revenue]` -> ["Net revenue"]) and returns
 * `{ field: { db, table, column } }`, `{ calc: { name } }` or `{ error: string }`; a `[@Name]` reference calls `resolve([name], "param")` (the name is not
 * dot-split) which returns `{ param: { name } }` or `{ error }`; null/undefined means "no match"
 * (the parser then reports a one-part name as a field missing its table).
 * Returns `{ ast }` or `{ error: { message, pos } }` (`pos`: character offset in `text`).
 */
export function parseFormula(text, resolve) {
  try {
    if (text.length > CALC_LIMITS.formula) throw new ParseError(`A formula can be at most ${CALC_LIMITS.formula} characters.`, 0);
    const tokens = tokenize(text);
    let at = 0;
    const peek = () => tokens[at];
    const next = () => tokens[at++];
    const isOp = (tok, ops) => tok.t === "op" && ops.includes(tok.text);

    const isWord = (tok, word) => tok.t === "id" && tok.text.toLowerCase() === word;

    // `after` names the token that demands a value first, for "Expected a value after +".
    function expr(after) {
      let left = andExpr(after);
      while (isWord(peek(), "or")) {
        const tok = next();
        left = { k: "logic", op: "or", l: left, r: andExpr(tok.text.toUpperCase()) };
      }
      return left;
    }
    function andExpr(after) {
      let left = notExpr(after);
      while (isWord(peek(), "and")) {
        const tok = next();
        left = { k: "logic", op: "and", l: left, r: notExpr(tok.text.toUpperCase()) };
      }
      return left;
    }
    function notExpr(after) {
      if (isWord(peek(), "not")) {
        const tok = next();
        return { k: "not", arg: notExpr(tok.text.toUpperCase()) };
      }
      return compare(after);
    }
    function compare(after) {
      const left = sum(after);
      const tok = peek();
      if (tok.t === "op" && CMP_OPS.includes(tok.text)) {
        next();
        return { k: "cmp", op: tok.text, l: left, r: sum(tok.raw) };
      }
      if (isWord(tok, "in")) { next(); return inList(left); }
      if (isWord(tok, "between")) { next(); return between(left); }
      if (isWord(tok, "not")) {
        const following = tokens[at + 1];
        if (!isWord(following, "in") && !isWord(following, "between")) throw new ParseError("Expected IN or BETWEEN after NOT", tok.pos);
        next(); next();
        return { k: "not", arg: isWord(following, "in") ? inList(left) : between(left) };
      }
      return left;
    }
    // x IN (a, b, …): the values stay a list node (a chain of ORs would nest as deep as the list is long).
    function inList(arg) {
      if (peek().t !== "(") throw new ParseError("Expected ( after IN", peek().pos);
      next();
      const list = [expr("(")];
      while (peek().t === ",") { next(); list.push(expr(",")); }
      closeParen();
      return { k: "in", arg, list };
    }
    // x BETWEEN a AND b: both ends included; the tree is the two comparisons joined by AND (x appears in both).
    function between(arg) {
      const lo = sum("BETWEEN");
      if (!isWord(peek(), "and")) throw new ParseError("Expected AND", peek().pos);
      next();
      const hi = sum("AND");
      return { k: "logic", op: "and", l: { k: "cmp", op: ">=", l: arg, r: lo }, r: { k: "cmp", op: "<=", l: structuredClone(arg), r: hi } };
    }
    function sum(after) {
      let left = term(after);
      while (isOp(peek(), "+-")) {
        const op = next().text;
        left = { k: "bin", op, l: left, r: term(op) };
      }
      return left;
    }
    function term(after) {
      let left = factor(after);
      while (isOp(peek(), "*/")) {
        const op = next().text;
        left = { k: "bin", op, l: left, r: factor(op) };
      }
      return left;
    }
    function factor(after) {
      const tok = peek();
      if (tok.t === "op" && tok.text === "-") { next(); return { k: "un", op: "-", arg: factor("-") }; }
      if (tok.t === "num") { next(); return { k: "num", v: tok.v }; }
      if (tok.t === "str") { next(); return { k: "str", v: tok.text }; }
      if (tok.t === "(") {
        next();
        const inner = expr("(");
        closeParen();
        return inner;
      }
      if (tok.t === "ref") { next(); return reference(tok); }
      if (tok.t === "id") {
        const word = tok.text.toLowerCase();
        if ((word === "true" || word === "false" || word === "null") && tokens[at + 1].t !== "(") {
          next();
          return word === "null" ? { k: "null" } : { k: "bool", v: word === "true" };
        }
        return call(tok);
      }
      if (after !== undefined) throw new ParseError(`Expected a value after ${after}`, tok.pos);
      throw new ParseError(tok.t === "end" ? "Expected a value." : `Unexpected ${tok.raw}`, tok.pos);
    }
    function closeParen() {
      if (peek().t !== ")") throw new ParseError("Expected )", peek().pos);
      next();
    }
    function comma() {
      if (peek().t !== ",") throw new ParseError("Expected ,", peek().pos);
      next();
    }
    // IF / IIF / IFNULL / ISNULL / ZN / CASE; returns undefined for any other name.
    function logicCall(tok) {
      const fn = tok.text.toLowerCase();
      if (fn === "case") { next(); return caseExpr(); }
      if (!["if", "iif", "ifnull", "isnull", "zn"].includes(fn)) return undefined;
      next();
      if (fn === "if") return ifForm();
      if (peek().t !== "(") throw new ParseError(`Expected ( after ${tok.text}`, peek().pos);
      next();
      return parenForm(fn);
    }
    // IF is the function IF(c, a, b) or the keyword form IF c THEN a … END. `IF (x) THEN …` starts like the function, so the
    // form is decided without backtracking (a retry would re-parse nested IFs twice per level): the function has a comma
    // at depth 1 of its parentheses; anything else is the keyword form. An unclosed "(" is left to the function's error.
    function ifForm() {
      if (peek().t !== "(") return ifKeyword();
      let depth = 0, comma1 = false, closed = false;
      for (let i = at; i < tokens.length && !closed; i++) {
        const t = tokens[i].t;
        if (t === "(") depth++;
        else if (t === ")") { depth--; closed = depth === 0; }
        else if (t === "," && depth === 1) comma1 = true;
      }
      if (comma1 || !closed) { next(); return parenForm("if"); }
      return ifKeyword();
    }
    function ifKeyword() {
      const whens = [];
      let c = expr("IF");
      for (;;) {
        if (!isWord(peek(), "then")) throw new ParseError("Expected THEN", peek().pos);
        next();
        whens.push({ c, t: expr("THEN") });
        if (!isWord(peek(), "elseif")) break;
        next();
        c = expr("ELSEIF");
      }
      let els;
      if (isWord(peek(), "else")) { next(); els = expr("ELSE"); }
      if (!isWord(peek(), "end")) throw new ParseError(els === undefined ? "Expected ELSEIF, ELSE or END" : "Expected END", peek().pos);
      next();
      return els === undefined ? { k: "case", whens } : { k: "case", whens, else: els };
    }
    // The arguments of IF / IIF / IFNULL / ISNULL / ZN after their "(".
    function parenForm(fn) {
      const a = expr("(");
      let node;
      if (fn === "if" || fn === "iif") {
        comma(); const t = expr(",");
        comma(); const e = expr(",");
        node = { k: "case", whens: [{ c: a, t }], else: e };
      } else if (fn === "ifnull") {
        comma(); node = { k: "ifnull", l: a, r: expr(",") };
      } else if (fn === "zn") {
        node = { k: "ifnull", l: a, r: { k: "num", v: 0 } };
      } else {
        node = { k: "isnull", arg: a };
      }
      closeParen();
      return node;
    }
    function caseExpr() {
      if (isWord(peek(), "end")) throw new ParseError("Expected WHEN after CASE", peek().pos);
      const subject = isWord(peek(), "when") ? null : expr("CASE");
      const whens = [];
      while (isWord(peek(), "when")) {
        next();
        const c = expr("WHEN");
        if (!isWord(peek(), "then")) throw new ParseError("Expected THEN", peek().pos);
        next();
        whens.push({ c: subject === null ? c : { k: "cmp", op: "=", l: subject, r: c }, t: expr("THEN") });
      }
      if (whens.length === 0) throw new ParseError("Expected WHEN after CASE", peek().pos);
      let els;
      if (isWord(peek(), "else")) { next(); els = expr("ELSE"); }
      if (!isWord(peek(), "end")) throw new ParseError(els === undefined ? "Expected WHEN, ELSE or END" : "Expected END", peek().pos);
      next();
      return els === undefined ? { k: "case", whens } : { k: "case", whens, else: els };
    }
    function call(tok) {
      const logic = logicCall(tok);
      if (logic !== undefined) return logic;
      next();
      const lower = tok.text.toLowerCase();
      const fn = lower === "str" ? "text" : lower; // STR is an alias of TEXT
      const isRow = Object.hasOwn(ROW_FUNCTIONS, fn);
      const known = isRow || Object.hasOwn(FUNCTIONS, fn);
      if (peek().t !== "(") {
        if (known) throw new ParseError(`Expected ( after ${tok.text}`, peek().pos);
        throw new ParseError(`Unexpected ${tok.text}`, tok.pos);
      }
      if (!known) throw new ParseError(`Unknown function ${tok.text}.`, tok.pos);
      next();
      if (isRow) {
        const args = [expr("(")];
        while (peek().t === ",") { next(); args.push(expr(",")); }
        closeParen();
        return { k: "fn", fn, args };
      }
      const arg = expr("(");
      if (FUNCTIONS[fn].fraction) {
        const hint = `Write ${tok.text.toUpperCase()}([field], 0.9) — the fraction goes after a comma.`;
        if (peek().t !== ",") throw new ParseError(hint, peek().pos);
        next();
        const p = peek();
        if (p.t !== "num") throw new ParseError(hint, p.pos);
        next();
        closeParen();
        return { k: "agg", fn, arg, p: p.v };
      }
      closeParen();
      return { k: "agg", fn, arg };
    }
    function reference(tok) {
      if (tok.text.startsWith("@")) {
        const name = tok.text.slice(1);
        if (name.trim() === "") throw new ParseError("Write the parameter as [@Name].", tok.pos);
        const r = resolve([name], "param");
        if (r && typeof r.error === "string") throw new ParseError(r.error, tok.pos);
        if (r && r.param) return { k: "param", name: r.param.name };
        throw new ParseError(`Unknown parameter ${tok.raw}.`, tok.pos);
      }
      const parts = tok.text.split(".");
      if (parts.length > 3 || parts.some((p) => p.length === 0)) throw new ParseError("Write the field as [table.column].", tok.pos);
      const r = resolve(parts);
      if (r && typeof r.error === "string") throw new ParseError(r.error, tok.pos);
      if (r && r.field) return { k: "field", db: r.field.db, table: r.field.table, column: r.field.column };
      if (r && r.calc) return { k: "calc", name: r.calc.name };
      // Nothing matched: a lone name that isn't a calculation is most likely a field missing its table.
      if (parts.length === 1) throw new ParseError("Write the field as [table.column].", tok.pos);
      throw new ParseError(`Unknown reference ${tok.raw}.`, tok.pos);
    }

    const ast = expr();
    if (peek().t !== "end") throw new ParseError(`Unexpected ${peek().raw}`, peek().pos);
    return { ast };
  } catch (e) {
    if (e instanceof ParseError) return { error: { message: e.message, pos: e.pos } };
    throw e;
  }
}
