#!/usr/bin/env bash
# Mirror the current project (its single repo: working tree, plus .git packed as dot-git.tar) into /unified/user/cj/web_project/<project>/archive/mirror/
# so a fresh pre-move copy always exists. Called by the project repo's git hooks (post-commit, post-merge, post-rewrite).
# Copies the project root minus archive/ (the mirror's own home), publish/ (live build), bin/ obj/ node_modules/ keys/
# (build output, and the key-ring secret).
# Only ever replaces <project>/archive/mirror/; the rest of <project>/archive/ (the live-* snapshots) is never touched.
# Only runs for the repo whose toplevel is <project>/ itself; never fails or blocks git (always exits 0).
set -o pipefail
ROOT=/unified/user/cj/web_project
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
proj=$top
name=${proj##*/}
case $name in ''|*[!a-z0-9_]*) exit 0 ;; esac
[ "$proj" = "$ROOT/$name" ] || exit 0
PM=$proj/archive
mkdir -p "$PM" 2>/dev/null || exit 0
exec 9>"$PM/.lock"
flock -n 9 || exit 0
dest=$PM/mirror
tmp=$PM/.mirror.tmp
rm -rf "$tmp"
mkdir "$tmp" || exit 0
# History goes in as one file so the mirror holds no second repo (restore: tar -xf dot-git.tar). Keeps hooks, config and info/exclude.
tar -C "$top" -cf "$tmp/dot-git.tar" .git 2>>"$PM/sync.log" || true
if tar -C "$top" --exclude=./.git --exclude=./archive --exclude=./publish --exclude=bin --exclude=obj --exclude=node_modules --exclude=keys -cf - . 2>"$PM/sync.log" | tar -C "$tmp" -xf - 2>>"$PM/sync.log"; then
  rm -rf "$dest" && mv "$tmp" "$dest" && date '+%F %T synced' >"$PM/sync.log"
else
  rm -rf "$tmp"
fi
exit 0
