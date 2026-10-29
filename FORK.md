# This fork

`saiifali77/learnharness` is upstream ([amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness)) plus the Claude Code / Antigravity local agent connections (upstream PR #151, pinned at `f07238c`; upstream's own Claude Code integration from v0.4.0 is switched off in favour of it), a Providers-page label fix for those rows, and an updater feed pointing at this fork's releases (`electron-builder.yml`, `owner: saiifali77`).

## Auto-sync

`.github/workflows/fork-sync.yml` runs every 6 hours and on demand. It asks GitHub for upstream's latest published release. If this fork already has a release with that tag, it stops. Otherwise it:

1. merges the upstream tag into `main` (a merge commit; upstream tags are not copied into this fork),
2. runs upstream's release gates (typecheck, tests via `scripts/fork-test.mjs`, lint, native renderer tests, build, smoke tests),
3. builds the Linux AppImage,
4. pushes `main` and publishes a release with the same tag, containing the AppImage and `latest-linux.yml` (the AppImage embeds its block map).

The installed app's updater reads only this fork's releases. Nothing is pushed or released if any step fails.

## Upstream's Claude Code integration is off

Upstream v0.4.0 ships its own Claude Code integration, which collides with PR #151's `claude-code` provider. The fork keeps PR #151's connection and switches upstream's off with three edits: `CLAUDE_CODE_PROVIDER` is renamed to `"claude-code-official"` (`src/core/contracts/claude-code.ts`), the provider is not registered in `src/agent/models.ts`, and the "External CLI" settings group is removed from `components/settings/keys-section.tsx`. Upstream's files stay in place.

Its tests are skipped by `scripts/fork-test.mjs`, which Fork sync runs instead of `npm test`; upstream test files stay unmodified. If a sync fails on those tests after upstream renames or adds Claude Code tests, update the lists at the top of that script.

## Node-closing essays

Before the teacher leaves a plan node, the learner writes a free-recall essay explaining it, graded strictly, with gaps repaired and re-checked before moving on. Fork-only: in multiple-choice mode `createTeacherTools` (`src/agent/tools.ts`) also hands the teacher `explain` alongside `quiz` (free mode and the prober are unchanged), and `src/agent/prompts/teacher/32-node-essay.md` reserves `explain` for the closing essay. `tests/fork-node-essay.test.ts` guards it, and `scripts/fork-test.mjs` skips one upstream test that asserts choice mode holds only `quiz`.

## When a "Fork sync" issue appears

The workflow opened an issue: a merge conflict, a version mismatch, failed checks, or a failed publish. Nothing was pushed. To resolve a conflict:

```
git fetch https://github.com/amosblomqvist/learnharness.git tag <tag> --no-tags
git checkout main && git merge <tag>   # fix conflicts, commit
git push origin main
```

Then re-run: Actions -> Fork sync -> Run workflow. (If you pushed the merge yourself, the workflow sees `main` already contains the tag and just builds and releases.)

## One-time setup

- Add repository secret `FORK_PUSH_TOKEN`: a fine-grained PAT for this repo with Contents and Workflows write (upstream merges may change workflow files, which the default token cannot push).
- Enable Actions on the fork first: Actions tab -> "I understand my workflows, go ahead and enable them".
- Disable upstream's release workflows in the fork: in the Actions tab select each of "Desktop release" (`release.yml`) and "Notify website of public desktop release" (`notify-website.yml`), then "..." -> "Disable workflow". Or run `gh workflow disable release.yml --repo saiifali77/learnharness` and `gh workflow disable notify-website.yml --repo saiifali77/learnharness`. Leave "Fork sync" enabled.

## Known limit

The fork's release version equals upstream's version. A fork-only fix therefore ships with the next upstream release, or by installing a build manually.
