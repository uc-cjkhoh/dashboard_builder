"""Translate one SQL query between MySQL and ClickHouse (the Edit SQL dialog's dialect switch, D106).

Reads one JSON object on stdin: {"sql": "...", "from": "mysql", "to": "clickhouse"}.
Writes one JSON object on stdout:
  {"ok": true, "sql": "...", "warnings": ["..."], "changes": ["case-fold", ...]}
  {"ok": false, "kind": "parse" | "unsupported" | "error" | "missing", "error": "...", "errors": [{"line": 1, "col": 5, "start": 0, "message": "..."}]}
"changes" names the repairs that make the ClickHouse query MEAN something other than the same text read as ClickHouse, so a caller can tell that turning
ClickHouse text into MySQL and back would not give the original back (form-only repairs are not listed).
MySQL -> ClickHouse is parsed, repaired for the places sqlglot's own output would be wrong or silently different (see `mysql_to_clickhouse`), then
generated. sqlglot (MIT, vendored in ./vendor) does the work; this file only adapts its answers. It reads nothing but stdin, opens no network
connection and runs no SQL. It is started by ClickHouse/SqlTranslator.cs with `python3 -I` (isolated: no PYTHON* variables, no user site).
"""
import json
import logging
import os
import re
import sys

logging.getLogger("sqlglot").setLevel(logging.CRITICAL)  # sqlglot logs "unsupported" notes to stderr; nobody reads them, and a full pipe would stall the script

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))

DIALECTS = {"mysql", "clickhouse"}


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def plain(description):
    """sqlglot's messages name its own classes; say the same thing in words a person can use."""
    d = description or ""
    if "Required keyword" in d or "missing for" in d:
        return "The query looks unfinished here: something is missing."
    if "Invalid expression" in d or "Unexpected token" in d:
        return "Unexpected word or symbol here."
    d = re.sub(r"<class '[^']*'>", "this part", d).strip()
    return d or "This query could not be read."


# MySQL interval units that ClickHouse has under the same name.
UNITS = {"MICROSECOND", "SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "QUARTER", "YEAR"}
# MySQL compound interval units: the parts a value like '1 02:03' stands for, in order. The whole value is added at once in MySQL, so it becomes ONE interval
# of the smallest whole unit (months, or seconds) rather than several additions (which would clamp the end of a month more than once).
COMPOUND = {
    "YEAR_MONTH": (("YEAR", 12), ("MONTH", 1), "MONTH"),
    "DAY_HOUR": (("DAY", 86400), ("HOUR", 3600), "SECOND"),
    "DAY_MINUTE": (("DAY", 86400), ("HOUR", 3600), ("MINUTE", 60), "SECOND"),
    "DAY_SECOND": (("DAY", 86400), ("HOUR", 3600), ("MINUTE", 60), ("SECOND", 1), "SECOND"),
    "HOUR_MINUTE": (("HOUR", 3600), ("MINUTE", 60), "SECOND"),
    "HOUR_SECOND": (("HOUR", 3600), ("MINUTE", 60), ("SECOND", 1), "SECOND"),
    "MINUTE_SECOND": (("MINUTE", 60), ("SECOND", 1), "SECOND"),
}
INTEGER = re.compile(r"^-?\d+$")
# Text that is really a number or a date/time: converting the other side of a comparison to text would break it, so such literals are never case-folded.
NUMBER_LIKE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^0[xX][0-9a-fA-F]+$")
DATE_LIKE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$")
STRICT_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STRICT_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$")
STRICT_DATETIME_FRAC = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d+$")

# DATE_FORMAT codes that ClickHouse's formatDateTime (MySQL-style) prints exactly as MySQL does (checked on a 26.8 server against MySQL's documented output).
FORMAT_DIRECT = set("abdefHhIijMmpSsTWwYy%")
# The ones that differ get an expression instead (week numbers use toWeek / toYearWeek, whose modes are MySQL's WEEK() modes).
# STR_TO_DATE codes that ClickHouse's parseDateTime reads like MySQL (%y is refused: years 70-99 come out NULL, MySQL reads them as 19xx).
PARSE_OK = set("abcdeHhIijklMmpSsWY%")
PARSE_TIME = set("HhIiklpSsTr")
PARSE_REFUSED = {
    "D": "the day with a suffix (1st, 2nd)", "f": "fractions of a second", "U": "week numbers", "u": "week numbers", "V": "week numbers", "v": "week numbers",
    "w": "the weekday number", "X": "the year of a week number", "x": "the year of a week number",
    "y": "a two-digit year (ClickHouse reads 70-99 as NULL, MySQL as 1970-1999)",
}
MAX_PAIRS = 6  # column = column comparisons examined for case-folding per query
# Hints and modifiers that do not change what a SELECT returns.
DROPPED_MODIFIERS = {"SQL_CALC_FOUND_ROWS", "SQL_NO_CACHE", "SQL_CACHE", "SQL_SMALL_RESULT", "SQL_BIG_RESULT", "SQL_BUFFER_RESULT", "HIGH_PRIORITY", "STRAIGHT_JOIN"}

# Function names MySQL has (what the ClickHouse -> MySQL display may print). Anything else sqlglot prints (TODATE, UNIQEXACT, APPROX_DISTINCT, EXPLODE, TRANSFORM...) is
# a ClickHouse function or another database's name: the query is refused instead of shown with a name MySQL would not know.
MYSQL_FUNCTIONS = set("""
ABS ACOS ADDDATE ANY_VALUE ASCII ASIN ATAN ATAN2 AVG BIT_AND BIT_COUNT BIT_LENGTH BIT_OR BIT_XOR CAST CEIL CEILING CHAR_LENGTH CHARACTER_LENGTH COALESCE CONCAT CONCAT_WS CONVERT COS COT
COUNT CURDATE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURTIME DATABASE DATE DATE_ADD DATE_FORMAT DATE_SUB DATEDIFF DAY DAYNAME DAYOFMONTH DAYOFWEEK DAYOFYEAR DEGREES ELT EXP EXTRACT
FIELD FIND_IN_SET FLOOR FROM_DAYS FROM_UNIXTIME GREATEST GROUP_CONCAT HEX HOUR IF IFNULL INSTR ISNULL LAST_DAY LCASE LEAST LEFT LENGTH LN LOCATE LOG LOG10 LOG2 LOWER LPAD LTRIM MAX MD5 MID
MIN MINUTE MOD MONTH MONTHNAME NOW NULLIF OCTET_LENGTH PI POSITION POW POWER QUARTER RADIANS RAND REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR REPEAT REPLACE REVERSE RIGHT ROUND RPAD RTRIM
SECOND SHA1 SHA2 SIGN SIN SPACE SQRT STD STDDEV STDDEV_POP STDDEV_SAMP STR_TO_DATE STRCMP SUBDATE SUBSTR SUBSTRING SUBSTRING_INDEX SUM TAN TIMESTAMP TIMESTAMPADD TIMESTAMPDIFF TO_DAYS
TRIM TRUNCATE UCASE UNHEX UNIX_TIMESTAMP UPPER UUID VAR_POP VAR_SAMP VARIANCE VERSION WEEK WEEKDAY WEEKOFYEAR YEAR YEARWEEK
ROW_NUMBER RANK DENSE_RANK PERCENT_RANK CUME_DIST NTILE LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE
""".split())
# Words that start ClickHouse-only syntax: found in the text outside quotes and comments.
# ClickHouse functions that share a name with a MySQL function but mean something else (ASCII-only upper / lower, NULL-giving concat_ws, DAYOFWEEK from Monday, raw-byte SHA1,
# addDate with an interval, timestamp()). The MySQL -> ClickHouse direction maps those names to ClickHouse's own forms, so these would not come back as they went: refused here.
CH_NAME_CLASH = re.compile(r"\b(upper|lower|concat_ws|dayofweek|sha1|timestamp|adddate|subdate)\s*\(", re.I)
CH_ONLY_SYNTAX = re.compile(r"\b(ARRAY\s+JOIN|WITH\s+TOTALS|WITH\s+FILL|GLOBAL|PREWHERE|FINAL|SAMPLE|SETTINGS|INTO\s+OUTFILE|FORMAT)\b", re.I)


class Refusal(Exception):
    """A MySQL query that must not be translated: ambiguous or without a faithful ClickHouse form. `errors` places it in the text when it can."""

    def __init__(self, message, kind="unsupported", errors=None):
        super().__init__(message)
        self.kind, self.errors = kind, errors or []


def mysql_to_clickhouse(sql, sqlglot, ErrorLevel, fold_pairs=()):
    """Translate one MySQL query for ClickHouse. Where sqlglot's plain output would run but mean something else, the text is refused or repaired:

    * `||` is OR in MySQL's default mode and concatenation in ClickHouse: refused, so nobody gets 0/1 where they wanted text (write OR or CONCAT()).
    * `@var`, `@@var` have no ClickHouse equivalent: refused, at their position.
    * DATEDIFF(a, b) is a - b in days: dateDiff('day', b, a), the order ClickHouse takes. TIMESTAMPDIFF counts whole units (b - a, truncated toward zero):
      age('unit', a, b) for DAY..YEAR, elapsed seconds for SECOND/MINUTE/HOUR (age('hour') is WRONG on ClickHouse 26.8: 10:00 -> 12:30 gave 3), dateDiff('microsecond').
    * DATE_ADD / DATE_SUB(d, INTERVAL n unit): d +/- INTERVAL n unit (n a number) or toIntervalUnit(n) (n an expression); a compound unit (YEAR_MONTH,
      DAY_HOUR, ...) is ONE interval of months or seconds, as MySQL adds it. Date-like text operands become toDate / toDateTime.
    * DATE_FORMAT(d, fmt) and FROM_UNIXTIME(n, fmt): sqlglot rewrites the codes into another style (%i -> %M, which ClickHouse reads as the MONTH NAME), so the
      MySQL text is kept (parser subclass) and rebuilt: codes ClickHouse prints like MySQL go through formatDateTime, the rest become expressions (%c %l %D %r %U %u %V %v %X %x).
    * STR_TO_DATE(s, fmt): parseDateTimeOrNull (NULL on a bad text, as MySQL), a Date for a date-only format, a DateTime otherwise; a few codes are refused.
    * UNIX_TIMESTAMP, LAST_DAY, JSON_UNQUOTE(JSON_EXTRACT()), ->> and JSON_VALUE are translated (the JSON ones keep numbers, booleans, null and a missing key apart);
      JSON_EXTRACT and -> give NULL for a missing key (JSONExtractRaw gives '', which is not NULL). A text that is not JSON gives NULL here; MySQL raises an error.
    * LIKE becomes ILIKE (MySQL's default collation ignores case); LIKE ... ESCAPE c becomes the backslash escapes ClickHouse has.   [changes: ilike]
    * `=`, `!=` and IN against a text literal ignore case in MySQL and not in ClickHouse: lowerUTF8(toString(x)) = lowerUTF8('lit').   [changes: case-fold]
    * a DIV 0 is NULL in MySQL: the divisor of DIV is wrapped in nullIf(..., 0) (sqlglot already does it for `/` and `%`).   [changes: div-null]
    * ORDER BY keeps MySQL's NULL-first order (sqlglot adds NULLS FIRST).   [changes: nulls-first]
    * `col = col` / `col != col` between two columns: whether it needs the case-folding above depends on the columns' types, which this script cannot know (it reads
      nothing). It lists each such pair as a candidate (`probes`: a query that describes the two columns); the caller asks ClickHouse for their types and calls again with
      `fold_pairs` = the ids whose columns are both text, and those are folded like a comparison with a text literal.   [changes: case-fold]
    * SQL_CALC_FOUND_ROWS, SQL_NO_CACHE, USE/FORCE/IGNORE INDEX and a SELECT-level STRAIGHT_JOIN are dropped (they do not change the result); a STRAIGHT_JOIN
      join is an INNER (or CROSS) join; FOR UPDATE / FOR SHARE is dropped with a note (ClickHouse has no row locks).
    """
    from sqlglot import exp
    from sqlglot.dialects.dialect import Dialect
    from sqlglot.dialects.mysql import MySQL
    from sqlglot.tokens import TokenType

    # --- user variables: no ClickHouse equivalent ---------------------------------------------------------------------------------------------------------
    tokens = Dialect.get_or_raise("mysql").tokenize(sql)
    for i, tok in enumerate(tokens):
        if tok.token_type == TokenType.DPIPE:
            raise Refusal("'||' means OR in MySQL but joins text in ClickHouse. Write OR, or CONCAT(a, b) for text.", "parse",
                          [{"line": tok.line, "col": tok.col, "start": tok.col - len(tok.text), "message": "'||' is ambiguous: write OR or CONCAT()."}])
        if tok.token_type in (TokenType.PARAMETER, TokenType.SESSION_PARAMETER) and tok.text in ("@", "@@"):
            name = tokens[i + 1].text if i + 1 < len(tokens) else ""
            what = "System variables (@@" if tok.text == "@@" else "User variables (@"
            msg = f"{what}{name}) have no ClickHouse equivalent. Write the value into the query."
            end = tokens[i + 1].col if i + 1 < len(tokens) else tok.col
            raise Refusal(msg, "parse", [{"line": tok.line, "col": end, "start": tok.col - len(tok.text), "message": msg}])

    # --- parse: MySQL's date format functions are kept as plain calls with the original format text -------------------------------------------------------
    original_from_unixtime = MySQL.Parser.FUNCTIONS["FROM_UNIXTIME"]
    raw = {"DATE_FORMAT": "MYSQL_DATE_FORMAT", "STR_TO_DATE": "MYSQL_STR_TO_DATE", "TIME_FORMAT": "MYSQL_TIME_FORMAT", "BIN": "MYSQL_BIN"}

    def keep(name):
        return lambda args: exp.Anonymous(this=name, expressions=args)

    class MySQLRaw(MySQL):
        class Parser(MySQL.Parser):
            FUNCTIONS = {**MySQL.Parser.FUNCTIONS, **{k: keep(v) for k, v in raw.items()},
                         "FROM_UNIXTIME": lambda args, dialect: exp.Anonymous(this="MYSQL_FROM_UNIXTIME", expressions=args) if len(args) == 2 else original_from_unixtime(args, dialect)}

    trees = [t for t in sqlglot.parse(sql, read=MySQLRaw()) if t]
    if len(trees) != 1:
        raise Refusal("Only one query can be translated.", "parse")
    warnings, changes = [], []

    A = lambda name, *args: exp.Anonymous(this=name, expressions=list(args))  # a ClickHouse function call, name kept as written
    S = exp.Literal.string
    N = exp.Literal.number

    def note(text):
        if text not in warnings:
            warnings.append(text)

    # --- small predicates and builders --------------------------------------------------------------------------------------------------------------------
    def is_text(node):
        """A quoted text with letters that is not a number or a date/time: the kind of literal whose comparison MySQL does without regard to case."""
        return (isinstance(node, exp.Literal) and node.is_string and any(c.isalpha() for c in node.this)
                and not NUMBER_LIKE.match(node.this.strip()) and not DATE_LIKE.match(node.this.strip()))

    def foldable(node):
        """The other side of a comparison: anything but a literal, NULL or a subquery (whose type we cannot know)."""
        return not isinstance(node, (exp.Literal, exp.Null, exp.Subquery, exp.Select))

    def lowered(node):
        return isinstance(node, exp.Lower) or (isinstance(node, exp.Anonymous) and node.name == "lowerUTF8")

    def fold(node):
        """lowerUTF8(toString(x)): the same text whatever the column's type, compared without regard to case (LOWER(x) is already lower-cased text)."""
        if isinstance(node, exp.Lower) or (isinstance(node, exp.Anonymous) and node.name == "lowerUTF8"):
            return node
        return A("lowerUTF8", A("toString", node))

    def nonzero_literal(node):
        """A number written in the query that is not zero (-2 too): dividing by it needs no nullIf, and keeps the column from becoming Nullable."""
        if isinstance(node, exp.Neg):
            node = node.this
        if isinstance(node, exp.Paren):
            node = node.this
        try:
            return isinstance(node, exp.Literal) and not node.is_string and float(node.this) != 0
        except ValueError:
            return False

    def when(node):
        """A date-like text literal as a ClickHouse date value (MySQL takes the text as it is; ClickHouse's date functions refuse text)."""
        if isinstance(node, exp.Literal) and node.is_string:
            t = node.this.strip()
            if STRICT_DATE.match(t):
                return A("toDate", node)
            if STRICT_DATETIME.match(t):
                return A("toDateTime", node)
            if STRICT_DATETIME_FRAC.match(t):
                return A("toDateTime64", node, N(6))
        return node

    def unit_of(node, what, allowed=UNITS):
        u = node.args.get("unit")
        name = (u.name if u is not None else "").upper()
        if name not in allowed:
            raise Refusal(f"{what} with the unit {name or '?'} has no ClickHouse equivalent.")
        return name

    def interval_of(amount, unit, what):
        """(the amount, the unit) of an interval, as ClickHouse wants it: a number for a literal, toIntervalUnit(...) for an expression; compound units become one."""
        unit = (unit.name if unit is not None else "").upper()
        if unit in COMPOUND:
            *parts, base = COMPOUND[unit]
            if not (isinstance(amount, exp.Literal)):
                raise Refusal(f"{what} with the unit {unit} needs the amount written as text such as '1-2'.")
            text = amount.this.strip()
            sign = -1 if text.startswith("-") else 1
            digits = [int(x) for x in re.findall(r"\d+", text)]
            if not digits or len(digits) > len(parts):
                raise Refusal(f"{what}: '{text}' does not fit the unit {unit}.")
            digits = [0] * (len(parts) - len(digits)) + digits  # a short value leaves out the LEFTMOST parts, as in MySQL
            total = sign * sum(d * mult for d, (_, mult) in zip(digits, parts))
            return N(total), base
        if unit not in UNITS:
            raise Refusal(f"{what} with the unit {unit or '?'} has no ClickHouse equivalent.")
        if isinstance(amount, exp.Literal) and INTEGER.match(amount.this):
            return N(int(amount.this)), unit
        if isinstance(amount, exp.Literal):
            raise Refusal(f"{what} needs the amount written as a whole number.")
        return amount, unit

    def interval_node(amount, unit):
        if isinstance(amount, exp.Literal) or (isinstance(amount, exp.Neg) and isinstance(amount.this, exp.Literal)):
            return exp.Interval(this=amount, unit=exp.var(unit))
        return A("toInterval" + unit.title(), amount)

    # --- DATE_FORMAT -----------------------------------------------------------------------------------------------------------------------------------------
    def format_pieces(dt):
        d = lambda: dt.copy()
        day = lambda: A("toDayOfMonth", d())
        hour12 = lambda: A("if", exp.EQ(this=A("modulo", A("toHour", d()), N(12)), expression=N(0)), N(12), A("modulo", A("toHour", d()), N(12)))
        week = lambda mode: A("lpad", A("toString", A("toWeek", d(), N(mode))), N(2), S("0"))
        yearweek = lambda mode: A("toString", A("intDiv", A("toYearWeek", d(), N(mode)), N(100)))
        suffix = A("multiIf", exp.In(this=day(), expressions=[N(11), N(12), N(13)]), S("th"),
                   exp.EQ(this=A("modulo", day(), N(10)), expression=N(1)), S("st"), exp.EQ(this=A("modulo", day(), N(10)), expression=N(2)), S("nd"),
                   exp.EQ(this=A("modulo", day(), N(10)), expression=N(3)), S("rd"), S("th"))
        return {
            "c": A("toString", A("toMonth", d())), "k": A("toString", A("toHour", d())), "l": A("toString", hour12()),
            "D": A("concat", A("toString", day()), suffix), "r": A("formatDateTime", d(), S("%I:%i:%S %p")),
            "U": week(0), "u": week(1), "V": week(2), "v": week(3), "X": yearweek(2), "x": yearweek(3),
        }

    def date_format(dt, fmt):
        """formatDateTime / concat(...) over `dt` for a MySQL format text (an unknown code stands for itself, as in MySQL)."""
        if not (isinstance(fmt, exp.Literal) and fmt.is_string):
            raise Refusal("DATE_FORMAT needs the format written as text.")
        text, pieces = fmt.this, format_pieces(dt)
        parts, cur, i = [], "", 0
        while i < len(text):
            c = text[i]
            if c != "%" or i + 1 >= len(text):
                cur += "%%" if c == "%" else c
                i += 1
                continue
            spec = text[i + 1]
            i += 2
            if spec in FORMAT_DIRECT:
                cur += "%" + spec
            elif spec in pieces:
                if cur:
                    parts.append(A("formatDateTime", dt.copy(), S(cur)))
                    cur = ""
                parts.append(pieces[spec])
            else:
                cur += spec  # MySQL prints an unknown code's letter
        if cur:
            parts.append(A("formatDateTime", dt.copy(), S(cur)))
        if not parts:
            return S("")
        return parts[0] if len(parts) == 1 else A("concat", *parts)

    # --- STR_TO_DATE -----------------------------------------------------------------------------------------------------------------------------------------
    LENIENT = {"m": "c", "d": "e", "H": "k", "h": "l", "I": "l"}  # the codes that read one or two digits (MySQL's %m reads '3' and '03'; ClickHouse's %m needs '03')

    def str_to_date(value, fmt):
        if not (isinstance(fmt, exp.Literal) and fmt.is_string):
            raise Refusal("STR_TO_DATE needs the format written as text.")
        text, items, has_time, i = fmt.this, [], False, 0  # items: ("lit", text) or ("code", letter)
        while i < len(text):
            c = text[i]
            if c != "%" or i + 1 >= len(text):
                items.append(("lit", "%%" if c == "%" else c))
                i += 1
                continue
            spec = text[i + 1]
            i += 2
            if spec == "r":
                items += [("code", "h"), ("lit", ":"), ("code", "i"), ("lit", ":"), ("code", "s"), ("lit", " "), ("code", "p")]
                has_time = True
            elif spec == "T":
                items += [("code", "H"), ("lit", ":"), ("code", "i"), ("lit", ":"), ("code", "s")]
                has_time = True
            elif spec in PARSE_OK:
                items.append(("code", spec))
                has_time = has_time or spec in PARSE_TIME
            elif spec in PARSE_REFUSED:
                raise Refusal(f"STR_TO_DATE with %{spec} ({PARSE_REFUSED[spec]}) has no ClickHouse equivalent.")
            else:
                raise Refusal(f"STR_TO_DATE with %{spec} is not translated.")
        if has_time and not any(kind == "code" and v in "YmcdeMbj" for kind, v in items):
            raise Refusal("STR_TO_DATE with only a time has no ClickHouse equivalent (MySQL answers a TIME; ClickHouse has no such type). Add the date part.")
        out_fmt, strict = "", False
        for k, (kind, v) in enumerate(items):
            if kind == "lit":
                out_fmt += v
                continue
            alone = (k == 0 or items[k - 1][0] == "lit") and (k == len(items) - 1 or items[k + 1][0] == "lit")  # no other code touches it, so its width can vary
            if v in LENIENT and alone:
                out_fmt += "%" + LENIENT[v]
            else:
                out_fmt += "%" + v
                strict = strict or v in "mdHhIisS"
        if strict:
            note("STR_TO_DATE: ClickHouse needs zero-padded numbers for %i %s %S, and for %m %d %H %h %I when another code follows it directly (MySQL also reads 2024-3-5, 7:5); text that does not match gives NULL.")
        parsed = A("parseDateTimeOrNull", value, S(out_fmt))
        return parsed if has_time else A("toDate", parsed)

    # --- JSON ------------------------------------------------------------------------------------------------------------------------------------------------
    def json_args(path, what):
        """The key / index arguments of a ClickHouse JSON function for a MySQL path ($.a.b[0]); wildcards, slices and the like are refused."""
        if not isinstance(path, exp.JSONPath):
            raise Refusal(f"{what} needs the path written as text such as '$.name'.")
        args = []
        for step in path.expressions:
            if isinstance(step, exp.JSONPathRoot):
                continue
            if isinstance(step, exp.JSONPathKey):
                args.append(S(step.name) if isinstance(step.this, str) else step.this)
            elif isinstance(step, exp.JSONPathSubscript) and isinstance(step.this, int):
                args.append(N(step.this + 1))  # MySQL counts from 0, ClickHouse from 1
            else:
                raise Refusal(f"{what} with a wildcard, slice or other path step has no ClickHouse equivalent; write each key or index out.")
        if not args:
            raise Refusal(f"{what} needs a path below the root, such as '$.name'.")
        return args

    def json_scalar(doc, path, what):
        """JSON_UNQUOTE(JSON_EXTRACT(doc, path)) / ->> / JSON_VALUE: a text value unquoted, anything else as its JSON text ('2', 'true', 'null'), NULL when the key is missing."""
        args = json_args(path, what)
        c = lambda: doc.copy()
        has = A("JSONHas", c(), *[a.copy() for a in args])
        is_text_value = A("equals", A("JSONType", c(), *[a.copy() for a in args]), S("String"))  # a call, not `=`: the text-comparison repair must not fold it
        return A("if", has, A("if", is_text_value, A("JSONExtractString", c(), *[a.copy() for a in args]), A("JSONExtractRaw", c(), *[a.copy() for a in args])), exp.Null())

    # --- LIKE ... ESCAPE ------------------------------------------------------------------------------------------------------------------------------------
    def like_pattern(pattern, esc):
        """The pattern in ClickHouse's backslash escaping: `esc` before % _ or itself is a literal; a backslash that is not the escape character is an ordinary one."""
        out_p, i = "", 0
        while i < len(pattern):
            c = pattern[i]
            if esc and c == esc and i + 1 < len(pattern):
                n = pattern[i + 1]
                out_p += ("\\" + n) if n in "%_\\" else n
                i += 2
            elif c == "\\":
                out_p += "\\\\" if esc != "\\" else "\\\\"  # a literal backslash is two in ClickHouse; with the escape character '\\' the pattern is already written that way
                i += 1
            else:
                out_p += c
                i += 1
        return out_p


    # --- helpers for the function mappings -------------------------------------------------------------------------------------------------------------------
    def txt(node):
        """`node` as text: a text literal stays, anything else goes through toString (arrays of mixed types, comparisons and joins need one type)."""
        return node.copy() if (isinstance(node, exp.Literal) and node.is_string) else A("toString", node.copy())

    def low(node):
        return A("lowerUTF8", txt(node))

    def either_null(nodes):
        """`isNull(a) OR isNull(b) ...` for the operands that can be NULL (a literal never is); None when none can."""
        cond = None
        for n in nodes:
            if isinstance(n, exp.Literal):
                continue
            test = A("isNull", n.copy())
            cond = test if cond is None else exp.Or(this=cond, expression=test)
        return cond

    def null_if_any_null(nodes, result):
        """MySQL answers NULL when any argument is NULL; ClickHouse's own version of the function often does not."""
        cond = either_null(nodes)
        return result if cond is None else A("if", cond, exp.Null(), result)

    def lam(param, body):
        return exp.Lambda(this=body, expressions=[exp.to_identifier(param)])

    def number_text(node):
        """The text of a numeric literal (a leading minus included), or None."""
        if isinstance(node, exp.Neg) and isinstance(node.this, exp.Literal) and not node.this.is_string:
            return "-" + node.this.this
        if isinstance(node, exp.Literal) and not node.is_string:
            return node.this
        return None

    def decimal_literal(text):
        """An exact decimal for a numeric literal: MySQL treats 2.5 as an exact DECIMAL (ROUND gives 3), ClickHouse as a Float64 (ROUND gives 2)."""
        scale = len(text.split(".")[1]) if "." in text and "e" not in text.lower() else None
        return A("toDecimal128", S(text), N(scale)) if scale is not None and 0 < scale <= 30 else None

    def ci_pattern(pattern):
        """MySQL's REGEXP ignores case by default; RE2 (ClickHouse) is told so with a leading (?i)."""
        if isinstance(pattern, exp.Literal) and pattern.is_string:
            return pattern.copy() if pattern.this.startswith("(?i)") else S("(?i)" + pattern.this)
        return A("concat", S("(?i)"), pattern.copy())

    def date_arg(node):
        return when(node.this if isinstance(node, exp.TsOrDsToDate) and isinstance(node.this, exp.Literal) else node)

    def group_concat(node):
        what = "GROUP_CONCAT"
        value, order, distinct = node.this, [], False
        if isinstance(value, exp.Order):
            order, value = value.expressions, value.this
        if isinstance(value, exp.Distinct):
            distinct = True
            value = value.expressions[0] if len(value.expressions) == 1 else exp.Concat(expressions=[e.copy() for e in value.expressions], safe=True, coalesce=False)
        sep = node.args.get("separator")
        if sep is None:
            sep = S(",")
        if not (isinstance(sep, exp.Literal) and sep.is_string):
            raise Refusal(f"{what} needs the SEPARATOR written as text.")
        if order and len({bool(o.args.get("desc")) for o in order}) > 1:
            raise Refusal(f"{what} with some ORDER BY columns ascending and others descending has no ClickHouse equivalent; sort in a subquery.")
        if distinct and order and any(o.this != value for o in order):
            raise Refusal(f"{what}(DISTINCT … ORDER BY …) can only sort by the value itself here; sort in a subquery.")
        present = A("isNotNull", value.copy())
        if order:
            key = A("tuple", *[part for o in order for part in (A("isNotNull", o.this.copy()), o.this.copy())])  # NULL first when ascending, last when descending, as in MySQL
            items = A("groupArrayIf", A("tuple", txt(value), key), present)
            if distinct:
                items = A("arrayDistinct", items)
            ordered = A("arrayReverseSort" if order[0].args.get("desc") else "arraySort", lam("t", A("tupleElement", exp.column("t"), N(2))), items)
            items = A("arrayMap", lam("t", A("tupleElement", exp.column("t"), N(1))), ordered)
        else:
            items = A("groupArrayIf", txt(value), present)
            if distinct:
                items = A("arrayDistinct", items)
        note("GROUP_CONCAT: MySQL cuts the result at 1024 characters by default (group_concat_max_len); this query does not.")
        changes.append("group-concat")
        return A("if", exp.EQ(this=A("countIf", present.copy()), expression=N(0)), exp.Null(), A("arrayStringConcat", items, sep.copy()))  # no rows with a value: NULL, as in MySQL

    def bt_ok(node):
        """A one-argument function, or LOG with a base of 2 or 10 (the only logarithm forms that go straight to a ClickHouse function)."""
        return not isinstance(node, exp.Log) or number_text(node.args.get("this")) in ("2", "10")

    BITS = {exp.BitwiseAnd: "bitAnd", exp.BitwiseOr: "bitOr", exp.BitwiseXor: "bitXor", exp.BitwiseLeftShift: "bitShiftLeft", exp.BitwiseRightShift: "bitShiftRight"}

    def u64(node):
        return A("toUInt64", node.copy())  # MySQL's bit operators work on unsigned 64-bit numbers (so ~5 is 18446744073709551610)

    # --- the repair of one node ---------------------------------------------------------------------------------------------------------------------------
    def fix(node):
        # ---- common MySQL functions whose plain ClickHouse translation is missing, wrong or silently different ----
        if isinstance(node, exp.ConcatWs):  # skips NULL arguments (sqlglot's COALESCE(x, '') leaves a doubled separator)
            sep, rest = node.expressions[0], node.expressions[1:]
            parts = A("arrayFilter", lam("x", A("isNotNull", exp.column("x"))), exp.Array(expressions=[txt(r) for r in rest]))
            return A("arrayStringConcat", parts, sep.copy())
        if isinstance(node, (exp.Upper, exp.Lower)):  # upper()/lower() in ClickHouse change ASCII letters only
            return A("upperUTF8" if isinstance(node, exp.Upper) else "lowerUTF8", node.this)
        if isinstance(node, exp.RegexpLike):
            flag, mode = node.args.get("flag"), "i"
            if flag is not None:
                if not (isinstance(flag, exp.Literal) and flag.is_string and set(flag.this) <= set("ci")):
                    raise Refusal("REGEXP_LIKE with a match type other than 'c' or 'i' is not translated.")
                mode = flag.this[-1] if flag.this else "i"
            if mode == "i":
                changes.append("regexp-ci")
            return A("match", node.this, ci_pattern(node.expression) if mode == "i" else node.expression)
        if isinstance(node, exp.RegexpReplace):
            if any(node.args.get(k) is not None for k in ("position", "occurrence", "parameters", "modifiers")):
                raise Refusal("REGEXP_REPLACE with a start position, occurrence or match type is not translated.")
            repl = node.args.get("replacement")
            if isinstance(repl, exp.Literal) and repl.is_string:
                repl = S(re.sub(r"\$(\d)", r"\\\1", repl.this))  # MySQL's $1 is ClickHouse's \1
            changes.append("regexp-ci")
            return A("replaceRegexpAll", node.this, ci_pattern(node.expression), repl)
        if isinstance(node, exp.RegexpSubstr):
            if any(node.args.get(k) is not None for k in ("position", "occurrence", "parameters", "group")):
                raise Refusal("REGEXP_SUBSTR with a start position, occurrence or match type is not translated.")
            changes.append("regexp-ci")
            pat = ci_pattern(node.expression)
            return A("if", A("match", node.this.copy(), pat.copy()), A("extract", node.this.copy(), pat), exp.Null())  # no match: NULL (extract gives '')
        if isinstance(node, exp.Round) and node.args.get("this") is not None:
            text = number_text(node.this)
            dec = decimal_literal(text) if text is not None else None
            if dec is not None:
                changes.append("round-half-away")
                return exp.Round(this=dec, decimals=node.args.get("decimals"))
        if isinstance(node, exp.Cast) and isinstance(node.args.get("to"), exp.DataType) and node.args["to"].this in (exp.DType.BIGINT, exp.DType.UBIGINT) and not node.args.get("format"):
            inner = node.this
            text = number_text(inner)
            dec = decimal_literal(text) if text is not None else None
            if dec is not None:  # a decimal literal is rounded, not cut (2.5 is 3)
                changes.append("round-half-away")
                node.set("this", A("round", dec))
                return node
            if not (text is not None or (isinstance(inner, exp.Literal) and inner.is_string)):
                note("CAST(x AS SIGNED): MySQL rounds a decimal number to the nearest whole number (2.5 is 3); ClickHouse cuts the fraction (2.5 is 2).")
        if isinstance(node, (exp.Ln, exp.Log, exp.Sqrt, exp.Asin, exp.Acos)):  # outside their domain MySQL answers NULL; ClickHouse gives -inf or nan
            if isinstance(node, exp.Log):
                base, x = node.args.get("this"), node.args.get("expression")
                bt = number_text(base)
                if bt in ("2", "10"):
                    call, cond = A("log" + bt, x.copy()), exp.GT(this=x.copy(), expression=N(0))
                else:
                    call = A("divide", A("ln", x.copy()), A("ln", base.copy()))
                    cond = exp.And(this=exp.And(this=exp.GT(this=base.copy(), expression=N(0)), expression=exp.NEQ(this=base.copy(), expression=N(1))), expression=exp.GT(this=x.copy(), expression=N(0)))
                subject = x
            else:
                x = node.this
                subject = x
                name = {exp.Ln: "ln", exp.Sqrt: "sqrt", exp.Asin: "asin", exp.Acos: "acos"}[type(node)]
                call = A(name, x.copy())
                cond = (exp.GTE(this=x.copy(), expression=N(0)) if isinstance(node, exp.Sqrt) else exp.GT(this=x.copy(), expression=N(0)) if isinstance(node, exp.Ln)
                        else exp.And(this=exp.GTE(this=x.copy(), expression=N(-1)), expression=exp.LTE(this=x.copy(), expression=N(1))))
            changes.append("math-null")
            sure = number_text(subject)  # a literal needs no run-time guard: inside the domain it is the call, outside it is NULL
            if sure is not None and bt_ok(node):
                v = float(sure)
                inside = v >= 0 if isinstance(node, exp.Sqrt) else -1 <= v <= 1 if isinstance(node, (exp.Asin, exp.Acos)) else v > 0
                return call if inside else exp.Null()
            return A("if", cond, call, exp.Null())
        if isinstance(node, exp.StrPosition):  # LOCATE / INSTR / POSITION ignore case in MySQL
            changes.append("case-fold")
            extra = [node.args["position"]] if node.args.get("position") is not None else []
            return A("positionCaseInsensitiveUTF8", node.this, node.args["substr"], *extra)
        if isinstance(node, exp.BitLength):  # bytes times eight
            return exp.Paren(this=exp.Mul(this=A("length", node.this), expression=N(8)))
        if isinstance(node, exp.Stuff):
            raise Refusal("INSERT(str, pos, len, newstr) is not translated; build it with CONCAT and SUBSTRING.")
        if isinstance(node, (exp.Greatest, exp.Least)):  # NULL when any argument is NULL; ClickHouse ignores NULLs
            args = [node.this, *node.expressions]
            name = "greatest" if isinstance(node, exp.Greatest) else "least"
            cond = either_null(args)
            if cond is None:
                return A(name, *args)
            changes.append("null-aware")
            return A("if", cond, exp.Null(), A(name, *[a.copy() for a in args]))
        if type(node) in BITS:
            changes.append("bit-ops")
            return A(BITS[type(node)], u64(node.this), u64(node.expression))
        if isinstance(node, exp.BitwiseNot):
            changes.append("bit-ops")
            return A("bitNot", u64(node.this))
        if isinstance(node, exp.BitwiseCount):
            changes.append("bit-ops")
            return A("bitCount", u64(node.this))
        if isinstance(node, exp.GroupConcat):
            return group_concat(node)
        if isinstance(node, exp.NumberToStr):
            raise Refusal("FORMAT(number, decimals) is not translated: ClickHouse has no thousands-separator format. Use round() and write the grouping you need.")
        if isinstance(node, exp.SHA):
            return A("lower", A("hex", A("SHA1", node.this)))
        if isinstance(node, exp.SHA2):
            bits = node.args.get("length")
            size = "256" if (isinstance(bits, exp.Literal) and bits.this == "0") else (bits.this if isinstance(bits, exp.Literal) else "")
            if size not in ("224", "256", "384", "512"):
                raise Refusal("SHA2 with a length other than 224, 256, 384 or 512 is not translated.")
            return A("lower", A("hex", A("SHA" + size, node.this)))
        if isinstance(node, exp.Elt):
            items, n = node.expressions, node.this
            inside = exp.And(this=exp.GTE(this=n.copy(), expression=N(1)), expression=exp.LTE(this=n.copy(), expression=N(len(items))))
            return A("if", inside, A("arrayElement", exp.Array(expressions=[txt(i) for i in items]), n.copy()), exp.Null())  # out of range: NULL (arrayElement gives '')
        if isinstance(node, exp.DayOfWeek):  # Sunday = 1 .. Saturday = 7 (ClickHouse's DAYOFWEEK: Monday = 1)
            return exp.Paren(this=exp.Add(this=A("modulo", A("toDayOfWeek", node.this), N(7)), expression=N(1)))
        if isinstance(node, exp.Dayname):
            return A("dateName", S("weekday"), exp.TsOrDsToDate(this=date_arg(node.this)))
        if isinstance(node, exp.TimeToStr) and isinstance(node.args.get("format"), exp.Literal) and node.args["format"].this == "%B":  # MONTHNAME
            return A("dateName", S("month"), node.this)
        if isinstance(node, (exp.Quarter, exp.Hour, exp.Minute, exp.Second)) and date_arg(node.this) is not node.this:
            node.set("this", date_arg(node.this))
            return node
        if isinstance(node, exp.Extract) and date_arg(node.args.get("expression")) is not node.args.get("expression"):
            node.set("expression", date_arg(node.args["expression"]))
            return node
        if isinstance(node, exp.Timestamp):
            if node.args.get("zone") is not None:
                raise Refusal("TIMESTAMP(date, time) with two arguments is not translated.")
            return A("toDateTime", node.this)
        if isinstance(node, exp.TimestampAdd):
            return exp.DateAdd(this=node.this, expression=node.args.get("expression"), unit=node.args.get("unit"))
        if isinstance(node, exp.Paren) and isinstance(node.this, exp.Add) and isinstance(node.this.this, exp.DateDiff) and node.this.expression == N(1):  # TO_DAYS
            diff = node.this.this
            if isinstance(diff.expression, exp.TsOrDsToDate) and diff.expression.this == S("0000-01-01"):
                return exp.Paren(this=exp.Add(this=A("toRelativeDayNum", diff.this), expression=N(719528)))  # days from year 0; ClickHouse counts from 1970
        if isinstance(node, exp.Anonymous):
            lname, largs = node.name.upper(), node.expressions
            if lname == "FIND_IN_SET" and len(largs) == 2:
                changes.append("case-fold")
                found = A("indexOf", A("splitByChar", S(","), low(largs[1])), low(largs[0]))
                return null_if_any_null(largs, found)
            if lname == "FIELD" and len(largs) >= 2:
                if any(isinstance(a, exp.Literal) and a.is_string for a in largs):
                    changes.append("case-fold")
                    return A("indexOf", exp.Array(expressions=[low(a) for a in largs[1:]]), low(largs[0]))
                return A("indexOf", exp.Array(expressions=[a.copy() for a in largs[1:]]), largs[0].copy())
            if lname == "STRCMP" and len(largs) == 2:
                changes.append("case-fold")
                a, b = low(largs[0]), low(largs[1])
                compare = A("multiIf", exp.LT(this=a, expression=b), N(-1), exp.EQ(this=a.copy(), expression=b.copy()), N(0), N(1))
                return null_if_any_null(largs, compare)
            if lname == "MYSQL_BIN" and len(largs) == 1:  # ClickHouse's bin() pads to whole bytes ('00000101'); MySQL's does not ('101')
                bits = A("replaceRegexpOne", A("bin", A("toUInt64", largs[0].copy())), S("^0+"), S(""))
                return A("if", exp.EQ(this=largs[0].copy(), expression=N(0)), S("0"), bits)
            if lname == "WEEKDAY" and len(largs) == 1:  # Monday = 0
                return exp.Paren(this=exp.Sub(this=A("toDayOfWeek", exp.TsOrDsToDate(this=date_arg(largs[0]))), expression=N(1)))
            if lname in ("ADDDATE", "SUBDATE") and len(largs) == 2:
                cls = exp.DateAdd if lname == "ADDDATE" else exp.DateSub
                if isinstance(largs[1], exp.Interval):
                    return cls(this=largs[0], expression=largs[1].this, unit=largs[1].args.get("unit"))
                return cls(this=largs[0], expression=largs[1], unit=exp.var("DAY"))
        if isinstance(node, exp.Anonymous):
            name = node.name.upper()
            args = node.expressions
            if name == "MYSQL_DATE_FORMAT" and len(args) == 2:
                return date_format(when(args[0]), args[1])
            if name == "MYSQL_STR_TO_DATE" and len(args) == 2:
                return str_to_date(args[0], args[1])
            if name == "MYSQL_FROM_UNIXTIME" and len(args) == 2:
                return date_format(A("toDateTime", args[0]), args[1])
            if name == "MYSQL_TIME_FORMAT":
                raise Refusal("TIME_FORMAT is not translated: ClickHouse has no TIME type. Use DATE_FORMAT on a date and time.")
            if name == "UNIX_TIMESTAMP":
                if not args:
                    return A("toUnixTimestamp", A("now"))
                if len(args) == 1:
                    return A("toUnixTimestamp", A("toDateTime", args[0]))  # a Date means midnight in the session time zone, as in MySQL (a bare Date would be UTC midnight)
            if name == "JSON_UNQUOTE" and len(args) == 1 and isinstance(args[0], exp.JSONExtract):
                return json_scalar(args[0].this, args[0].args.get("expression"), "JSON_UNQUOTE(JSON_EXTRACT())")
        if isinstance(node, exp.JSONExtract) and not node.args.get("expressions"):
            args = json_args(node.args.get("expression"), "JSON_EXTRACT")
            return A("if", A("JSONHas", node.this.copy(), *[a.copy() for a in args]), A("JSONExtractRaw", node.this.copy(), *[a.copy() for a in args]), exp.Null())
        if isinstance(node, exp.JSONExtractScalar):
            return json_scalar(node.this, node.args.get("expression"), "->>")
        if isinstance(node, exp.JSONValue):
            if node.args.get("returning"):
                raise Refusal("JSON_VALUE ... RETURNING has no ClickHouse equivalent.")
            return json_scalar(node.this, node.args.get("path"), "JSON_VALUE")
        if isinstance(node, exp.LastDay):
            return A("toLastDayOfMonth", when(node.this))
        if isinstance(node, exp.DateDiff) and node.args.get("unit") is None:  # MySQL DATEDIFF(a, b): this = a, expression = b
            return A("dateDiff", S("day"), when(node.args["expression"]), when(node.args["this"]))
        if isinstance(node, (exp.Lag, exp.Lead, exp.NthValue)):
            # A value that does not exist (LAG on the first row, LEAD on the last, NTH_VALUE before the n-th row) is NULL in MySQL; ClickHouse answers the type's zero ('' / 0) unless
            # the argument is Nullable. An explicit default (LAG(x, 1, 0)) is kept as it is.
            default = node.args.get("default")
            explicit = default is not None and not isinstance(default, exp.Null)
            if not explicit and not (isinstance(node.this, exp.Anonymous) and node.this.name == "toNullable"):
                changes.append("window-null")
                node.set("this", A("toNullable", node.this))
                if isinstance(default, exp.Null):
                    node.set("default", None)
            return node
        if isinstance(node, exp.CumeDist):
            return A("cume_dist")  # ClickHouse knows only the lower-case name (CUME_DIST: unknown function)
        if isinstance(node, exp.Pad):  # MySQL turns a number into text first (LPAD(7, 3, '0') = '007'); ClickHouse's leftPad refuses a number. UTF8 variants count characters, as MySQL does
            fill = node.args.get("fill_pattern")
            if fill is not None:
                return A("leftPadUTF8" if node.args.get("is_left") else "rightPadUTF8", A("toString", node.this), node.args["expression"], fill)
        if isinstance(node, exp.TimestampDiff):  # this = the later time (3rd argument), expression = the earlier one
            unit = (node.args["unit"].name if node.args.get("unit") is not None else "").upper()
            unit = "MICROSECOND" if unit == "FRAC_SECOND" else unit
            if unit not in UNITS:
                raise Refusal(f"TIMESTAMPDIFF with the unit {unit or '?'} has no ClickHouse equivalent.")
            start, end = when(node.args["expression"]), when(node.args["this"])
            if unit == "MICROSECOND":
                return A("dateDiff", S("microsecond"), start, end)
            if unit in ("SECOND", "MINUTE", "HOUR"):
                # Elapsed time, truncated toward zero by intDiv. dateDiff('second') counts the second BOUNDARIES crossed, so 10:00:00.9 -> 10:00:01.1 gave 1 (MySQL: 0) on a
                # DateTime64 column; the difference of the two instants in microseconds is exact for Date, DateTime and DateTime64 alike.
                micros = lambda t: A("toUnixTimestamp64Micro", A("toDateTime64", t, N(6)))
                return A("intDiv", exp.Sub(this=micros(end), expression=micros(start)), N({"SECOND": 1000000, "MINUTE": 60000000, "HOUR": 3600000000}[unit]))
            return A("age", S(unit.lower()), start, end)
        if isinstance(node, (exp.DateAdd, exp.DateSub)):
            what = "DATE_ADD" if isinstance(node, exp.DateAdd) else "DATE_SUB"
            amount, unit = interval_of(node.args.get("expression"), node.args.get("unit"), what)
            return (exp.Add if isinstance(node, exp.DateAdd) else exp.Sub)(this=when(node.args["this"]), expression=interval_node(amount, unit))
        if isinstance(node, exp.Interval):
            if isinstance(node.parent, (exp.DateAdd, exp.DateSub)):
                return node
            amount, unit = interval_of(node.args.get("this"), node.args.get("unit"), "INTERVAL")
            return interval_node(amount, unit)
        if isinstance(node, (exp.Add, exp.Sub)) and (isinstance(node.args.get("expression"), exp.Interval) or isinstance(node.args.get("this"), exp.Interval)):
            changed = False
            for key in ("this", "expression"):
                w = when(node.args.get(key))
                if w is not node.args.get(key) and not isinstance(node.args.get(key), exp.Interval):
                    node.set(key, w)
                    changed = True
            return node if changed else node
        if isinstance(node, exp.Escape) and isinstance(node.this, (exp.Like, exp.ILike)):
            like, esc = node.this, node.args.get("expression")
            pattern = like.args.get("expression")
            if not (isinstance(pattern, exp.Literal) and pattern.is_string and isinstance(esc, exp.Literal) and esc.is_string and len(esc.this) <= 1):
                raise Refusal("LIKE ... ESCAPE needs the pattern and the escape character written as text.")
            changes.append("ilike")
            rest = {k: v for k, v in like.args.items() if k not in ("this", "expression")}
            return exp.ILike(this=like.args["this"], expression=S(like_pattern(pattern.this, esc.this)), **rest)
        if isinstance(node, exp.Like):
            changes.append("ilike")
            return exp.ILike(**node.args)  # every argument kept: NOT LIKE is a Like with negate=True
        if isinstance(node, exp.IntDiv):  # a DIV 0 is NULL in MySQL; the plain translation divides by zero
            divisor = node.args["expression"]
            if isinstance(divisor, exp.Anonymous) and divisor.name == "nullIf":
                return node
            if nonzero_literal(divisor):
                return node
            changes.append("div-null")
            return exp.IntDiv(this=node.args["this"], expression=A("nullIf", divisor, N(0)))
        if isinstance(node, (exp.EQ, exp.NEQ)):
            left, right = node.args.get("this"), node.args.get("expression")
            if is_text(right) and foldable(left) and not (lowered(left) and right.this == right.this.lower()):  # LOWER(x) = 'abc' already ignores case
                changes.append("case-fold")
                return type(node)(this=fold(left), expression=A("lowerUTF8", right))
            if is_text(left) and foldable(right) and not (lowered(right) and left.this == left.this.lower()):
                changes.append("case-fold")
                return type(node)(this=A("lowerUTF8", left), expression=fold(right))
        if isinstance(node, exp.In) and node.args.get("expressions") and not node.args.get("query") and not node.args.get("field"):
            items, subject = node.args["expressions"], node.args.get("this")
            if all(isinstance(i, exp.Literal) and i.is_string for i in items) and any(is_text(i) for i in items) and foldable(subject):
                changes.append("case-fold")
                return exp.In(this=fold(subject), expressions=[A("lowerUTF8", i) for i in items])
        return node

    # --- clauses that do not change a result are dropped ------------------------------------------------------------------------------------------------------
    tree = trees[0]
    for select in list(tree.find_all(exp.Select)):
        mods = select.args.get("operation_modifiers")
        if mods:
            kept = [m for m in mods if not (isinstance(m, exp.Var) and m.name.upper() in DROPPED_MODIFIERS)]
            select.set("operation_modifiers", kept or None)
        if select.args.get("locks"):
            select.set("locks", None)
            note("FOR UPDATE / FOR SHARE (row locks) do not exist in ClickHouse; the clause was left out.")
    for join in tree.find_all(exp.Join):
        if str(join.args.get("kind") or "").upper() == "STRAIGHT_JOIN":
            join.set("kind", "INNER" if (join.args.get("on") or join.args.get("using")) else "CROSS")

    # --- ORDER BY: the NULL-last emulation MySQL needs (CASE WHEN x IS NULL THEN 1 ELSE 0 END, x) is ClickHouse's own default (x), so it is turned back ---------------
    def null_key(key):
        """The `x` of `CASE WHEN x IS NULL THEN 1 ELSE 0 END` or `x IS NULL`; None when `key` is neither."""
        if isinstance(key, exp.Is) and isinstance(key.args.get("expression"), exp.Null):
            return key.this
        if isinstance(key, exp.Case) and key.args.get("this") is None and len(key.args.get("ifs") or []) == 1 and key.args.get("default") == N(0):
            cond = key.args["ifs"][0]
            if isinstance(cond.this, exp.Is) and isinstance(cond.this.args.get("expression"), exp.Null) and cond.args.get("true") == N(1):
                return cond.this.this
        return None

    for order in tree.find_all(exp.Order):
        items, merged, k = order.expressions, [], 0
        while k < len(items):
            flag = null_key(items[k].this) if isinstance(items[k], exp.Ordered) else None
            if flag is not None and k + 1 < len(items) and isinstance(items[k + 1], exp.Ordered) and items[k + 1].this == flag:
                # the flag sorts 0 (a value) before 1 (NULL): NULL last when ascending, first when descending; the key keeps its own direction
                spec = {"desc": True} if items[k + 1].args.get("desc") else {}  # no `desc` at all for ascending: sqlglot would print an explicit ASC
                if items[k].args.get("desc"):
                    spec["nulls_first"] = True
                merged.append(exp.Ordered(this=flag, **spec))
                k += 2
            else:
                merged.append(items[k])
                k += 1
        if len(merged) != len(items):
            order.set("expressions", merged)

    # --- repair, until nothing changes (a rewritten node's children are repaired too) -------------------------------------------------------------------------------
    for _ in range(6):
        before = repr(tree)
        tree = tree.transform(fix)
        if repr(tree) == before:
            break
    # --- column = column: candidates for the case-fold, folded where the caller found both columns to be text -------------------------------------------------------------
    probes = []
    root_with = tree.args.get("with_") if isinstance(tree, exp.Select) else None
    for node in list(tree.find_all(exp.EQ, exp.NEQ)):
        left, right = node.args.get("this"), node.args.get("expression")
        if not (isinstance(left, exp.Column) and isinstance(right, exp.Column)) or len(probes) >= MAX_PAIRS:
            continue
        select, pid = node.find_ancestor(exp.Select), len(probes)
        scope = None
        if select is not None and select.args.get("from_") is not None:
            probe = exp.Select(expressions=[exp.alias_(left.copy(), "l"), exp.alias_(right.copy(), "r")])
            probe.set("from_", select.args["from_"].copy())
            if select.args.get("joins"):
                probe.set("joins", [j.copy() for j in select.args["joins"]])
            if root_with is not None:
                probe.set("with_", root_with.copy())
            scope = probe.sql(dialect="clickhouse")
        probes.append({"id": pid, "sql": scope, "columns": 2})
        if pid in fold_pairs:
            changes.append("case-fold")
            node.replace(type(node)(this=fold(left.copy()), expression=fold(right.copy())))
    # --- GROUP BY / ORDER BY / DISTINCT on a plain column: when ClickHouse says the column is text, a note (MySQL puts 'A' and 'a' in one group; ClickHouse in two). Not rewritten: the
    # output values would change, and every reference to the column with them. Probes ask ClickHouse for the type, like the pairs above.
    seen_cols = set()
    for select in list(tree.find_all(exp.Select)):
        group, order, distinct = select.args.get("group"), select.args.get("order"), select.args.get("distinct")
        cols = []
        if group is not None:
            cols += [e for e in group.expressions if isinstance(e, exp.Column)]
        if order is not None:
            cols += [o.this for o in order.expressions if isinstance(o, exp.Ordered) and isinstance(o.this, exp.Column)]
        if distinct is not None and not distinct.args.get("on"):
            cols += [e for e in select.expressions if isinstance(e, exp.Column)]
        for col in cols:
            key = (id(select), col.sql())
            if key in seen_cols or len(probes) >= MAX_PAIRS or select.args.get("from_") is None:
                continue
            seen_cols.add(key)
            probe = exp.Select(expressions=[exp.alias_(col.copy(), "l")])
            probe.set("from_", select.args["from_"].copy())
            if select.args.get("joins"):
                probe.set("joins", [j.copy() for j in select.args["joins"]])
            if root_with is not None:
                probe.set("with_", root_with.copy())
            pid = len(probes)
            probes.append({"id": pid, "sql": probe.sql(dialect="clickhouse"), "columns": 1})
            if pid in fold_pairs:
                note("Grouping, sorting and DISTINCT on text are case-sensitive in ClickHouse: 'Open' and 'open' are two values here, one in MySQL.")
    for n in tree.find_all(exp.Anonymous):
        if n.name.upper().startswith("MYSQL_"):
            raise Refusal(f"{n.name[6:].replace('_', ' ').title()} could not be translated.")
    guarded = False
    for n in tree.find_all(exp.Div, exp.Mod):
        if nonzero_literal(n.args.get("expression")):
            n.set("safe", False)  # sqlglot's generator wraps the divisor in nullIf(..., 0) only for a "safe" division
        else:
            guarded = True
    if guarded:
        changes.append("div-null")  # sqlglot wraps the divisor in nullIf(..., 0) itself
    result = tree.sql(dialect="clickhouse", unsupported_level=ErrorLevel.RAISE)
    # ClickHouse names an unaliased column after its text (`count()`, `sum(x)`): the common aggregates keep the lower-case spelling ClickHouse queries use, outside quoted text
    result = "".join(part if i % 2 else re.sub(r"\b(COUNT|SUM|AVG|MIN|MAX)\(", lambda m: m.group(1).lower() + "(", part)
                     for i, part in enumerate(re.split(r"('(?:[^'\\]|\\.|'')*'|\"(?:[^\"\\]|\\.)*\"|`[^`]*`)", result)))
    if "NULLS FIRST" in result and "NULLS FIRST" not in sql.upper():
        changes.append("nulls-first")  # MySQL sorts NULL first; ClickHouse's default is last
    if "case-fold" in changes:
        note("Text comparisons ignore upper/lower case, as in MySQL. They are written with lowerUTF8(), so a filter on a very large table can be slower "
             "(it cannot use the primary key), and accents still count as different letters.")
    return result, warnings, sorted(set(changes)), [p for p in probes if p["sql"]]


def clickhouse_to_mysql(sql, sqlglot, ErrorLevel):
    """ClickHouse -> MySQL, for DISPLAY only (the text is never run on MySQL, and what is saved is the ClickHouse query). Whatever MySQL has no form for is refused with
    its name, so the dialog keeps the query in ClickHouse syntax instead of showing text that looks like MySQL but is not: ClickHouse-only functions (sqlglot would print
    TODATE(x), UNIQEXACT(x), TRANSFORM(a, x -> ...)), array access (it shifts the index), query parameters, PREWHERE / FINAL / SAMPLE / ARRAY JOIN / GLOBAL / SETTINGS / LIMIT n BY
    / WITH TOTALS, and the start-of-period functions (sqlglot builds a date-arithmetic puzzle from year 0). formatDateTime(x, fmt) becomes DATE_FORMAT(x, fmt) for the codes both
    print the same way (sqlglot's own conversion reads ClickHouse's %M, the month name, as minutes)."""
    from sqlglot import exp

    plain_text = re.sub(r"--[^\n]*|/\*.*?\*/|'(?:[^'\\]|\\.|'')*'|\"(?:[^\"\\]|\\.)*\"|`[^`]*`", " ", sql, flags=re.S)
    m = CH_ONLY_SYNTAX.search(plain_text)
    if m:
        raise Refusal(f"{' '.join(m.group(1).upper().split())} is ClickHouse-only syntax with no MySQL form.")
    m = CH_NAME_CLASH.search(plain_text)
    if m:
        raise Refusal(f"{m.group(1)}() means something else in MySQL (ASCII-only case change, NULL handling, weekday numbering, raw bytes, interval arguments). Use the UTF-8 form, e.g. lowerUTF8().")
    trees = [t for t in sqlglot.parse(sql, read="clickhouse") if t]
    if len(trees) != 1:
        raise Refusal("Only one query can be translated.", "parse")
    tree = trees[0]
    for n in tree.find_all(exp.Bracket, exp.Array, exp.Lambda, exp.Transform, exp.Placeholder, exp.Parameter):
        what = {"Bracket": "Array access (x[1])", "Array": "An array", "Lambda": "A lambda (x -> …)", "Transform": "arrayMap()", "Placeholder": "A query parameter ({name:Type})", "Parameter": "A query parameter"}[type(n).__name__]
        raise Refusal(f"{what} has no MySQL form.")
    for n in tree.find_all(exp.Limit):
        if n.args.get("expressions"):
            raise Refusal("LIMIT n BY has no MySQL form.")

    def fix(node):
        if isinstance(node, exp.Anonymous) and node.name in ("upperUTF8", "lowerUTF8") and len(node.expressions) == 1:  # what MySQL's UPPER / LOWER do
            return (exp.Upper if node.name == "upperUTF8" else exp.Lower)(this=node.expressions[0])
        if isinstance(node, exp.TimeToStr):
            fmt = node.args.get("format")
            ok = isinstance(fmt, exp.Literal) and fmt.is_string and node.args.get("zone") is None
            if ok:
                codes = re.findall(r"%(.)", fmt.this)
                ok = all(c in FORMAT_DIRECT for c in codes)
            if not ok:
                raise Refusal("formatDateTime with a time zone or a format code MySQL prints differently has no MySQL form.")
            return exp.Anonymous(this="DATE_FORMAT", expressions=[node.this, fmt])
        return node

    tree = tree.transform(fix)
    for n in tree.find_all(exp.Func):
        mysql = n.sql(dialect="mysql")
        name = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\(", mysql)
        if name and name.group(1).upper() not in MYSQL_FUNCTIONS:
            original = re.match(r"([A-Za-z_][A-Za-z0-9_]*)", n.sql(dialect="clickhouse"))
            raise Refusal(f"{original.group(1) if original else name.group(1)}() is a ClickHouse function with no MySQL form.")
    result = tree.sql(dialect="mysql", unsupported_level=ErrorLevel.RAISE)
    if "0000-01-01" in result:
        raise Refusal("toStartOf…() and toMonday() have no readable MySQL form.")
    return result


def main():
    try:
        import sqlglot
        from sqlglot import ErrorLevel, errors
    except Exception:
        out({"ok": False, "kind": "missing", "error": "The SQL translator is not installed."})
        return
    try:
        req = json.loads(sys.stdin.read())
        sql, src, dst = req["sql"], req["from"], req["to"]
        if src not in DIALECTS or dst not in DIALECTS or src == dst or not isinstance(sql, str):
            raise ValueError("bad request")
    except Exception:
        out({"ok": False, "kind": "error", "error": "Bad translation request."})
        return
    try:
        if src == "mysql" and dst == "clickhouse":
            fold_pairs = req.get("fold") or []
            if not (isinstance(fold_pairs, list) and len(fold_pairs) <= MAX_PAIRS and all(isinstance(i, int) and 0 <= i < MAX_PAIRS for i in fold_pairs)):
                raise ValueError("bad request")
            result, warnings, changes, probes = mysql_to_clickhouse(sql, sqlglot, ErrorLevel, set(fold_pairs))
            out({"ok": True, "sql": result, "warnings": warnings, "changes": changes, "probes": probes})
            return
        if src == "clickhouse" and dst == "mysql":
            out({"ok": True, "sql": clickhouse_to_mysql(sql, sqlglot, ErrorLevel), "warnings": [], "changes": []})
            return
        result = [r for r in sqlglot.transpile(sql, read=src, write=dst, unsupported_level=ErrorLevel.RAISE) if r]
        if len(result) != 1:
            out({"ok": False, "kind": "parse", "error": "Only one query can be translated.", "errors": []})
            return
        out({"ok": True, "sql": result[0], "warnings": [], "changes": []})
    except Refusal as r:
        out({"ok": False, "kind": r.kind, "error": str(r), "errors": r.errors})
    except errors.ParseError as e:
        found = []
        for d in e.errors:
            col, line = d.get("col"), d.get("line")
            hl = d.get("highlight") or ""
            found.append({"line": line, "col": col, "start": (col - len(hl)) if isinstance(col, int) else None, "message": plain(d.get("description"))})
        out({"ok": False, "kind": "parse", "error": found[0]["message"] if found else "This query could not be read.", "errors": found})
    except errors.TokenError as e:
        out({"ok": False, "kind": "parse", "error": plain(str(e).splitlines()[0] if str(e) else ""), "errors": []})
    except errors.UnsupportedError as e:
        out({"ok": False, "kind": "unsupported", "error": "Part of this query has no equivalent in the other dialect: " + plain(str(e).splitlines()[0] if str(e) else "")})
    except Exception:
        out({"ok": False, "kind": "error", "error": "This query could not be translated."})


main()
