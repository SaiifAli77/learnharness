/**
 * fork-test.mjs — the fork's test runner (fork-only; not part of upstream).
 *
 * Upstream's own Claude Code integration (v0.4.0) is switched off in favour
 * of PR #151's local-agent connection (see FORK.md), so its tests are skipped
 * here. Upstream test files stay unmodified to keep fork-sync merges
 * conflict-free; the exclusions live in this script instead.
 *
 * Runs exactly what `npm test` runs
 * (NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx), minus the
 * lists below. Exit code is passed through. When a sync fails on tests after
 * upstream renames or adds Claude Code tests, update these lists.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Whole files that test only upstream's Claude Code integration.
const EXCLUDED_FILES = /^claude-code-.*\.test\.tsx?$/;

// Individual tests in shared files, matched as anchored, escaped exact names
// (the bare test name; verified with tsx and this Node). One reason each.
const SKIPPED_TESTS = [
	// counts exactly three Connect rows; PR #151 adds two local-agent rows (tests/fork-local-agent-rows.test.tsx)
	["three compact rows render in approved order with no browser-only sign-in or fabricated identities"],
	// same: three Connect rows and three labels (tests/fork-local-agent-rows.test.tsx covers all five)
	["only Providers subscription labels use sans; setup labels retain their compact mono styling"],
	// expects an unchanged Claude prompt; the fork adds the delivery rule (tests/claude-delivery.test.ts runs these cases)
	// (v0.5.0 renamed these from "…: includes tool and description in all conversation agents")
	["anthropic/claude-opus-5-5: includes teaching output, never adds it to practice"],
	["anthropic/claude-haiku-4-5-20251001: includes teaching output, never adds it to practice"],
	["openrouter/anthropic/claude-opus-5.5: includes teaching output, never adds it to practice"],
	["openrouter/anthropic/claude-sonnet-5.5: includes teaching output, never adds it to practice"],
	["amazon-bedrock/us.anthropic.claude-opus-5-5-v1:0: includes teaching output, never adds it to practice"],
	["fixture/CLAUDE-fixture: includes teaching output, never adds it to practice"],
	// its "plain thinking" is fauxThinking with NO signature, which is what the Claude Code/Antigravity bridge emits (src/agent/local-agents/run.ts); the fork's deliveryGuard bounces unsigned thinking once there, where upstream's guard is inert. Plain SIGNED thinking passes (tests/claude-delivery.test.ts)
	["allows a legitimate predict with plain thinking and no prose"],
	// same: unsigned (bridge) thinking; the signed API case passes in tests/claude-delivery.test.ts
	["allows a legitimate check with plain thinking and no prose"],
	// expects upstream's removed "External CLI" settings group
	["Providers has five ordered sections including External CLI; unknown variables stay masked/read-only at the end of Model API keys"],
	// upstream's claude-code opus id (provider switched off)
	["claude-code/opus: includes teaching output, never adds it to practice"],
	// upstream's claude-code sonnet id (provider switched off)
	["claude-code/sonnet: includes teaching output, never adds it to practice"],
	// upstream's claude-code haiku id (provider switched off)
	["claude-code/haiku: includes teaching output, never adds it to practice"],
	// upstream's claude-code gate (provider switched off; new in v0.5.0)
	["claude-code/opus: shares the tool's gate, with teacher-only enforcement"],
	// upstream's claude-code narration flow (provider switched off; new in v0.5.0)
	["claude-code: rejects undelivered narration, retries, persists errors, then stops on the delivered question"],
	// upstream's CLI catalog models (provider not registered)
	["modelCatalog() lists claude-code opus/sonnet/haiku when the CLI is installed"],
	// upstream's CLI availability row (CLAUDE_CODE_PROVIDER renamed)
	["catalogProviders() marks claude-code present when the CLI is installed"],
	// resolves upstream's unregistered provider
	["piEngineForSpec({ provider: \"claude-code\", id: \"sonnet\" }) resolves"],
	// upstream's CLI opt-in/availability gate
	["providerKeyPresent(\"claude-code\") requires both explicit opt-in and executable presence"],
	// asserts choice mode holds only `quiz`; the fork's teacher also holds `explain` for node essays
	["createTeacherTools: {research: false} removes exactly research; unknown keys are no-ops"],
	// fork graph links carry ?full=1 (full transcript render, see FORK.md "Opening long chats fast")
	["chooses the first recorded non-empty anchor for that source"],
	// same: the href now has ?full=1 before the hash
	["encodes path/hash values and round-trips the actual message ID"],
	// pins the toggleable list; the fork adds `slides` (tests/fork-slides.test.ts re-asserts the fork's list)
	["TOGGLEABLE_TOOLS: the sub-agent dispatch tools; quiz/ask/read stay off the list"],
	// same, for the settings tool rows (tests/fork-slides.test.ts renders the fork's five rows)
	["renders the owner's FINAL tool list — research, demo, visual, pdf"],
	// pins jobTools()' keys; the fork spreads `slides` into it (tests/fork-slides.test.ts re-asserts the five keys)
	["demo and visual are SERVER-EXECUTED dispatch tools with the contract schemas"],
	// pins the settings write-side's supported list; the fork adds `slides` (re-asserted in tests/fork-slides.test.ts)
	["unknown keys are rejected with the supported list (the quiz wedge never persists)"],
	// its first explain on a node of a 4-node plan meets the fork's node-video gate (rejected once until the next node has a video); tests/fork-node-video-gate.test.ts re-asserts its explain call with the gate satisfied
	["explain tool call persists as a pending part; the free-text answer reveals the commitment and reaches the model"],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const files = fs.readdirSync(path.join(ROOT, "tests")).filter((f) => /\.test\.tsx?$/.test(f)).sort();
const excluded = files.filter((f) => EXCLUDED_FILES.test(f));
const run = files.filter((f) => !EXCLUDED_FILES.test(f)).map((f) => path.join("tests", f));

console.log(`[fork-test] excluded ${excluded.length} upstream Claude Code files: ${excluded.join(", ")}`);
console.log(`[fork-test] ${SKIPPED_TESTS.length} skip patterns active`);

const skipArgs = SKIPPED_TESTS.flatMap(([name]) => ["--test-skip-pattern", `^${escape(name)}$`]);
const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
const result = spawnSync(tsx, ["--test", ...skipArgs, ...run], {
	cwd: ROOT,
	stdio: "inherit",
	env: { ...process.env, NODE_ENV: "test" },
});
process.exit(result.status ?? 1);
