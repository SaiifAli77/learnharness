/**
 * Fork-only: guards what a delivered slides call means (FORK.md "StatQuest
 * method and slide decks"). (1) The knowledge-graph extractor, coverage and
 * the Markdown export count a slides call's narration only once a drawn
 * result for it was delivered (a subject part: listed in the delivered
 * video and not missing). (2) The model sees a delivered call's arguments
 * slimmed to title, kind, node/part fields and narration; everything else
 * keeps its full script, and the persisted record is untouched.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-delivery-"));
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

const { createFauxCore } = await import("@earendil-works/pi-ai");
const { forkSlidesDelivered } = await import("../src/core/fork-slides.ts");
const { forkSlimDeliveredSlides, slimSlidesArguments, SLIMMED_NOTE } = await import("../src/agent/fork-slides/slim-history.ts");
const { buildSubagentSteer, buildAbortSteer } = await import("../src/core/contracts.ts");
const { failedOutputCallIds, toLlmMessages } = await import("../src/core/native-messages.ts");
const { coverageSlots, messageViewLines, teacherProseBlocks } = await import("../src/core/coverage.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { transcriptView } = await import("../src/agent/subagents/extraction.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { conversationKeys } = await import("../src/agent/local-agents/run.ts");
const { chatStore } = await import("../src/store/chats.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

// ─── fixtures ───────────────────────────────────────────────────────────────

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A realistic node video script: 12 slides × 4 steps, a full stage, show/pointer on every step, numbers on every other. */
function realisticScript(title: string, extra: Record<string, unknown> = {}) {
	const slides = Array.from({ length: 12 }, (_, i) => ({
		steps: Array.from({ length: 4 }, (_, j) => ({
			say: `Now we push dosage ${i + 1} through the top node, and the weight times the input lands at step ${j + 1}.`,
			show: `the top connection lights up in blue, the product for dosage ${i + 1} appears beside the node, and the earlier sum fades`,
			pointer: `weight × input, dosage ${i + 1}`,
			...(j % 2 === 0 ? { numbers: [{ value: (i * 0.1 * -34.4 + 2.14).toFixed(2), expr: `${(i * 0.1).toFixed(1)}*-34.4+2.14` }] } : {}),
		})),
	}));
	return {
		title,
		kind: "video",
		nodeId: "n2",
		stage:
			"A small dosage plot top-left (x 0 to 1, y 0 to 1, three green dots at 0, 0.5 and 1); the network in the centre: input node on the left, " +
			"two hidden nodes (top and bottom), one output node on the right; weights −34.4 (top, blue) and −2.52 (bottom, orange) on the input " +
			"connections, biases +2.14 and +1.29 under the hidden nodes, output weights −1.30 and 2.28, final bias −0.58; a data card bottom-right " +
			"listing the three dosages with the current row red-boxed; one colour per quantity: input purple, top path blue, bottom path orange, output green.",
		slides,
		...extra,
	};
}

let seq = 0;
function assistant(id: string, blocks: unknown[], stopReason = "toolUse"): LhMessage {
	return { role: "assistant", id, content: blocks, api: "faux", provider: "faux", model: "faux", usage: USAGE, stopReason, timestamp: ++seq } as never;
}
const slidesCall = (id: string, args: unknown) => ({ type: "toolCall", id, name: "slides", arguments: args });
const ack = (callId: string, isError = false): LhMessage =>
	({ role: "toolResult", id: `r-${callId}`, toolCallId: callId, toolName: "slides", content: [{ type: "text", text: isError ? "Invalid tool input" : "Dispatched." }], isError, timestamp: ++seq }) as never;
const deckResult = (jobId: string, parts?: { of: number; missing: number[]; calls: string[] }) => ({
	title: "Deck",
	html: "slides",
	tested: true,
	forkSlides: { version: 1, jobId, kind: parts ? "subject" : "video", stage: "stage.svg", slides: [{ steps: [{ say: "x", frame: "frame-01-1.svg" }] }], ...(parts ? { parts } : {}) },
});
const steer = (callId: string, result: unknown = deckResult(`job_${callId}`)): LhMessage =>
	buildSubagentSteer({ id: `job_${callId}`, kind: "demo", toolCallId: callId }, result as never) as never;
const user = (text: string): LhMessage => ({ role: "user", id: `u${++seq}`, content: text, timestamp: seq }) as never;

const VIDEO = realisticScript("Softplus video");
const NARRATION_START = "Softplus video\n\nNow we push dosage 1";

// ─── (1) only delivered narration counts ───────────────────────────────────

describe("delivered narration only (fork)", () => {
	it("before delivery the call adds no prose; when the steer arrives the same message's fingerprint changes and its narration appears", () => {
		const before = [user("teach me"), assistant("m1", [{ type: "text", text: "Here is the setup." }, slidesCall("c1", VIDEO)]), ack("c1")];
		const slot0 = coverageSlots(before)[1]!;
		assert.deepEqual(messageViewLines(before[1]!, "m1", failedOutputCallIds(before)), ["TEACHER [m1] Here is the setup."], "still building: excluded");
		const afterDelivery = [...before, user("ok"), steer("c1")];
		const slot1 = coverageSlots(afterDelivery)[1]!;
		assert.notEqual(slot1.fp, slot0.fp, "the message re-opens for extraction once its video is delivered");
		assert.ok(slot1.tokens > slot0.tokens);
		const lines = messageViewLines(afterDelivery[1]!, "m1", failedOutputCallIds(afterDelivery));
		assert.equal(lines.length, 2);
		assert.ok(lines[1]!.startsWith(`TEACHER [m1] ${NARRATION_START}`));
		assert.ok(teacherProseBlocks(afterDelivery)[1]!.startsWith(NARRATION_START));
	});

	it("a failed build, an abort, a rejection and an errored message never count", () => {
		const failedBuild = [assistant("m1", [slidesCall("c1", VIDEO)]), ack("c1"), steer("c1", { title: "Deck", html: "", tested: true, notes: "FAILED: x" })];
		assert.deepEqual(teacherProseBlocks(failedBuild), []);
		const aborted = [assistant("m1", [slidesCall("c1", VIDEO)]), ack("c1"), buildAbortSteer({ id: "job_c1", kind: "demo", toolCallId: "c1" }) as never];
		assert.deepEqual(teacherProseBlocks(aborted), []);
		assert.deepEqual(teacherProseBlocks([assistant("m1", [slidesCall("c1", VIDEO)]), ack("c1", true)]), []);
		assert.deepEqual(teacherProseBlocks([assistant("m1", [slidesCall("c1", VIDEO)], "aborted"), steer("c1")]), [], "an aborted message stays excluded even if its job delivered");
	});

	it("a subject part counts only when the delivered video lists its call and the part is not missing", () => {
		const part = (n: number) => ({ ...VIDEO, kind: "subject", title: `Part ${n}`, part: n, of: 3, minutes: 10 });
		const messages = [
			assistant("m0", [slidesCall("old-1", part(1))]), // replaced later
			assistant("m1", [slidesCall("p1", part(1))]),
			assistant("m2", [slidesCall("p2", part(2))]), // could not be drawn
			assistant("m3", [slidesCall("p3", part(3))]),
			assistant("m4", [slidesCall("q1", { ...part(1), of: 2 })]), // a collection never completed
			steer("p3", deckResult("job_p3", { of: 3, missing: [2], calls: ["p1", "p2", "p3"] })),
		];
		const delivered = forkSlidesDelivered(messages);
		assert.deepEqual([...delivered.narrated].sort(), ["p1", "p3"]);
		assert.deepEqual([...delivered.slim].sort(), ["p1", "p2", "p3"], "the missing part is delivered for slimming");
		assert.deepEqual(teacherProseBlocks(messages).map((t) => t.split("\n")[0]), ["Part 1", "Part 3"]);
	});

	it("the Markdown export and the extractor's transcript view (whole-transcript paths) show delivered narration", () => {
		const record = chatStore.createChat("delivery export");
		const messages = [assistant("m1", [slidesCall("c1", VIDEO), slidesCall("c2", { ...VIDEO, title: "Never arrived" })]), ack("c1"), ack("c2"), steer("c1")];
		chatStore.saveMessages(record.id, messages as never);
		const md = sessionMarkdown(messages, { title: "S", anchors: false });
		assert.ok(md.includes(`### Teacher\n\n${NARRATION_START}`), md.slice(0, 400));
		assert.ok(!md.includes("Never arrived"));
		const view = transcriptView(chatStore.getChat(record.id)!);
		assert.ok(view.includes(`TEACHER [m1] ${NARRATION_START}`));
		assert.ok(!view.includes("Never arrived"));
	});
});

// ─── (2) the slim model view ────────────────────────────────────────────────

describe("slim model view of delivered slides calls (fork)", () => {
	it("slims a delivered call to title, kind, node/part fields and the narration per slide, with a note", () => {
		const slim = slimSlidesArguments(VIDEO);
		assert.deepEqual(Object.keys(slim), ["title", "kind", "nodeId", "stage", "narration", "trimmed"]);
		assert.equal(slim.trimmed, SLIMMED_NOTE);
		assert.equal((slim.narration as string[]).length, 12);
		assert.ok((slim.narration as string[])[0]!.startsWith("Now we push dosage 1 through the top node"));
		assert.ok(!JSON.stringify(slim).includes("lights up"), "no show text");
		assert.ok(!JSON.stringify(slim).includes("-34.4+2.14"), "no number expressions");
		const subject = slimSlidesArguments({ ...VIDEO, kind: "subject", part: 2, of: 3, minutes: 10, nodeId: undefined });
		assert.deepEqual([subject.part, subject.of, subject.minutes, "nodeId" in subject], [2, 3, 10, false]);
		assert.deepEqual(slimSlidesArguments(null), { title: undefined, kind: undefined, narration: [], trimmed: SLIMMED_NOTE }, "never throws");

		const before = JSON.stringify(VIDEO).length;
		const after = JSON.stringify(slim).length;
		assert.ok(after < before * 0.4, `realistic node video script: ${before} → ${after} chars (measured 14641 → 5139, 65% smaller, stage kept)`);
	});

	it("only delivered calls before the latest assistant message change; everything else is the same object; the input is not mutated", () => {
		const thinking = { type: "thinking", thinking: "plan", thinkingSignature: "sig-123" };
		const m1 = assistant("m1", [thinking, { type: "text", text: "setup" }, slidesCall("c1", VIDEO)]);
		const m2 = assistant("m2", [slidesCall("c2", VIDEO)]); // still building
		const m3 = assistant("m3", [slidesCall("c3", VIDEO)]); // the latest assistant message, delivered
		const messages = [user("hi"), m1, ack("c1"), m2, ack("c2"), steer("c1"), m3, ack("c3"), steer("c3")];
		const snapshot = JSON.stringify(messages);
		const out = forkSlimDeliveredSlides(messages as never) as unknown as LhMessage[];
		assert.equal(JSON.stringify(messages), snapshot, "the persisted record is untouched");
		assert.notEqual(out, messages);
		const slimmed = out[1] as unknown as { content: Array<{ arguments?: Record<string, unknown> }> };
		assert.equal(slimmed.content[0], thinking, "thinking block and signature pass through as the same object");
		assert.equal(slimmed.content[1], (m1 as unknown as { content: unknown[] }).content[1]);
		assert.equal(slimmed.content[2]!.arguments!.trimmed, SLIMMED_NOTE);
		assert.equal(out[3], m2, "a call still building keeps its full script");
		assert.equal(out[6], m3, "the latest assistant message is never modified");
		for (const i of [0, 2, 4, 5, 7, 8]) assert.equal(out[i], messages[i]);
		const none = [user("hi"), m2, ack("c2")];
		assert.equal(forkSlimDeliveredSlides(none as never), none, "nothing delivered: the same array");
	});

	it("a delivered subject video slims every part call, the missing one too; replaced parts keep their script", () => {
		const part = (n: number) => ({ ...VIDEO, kind: "subject", part: n, of: 2, minutes: 10 });
		const messages = [
			assistant("m0", [slidesCall("old", part(1))]),
			assistant("m1", [slidesCall("p1", part(1)), slidesCall("p2", part(2))]),
			steer("p2", deckResult("job_p2", { of: 2, missing: [2], calls: ["p1", "p2"] })),
			assistant("m9", [{ type: "text", text: "Watch it." }]),
		];
		const out = forkSlimDeliveredSlides(messages as never) as unknown as Array<{ content: Array<{ arguments?: Record<string, unknown> }> }>;
		assert.equal(out[0], messages[0], "the replaced part keeps its full script");
		assert.deepEqual(out[1]!.content.map((b) => b.arguments!.trimmed), [SLIMMED_NOTE, SLIMMED_NOTE]);
	});

	it("the teacher agent's convertToLlm applies it (one hook line), and the local-agent resume keys are unchanged", () => {
		const faux = createFauxCore({});
		const agent = createTeacherAgent(undefined, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, messages: [] as never, tools: [] as never });
		const messages = [user("hi"), assistant("m1", [slidesCall("c1", VIDEO)]), ack("c1"), steer("c1"), assistant("m2", [{ type: "text", text: "Watch it." }])];
		const wire = (agent as unknown as { convertToLlm: (m: unknown[]) => Array<{ role: string; content: Array<{ arguments?: Record<string, unknown> }> }> }).convertToLlm(messages);
		const call = wire.find((m) => m.role === "assistant")!.content[0]!;
		assert.equal(call.arguments!.trimmed, SLIMMED_NOTE);
		assert.equal(typeof call.arguments!.stage, "string", "the stage stays for a later continues deck");
		assert.equal(JSON.stringify(call.arguments).includes("\"show\""), false);
		assert.deepEqual(conversationKeys(wire as never), conversationKeys(toLlmMessages(messages as never)), "a parked Claude Code/Antigravity run still resumes");
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent", "teacher-agent.ts"), "utf-8");
		assert.match(source, /^\t\tconvertToLlm: \(messages\) => toLlmMessages\(forkSlimDeliveredSlides\(messages\)\),$/m);
	});
});
