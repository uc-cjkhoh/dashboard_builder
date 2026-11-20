#!/usr/bin/env python3
"""Design review gate. Two modes, both wired in .claude/settings.json:

  design-gate.py snapshot   (UserPromptSubmit)  copy Features/**/*.{css,js,cshtml} into .claude/design-review.state/snap
  design-gate.py stop       (Stop)              diff the Features tree against that snapshot; if the turn changed what a user sees,
                                                block ONCE and ask for the design check in docs/development/design-review.md

Why a snapshot and not a Write|Edit matcher: UI changes also arrive through Bash (sed, python heredocs) and subagents, and the
app repo is too dirty for `git diff` to say what THIS turn changed. The snapshot needs no git.

Stop behaviour: no snapshot yet -> take one, never block. Nothing visual changed -> refresh the snapshot, stay silent. Visual change
-> block with the targeted components, the static findings and the pointer to the checklist. `stop_hook_active` (Claude already
continued once because of this hook) -> never block again, refresh the snapshot. Errors fail open.
"""
import json, os, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import design_rules as R

KB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE = os.path.join(KB, ".claude", "design-review.state")
SNAP = os.path.join(STATE, "snap")
DOCS = {  # Features/<folder> -> the KB doc that owns that component (CLAUDE.md "Where things live")
    "Relations": "docs/concepts/data-source/relationships.md", "Canvas": "docs/concepts/data-source/canvas.md",
    "Connection": "docs/concepts/data-source/connection.md", "Schema": "docs/concepts/data-source/schema-browser.md",
    "Dashboard": "docs/concepts/worksheet/worksheet.md", "Calc": "docs/concepts/worksheet/calculated-fields.md",
    "Board": "docs/concepts/workbook/dashboards.md", "Story": "docs/concepts/workbook/stories.md",
    "Tabs": "docs/concepts/workbook/tabs.md", "Workbook": "docs/concepts/workbook/workbook.md",
    "Core": "docs/reference/design/components.md", "Shell": "docs/reference/design/layout.md",
}


def ui_files():
    for dirpath, _dirs, names in os.walk(R.FEATURES):
        for n in names:
            if n.endswith(R.EXTS):
                yield os.path.join(dirpath, n)


def snapshot():
    tmp = SNAP + ".new"
    shutil.rmtree(tmp, ignore_errors=True)
    for p in ui_files():
        dest = os.path.join(tmp, os.path.relpath(p, R.FEATURES))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(p, dest)
    shutil.rmtree(SNAP, ignore_errors=True)
    os.makedirs(STATE, exist_ok=True)
    os.rename(tmp, SNAP)


def read(path):
    try:
        return open(path, encoding="utf-8").read()
    except OSError:
        return None


def changed():
    """[(abs_path, [(lineno, text)])] of UI files whose added lines changed what a user sees."""
    out = []
    for p in ui_files():
        rel = os.path.relpath(p, R.FEATURES)
        new = read(p)
        old = read(os.path.join(SNAP, rel)) or ""
        if new is None or new == old:
            continue
        added = R.added_lines(old, new)
        if added and R.is_visual(p, added):
            out.append((p, added))
    return out


def stop(data):
    if not os.path.isdir(SNAP):
        return snapshot()
    if data.get("stop_hook_active"):
        return snapshot()
    items = changed()
    if not items:
        return snapshot()
    defs = R.token_defs()
    findings = []
    for p, added in items:
        findings += R.lint_lines(p, added, defs)
    comps = R.components(items)
    files = [os.path.relpath(p, R.FEATURES) for p, _a in items]
    docs = []
    for f in files:
        d = DOCS.get(f.split(os.sep)[0])
        if d and d not in docs and os.path.exists(os.path.join(KB, d)):
            docs.append(d)
    reason = (
        "DESIGN CHECK REQUIRED before you finish: this turn changed UI in " + ", ".join(files[:8]) + (" …" if len(files) > 8 else "") + ".\n"
        "Targeted components (BEM roots from the changed selectors): " + (", ".join("." + c for c in comps) or "none detected, name them yourself") + ".\n"
        "Run docs/development/design-review.md for them: (1) static findings below, (2) render each component in light, dark and the One Dark look at the "
        "widths it ships at and run the probe in tests/live/design-probe.mjs (alignment, gaps, off-token colours, contrast, scale), "
        "(3) answer the 13 design-principle questions and the theme-match questions in that doc against the component's neighbours, "
        "(4) fix what fails. End your reply with a short 'Design check:' section: per metric pass / fixed / accepted-with-reason. "
        "Do not claim a pass you did not measure.\n"
        + ("Owning doc(s) to compare with and update: " + ", ".join(docs) + ".\n" if docs else "")
        + ("Static findings on the lines added this turn:\n- " + "\n- ".join(findings[:15]) if findings else "Static findings: none.")
    )
    print(json.dumps({"decision": "block", "reason": reason}))


def main():
    try:
        data = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    except Exception:
        data = {}
    try:
        mode = sys.argv[1] if len(sys.argv) > 1 else "stop"
        snapshot() if mode == "snapshot" else stop(data)
    except Exception:
        return  # fail open: a broken gate must never trap a session


main()
