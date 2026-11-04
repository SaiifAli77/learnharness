/**
 * Fork-only: guards the node-video gate (FORK.md "StatQuest method and slide
 * decks"). Node videos are built two nodes ahead: the first question on a
 * node is rejected once until the exact next two nodes have videos (running
 * or done, or the newest one for that node failed), naming them; DAG order
 * and its fallback; steady state; the in-memory and persisted "reached"
 * nodes; the slides tool's wrong-node guard while a rejection is pending;
 * the last nodes, the settings switch, headless rendering, a running subject
 * video, and the one hook line in upstream createTeacherTools. Re-asserts,
 * with the gate satisfied, the upstream chat-flow explain case that
 * scripts/fork-test.mjs skips.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-gate-"));
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	...(originalEnv.PATH ? { PATH: originalEnv.PATH } : {}),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
};
after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { createTeacherTools, quizExampleBody } = await import("../src/agent/tools.ts");
const { FORK_SLIDES_MARKER, NODE_VIDEO_GATE_MARKER } = await import("../src/core/fork-slides.ts");
const { nextVideoTargets, reachedNodes, pendingNodeVideoGate, NODE_VIDEO_LOOKAHEAD } = await import("../src/agent/fork-slides/node-video-gate.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");

/** A headless browser that is available (the gate asks for videos only when frames can be drawn). */
const browser = { available: () => true, unavailableReason: () => null } as never;
headlessOverride.current = browser;
after(() => {
	headlessOverride.current = undefined;
});
type JobStatus = import("../src/core/contracts.ts").JobStatus;

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A chat with a plan map n1 → n2 → n3 (each node titled in upper case). */
function plannedChat(nodes = ["n1", "n2", "n3"], edges: Array<{ from: string; to: string }> = []): string {
	const id = chatStore.createChat("gate").id;
	chatStore.saveTree(id, { nodes: nodes.map((n) => ({ id: n, title: n.toUpperCase() })), edges, version: 1 });
	return id;
}

/** Persist earlier quiz calls about these nodes (what a past turn leaves in the record). */
function asked(chatId: string, nodes: string[]): void {
	const messages = nodes.map((nodeId, i) => ({
		...fauxAssistantMessage([fauxToolCall("quiz", { type: "check", nodeId, ...quizExampleBody }, { id: `old-${i}` })], { stopReason: "toolUse" }),
		id: `m-${i}`,
	}));
	chatStore.saveMessages(chatId, messages as never);
}

function slidesJob(chatId: string, input: Record<string, unknown>, status: JobStatus): void {
	const job = jobStore.createJob({ kind: "demo", chatId, toolCallId: `job-${Math.random()}`, input: { ...input, [FORK_SLIDES_MARKER]: true } });
	if (status !== "running") jobStore.updateJob(job.id, { status });
}
const video = (nodeId: string) => ({ title: "v", kind: "video", nodeId, stage: "s", slides: [{ steps: [{ say: "a", show: "b" }] }] });
const subject = { kind: "subject", title: "s", of: 1, minutes: 10, parts: [] };
/** A node video script the slides tool accepts (450 spoken words). */
const videoCall = (nodeId: string) => ({
	...video(nodeId),
	slides: [{ steps: [{ say: Array.from({ length: 50 }, () => "one two three four five six seven eight nine").join(" "), show: "x" }] }],
});

const tools = (chatId: string, enabled?: Record<string, boolean>) => createTeacherTools({ chatId, chatStore, jobStore, spawn: () => {} }, enabled);
async function ask(chatId: string, nodeId: string, enabled?: Record<string, boolean>, tool: "quiz" | "explain" = "quiz") {
	const input =
		tool === "quiz"
			? { type: "check", nodeId, ...quizExampleBody }
			: { type: "check", nodeId, question: "Explain why Mercury is hard to observe.", correctAnswer: "It never strays far from the Sun." };
	const res = await tools(chatId, enabled)[tool]!.execute(`call-${Math.random()}`, input as never, undefined as never);
	return { text: (res.content[0] as { text: string }).text, isError: (res as { isError?: boolean }).isError === true };
}
async function slides(chatId: string, nodeId: string) {
	const res = await tools(chatId).slides!.execute(`slides-${Math.random()}`, videoCall(nodeId) as never, undefined as never);
	return { text: (res.content[0] as { text: string }).text, isError: (res as { isError?: boolean }).isError === true };
}
/** The rejection naming two missing nodes. */
const gate2 = (k: string, a: string, b: string) =>
	`This is the first question on node "${k}". ${NODE_VIDEO_GATE_MARKER} (two nodes ahead of the learner): build the video for node "${a}" ("${a.toUpperCase()}") and node "${b}" ("${b.toUpperCase()}") now — ` +
	`the nodes after "${k}", not "${k}" itself (slides with kind: "video" and that nodeId, one call per node) — then re-pose this question.`;
/** The rejection naming one missing node. */
const gate1 = (k: string, a: string) =>
	`This is the first question on node "${k}". ${NODE_VIDEO_GATE_MARKER} (two nodes ahead of the learner): build the video for node "${a}" ("${a.toUpperCase()}") now — ` +
	`a node after "${k}", not "${k}" itself (slides with kind: "video" and that nodeId) — then re-pose this question.`;
const GATE = /This is the first question on node "n1"\. Node videos are built ahead \(two nodes ahead of the learner\): /;
const errorText = (text: string) => text.replace(/^Invalid tool input for tool "(quiz|explain)":\s*/, "").replace(/^- /, "").trim();

// ─── the targets ───────────────────────────────────────────────────────────

describe("node-video gate: the targets (fork)", () => {
	const tree = (nodes: string[], edges: Array<[string, string]> = []) => ({
		nodes: nodes.map((id) => ({ id, title: id })),
		edges: edges.map(([from, to]) => ({ from, to })),
		version: 1,
	});
	const ids = (nodes: Array<{ id: string }>) => nodes.map((n) => n.id);

	it("the next two nodes in plan order after k, skipping reached nodes and k", () => {
		assert.equal(NODE_VIDEO_LOOKAHEAD, 2);
		const t = tree(["a", "b", "c", "d", "e"]);
		assert.deepEqual(ids(nextVideoTargets(t, new Set(), null)), ["a", "b"], "before node 1: nodes 1 and 2");
		assert.deepEqual(ids(nextVideoTargets(t, new Set(), "a")), ["b", "c"]);
		assert.deepEqual(ids(nextVideoTargets(t, new Set(["a", "b"]), "c")), ["d", "e"]);
		assert.deepEqual(ids(nextVideoTargets(t, new Set(["a", "c"]), "b")), ["d", "e"], "a reached node is never a target");
		assert.deepEqual(ids(nextVideoTargets(t, new Set(["a", "b", "c"]), "d")), ["e"], "fewer than two left");
		assert.deepEqual(ids(nextVideoTargets(t, new Set(["a", "b", "c", "d"]), "e")), [], "the last node");
		assert.deepEqual(ids(nextVideoTargets(t, new Set(), "a", 1)), ["b"], "count");
	});

	it("follows prerequisites (reached, k or already picked), and falls back to plan order", () => {
		// late needs mid, mid needs a: at a, mid comes before late although late is listed first.
		const dag = tree(["a", "late", "mid", "x"], [["mid", "late"], ["a", "mid"]]);
		assert.deepEqual(ids(nextVideoTargets(dag, new Set(), "a")), ["mid", "late"], "late's prerequisite was just picked");
		assert.deepEqual(ids(nextVideoTargets(dag, new Set(), null)), ["a", "mid"], "before node 1");
		// p and q need each other: no candidate qualifies, so the first in plan order, then the one it unlocks.
		const cycle = tree(["a", "p", "q"], [["q", "p"], ["p", "q"]]);
		assert.deepEqual(ids(nextVideoTargets(cycle, new Set(), "a")), ["p", "q"]);
		// z needs y and x needs w (never reached): y (needs k) is picked first, then z (needs y, just picked); x never qualifies.
		const blocked = tree(["a", "z", "x", "y"], [["y", "z"], ["w", "x"], ["a", "y"]]);
		assert.deepEqual(ids(nextVideoTargets(blocked, new Set(), "a")), ["y", "z"], "y (needs a) first, then z (needs y, just picked)");
	});
});

// ─── the gate ──────────────────────────────────────────────────────────────

describe("node-video gate (fork)", () => {
	it("rejects the first question on a node once, naming both next nodes; the re-posed question passes without a dispatch", async () => {
		const chatId = plannedChat();
		const first = await ask(chatId, "n1");
		assert.equal(first.isError, true);
		assert.match(first.text, /^Invalid tool input for tool "quiz":/);
		assert.equal(errorText(first.text), gate2("n1", "n2", "n3"));
		assert.deepEqual(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!)?.k, "n1");
		const again = await ask(chatId, "n1");
		assert.equal(again.isError, false, again.text);
		assert.match(again.text, /^Question posed/);
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!), undefined, "the re-posed question ends the pending rejection");
	});

	it("passes once a node asked about before (in the record, even a rejected call) is asked again, across processes", async () => {
		const chatId = plannedChat();
		asked(chatId, ["n1"]);
		assert.equal((await ask(chatId, "n1")).isError, false, "a persisted earlier call (even a rejected one) counts");
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!), undefined);
	});

	it("checks the exact next nodes: their running or finished videos pass, a far node's video does not", async () => {
		for (const status of ["running", "done"] as const) {
			const chatId = plannedChat(["n1", "n2", "n3", "n4"]);
			slidesJob(chatId, video("n2"), status);
			slidesJob(chatId, video("n3"), status);
			assert.equal((await ask(chatId, "n1")).isError, false, status);
		}
		const far = plannedChat(["n1", "n2", "n3", "n4"]);
		slidesJob(far, video("n4"), "done");
		assert.equal(errorText((await ask(far, "n1")).text), gate2("n1", "n2", "n3"), "n4 is not a target at n1");
	});

	it("names only the missing target: steady state (k+1 covered, only k+2 missing)", async () => {
		const chatId = plannedChat(["n1", "n2", "n3", "n4"]);
		asked(chatId, ["n1"]);
		slidesJob(chatId, video("n3"), "running");
		assert.equal(errorText((await ask(chatId, "n2")).text), gate1("n2", "n4"));
		const first = plannedChat(["n1", "n2", "n3"]);
		slidesJob(first, video("n2"), "done");
		assert.equal(errorText((await ask(first, "n1")).text), gate1("n1", "n3"));
	});

	it("follows the plan's prerequisites when picking the targets", async () => {
		const chatId = plannedChat(["n1", "late", "mid"], [{ from: "mid", to: "late" }, { from: "n1", to: "mid" }]);
		assert.equal(errorText((await ask(chatId, "n1")).text), gate2("n1", "mid", "late"));
	});

	it("still rejects when the only videos are for this node, for a node already asked about, or are decks", async () => {
		const own = plannedChat();
		slidesJob(own, video("n1"), "done");
		assert.match((await ask(own, "n1")).text, GATE);
		const behind = plannedChat(["n0", "n1", "n2", "n3"]);
		asked(behind, ["n0"]);
		slidesJob(behind, video("n0"), "done");
		assert.equal(errorText((await ask(behind, "n1")).text), gate2("n1", "n2", "n3"));
		const deck = plannedChat();
		slidesJob(deck, { ...video("n2"), kind: "deck" }, "done");
		slidesJob(deck, { ...video("n3"), kind: "deck" }, "done");
		assert.match((await ask(deck, "n1")).text, GATE, "a deck is not a node video");
	});

	it("a target whose newest video failed is excused, only that node", async () => {
		const one = plannedChat();
		slidesJob(one, video("n2"), "error");
		assert.equal(errorText((await ask(one, "n1")).text), gate1("n1", "n3"), "n2 is excused, n3 is still asked for");
		const both = plannedChat();
		slidesJob(both, video("n2"), "error");
		slidesJob(both, video("n3"), "done");
		assert.equal((await ask(both, "n1")).isError, false, "n2 excused, n3 covered");
		const elsewhere = plannedChat(["n1", "n2", "n3", "n4"]);
		slidesJob(elsewhere, video("n4"), "error");
		assert.equal(errorText((await ask(elsewhere, "n1")).text), gate2("n1", "n2", "n3"), "a failure on another node excuses nothing");
		const recovered = plannedChat();
		slidesJob(recovered, video("n2"), "done");
		slidesJob(recovered, video("n3"), "error");
		await new Promise((r) => setTimeout(r, 5));
		slidesJob(recovered, { ...video("n3"), title: "again" }, "running");
		assert.equal((await ask(recovered, "n1")).isError, false, "a newer running video covers n3");
		const failedAgain = plannedChat();
		slidesJob(failedAgain, video("n2"), "done");
		slidesJob(failedAgain, video("n3"), "running");
		jobStore.listJobs(failedAgain).filter((j) => (j.input as { nodeId?: string }).nodeId === "n3").forEach((j) => jobStore.updateJob(j.id, { status: "error" }));
		assert.equal((await ask(failedAgain, "n1")).isError, false, "n3's newest video failed: excused");
	});

	it("reached nodes include the in-memory rejected ones, then the persisted call after a restart", async () => {
		const chatId = plannedChat(["n1", "n2", "n3", "n4"]);
		assert.match((await ask(chatId, "n1")).text, GATE);
		assert.deepEqual([...reachedNodes(chatId, chatStore.getChat(chatId)!)], ["n1"], "the rejection, not yet in the record");
		// At n2 in the same process (n1 only in memory): the targets skip n1.
		assert.equal(errorText((await ask(chatId, "n2")).text), gate2("n2", "n3", "n4"));
		// A fresh process sees the persisted rejected calls instead.
		const restarted = plannedChat(["n1", "n2", "n3", "n4"]);
		asked(restarted, ["n1"]);
		assert.deepEqual([...reachedNodes(restarted, chatStore.getChat(restarted)!)], ["n1"]);
		assert.equal(errorText((await ask(restarted, "n2")).text), gate2("n2", "n3", "n4"));
	});

	it("passes when headless rendering is unavailable (no video can be drawn)", async () => {
		headlessOverride.current = { available: () => false, unavailableReason: () => "no browser" } as never;
		try {
			assert.equal((await ask(plannedChat(), "n1")).isError, false);
		} finally {
			headlessOverride.current = browser;
		}
		assert.match((await ask(plannedChat(), "n1")).text, GATE, "with a browser it asks again");
	});

	it("passes while the subject video is building, and not after it is done", async () => {
		const building = plannedChat();
		slidesJob(building, subject, "running");
		assert.equal((await ask(building, "n1")).isError, false);
		const built = plannedChat();
		slidesJob(built, subject, "done");
		assert.match((await ask(built, "n1")).text, GATE);
	});

	it("on the last nodes: one target left names one; none left passes", async () => {
		const second = plannedChat(["n0", "n1", "n2"]);
		asked(second, ["n0"]);
		assert.equal(errorText((await ask(second, "n1")).text), gate1("n1", "n2"));
		const last = plannedChat(["n0", "n1"]);
		asked(last, ["n0"]);
		assert.equal((await ask(last, "n1")).isError, false);
		assert.equal((await ask(plannedChat(["n1"]), "n1")).isError, false, "a one-node plan");
	});

	it("is off when the slides tool is switched off", async () => {
		assert.equal((await ask(plannedChat(), "n1", { slides: false })).isError, false);
		assert.match((await ask(plannedChat(), "n1", { research: false })).text, GATE, "other toggles leave it on");
	});

	it("gates explain too, in both mechanics", async () => {
		assert.match((await ask(plannedChat(), "n1", undefined, "explain")).text, /^Invalid tool input for tool "explain":[\s\S]*first question on node "n1"/);
		assert.match((await ask(plannedChat(), "n1", { explain: true }, "explain")).text, GATE);
	});

	it("an otherwise invalid question gets upstream's error only, and uses up no rejection", async () => {
		const chatId = plannedChat();
		const bad = await ask(chatId, "n9");
		assert.match(bad.text, /nodeId "n9" matches no node/);
		assert.doesNotMatch(bad.text, /first question on node/);
		assert.match((await ask(chatId, "n1")).text, GATE, "the gate still fires once for n1");
	});

	// The upstream chat-flow case "explain tool call persists as a pending
	// part; the free-text answer reveals the commitment and reaches the model"
	// (skipped in scripts/fork-test.mjs): its first explain on planet-order in
	// a four-node plan. With the next two nodes' videos built, it is posed.
	it("the skipped upstream explain case: with the next two nodes' videos built, the first explain is posed", async () => {
		const chatId = plannedChat(["planet-order", "genealogy", "indexicals", "modal-realism"]);
		slidesJob(chatId, video("genealogy"), "running");
		slidesJob(chatId, video("indexicals"), "running");
		const res = await tools(chatId, { explain: true }).explain!.execute(
			"call-1",
			{ question: "Explain why Mercury is hard to observe.", correctAnswer: "Its small angular separation from the Sun.", nodeId: "planet-order", type: "check" } as never,
			undefined as never,
		);
		assert.equal((res as { isError?: boolean }).isError, undefined);
		assert.equal((res as { terminate?: boolean }).terminate, true, "the question placeholder ends the turn");
	});

	it("hooks into createTeacherTools with one line (plus its import)", () => {
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent", "tools.ts"), "utf-8");
		assert.match(source, /^import \{ forkNodeVideoGate \} from "\.\/fork-slides\/node-video-gate\.ts";$/m);
		assert.match(source, /^\t\t\t\.\.\.forkNodeVideoGate\(quizzing, ctx, enabled\),$/m);
		assert.match(source, /^\t\t\t\.\.\.jobTools\(ctx\),$/m, "the teacher's whole context reaches slides (the video's nodeId check reads the plan map)");
	});
});

// ─── the slides tool's wrong-node guard ────────────────────────────────────

describe("node-video gate: the wrong-node video while a rejection is pending (fork)", () => {
	it("rejects a video for the node the learner is at, in the same turn, naming the targets", async () => {
		const chatId = plannedChat(["n1", "n2", "n3"]);
		assert.match((await ask(chatId, "n1")).text, GATE);
		const wrong = await slides(chatId, "n1");
		assert.equal(wrong.isError, true);
		assert.match(wrong.text, /The learner is already at "n1"; build the video for "n2" \("N2"\) and "n3" \("N3"\) instead\./);
		assert.equal(jobStore.listJobs(chatId).length, 0, "no job");
		// One right video: the guard names only the one still missing.
		assert.equal((await slides(chatId, "n2")).isError, false);
		assert.match((await slides(chatId, "n1")).text, /The learner is already at "n1"; build the video for "n3" \("N3"\) instead\./);
		assert.equal((await slides(chatId, "n3")).isError, false);
		assert.match((await slides(chatId, "n1")).text, /The learner is already at "n1"; the videos for "n2" \("N2"\) and "n3" \("N3"\) are already dispatched, so re-pose the question instead\./);
		// The re-posed question passes and ends the pending rejection: a video for n1 is fine again (the learner asks for one).
		assert.equal((await ask(chatId, "n1")).isError, false);
		assert.equal((await slides(chatId, "n1")).isError, false, "not pending: any node");
	});

	it("rejects a video for a node already passed, while pending", async () => {
		const chatId = plannedChat(["n1", "n2", "n3", "n4"]);
		asked(chatId, ["n1"]);
		assert.equal(errorText((await ask(chatId, "n2")).text), gate2("n2", "n3", "n4"));
		assert.match((await slides(chatId, "n1")).text, /The learner is already past "n1"; build the video for "n3" \("N3"\) and "n4" \("N4"\) instead\./);
		assert.equal((await slides(chatId, "n4")).isError, false, "a target is fine");
	});

	it("any question that passes the gate ends the pending rejection (the teacher moved on); a new rejection sets a new one", async () => {
		const chatId = plannedChat(["n1", "n2", "n3", "n4", "n5"]);
		asked(chatId, ["n1"]);
		assert.equal(errorText((await ask(chatId, "n2")).text), gate2("n2", "n3", "n4"));
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!)?.k, "n2");
		// Instead of re-posing on n2, the teacher asks about n1 (already reached): it passes and the guard disarms.
		assert.equal((await ask(chatId, "n1")).isError, false);
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!), undefined);
		assert.equal((await slides(chatId, "n2")).isError, false, "a video for n2 is allowed again");
		// A new first question elsewhere is rejected and pending again.
		assert.equal(errorText((await ask(chatId, "n3")).text), gate2("n3", "n4", "n5"));
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!)?.k, "n3");
		assert.match((await slides(chatId, "n2")).text, /The learner is already past "n2"; build the video for "n4" \("N4"\) and "n5" \("N5"\) instead\./);
	});

	it("a wrong-node video gets only the redirect, whatever its length", async () => {
		const chatId = plannedChat(["n1", "n2", "n3"]);
		assert.match((await ask(chatId, "n1")).text, GATE);
		const short = { ...videoCall("n1"), slides: [{ steps: [{ say: Array.from({ length: 125 }, () => "w").join(" "), show: "x" }] }] };
		const res = await tools(chatId).slides!.execute("slides-short", short as never, undefined as never);
		assert.equal(
			(res.content[0] as { text: string }).text,
			'Invalid tool input for tool "slides":\n- The learner is already at "n1"; build the video for "n2" ("N2") and "n3" ("N3") instead.',
			"no word-count message",
		);
	});

	it("is armed only within the rejecting turn: after an abort (the record grew, no re-pose) a requested video of k is allowed", async () => {
		const chatId = plannedChat(["n1", "n2", "n3"]);
		assert.match((await ask(chatId, "n1")).text, GATE);
		assert.match((await slides(chatId, "n1")).text, /The learner is already at "n1"/, "same turn: refused");
		// The turn is aborted: its calls (the rejected question) are persisted, nothing is re-posed.
		asked(chatId, ["n1"]);
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!), undefined, "the record grew: no longer pending");
		assert.equal((await slides(chatId, "n1")).isError, false, "the learner asks for n1's video in the next turn");
	});

	it("allows a video for any node when no rejection is pending", async () => {
		const chatId = plannedChat(["n1", "n2", "n3"]);
		asked(chatId, ["n1", "n2"]);
		assert.equal(pendingNodeVideoGate(chatId, chatStore.getChat(chatId)!), undefined);
		assert.equal((await slides(chatId, "n1")).isError, false, "a revisit");
		assert.equal((await slides(chatId, "n2")).isError, false, "the current node");
	});
});
