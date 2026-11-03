# This fork

`saiifali77/learnharness` is the latest official upstream release tag ([amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness)) plus a short, linear stack of fork patches, one commit per feature. On each upstream release the patches are rebased onto the new tag and `main` is force-pushed. The stack, in order:

1. `feat: add Claude Code and Antigravity local agent connections` (upstream PR #151)
2. `fix(fork): adapt PR #151 to this fork`
3. `fix(fork): switch off upstream's Claude Code integration in favour of PR #151`
4. `feat(fork): Claude delivery rule, preamble and hidden-explanation guard`
5. `feat(fork): node-closing essays graded as free recall`
6. `perf(fork): skip transcript re-render while typing in long chats`
7. `perf(fork): open long chats newest-first`
8. `build(fork): updater feed, Fork sync, FORK.md and the fork-maintenance skill` (updater feed pointing at this fork's releases in `electron-builder.yml`, `owner: saiifali77`; the workflows; this file)

The merge-based history from before the switch to rebasing is preserved at tag `archive/pre-rebase`.

## Rules for fork changes

- Keep edits to upstream files minimal: new files plus one-line hooks. Never edit upstream tests; skip them in `scripts/fork-test.mjs` instead.
- Every feature has a fork test.
- One commit per feature. Amend or fixup into the feature's commit rather than stacking new commits on top, so the stack stays short and rebases stay cheap.
- Fork docs live in this file only. Upstream's `README.md` and `docs/architecture.md` stay unmodified.
- The project skill `/learnharness` (`.claude/skills/learnharness/SKILL.md`) holds the full procedure.

## Local agent connections (PR #151)

The Claude Code and Antigravity connections come from upstream PR #151, pinned at `f07238c` (author pdomenico). The fork's adaptation commit keeps `config.ts` and `src/core/ports.ts` untouched. The text this fork used to add to upstream's docs lives here, so upstream's `README.md` and `docs/architecture.md` stay unmodified.

### README paragraph

Formerly added to upstream's README, after the paragraph about adding a provider API key:

Already pay for a Claude or Google AI plan? Under Providers → Subscriptions, LearnHarness can use the [Claude Code](https://code.claude.com/docs/en/setup) or [Antigravity](https://antigravity.google/docs/ide/extensions) installation you have signed into on this computer. Those programs keep their own sign-in, and your plan's limits and terms apply.

### Architecture, section 8.2

Formerly added to upstream's `docs/architecture.md`, after section 8.1:

#### 8.2 Local agent connections (Claude Code, Antigravity)

A second subscription class where LearnHarness owns **no credential at all**: the learner installs and signs into a vendor runtime themselves, and the app drives it over that runtime's documented local protocol. Routes `claude-code` (the learner's own Claude Code CLI, spoken to directly over `claude -p --input-format/--output-format stream-json` — no Anthropic SDK is bundled) and `antigravity` (Google's official Antigravity ACP server, spoken to over the Agent Client Protocol via `@agentclientprotocol/sdk`) are distinct persisted routes that never fall back to API keys. The app never runs a claude.ai or Google OAuth flow of its own and never reads a token: Claude Code keeps the `claude auth login` sign-in; Antigravity's sign-in is requested *inside* the ACP server (`authenticate`, Google method), which opens the browser and stores the tokens itself. Status reads only what the runtimes report (`claude auth status --json`; Antigravity token *presence*). Everything runs in the server child (Electron main hosts no inference — §8), so the web build works too. The only persisted state is `data/local-agents.json`: per connection `{enabled, allowBackgroundUse}` (default off / on), written by `src/store/local-agents.ts` and injected into the agent layer by `src/server/local-agents.ts`.

**Park within a run** (`src/agent/local-agents/run.ts`). The runtimes run their own agent loop; pi-agent-core runs the app's. One `LocalRun` is one live CLI conversation spanning several pi model steps: a cold start spawns the runtime with the prior conversation rendered as tagged transcript blocks (`transcript.ts`, deterministic and append-only so prefixes cache); the app's current tools are exposed through a loopback MCP server (`mcp-server.ts` — 127.0.0.1, per-run bearer token, capped bodies, hand-rolled Streamable HTTP so parked `tools/call` requests answer over SSE with keep-alives); a tool call surfaces to pi as a `toolCall` and the step ends `toolUse` while the MCP request stays parked; the next `streamFn` call resumes the SAME process only when it carries exactly the pending call ids' results, nothing else appended, and the same prompt/tools/model/level signature — anything else closes the run and cold-starts. A question tool's dangling call therefore parks across the learner's answer (20 min idle cap; at most 6 live runs, LRU-evicted); a turn that ends without a tool call releases its process. Claude declares calls in its stream (`tool_use` blocks) before the MCP request arrives; ACP surfaces them on arrival (150 ms batching).

**Isolation.** Claude Code: `--tools ""` (no built-ins), `--setting-sources ""` (no settings files, hooks or CLAUDE.md — verified with a canary), `--disable-slash-commands` (no skills), `--strict-mcp-config` + `--allowedTools` (only the bridge), `--permission-mode dontAsk`, `--system-prompt-file` (the app's prompt replaces Claude Code's), `--no-session-persistence`, an empty private working directory, and a child environment with every app-held provider key and every auth/base-URL reroute (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, Bedrock/Vertex switches, …) removed — so a key saved in LearnHarness can never silently bill instead of the learner's plan. (`--safe-mode` is NOT usable: it also drops `--mcp-config` servers.) Antigravity: no filesystem or terminal client capabilities, the bridge as the only extra MCP server, the `default` (prompting) mode, every `session/request_permission` rejected — the agent's native file/shell tools never run — and the same empty private directory.

**Admission and accounting** ride the shared subscription machinery (§8.1): `isSubscriptionProvider` covers both routes, so the request cycle, background consent (default ON, per connection, withdrawn consent aborts background work), and `nativeSubscriptionError`'s no-fallback copy all apply; the admission scope is the connection generation, which bumps when enabled/account/binary identity changes and closes that provider's runs. Catalogs: Claude is pi-ai's Anthropic catalog without dated snapshots (4.6-generation windows capped at 200K — Claude Code serves `[1m]` separately); Antigravity is discovered from the server's `model`/`thought_level` selectors (pi thinking levels map onto the advertised `thought_level` values). Usage displays as the plan label ("Claude", "Antigravity"), never dollars. Binaries resolve `LH_CLAUDE_BIN` / `AGY_ACP_BIN` → PATH → the login shell's PATH (GUI launches lack it) → vendor install locations.

## Auto-sync

`.github/workflows/fork-sync.yml` runs every 6 hours and on demand. It asks GitHub for upstream's latest published release. If this fork already has a release with that tag, it stops. Otherwise it:

1. fetches the upstream tag (upstream tags are not copied into this fork) and rebases the fork's patches onto it (`git rebase --onto <tag> <old base>`). If `main` already contains the tag, it skips this and just builds,
2. runs upstream's release gates (typecheck, tests via `scripts/fork-test.mjs`, lint, native renderer tests, build, smoke tests),
3. builds the Linux AppImage,
4. force-pushes `main` with `--force-with-lease` pinned to the pre-rebase commit, then publishes a release with the same tag, containing the AppImage and `latest-linux.yml` (the AppImage embeds its block map).

The release notes list the fork patches on top of the tag and include a `git range-diff` of what each patch changed in the rebase. The same list and range-diff go to the run's step summary.

The installed app's updater reads only this fork's releases. Nothing is pushed or released if any step fails. If the rebase conflicts, the workflow aborts it and opens an issue; nothing is pushed.

`.github/workflows/fork-preview.yml` ("Fork conflict preview") runs daily and on demand. It rebases the fork's patches onto upstream's current `main` in a throwaway branch, with no tests, build or push. On a conflict it opens the issue "Fork sync: upcoming conflict with upstream main"; when a later run rebases cleanly (or upstream `main` is already contained) it comments and closes that issue. It gives you early warning before a release lands.

## Upstream's Claude Code integration is off

Upstream v0.4.0 ships its own Claude Code integration, which collides with PR #151's `claude-code` provider. The fork keeps PR #151's connection and switches upstream's off with three edits: `CLAUDE_CODE_PROVIDER` is renamed to `"claude-code-official"` (`src/core/contracts/claude-code.ts`), the provider is not registered in `src/agent/models.ts`, and the "External CLI" settings group is removed from `components/settings/keys-section.tsx`. Upstream's files stay in place.

Its tests are skipped by `scripts/fork-test.mjs`, which Fork sync runs instead of `npm test`; upstream test files stay unmodified. If a sync fails on those tests after upstream renames or adds Claude Code tests, update the lists at the top of that script.

## Node-closing essays

Before the teacher leaves a plan node, the learner writes a free-recall essay explaining it, graded strictly, with gaps repaired and re-checked before moving on. Fork-only: in multiple-choice mode `createTeacherTools` (`src/agent/tools.ts`) also hands the teacher `explain` alongside `quiz` (free mode and the prober are unchanged), and `src/agent/prompts/teacher/32-node-essay.md` reserves `explain` for the closing essay. `tests/fork-node-essay.test.ts` guards it, and `scripts/fork-test.mjs` skips one upstream test that asserts choice mode holds only `quiz`.

## Claude delivery rule

On Claude models the app makes `send_to_user` the learner's only visible channel (`src/agent/claude-delivery.ts`). The system prompt ends with a one-line "Delivery rule", and an opening section, "How your words reach the learner", also leads it. The upstream prompt body repeatedly says to write prose before a check, and the closing rule alone didn't hold for Sonnet 5.5. Both are fixed text, so the prompt stays deterministic. `tests/claude-delivery.test.ts` pins them.

## Typing stays fast in long chats

`components/chat.tsx` wraps the transcript map in `useMemo`, and `ToolContentResponse` (`components/ai-elements/message.tsx`) is wrapped in `memo`, so a keystroke in the composer or a question dock no longer re-renders every transcript block (367-message chat: ~180 ms -> ~30 ms per keystroke, pixel-identical). `tests/fork-transcript-memo.test.ts` recomputes, with the TypeScript checker, every Chat-scope value the block reads and fails if the deps array is out of date. Two of those values, `pending` and `malformedQuestions`, are rebuilt on every render, so the deps list their inputs (`messages`, `nativeMessages`) instead. The test's `DERIVED` table records that, and a second test fails if upstream starts computing either value from anything else.

## Opening long chats fast

A long chat used to SSR and hydrate every transcript block before showing anything. Now the transcript first renders only the newest 6 messages (server and first client render agree, so hydration matches), then, after mount, ONE idle-scheduled transition renders all the older ones at once (batches re-rendered the visible transcript each time and took ~10 s). A scroll hold in the same hook tracks the reader's distance from the bottom and restores it when older messages are prepended: at the bottom stays at the bottom, scrolled-up text does not move. The settled page is pixel-identical to before. Measured on a 44-block chat: usable at the bottom in ~4.2 s (was ~13 s), typing during the fill ~16 ms median.

`components/transcript-fill.ts` holds the hook; `components/chat.tsx` renders hidden messages as `null` and keeps the absolute index `mi`. The full transcript is forced at once by a URL hash at mount, `hashchange`/`popstate`, and the in-chat Find opening. Graph links to an old message (`propositionSessionHref` in `src/core/session-navigation.ts`) carry `?full=1`: `app/chat/[id]/page.tsx` reads it and passes `initialFullTranscript` to `Chat`, so SSR and the first client render contain the whole transcript, as before the fork change. Two upstream tests that assert the exact href are on the skip list in `scripts/fork-test.mjs`. `tests/fork-transcript-fill.test.ts` guards it, and `tests/fork-transcript-memo.test.ts` accepts the `null`-for-hidden `messages.map(` form.

Remaining trade-off: using in-chat Find within the first seconds waits for the older messages to render.

## When a "Fork sync" issue appears

The workflow opened an issue: a rebase conflict, a version mismatch, failed checks, or a failed publish. Nothing was pushed. This clone has `origin` = upstream and `fork` = this fork. To resolve a rebase conflict:

```
git fetch origin --tags
git fetch fork && git switch main && git reset --hard fork/main   # main is force-pushed, so reset instead of pull
git merge-tree --write-tree --name-only main <tag>                # preview the conflicts
base=$(git merge-base main <tag>)
git rebase --onto <tag> "$base"                                   # rerere replays previously recorded fixes
git range-diff "$base..ORIG_HEAD" "<tag>..HEAD"                   # check each patch still says the same
npm ci && npm run typecheck && node scripts/fork-test.mjs && npm run lint
git push --force-with-lease fork main
```

If the rebase stops on a conflict, fix the files, `git add` them, and `git rebase --continue`. Then re-run: Actions -> Fork sync -> Run workflow. The workflow sees `main` already contains the tag and just builds and releases.

Enable rerere locally once: `git config rerere.enabled true` and `git config rerere.autoupdate true`. For an "upcoming conflict" issue, resolve it early: rebase a scratch branch onto `origin/main` (`git switch -c scratch main && git rebase --onto origin/main $(git merge-base main origin/main)`), fix the conflict, and finish the rebase. Git records the resolution, so the rebase at release time replays it instead of conflicting again. Delete the scratch branch afterwards.

## One-time setup

- Add repository secret `FORK_PUSH_TOKEN`: a fine-grained PAT for this repo with Contents and Workflows write (the rebase can carry upstream workflow changes, which the default token cannot push).
- Enable Actions on the fork first: Actions tab -> "I understand my workflows, go ahead and enable them".
- Disable upstream's release workflows in the fork: in the Actions tab select each of "Desktop release" (`release.yml`) and "Notify website of public desktop release" (`notify-website.yml`), then "..." -> "Disable workflow". Or run `gh workflow disable release.yml --repo saiifali77/learnharness` and `gh workflow disable notify-website.yml --repo saiifali77/learnharness`. Leave "Fork sync" and "Fork conflict preview" enabled.

## Known limit

The fork's release version equals upstream's version. A fork-only fix therefore ships with the next upstream release, or by installing a build manually.
