#!/usr/bin/env python3
"""PostToolUse hook (Write|Edit): instant design lint on the lines just written to a Features UI file.

Reads the hook JSON on stdin. For an Edit it lints `new_string`; for a Write, the whole `content`. Rules and the
`design-lint-ignore` marker: design_rules.py. Findings go back to the model as additionalContext (non-blocking);
clean edits and non-UI files print nothing. The Stop gate (design-gate.py) is the authority; this is the quick nudge.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import design_rules as R


def main():
    try:
        data = json.load(sys.stdin)
        ti = data.get("tool_input") or {}
        path = ti.get("file_path") or ""
        if not path.startswith(R.FEATURES) or not path.endswith(R.EXTS):
            return
        text = ti.get("new_string") if "new_string" in ti else ti.get("content")
        if not text:
            return
        # for an Edit, find where the new text sits in the file so line numbers are real
        start = 1
        try:
            whole = open(path, encoding="utf-8").read()
            at = whole.find(text)
            if at >= 0:
                start = whole.count("\n", 0, at) + 1
        except OSError:
            pass
        numbered = [(start + i, t) for i, t in enumerate(text.splitlines())]
        findings = R.lint_lines(path, numbered)
        if findings:
            msg = ("Design lint (project rules: tokens, 4/8/16/24 spacing, one radius, 4 type sizes, `hidden`). Fix, or mark a deliberate exception with a `design-lint-ignore` comment saying why:\n- "
                   + "\n- ".join(findings[:12]))
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))
    except Exception:
        return  # a lint must never break an edit


main()
