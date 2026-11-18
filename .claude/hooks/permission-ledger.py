#!/usr/bin/env python3
"""Permission ledger hook: remember permission answers, auto-allow exact repeats that were accepted.

One script, four events (wired in .claude/settings.json):
  PermissionRequest            - a prompt is about to show. If the ledger has an `accept` row with the same
                                 key, print the allow decision (no prompt). Otherwise record a `pending` row
                                 and print nothing, so the normal prompt appears.
  PostToolUse/PostToolUseFailure - the tool ran, so a matching `pending` row was accepted -> `accept`.
  Stop                         - any row still `pending` was never run -> the user rejected it -> `reject`.

Key = sha256 of tool name + normalised input (Bash: command, sandbox flag, cwd; other tools: full input
minus `description`). Only the key column is matched; the Operation column is for people to read.
`reject` rows are records only, never auto-denied. Operations that touch the ledger or the settings
files are neither recorded nor auto-allowed (no self-approval). Any error -> exit 0 with no output (fail open to the normal prompt).
Ledger: .claude/permission-ledger.local.md (git-ignored by *.local.md).
"""
import fcntl, hashlib, json, os, re, sys
from datetime import datetime

KB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LEDGER = os.environ.get("PERMISSION_LEDGER") or os.path.join(KB, ".claude", "permission-ledger.local.md")
LOCK = LEDGER + ".lock"
HEADER = """# Permission ledger

Written by `.claude/hooks/permission-ledger.py` — see `docs/development/hooks.md`.
An `accept` row auto-allows the exact same operation next time. Change a Status to `reject` (or delete
the row) to be asked again. `pending` = prompted, answer not known yet.

| Key | Tool | Operation | Status | First seen | Updated |
|---|---|---|---|---|---|
"""
ROW = re.compile(r"^\| `([0-9a-f]{16})` \| (.*?) \| (.*) \| (accept|reject|pending) \| (.*?) \| (.*?) \|$")
NEVER_AUTO = re.compile(r"permission-ledger|\.claude/settings(\.local)?\.json")


def key_of(tool, inp, cwd):
    if tool == "Bash":
        norm = {"command": inp.get("command", ""), "sandbox_off": bool(inp.get("dangerouslyDisableSandbox")), "cwd": cwd}
    else:
        norm = {k: v for k, v in inp.items() if k != "description"}
    blob = json.dumps({"tool": tool, "input": norm}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:16], norm


def display(tool, norm):
    if tool == "Bash":
        text = norm["command"] + (f"  (cwd {norm['cwd']})" if norm.get("cwd") else "")
    else:
        text = norm.get("file_path") or norm.get("url") or norm.get("pattern") or json.dumps(norm, ensure_ascii=False)
    text = " ".join(text.split()).replace("|", "\\|").replace("`", "'")
    return "`" + (text if len(text) <= 160 else text[:157] + "...") + "`"


def load():
    rows = {}
    if os.path.exists(LEDGER):
        for line in open(LEDGER, encoding="utf-8"):
            m = ROW.match(line.rstrip("\n"))
            if m:
                rows[m.group(1)] = list(m.groups()[1:])  # tool, op, status, first, updated
    return rows


def save(rows):
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(HEADER)
        for k, (tool, op, status, first, upd) in rows.items():
            f.write(f"| `{k}` | {tool} | {op} | {status} | {first} | {upd} |\n")
    os.replace(tmp, LEDGER)


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name", "")
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(LOCK, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        rows = load()
        if event == "Stop":
            changed = False
            for r in rows.values():
                if r[2] == "pending":
                    r[2], r[4], changed = "reject", now, True
            if changed:
                save(rows)
            return
        tool, inp = data.get("tool_name", ""), data.get("tool_input") or {}
        if not tool or not isinstance(inp, dict):
            return
        k, norm = key_of(tool, inp, data.get("cwd", ""))
        if NEVER_AUTO.search(json.dumps(norm)):
            return  # ledger/settings writes: always prompt, never recorded
        row = rows.get(k)
        if event == "PermissionRequest":
            if row and row[2] == "accept":
                row[4] = now
                save(rows)
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                  "decision": {"behavior": "allow"}}}))
                return
            if row:
                row[2], row[4] = "pending", now
            else:
                rows[k] = [tool, display(tool, norm), "pending", now, now]
            save(rows)
        elif event in ("PostToolUse", "PostToolUseFailure") and row and row[2] == "pending":
            row[2], row[4] = "accept", now
            save(rows)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
