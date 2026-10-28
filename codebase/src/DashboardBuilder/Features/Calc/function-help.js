// Calculated fields — the function glossary (pure, DOM-free; tests/js/function-help.test.mjs).
// Names, argument kinds and result types are DERIVED from calc-types.js (FUNCTIONS, ROW_FUNCTIONS) so they cannot drift;
// only the plain-words text, the example and the NULL note are written here. The logic keywords are not in a type table
// (the parser owns them), so they are listed in LOGIC below; a test fails if any function exists on one side only.
import { FUNCTIONS, ROW_FUNCTIONS, CALC_LIMITS } from "./calc-types.js";

export const GROUPS = Object.freeze(["Aggregate", "Logic", "Text", "Date"]);

const AGGREGATES = ["sum", "avg", "min", "max", "count", "countd", "median", "stddev", "variance", "percentile", "attr"];
const TEXT = ["lower", "upper", "trim", "len", "left", "right", "replace", "concat", "contains", "startswith", "endswith", "split"];
const DATE = ["datediff", "dateadd", "year", "month", "day", "quarter", "week", "weekday", "date"];
/** Logic keywords the parser handles itself: name -> { args: display text, result, insert }. */
const LOGIC = {
  if: { sig: "IF(condition, then, else)", result: "same type as then / else" },
  iif: { sig: "IIF(condition, then, else)", result: "same type as then / else" },
  case: { sig: "CASE [value] WHEN a THEN x … [ELSE y] END", result: "same type as the results", insert: "CASE " },
  ifnull: { sig: "IFNULL(value, fallback)", result: "same type as value" },
  isnull: { sig: "ISNULL(value)", result: "boolean" },
  zn: { sig: "ZN(number)", result: "number" },
  and: { sig: "a AND b", result: "boolean", insert: "AND " },
  or: { sig: "a OR b", result: "boolean", insert: "OR " },
  not: { sig: "NOT a", result: "boolean", insert: "NOT " },
};

// name -> [plain-words sentence, example formula, NULL / edge note]
const TEXTS = {
  sum: ["Adds up the numbers in each group.", "SUM([orders.amount])", "Empty values are skipped; a group with no value is empty."],
  avg: ["The average of the numbers in each group.", "AVG([orders.amount])", "Empty values are skipped, not counted as 0."],
  min: ["The smallest number, earliest date or first text in each group.", "MIN([orders.placed])", "Empty values are skipped."],
  max: ["The largest number, latest date or last text in each group.", "MAX([orders.placed])", "Empty values are skipped."],
  count: ["How many non-empty values are in each group.", "COUNT([orders.status])", "Empty values are not counted; a group with none gives 0."],
  countd: ["How many different non-empty values are in each group.", "COUNTD([orders.status])", "Empty values are not counted."],
  median: ["The middle number of each group (halfway between the two middle ones when the count is even).", "MEDIAN([orders.amount])", "Empty values are skipped; no value gives an empty result."],
  stddev: ["The sample standard deviation of the numbers in each group.", "STDDEV([orders.amount])", "Needs at least two values, otherwise it is empty."],
  variance: ["The sample variance of the numbers in each group.", "VARIANCE([orders.amount])", "Needs at least two values, otherwise it is empty."],
  percentile: ["The value below which a fraction p of the numbers fall (0 is the minimum, 0.5 the median, 1 the maximum).", "PERCENTILE([orders.amount], 0.9)", "p is a literal number from 0 to 1, not a field. Empty values are skipped."],
  attr: ["The value itself when every row of the group has the same one.", "ATTR([orders.status])", "Empty when the group has more than one distinct value; empty values are ignored."],
  if: ["The second argument when the condition is true, otherwise the third.", "IF([orders.amount] > 100, 'big', 'small')", "A condition that is empty counts as not true, so the else is used. Both results must be the same type."],
  iif: ["Same as IF: the second argument when the condition is true, otherwise the third.", "IIF([orders.qty] > 1, 'many', 'one')", "A condition that is empty counts as not true."],
  case: ["The result of the first WHEN that matches, or of ELSE.", "CASE [orders.status] WHEN 'open' THEN 1 ELSE 0 END", "With no ELSE and no match the result is empty. All results must be the same type."],
  ifnull: ["The value, or the fallback when the value is empty.", "IFNULL([orders.amount], 0)", "Both arguments must be the same type. Division by zero is empty, so IFNULL(a / b, 0) repairs it."],
  isnull: ["True when the value is empty.", "ISNULL([orders.amount])", "Never empty itself: it is true or false."],
  zn: ["The number, or 0 when it is empty (short for IFNULL(number, 0)).", "ZN([orders.amount])", "Only numbers."],
  and: ["True when both sides are true.", "[orders.amount] > 100 AND [orders.qty] > 1", "Empty AND false is false; empty AND true is empty."],
  or: ["True when either side is true.", "[orders.amount] > 100 OR [orders.qty] > 1", "Empty OR true is true; empty OR false is empty."],
  not: ["Flips true and false.", "NOT ISNULL([orders.amount])", "NOT of an empty value is empty."],
  lower: ["The text in lower case.", "LOWER([orders.status])", "Empty text gives empty."],
  upper: ["The text in upper case.", "UPPER([orders.status])", "Empty text gives empty."],
  trim: ["The text without leading and trailing spaces.", "TRIM([orders.status])", "Strips the space character only, not tabs or line breaks."],
  len: ["How many characters the text has.", "LEN([orders.status])", "Empty text gives empty, not 0."],
  left: ["The first n characters of the text.", "LEFT([orders.status], 3)", `n is a literal whole number 0 to ${CALC_LIMITS.count}.`],
  right: ["The last n characters of the text.", "RIGHT([orders.status], 3)", `n is a literal whole number 0 to ${CALC_LIMITS.count}.`],
  replace: ["The text with every occurrence of one piece replaced by another.", "REPLACE([orders.status], 'open', 'new')", "Empty text gives empty."],
  concat: ["Several texts joined end to end.", "CONCAT([orders.status], ' - ', [orders.region])", `Two to ${CALC_LIMITS.concat} texts. Empty if any one is empty: wrap a part in IFNULL(x, '') to keep the rest.`],
  contains: ["True when the text includes the piece.", "CONTAINS([orders.status], 'pen')", "Case counts (use LOWER on both sides to ignore it). Empty text gives empty."],
  startswith: ["True when the text begins with the piece.", "STARTSWITH([orders.status], 'op')", "Case counts. Empty text gives empty."],
  endswith: ["True when the text ends with the piece.", "ENDSWITH([orders.status], 'en')", "Case counts. Empty text gives empty."],
  split: ["The k-th piece of the text cut at a separator (1 is the first).", "SPLIT([orders.status], '-', 1)", `The separator is a literal of 1 to ${CALC_LIMITS.separator} characters, k a literal whole number 1 to ${CALC_LIMITS.count}. Empty when there is no k-th piece.`],
  datediff: ["How many whole units lie between two dates (end minus start).", "DATEDIFF('day', [orders.placed], DATE('2024-12-31'))", "The unit is a text literal: year, quarter, month, week, day, hour, minute or second. Empty if either date is empty."],
  dateadd: ["A date moved forward (or back, with a negative amount) by a number of units.", "DATEADD('month', 1, [orders.placed])", "A month step past a shorter month lands on its last day. The amount is a literal whole number."],
  year: ["The year of the date.", "YEAR([orders.placed])", "An empty date gives empty. Text is refused: use DATE() first."],
  month: ["The month of the date, 1 to 12.", "MONTH([orders.placed])", "An empty date gives empty."],
  day: ["The day of the month, 1 to 31.", "DAY([orders.placed])", "An empty date gives empty."],
  quarter: ["The quarter of the year, 1 to 4.", "QUARTER([orders.placed])", "An empty date gives empty."],
  week: ["The ISO 8601 week number, 1 to 53.", "WEEK([orders.placed])", "Weeks start on Monday; week 1 holds the year's first Thursday."],
  weekday: ["The day of the week, Monday 1 to Sunday 7.", "WEEKDAY([orders.placed])", "Tableau counts Sunday as 1; here a Sunday is 7."],
  date: ["Reads text as a calendar date.", "DATE('2024-03-05')", "Empty when the text is not a real date (for example 2024-02-30)."],
};

const WORD = { text: "text", length: "length", position: "position", separator: "separator", unit: "unit", amount: "amount", date: "date" };
const NAMES = new Map(); // lower-case name -> group
for (const n of AGGREGATES) NAMES.set(n, "Aggregate");
for (const n of Object.keys(LOGIC)) NAMES.set(n, "Logic");
for (const n of TEXT) NAMES.set(n, "Text");
for (const n of DATE) NAMES.set(n, "Date");

const upper = (n) => n.toUpperCase();

function signatureOf(name) {
  if (LOGIC[name]) return LOGIC[name].sig;
  const agg = FUNCTIONS[name];
  if (agg) return `${upper(name)}(${agg.fraction ? "number, p" : "value"})`;
  const row = ROW_FUNCTIONS[name];
  const parts = row.args.map((a) => WORD[a] ?? a);
  if (row.max) parts.push("…");
  return `${upper(name)}(${parts.join(", ")})`;
}
function argumentsOf(name) {
  if (LOGIC[name]) return LOGIC[name].sig.replace(/^[^(]*\(/, "").replace(/\)$/, "");
  const agg = FUNCTIONS[name];
  if (agg) return agg.fraction ? "number, p (a number 0 to 1)" : `a ${agg.accepts.join(", ")} value`.replace(/, (\w+)$/, " or $1");
  return ROW_FUNCTIONS[name].args.map((a) => WORD[a] ?? a).join(", ");
}
function resultOf(name) {
  if (LOGIC[name]) return LOGIC[name].result;
  const agg = FUNCTIONS[name];
  if (agg) return agg.result ?? "same type as its argument";
  return ROW_FUNCTIONS[name].result;
}

/** One entry per function, in group order. `insert` is what the autocomplete / the help list puts at the caret. */
export const FUNCTION_HELP = Object.freeze([...NAMES].map(([name, group]) => Object.freeze({
  name: upper(name), group, signature: signatureOf(name), arguments: argumentsOf(name), result: resultOf(name),
  summary: TEXTS[name]?.[0] ?? "", example: TEXTS[name]?.[1] ?? "", note: TEXTS[name]?.[2] ?? "",
  insert: LOGIC[name]?.insert ?? `${upper(name)}(`,
})));

/** Names that exist in the type tables (plus the logic list) — what the consistency test compares FUNCTION_HELP against. */
export const CATALOG_NAMES = Object.freeze([...Object.keys(FUNCTIONS), ...Object.keys(ROW_FUNCTIONS), ...Object.keys(LOGIC)].map(upper));
/** Names in `TEXTS` with no entry in the tables (a typo guard for the test). */
export const TEXT_NAMES = Object.freeze(Object.keys(TEXTS).map(upper));

/** Entries matching `query` (case-insensitive substring of the name, signature, summary or group); everything when empty. */
export function searchHelp(query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q === "") return FUNCTION_HELP.slice();
  return FUNCTION_HELP.filter((h) => `${h.name} ${h.group} ${h.summary} ${h.signature}`.toLowerCase().includes(q));
}

/** Entries grouped for display: `[{ group, items }]` in GROUPS order, skipping empty groups. */
export function groupHelp(entries) {
  return GROUPS.map((group) => ({ group, items: entries.filter((h) => h.group === group) })).filter((g) => g.items.length);
}

/** Function-name autocomplete items for a typed prefix (case-insensitive, name starts with it), at most `max`. */
export function functionItems(prefix, max) {
  const p = String(prefix ?? "").toLowerCase();
  if (p === "") return [];
  return FUNCTION_HELP.filter((h) => h.name.toLowerCase().startsWith(p)).slice(0, max)
    .map((h) => ({ label: h.name, insert: h.insert, kind: "function", hint: h.signature }));
}
