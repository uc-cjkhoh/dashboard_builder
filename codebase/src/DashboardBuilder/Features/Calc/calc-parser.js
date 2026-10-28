// Calculated fields — the formula parser (pure, DOM-free; tests/js/calc-cases.test.mjs).
//
//   expr      := term (("+" | "-") term)*
//   term      := factor (("*" | "/") factor)*
//   factor    := "-" factor | number | "(" expr ")" | aggregate | ref
//   aggregate := ("SUM" | "AVG" | "MIN" | "MAX" | "COUNT" | "COUNTD") "(" expr ")"
//   ref       := "[" name "]"
//
// Hand-written tokenizer + recursive descent. Function names are case-insensitive; references are matched
// case-sensitively by the caller's `resolve`. Nodes are exactly the wire shapes (field | num | un | bin | agg),
// plus the client-only `{ k: "calc", name }` for a reference to another calculation (expanded by
// calc-model.js before anything is sent).
import { CALC_LIMITS, FUNCTIONS } from "./calc-types.js";

class ParseError extends Error {
  constructor(message, pos) { super(message); this.pos = pos; }
}

const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const WHITESPACE = /\s/;
const match = (re, text, at) => { re.lastIndex = at; const m = re.exec(text); return m ? m[0] : null; };

// Tokens: { t: "num" | "ref" | "id" | "op" | "(" | ")" | "end", text, pos, v? }; for "ref", `text` is the
// name between the brackets.
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
    } else if (ch === "(" || ch === ")") {
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
 * `{ field: { db, table, column } }`, `{ calc: { name } }` or `{ error: string }`; null/undefined means "no match"
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

    // `after` names the token that demands a value first, for "Expected a value after +".
    function expr(after) {
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
      if (tok.t === "(") {
        next();
        const inner = expr("(");
        closeParen();
        return inner;
      }
      if (tok.t === "ref") { next(); return reference(tok); }
      if (tok.t === "id") return call(tok);
      if (after !== undefined) throw new ParseError(`Expected a value after ${after}`, tok.pos);
      throw new ParseError(tok.t === "end" ? "Expected a value." : `Unexpected ${tok.raw}`, tok.pos);
    }
    function closeParen() {
      if (peek().t !== ")") throw new ParseError("Expected )", peek().pos);
      next();
    }
    function call(tok) {
      next();
      const fn = tok.text.toLowerCase();
      const known = Object.hasOwn(FUNCTIONS, fn);
      if (peek().t !== "(") {
        if (known) throw new ParseError(`Expected ( after ${tok.text}`, peek().pos);
        throw new ParseError(`Unexpected ${tok.text}`, tok.pos);
      }
      if (!known) throw new ParseError(`Unknown function ${tok.text}.`, tok.pos);
      next();
      const arg = expr("(");
      closeParen();
      return { k: "agg", fn, arg };
    }
    function reference(tok) {
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
