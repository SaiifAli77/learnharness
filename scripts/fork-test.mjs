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
	// expects upstream's removed "External CLI" settings group
	["Providers has five ordered sections including External CLI; unknown variables stay masked/read-only at the end of Model API keys"],
	// upstream's claude-code opus id (provider switched off)
	["claude-code/opus: includes tool and description in all conversation agents"],
	// upstream's claude-code sonnet id (provider switched off)
	["claude-code/sonnet: includes tool and description in all conversation agents"],
	// upstream's claude-code haiku id (provider switched off)
	["claude-code/haiku: includes tool and description in all conversation agents"],
	// upstream's CLI catalog models (provider not registered)
	["modelCatalog() lists claude-code opus/sonnet/haiku when the CLI is installed"],
	// upstream's CLI availability row (CLAUDE_CODE_PROVIDER renamed)
	["catalogProviders() marks claude-code present when the CLI is installed"],
	// resolves upstream's unregistered provider
	["piEngineForSpec({ provider: \"claude-code\", id: \"sonnet\" }) resolves"],
	// upstream's CLI opt-in/availability gate
	["providerKeyPresent(\"claude-code\") requires both explicit opt-in and executable presence"],
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
