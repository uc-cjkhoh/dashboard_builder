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
import os
import re
import sys

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


# MySQL interval units that ClickHouse has under the same name (compound ones such as YEAR_MONTH have none).
UNITS = {"MICROSECOND", "SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "QUARTER", "YEAR"}
# TIMESTAMPDIFF units: MICROSECOND is left out (not verified against ClickHouse).
DIFF_UNITS = UNITS - {"MICROSECOND"}
INTEGER = re.compile(r"^-?\d+$")
# Text that is really a number or a date/time: converting the other side of a comparison to text would break it, so such literals are never case-folded.
NUMBER_LIKE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^0[xX][0-9a-fA-F]+$")
DATE_LIKE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$")


class Refusal(Exception):
    """A MySQL query that must not be translated: ambiguous or without a faithful ClickHouse form. `errors` places it in the text when it can."""

    def __init__(self, message, kind="unsupported", errors=None):
        super().__init__(message)
        self.kind, self.errors = kind, errors or []


def mysql_to_clickhouse(sql, sqlglot, ErrorLevel):
    """Translate one MySQL query for ClickHouse. Where sqlglot's plain output would run but mean something else, the text is refused or repaired:

    * `||` is OR in MySQL's default mode and concatenation in ClickHouse: refused, so nobody gets 0/1 where they wanted text (write OR or CONCAT()).
    * DATEDIFF(a, b) is a - b in days: written as dateDiff('day', b, a), the order ClickHouse takes (sqlglot gave DATE_DIFF(a, b), which has no unit).
    * TIMESTAMPDIFF(unit, a, b) counts whole units (b - a, truncated toward zero). Checked against a ClickHouse 26.8 server: age('unit', a, b) is right for
      DAY, WEEK, MONTH, QUARTER and YEAR, but age('hour', ...) is WRONG there (10:00 -> 12:30 gave 3, 10:59 -> 11:01 gave -1), so SECOND, MINUTE and HOUR use the
      elapsed seconds instead: dateDiff('second', a, b), intDiv(..., 60), intDiv(..., 3600). dateDiff by itself counts boundaries for DAY and up, which is not MySQL's count.
    * DATE_ADD / DATE_SUB(d, INTERVAL n unit): d +/- INTERVAL n unit, with n a number (sqlglot made it the string '1'); compound units and non-literal amounts are refused.
    * LIKE becomes ILIKE: MySQL's default collation ignores case, ClickHouse's LIKE does not.   [changes: ilike]
    * `=`, `!=` and IN against a text literal ignore case in MySQL and not in ClickHouse: written as lowerUTF8(toString(x)) = lowerUTF8('lit') (toString makes it work
      for every column type, lowerUTF8 for non-ASCII letters), with a note that this can be slower. Not done for number- or date-like literals, a list that is not all
      text, or when the other side is a literal, NULL or a subquery.   [changes: case-fold]
    * a DIV 0 is NULL in MySQL: the divisor of DIV is wrapped in nullIf(..., 0) (sqlglot already does it for `/` and `%`).   [changes: div-null]
    * ORDER BY keeps MySQL's NULL-first order (sqlglot adds NULLS FIRST).   [changes: nulls-first]
    """
    from sqlglot import exp
    from sqlglot.dialects.dialect import Dialect
    from sqlglot.tokens import TokenType

    for tok in Dialect.get_or_raise("mysql").tokenize(sql):
        if tok.token_type == TokenType.DPIPE:
            raise Refusal("'||' means OR in MySQL but joins text in ClickHouse. Write OR, or CONCAT(a, b) for text.", "parse",
                          [{"line": tok.line, "col": tok.col, "start": tok.col - len(tok.text), "message": "'||' is ambiguous: write OR or CONCAT()."}])
    trees = [t for t in sqlglot.parse(sql, read="mysql") if t]
    if len(trees) != 1:
        raise Refusal("Only one query can be translated.", "parse")
    warnings, changes = [], []

    def is_text(node):
        """A quoted text with letters that is not a number or a date/time: the kind of literal whose comparison MySQL does without regard to case."""
        return (isinstance(node, exp.Literal) and node.is_string and any(c.isalpha() for c in node.this)
                and not NUMBER_LIKE.match(node.this.strip()) and not DATE_LIKE.match(node.this.strip()))

    def foldable(node):
        """The other side of a comparison: anything but a literal, NULL or a subquery (whose type we cannot know)."""
        return not isinstance(node, (exp.Literal, exp.Null, exp.Subquery, exp.Select, exp.Lower, exp.Upper))  # LOWER(x) = 'a' already ignores case

    def unit_of(node, what, allowed=UNITS):
        u = node.args.get("unit")
        name = (u.name if u is not None else "").upper()
        if name not in allowed:
            raise Refusal(f"{what} with the unit {name or '?'} has no ClickHouse equivalent.")
        return name

    def amount_of(node, what):
        e = node.args.get("expression")
        if isinstance(e, exp.Literal) and INTEGER.match(e.this):
            return exp.Literal.number(int(e.this))
        raise Refusal(f"{what} needs the amount written as a plain number (for example INTERVAL 7 DAY).")

    def fold(node):
        """lowerUTF8(toString(x)): the same text whatever the column's type, compared without regard to case."""
        return exp.Anonymous(this="lowerUTF8", expressions=[exp.Anonymous(this="toString", expressions=[node])])

    def fold_literal(lit):
        return exp.Anonymous(this="lowerUTF8", expressions=[lit])

    def fix(node):
        if isinstance(node, exp.DateDiff) and node.args.get("unit") is None:  # MySQL DATEDIFF(a, b): this = a, expression = b
            return exp.Anonymous(this="dateDiff", expressions=[exp.Literal.string("day"), node.args["expression"], node.args["this"]])
        if isinstance(node, exp.TimestampDiff):  # this = the later time (3rd argument), expression = the earlier one
            unit, start, end = unit_of(node, "TIMESTAMPDIFF", DIFF_UNITS), node.args["expression"], node.args["this"]
            if unit in ("SECOND", "MINUTE", "HOUR"):  # elapsed seconds, truncated toward zero by intDiv
                seconds = exp.Anonymous(this="dateDiff", expressions=[exp.Literal.string("second"), start, end])
                return seconds if unit == "SECOND" else exp.Anonymous(this="intDiv", expressions=[seconds, exp.Literal.number(60 if unit == "MINUTE" else 3600)])
            return exp.Anonymous(this="age", expressions=[exp.Literal.string(unit.lower()), start, end])
        if isinstance(node, (exp.DateAdd, exp.DateSub)):
            what = "DATE_ADD" if isinstance(node, exp.DateAdd) else "DATE_SUB"
            unit = unit_of(node, what)  # the unit first: a compound unit such as YEAR_MONTH is the clearer thing to say
            interval = exp.Interval(this=amount_of(node, what), unit=exp.var(unit))
            return (exp.Add if isinstance(node, exp.DateAdd) else exp.Sub)(this=node.args["this"], expression=interval)
        if isinstance(node, exp.Interval):
            if node.args.get("unit") is not None and node.args["unit"].name.upper() not in UNITS:
                raise Refusal(f"INTERVAL with the unit {node.args['unit'].name} has no ClickHouse equivalent.")
            amount = node.args.get("this")
            if isinstance(amount, exp.Literal) and amount.is_string and INTEGER.match(amount.this):
                return exp.Interval(this=exp.Literal.number(int(amount.this)), unit=node.args.get("unit"))
        if isinstance(node, exp.Like):
            changes.append("ilike")
            return exp.ILike(**node.args)  # every argument kept: NOT LIKE is a Like with negate=True, and ESCAPE rides along
        if isinstance(node, exp.IntDiv):  # a DIV 0 is NULL in MySQL; the plain translation divides by zero
            changes.append("div-null")
            return exp.IntDiv(this=node.args["this"], expression=exp.Anonymous(this="nullIf", expressions=[node.args["expression"], exp.Literal.number(0)]))
        if isinstance(node, (exp.EQ, exp.NEQ)):
            left, right = node.args.get("this"), node.args.get("expression")
            if is_text(right) and foldable(left):
                changes.append("case-fold")
                return type(node)(this=fold(left), expression=fold_literal(right))
            if is_text(left) and foldable(right):
                changes.append("case-fold")
                return type(node)(this=fold_literal(left), expression=fold(right))
        if isinstance(node, exp.In) and node.args.get("expressions") and not node.args.get("query") and not node.args.get("field"):
            items, subject = node.args["expressions"], node.args.get("this")
            if all(isinstance(i, exp.Literal) and i.is_string for i in items) and any(is_text(i) for i in items) and foldable(subject):
                changes.append("case-fold")
                return exp.In(this=fold(subject), expressions=[fold_literal(i) for i in items])
        return node

    tree = trees[0].transform(fix)
    if any(True for _ in trees[0].find_all(exp.Div, exp.Mod)):
        changes.append("div-null")  # sqlglot wraps the divisor in nullIf(..., 0) itself
    result = tree.sql(dialect="clickhouse", unsupported_level=ErrorLevel.RAISE)
    if "NULLS FIRST" in result and "NULLS FIRST" not in sql.upper():
        changes.append("nulls-first")  # MySQL sorts NULL first; ClickHouse's default is last
    if "case-fold" in changes:
        warnings.append("Text comparisons ignore upper/lower case, as in MySQL. They are written with lowerUTF8(), so a filter on a very large table can be slower "
                        "(it cannot use the primary key), and accents still count as different letters.")
    return result, warnings, sorted(set(changes))


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
            result, warnings, changes = mysql_to_clickhouse(sql, sqlglot, ErrorLevel)
            out({"ok": True, "sql": result, "warnings": warnings, "changes": changes})
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
