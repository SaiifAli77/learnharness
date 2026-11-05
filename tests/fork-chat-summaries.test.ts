/**
 * Fork-only: guards the chat-list summary cache (src/store/fork-chat-summaries.ts,
 * hooked into listChats in src/store/chats.ts). Every listing must equal a
 * cold one (an empty cache reads and projects every file, as listChats did
 * before), and an unchanged file must not be read again. Runs under an
 * isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import ts from "typescript";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-chat-summaries-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { PATHS } = await import("../config.ts");
const { forkChatSummaryConfig, forkChatSummaryStats, resetForkChatSummaries } = await import("../src/store/fork-chat-summaries.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const quizCall = (id: string): LhMessage[] => [
	{ id: `u_${id}`, role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } as never,
	{ id: `a_${id}`, role: "assistant", content: [{ type: "toolCall", id, name: "quiz", arguments: { question: "q?", options: ["a", "b"], correct: [1] } }], api: "faux", provider: "test", model: "m", usage, stopReason: "toolUse", timestamp: 2 } as never,
];
const fileOf = (id: string) => path.join(PATHS.chats, `${id}.json`);
let stamp = Date.now() / 1000 - 3600;
/** Give a file a unique, old mtime (ctime still moves on its own). */
const age = (id: string) => {
	stamp += 7;
	fs.utimesSync(fileOf(id), stamp, stamp);
};

/** listChats with the cache as it is, then cold (empty cache): they must agree. */
function listBoth() {
	const before = { ...forkChatSummaryStats };
	const warm = chatStore.listChats();
	const counts = { reads: forkChatSummaryStats.reads - before.reads, hits: forkChatSummaryStats.hits - before.hits };
	const saved = structuredClone(warm);
	resetForkChatSummaries();
	const cold = chatStore.listChats();
	assert.deepEqual(warm, cold, "a cached listing equals an uncached one");
	assert.deepEqual(warm, saved);
	// Warm the cache again for the next step (the cold call above filled it).
	return { warm, counts };
}

function quietErrors<T>(fn: () => T): { value: T; errors: string[] } {
	const original = console.error;
	const errors: string[] = [];
	console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
	try {
		return { value: fn(), errors };
	} finally {
		console.error = original;
	}
}

beforeEach(() => {
	fs.rmSync(PATHS.chats, { recursive: true, force: true });
	forkChatSummaryConfig.racyMs = 0;
	resetForkChatSummaries();
});

test("chat summaries: listings equal uncached ones across create, modify, rename-over, delete, corrupt and newer-version files; unchanged files are not re-read", () => {
	assert.deepEqual(chatStore.listChats(), []);

	const a = chatStore.createChat("Alpha");
	const b = chatStore.createChat("Beta");
	const p = chatStore.createChat("Practice", "practice");
	chatStore.saveMessages(b.id, quizCall("call_b"));
	for (const id of [a.id, b.id, p.id]) age(id);

	let r = listBoth();
	assert.equal(r.warm.length, 3);
	assert.equal(r.warm.find((s) => s.id === b.id)?.messageCount, 2);
	r = listBoth();
	assert.deepEqual(r.counts, { reads: 0, hits: 3 }, "nothing changed: no file is read again");

	// An atomic write (a new inode renamed over the file).
	chatStore.saveMessages(a.id, quizCall("call_a"));
	age(a.id);
	r = listBoth();
	assert.deepEqual(r.counts, { reads: 1, hits: 2 });
	assert.equal(r.warm.find((s) => s.id === a.id)?.messageCount, 2);

	// An in-place write of the same size (same inode, same size).
	const text = fs.readFileSync(fileOf(a.id), "utf8");
	fs.writeFileSync(fileOf(a.id), text.replace('"Alpha"', '"Alfa!"'));
	age(a.id);
	assert.equal(fs.statSync(fileOf(a.id)).size, Buffer.byteLength(text));
	r = listBoth();
	assert.deepEqual(r.counts, { reads: 1, hits: 2 });
	assert.equal(r.warm.find((s) => s.id === a.id)?.title, "Alfa!");

	// Another program renames a new file over it.
	const tmp = path.join(PATHS.chats, "elsewhere.tmp");
	fs.writeFileSync(tmp, text.replace('"Alpha"', '"Gamma"'));
	fs.renameSync(tmp, fileOf(a.id));
	age(a.id);
	r = listBoth();
	assert.deepEqual(r.counts, { reads: 1, hits: 2 });
	assert.equal(r.warm.find((s) => s.id === a.id)?.title, "Gamma");

	// A rename through the store (an atomic write).
	chatStore.renameChat(p.id, "Practice renamed");
	age(p.id);
	r = listBoth();
	assert.deepEqual(r.counts, { reads: 1, hits: 2 });

	// Delete: gone from the listing, and the next listing reads nothing.
	chatStore.deleteChat(b.id);
	r = listBoth();
	assert.equal(r.warm.length, 2);
	assert.equal(r.warm.some((s) => s.id === b.id), false);
	assert.deepEqual(listBoth().counts, { reads: 0, hits: 2 });

	// Corrupt, newer-version and unprojectable files are never cached: each
	// listing reads them again and logs exactly what an uncached one logs.
	fs.writeFileSync(path.join(PATHS.chats, "chat_corrupt.json"), "{ not json");
	fs.writeFileSync(path.join(PATHS.chats, "chat_future.json"), JSON.stringify({ id: "chat_future", title: "Future", createdAt: "x", updatedAt: "x", messages: [], version: 9_999 }));
	fs.writeFileSync(path.join(PATHS.chats, "chat_broken.json"), JSON.stringify({ id: "chat_broken", title: "Broken", createdAt: "x", updatedAt: "x", messages: null }));
	for (const id of ["chat_corrupt", "chat_future", "chat_broken"]) age(id);
	const logs: string[][] = [];
	for (let i = 0; i < 3; i++) {
		const { value, errors } = quietErrors(() => listBoth());
		logs.push(errors);
		assert.equal(value.warm.length, 2, "failed records stay absent");
		if (i > 0) assert.deepEqual(value.counts, { reads: 3, hits: 2 }, "only the three failing files are read again");
	}
	// Each listBoth() is a warm and a cold listing; both log the same two errors.
	for (const errors of logs) {
		assert.equal(errors.length, 4);
		assert.equal(errors.filter((e) => e.includes("[chat chat_future]") && e.includes("schema version 9999")).length, 2);
		assert.equal(errors.filter((e) => e.includes("[chat chat_broken] summary projection failed")).length, 2);
	}

	// Fixed files are picked up.
	fs.writeFileSync(path.join(PATHS.chats, "chat_corrupt.json"), JSON.stringify({ id: "chat_corrupt", title: "Fixed", createdAt: "y", updatedAt: "y", messages: [] }));
	age("chat_corrupt");
	const fixed = quietErrors(() => listBoth()).value;
	assert.equal(fixed.warm.find((s) => s.id === "chat_corrupt")?.title, "Fixed");
});

test("chat summaries: callers get a fresh copy every time", () => {
	const c = chatStore.createChat("Mutable");
	chatStore.saveSettings?.(c.id, { model: "x" } as never);
	age(c.id);
	const first = chatStore.listChats();
	const second = chatStore.listChats();
	assert.equal(forkChatSummaryStats.hits, 1);
	assert.notEqual(first[0], second[0]);
	(second[0] as { title: string }).title = "changed by a caller";
	for (const v of Object.values(second[0]!)) if (v && typeof v === "object") (v as Record<string, unknown>).poked = true;
	const third = chatStore.listChats();
	assert.deepEqual(third, first, "a caller's mutation never reaches the cache");
	chatStore.deleteChat(c.id);
});

test("chat summaries: a file written within the racy window is read again", () => {
	forkChatSummaryConfig.racyMs = 3_000;
	const c = chatStore.createChat("Fresh");
	chatStore.listChats();
	chatStore.listChats();
	assert.deepEqual({ ...forkChatSummaryStats }, { reads: 2, hits: 0 }, "a just-written file is never trusted by its timestamps");
	age(c.id);
	// utimes moved ctime to now: still racy.
	chatStore.listChats();
	assert.equal(forkChatSummaryStats.hits, 0);
	chatStore.deleteChat(c.id);
});

test("chat summaries: listChats still hands forkCachedChat's records straight to forkCachedSummary", () => {
	// A cache hit passes a stand-in record from forkCachedChat to
	// forkCachedSummary. Any stage upstream adds between them would see the
	// stand-in instead of the record.
	const file = path.join(import.meta.dirname, "..", "src", "store", "chats.ts");
	const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	let fn: ts.FunctionDeclaration | undefined;
	sf.forEachChild((n) => {
		if (ts.isFunctionDeclaration(n) && n.name?.text === "listChats") fn = n;
	});
	const advice = "re-check src/store/fork-chat-summaries.ts against this upstream change to listChats (src/store/chats.ts)";
	assert.ok(fn, `listChats not found: ${advice}`);
	// The method chain containing forkCachedChat, outermost call first.
	let chain: ts.CallExpression | undefined;
	const find = (n: ts.Node) => {
		if (!chain && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.getText(sf).includes("forkCachedChat(")) chain = n;
		ts.forEachChild(n, find);
	};
	find(fn);
	assert.ok(chain, `no method chain with forkCachedChat in listChats: ${advice}`);
	const stages: Array<{ name: string; args: readonly ts.Expression[] }> = [];
	for (let e: ts.Expression = chain; ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression); e = e.expression.expression) {
		stages.unshift({ name: e.expression.name.text, args: e.arguments });
	}
	const i = stages.findIndex((st) => st.name === "map" && st.args[0]?.getText(sf).includes("forkCachedChat("));
	assert.ok(i >= 0, `forkCachedChat is no longer a .map stage of listChats: ${advice}`);
	const filter = stages[i + 1];
	assert.ok(filter?.name === "filter" && /^\(r\)[^=]*=>\s*r !== null$/.test(filter.args[0]?.getText(sf) ?? ""), `the stage after forkCachedChat is no longer the \`r !== null\` filter: ${advice}`);
	const project = stages[i + 2];
	const wrapped = project?.args[0];
	assert.ok(
		project?.name === "map" && wrapped && ts.isCallExpression(wrapped) && ts.isIdentifier(wrapped.expression) && wrapped.expression.text === "forkCachedSummary",
		`the stage after the null filter is no longer .map(forkCachedSummary(…)): ${advice}`,
	);
});
