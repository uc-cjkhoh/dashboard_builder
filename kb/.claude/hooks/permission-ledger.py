#!/usr/bin/env python3
"""Permission ledger hook: record what the user actually chose, and auto-allow exact repeats of a call they allowed.

One script, four events (wired in .claude/settings.json):
  PermissionRequest             - a permission prompt is about to show. If the ledger has an `allowed` row with the same key,
                                  print the allow decision (no prompt). Otherwise remember the prompt in the sidecar
                                  (<ledger>.pending.json) with a snapshot of the saved allow rules, and print nothing.
                                  Nothing is written to the ledger yet: an unanswered prompt is not a record.
  PostToolUse / PostToolUseFailure - the tool ran, so the user allowed it:
                                    * a new `permissions.allow` rule appeared since the prompt  -> `allowed`, Detail "rule saved: ..."
                                      ("Yes, and don't ask again")
                                    * no new rule                                                -> `allowed` ("Yes": once, or for this session;
                                      the hook cannot tell those two apart)
                                  AskUserQuestion is not a permission: when the user answered it, the row is `answered` and Detail holds
                                  the question and the option picked.
  Stop                          - a prompt still in the sidecar never ran. Only if the transcript shows the user declined it
                                  ("The user doesn't want to proceed with this tool use") is it recorded, as `rejected`. Anything else
                                  (interrupted, decided elsewhere) is dropped. A declined or unanswered AskUserQuestion is never recorded.

Action values: allowed | rejected | answered. Only `allowed` rows auto-allow, and never for AskUserQuestion (a question must always be
asked). `rejected` and `answered` rows are records only, never auto-denied or auto-answered.
Key = sha256 of tool name + normalised input (Bash: command, sandbox flag, cwd; other tools: full input minus `description`).
Operations that touch the ledger or the settings files are neither recorded nor auto-allowed (no self-approval). Any error -> exit 0 with
no output (fail open to the normal prompt).
Ledger: .claude/permission-ledger.local.md (git-ignored by *.local.md). Rows in an older format (a Status column) are not read and are
dropped on the next write.
"""
import fcntl, hashlib, json, os, re, sys, time
from datetime import datetime, timezone

KB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LEDGER = os.environ.get("PERMISSION_LEDGER") or os.path.join(KB, ".claude", "permission-ledger.local.md")
LOCK = LEDGER + ".lock"
PENDING = LEDGER + ".pending.json"
HEADER = """# Permission ledger

Written by `.claude/hooks/permission-ledger.py` — see `docs/development/hooks.md`.
One row per operation, holding the answer the user last gave. Only answers are recorded: a prompt that was never answered, and a
question the user declined, leave no row.

| Action | Meaning |
|---|---|
| `allowed` | Permission prompt answered Yes. Detail says `rule saved: …` when the user chose "don't ask again" (a new allow rule appeared); otherwise it was Yes once or for the session (the hook cannot tell which). An exact repeat is auto-allowed. |
| `rejected` | Permission prompt answered No (confirmed in the transcript). A record only: the next request still prompts. |
| `answered` | A question Claude asked (AskUserQuestion); Detail is the question and the option picked. A record only: the question is always asked again. |

Delete a row to forget it; change `allowed` to `rejected` to be asked again.

| Key | Tool | Operation | Action | Detail | First seen | Updated |
|---|---|---|---|---|---|---|
"""
ACTIONS = ("allowed", "rejected", "answered")
NEVER_AUTO = re.compile(r"permission-ledger|\.claude/settings(\.local)?\.json")
ASK = "AskUserQuestion"
DECLINE = "doesn't want to proceed with this tool use"
SETTINGS = (os.environ.get("PERMISSION_LEDGER_SETTINGS") or "").split(os.pathsep) if os.environ.get("PERMISSION_LEDGER_SETTINGS") else [os.path.expanduser("~/.claude/settings.json"), os.path.join(KB, ".claude", "settings.json"), os.path.join(KB, ".claude", "settings.local.json")]


def norm_input(tool, inp, cwd):
    if tool == "Bash":
        return {"command": inp.get("command", ""), "sandbox_off": bool(inp.get("dangerouslyDisableSandbox")), "cwd": cwd}
    return {k: v for k, v in inp.items() if k not in ("description", "answers", "annotations")}


def key_of(tool, inp, cwd):
    norm = norm_input(tool, inp, cwd)
    blob = json.dumps({"tool": tool, "input": norm}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:16], norm


def cell(text, limit):
    text = " ".join(str(text).split()).replace("|", "\\|").replace("`", "'")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def display(tool, norm):
    if tool == ASK:
        qs = [q.get("question", "") for q in norm.get("questions", []) if isinstance(q, dict)]
        return cell(qs[0] + (f"  (+{len(qs) - 1} more)" if len(qs) > 1 else ""), 160) if qs else "(question)"
    if tool == "Bash":
        text = norm["command"] + (f"  (cwd {norm['cwd']})" if norm.get("cwd") else "")
    else:
        text = norm.get("file_path") or norm.get("url") or norm.get("pattern") or json.dumps(norm, ensure_ascii=False)
    return "`" + cell(text, 160) + "`"


def split_row(line):
    parts = re.split(r"(?<!\\)\|", line.rstrip("\n"))
    if len(parts) != 9 or parts[0].strip() or parts[-1].strip():
        return None
    c = [p.strip() for p in parts[1:-1]]
    m = re.fullmatch(r"`([0-9a-f]{16})`", c[0])
    return (m.group(1), c[1:]) if m and c[3] in ACTIONS else None  # [tool, op, action, detail, first, updated]


def load():
    rows = {}
    if os.path.exists(LEDGER):
        for line in open(LEDGER, encoding="utf-8"):
            r = split_row(line)
            if r:
                rows[r[0]] = r[1]
    return rows


def save(rows):
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(HEADER)
        for k, (tool, op, action, detail, first, upd) in rows.items():
            f.write(f"| `{k}` | {tool} | {op} | {action} | {detail} | {first} | {upd} |\n")
    os.replace(tmp, LEDGER)


def load_pending():
    try:
        return json.load(open(PENDING, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_pending(p):
    if not p:
        try:
            os.remove(PENDING)
        except OSError:
            pass
        return
    tmp = PENDING + ".tmp"
    json.dump(p, open(tmp, "w", encoding="utf-8"))
    os.replace(tmp, PENDING)


def allow_rules():
    """{settings file: [permissions.allow rules]} as saved right now."""
    out = {}
    for path in SETTINGS:
        try:
            rules = (json.load(open(path, encoding="utf-8")).get("permissions") or {}).get("allow") or []
            out[path] = [r for r in rules if isinstance(r, str)]
        except (OSError, ValueError, AttributeError):
            out[path] = []
    return out


def new_rules(before):
    found = []
    for path, rules in allow_rules().items():
        found += [f"{r} -> {os.path.basename(path)}" for r in rules if r not in set(before.get(path, []))]
    return found


def answers_of(data):
    """{question: picked option or typed answer} from an AskUserQuestion result; {} when the user did not answer."""
    for src in (data.get("tool_response"), data.get("tool_input")):
        if isinstance(src, list):
            src = " ".join(b.get("text", "") for b in src if isinstance(b, dict))
        if isinstance(src, dict) and isinstance(src.get("answers"), dict) and src["answers"]:
            return {str(q): str(a) for q, a in src["answers"].items()}
        if isinstance(src, str):
            pairs = re.findall(r'"([^"]+)"="([^"]*)"', src)  # Your questions have been answered: "Q"="A"
            if pairs:
                return dict(pairs)
    return {}


def same_input(tool, a, b):
    if tool == "Bash":
        return a.get("command") == b.get("command") and bool(a.get("dangerouslyDisableSandbox")) == bool(b.get("dangerouslyDisableSandbox"))
    return norm_input(tool, a, "") == norm_input(tool, b, "")


def stamp(o):
    try:
        return datetime.fromisoformat(str(o.get("timestamp")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def declined(transcript, tool, inp, since):
    """Does the transcript show the user declining this very call (after `since`)? The only record of a "No" there is."""
    if not transcript or not os.path.exists(transcript):
        return False
    uses, refused = {}, set()
    for line in open(transcript, encoding="utf-8", errors="replace"):
        if tool not in line and DECLINE not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        content = (o.get("message") or {}).get("content")
        if not isinstance(content, list) or stamp(o) < since - 5:
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use" and c.get("name") == tool and isinstance(c.get("input"), dict):
                uses[c.get("id")] = c["input"]
            elif c.get("type") == "tool_result" and c.get("is_error") and DECLINE in json.dumps(c.get("content")):
                refused.add(c.get("tool_use_id"))
    return any(i in uses and same_input(tool, uses[i], inp) for i in refused)


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name", "")
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(LOCK, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        rows, pending = load(), load_pending()
        if event == "Stop":
            changed = False
            for k, p in pending.items():
                if p["tool"] != ASK and declined(data.get("transcript_path"), p["tool"], p["input"], p["ts"]):
                    first = rows[k][4] if k in rows else now
                    rows[k] = [p["tool"], p["op"], "rejected", "declined in the permission dialog", first, now]
                    changed = True
            if changed:
                save(rows)
            save_pending({})  # whatever is left was never answered
            return
        tool, inp = data.get("tool_name", ""), data.get("tool_input") or {}
        if not tool or not isinstance(inp, dict):
            return
        k, norm = key_of(tool, inp, data.get("cwd", ""))
        if NEVER_AUTO.search(json.dumps(norm)):
            return  # ledger/settings writes: always prompt, never recorded
        if event == "PermissionRequest":
            if tool == ASK:
                return  # a question is not a permission: always asked, and recorded only once answered
            row = rows.get(k)
            if row and row[2] == "allowed":
                row[5] = now
                save(rows)
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}))
                return
            pending[k] = {"tool": tool, "input": inp, "op": display(tool, norm), "ts": time.time(), "rules": allow_rules()}
            save_pending(pending)
        elif event in ("PostToolUse", "PostToolUseFailure"):
            if tool == ASK:
                ans = answers_of(data)
                if ans:  # declined questions never reach here, and are not recorded
                    first = rows[k][4] if k in rows else now
                    detail = cell("; ".join(f"{q} -> {a}" for q, a in ans.items()), 300)
                    rows[k] = [tool, display(tool, norm), "answered", detail, first, now]
                    save(rows)
                return
            p = pending.pop(k, None)
            if not p:
                return  # allowed without a prompt (a rule, the ledger itself): not a user choice
            saved = new_rules(p.get("rules", {}))
            first = rows[k][4] if k in rows else now
            rows[k] = [tool, p["op"], "allowed", cell("rule saved: " + "; ".join(saved), 300) if saved else "Yes (once or this session)", first, now]
            save(rows)
            save_pending(pending)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
