---
components: []
---
# Decisions — calculation logic

Continues [decisions-platform.md](decisions-platform.md). This file holds D75–D77 (`NULL`, `IN` / `BETWEEN`, keyword `IF`), D78 (`MAKEDATE`, `DATENAME`), D93 (`FISCALYEAR`, `FISCALQUARTER`) and D101 (date literal, `IN` over dates, boolean `=`). Behaviour:
[calculated-fields-formulas.md](../concepts/worksheet/calculated-fields-formulas.md#logic-functions). Edit an entry in place when it changes.

### D75 — `NULL` has no type of its own; it takes the type of the results beside it
`NULL` is a leaf node (`{ "k": "null" }`) whose internal type is `null`. Where it may stand is the whole rule:
- **Allowed** as a `THEN` / `ELSE` result of `IF` / `CASE`, and as either side of `IFNULL`. It takes the type of the first
  non-`NULL` result (`IF c THEN 'x' ELSE NULL END` is text; `CASE WHEN c THEN NULL WHEN d THEN 1 END` is a number).
- **Refused** everywhere else, by the type table's ordinary messages (`Arithmetic needs numbers — NULL is null.`).
  A formula that is only `NULL`, or whose results are all `NULL`, has no type (`NULL needs another value to take its type
  from — use it as an IF, CASE or IFNULL result.`).
- **`x = NULL` is refused**, not answered `NULL`: it can never match, so the message points at `ISNULL(value)`.
- **Why:** a calculation's type decides its role (dimension or measure) and the checks on every consumer. An untyped value
  would leak into arithmetic and aggregates, where it has no meaning. This is the smallest rule that gives `ELSE NULL` its
  usual use (leave a row out of a group) and is checked identically on both sides.
- **Rejected:** a `NULL` that fits any slot (every consumer needs an "unknown type" branch); casting it to a chosen type
  (`CAST(NULL AS text)` syntax for a convenience).

`TRUE` / `FALSE` are boolean literals (`{ "k": "bool", "v": true }`). They compile to the fixed SQL keywords `true` / `false`,
and `NULL` to `NULL`, since nothing the user typed reaches the SQL. A boolean compares with `=` / `!=` only against another
boolean ([D101](#d101--a-date-literal-is-hash-delimited-in-over-dates-and-a-boolean-compares-with--and-)); these literals are for `IF` results, `AND` / `OR` and that comparison.

### D76 — `IN` is a list node of bound literals, at most 50; `BETWEEN` is two comparisons
- `x IN (a, b, …)` is `{ "k": "in", arg, list }`; `NOT IN` wraps it in `not`. The list holds number or text literals (a
  negated number counts), written in the formula, 1 to `CALC_LIMITS.inList` (50, `CalcLimits.MaxInList`), all of the
  value's type; the value is a number or text. Every list value is a bound parameter. A `[@Parameter]` works because it is
  replaced by a literal first; a date parameter is not a list value.
- Anything else is a 400, never clamped: no values or more than 50 (`IN takes 1 to 50 values.`, at `….calc.list`), a field or
  expression in the list (`….calc.list.<i>`), a mixed type, a date value.
- **Why a node, not ORs:** a chain of `=` joined by `OR` nests as deep as the list is long and would hit the depth limit at
  about ten values. The list node costs one level.
- **`BETWEEN`** is parser sugar for `x >= a AND x <= b` (ends included; `NOT BETWEEN` wraps it in `not`), so it adds no wire
  node and inherits the comparison rules (number, text or date; never a mix). `x` is written twice in the tree and
  counts twice against the node limit.
- **Rejected:** a list read from a field or a subquery (not bounded, not bindable). `IN` over a date was rejected here and is
  built in [D101](#d101--a-date-literal-is-hash-delimited-in-over-dates-and-a-boolean-compares-with--and-).

### D77 — The keyword `IF` is another spelling of `CASE WHEN`
`IF c THEN a [ELSEIF d THEN b]… [ELSE e] END` parses to the same `case` node as `IF(c, a, e)`, `IIF` and `CASE WHEN`, so
the server, the compiler and the workbook see nothing new. `IF (c) THEN …` starts like the function, so the parser decides the form from the tokens, without backtracking: a comma at
depth 1 of the parentheses (or an unclosed one) is the function; anything else is the keyword form. **Rejected:** trying the
function and retrying as the keyword form on failure: it re-parses nested `IF (…) THEN` twice per level, so 22 levels took
44 s and the 500-character limit allows about 30. The cost now is one token scan per `IF (`.
- No `ELSE` gives NULL, like `CASE`. `ELSEIF` after `ELSE` is a parse error.

### D78 — `MAKEDATE` is NULL unless the date exists; `DATENAME` is English
- **`MAKEDATE(y, m, d)`** takes three number expressions. The engine's `makeDate32` rolls 30 Feb over to 1 Mar and gives
  1970-01-01 for month 13 or day 0, so the compiler guards it: whole numbers, year 1901 to 2298 (inside the `DATEADD`
  window), month 1 to 12, day 1 to 31, and the built date's day equals the day asked for. Anything else, or a NULL part, is
  NULL. **Rejected:** a bad date as an error (the values are data, not the formula); clamping to the month end.
- **`DATENAME(part, d)`** takes `'weekday'` or `'month'` and always answers in English: `dateName` does not read the server
  locale, so the same workbook reads the same everywhere. Other parts are refused (`YEAR`, `MONTH` already give numbers).
- **`DATETRUNC`** returns one `DateTime64` type for every unit, so results of different units can share an `IF`.

### D93 — `FISCALYEAR` and `FISCALQUARTER` take a literal start month
- **`FISCALYEAR(s, d)` / `FISCALQUARTER(s, d)`** take the month the fiscal year starts (`s`, a literal whole number 1 to 12,
  validated on both sides and bound as an `Int32`) and a date. They answer numbers, so they group, filter and sort like
  `YEAR` and `QUARTER`. Fiscal calendars are not a workbook setting: the start month is written where it is used.
- **The year is named by the calendar year it ends in** (start month 10: 15 Oct 2024 is fiscal 2025), the common
  convention; start month 1 is the calendar year. **Rejected:** naming by the start year (reads as the wrong year for a
  fiscal year that is mostly the next one); a start month from a field (the unit and amount rule: literals only).

### D101 — A date literal is hash-delimited; `IN` over dates; and a boolean compares with `=` and `!=`
- **`#2024-01-31#`** is a literal of its own node (`{ "k": "date", "v": "2024-01-31" }`, type date, a constant). Hash is the delimiter
  because it can't start any other token (a bare `2024-01-31` is arithmetic; `'2024-01-31'` is text) and costs no new keyword.
  The parser checks only the shape (`yyyy-mm-dd` between the hashes); the type checker, identical on both sides, demands a real
  calendar day from **1970-01-01 to 2149-06-06** — exactly what a ClickHouse `Date` holds — so there is no wrap-around and no
  silent clamp: anything else is a 400 at the node (`CalcLimits.MinDate` / `MaxDate`, `DATE_LITERAL_MIN` / `_MAX`).
- **Compiled to `toDate({p:String})`**: the value is a validated 10-character string bound as data, read by the engine's own
  function, which is the type `DATE('…')` already answers. Nothing the user typed reaches the SQL. **Rejected:** a `{p:Date}`
  parameter (the driver's formatting of a date-typed parameter is one more moving part; every other bound text is a `String`
  parameter); `Date32` (a second date type next to `DATE()`'s).
- **`IN` takes date literals** (`x IN (#2024-01-01#, #2024-02-29#)`): the value may now be a date, the list holds `date` nodes
  of the same type, still 1 to 50, never a field, `DATE()` call or expression. The messages say "number, text or date".
- **A boolean compares with `=` and `!=`** against a boolean (a field, `TRUE` / `FALSE`, a comparison, `ISNULL`); `<` `<=` `>` `>=`
  on a boolean keep the old refusal, and a boolean against another type is the ordinary type-mismatch message. The SQL is the
  plain comparison; a NULL side gives NULL like any comparison. **Why now:** with `TRUE` / `FALSE` literals (D75) the refusal only
  forced `[flag]` / `NOT [flag]`, which reads worse beside a `= 'x'` list of conditions.
- **Not built:** an `IN` list read from a field or another source (needs a subquery; stays in the
  [backlog](../development/backlog/calculations.md)), and a date `[@Parameter]` as a literal or list value (it still becomes
  `DATE(text)`, which is not a list value).
