/**
 * Fork-only: guards the subject video (FORK.md "StatQuest method and slide
 * decks"): part validation, the length cap, the 7-minute part cap and each
 * part's own word range, collecting parts per chat into ONE job, the parallel build with a
 * retry and partial delivery, the part-prefixed file names (old names still
 * served), the card playing every part as one timeline, and the prompt.
 */
import React from "react";
const h = React.createElement;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-subject-"));
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

const { slidesInputProblems, subjectPartWordRange, SUBJECT_MAX_PART_MINUTES } = await import("../src/agent/fork-slides/tools.ts");
const { forkSlidesModelOverride, forkSlidesTtsOverride } = await import("../src/agent/fork-slides/runner-hook.ts");
const { forkSlidesDir, forkSlidesRoot, readSubjectParts, writeSubjectParts, forkSlidesAssetPath, sweepForkSlidesOrphans } = await import("../src/agent/fork-slides/storage.ts");
const { PATHS } = await import("../config.ts");
const fsDefault = (await import("node:fs")).default;
const { deckTimeline, isForkSlidesResult, subjectPartReceived, FORK_SLIDES_MARKER, FORK_SLIDES_FILE_RE, frameFileName, audioFileName, stageFileName } = await import(
	"../src/core/fork-slides.ts"
);
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { ForkSlidesCard } = await import("../components/artifacts/fork-slides-card.tsx");
const { GET } = await import("../app/api/fork-slides/[...path]/route.ts");
const { Value } = await import("typebox/value");

// ─── fixtures ───────────────────────────────────────────────────────────────

const STAGE =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect id="bg" width="1280" height="720" fill="#fff"/><text id="w1" x="100" y="100">× −34.4</text><rect id="box-w1" x="90" y="75" width="120" height="35"/></svg>';

const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");

/** One subject part: two slides (2 steps, then 1). Unless `extra.slides` is
 *  given, the last step's `say` is padded so the part's spoken words sit in
 *  the middle of its range for the final minutes and of. */
function part(n: number, of: number, extra: Record<string, unknown> = {}) {
	const { min, max } = subjectPartWordRange((extra.minutes as number | undefined) ?? 10, (extra.of as number | undefined) ?? of);
	const pad = extra.slides === undefined ? Math.max(0, Math.round((min + max) / 2) - 6) : 0; // "Part n opens." + "Box it." + "Done." = 6 words
	return {
		title: `Softplus, part ${n}`,
		kind: "subject" as const,
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

/** A slide-maker engine that answers each part's own conversation: it reads
 *  the part number from the script and the turn from the assistant count, so
 *  parallel parts never steal each other's responses. `failures[n]` makes
 *  part n's first that-many attempts crash. */
function partRouter(failures: Record<number, number> = {}): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const attempts: Record<number, number> = {};
	const route = (context: Context) => {
		const n = Number(/Kind: subject video, part (\d+) of/.exec(JSON.stringify(context.messages))?.[1] ?? 0);
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

const ctxFor = (chatId: string) => ({ chatId, jobStore, chatStore, spawn: () => {} });
async function send(chatId: string, toolCallId: string, input: unknown) {
	const res = await jobTools(ctxFor(chatId) as never).slides!.execute(toolCallId, input as never, undefined as never);
	return { text: (res.content[0] as { text: string }).text, isError: (res as { isError?: boolean }).isError === true };
}

// ─── 1. validation ─────────────────────────────────────────────────────────

describe("subject video: part validation (fork)", () => {
	it("needs part, of and minutes; at most 8 parts; the part within of; no continues", () => {
		const ctx = { chatId: chatStore.createChat("s").id, jobStore, chatStore };
		const { part: _p, ...noPart } = part(1, 2);
		assert.match(slidesInputProblems(noPart as never, ctx).join(), /a subject part needs part, of and minutes/);
		assert.match(slidesInputProblems(part(1, 9) as never, ctx).join(), /of: 9 parts; a subject video has at most 8/);
		assert.match(slidesInputProblems(part(3, 2) as never, ctx).join(), /part 3 of 2: the part number cannot exceed of/);
		assert.match(slidesInputProblems(part(1, 2, { continues: "x" }) as never, ctx).join(), /a subject part never continues another deck/);
		assert.deepEqual(slidesInputProblems(part(1, 8) as never, ctx), []);
	});

	it("caps the length at 25 minutes and says to tell the learner", () => {
		const ctx = { chatId: chatStore.createChat("s").id, jobStore, chatStore };
		assert.match(
			slidesInputProblems(part(1, 2, { minutes: 30 }) as never, ctx).join(),
			/minutes: 30 is over the 25-minute cap\. Use minutes: 25, and tell the learner the video is capped at 25 minutes\./,
		);
		assert.match(slidesInputProblems(part(1, 2, { minutes: 0 }) as never, ctx).join(), /at least 1 minute/);
		assert.deepEqual(slidesInputProblems(part(1, 4, { minutes: 25 }) as never, ctx), []);
	});

	it("keeps per-part deck limits and checks every number", () => {
		const ctx = { chatId: chatStore.createChat("s").id, jobStore, chatStore };
		const step = { say: "a", show: "x" };
		assert.match(slidesInputProblems(part(1, 2, { slides: Array.from({ length: 46 }, () => ({ steps: [step] })) }) as never, ctx).join(), /46 slides: at most 45/);
		const bad = part(1, 2, { slides: [{ steps: [{ ...step, numbers: [{ value: "2.26", expr: "log(1+exp(2.14))" }] }] }] });
		assert.match(slidesInputProblems(bad as never, ctx).join(), /slide 1, step 1, number 1: .*computes 2\.2512/);
	});

	it("schema: subject is a kind; part and of are positive integers", () => {
		const schema = jobTools(ctxFor("chat_schema") as never).slides!.parameters;
		assert.equal(Value.Check(schema, part(1, 3)), true);
		assert.equal(Value.Check(schema, part(0, 3)), false);
		assert.equal(Value.Check(schema, part(1.5, 3)), false);
		assert.equal(Value.Check(schema, part(1, 3, { minutes: 12.5 })), false, "whole minutes");
	});
});

// ─── 2. collecting parts into one job ──────────────────────────────────────

describe("subject video: collecting parts (fork)", () => {
	it("acks each part until all are in, then creates ONE job holding every part in order and clears the collection", async () => {
		const chatId = chatStore.createChat("collect").id;
		const spawned: unknown[] = [];
		const run = async (id: string, input: unknown) => {
			const res = await jobTools({ chatId, jobStore, chatStore, spawn: (_job: unknown, i: unknown) => spawned.push(i) } as never).slides!.execute(
				id,
				input as never,
				undefined as never,
			);
			return (res.content[0] as { text: string }).text;
		};
		assert.equal(await run("tc-p3", part(3, 3)), "Part 3 of 3 received; send the rest (still missing: parts 1, 2).");
		assert.equal(await run("tc-p1", part(1, 3)), "Part 1 of 3 received; send the rest (still missing: part 2).");
		assert.equal(jobStore.listJobs(chatId).length, 0, "no job until every part is in");
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => [p.toolCallId, p.input.part]), [["tc-p1", 1], ["tc-p3", 3]]);
		// a resent part replaces the old one
		assert.match(await run("tc-p1b", part(1, 3, { title: "Softplus, again" })), /^Part 1 of 3 received/);
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["tc-p1b", "tc-p3"]);

		const last = await run("tc-p2", part(2, 3));
		assert.match(last, /^Dispatched \(job job_/);
		assert.match(last, /let the learner try to invent the subject from the start: pose the problem it solves and ask, one question at a time with ask_user_question/);
		assert.match(last, /not quiz or explain/);
		assert.match(last, /Do not wait, poll, or mention waiting\./);
		assert.match(last, /tell the learner to watch it and to send a message when done; begin node 1 after that/);
		const jobs = jobStore.listJobs(chatId);
		assert.equal(jobs.length, 1);
		const input = jobs[0]!.input as Record<string, unknown> & { parts: Array<{ part: number; title: string }> };
		assert.equal(jobs[0]!.kind, "demo");
		assert.equal(jobs[0]!.toolCallId, "tc-p2", "the call that completed the video owns the job");
		assert.equal(input[FORK_SLIDES_MARKER], true);
		assert.equal(input.kind, "subject");
		assert.equal(input.title, "Softplus, again", "part 1's title");
		assert.deepEqual([input.of, input.minutes], [3, 10]);
		assert.deepEqual(input.calls, ["tc-p1b", "tc-p2", "tc-p3"], "each part's call id, the replaced part's gone");
		assert.deepEqual(input.parts.map((p) => p.part), [1, 2, 3]);
		assert.equal(spawned.length, 1);
		assert.equal(readSubjectParts(chatId), null, "collection cleared");
		// idempotent by the completing call's id
		assert.match(await run("tc-p2", part(2, 3)), /^Dispatched/);
		assert.equal(spawned.length, 1);
	});

	it("a later part with a different of or minutes is rejected; part 1 with them starts over", async () => {
		const chatId = chatStore.createChat("mismatch").id;
		await send(chatId, "m1", part(1, 3));
		await send(chatId, "m2", part(2, 3));
		const wrong = await send(chatId, "m3", part(3, 4));
		assert.equal(wrong.isError, true);
		assert.match(wrong.text, /part 3 says of 4, minutes 10, but the parts received so far say of 3, minutes 10\. .*send part 1 again to start the video over/);
		const wrongMinutes = await send(chatId, "m3b", part(3, 3, { minutes: 15 }));
		assert.match(wrongMinutes.text, /says of 3, minutes 15/);
		const restart = await send(chatId, "r1", part(1, 2, { minutes: 14 }));
		assert.equal(restart.text, "Part 1 of 2 received; send the rest (still missing: part 2).");
		assert.deepEqual(readSubjectParts(chatId), { of: 2, minutes: 14, parts: [{ toolCallId: "r1", input: part(1, 2, { minutes: 14 }) }] });
	});

	it("each part needs 80–120% of minutes ÷ of × 135 spoken words, with exact integer bounds", () => {
		assert.deepEqual(subjectPartWordRange(15, 3), { min: 540, max: 810 });
		assert.deepEqual(subjectPartWordRange(1, 1), { min: 108, max: 162 });
		assert.deepEqual(subjectPartWordRange(25, 4), { min: 675, max: 1012 }, "1012.5 rounds down");
		assert.deepEqual(subjectPartWordRange(10, 3), { min: 360, max: 540 });
		assert.deepEqual(subjectPartWordRange(13, 5), { min: 281, max: 421 }, "280.8 rounds up, 421.2 rounds down");
		const ctx = { chatId: chatStore.createChat("range").id, jobStore, chatStore };
		const sized = (w: number) => part(2, 3, { minutes: 15, slides: [{ steps: [{ say: words(w), show: "x" }] }] });
		assert.deepEqual(slidesInputProblems(sized(539) as never, ctx), [
			'part 2 has 539 spoken words; a 15-minute video in 3 parts needs 540–810 per part (80–120% of minutes ÷ of × 135). Lengthen this part\'s "say" text.',
		]);
		assert.deepEqual(slidesInputProblems(sized(811) as never, ctx), [
			'part 2 has 811 spoken words; a 15-minute video in 3 parts needs 540–810 per part (80–120% of minutes ÷ of × 135). Shorten this part\'s "say" text.',
		]);
		assert.deepEqual(slidesInputProblems(sized(540) as never, ctx), []);
		assert.deepEqual(slidesInputProblems(sized(810) as never, ctx), []);
	});

	it("a part is at most 7 minutes: minutes ÷ of over 7 is rejected with the parts needed, and no word range", () => {
		assert.equal(SUBJECT_MAX_PART_MINUTES, 7);
		const ctx = { chatId: chatStore.createChat("part minutes").id, jobStore, chatStore };
		const tooFew = "minutes 15 in 2 parts is 7.5 minutes per part; a part is at most 7 minutes, so a 15-minute video needs at least 3 parts (of: 3).";
		assert.deepEqual(slidesInputProblems(part(1, 2, { minutes: 15 }) as never, ctx), [tooFew]);
		assert.deepEqual(slidesInputProblems(part(1, 2, { minutes: 15, slides: [{ steps: [{ say: "Short.", show: "x" }] }] }) as never, ctx), [tooFew], "the word range is not reported too");
		assert.deepEqual(slidesInputProblems(part(1, 1, { minutes: 8 }) as never, ctx), [
			"minutes 8 in 1 part is 8 minutes per part; a part is at most 7 minutes, so a 8-minute video needs at least 2 parts (of: 2).",
		]);
		assert.deepEqual(slidesInputProblems(part(1, 3, { minutes: 22 }) as never, ctx), [
			"minutes 22 in 3 parts is 7.3 minutes per part; a part is at most 7 minutes, so a 22-minute video needs at least 4 parts (of: 4).",
		]);
		assert.deepEqual(slidesInputProblems(part(1, 2, { minutes: 14 }) as never, ctx), [], "exactly 7 minutes per part");
		assert.deepEqual(slidesInputProblems(part(1, 1, { minutes: 7 }) as never, ctx), []);
	});

	it("the word range is per part, not a total: each part is checked on its own words, a short part at once", async () => {
		// 2 minutes in 2 parts: 108–162 words per part.
		const sized = (n: number, w: number) => part(n, 2, { minutes: 2, slides: [{ steps: [{ say: words(w), show: "x" }] }] });
		const full = chatStore.createChat("words full").id;
		assert.match((await send(full, "f1", sized(1, 162))).text, /^Part 1 of 2 received/);
		assert.match((await send(full, "f2", sized(2, 162))).text, /^Dispatched/, "324 in all: no ceiling across parts");
		const mixed = chatStore.createChat("words mixed").id;
		const short = await send(mixed, "s1", sized(1, 50));
		assert.equal(short.isError, true, "a short part is rejected before any other part arrives");
		assert.match(short.text, /part 1 has 50 spoken words; a 2-minute video in 2 parts needs 108–162 per part .*Lengthen this part's "say" text\./);
		assert.equal(readSubjectParts(mixed), null);
		assert.match((await send(mixed, "m1", sized(1, 108))).text, /^Part 1 of 2 received/);
		assert.match((await send(mixed, "m2", sized(2, 107))).text, /part 2 has 107 spoken words.*Lengthen/);
		assert.match((await send(mixed, "m2b", sized(2, 163))).text, /part 2 has 163 spoken words.*Shorten/, "rejected though 108 + 163 is about the 270-word total");
		assert.match((await send(mixed, "m1b", sized(1, 162))).text, /^Part 1 of 2 received/, "a resent part is checked on its own words");
		assert.match((await send(mixed, "m2c", sized(2, 108))).text, /^Dispatched/);
	});

	it("parts dispatched together (one message, concurrent execute): valid parts are all collected, a short or disagreeing one is rejected, nothing acknowledged is dropped", async () => {
		const tool = jobTools(ctxFor("chat_unused") as never).slides!;
		assert.equal(tool.executionMode, "sequential", "pi runs one slides call at a time");
		const chatId = chatStore.createChat("concurrent").id;
		const run = (id: string, input: unknown) =>
			jobTools(ctxFor(chatId) as never).slides!.execute(id, input as never, undefined as never).then((r) => ({
				text: (r.content[0] as { text: string }).text,
				isError: (r as { isError?: boolean }).isError === true,
			}));
		// two valid parts and a short one, all at once (10 minutes in 4 parts: 270–405 words per part).
		const short = part(3, 4, { slides: [{ steps: [{ say: words(10), show: "x" }] }] });
		const together = await Promise.all([run("c1", part(1, 4)), run("c2", part(2, 4)), run("c3", short)]);
		assert.deepEqual(together.map((r) => r.isError), [false, false, true]);
		assert.match(together[0]!.text, /^Part 1 of 4 received/);
		assert.match(together[1]!.text, /^Part 2 of 4 received/);
		assert.match(together[2]!.text, /part 3 has 10 spoken words; a 10-minute video in 4 parts needs 270–405 per part .*Lengthen/);
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["c1", "c2"], "the valid parts stay collected");
		// a disagreeing part sent with the others is rejected, and the acknowledged ones stay
		const mixed = await Promise.all([run("c4", part(4, 4)), run("c5", part(3, 5))]);
		assert.deepEqual(mixed.map((r) => r.isError), [false, true]);
		assert.match(mixed[1]!.text, /part 3 says of 5, minutes 10, but the parts received so far say of 4, minutes 10/);
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["c1", "c2", "c4"], "every acknowledged part is still collected");
	});

	it("a replayed part call after the video was created gets the same ACK and never reopens a collection", async () => {
		const chatId = chatStore.createChat("replay").id;
		await send(chatId, "x1", part(1, 2));
		const done = await send(chatId, "x2", part(2, 2));
		assert.match(done.text, /^Dispatched \(job (job_\S+)\)/);
		const replay = await send(chatId, "x1", part(1, 2));
		assert.equal(replay.text, "Part 1 of 2 received.", "an earlier part gets its own received line back");
		assert.deepEqual(subjectPartReceived(replay.text), { part: 1, of: 2 }, "the card still recognises it");
		assert.equal((await send(chatId, "x2", part(2, 2))).text, done.text, "the completing call gets the dispatch ACK again");
		assert.equal(readSubjectParts(chatId), null, "no collection reopened");
		const fresh = await send(chatId, "y2", part(2, 2));
		assert.equal(fresh.text, "Part 2 of 2 received; send the rest (still missing: part 1).", "a new video starts clean, without the stale part 1");
		assert.equal(jobStore.listJobs(chatId).length, 1);
	});

	it("a collection left by a crash after the job was created is discarded; one with any unconsumed call is kept", async () => {
		const chatId = chatStore.createChat("crash").id;
		jobStore.createJob({ kind: "demo", chatId, toolCallId: "k2", input: { kind: "subject", title: "t", of: 2, minutes: 10, parts: [], calls: ["k1", "k2"], [FORK_SLIDES_MARKER]: true } });
		writeSubjectParts(chatId, { of: 2, minutes: 10, parts: [{ toolCallId: "k1", input: part(1, 2) }] });
		assert.equal((await send(chatId, "n2", part(2, 2))).text, "Part 2 of 2 received; send the rest (still missing: part 1).", "the consumed part 1 is not reused");
		assert.deepEqual(readSubjectParts(chatId)!.parts.map((p) => p.toolCallId), ["n2"]);
		const mixed = chatStore.createChat("crash mixed").id;
		jobStore.createJob({ kind: "demo", chatId: mixed, toolCallId: "m2", input: { kind: "subject", title: "t", of: 3, minutes: 10, parts: [], calls: ["m1", "m2"], [FORK_SLIDES_MARKER]: true } });
		writeSubjectParts(mixed, { of: 3, minutes: 10, parts: [{ toolCallId: "m1", input: part(1, 3) }, { toolCallId: "fresh", input: part(3, 3) }] });
		await send(mixed, "p2", part(2, 3));
		assert.equal(jobStore.listJobs(mixed).length, 2, "the kept collection completed with the new part");
	});

	it("writes the collection through upstream's atomic write", () => {
		const chatId = chatStore.createChat("atomic").id;
		const renames: string[] = [];
		// atomic-write.ts calls renameSync on the default fs object, so a test can watch it.
		const original = fsDefault.renameSync;
		fsDefault.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
			renames.push(String(to));
			return original(from, to);
		}) as typeof fs.renameSync;
		try {
			writeSubjectParts(chatId, { of: 2, minutes: 10, parts: [] });
		} finally {
			fsDefault.renameSync = original;
		}
		const file = path.join(forkSlidesRoot(), "subject-parts", `${chatId}.json`);
		assert.deepEqual(renames, [file], "a temp file renamed over the target");
		assert.deepEqual(readSubjectParts(chatId), { of: 2, minutes: 10, parts: [] });
	});

	it("a subject video cannot be continued", () => {
		const chatId = chatStore.createChat("no continue").id;
		jobStore.createJob({ kind: "demo", chatId, toolCallId: "subj", input: { kind: "subject", title: "t", of: 1, minutes: 5, parts: [part(1, 1)], [FORK_SLIDES_MARKER]: true } });
		const deck = { title: "d", kind: "deck", stage: "s", slides: [{ steps: [{ say: "a", show: "b" }] }], continues: "subj" };
		assert.match(slidesInputProblems(deck as never, { chatId, jobStore, chatStore }).join(), /is the subject video, which has one stage per part and cannot be continued/);
	});
});

// ─── 3. the build ──────────────────────────────────────────────────────────

describe("subject video: the parallel build (fork)", () => {
	const build = async (of: number, failures: Record<number, number>, synth: (typeof forkSlidesTtsOverride)["current"]) => {
		const chatId = chatStore.createChat("build").id;
		for (let n = 1; n < of; n++) await send(chatId, `b${n}`, part(n, of));
		await send(chatId, "b-last", part(of, of));
		const job = jobStore.findJobByToolCallId(chatId, "b-last")!;
		const router = partRouter(failures);
		headlessOverride.current = fakeHeadless();
		forkSlidesModelOverride.current = router.engine;
		forkSlidesTtsOverride.current = synth;
		try {
			await createJobRunner({ chatStore, jobStore, deliver: async () => {} }).runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			forkSlidesModelOverride.current = undefined;
			forkSlidesTtsOverride.current = undefined;
		}
		return { job: jobStore.getJob(job.id)!, calls: router.calls };
	};
	const voiced = (record: Array<{ text: string; out: string }>, sessions: number[] = []) => async (items: Array<{ text: string; out: string }>) => {
		sessions.push(items.length);
		record.push(...items);
		for (const it of items) fs.writeFileSync(it.out, "OggS");
		return { ok: true as const, durations: items.map(() => 2) };
	};

	it("draws every part at once, narrates all steps in one session, and delivers ONE deck with part-prefixed files", async () => {
		const items: Array<{ text: string; out: string }> = [];
		const synthCalls: number[] = [];
		const { job, calls } = await build(3, {}, voiced(items, synthCalls));
		assert.equal(job.status, "done", job.error);
		assert.deepEqual(calls.slice(0, 3).sort(), ["1#0", "2#0", "3#0"], "all three parts start before any part's second turn");
		assert.deepEqual(synthCalls, [9], "one narration session for every step of every part");
		const dir = forkSlidesDir(job.id)!;
		assert.deepEqual(
			items.map((i) => path.relative(dir, i.out)),
			["p1-audio-01-1.ogg", "p1-audio-01-2.ogg", "p1-audio-02-1.ogg", "p2-audio-01-1.ogg", "p2-audio-01-2.ogg", "p2-audio-02-1.ogg", "p3-audio-01-1.ogg", "p3-audio-01-2.ogg", "p3-audio-02-1.ogg"],
		);
		for (const f of ["p1-stage.svg", "p2-stage.svg", "p3-stage.svg", "p1-frame-01-1.svg", "p3-frame-02-1.svg"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
		assert.ok(!fs.existsSync(path.join(dir, "states.json")), "a subject video keeps no continuation state");

		assert.ok(isForkSlidesResult(job.result));
		const result = job.result as { title: string; notes: string; forkSlides: ForkSlidesDeck };
		assert.equal(result.title, "Softplus, part 1");
		const deck = result.forkSlides;
		assert.equal(deck.kind, "subject");
		assert.equal(deck.stage, "p1-stage.svg");
		assert.deepEqual(deck.parts, { of: 3, missing: [], calls: ["b1", "b2", "b-last"] }, "each part's call id, in part order");
		assert.deepEqual(deck.slides.map((s) => s.part), [1, 1, 2, 2, 3, 3]);
		assert.deepEqual(deck.slides[2]!.steps.map((s) => [s.frame, s.audio, s.duration]), [
			["p2-frame-01-1.svg", "p2-audio-01-1.ogg", 2],
			["p2-frame-01-2.svg", "p2-audio-01-2.ogg", 2],
		]);
		assert.equal(Math.round(deckTimeline(deck)!.total * 10) / 10, 31.6, "one timeline straight through every part: 9 × 2 s narration + 3 × 1.2 s step pauses + 5 × 2 s slide pauses");
		assert.match(result.notes, /the narrated subject video, 3 of 3 parts played straight through as one video \(6 slides, 9 build steps\)/);
		assert.match(result.notes, /Stop the invention questions now: tell the learner to watch it and to send a message when done; begin node 1 after that/);
		assert.match(result.notes, /part 1: Part 1 checked\. part 2: Part 2 checked\. part 3: Part 3 checked\./);
		assert.doesNotMatch(result.notes, /continues:/, "a subject video is never continued");

		const get = (file: string) => GET(new Request("http://localhost/x"), { params: Promise.resolve({ path: [job.id, file] }) });
		assert.equal((await get("p2-frame-01-2.svg")).status, 200);
		assert.equal((await get("p2-stage.svg")).status, 200);
		assert.equal((await get("p3-audio-02-1.ogg")).headers.get("content-type"), "audio/ogg");
		const html = await (await get("deck.html")).text();
		assert.equal((html.match(/data:image\/svg\+xml;base64,/g) ?? []).length, 9, "the download carries every part's frames");
	});

	it("a failed part is retried once and then succeeds", async () => {
		const { job, calls } = await build(2, { 2: 1 }, voiced([]));
		assert.equal(job.status, "done", job.error);
		assert.equal(calls.filter((c) => c === "2#0").length, 2, "part 2 drawn twice");
		const deck = (job.result as { forkSlides: ForkSlidesDeck }).forkSlides;
		assert.deepEqual(deck.parts, { of: 2, missing: [], calls: ["b1", "b-last"] });
	});

	it("a part that fails twice is left out: the card says so and the notes tell the teacher to cover it in prose", async () => {
		const { job } = await build(3, { 2: 2 }, voiced([]));
		assert.equal(job.status, "done", job.error);
		const result = job.result as { notes: string; forkSlides: ForkSlidesDeck };
		assert.deepEqual(result.forkSlides.parts, { of: 3, missing: [2], calls: ["b1", "b2", "b-last"] });
		assert.deepEqual(result.forkSlides.slides.map((s) => s.part), [1, 1, 3, 3]);
		assert.match(result.notes, /2 of 3 parts played straight through/);
		assert.match(result.notes, /Part 2 of 3 could not be drawn \(the slide maker crashed — part 2 engine down\), so the video skips that stretch: cover your part 2 script in prose/);
		const html = renderToStaticMarkup(h(ForkSlidesCard, { result: result as never }));
		assert.match(html, /data-testid="fork-slides-missing-parts"[^>]*>Part 2 of 3 could not be drawn\./);
		assert.ok(!fs.readdirSync(forkSlidesDir(job.id)!).some((f) => f.startsWith("p2-")), "nothing of part 2 on disk");
	});

	it("when every part fails the job fails as before", async () => {
		const { job } = await build(2, { 1: 2, 2: 2 }, voiced([]));
		assert.equal(job.status, "error");
		assert.match(job.error ?? "", /^FAILED: no part of the subject video could be drawn \(each was retried once\)\. Part 1: .*Part 2: /);
	});
});

// ─── 4. the orphan sweep ───────────────────────────────────────────────────

describe("slides assets: the orphan sweep (fork)", () => {
	it("removes job folders whose job is gone and collections whose chat is gone; keeps the rest", () => {
		const root = forkSlidesRoot();
		const liveChat = chatStore.createChat("sweep live").id;
		const live = jobStore.createJob({ kind: "demo", chatId: liveChat, toolCallId: "sweep-live", input: {} });
		const unreadable = jobStore.createJob({ kind: "demo", chatId: liveChat, toolCallId: "sweep-unreadable", input: {} });
		fs.writeFileSync(path.join(PATHS.data, "jobs", `${unreadable.id}.json`), "{half written");
		assert.equal(jobStore.getJob(unreadable.id), null, "a read that fails transiently");
		for (const dir of [live.id, unreadable.id, "job_sweptorphan", "not-a-job"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
		fs.writeFileSync(path.join(root, "job_sweptorphan", "stage.svg"), "<svg/>");
		writeSubjectParts(liveChat, { of: 2, minutes: 10, parts: [] });
		writeSubjectParts("chat_deleted_sweep", { of: 2, minutes: 10, parts: [] });
		const parts = path.join(root, "subject-parts");
		fs.writeFileSync(path.join(parts, "chat_deleted_temponly.json.tmp-0f3c"), "{}");
		fs.writeFileSync(path.join(parts, `${liveChat}.json.tmp-0f3c`), "{}");
		assert.ok(fs.existsSync(PATHS.chats));
		sweepForkSlidesOrphans();
		assert.ok(!fs.existsSync(path.join(root, "job_sweptorphan")), "the orphaned job folder is gone");
		assert.ok(fs.existsSync(path.join(root, live.id)), "an existing job's folder stays");
		assert.ok(fs.existsSync(path.join(root, unreadable.id)), "a job whose file exists but can't be read right now keeps its folder");
		assert.ok(!fs.existsSync(path.join(parts, "chat_deleted_temponly.json.tmp-0f3c")), "a deleted chat's temp-only leftover is gone");
		assert.ok(fs.existsSync(path.join(parts, `${liveChat}.json.tmp-0f3c`)), "a live chat's temp is left alone");
		assert.ok(fs.existsSync(path.join(root, "not-a-job")), "only job-id names are ever swept");
		assert.equal(readSubjectParts("chat_deleted_sweep"), null, "a deleted chat's collection is gone");
		assert.ok(readSubjectParts(liveChat), "a live chat's collection stays");
	});

	it("runs at the start of each slides job", async () => {
		const orphan = path.join(forkSlidesRoot(), "job_sweptbyrunner");
		fs.mkdirSync(orphan, { recursive: true });
		const chatId = chatStore.createChat("sweep runner").id;
		const job = jobStore.createJob({ kind: "demo", chatId, toolCallId: "sweep-run", input: { ...part(1, 1), kind: "deck", [FORK_SLIDES_MARKER]: true } });
		headlessOverride.current = { ...fakeHeadless(), unavailableReason: () => "no browser in this test" };
		forkSlidesModelOverride.current = partRouter().engine;
		try {
			await createJobRunner({ chatStore, jobStore, deliver: async () => {} }).runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			forkSlidesModelOverride.current = undefined;
		}
		assert.ok(!fs.existsSync(orphan));
	});
});

// ─── 5. file names, the card ───────────────────────────────────────────────

describe("subject video: file names and the card (fork)", () => {
	it("part files carry a p1–p8 prefix; the old names stay valid", () => {
		assert.equal(frameFileName(3, 2), "frame-03-2.svg");
		assert.equal(frameFileName(3, 2, 7), "p7-frame-03-2.svg");
		assert.equal(audioFileName(45, 6, 8), "p8-audio-45-6.ogg");
		assert.equal(stageFileName(), "stage.svg");
		assert.equal(stageFileName(2), "p2-stage.svg");
		for (const ok of ["stage.svg", "frame-01-1.svg", "audio-45-6.ogg", "p1-stage.svg", "p8-frame-45-6.svg", "p3-audio-01-1.ogg"]) assert.ok(FORK_SLIDES_FILE_RE.test(ok), ok);
		for (const bad of ["p0-stage.svg", "p9-frame-01-1.svg", "p10-frame-01-1.svg", "p1-states.json", "p1-deck.html", "p1p1-stage.svg", "p1-frame-1-1.svg"]) assert.ok(!FORK_SLIDES_FILE_RE.test(bad), bad);
		assert.equal(forkSlidesAssetPath("job_x", "p9-stage.svg"), null);
	});

	it("the card plays every part as one timeline, shows the part, and labels it a video", () => {
		const deck: ForkSlidesDeck = {
			version: 1,
			jobId: "job_subject_card",
			kind: "subject",
			stage: "p1-stage.svg",
			parts: { of: 3, missing: [2], calls: ["c1", "c2", "c3"] },
			slides: [
				{ part: 1, steps: [{ say: "One.", frame: "p1-frame-01-1.svg", audio: "p1-audio-01-1.ogg", duration: 2 }] },
				{ part: 3, steps: [{ say: "Three.", frame: "p3-frame-01-1.svg", audio: "p3-audio-01-1.ogg", duration: 3 }] },
			],
		};
		const tl = deckTimeline(deck)!;
		assert.deepEqual(tl.steps.map((s) => [s.slide, s.start, s.audio]), [
			[0, 0, "p1-audio-01-1.ogg"],
			[1, 4, "p3-audio-01-1.ogg"],
		]);
		const html = renderToStaticMarkup(h(ForkSlidesCard, { result: { title: "Subject", html: "slides", tested: true, forkSlides: deck } }));
		assert.match(html, />video</);
		assert.match(html, /part 1 of 3 · step 1 of 1/);
		assert.match(html, /Part 2 of 3 could not be drawn\./);
		assert.match(html, /0:00 \/ 0:07/, "2 + the 2 s slide pause + 3");
		// an old deck (no parts) renders as before
		const old = renderToStaticMarkup(
			h(ForkSlidesCard, { result: { title: "Old", html: "slides", tested: true, forkSlides: { version: 1, jobId: "job_old", kind: "deck", stage: "stage.svg", slides: [{ steps: [{ say: "Hi.", frame: "frame-01-1.svg" }] }] } } }),
		);
		assert.ok(!old.includes("fork-slides-missing-parts"));
		assert.match(old, />slides</);
		assert.match(old, />step 1 of 1 · 1\/1</);
	});
});

// ─── 6. the prompt ─────────────────────────────────────────────────────────

describe("subject video: the teacher prompt (fork)", () => {
	it("asks the length after the plan, builds the subject video in parts, node videos two ahead, decks only on request", () => {
		const teacher = composeInstructions("teacher");
		assert.match(teacher, /Once the learner confirms the plan, ask with `ask_user_question` how many minutes of narration the subject video should have: 10, 15, 20 or 25, with one option marked recommended/);
		assert.match(teacher, /show the expected play time with each option: 10 → about 14 minutes, 15 → about 21, 20 → about 29, 25 → about 36/);
		assert.match(
			teacher,
			/The pick sets the narration's length: every part must have 80–120% of its share of the spoken words, where the share is the pick ÷ the number of parts × 135 words \(15 minutes in 3 parts: 540–810 words per part\)\. The tool rejects a part outside that range\. 25 minutes of narration is the most/,
		);
		assert.match(teacher, /each a consecutive part of about 5–7 minutes and never more than 7 \(the pick ÷ the number of parts is at most 7\)/);
		assert.match(teacher, /Before writing a part, work out its word target \(the pick ÷ the number of parts × 135\) and write to it; at about 10 words per step, a 5-minute part is roughly 65 steps\./);
		assert.match(teacher, /\*\*The subject video \(`kind: "subject"`\)\.\*\* One video that explains the whole subject/);
		assert.match(teacher, /not organised by plan nodes/);
		assert.match(teacher, /let the learner try to invent the subject from the start\. Pose the problem the subject solves and ask, one question at a time with `ask_user_question` \(not `quiz` or `explain`\)/);
		assert.match(teacher, /without giving the answer away; the video will\. When the video arrives, stop asking/);
		assert.match(teacher, /\*\*While it builds\*\*, first build the node videos for nodes 1 and 2 \(the app names them when the subject video is dispatched\), then let the learner try to invent the subject from the start\./);
		assert.match(
			teacher,
			/\*\*Node videos \(`kind: "video"`, 3–6 minutes, about 550 words, with the node's `nodeId`\)\.\*\* Build them two nodes ahead: nodes 1 and 2 while the subject video builds; by the first question on node k, the videos for the next two nodes must already be dispatched \(the app names them if not\)\./,
		);
		assert.match(teacher, /Never build the video for the node the learner is at or has passed unless the learner asks\./);
		assert.match(teacher, /At a node whose video has arrived, point the learner to it first and wait for them to watch it and send a message\. Then teach the node in full with the method above: worked numbers, predict and check questions, going deeper and practising rather than repeating the video, then the node's closing essay\. The video never replaces the teaching\./);
		assert.match(teacher, /If the video has not arrived yet, teach the node in prose and point to the video when it arrives\. At a node show only its own video; do not show the subject video again\./);
		assert.doesNotMatch(teacher, /one node ahead/);
		assert.match(teacher, /only when the learner asks for one/);
		assert.doesNotMatch(teacher, /at the start of every plan node and for any hard concept/);
		assert.doesNotMatch(teacher, /Use `slides` for every step where numbers flow through a process/);
		assert.match(teacher, /16\. \*\*State the goals, then check them off\.\*\*/, "the method rules stay");
	});
});
