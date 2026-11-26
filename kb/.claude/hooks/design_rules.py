"""Shared static design rules for the Dashboard Builder UI (imported by design-lint.py and design-gate.py).

Lints only the ADDED lines of a change, so legacy code never nags. Rules come from CLAUDE.md / coding-standards.md:
  colour   golden rule 7: design tokens only, no hardcoded hex/rgb/hsl (token definitions `--x: #...` are the one home for literals)
  token    a `var(--x)` that no stylesheet or script defines (a typo, or a theme that never gets the token); `var(--x, fallback)` is fine
  space    design rule 2: padding / margin / gap on the 4 / 8 / 16 / 24 scale (0, and 1-2px optical nudges, are allowed; calc() and var() are skipped)
  radius   design rule 3: one radius (`--r`, 8px), plus 0, 50% and the pill token
  type     design rule 5: font sizes 14 / 16 / 24 / 32 (the `--fs-*` tokens)
  hidden   golden rule 6: toggle visibility with `hidden`, never `style.display`
An inline `design-lint-ignore` comment on a line silences it for that line (say why next to it).
"""
import difflib, glob, os, re

APP = "/unified/user/cj/web_project/dashboard_builder/codebase"
FEATURES = os.path.join(APP, "src/DashboardBuilder/Features")
EXTS = (".css", ".js", ".cshtml")
SPACE_OK = {0, 1, 2, 4, 8, 16, 24}
FONT_OK = {14, 16, 24, 32}
IGNORE = "design-lint-ignore"

COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(")
PX_RE = re.compile(r"(-?\d+(?:\.\d+)?)px")
DECL_RE = re.compile(r"(?:^|[;{])\s*([a-zA-Z-]+)\s*:\s*([^;{}]+)")
VAR_RE = re.compile(r"var\(\s*(--[\w-]+)\s*(,)?")
SPACING_PROPS = re.compile(r"^(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$|^(?:gap|row-gap|column-gap)$")
RADIUS_PROP = re.compile(r"^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$")


def token_defs():
    """Every custom property any Features stylesheet or script defines (`--x:` in CSS, "--x" string in JS/cshtml)."""
    defs = set()
    for path in glob.glob(os.path.join(FEATURES, "**/*"), recursive=True):
        if not path.endswith(EXTS):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        if path.endswith(".css"):
            defs.update(re.findall(r"(--[\w-]+)\s*:", text))
        else:
            defs.update(re.findall(r"[\"'`](--[\w-]+)[\"'`:]", text))
    return defs


def _strip_calc(value):
    # drop calc(...) and var(...) spans (nested parens, one level deep is enough for this code base)
    prev = None
    while prev != value:
        prev = value
        value = re.sub(r"(?:calc|var|min|max|clamp)\((?:[^()]|\([^()]*\))*\)", " ", value)
    return value


def _check_decl(prop, value, defs, where):
    out = []
    prop = prop.lower()
    v = value.strip()
    if not prop.startswith("--"):
        scan = re.sub(r"url\([^)]*\)", " ", v)
        if COLOR_RE.search(_strip_vars(scan)):
            out.append(f"{where} [colour] hardcoded colour in `{prop}`: use a design token (var(--…)); literals belong in a `--token:` definition")
        if SPACING_PROPS.match(prop):
            bad = [p for p in PX_RE.findall(_strip_calc(scan)) if abs(float(p)) not in SPACE_OK]
            if bad:
                out.append(f"{where} [space] `{prop}` uses {', '.join(sorted(set(b + 'px' for b in bad)))}: gaps and spacing are 4 / 8 / 16 / 24 (--s1 --s2 --s4 --s6)")
        elif RADIUS_PROP.match(prop):
            bad = [p for p in PX_RE.findall(_strip_calc(scan)) if float(p) != 0]
            if bad:
                out.append(f"{where} [radius] `{prop}` uses {', '.join(sorted(set(b + 'px' for b in bad)))}: one radius, var(--r) (8px); pills use var(--r-pill)")
        elif prop == "font-size":
            bad = [p for p in PX_RE.findall(_strip_calc(scan)) if float(p) not in FONT_OK]
            if bad or re.search(r"\d(?:rem|em)\b", _strip_calc(scan)):
                out.append(f"{where} [type] `font-size: {v}`: sizes are 14 / 16 / 24 / 32 (--fs-body --fs-lead --fs-title --fs-display)")
    for name, fallback in VAR_RE.findall(v):
        if not fallback and name not in defs:
            out.append(f"{where} [token] var({name}) is not defined by any Features stylesheet or script: typo, or a theme that never sets it")
    return out


def _strip_vars(value):
    return re.sub(r"var\(\s*--[\w-]+\s*\)", " ", value)


def _decls(line):
    return DECL_RE.findall(line)


def lint_lines(path, numbered, defs=None):
    """numbered: [(lineno, text)] of ADDED lines. Returns finding strings `file:line [rule] message`."""
    defs = defs if defs is not None else token_defs()
    rel = os.path.relpath(path, FEATURES) if path.startswith(FEATURES) else os.path.basename(path)
    out = []
    in_comment = False
    for no, raw in numbered:
        if IGNORE in raw:
            continue
        line = raw
        # strip /* ... */ comments (multi-line aware, good enough for added-line scans)
        line = re.sub(r"/\*.*?\*/", " ", line)
        if in_comment:
            if "*/" in line:
                line = line.split("*/", 1)[1]
                in_comment = False
            else:
                continue
        if "/*" in line:
            line = line.split("/*", 1)[0]
            in_comment = True
        if not line.strip():
            continue
        where = f"{rel}:{no}"
        if path.endswith(".css"):
            for prop, value in _decls(line):
                out += _check_decl(prop, value, defs, where)
        elif path.endswith(".js"):
            code = re.sub(r"(?<![:\w])//.*$", "", line)  # line comments (not https://)
            if re.search(r"\.style\.display\b|style\.cssText[^;\n]*display\s*:", code):
                out.append(f"{where} [hidden] toggle visibility with `hidden`, never `style.display` (golden rule 6)")
            if re.search(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])", code):
                out.append(f"{where} [colour] hex literal in script: read a design token (getComputedStyle / var(--…)); fine only for data, not for styling")
            for m in re.finditer(r"style\.(padding\w*|margin\w*|gap|fontSize|borderRadius)\s*=\s*[\"'`]([^\"'`]+)", code):
                prop = re.sub(r"([A-Z])", lambda c: "-" + c.group(1).lower(), m.group(1))
                out += _check_decl(prop, m.group(2), defs, where)
            for name, fallback in VAR_RE.findall(code):
                if not fallback and name not in defs:
                    out.append(f"{where} [token] var({name}) is not defined by any Features stylesheet or script")
        elif path.endswith(".cshtml"):
            for attr in re.findall(r"\bstyle=\"([^\"]*)\"", line):
                for prop, value in _decls(attr if attr.strip().endswith(";") else attr + ";"):
                    out += _check_decl(prop, value, defs, where)
    return out


def added_lines(old, new):
    """[(new_lineno, text)] for lines in `new` that are not in `old` (inserts and replacements)."""
    a, b = old.splitlines(), new.splitlines()
    out = []
    for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("insert", "replace"):
            out += [(j + 1, b[j]) for j in range(j1, j2)]
    return out


VISUAL_JS = re.compile(r"className|classList|\.style\b|createElement|textContent|innerHTML|\.append\(|\.prepend\(|setAttribute|\bicon\(|\.hidden\b|insertAdjacent")


def is_visual(path, numbered):
    """Does this added text change what a user sees? CSS and markup: any real line. Script: only DOM / class / style work."""
    body = [t for _n, t in numbered if t.strip() and not t.strip().startswith(("//", "/*", "*"))]
    if not body:
        return False
    if path.endswith(".js"):
        return any(VISUAL_JS.search(t) for t in body)
    return True


def components(items):
    """BEM roots named by the added lines, most-used first: `.key-pairs` from key-pairs__select / key-pairs--x."""
    count = {}
    for path, numbered in items:
        for _n, t in numbered:
            for m in re.finditer(r"([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:__|--)[a-z0-9]", t):
                count[m.group(1)] = count.get(m.group(1), 0) + 1
            if path.endswith(".css"):
                for m in re.finditer(r"\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w-])", t.split("{")[0]):
                    count[m.group(1)] = count.get(m.group(1), 0) + 1
    return [k for k, _v in sorted(count.items(), key=lambda kv: -kv[1])][:6]
