/**
 * Fork-only: guards the recap video (FORK.md "StatQuest method and slide
 * decks"): `kind: "recap"` reuses the subject video's parts machinery (the
 * same part/of/minutes checks and word range, no `continues` either way),
 * in its own collection beside the subject video's; several recaps per
 * chat; replayed ACKs, the crash discard and the sweep; its own ACK and
 * runner notes; the card label; narration kept out of the knowledge graph,
 * the Markdown export and coverage; slimming once delivered; the node-video
 * gate ignoring recap jobs; and the prompt.
 */
import React from "react";
const h = React.createElement;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-recap-"));
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

const { renderToStaticMarkup } = await import("react-dom/server");
const { createCanvas } = await import("@napi-rs/canvas");
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
type Context = import("@earendil-works/pi-ai").Context;
type PiEngine = import("../src/agent/models.ts").PiEngine;
type HeadlessApi = import("../src/agent/subagents/headless.ts").HeadlessApi;
type ForkSlidesDeck = import("../src/core/fork-slides.ts").ForkSlidesDeck;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type JobStatus = import("../src/core/contracts.ts").JobStatus;

const { slidesInputProblems, subjectPartWordRange } = await import("../src/agent/fork-slides/tools.ts");
const { forkSlidesModelOverride, forkSlidesTtsOverride } = await import("../src/agent/fork-slides/runner-hook.ts");
const { forkSlidesDir, forkSlidesRoot, readPartsCollection, writePartsCollection, readSubjectParts, sweepForkSlidesOrphans } = await import(
	"../src/agent/fork-slides/storage.ts"
);
const { forkSlimDeliveredSlides, SLIMMED_NOTE } = await import("../src/agent/fork-slides/slim-history.ts");
const { PATHS } = await import("../config.ts");
const { forkSlidesDelivered, forkSlidesNarration, isForkSlidesResult, subjectPartReceived, FORK_SLIDES_MARKER } = await import("../src/core/fork-slides.ts");
const { buildSubagentSteer } = await import("../src/core/contracts.ts");
const { failedOutputCallIds, userFacingTextOf } = await import("../src/core/native-messages.ts");
const { coverageSlots, messageViewLines, teacherProseBlocks } = await import("../src/core/coverage.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createTeacherTools, quizExampleBody } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { ForkSlidesCard, ForkSlidesDispatchCard, forkSlidesKindLabel } = await import("../components/artifacts/fork-slides-card.tsx");
const { GET } = await import("../app/api/fork-slides/[...path]/route.ts");
const { Value } = await import("typebox/value");

// ─── fixtures ───────────────────────────────────────────────────────────────

const STAGE =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect id="bg" width="1280" height="720" fill="#fff"/><text id="w1" x="100" y="100">× −34.4</text><rect id="box-w1" x="90" y="75" width="120" height="35"/></svg>';

const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");

/** One part of a subject or recap video: two slides (2 steps, then 1).
 *  Unless `extra.slides` is given, the last step's `say` is padded so the
 *  part's spoken words sit in the middle of its range. */
function piece(kind: "recap" | "subject", n: number, of: number, extra: Record<string, unknown> = {}) {
	const { min, max } = subjectPartWordRange((extra.minutes as number | undefined) ?? 10, (extra.of as number | undefined) ?? of);
	const pad = extra.slides === undefined ? Math.max(0, Math.round((min + max) / 2) - 6) : 0; // "Part n opens." + "Box it." + "Done." = 6 words
	return {
		title: `${kind === "recap" ? "Recap" : "Softplus"}, part ${n}`,
		kind,
		part: n,
		of,
		minutes: 10,
		stage: `Part ${n} stage.`,
		slides: [
			{ steps: [{ say: `Part ${n} opens.`, show: "lit" }, { say: "Box it.", show: "box" }] },
			{ steps: [{ say: pad > 0 ? `Done. ${words(pad)}` : "Done.", show: "all" }] },
		],
		...extra,
	};
}
const recap = (n: number, of: number, extra: Record<string, unknown> = {}) => piece("recap", n, of, extra);
const subject = (n: number, of: number, extra: Record<string, unknown> = {}) => piece("subject", n, of, extra);

const RECAP_ACK =
	"The recap video is built from every part and arrives as a new message. Tell the learner the recap video is being built and " +
	"will arrive as a new message, then wait: no questions and no teaching meanwhile (no quiz, explain or ask_user_question). " +
	"When it arrives, tell the learner to watch it.";

function fakeHeadless(): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => ({ consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }),
		async renderSvg(): Promise<Buffer> {
			const canvas = createCanvas(1, 1);
			canvas.getContext("2d").fillRect(0, 0, 1, 1);
			return canvas.toBuffer("image/png");
		},
		renderPdfPages: async () => [],
	};
}

/** A slide-maker engine that answers each recap part's own conversation (the
 *  part number read from the helper's "Kind: recap video, part n of" line).
 *  `failures[n]` makes part n's first that-many attempts crash. */
function recapRouter(failures: Record<number, number> = {}): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const attempts: Record<number, number> = {};
	const route = (context: Context) => {
		const n = Number(/Kind: recap video, part (\d+) of/.exec(JSON.stringify(context.messages))?.[1] ?? 0);
		const turn = context.messages.filter((m) => m.role === "assistant").length;
		calls.push(`${n}#${turn}`);
		if (turn === 0) attempts[n] = (attempts[n] ?? 0) + 1;
		if ((failures[n] ?? 0) >= attempts[n]!) throw new Error(`part ${n} engine down`);
		if (turn === 0)
			return fauxAssistantMessage(
				[
					fauxToolCall("write_stage", { svg: STAGE }, { id: `w${n}` }),
					fauxToolCall("set_slide", { slide: 1, steps: [{ lit: ["w1"] }, { boxes: ["w1"] }] }, { id: `a${n}` }),
					fauxToolCall("set_slide", { slide: 2, steps: [{}] }, { id: `b${n}` }),
				],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage(turn === 1 ? "x" : `Part ${n} checked.`);
	};
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(Array.from({ length: 200 }, () => route));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

const ctxFor = (chatId: string, spawned?: unknown[]) => ({ chatId, jobStore, chatStore, spawn: (_job: unknown, input: unknown) => spawned?.push(input) });
async function send(chatId: string, toolCallId: string, input: unknown, spawned?: unknown[]) {
	const res = await jobTools(ctxFor(chatId, spawned) as never).slides!.execute(toolCallId, input as never, undefined as never);
	return { text: (res.content[0] as { text: string }).text, isError: (res as { isError?: boolean }).isError === true };
}

// ─── 1. dispatch validation ────────────────────────────────────────────────

describe("recap video: dispatch validation (fork)", () => {
	it("needs part, of and minutes; at most 8 parts; the part within of; the 25-minute cap; messages name the recap", () => {
		const ctx = { chatId: chatStore.createChat("recap v").id, jobStore, chatStore };
		const { part: _p, ...noPart } = recap(1, 2);
		assert.deepEqual(slidesInputProblems(noPart as never, ctx), ["a recap part needs part, of and minutes (the same of and minutes on every part)."]);
		assert.match(slidesInputProblems(recap(1, 9) as never, ctx).join(), /of: 9 parts; a recap video has at most 8\./);
		assert.match(slidesInputProblems(recap(3, 2) as never, ctx).join(), /part 3 of 2: the part number cannot exceed of/);
		assert.match(
			slidesInputProblems(recap(1, 2, { minutes: 30 }) as never, ctx).join(),
			/minutes: 30 is over the 25-minute cap\. Use minutes: 25, and tell the learner the video is capped at 25 minutes\./,
		);
		assert.match(slidesInputProblems(recap(1, 2, { minutes: 0 }) as never, ctx).join(), /at least 1 minute/);
		assert.deepEqual(slidesInputProblems(recap(1, 8) as never, ctx), []);
		assert.deepEqual(slidesInputProblems(recap(1, 4, { minutes: 25 }) as never, ctx), []);
	});

	it("shares the subject video's per-part limit and word range: the same checks, the same messages", () => {
		const ctx = { chatId: chatStore.createChat("recap range").id, jobStore, chatStore };
		const sized = (kind: "recap" | "subject", w: number) => piece(kind, 2, 3, { minutes: 15, slides: [{ steps: [{ say: words(w), show: "x" }] }] });
		for (const w of [539, 811]) {
			const problems = slidesInputProblems(sized("recap", w) as never, ctx);
			assert.deepEqual(problems, slidesInputProblems(sized("subject", w) as never, ctx), `${w} words`);
			assert.match(problems.join(), new RegExp(`part 2 has ${w} spoken words; a 15-minute video in 3 parts needs 540–810 per part`));
		}
		assert.deepEqual(slidesInputProblems(sized("recap", 540) as never, ctx), []);
		assert.deepEqual(slidesInputProblems(sized("recap", 810) as never, ctx), []);
		assert.deepEqual(slidesInputProblems(recap(1, 2, { minutes: 15 }) as never, ctx), [
			"minutes 15 in 2 parts is 7.5 minutes per part; a part is at most 7 minutes, so a 15-minute video needs at least 3 parts (of: 3).",
		]);
		assert.deepEqual(slidesInputProblems(recap(1, 2, { minutes: 14 }) as never, ctx), [], "exactly 7 minutes per part");
	});

	it("a recap part never takes continues, and no deck or video may continue a recap", () => {
		const chatId = chatStore.createChat("recap continues").id;
		const ctx = { chatId, jobStore, chatStore };
		assert.match(slidesInputProblems(recap(1, 2, { continues: "x" }) as never, ctx).join(), /continues: a recap part never continues another deck; drop it\./);
		const job = jobStore.createJob({ kind: "demo", chatId, toolCallId: "rc", input: { kind: "recap", title: "t", of: 1, minutes: 5, parts: [recap(1, 1)], calls: ["rc"], [FORK_SLIDES_MARKER]: true } });
		jobStore.updateJob(job.id, { status: "done" });
		const deck = { title: "d", kind: "deck", stage: "s", slides: [{ steps: [{ say: "a", show: "b" }] }], continues: "rc" };
		assert.match(slidesInputProblems(deck as never, ctx).join(), /continues: "rc" is the recap video, which has one stage per part and cannot be continued\./);
	});

	it("schema: recap is a kind; part and of are positive integers; the kind description names it", () => {
		const tool = jobTools(ctxFor("chat_schema") as never).slides!;
		assert.equal(Value.Check(tool.parameters, recap(1, 3)), true);
		assert.equal(Value.Check(tool.parameters, recap(0, 3)), false);
		assert.equal(Value.Check(tool.parameters, recap(1, 3, { minutes: 12.5 })), false, "whole minutes");
		const kind = (tool.parameters as { properties: { kind: { description: string } } }).properties.kind.description;
		assert.match(kind, /"recap": one part of the recap video, what the learner learned in this session retold end to end as one story \(set part, of and minutes, as for "subject"\)/);
		assert.match(tool.description, /A recap video \(kind "recap"\) is sent the same way, in parts with part, of and minutes, and collected separately from the subject video\./);
	});
});

// ─── 2. its own collection ─────────────────────────────────────────────────

describe("recap video: its own collection (fork)", () => {
	it("subject and recap parts interleaved in one chat are collected apart and each becomes its own job", async () => {
		const chatId = chatStore.createChat("interleave").id;
		const spawned: unknown[] = [];
		assert.equal((await send(chatId, "s1", subject(1, 2), spawned)).text, "Part 1 of 2 received; send the rest (still missing: part 2).");
		assert.equal((await send(chatId, "r1", recap(1, 3), spawned)).text, "Part 1 of 3 received; send the rest (still missing: parts 2, 3).");
		assert.equal((await send(chatId, "r3", recap(3, 3), spawned)).text, "Part 3 of 3 received; send the rest (still missing: part 2).");
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["s1"], "the recap parts never join the subject collection");
		assert.deepEqual(readPartsCollection("recap", chatId)!.parts.map((p) => p.toolCallId), ["r1", "r3"]);
		const file = path.join(forkSlidesRoot(), "recap-parts", `${chatId}.json`);
		assert.ok(fs.existsSync(file), "<data root>/fork-slides/recap-parts/<chatId>.json");
		// a recap part 1 with another of/minutes restarts only the recap
		assert.match((await send(chatId, "r1b", recap(1, 2, { minutes: 14 }), spawned)).text, /^Part 1 of 2 received/);
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["s1"]);
		const done = await send(chatId, "r2", recap(2, 2, { minutes: 14 }), spawned);
		assert.equal(done.isError, false, done.text);
		assert.match(done.text, /^Dispatched \(job job_\S+\)\. /);
		assert.ok(done.text.endsWith(RECAP_ACK), done.text);
		assert.equal(readPartsCollection("recap", chatId), null, "the recap collection is cleared");
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["s1"], "the subject collection is untouched");
		const subjectDone = await send(chatId, "s2", subject(2, 2), spawned);
		assert.match(subjectDone.text, /let the learner try to invent the subject from the start/, "the subject ACK is unchanged");
		const jobs = jobStore.listJobs(chatId);
		assert.equal(jobs.length, 2);
		const byKind = Object.fromEntries(jobs.map((j) => [(j.input as { kind: string }).kind, j.input as Record<string, unknown>]));
		assert.deepEqual([byKind.recap!.calls, byKind.recap!.of, byKind.recap!.minutes, byKind.recap!.title], [["r1b", "r2"], 2, 14, "Recap, part 1"]);
		assert.equal(byKind.recap![FORK_SLIDES_MARKER], true);
		assert.deepEqual(byKind.subject!.calls, ["s1", "s2"]);
		assert.equal(spawned.length, 2);
	});

	it("a later recap part that disagrees is rejected; parts dispatched together are checked against each other", async () => {
		const chatId = chatStore.createChat("recap mismatch").id;
		await send(chatId, "m1", recap(1, 3));
		const wrong = await send(chatId, "m2", recap(2, 4));
		assert.equal(wrong.isError, true);
		assert.match(wrong.text, /part 2 says of 4, minutes 10, but the parts received so far say of 3, minutes 10\. .*send part 1 again to start the video over/);
		const together = await Promise.all([send(chatId, "m2b", recap(2, 3)), send(chatId, "m3", recap(3, 5))]);
		assert.deepEqual(together.map((r) => r.isError), [false, true]);
		assert.deepEqual(readPartsCollection("recap", chatId)!.parts.map((p) => p.toolCallId), ["m1", "m2b"]);
	});

	it("several recap videos per chat: after one is built, a new part 1 starts a new collection", async () => {
		const chatId = chatStore.createChat("recap twice").id;
		await send(chatId, "a1", recap(1, 2));
		assert.match((await send(chatId, "a2", recap(2, 2))).text, /^Dispatched/);
		assert.equal((await send(chatId, "b1", recap(1, 1, { minutes: 5 }))).text.startsWith("Dispatched"), true, "a one-part recap completes at once");
		assert.equal((await send(chatId, "c1", recap(1, 2))).text, "Part 1 of 2 received; send the rest (still missing: part 2).");
		assert.match((await send(chatId, "c2", recap(2, 2))).text, /^Dispatched/);
		const recaps = jobStore.listJobs(chatId).map((j) => (j.input as { calls: string[] }).calls);
		assert.deepEqual(recaps.sort(), [["a1", "a2"], ["b1"], ["c1", "c2"]]);
	});

	it("a replayed recap part gets the ACK it got and never reopens a collection", async () => {
		const chatId = chatStore.createChat("recap replay").id;
		await send(chatId, "x1", recap(1, 2));
		const done = await send(chatId, "x2", recap(2, 2));
		const replay = await send(chatId, "x1", recap(1, 2));
		assert.equal(replay.text, "Part 1 of 2 received.");
		assert.deepEqual(subjectPartReceived(replay.text), { part: 1, of: 2 });
		assert.equal((await send(chatId, "x2", recap(2, 2))).text, done.text, "the completing call gets the recap dispatch ACK again");
		assert.ok(done.text.endsWith(RECAP_ACK));
		assert.equal(readPartsCollection("recap", chatId), null);
		assert.equal(jobStore.listJobs(chatId).length, 1);
	});

	it("a recap collection left by a crash is discarded; one with an unconsumed call is kept; a subject job never discards it", async () => {
		const chatId = chatStore.createChat("recap crash").id;
		jobStore.createJob({ kind: "demo", chatId, toolCallId: "k2", input: { kind: "recap", title: "t", of: 2, minutes: 10, parts: [], calls: ["k1", "k2"], [FORK_SLIDES_MARKER]: true } });
		writePartsCollection("recap", chatId, { of: 2, minutes: 10, parts: [{ toolCallId: "k1", input: recap(1, 2) }] });
		assert.equal((await send(chatId, "n2", recap(2, 2))).text, "Part 2 of 2 received; send the rest (still missing: part 1).", "the consumed part 1 is not reused");
		const mixed = chatStore.createChat("recap crash mixed").id;
		jobStore.createJob({ kind: "demo", chatId: mixed, toolCallId: "m2", input: { kind: "recap", title: "t", of: 3, minutes: 10, parts: [], calls: ["m1", "m2"], [FORK_SLIDES_MARKER]: true } });
		writePartsCollection("recap", mixed, { of: 3, minutes: 10, parts: [{ toolCallId: "m1", input: recap(1, 3) }, { toolCallId: "fresh", input: recap(3, 3) }] });
		await send(mixed, "p2", recap(2, 3));
		assert.equal(jobStore.listJobs(mixed).length, 2, "the kept collection completed with the new part");
		const other = chatStore.createChat("recap crash other kind").id;
		jobStore.createJob({ kind: "demo", chatId: other, toolCallId: "o2", input: { kind: "subject", title: "t", of: 2, minutes: 10, parts: [], calls: ["o1", "o2"], [FORK_SLIDES_MARKER]: true } });
		writePartsCollection("recap", other, { of: 2, minutes: 10, parts: [{ toolCallId: "o1", input: recap(1, 2) }] });
		assert.match((await send(other, "o3", recap(2, 2))).text, /^Dispatched/, "a subject job's calls never count as consuming a recap collection");
	});

	it("the orphan sweep removes the recap collections of deleted chats and keeps the rest", () => {
		const live = chatStore.createChat("recap sweep").id;
		writePartsCollection("recap", live, { of: 2, minutes: 10, parts: [] });
		writePartsCollection("recap", "chat_deleted_recap", { of: 2, minutes: 10, parts: [] });
		const dir = path.join(forkSlidesRoot(), "recap-parts");
		fs.writeFileSync(path.join(dir, "chat_deleted_recaptemp.json.tmp-0f3c"), "{}");
		fs.writeFileSync(path.join(dir, `${live}.json.tmp-0f3c`), "{}");
		sweepForkSlidesOrphans();
		assert.equal(readPartsCollection("recap", "chat_deleted_recap"), null, "a deleted chat's recap collection is gone");
		assert.ok(!fs.existsSync(path.join(dir, "chat_deleted_recaptemp.json.tmp-0f3c")), "a deleted chat's temp-only leftover is gone");
		assert.ok(readPartsCollection("recap", live), "a live chat's recap collection stays");
		assert.ok(fs.existsSync(path.join(dir, `${live}.json.tmp-0f3c`)));
		assert.equal(readPartsCollection("recap", "../etc"), null, "the strict chat-id check");
		assert.throws(() => writePartsCollection("recap", "chat_bad/../x", { of: 1, minutes: 1, parts: [] }), /invalid chat id for recap parts/);
	});
});

// ─── 3. the build and the runner's notes ───────────────────────────────────

describe("recap video: the build and the runner's notes (fork)", () => {
	const build = async (of: number, failures: Record<number, number>) => {
		const chatId = chatStore.createChat("recap build").id;
		for (let n = 1; n < of; n++) await send(chatId, `b${n}`, recap(n, of));
		await send(chatId, "b-last", recap(of, of));
		const job = jobStore.findJobByToolCallId(chatId, "b-last")!;
		const router = recapRouter(failures);
		headlessOverride.current = fakeHeadless();
		forkSlidesModelOverride.current = router.engine;
		forkSlidesTtsOverride.current = async (items) => {
			for (const it of items) fs.writeFileSync(it.out, "OggS");
			return { ok: true as const, durations: items.map(() => 2) };
		};
		try {
			await createJobRunner({ chatStore, jobStore, deliver: async () => {} }).runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			forkSlidesModelOverride.current = undefined;
			forkSlidesTtsOverride.current = undefined;
		}
		return { job: jobStore.getJob(job.id)!, calls: router.calls };
	};

	it("draws every part at once and delivers ONE recap deck; the notes say it is the narrated recap video and to tell the learner to watch it", async () => {
		const { job, calls } = await build(2, {});
		assert.equal(job.status, "done", job.error);
		assert.deepEqual(calls.slice(0, 2).sort(), ["1#0", "2#0"], "both parts start before any part's second turn");
		assert.ok(isForkSlidesResult(job.result));
		const result = job.result as { title: string; notes: string; forkSlides: ForkSlidesDeck };
		assert.equal(result.title, "Recap, part 1");
		assert.equal(result.forkSlides.kind, "recap");
		assert.deepEqual(result.forkSlides.parts, { of: 2, missing: [], calls: ["b1", "b-last"] });
		assert.deepEqual(result.forkSlides.slides.map((s) => s.part), [1, 1, 2, 2]);
		assert.match(result.notes, /it is the narrated recap video, 2 of 2 parts played straight through as one video \(4 slides, 6 build steps\)/);
		assert.match(result.notes, /Tell the learner to watch it\. Do not retell it\./);
		assert.doesNotMatch(result.notes, /invention|node 1|continues:/);
		const get = (file: string) => GET(new Request("http://localhost/x"), { params: Promise.resolve({ path: [job.id, file] }) });
		assert.equal((await get("p2-frame-01-2.svg")).status, 200);
		const html = await (await get("deck.html")).text();
		assert.equal((html.match(/data:image\/svg\+xml;base64,/g) ?? []).length, 6, "the downloadable deck.html carries every part's frames");
		assert.ok(fs.existsSync(path.join(forkSlidesDir(job.id)!, "p2-audio-02-1.ogg")));
	});

	it("a part that fails twice is left out: the notes name it and say to cover that stretch in prose; the card says so", async () => {
		const { job, calls } = await build(3, { 2: 2 });
		assert.equal(job.status, "done", job.error);
		assert.equal(calls.filter((c) => c === "2#0").length, 2, "retried once");
		const result = job.result as { notes: string; forkSlides: ForkSlidesDeck };
		assert.deepEqual(result.forkSlides.parts, { of: 3, missing: [2], calls: ["b1", "b2", "b-last"] });
		assert.match(result.notes, /the narrated recap video, 2 of 3 parts played straight through/);
		assert.match(result.notes, /Part 2 of 3 could not be drawn \(the slide maker crashed — part 2 engine down\), so the video skips that stretch: cover your part 2 script in prose once the learner has watched the video\./);
		const html = renderToStaticMarkup(h(ForkSlidesCard, { result: result as never }));
		assert.match(html, /Part 2 of 3 could not be drawn\./);
	});

	it("when every part fails the job fails, naming the recap video", async () => {
		const { job } = await build(2, { 1: 2, 2: 2 });
		assert.equal(job.status, "error");
		assert.match(job.error ?? "", /^FAILED: no part of the recap video could be drawn \(each was retried once\)\./);
	});
});

// ─── 4. the card ───────────────────────────────────────────────────────────

describe("recap video: the card (fork)", () => {
	it("labels it a recap video, shows the part by the step counter; a received recap part shows the quiet line", () => {
		assert.deepEqual(["deck", "video", "subject", "recap"].map((k) => forkSlidesKindLabel(k as never)), ["slides", "video", "video", "recap video"]);
		const deck: ForkSlidesDeck = {
			version: 1,
			jobId: "job_recap_card",
			kind: "recap",
			stage: "p1-stage.svg",
			parts: { of: 2, missing: [], calls: ["c1", "c2"] },
			slides: [
				{ part: 1, steps: [{ say: "One.", frame: "p1-frame-01-1.svg", audio: "p1-audio-01-1.ogg", duration: 2 }] },
				{ part: 2, steps: [{ say: "Two.", frame: "p2-frame-01-1.svg", audio: "p2-audio-01-1.ogg", duration: 3 }] },
			],
		};
		const html = renderToStaticMarkup(h(ForkSlidesCard, { result: { title: "Recap", html: "slides", tested: true, forkSlides: deck } }));
		assert.match(html, /uppercase tracking-wide text-muted-foreground">recap video</);
		assert.match(html, /part 1 of 2 · step 1 of 1/);
		assert.match(html, /0:00 \/ 0:07/);
		const part = { type: "tool-slides", state: "output-available", toolCallId: "t", input: recap(1, 2), output: "Part 1 of 2 received; send the rest (still missing: part 2)." };
		const received = renderToStaticMarkup(h(ForkSlidesDispatchCard, { part: part as never }));
		assert.match(received, /data-testid="fork-slides-part-received"/);
		assert.match(received, /part 1 of 2 received/);
	});
});

// ─── 5. narration stays out of the graph, the export and coverage ──────────

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let seq = 0;
function assistant(id: string, blocks: unknown[]): LhMessage {
	return { role: "assistant", id, content: blocks, api: "faux", provider: "faux", model: "faux", usage: USAGE, stopReason: "toolUse", timestamp: ++seq } as never;
}
const slidesCall = (id: string, args: unknown) => ({ type: "toolCall", id, name: "slides", arguments: args });
const ack = (callId: string): LhMessage =>
	({ role: "toolResult", id: `r-${callId}`, toolCallId: callId, toolName: "slides", content: [{ type: "text", text: "Dispatched." }], isError: false, timestamp: ++seq }) as never;
const user = (text: string): LhMessage => ({ role: "user", id: `u${++seq}`, content: text, timestamp: seq }) as never;
const videoSteer = (callId: string, kind: "recap" | "subject", calls: string[], missing: number[] = []): LhMessage =>
	buildSubagentSteer({ id: `job_${callId}`, kind: "demo", toolCallId: callId }, {
		title: "Video",
		html: "slides",
		tested: true,
		forkSlides: { version: 1, jobId: `job_${callId}`, kind, stage: "p1-stage.svg", slides: [{ part: 1, steps: [{ say: "x", frame: "p1-frame-01-1.svg" }] }], parts: { of: calls.length, missing, calls } },
	} as never) as never;
const RECAP_LINE = "Remember the softplus bend we built together";
const recapScript = (n: number) => recap(n, 2, { title: `Recap ${n}`, slides: [{ steps: [{ say: `${RECAP_LINE}, part ${n}.`, show: "x" }] }] });

describe("recap video: narration is never teacher prose (fork)", () => {
	it("forkSlidesNarration returns nothing for a recap call, delivered or not, so userFacingTextOf skips it", () => {
		assert.equal(forkSlidesNarration(slidesCall("r", recapScript(1))), undefined);
		assert.match(forkSlidesNarration(slidesCall("s", { ...recapScript(1), kind: "subject" }))!, new RegExp(RECAP_LINE), "the same script as a subject part counts");
		assert.deepEqual(userFacingTextOf([{ type: "text", text: "Here it comes." }, slidesCall("r", recapScript(1))]), ["Here it comes."], "even with no failed set at all");
	});

	it("a delivered recap adds no prose and does not change a message's coverage fingerprint; a subject video in the same chat still counts", () => {
		const before = [
			user("recap please"),
			assistant("m1", [{ type: "text", text: "Building your recap." }, slidesCall("r1", recapScript(1)), slidesCall("r2", recapScript(2))]),
			ack("r1"),
			ack("r2"),
			assistant("m2", [slidesCall("s1", { ...recapScript(1), kind: "subject", title: "Subject 1", slides: [{ steps: [{ say: "The subject story begins.", show: "x" }] }] })]),
			ack("s1"),
		];
		const delivered = [...before, videoSteer("r2", "recap", ["r1", "r2"]), videoSteer("s1", "subject", ["s1"])];
		assert.equal(coverageSlots(delivered)[1]!.fp, coverageSlots(before)[1]!.fp, "the recap message is not re-opened");
		assert.equal(coverageSlots(delivered)[1]!.tokens, coverageSlots(before)[1]!.tokens);
		assert.notEqual(coverageSlots(delivered)[4]!.fp, coverageSlots(before)[4]!.fp, "the subject video's message re-opens as before");
		assert.deepEqual(messageViewLines(delivered[1]!, "m1", failedOutputCallIds(delivered)), ["TEACHER [m1] Building your recap."]);
		const prose = teacherProseBlocks(delivered);
		assert.ok(!prose.some((t) => t.includes(RECAP_LINE)), prose.join(" | "));
		assert.ok(prose.some((t) => t.startsWith("Subject 1")));
		const { narrated, slim } = forkSlidesDelivered(delivered);
		assert.deepEqual([...narrated], ["s1"], "recap calls are never narrated");
		assert.deepEqual([...slim].sort(), ["r1", "r2", "s1"]);
		const failed = failedOutputCallIds(delivered);
		assert.ok(failed.has("r1") && failed.has("r2") && !failed.has("s1"));
		const md = sessionMarkdown(delivered, { title: "S", anchors: false });
		assert.ok(md.includes("Building your recap."));
		assert.ok(!md.includes("Recap 1") && !md.includes(RECAP_LINE), md);
		assert.ok(md.includes("Subject 1"));
	});
});

// ─── 6. slimmed once delivered ─────────────────────────────────────────────

describe("recap video: slimmed in the model's view once delivered (fork)", () => {
	it("every delivered recap part call is slimmed, a missing one too; undelivered parts keep their script", () => {
		const messages = [
			assistant("m0", [slidesCall("old", recapScript(1))]),
			assistant("m1", [slidesCall("p1", recapScript(1)), slidesCall("p2", recapScript(2))]),
			videoSteer("p2", "recap", ["p1", "p2"], [2]),
			assistant("m9", [{ type: "text", text: "Watch it." }]),
		];
		const out = forkSlimDeliveredSlides(messages as never) as unknown as Array<{ content: Array<{ arguments?: Record<string, unknown> }> }>;
		assert.equal(out[0], messages[0], "a replaced part keeps its full script");
		const args = out[1]!.content.map((b) => b.arguments!);
		assert.deepEqual(args.map((a) => a.trimmed), [SLIMMED_NOTE, SLIMMED_NOTE]);
		assert.deepEqual([args[0]!.kind, args[0]!.part, args[0]!.of, args[0]!.minutes], ["recap", 1, 2, 10]);
		assert.equal(JSON.stringify(args).includes('"show"'), false);
	});
});

// ─── 7. the node-video gate ignores recap jobs ─────────────────────────────

describe("recap video: the node-video gate ignores it (fork)", () => {
	const GATE = /This is the first question on node "n1"\. Node videos are built ahead \(two nodes ahead of the learner\): /;
	function plannedChat(): string {
		const id = chatStore.createChat("recap gate").id;
		chatStore.saveTree(id, { nodes: ["n1", "n2", "n3"].map((n) => ({ id: n, title: n })), edges: [], version: 1 });
		return id;
	}
	function recapJob(chatId: string, status: JobStatus): void {
		const job = jobStore.createJob({ kind: "demo", chatId, toolCallId: `rg-${Math.random()}`, input: { kind: "recap", title: "r", of: 1, minutes: 5, parts: [], calls: [], [FORK_SLIDES_MARKER]: true } });
		if (status !== "running") jobStore.updateJob(job.id, { status });
	}
	const ask = async (chatId: string) => {
		const tools = createTeacherTools({ chatId, chatStore, jobStore, spawn: () => {} });
		const res = await tools.quiz!.execute(`q-${Math.random()}`, { type: "check", nodeId: "n1", ...quizExampleBody } as never, undefined as never);
		return (res.content[0] as { text: string }).text;
	};

	it("a running, done or failed recap neither stands the gate down nor counts as a node video", async () => {
		headlessOverride.current = { available: () => true, unavailableReason: () => null } as never;
		try {
			for (const status of ["running", "done", "error"] as const) {
				const chatId = plannedChat();
				recapJob(chatId, status);
				assert.match(await ask(chatId), GATE, status);
			}
		} finally {
			headlessOverride.current = undefined;
		}
	});
});

// ─── 8. the prompt ─────────────────────────────────────────────────────────

describe("recap video: the teacher prompt (fork)", () => {
	it("offers the recap once after the last closing essay, retells the session with the learner's mistakes, and waits while it builds", () => {
		const teacher = composeInstructions("teacher");
		assert.match(teacher, /\*\*The recap video \(`kind: "recap"`\)\.\*\* After the learner passes the last plan node's closing essay, ask once with `ask_user_question` whether they want a recap video of what they learned/);
		assert.match(teacher, /the same length options as the subject video: 10, 15, 20 or 25 minutes of narration, each with its expected play time, one marked recommended, or their own number under "Other"\. Include a "No thanks" option\. If they decline, don't offer it again\./);
		assert.match(teacher, /The learner may also ask for a recap at any time; if they ask before every node is finished, make it from the nodes finished so far, and say in the first narration line that it covers the lesson so far\./);
		assert.match(teacher, /The recap retells this session end to end as one story, in plan-node order\. Reuse the session's own toy examples, datasets, numbers and colours\./);
		assert.match(teacher, /Spend extra time on what the learner got wrong or struggled with \(gaps in their closing essays, missed checks, repaired misconceptions\): show the wrong idea, why it fails, and the corrected one on the picture\. No new material\./);
		assert.match(teacher, /Send it exactly like the subject video, with `part`, `of` and `minutes` on every call: parts of at most 7 minutes, each with its own stage, the same colours and numbers across parts\./);
		assert.match(teacher, /\*\*While the recap builds\*\*, tell the learner it is being built and wait\. Don't ask questions or teach meanwhile\. When it arrives, tell the learner to watch it\./);
		const nodeVideo = teacher.indexOf("**Node videos (`kind: \"video\"`");
		const recapBullet = teacher.indexOf("**The recap video (`kind: \"recap\"`)");
		const shortDeck = teacher.indexOf("**Short deck (`kind: \"deck\"`");
		assert.ok(nodeVideo < recapBullet && recapBullet < shortDeck, "after the node-video bullet, in the Slides section");
	});
});
