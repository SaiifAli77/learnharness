/**
 * Fork-only: guards the streamed-row reuse (components/fork-transcript-rows.ts,
 * used by the transcript memo in components/chat.tsx).
 *
 * The golden test runs the REAL row callback: it loads a copy of
 * components/chat.tsx with one extra export that rebuilds the transcript
 * useMemo's body from its source text (so it follows upstream edits), drives
 * a synthetic turn through SessionModel, and at every step compares the
 * markup of the rows with the cache against a plain `messages.map` of the
 * same callback.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import React, { act, createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import ts from "typescript";
import { FORK_ROW_DISPATCH_PARTS, forkDeepEqual, forkRows, type ForkRowCache } from "../components/fork-transcript-rows.ts";
import { JobsContext } from "../components/jobs-context.ts";
import { SessionModel } from "../components/session-core.ts";
import {
	findPendingToolCall,
	firstSourceTextParts,
	malformedQuestionsOf,
	pendingQuestionOf,
	phaseTimeline,
	type LhMessage,
	type LhViewMessage,
} from "../src/core/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHAT = path.join(ROOT, "components", "chat.tsx");

// ── the harness: chat.tsx + an export that rebuilds the transcript memo body ──

type Scope = Record<string, unknown>;
type Harness = (scope: Scope) => { rows: () => ReactNode[]; row: (m: LhViewMessage, mi: number) => ReactNode };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-rows-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function loadHarness(): Promise<{ harness: Harness; scopeNames: string[] }> {
	const src = fs.readFileSync(CHAT, "utf8");
	const program = ts.createProgram([CHAT], {
		jsx: ts.JsxEmit.Preserve,
		noResolve: true,
		noEmit: true,
		allowImportingTsExtensions: true,
		target: ts.ScriptTarget.ES2022,
	});
	const checker = program.getTypeChecker();
	const sf = program.getSourceFile(CHAT)!;
	let chat: ts.FunctionDeclaration | undefined;
	sf.forEachChild((n) => {
		if (ts.isFunctionDeclaration(n) && n.name?.text === "Chat") chat = n;
	});
	assert.ok(chat, "Chat not found");
	let memo: ts.ArrowFunction | undefined;
	const visit = (n: ts.Node) => {
		if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useMemo" && n.arguments[0] && ts.isArrowFunction(n.arguments[0]) && n.arguments[0].getText(sf).includes("forkRows(")) memo = n.arguments[0];
		ts.forEachChild(n, visit);
	};
	visit(chat!);
	assert.ok(memo, "transcript useMemo not found");
	const call = memo!.body as ts.CallExpression;
	const rowArg = call.arguments[4]!;
	const inside = (node: ts.Node, outer: ts.Node) => node.pos >= outer.pos && node.end <= outer.end;
	const names = new Set<string>();
	const walk = (n: ts.Node) => {
		if (ts.isIdentifier(n)) {
			const p = n.parent;
			const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isJsxAttribute(p) && p.name === n);
			if (!isName) {
				const sym = ts.isShorthandPropertyAssignment(p) && p.name === n ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(n);
				for (const d of sym?.declarations ?? []) if (d.getSourceFile() === sf && inside(d, chat!) && !inside(d, memo!)) names.add(n.text);
			}
		}
		ts.forEachChild(n, walk);
	};
	walk(memo!);
	const scopeNames = [...names].sort();
	const harnessSrc =
		"/** @jsxRuntime automatic @jsxImportSource react */\n" + // the repo's jsx: react-jsx (no tsconfig applies out here)
		src.replace(/(from |import\()"@\/([^"]+)"/g, (_m, kw: string, rest: string) => `${kw}"${path.join(ROOT, rest)}"`) +
		`\nexport function __forkRowHarness(__scope: Record<string, any>) {\n` +
		`\tconst { ${scopeNames.join(", ")} } = __scope;\n` +
		`\treturn { rows: () => ${call.getText(sf)}, row: ${rowArg.getText(sf)} };\n}\n`;
	// node_modules next to the copy, so react/jsx-runtime resolves to the same
	// instance, and an ES module package like the repo's.
	fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ type: "module" }));
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(TMP, "node_modules"), "dir");
	const file = path.join(TMP, "chat-harness.tsx");
	fs.writeFileSync(file, harnessSrc);
	const mod = (await import(pathToFileURL(file).href)) as { __forkRowHarness: Harness };
	return { harness: mod.__forkRowHarness, scopeNames };
}

let harnessPromise: ReturnType<typeof loadHarness> | undefined;
const getHarness = () => (harnessPromise ??= loadHarness());

/** Chat's stable values (a new function would change the epoch and drop the cache). */
const STABLE = { setPlanOpen: () => {}, draftRef: { current: null }, send: async () => {} };

/** The memo's scope for hand-built view rows while a turn streams. */
function busyScope(messages: LhViewMessage[], cacheRef: { current: ForkRowCache | undefined }): Scope {
	return {
		...STABLE,
		forkRowCache: cacheRef,
		messages,
		nativeMessages: [],
		status: "streaming",
		busy: true,
		compacting: false,
		hiddenOldest: 0,
		phases: phaseTimeline(messages),
		sourceTextParts: firstSourceTextParts(messages),
		pending: null,
		malformedQuestions: [],
	};
}

// ── synthetic record ──

let clock = 1_000;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp: clock++ }) as never;
const assistant = (id: string | undefined, content: unknown[], stopReason = "stop"): LhMessage =>
	({ ...(id ? { id } : {}), role: "assistant", content, api: "openai-completions", provider: "openrouter", model: "test", usage, stopReason, timestamp: clock++ }) as never;
const result = (id: string, toolCallId: string, toolName: string, details: unknown, text = "ok"): LhMessage =>
	({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError: false, timestamp: clock++ }) as never;
const quizAnswer = {
	kind: "quiz",
	tool: "quiz",
	questionText: "Which is larger?",
	options: [{ index: 1, label: "2" }, { index: 2, label: "3" }],
	dontKnow: false,
	answers: [{ index: 2 }],
	correct: true,
	correctIndices: [2],
	explanation: "3 > 2.",
};

const base: LhMessage[] = [
	user("u1", "Teach me averages."),
	assistant("a1", [
		{ type: "thinking", thinking: "Start from a tiny dataset." },
		{ type: "text", text: "Take **three** numbers: 2, 4, 6." },
		{ type: "toolCall", id: "c_read", name: "read", arguments: { path: "notes/averages.md" } },
	]),
	result("r1", "c_read", "read", { text: "Mean = sum / n" }),
	assistant("a1b", [
		{ type: "text", text: "Their sum is $12$, so the mean is $4$." },
		{ type: "toolCall", id: "c_quiz", name: "quiz", arguments: { question: "Which is larger?", options: ["2", "3"], correct: [2] } },
	]),
	result("r_quiz", "c_quiz", "quiz", quizAnswer),
	user("u2", "Now medians."),
	assistant("a2", [
		{ type: "thinking", thinking: "Medians resist outliers." },
		{ type: "text", text: "Sort them and take the middle one." },
		{ type: "toolCall", id: "c_ls", name: "ls", arguments: { path: "notes" } },
	]),
	user("u3", "And the mode?"),
];

type Step = { label: string; busy: boolean; expectReused?: (key: string) => boolean };

test("forkRows: rows with the cache render exactly like messages.map at every step of a streamed turn, and unchanged rows are reused while busy", async () => {
	const { harness, scopeNames } = await getHarness();
	const model = new SessionModel({ chatId: "chat_fixture", initialMessages: base });
	const setStatus = (s: string) => (model as unknown as { setStatus(s: string): void }).setStatus(s);
	const cacheRef: { current: ForkRowCache | undefined } = { current: undefined };
	const stable = { setPlanOpen: () => {}, draftRef: { current: null }, send: async () => {} };

	let previous: { keys: string[]; rows: ReactNode[] } | undefined;
	let checkedReuse = 0;
	const check = ({ label, busy, expectReused }: Step) => {
		const state = model.getState();
		const messages = state.messages;
		const scope: Scope = {
			...stable,
			forkRowCache: cacheRef,
			messages,
			nativeMessages: state.nativeMessages,
			status: state.status,
			busy,
			compacting: false,
			hiddenOldest: 0,
			phases: phaseTimeline(messages),
			sourceTextParts: firstSourceTextParts(messages),
			pending: findPendingToolCall(messages, pendingQuestionOf(state.nativeMessages)),
			malformedQuestions: malformedQuestionsOf(state.nativeMessages),
		};
		for (const name of scopeNames) assert.ok(name in scope, `the transcript memo reads \`${name}\`; add it to this test's scope`);
		const h = harness(scope);
		const cached = h.rows();
		const plain = messages.map((m, mi) => h.row(m, mi));
		const html = (rows: ReactNode[]) => renderToStaticMarkup(createElement(Fragment, null, rows));
		assert.equal(html(cached), html(plain), `markup differs at step: ${label}`);
		const keys = messages.map((m, mi) => m.id || `m-${mi}`);
		if (expectReused && previous) {
			for (const [i, key] of keys.entries()) {
				const j: number = previous.keys.indexOf(key);
				const reused: boolean = j === i && cached[i] === previous.rows[j];
				assert.equal(reused, expectReused(key), `step "${label}": row ${key} ${reused ? "was" : "was not"} reused`);
				if (reused) checkedReuse++;
			}
		}
		previous = { keys, rows: cached };
		return messages;
	};

	check({ label: "idle record", busy: false });
	setStatus("submitted");
	check({ label: "submitted", busy: true });
	setStatus("streaming");
	check({ label: "streaming flag", busy: true });
	const all = () => true;

	// A new assistant message streams: empty → thinking → text → a tool call being written.
	model.applyWireEvent({ type: "message_start", message: assistant(undefined, []) });
	check({ label: "message_start", busy: true });
	const rowsNow = () => model.getState().messages.map((m, mi) => m.id || `m-${mi}`);
	const lastKey = () => rowsNow().at(-1)!;
	const streamRow = lastKey();
	const notStreamRow = (key: string) => key !== streamRow;
	model.applyWireEvent({ type: "message_update", message: assistant(undefined, [{ type: "thinking", thinking: "The mode is" }]) });
	check({ label: "thinking delta 1", busy: true, expectReused: notStreamRow });
	model.applyWireEvent({ type: "message_update", message: assistant(undefined, [{ type: "thinking", thinking: "The mode is the most common value." }]) });
	check({ label: "thinking delta 2", busy: true, expectReused: notStreamRow });
	// A marker injected mid-run lands after the streaming row: that row is no
	// longer last, so its thinking stops showing as streaming and it renders
	// again even though its content is unchanged.
	model.applyWireEvent({ type: "message_start", message: { role: "custom", id: "steer_next", customType: "practice-next", content: "Next problem", display: false, details: null, timestamp: clock++ } });
	check({ label: "marker after the streaming row", busy: true, expectReused: (key) => key !== streamRow && key !== "steer_next" });
	model.applyWireEvent({ type: "message_update", message: assistant(undefined, [{ type: "thinking", thinking: "The mode is the most common value." }, { type: "text", text: "The **mode** is" }]) });
	check({ label: "text delta 1", busy: true, expectReused: notStreamRow });
	const done = [
		{ type: "thinking", thinking: "The mode is the most common value." },
		{ type: "text", text: "The **mode** is the value that appears most often." },
		{ type: "toolCall", id: "c_grep", name: "grep", arguments: { pattern: "mode" } },
	];
	model.applyWireEvent({ type: "message_update", message: assistant(undefined, done) });
	check({ label: "tool call streaming", busy: true, expectReused: notStreamRow });
	// An identical update (no change at all) reuses every row.
	model.applyWireEvent({ type: "message_update", message: assistant(undefined, done) });
	check({ label: "identical update", busy: true, expectReused: all });
	model.applyWireEvent({ type: "tool_execution_end", toolCallId: "c_grep", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "mode: 1 match" }], details: { text: "mode: 1 match" } } });
	check({ label: "tool executed", busy: true, expectReused: notStreamRow });
	model.applyWireEvent({ type: "message_end", message: assistant(undefined, done, "toolUse") });
	check({ label: "message_end", busy: true });

	// A delayed result for an OLD row (a2's ls call) arrives in the turn's
	// results batch. The streaming row is unchanged (grep's result matches
	// its execution), so only a2 renders again.
	model.applyWireEvent({
		type: "turn_end",
		toolResults: [
			{ role: "toolResult", toolCallId: "c_grep", toolName: "grep", content: [{ type: "text", text: "mode: 1 match" }], details: { text: "mode: 1 match" }, isError: false, timestamp: clock++ },
			{ role: "toolResult", toolCallId: "c_ls", toolName: "ls", content: [{ type: "text", text: "averages.md" }], details: { text: "averages.md" }, isError: false, timestamp: clock++ },
		],
	});
	check({ label: "delayed result for an old row", busy: true, expectReused: (key) => key !== "a2" });

	// The next step streams below the marker, as a new row: the marker is no
	// longer last either.
	model.applyWireEvent({ type: "message_start", message: assistant(undefined, []) });
	check({ label: "second step start", busy: true, expectReused: (key) => key !== "steer_next" && key !== lastKey() });
	const notLast = (key: string) => key !== lastKey();
	model.applyWireEvent({ type: "message_update", message: assistant(undefined, [{ type: "thinking", thinking: "Check: 2 appears twice." }, { type: "text", text: "For 2, 2, 5 it is 2." }]) });
	check({ label: "second step text", busy: true, expectReused: notLast });
	model.applyWireEvent({ type: "message_end", message: assistant(undefined, [{ type: "thinking", thinking: "Check: 2 appears twice." }, { type: "text", text: "For 2, 2, 5 it is 2." }]) });
	check({ label: "second step end (same content)", busy: true, expectReused: all });

	// The status change ends the reuse: every row renders again and the cache drops.
	setStatus("ready");
	check({ label: "settled (not busy)", busy: false });
	assert.equal(cacheRef.current, undefined, "the cache is dropped when not busy");
	assert.ok(checkedReuse > 40, `expected many reused rows, saw ${checkedReuse}`);
});

// ── forkRows unit behaviour ──

const msg = (id: string, text: string): LhViewMessage => ({ id, role: "assistant", parts: [{ type: "text", id: `${id}-t0`, text, state: "done" }] }) as LhViewMessage;

test("forkRows: idle renders every row; busy reuses unless the row, its signature or the epoch changes", () => {
	let renders = 0;
	const render = (m: LhViewMessage, mi: number) => {
		renders++;
		return createElement("p", { key: m.id || `m-${mi}` }, String(m.parts[0]?.text));
	};
	const cache: { current: ForkRowCache | undefined } = { current: undefined };
	const anchors = (ms: LhViewMessage[]) => new Map(ms.map((m) => [m.id, `${m.id}-t0`]));
	const run = (ms: LhViewMessage[], epoch: { busy: boolean } & Record<string, unknown>, phases: string[] = ms.map(() => "teach"), srcParts = anchors(ms)) => {
		renders = 0;
		const out = forkRows(cache, ms, { phases: phases as never, sourceTextParts: srcParts }, epoch, render);
		return { out, renders };
	};
	const ms = [msg("a", "one"), msg("b", "two"), msg("c", "three")];
	assert.equal(run(ms, { busy: false }).renders, 3);
	assert.equal(run(ms, { busy: false }).renders, 3, "idle never reuses");
	const first = run(ms, { busy: true, status: "streaming" });
	assert.equal(first.renders, 3);
	const again = run(ms.map((m) => structuredClone(m)), { busy: true, status: "streaming" });
	assert.equal(again.renders, 0, "deep-equal rebuilt rows are reused");
	assert.ok(again.out.every((el, i) => el === first.out[i]));
	assert.equal(run([...ms.slice(0, 2), msg("c", "three!")], { busy: true, status: "streaming" }).renders, 1, "only the changed row renders");
	assert.equal(run([...ms.slice(0, 2), msg("c", "three!")], { busy: true, status: "ready" }).renders, 3, "an epoch change drops the cache");
	assert.equal(run([...ms.slice(0, 2), msg("c", "three!")], { busy: true, status: "ready", extra: 1 }).renders, 3, "a new epoch key drops the cache");
	const four = [...ms.slice(0, 2), msg("c", "three!"), msg("d", "four")];
	assert.equal(run(four, { busy: true, status: "ready", extra: 1 }).renders, 2, "the old last row renders again (it is no longer last), and the new one");
	assert.equal(run(four, { busy: true, status: "ready", extra: 1 }, ["teach", "probe", "teach", "teach"]).renders, 2, "a phase change re-renders that row and the next (phases[mi - 1])");
	const moved = anchors(four);
	moved.set("a", "elsewhere");
	assert.equal(run(four, { busy: true, status: "ready", extra: 1 }, ["teach", "probe", "teach", "teach"], moved).renders, 1, "an anchor change re-renders its row");
	assert.equal(run([four[1]!, four[0]!, four[2]!, four[3]!], { busy: true, status: "ready", extra: 1 }, ["teach", "probe", "teach", "teach"], moved).renders, 2, "moved rows (new index) render again");
	run(four, { busy: false });
	assert.equal(cache.current, undefined);
	// A row with a job-dispatch part always renders (its card reads the clock).
	for (const type of FORK_ROW_DISPATCH_PARTS) {
		const withJob: LhViewMessage = { id: "j", role: "assistant", parts: [{ type, toolCallId: "c", state: "output-available", input: {}, output: "Dispatched." }] } as LhViewMessage;
		run([...four, withJob], { busy: true });
		assert.equal(run([...four, structuredClone(withJob)], { busy: true }).renders, 1, `${type}: only the dispatch row renders again`);
	}
});

test("forkDeepEqual: plain data by value, undefined vs missing keys differ, other objects by identity", () => {
	assert.ok(forkDeepEqual("a", "a"));
	assert.ok(forkDeepEqual(NaN, NaN));
	assert.ok(!forkDeepEqual(0, -0), "Object.is semantics");
	assert.ok(!forkDeepEqual(1, "1"));
	assert.ok(!forkDeepEqual(null, undefined));
	assert.ok(!forkDeepEqual(null, {}));
	assert.ok(forkDeepEqual({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null }));
	assert.ok(!forkDeepEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] }));
	assert.ok(!forkDeepEqual({ a: undefined }, {}), "a key holding undefined differs from a missing key");
	assert.ok(!forkDeepEqual({}, { a: undefined }));
	assert.ok(!forkDeepEqual({ a: undefined, b: 1 }, { b: 1, c: undefined }));
	assert.ok(!forkDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), "key order matters (JSON.stringify shows it)");
	assert.ok(!forkDeepEqual({ x: { a: 1, b: 2 } }, { x: { b: 2, a: 1 } }), "nested key order matters");
	assert.ok(forkDeepEqual({ 2: "b", 1: "a" }, { 1: "a", 2: "b" }), "integer keys are always ascending, as in JSON.stringify");
	assert.ok(!forkDeepEqual([1, 2], [1, 2, 3]));
	assert.ok(!forkDeepEqual([1, 2], { 0: 1, 1: 2, length: 2 }), "an array is not an array-like object");
	assert.ok(!forkDeepEqual([1, , 3], [1, undefined, 3]), "a hole differs from undefined");
	assert.ok(!forkDeepEqual(Object.assign([, 1], { x: 1 }), Object.assign([, 1], { x: 2 })), "extra properties of sparse arrays are compared");
	assert.ok(!forkDeepEqual(Object.assign([, 1], { x: 1 }), Object.assign([, 1], { y: 1 })));
	assert.ok(!forkDeepEqual([1, ,], [1]), "a trailing hole changes length");
	assert.ok(!forkDeepEqual(Object.assign([1], { x: 1, y: 2 }), Object.assign([1], { y: 2, x: 1 })), "array property order matters too");
	const extra = Object.assign([1], { x: 1 });
	assert.ok(!forkDeepEqual(extra, Object.assign([1], { y: 1 })));
	assert.ok(forkDeepEqual(extra, Object.assign([1], { x: 1 })));
	const sym = Symbol("s");
	assert.ok(!forkDeepEqual({ [sym]: 1 }, { [sym]: 2 }));
	assert.ok(!forkDeepEqual(new Date(0), new Date(0)), "non-plain objects compare by identity");
	assert.ok(!forkDeepEqual(new Map(), new Map()));
	const shared = new Map();
	assert.ok(forkDeepEqual({ m: shared }, { m: shared }));
	assert.ok(!forkDeepEqual(Object.create(null), {}), "different prototypes");
	assert.ok(forkDeepEqual(Object.create(null), Object.create(null)));
	const f = () => {};
	assert.ok(forkDeepEqual({ f }, { f }));
	assert.ok(!forkDeepEqual({ f }, { f: () => {} }));
	const cyc1: Record<string, unknown> = {};
	cyc1.self = cyc1;
	const cyc2: Record<string, unknown> = {};
	cyc2.self = cyc2;
	assert.equal(forkDeepEqual(cyc1, cyc2), false, "cycles are bounded (treated as different)");
});

test("forkRows: a reordered tool input/output is not reused (ToolCallCard shows JSON.stringify order)", async () => {
	const { harness } = await getHarness();
	const cacheRef: { current: ForkRowCache | undefined } = { current: undefined };
	const rows = (input: unknown, output: unknown): LhViewMessage[] => [
		{ id: "u1", role: "user", parts: [{ type: "text", id: "u1-t0", text: "list my notes", state: "done" }] } as LhViewMessage,
		{ id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-ls", toolCallId: "c_ls", state: "output-available", input, output }] } as LhViewMessage,
		{ id: "a2x", role: "user", parts: [{ type: "text", id: "a2x-t0", text: "streaming…", state: "done" }] } as LhViewMessage,
	];
	const render = (messages: LhViewMessage[]) => {
		const h = harness(busyScope(messages, cacheRef));
		const html = (r: ReactNode[]) => renderToStaticMarkup(createElement(Fragment, null, r));
		return { cached: html(h.rows()), plain: html(messages.map((m, mi) => h.row(m, mi))) };
	};
	const first = render(rows({ path: "notes", opts: { depth: 1, all: true } }, { entries: ["a.md"], meta: { count: 1, dir: "notes" } }));
	assert.equal(first.cached, first.plain);
	const firstRows = cacheRef.current!.rows;
	const same = render(rows({ path: "notes", opts: { depth: 1, all: true } }, { entries: ["a.md"], meta: { count: 1, dir: "notes" } }));
	assert.equal(same.cached, first.cached);
	assert.equal(cacheRef.current!.rows.get("a1")!.el, firstRows.get("a1")!.el, "an unchanged tool row is reused (the cache is live)");
	const second = render(rows({ opts: { all: true, depth: 1 }, path: "notes" }, { meta: { dir: "notes", count: 1 }, entries: ["a.md"] }));
	assert.notEqual(second.plain, first.plain, "the card's markup shows the new order");
	assert.equal(second.cached, second.plain, "the cached row follows the new order");
});

test("forkRows (mounted): a running job's elapsed time keeps updating while another row streams", async () => {
	const { harness } = await getHarness();
	const dom = parseHTML("<!doctype html><html><body></body></html>");
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const realNow = Date.now;
	let now = 10_000;
	Date.now = () => now;
	try {
		const { createRoot } = await import("react-dom/client");
		const jobs = [{ id: "job_1", kind: "demo", chatId: "c", toolCallId: "c_demo", status: "running", activity: "building the demo", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }];
		const messages = (streamed: string): LhViewMessage[] => [
			{ id: "u1", role: "user", parts: [{ type: "text", id: "u1-t0", text: "show me", state: "done" }] } as LhViewMessage,
			{ id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-demo", toolCallId: "c_demo", state: "output-available", input: { title: "Demo" }, output: "Dispatched (job job_1)." }] } as LhViewMessage,
			{ id: "u2", role: "user", parts: [{ type: "text", id: "u2-t0", text: streamed, state: "done" }] } as LhViewMessage,
		];
		const mount = (mode: "cached" | "plain") => {
			const host = dom.document.createElement("div");
			dom.document.body.appendChild(host);
			const root = createRoot(host);
			const cacheRef: { current: ForkRowCache | undefined } = { current: undefined };
			const render = (streamed: string) => {
				const ms = messages(streamed);
				const h = harness(busyScope(ms, cacheRef));
				const rows = mode === "cached" ? h.rows() : ms.map((m, mi) => h.row(m, mi));
				// The same jobs array every time: JobsContext does not change.
				return act(async () => root.render(createElement(JobsContext.Provider, { value: jobs as never }, rows)));
			};
			return { host, root, render, cacheRef };
		};
		const cached = mount("cached");
		const plain = mount("plain");
		await cached.render("The mode");
		await plain.render("The mode");
		assert.match(plain.host.textContent ?? "", /· 10s/);
		assert.equal(cached.host.textContent, plain.host.textContent);
		now = 12_000;
		const u1 = cached.cacheRef.current!.rows.get("u1")!.el;
		await cached.render("The mode is the most common value.");
		assert.equal(cached.cacheRef.current!.rows.get("u1")!.el, u1, "the other unchanged row is reused (the cache is live)");
		await plain.render("The mode is the most common value.");
		assert.match(plain.host.textContent ?? "", /· 12s/);
		assert.equal(cached.host.textContent, plain.host.textContent, "the cached transcript shows the same elapsed time");
		await act(async () => { cached.root.unmount(); plain.root.unmount(); });
	} finally {
		Date.now = realNow;
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
});
