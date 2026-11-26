---
components: []
---
# Commit and merge

**Ask before every commit and every merge** — in the Dashboard Builder project repo (`codebase/` and `kb/` are one repo).
The earlier standing grant to merge the project repo's work branch to `main` once the suites were green was
withdrawn on 2026-11-17.

## Do

1. Make the change on a work branch and run the suites in [review-guidelines.md](review-guidelines.md#verification).
2. Report the diff and the test results, and ask before `git commit`.
3. Ask again before merging into `main`; after a merge, run the suites on the merged result and delete the
   merged branch.

## Never

- Commit, merge, stash or reset the user's work without asking.
- Push, unless the user asks for that push.
