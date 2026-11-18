---
components: []
---
# Hooks

What the KB hooks check or generate, and how to run them by hand. The hooks are wired in
`.claude/settings.json`; the scripts live in `.claude/hooks/`.

| Hook | Fires | Does |
|---|---|---|
| `kb-verify.py` | after Write/Edit of a KB markdown file | Reports line-limit breaches (under 300 lines per doc, under 200 for indexes), code blocks in `architecture/overview.md`, missing front-matter, folders without an `index.md`, non-kebab-case filenames, changelog phrasing, and broken file/anchor links (inbound too) back to the agent. Rules: [kb-maintenance.md](kb-maintenance.md). |
| `update-log.py` | after a Bash call that runs `git merge` or `git commit` | Rebuilds [ui_updates.md](updates/ui_updates.md) and [feature_updates.md](updates/feature_updates.md) from the app repo's `main` history. |
| `reap-orphans.sh` | after Bash, and on Stop | Kills orphaned headless-Chrome processes and removes their `calc-ui-*` profile dirs. Also stops orphaned dev servers (`dotnet run`, `bin/Debug` builds) that a Claude shell started (`CLAUDECODE=1`), now parentless and over an hour old, with their process tree. Never the live service under `/var/www`. |

| `permission-ledger.py` | on PermissionRequest, after every tool (PostToolUse / PostToolUseFailure), and on Stop | Records each permission prompt in `.claude/permission-ledger.local.md` (git-ignored). A prompted call that then runs becomes `accept`. One still `pending` at Stop was never run, so it becomes `reject`. The next prompt for the exact same operation is auto-allowed if its row says `accept`. See [Permission ledger](#permission-ledger). |

## Permission ledger

- **Same operation** means the same sha256 key. For Bash the key covers command text, sandbox flag and working directory, not `description` or `timeout`. For other tools it covers the full input minus `description`. Only the Key column is matched.
- **Undo an approval:** set the row's Status to `reject` or delete the row. A `reject` row is a record only: the next request still prompts and is never auto-denied.
- **Never auto-allowed or recorded:** anything that touches the ledger or `.claude/settings*.json`, so a call can't approve itself. Deny rules still win over the hook's allow.
- **Known gap:** no hook fires when you click No. "Prompted but never ran by Stop" is the reject signal.
- **Errors fail open:** a broken payload or ledger means the normal prompt shows.

## By hand

- Check the whole KB: `python3 .claude/hooks/kb-verify.py --all` (exit 1 if any finding).
- Rebuild the update logs: `python3 .claude/hooks/update-log.py --rebuild`.

## Exemptions

`kb-verify.py` skips `docs/archive/`, `docs/development/updates/`, `docs/development/run-logs/`
and `*.local.md`. These are either history by design or git-ignored.

The update logs are generated, never hand-edited:

- One section per commit date, newest first.
- Each commit lands in exactly one file. UI covers styles, markup and visual wording; feature covers
  server, models and behaviour.
- Test-only and docs-only commits are skipped.
- Commits from the same date that open with the same four words collapse to one bullet.
