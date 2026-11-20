---
components: []
---
# Hooks

What the KB hooks check or generate, and how to run them by hand. The hooks are wired in
`.claude/settings.json`; the scripts live in `.claude/hooks/`.

| Hook | Fires | Does |
|---|---|---|
| `kb-verify.py` | after Write/Edit of a KB markdown file | Reports line-limit breaches (under 300 lines per doc, under 200 for indexes), code blocks in `architecture/overview.md`, missing front-matter, folders without an `index.md`, non-kebab-case filenames, changelog phrasing, and broken file/anchor links (inbound too) back to the agent. Rules: [kb-maintenance.md](kb-maintenance.md). |
| `update-log.py` | after a Bash call that runs `git merge`, `commit`, `rebase`, `cherry-pick`, `revert` or `pull` (the word right after `git` and any `-C` / `-c` / `--option`, so `git commit-tree` does not count) | Rebuilds [change_log.md](updates/change_log.md) (one table per date, commits that share a topic on a day grouped into one row) from the app repo's `main` history. The app repo also has git hooks (`post-commit`, `post-merge`, `post-rewrite` in its `.git/hooks/`, all running `update-change-log`, which calls `update-log.py --rebuild`), so a commit made in a terminal, an IDE or with `!` is logged too; they never fail a git operation. The git hooks are local to that clone, not versioned: recreate them in a fresh clone. |
| `reap-orphans.sh` | after Bash, and on Stop | Kills orphaned headless-Chrome processes and removes their `calc-ui-*` profile dirs. Also stops orphaned dev servers (`dotnet run`, `bin/Debug` builds) that a Claude shell started (`CLAUDECODE=1`), now parentless and over an hour old, with their process tree. Never the live service under `/var/www`. |
| `permission-ledger.py` | on PermissionRequest, after every tool (PostToolUse / PostToolUseFailure), and on Stop | Records the answer the user actually gave in `.claude/permission-ledger.local.md` (git-ignored): `allowed`, `rejected`, or `answered` for a question Claude asked. A prompt nobody answered leaves no row. The next prompt for the exact same operation is auto-allowed if its row says `allowed`. See [Permission ledger](#permission-ledger). |
| `design-lint.py` | after Write/Edit of a `Features/` `.css`, `.js` or `.cshtml` file | Lints the lines just written (rules in `design_rules.py`): hardcoded colours, undefined `var(--x)`, padding / margin / gap off 4 / 8 / 16 / 24, radius, font size, `style.display`. Findings go back as context, never blocking. A `design-lint-ignore` comment on a line, with the reason, silences it. |
| `design-gate.py snapshot` / `stop` | on every prompt (snapshot) and on Stop (gate) | The snapshot copies the `Features/` UI files into the git-ignored `.claude/design-review.state/`. At Stop the gate diffs the tree against it, so UI changed through Bash or a subagent counts too. If the added lines change what a user sees (any CSS or markup line; script only when it touches DOM, classes or style) it blocks **once**, naming the targeted components, the lint findings and [design-review.md](design-review.md). Silent when nothing visual changed, on the first Stop (no snapshot yet) and when already continuing because of it (`stop_hook_active`). Errors fail open. |

## Permission ledger

The ledger holds one row per operation with the **Action** the user last took. Columns: Key, Tool, Operation, Action, Detail, First seen, Updated.

| Action | Recorded when | Detail |
|---|---|---|
| `allowed` | The prompt was shown and the tool then ran | `rule saved: <rule> -> <settings file>` if a new `permissions.allow` rule appeared since the prompt ("Yes, and don't ask again"); otherwise `Yes (once or this session)` |
| `rejected` | The prompt was shown, the tool never ran, and the transcript holds the refusal ("The user doesn't want to proceed with this tool use") | `declined in the permission dialog` |
| `answered` | The user answered a question Claude asked (`AskUserQuestion`) | The question and the option picked, or the text typed under Other |

- **Only answers are recorded.** A prompt is kept in a sidecar (`permission-ledger.local.md.pending.json`) until it is resolved. At Stop whatever is left is dropped unless the transcript shows a refusal. A question the user declined, left unanswered or had interrupted never gets a row; neither does a prompt that was interrupted or settled by another rule.
- **A question is not a permission.** `AskUserQuestion` is always asked, never auto-answered, and `answered` rows are history only.
- **What the hook cannot see.** The dialog's own choice is not exposed to hooks. "Yes once" and "Yes for this session" look the same (`allowed`). A saved rule is detected by comparing the allow rules in `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json` before and after. "No, and tell Claude what to do" is recorded as `rejected`; the feedback text is in the transcript, not the ledger.
- **Same operation** means the same sha256 key. For Bash the key covers command text, sandbox flag and working directory, not `description` or `timeout`. For other tools it covers the full input minus `description`. Only the Key column is matched.
- **Auto-allow** applies to `allowed` rows only. `rejected` and `answered` rows are records: the next request still prompts. To be asked again, delete the row or change `allowed` to `rejected`.
- **Never auto-allowed or recorded:** anything that touches the ledger or `.claude/settings*.json`, so a call can't approve itself. Deny rules still win over the hook's allow.
- **Older rows.** Rows from the earlier format (a Status column of `accept`, `reject` or `pending`) are not read and are dropped on the next write. Those recorded questions the user had declined, which is not a permission answer.
- **Errors fail open:** a broken payload or ledger means the normal prompt shows.

## By hand

- Probe a component's rendered design: `tests/live/design-probe.mjs` in the app repo, from a CDP driver ([design-review.md](design-review.md#procedure)).
- Lint a snippet: pipe `{"tool_input":{"file_path":"<Features file>","new_string":"…"}}` into `python3 .claude/hooks/design-lint.py`.
- Check the whole KB: `python3 .claude/hooks/kb-verify.py --all` (exit 1 if any finding).
- Rebuild the change log: `python3 .claude/hooks/update-log.py --rebuild`.

## Exemptions

`kb-verify.py` skips `docs/archive/`, `docs/development/updates/`, `docs/development/run-logs/`
and `*.local.md`. These are either history by design or git-ignored.

The change log is generated, never hand-edited. Every change is recorded in the one file, [change_log.md](updates/change_log.md):

- One section per commit date, newest first; each section is a table of Time | Change | Commits. Time is the
  commit's author time (HH:MM, +08:00, the timezone of every commit so far).
- No UI / feature split: a commit is one entry whatever it touches.
- Test-only and docs-only commits are skipped.
- Commits from the same date that share a topic (the subject's text before its first colon, up to six words;
  without a colon, the first four words) collapse to one row: the topic in bold, one bullet per commit, every sha,
  and the time range.
