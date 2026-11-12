// Did turning ClickHouse text into MySQL and back keep its meaning? (pure: the Edit SQL dialog supplies the facts, tests/live/translate-smoke.mjs measures it)
// A query written in ClickHouse is shown in MySQL by default when the way back gives the same query; otherwise it opens in ClickHouse syntax, so the
// first edit cannot silently change which rows it returns. A false alarm only costs that; a missed change would be silent, so every doubt says "changed".
import { canonSyntax } from "./sql-check.js";

/**
 * @param {{ ch: string, back: string, changes?: string[], columnsBefore?: {name:string,type:string}[], columnsAfter?: {name:string,type:string}[],
 *   syntaxBefore?: string|null, syntaxAfter?: string|null }} f
 *   `ch` the original ClickHouse text, `back` the text after ClickHouse → MySQL → ClickHouse; `changes` what the translator reports on the way back
 *   (ilike, case-fold, div-null, nulls-first, …); the columns are what ClickHouse's DESCRIBE says of each (null when ClickHouse refused that text);
 *   the syntax strings are EXPLAIN SYNTAX of each (null when unavailable: both null = no EXPLAIN here; only one null = a doubt, so "changed").
 * @returns {{ kept: boolean, reason: "same" | "changes" | "refused" | "columns" | "syntax" | "ok" | "ok-no-explain" }}
 */
export function meaningKept(f) {
  if (f.back === f.ch) return { kept: true, reason: "same" };
  if ((f.changes ?? []).length) return { kept: false, reason: "changes" };                       // a repair that changes meaning ran on the way back
  if (!f.columnsBefore || !f.columnsAfter) return { kept: false, reason: "refused" };            // ClickHouse does not accept the round trip (a mangled function name)
  const shape = (cols) => JSON.stringify(cols.map((c) => [c.name, c.type]));
  if (shape(f.columnsBefore) !== shape(f.columnsAfter)) return { kept: false, reason: "columns" };
  const none = [f.syntaxBefore, f.syntaxAfter].filter((x) => x == null).length;
  if (none === 2) return { kept: true, reason: "ok-no-explain" };                               // no EXPLAIN on this server at all: the checks above have spoken
  if (none === 1) return { kept: false, reason: "syntax" };                                      // it worked for one text and not the other: that is a doubt
  return canonSyntax(f.syntaxBefore) === canonSyntax(f.syntaxAfter) ? { kept: true, reason: "ok" } : { kept: false, reason: "syntax" };
}
