---
name: learnharness
description: How to change this LearnHarness fork without creating merge conflicts with the official project (amosblomqvist/learnharness), and how to bring in a new official release. Use before adding or changing any fork feature, fixing a fork bug, resolving a "Fork sync" issue, rebasing onto a new upstream tag, or installing the fork build.
---

# Maintaining the LearnHarness fork

This repo is a personal fork, used only by its owner. Fork `main` = the latest
**official release tag** + a short **linear stack of fork patches, one commit per
feature**. Every official release, the stack is **rebased** onto the new tag (never
merged). `FORK.md` describes the features and the automation; this skill is the
procedure. The project's `AGENTS.md` rules (no guessing, ask the user, plan → approve
→ implement) still apply on top of this.

Remotes in the local clone: `origin` = official upstream, `fork` = SaiifAli77/learnharness.
The pre-rebase merge history is kept at tag `archive/pre-rebase`.

## The rules

1. **Touch as few upstream files as possible.** Conflicts can only happen in upstream
   files the fork edits.
   - Put feature code in NEW files (e.g. `src/agent/local-agents/`, `src/agent/claude-delivery.ts`,
     `components/transcript-fill.ts`). In upstream files, add only a hook: one import and
     one call/branch, kept on as few lines as possible.
   - Never move, reformat, re-indent or "tidy" upstream code. Never re-order upstream imports.
   - Add new types, constants and paths to fork files, not to shared upstream files
     (`config.ts`, `src/core/ports.ts`, `src/core/index.ts`, …). Derive from exported
     upstream values instead of editing them (example: `local-agents.json` path comes from
     `path.dirname(SETTINGS_FILE)`).
   - **Never edit upstream test files.** If a fork feature intentionally changes behaviour an
     upstream test asserts, add that test's exact name to `SKIPPED_TESTS` (or the file to
     `EXCLUDED_FILES`) in `scripts/fork-test.mjs`, with a one-line reason.
   - **Never edit upstream docs** (`README.md`, `docs/**`). Fork documentation lives only in `FORK.md`.
   - Before finishing, list what upstream files you touched and justify each:
     `git diff --stat --diff-filter=M <tag>..HEAD`.
2. **One commit per feature, in a linear stack.** No merge commits on `main`.
   - A fix or change to an existing fork feature is folded INTO that feature's commit
     (`git commit --fixup=<feature-commit>` then
     `GIT_SEQUENCE_EDITOR=: git rebase --autosquash <tag>`), not stacked as a new commit.
     Two commits that touch the same upstream lines double the conflicts at every rebase.
   - A new feature = one new commit inserted just below the build(fork) commit (which always stays last), `feat(fork): …` / `perf(fork): …`,
     with a body explaining what and why.
   - Keep `FORK.md` up to date with every feature commit (FORK.md changes go in the
     last commit, "build(fork): updater feed, Fork sync, FORK.md and the fork-maintenance skill").
   - Never commit untracked personal files (e.g. `ideas.md`). Stage paths explicitly; don't use `git add -A`.
3. **Sync on every official release, and preview in between.** `Fork sync` (every 6 h)
   rebases onto each new upstream release; `Fork conflict preview` (daily) dry-runs the
   rebase onto upstream `main` and opens "Fork sync: upcoming conflict with upstream main"
   when it would conflict. Resolve upcoming conflicts early (see below), not at release time.
4. **rerere stays on.** `git config rerere.enabled true` and `rerere.autoupdate true` in this
   clone. Never delete `.git/rr-cache`. After rerere auto-resolves, still read the result.
5. **Every fork feature has a fork test** (`tests/fork-*.test.ts`, `tests/claude-delivery.test.ts`,
   `tests/local-agents-*.test.ts`, …) that fails if an upstream change quietly undoes it. A
   new feature without a test is not done. Tests run through `node scripts/fork-test.mjs`,
   never `npm test` (upstream's Claude Code tests are switched off).
6. **Upstreaming / extension points.** The owner keeps everything in the fork for now: do
   NOT open pull requests or issues on amosblomqvist/learnharness unless the user asks.
   When upstream adds an extension point (setting, hook, plugin) that a fork feature
   could use instead of an edit, propose switching to it.

Known structural risk: the fork carries PR #151's Claude Code/Antigravity connection
and switches off upstream's own Claude Code integration (owner's decision). Upstream
changes to `src/agent/models.ts`, `subscription-*.ts`, `src/server/model-catalog.ts` and
`components/settings/keys-section.tsx` are the usual conflict spots. Ask the owner
before changing that approach.

## Adding or changing a fork feature

1. `git fetch fork && git switch main && git reset --hard fork/main` (main is force-pushed;
   check `git status` first and never discard the owner's uncommitted work).
2. Plan with the owner (AGENTS.md). In the plan, list each upstream file you'll touch and the hook line(s).
3. Implement in new files; add the hooks; add/extend the fork test; update `FORK.md`.
4. Commit: new feature → new commit; change to an existing feature → `--fixup` + autosquash.
5. Gates: `npm run typecheck && node scripts/fork-test.mjs && npm run lint` (they use the
   repo-local `./data`, never the real data).
6. Check the footprint: `git diff --stat --diff-filter=M $(git merge-base HEAD origin/main)..HEAD`
   should have grown only by the hook lines.
7. Push only when the owner says to: `git push --force-with-lease fork main`.

## A new official release / a "Fork sync" issue

```
git fetch origin --tags
git fetch fork && git switch main && git reset --hard fork/main
TAG=vX.Y.Z
git merge-tree --write-tree --name-only main "$TAG"   # preview: lists conflicted files
base=$(git merge-base main "$TAG")
git rebase --onto "$TAG" "$base"                       # rerere replays recorded fixes
#   on a conflict: resolve keeping upstream's code intact + the fork's minimal hook,
#   git add <files>; GIT_EDITOR=true git rebase --continue
git range-diff "$base..ORIG_HEAD" "$TAG..HEAD"         # each patch must say what it said before
npm ci && npm run typecheck && node scripts/fork-test.mjs && npm run lint
git push --force-with-lease fork main                  # with the owner's OK
```

Then Actions → Fork sync → Run workflow; it sees `main` already contains the tag and
builds/releases. Close the issue once the release exists.

- If a conflict means upstream now does what a fork patch did, tell the owner and propose
  dropping or shrinking the patch rather than forcing it through.
- If upstream renamed/added tests the fork skips, update the lists in `scripts/fork-test.mjs`.
- For an "upcoming conflict" issue: do the same rebase on a scratch branch onto `origin/main`
  to record the resolution with rerere, then delete the scratch branch. Nothing is pushed.

## Installing the fork build

The installed app is `~/.local/share/learnharness/LearnHarness.AppImage`; its updater reads the
fork's releases. **Never touch `~/.config/LearnHarness/data`** (the owner's learning data) without asking.

1. Make sure LearnHarness is not running.
2. Back up the current AppImage to `~/LearnHarness-backups/` with a descriptive name.
3. `gh release download <tag> -R SaiifAli77/learnharness -p '*.AppImage' -D <scratch dir>`,
   copy it over the installed path, `chmod +x`.
4. The owner launches it. A fork release with the same version as the installed one is not
   offered by the updater, so same-version fixes are installed this way.
