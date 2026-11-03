/**
 * Fork-only: guards the node-essay feature. In multiple-choice mode the
 * teacher holds `explain` alongside `quiz` (src/agent/tools.ts) so it can ask
 * node-closing essays; the doctrine lives in prompts/teacher/32-node-essay.md
 * and composes into the teacher prompt only. The prober's registry is
 * unchanged.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-node-essay-"));
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
};
after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");

// Registry construction never touches the stores (they are only read inside
// execute), so inert stand-ins are enough.
const stub = {} as never;
const teacherCtx = { chatId: "essay-test", chatStore: stub, jobStore: stub, spawn: () => {} };
const proberCtx = { chatId: "essay-test", jobStore: stub, spawn: () => {} } as never;

describe("node essays (fork)", () => {
	it("choice mode gives the teacher both quiz and explain", () => {
		for (const enabled of [undefined, {}, { explain: false }]) {
			const tools = createTeacherTools(teacherCtx, enabled);
			assert.ok(tools.quiz, "quiz present");
			assert.ok(tools.explain, "explain present");
		}
	});

	it("free mode keeps explain only", () => {
		const tools = createTeacherTools(teacherCtx, { explain: true });
		assert.ok(tools.explain);
		assert.equal(tools.quiz, undefined);
	});

	// Replaces the skipped upstream "createTeacherTools: {research: false} …"
	// test (tests/question-tools.test.ts) with the fork's choice-mode list.
	it("teacher toggles still remove exactly the toggled tool, in both mechanics", () => {
		const choiceFull = ["ask_user_question", "demo", "explain", "find", "grep", "ls", "pdf", "plan_init", "quiz", "read", "research", "visual"];
		assert.deepEqual(Object.keys(createTeacherTools(teacherCtx)).sort(), choiceFull);
		assert.deepEqual(Object.keys(createTeacherTools(teacherCtx, {})).sort(), choiceFull, "absent keys mean enabled");
		assert.deepEqual(Object.keys(createTeacherTools(teacherCtx, { research: false })).sort(), choiceFull.filter((t) => t !== "research"));
		const freeFull = choiceFull.filter((t) => t !== "quiz");
		assert.deepEqual(Object.keys(createTeacherTools(teacherCtx, { explain: true })).sort(), freeFull);
		assert.deepEqual(Object.keys(createTeacherTools(teacherCtx, { explain: true, research: false })).sort(), freeFull.filter((t) => t !== "research"));
	});

	it("the prober registry is unchanged", () => {
		const choice = createProberTools(proberCtx);
		assert.ok(choice.probe);
		assert.equal(choice.recall, undefined);
		assert.equal(choice.quiz, undefined);
		assert.equal(choice.explain, undefined);
		const free = createProberTools(proberCtx, { explain: true });
		assert.ok(free.recall);
		assert.equal(free.probe, undefined);
		assert.equal(free.quiz, undefined);
		assert.equal(free.explain, undefined);
	});

	it("the Node essays fragment composes into the teacher prompt only", () => {
		assert.match(composeInstructions("teacher"), /# Node essays — explain it back before moving on/);
		assert.doesNotMatch(composeInstructions("prober"), /Node essays/);
	});
});
