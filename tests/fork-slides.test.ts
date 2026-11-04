/**
 * Fork-only: guards the StatQuest method and slide decks (FORK.md). Covers
 * the number checker, dispatch validation, frame assembly, the slide
 * helper's look gate, the runner branch (Strong engine, stored assets), the
 * route, the card, the hooks in upstream files, and the prompt fragment.
 * Re-asserts the fork's version of the upstream tests skipped in
 * scripts/fork-test.mjs.
 */
import React from "react";
const h = React.createElement;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-slides-"));
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
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type PiEngine = import("../src/agent/models.ts").PiEngine;
type HeadlessApi = import("../src/agent/subagents/headless.ts").HeadlessApi;

const { evaluateExpr, checkNumber, parseDisplayedValue } = await import("../src/agent/fork-slides/expr.ts");
const { forkSlidesTools, slidesInputProblems, spokenWords, slidesInputSchema, NODE_VIDEO_TARGET_WORDS } = await import("../src/agent/fork-slides/tools.ts");
const { parseStage, assembleFrame, resolveSlide, stepProblems, StageError, FADE_OPACITY, BOX_RED, FRAME_BACKGROUND } = await import("../src/agent/fork-slides/frames.ts");
const { runSlidesMaker, FRAMES_PER_LOOK } = await import("../src/agent/subagents/fork-slides-maker.ts");
const { forkSlidesModelOverride, forkSlidesTtsOverride, isForkSlidesJob } = await import("../src/agent/fork-slides/runner-hook.ts");
const { forkSlidesDir, forkSlidesRoot } = await import("../src/agent/fork-slides/storage.ts");
const { isForkSlidesResult, FORK_SLIDES_MARKER } = await import("../src/core/fork-slides.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { buildSubagentSteer } = await import("../src/core/contracts.ts");
const { projectView } = await import("../src/core/view.ts");
const { SubagentSteerCard } = await import("../components/artifacts/steer-card.tsx");
const { ForkSlidesCard, ForkSlidesDispatchCard, nextBuildStep, moveSlide, deckKey } = await import("../components/artifacts/fork-slides-card.tsx");
const { artifactRenderers } = await import("../components/artifacts/index.ts");
const { DemoCard } = await import("../components/artifacts/demo-card.tsx");
const { TOGGLEABLE_TOOLS } = await import("../src/core/pending.ts");
const { TOGGLE_TOOLS, AgentSection } = await import("../components/settings/agent-section.tsx");
const { GET } = await import("../app/api/fork-slides/[...path]/route.ts");
const { SETTINGS_FILE } = await import("../config.ts");
const { forkSlidesNarration } = await import("../src/core/fork-slides.ts");
const { failedOutputCallIds } = await import("../src/core/native-messages.ts");
const { messageViewLines, teacherProseBlocks } = await import("../src/core/coverage.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { Value } = await import("typebox/value");
const { demoInputSchema, visualInputSchema, pdfInputSchema } = await import("../src/agent/tools/jobs.ts");

// ─── fixtures ───────────────────────────────────────────────────────────────

const STAGE = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
	"<defs><marker id=\"m\" markerWidth=\"4\" markerHeight=\"4\" refX=\"2\" refY=\"2\"><path d=\"M0,0 L4,2 L0,4 z\"/></marker></defs>",
	'<rect id="bg" width="1280" height="720" fill="#fff"/>',
	'<text id="w1" x="100" y="100" font-size="24" fill="#1565c0">× −34.4</text>',
	'<rect id="box-w1" x="90" y="75" width="120" height="35" display="none" stroke="black"/>',
	'<g id="b1"><text x="100" y="200" font-size="24">+ 2.14</text></g>',
	"</svg>",
].join("\n");

function script(overrides: Record<string, unknown> = {}) {
	return {
		title: "Softplus at dosage 0",
		kind: "deck" as const,
		stage: "Weight × −34.4 on the top connection (blue), bias + 2.14 below it; result 2.25.",
		slides: [
			{
				steps: [
					{ say: "Start with the weight on the top connection.", show: "the weight lights up" },
					{
						say: "Zero times minus thirty-four point four, plus two point one four, gives two point two five.",
						show: "box the weight",
						pointer: "the weight",
						numbers: [
							{ value: "2.14", expr: "0*-34.4+2.14" },
							{ value: "2.25", expr: "log(1+exp(0*-34.4+2.14))" },
						],
					},
				],
			},
		],
		...overrides,
	};
}

function scriptedModel(turns: Array<{ toolCalls?: Array<{ id: string; name: string; input: unknown }>; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((t) =>
		t.toolCalls
			? fauxAssistantMessage(t.toolCalls.map((c) => fauxToolCall(c.name, c.input as never, { id: c.id })), { stopReason: "toolUse" })
			: fauxAssistantMessage(t.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function fakeHeadless(): HeadlessApi & { renders: string[] } {
	const api = {
		renders: [] as string[],
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => ({ consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }),
		async renderSvg(svg: string): Promise<Buffer> {
			api.renders.push(svg);
			const canvas = createCanvas(1, 1);
			canvas.getContext("2d").fillRect(0, 0, 1, 1);
			return canvas.toBuffer("image/png");
		},
		renderPdfPages: async () => [],
	};
	return api;
}

const STEPS_1 = [{ lit: ["w1"] }, { lit: ["w1"], boxes: ["w1"], add: [{ id: "p", svg: '<text x="300" y="100">the weight</text>' }] }];

function newChat(title: string): string {
	return chatStore.createChat(title).id;
}

/** A chat with a two-node plan map (node videos need a nodeId on it). */
function plannedChat(title: string): string {
	const id = newChat(title);
	chatStore.saveTree(id, { nodes: [{ id: "n1", title: "One" }, { id: "n2", title: "Two" }], edges: [], version: 1 });
	return id;
}

// ─── 1. the number checker ─────────────────────────────────────────────────

describe("slides: the number checker (fork)", () => {
	it("computes with precedence, functions and constants", () => {
		assert.equal(evaluateExpr("1+2*3"), 7);
		assert.equal(evaluateExpr("(1+2)*3"), 9);
		assert.equal(evaluateExpr("2^3^2"), 512, "^ is right-associative");
		assert.equal(evaluateExpr("-2^2"), -4, "unary minus binds looser than ^");
		assert.equal(evaluateExpr("2^-1"), 0.5);
		assert.equal(evaluateExpr("0*-34.4+2.14"), 2.14);
		assert.ok(Math.abs(evaluateExpr("log(1+exp(2.14))") - 2.2512) < 1e-4);
		assert.equal(evaluateExpr("ln(e)"), 1);
		assert.equal(evaluateExpr("sqrt(16) + abs(-3)"), 7);
		assert.equal(evaluateExpr("min(3, 1, 2) + max(4, 9)"), 10);
		assert.ok(Math.abs(evaluateExpr("pi") - Math.PI) < 1e-12);
		assert.equal(evaluateExpr("1.5e2 + 2E-1"), 150.2);
		assert.equal(evaluateExpr("−3 + 1"), -2, "U+2212 reads as minus");
	});

	it("rounds to the displayed decimals", () => {
		assert.ok(checkNumber("2.25", "log(1+exp(0*-34.4+2.14))").ok);
		assert.ok(checkNumber("2.3", "log(1+exp(2.14))").ok);
		assert.ok(checkNumber("2", "log(1+exp(2.14))").ok);
		assert.ok(checkNumber("−1.91", "-1.9137").ok, "a leading U+2212 is a minus in value");
		assert.ok(checkNumber("0.125", "1/8").ok);
		assert.ok(checkNumber("1.5e-4", "0.00015").ok);
		assert.deepEqual(parseDisplayedValue("2.25"), { value: 2.25, decimals: 2 });
		const bad = checkNumber("2.26", "log(1+exp(2.14))");
		assert.equal(bad.ok, false);
		assert.match(!bad.ok ? bad.reason : "", /computes 2\.2512.*rounds to 2\.25, not 2\.26/);
	});

	it("rejects garbage and eval-able input", () => {
		for (const src of [
			"",
			"1+",
			"(1+2",
			"1 2",
			"foo(1)",
			"alert(1)",
			"constructor",
			"toString(1)",
			"__proto__",
			"process.exit(1)",
			"require('fs')",
			"1;2",
			"[1]",
			"`1`",
			"x=1",
			"Math.PI",
			"exp(1,2)",
			"1/0",
			"log(-1)",
		]) {
			assert.throws(() => evaluateExpr(src), Error, src);
		}
		assert.equal(checkNumber("abc", "1").ok, false);
		assert.equal(checkNumber("1", "process.exit(1)").ok, false);
	});
});

// ─── 2. dispatch validation ────────────────────────────────────────────────

describe("slides: dispatch (fork)", () => {
	const spawned: Array<{ id: string; input: unknown }> = [];
	const ctxFor = (chatId: string) => ({ chatId, jobStore, chatStore, spawn: (job: { id: string }, input: unknown) => spawned.push({ id: job.id, input }) });
	const run = async (chatId: string, toolCallId: string, input: unknown) => {
		const tools = jobTools(ctxFor(chatId) as never);
		const res = await tools.slides!.execute(toolCallId, input as never, undefined as never);
		return { text: (res.content[0] as { text: string }).text, isError: (res as { isError?: boolean }).isError === true };
	};

	it("a valid call creates one demo job with the slides marker and returns the deck ACK", async () => {
		const chatId = newChat("slides dispatch");
		const before = spawned.length;
		const res = await run(chatId, "tc-valid", script());
		assert.equal(res.isError, false);
		assert.match(res.text, /^Dispatched \(job job_/);
		assert.match(res.text, /IS the explanation/);
		assert.match(res.text, /keep the learner working/);
		assert.match(res.text, /Do not wait, poll, or mention waiting\./);
		assert.ok(!/end your turn/.test(res.text), "a short deck no longer ends the turn");
		const job = jobStore.findJobByToolCallId(chatId, "tc-valid")!;
		assert.equal(job.kind, "demo");
		assert.equal((job.input as Record<string, unknown>)[FORK_SLIDES_MARKER], true);
		assert.ok(isForkSlidesJob(job));
		assert.equal(spawned.length, before + 1);
		assert.equal((spawned.at(-1)!.input as Record<string, unknown>)[FORK_SLIDES_MARKER], true);
		// idempotent by toolCallId
		await run(chatId, "tc-valid", script());
		assert.equal(spawned.length, before + 1, "no second spawn");
	});

	it("a video ACK says to carry on meanwhile, to show it first at its node, then to teach the node in full", async () => {
		const chatId = plannedChat("slides video");
		const say = Array.from({ length: 50 }, () => "one two three four five six seven eight nine").join(" ");
		const res = await run(chatId, "tc-video", script({ kind: "video", nodeId: "n2", slides: [{ steps: [{ say, show: "x" }] }] }));
		assert.equal(res.isError, false, res.text);
		assert.match(res.text, /Carry on with the current activity while it builds \(during the subject video, the invention questions; otherwise teach in prose\): do not wait, poll, or mention waiting\./);
		assert.match(
			res.text,
			/The node video arrives as a new message\. At its node, point the learner to it first and wait for them to watch it and send a message; then teach that node in full \(worked numbers, predict and check questions, its closing essay\): the video never replaces the teaching\./,
		);
		assert.equal((jobStore.findJobByToolCallId(chatId, "tc-video")!.input as { nodeId?: string }).nodeId, "n2", "the job keeps the node");
	});

	it("a video needs a nodeId from this session's plan map", async () => {
		const say = Array.from({ length: 50 }, () => "one two three four five six seven eight nine").join(" ");
		const video = (extra: Record<string, unknown>) => script({ kind: "video", slides: [{ steps: [{ say, show: "x" }] }], ...extra });
		const chatId = plannedChat("slides video node");
		const missing = await run(chatId, "tc-video-nonode", video({}));
		assert.equal(missing.isError, true);
		assert.match(missing.text, /a video needs nodeId/);
		const unknown = await run(chatId, "tc-video-unknown", video({ nodeId: "n9" }));
		assert.match(unknown.text, /nodeId "n9" matches no node in this session's plan map\. Copy one of your plan_init slugs exactly \(n1, n2\)/);
		const unplanned = await run(newChat("slides video no plan"), "tc-video-noplan", video({ nodeId: "n1" }));
		assert.match(unplanned.text, /No plan map exists yet/);
		assert.equal(jobStore.findJobByToolCallId(chatId, "tc-video-unknown"), null, "no job for an invalid call");
		assert.deepEqual(slidesInputProblems(script({ nodeId: "n9" }) as never, { chatId, jobStore, chatStore }), [], "a deck ignores nodeId");
	});

	it("rejects a wrong or unparsable number, naming slide, step, number and the computed value", async () => {
		const chatId = newChat("slides bad number");
		const bad = script();
		bad.slides[0]!.steps[1]!.numbers = [{ value: "2.26", expr: "log(1+exp(2.14))" }, { value: "1", expr: "2+" }];
		const res = await run(chatId, "tc-bad", bad);
		assert.equal(res.isError, true);
		assert.match(res.text, /slide 1, step 2, number 1: .*computes 2\.2512/);
		assert.match(res.text, /slide 1, step 2, number 2: expression "2\+" does not parse/);
		assert.equal(jobStore.findJobByToolCallId(chatId, "tc-bad"), null, "no job for an invalid call");
	});

	it("rejects more than 45 slides, 6 steps per slide, or 120 steps", () => {
		const ctx = { chatId: "x", jobStore };
		const step = { say: "a b c", show: "x" };
		assert.match(slidesInputProblems(script({ slides: Array.from({ length: 46 }, () => ({ steps: [step] })) }) as never, ctx).join(), /46 slides: at most 45/);
		assert.match(slidesInputProblems(script({ slides: [{ steps: Array.from({ length: 7 }, () => step) }] }) as never, ctx).join(), /slide 1 has 7 steps: at most 6/);
		const many = Array.from({ length: 21 }, () => ({ steps: Array.from({ length: 6 }, () => step) }));
		assert.match(slidesInputProblems(script({ slides: many }) as never, ctx).join(), /126 steps in the deck: at most 120/);
		assert.deepEqual(slidesInputProblems(script({ slides: many.slice(0, 20) }) as never, ctx), [], "exactly 120 steps is fine");
	});

	it("rejects a video outside 400–850 spoken words, counting every say", () => {
		const ctx = { chatId: plannedChat("slides video words"), jobStore, chatStore };
		const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");
		const video = (n: number) => script({ kind: "video", nodeId: "n1", slides: [{ steps: [{ say: words(n - 100), show: "x" }, { say: words(100), show: "y" }] }] });
		assert.equal(spokenWords(video(500) as never), 500);
		assert.deepEqual(slidesInputProblems(video(399) as never, ctx), [
			'a node video needs 400–850 spoken words; this script\'s "say" text has 399 words: at least 1 more are needed; aim for about 550 (about 151 more).',
		]);
		assert.deepEqual(slidesInputProblems(video(385) as never, ctx), [
			'a node video needs 400–850 spoken words; this script\'s "say" text has 385 words: at least 15 more are needed; aim for about 550 (about 165 more).',
		]);
		assert.deepEqual(slidesInputProblems(video(900) as never, ctx), [
			'a node video needs 400–850 spoken words; this script\'s "say" text has 900 words: cut at least 50; aim for about 550.',
		]);
		assert.match(slidesInputProblems(video(851) as never, ctx).join(), /has 851 words: cut at least 1;/);
		assert.equal(NODE_VIDEO_TARGET_WORDS, 550);
		assert.match((slidesInputSchema.properties.kind as unknown as { description: string }).description, /"video": a node video of 400–850 spoken words \(aim for about 550 words, about 50–60 steps\), for the plan node in nodeId, built two nodes ahead\./);
		assert.deepEqual(slidesInputProblems(video(400) as never, ctx), []);
		assert.deepEqual(slidesInputProblems(video(850) as never, ctx), []);
		assert.deepEqual(slidesInputProblems(script({ slides: [{ steps: [{ say: words(10), show: "x" }] }] }) as never, ctx), [], "a deck has no word range");
	});

	it("the subject video's ACK names the videos of nodes 1 and 2 (those not already built), only when they can be drawn; a replay gets the same ACK", async () => {
		const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");
		const part = script({ kind: "subject", part: 1, of: 1, minutes: 5, slides: [{ steps: [{ say: words(600), show: "x" }] }] });
		const nodeVideo = script({ kind: "video", nodeId: "n1", slides: [{ steps: [{ say: words(450), show: "x" }] }] });
		const BOTH = 'Now, before the invention questions, build the node videos for "n1" ("One") and "n2" ("Two"): one slides call each, kind "video".';
		headlessOverride.current = fakeHeadless();
		try {
			const chatId = plannedChat("slides subject ack");
			const res = await run(chatId, "tc-subject-ack", part);
			assert.equal(res.isError, false, res.text);
			assert.match(res.text, /^Dispatched \(job job_/);
			assert.match(res.text, /begin node 1 after that\./);
			assert.ok(res.text.endsWith(` ${BOTH}`), res.text);
			assert.equal((await run(chatId, "tc-subject-ack", part)).text, res.text, "a replayed completing call gets the ACK it got");

			const covered = plannedChat("slides subject ack covered");
			assert.equal((await run(covered, "tc-video-first", nodeVideo)).isError, false);
			const one = await run(covered, "tc-subject-covered", part);
			assert.ok(one.text.endsWith(' Now, before the invention questions, build the node video for "n2" ("Two"): one slides call, kind "video".'), one.text);

			// The sequence the subject ACK asks for: node 1's and node 2's videos, while the invention questions go on.
			const seq = plannedChat("slides subject then node videos");
			const subjectAck = await run(seq, "tc-seq-subject", part);
			assert.ok(subjectAck.text.endsWith(` ${BOTH}`), subjectAck.text);
			assert.match(subjectAck.text, /Meanwhile let the learner try to invent the subject/);
			for (const nodeId of ["n1", "n2"]) {
				const ack = await run(seq, `tc-seq-${nodeId}`, { ...nodeVideo, nodeId });
				assert.equal(ack.isError, false, ack.text);
				assert.match(ack.text, /during the subject video, the invention questions/);
				assert.doesNotMatch(ack.text, /[Ss]top (asking|the invention)/, "a node video never ends the invention questions");
				assert.doesNotMatch(ack.text, /^Dispatched \(job [^)]+\)\. Keep teaching in prose/, "nor says to teach meanwhile, which the subject phase forbids");
			}

			const unplanned = await run(newChat("slides subject ack no plan"), "tc-subject-noplan", part);
			assert.ok(unplanned.text.endsWith("begin node 1 after that."), "no plan map, no node line");
		} finally {
			headlessOverride.current = undefined;
		}
		headlessOverride.current = { ...fakeHeadless(), unavailableReason: () => "no browser" };
		try {
			const res = await run(plannedChat("slides subject ack headless"), "tc-subject-headless", part);
			assert.equal(res.isError, false, res.text);
			assert.ok(res.text.endsWith("begin node 1 after that."), "no node line when videos cannot be drawn");
		} finally {
			headlessOverride.current = undefined;
		}
	});

	it("rejects continues that is not an earlier finished slides deck in this chat", async () => {
		const chatId = newChat("slides continues");
		const otherChat = newChat("slides other");
		const ctx = { chatId, jobStore };
		assert.match(slidesInputProblems(script({ continues: "nope" }) as never, ctx).join(), /not the toolCallId of an earlier slides call/);
		jobStore.createJob({ kind: "demo", chatId, toolCallId: "plain-demo", input: { title: "d", brief: "b" } });
		assert.match(slidesInputProblems(script({ continues: "plain-demo" }) as never, ctx).join(), /not the toolCallId of an earlier slides call/);
		jobStore.createJob({ kind: "demo", chatId: otherChat, toolCallId: "elsewhere", input: { ...script(), [FORK_SLIDES_MARKER]: true } });
		assert.match(slidesInputProblems(script({ continues: "elsewhere" }) as never, ctx).join(), /not the toolCallId/, "another chat's deck does not count");
		const running = jobStore.createJob({ kind: "demo", chatId, toolCallId: "running-deck", input: { ...script(), [FORK_SLIDES_MARKER]: true } });
		assert.match(slidesInputProblems(script({ continues: "running-deck" }) as never, ctx).join(), /still being built/);
		jobStore.updateJob(running.id, { status: "done" });
		assert.deepEqual(slidesInputProblems(script({ continues: "running-deck" }) as never, ctx), []);
	});
});

// ─── 3. frame assembly ─────────────────────────────────────────────────────

describe("slides: frame assembly (fork)", () => {
	it("parses top-level parts and boxes; rejects unnamed parts, orphan boxes and unsafe markup", () => {
		const stage = parseStage(STAGE);
		assert.deepEqual(stage.partIds, ["bg", "w1", "box-w1", "b1"]);
		assert.deepEqual([...stage.boxes.entries()], [["w1", "box-w1"]]);
		const bad = (svg: string) => assert.throws(() => parseStage(svg), StageError, svg);
		bad(STAGE.replace('<g id="b1">', "<g>"));
		bad(STAGE.replace('id="box-w1"', 'id="box-nothing"'));
		bad(STAGE.replace("</svg>", "<script>alert(1)</script></svg>"));
		bad(STAGE.replace('<rect id="bg"', '<rect id="bg" onclick="x()"'));
		bad(STAGE.replace("</g>", ""));
		bad(STAGE.replace(' width="1280" height="720"', ""));
		bad(STAGE.replace('id="b1"', 'id="w1"'));
	});

	it("is deterministic, fades unlit parts, and shows boxes in red only when asked", () => {
		const stage = parseStage(STAGE);
		const [s1, s2] = resolveSlide(STEPS_1);
		const f1 = assembleFrame(stage, s1!);
		assert.equal(assembleFrame(parseStage(STAGE), s1!), f1, "same stage + state → same frame");
		assert.ok(f1.includes(`<g opacity="${FADE_OPACITY}"><g id="b1">`), "unlit part faded");
		assert.ok(f1.includes(`<g opacity="${FADE_OPACITY}"><rect id="bg"`), "background is a part too");
		assert.ok(f1.includes('<text id="w1"') && !f1.includes(`opacity="${FADE_OPACITY}"><text id="w1"`), "lit part at full strength");
		assert.ok(!f1.includes('id="box-w1"'), "box hidden by default");
		const f2 = assembleFrame(stage, s2!);
		const box = /<rect id="box-w1"[^>]*>/.exec(f2)?.[0] ?? "";
		assert.ok(box.includes(`stroke="${BOX_RED}"`) && box.includes('fill="none"'), "shown box is red");
		assert.ok(!box.includes("display=") && !box.includes('stroke="black"'), "the box's own paint/visibility is overridden");
		assert.ok(f2.includes('<g data-overlay="p"><text x="300" y="100">the weight</text></g>'), "overlay drawn on top");
		assert.ok(f2.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1280"') && f2.trimEnd().endsWith("</svg>"), "stage head/tail kept");
		const all = assembleFrame(stage, { hide: ["b1"], boxes: [], overlay: [] });
		assert.ok(!all.includes("opacity="), "no lit list → nothing faded");
		assert.ok(!all.includes('id="b1"'), "hidden part not drawn");
	});

	it("every frame starts with a white background as the root's first child, even without a stage background", () => {
		assert.equal(FRAME_BACKGROUND, '<rect width="100%" height="100%" fill="#fff"/>');
		const bare = parseStage('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><text id="t" x="5" y="20">0</text></svg>');
		const frame = assembleFrame(bare, { lit: [], hide: [], boxes: [], overlay: [] });
		assert.ok(frame.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50">${FRAME_BACKGROUND}<g opacity=`), frame);
		const withBg = assembleFrame(parseStage(STAGE), resolveSlide(STEPS_1)[0]!);
		const root = /^<svg[^>]*>/.exec(withBg)![0];
		assert.ok(withBg.slice(root.length).startsWith(FRAME_BACKGROUND), "also when the stage has its own background");
		assert.equal(withBg.split(FRAME_BACKGROUND).length - 1, 1, "exactly once");
	});

	it("overlay additions persist within a slide until removed", () => {
		const states = resolveSlide([
			{ add: [{ id: "a", svg: "<text>1</text>" }] },
			{ add: [{ id: "b", svg: "<text>2</text>" }] },
			{ remove: ["a"] },
		]);
		assert.deepEqual(states.map((s) => s.overlay.map((o) => o.id)), [["a"], ["a", "b"], ["b"]]);
		const carried = resolveSlide([{}], [{ id: "old", svg: "<text>9</text>" }]);
		assert.deepEqual(carried[0]!.overlay.map((o) => o.id), ["old"], "a continued slide 1 starts with the earlier overlay");
	});

	it("step states must name real parts, boxes and overlay items", () => {
		const stage = parseStage(STAGE);
		const problems = stepProblems(stage, [{ lit: ["nope"], boxes: ["b1"], remove: ["ghost"], add: [{ id: "x", svg: "<text>1" }] }], "slide 1");
		assert.equal(problems.length, 4, problems.join("\n"));
	});
});

// ─── 4. the look gate ──────────────────────────────────────────────────────

describe("slides: the helper's look gate (fork)", () => {
	const write = { id: "w", name: "write_stage", input: { svg: STAGE } };

	it("refuses to finish with unlooked frames: shows them, then accepts", async () => {
		const headless = fakeHeadless();
		const engine = scriptedModel([
			{ toolCalls: [write] },
			{ toolCalls: [{ id: "s1", name: "set_slide", input: { slide: 1, steps: STEPS_1 } }] },
			{ text: "Done." }, // premature: no frame seen yet
			{ text: "Looked at both frames; correct." },
		]);
		const res = await runSlidesMaker(script() as never, { engine, headless });
		assert.equal(res.ok, true, res.notes);
		assert.equal(headless.renders.length, 2, "the gate rendered both frames itself");
		assert.equal(res.ok && res.frames.length, 2);
		assert.equal(res.ok && res.notes, "Looked at both frames; correct.");
	});

	it("re-shows only the frames whose SVG changed after a fix", async () => {
		const headless = fakeHeadless();
		const fixed = [STEPS_1[0], { ...STEPS_1[1], lit: ["w1", "b1"] }];
		const engine = scriptedModel([
			{ toolCalls: [write, { id: "s1", name: "set_slide", input: { slide: 1, steps: STEPS_1 } }] },
			{ toolCalls: [{ id: "l1", name: "look", input: {} }] },
			{ toolCalls: [{ id: "s2", name: "set_slide", input: { slide: 1, steps: fixed } }] },
			{ toolCalls: [{ id: "l2", name: "look", input: {} }] },
			{ text: "Fixed step 2." },
		]);
		const res = await runSlidesMaker(script() as never, { engine, headless });
		assert.equal(res.ok, true, res.notes);
		assert.equal(headless.renders.length, 3, "2 frames, then only the changed one");
	});

	it(`batches at most ${FRAMES_PER_LOOK} frames per look, and fails at the cap instead of delivering unlooked frames`, async () => {
		const step = { say: "a", show: "b" };
		const big = script({ slides: [{ steps: [step, step, step, step] }, { steps: [step, step, step, step] }] });
		const four = [{}, {}, {}, {}];
		const setBoth = { toolCalls: [write, { id: "a", name: "set_slide", input: { slide: 1, steps: four } }, { id: "b", name: "set_slide", input: { slide: 2, steps: four } }] };

		const headless = fakeHeadless();
		const ok = await runSlidesMaker(big as never, { engine: scriptedModel([setBoth, { text: "x" }, { text: "y" }, { text: "all good" }]), headless });
		assert.equal(ok.ok, true, ok.notes);
		assert.equal(headless.renders.length, 8, "6 then 2");

		const capped = fakeHeadless();
		const failed = await runSlidesMaker(big as never, { engine: scriptedModel([setBoth, { text: "x" }, { text: "y" }]), headless: capped, maxIterations: 2 });
		assert.equal(failed.ok, false);
		assert.match(failed.notes, /^FAILED: iteration limit \(2\)/);
		assert.match(failed.notes, /2 frames unseen/);
	});

	it("refuses to finish while slides are undeclared", async () => {
		const step = { say: "a", show: "b" };
		const two = script({ slides: [{ steps: [step] }, { steps: [step] }] });
		const headless = fakeHeadless();
		const res = await runSlidesMaker(two as never, {
			engine: scriptedModel([
				{ toolCalls: [write, { id: "a", name: "set_slide", input: { slide: 1, steps: [{}] } }] },
				{ text: "done" },
				{ text: "still done" },
			]),
			headless,
			maxIterations: 3,
		});
		assert.equal(res.ok, false, "slide 2 was never declared");
	});
});

// ─── 5. the runner branch, storage and the route ────────────────────────────

describe("slides: runner, storage and route (fork)", () => {
	const deliveredSteers: unknown[] = [];
	const runner = (engineFor?: (role: string) => PiEngine | undefined) =>
		createJobRunner({
			chatStore,
			jobStore,
			engineFor: engineFor as never,
			deliver: async (steer) => {
				deliveredSteers.push(steer);
			},
		});

	it("a slides job asks for the teacher's (Strong) engine and refuses on the strong tier", async () => {
		const chatId = newChat("slides engine");
		const job = jobStore.createJob({ kind: "demo", chatId, toolCallId: "tc-engine", input: { ...script(), [FORK_SLIDES_MARKER]: true } });
		const roles: string[] = [];
		await runner((role) => {
			roles.push(role);
			return undefined;
		}).runJob(job.id);
		assert.deepEqual(roles, ["teacher"]);
		const after = jobStore.getJob(job.id)!;
		assert.match(after.error ?? "", /missing: strong/);
		// a plain demo job still asks for the demo builder
		const plain = jobStore.createJob({ kind: "demo", chatId, toolCallId: "tc-plain", input: { title: "t", brief: "b" } });
		const plainRoles: string[] = [];
		await runner((role) => {
			plainRoles.push(role);
			return undefined;
		}).runJob(plain.id);
		assert.deepEqual(plainRoles, ["demoBuilder"]);
	});

	it("runs end to end: frames on disk under the data root, references in the result, served by the route", async () => {
		const chatId = newChat("slides e2e");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		// Narration is covered by tests/fork-slides-narration.test.ts; never spawn uv here.
		forkSlidesTtsOverride.current = async () => ({ ok: false, reason: "no narration in this test" });
		forkSlidesModelOverride.current = scriptedModel([
			{ toolCalls: [{ id: "w", name: "write_stage", input: { svg: STAGE } }, { id: "s", name: "set_slide", input: { slide: 1, steps: STEPS_1 } }] },
			{ toolCalls: [{ id: "l", name: "look", input: {} }] },
			{ text: "Both frames checked." },
		]);
		try {
			const tools = jobTools({ chatId, jobStore, spawn: () => {} } as never);
			await tools.slides!.execute("tc-e2e", script() as never, undefined as never);
			const job = jobStore.findJobByToolCallId(chatId, "tc-e2e")!;
			await runner().runJob(job.id);
			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done", done.error);
			const result = done.result as Record<string, unknown>;
			assert.ok(isForkSlidesResult(result));
			assert.equal(typeof result.html, "string");
			assert.ok((result.html as string).length > 0, "html is a non-empty placeholder");
			assert.ok(!JSON.stringify(result).includes("<svg"), "no inline SVG in the result");
			assert.match(result.notes as string, /narrated slide deck \(deck\).*1 slide, 2 build steps/);
			assert.match(result.notes as string, /continues: "tc-e2e"/);
			const deck = (result as { forkSlides: { slides: Array<{ steps: Array<{ say: string; frame: string }> }> } }).forkSlides;
			assert.deepEqual(deck.slides[0]!.steps.map((s) => s.frame), ["frame-01-1.svg", "frame-01-2.svg"]);
			assert.equal(deck.slides[0]!.steps[0]!.say, "Start with the weight on the top connection.");

			const dir = forkSlidesDir(job.id)!;
			assert.equal(path.dirname(path.dirname(dir)), path.dirname(SETTINGS_FILE), "under <data root>/fork-slides/<jobId>");
			assert.equal(forkSlidesRoot(), path.join(path.dirname(SETTINGS_FILE), "fork-slides"));
			for (const f of ["stage.svg", "frame-01-1.svg", "frame-01-2.svg", "states.json"]) assert.ok(fs.existsSync(path.join(dir, f)), f);

			const get = (...p: string[]) => GET(new Request("http://localhost/api/fork-slides/x"), { params: Promise.resolve({ path: p }) });
			const frame = await get(job.id, "frame-01-2.svg");
			assert.equal(frame.status, 200);
			assert.equal(frame.headers.get("content-type"), "image/svg+xml; charset=utf-8");
			assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
			assert.match(await frame.text(), new RegExp(`stroke="${BOX_RED}"`));
			const html = await get(job.id, "deck.html");
			assert.equal(html.status, 200);
			assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
			const body = await html.text();
			assert.match(body, /data:image\/svg\+xml;base64,/);
			assert.match(body, /Start with the weight on the top connection\./);
			assert.ok(!body.includes("<svg"), "frames embed as image documents only");

			// the steer: the arrival card is the slides card
			const steer = buildSubagentSteer(done, done.result as never);
			const markup = renderToStaticMarkup(h(SubagentSteerCard, { message: projectView([steer])[0] as never }));
			assert.match(markup, /data-testid="fork-slides-card"/);
			assert.match(markup, /1 \/ 1/);
		} finally {
			headlessOverride.current = undefined;
			forkSlidesModelOverride.current = undefined;
			forkSlidesTtsOverride.current = undefined;
		}
	});

	it("a delivered node video's notes: show it first at its node, wait for the learner, then teach the node in full", async () => {
		const chatId = plannedChat("slides node video notes");
		headlessOverride.current = fakeHeadless();
		forkSlidesTtsOverride.current = async () => ({ ok: false, reason: "no narration in this test" });
		forkSlidesModelOverride.current = scriptedModel([
			{ toolCalls: [{ id: "w", name: "write_stage", input: { svg: STAGE } }, { id: "s", name: "set_slide", input: { slide: 1, steps: STEPS_1 } }] },
			{ toolCalls: [{ id: "l", name: "look", input: {} }] },
			{ text: "Both frames checked." },
		]);
		try {
			const job = jobStore.createJob({ kind: "demo", chatId, toolCallId: "tc-node-notes", input: { ...script({ kind: "video", nodeId: "n2" }), [FORK_SLIDES_MARKER]: true } });
			await runner().runJob(job.id);
			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done", done.error);
			assert.match(
				(done.result as { notes: string }).notes,
				/It is the video for node "n2", built ahead: when the learner reaches that node, point them to it first and wait for them to watch it and send a message; then teach that node in full \(worked numbers, predict and check questions, its closing essay\): the video never replaces the teaching\. Do not retell it\./,
			);
		} finally {
			headlessOverride.current = undefined;
			forkSlidesModelOverride.current = undefined;
			forkSlidesTtsOverride.current = undefined;
		}
	});

	it("the route rejects traversal and anything outside the fixed file set", async () => {
		const get = (p: string[]) => GET(new Request("http://localhost/api/fork-slides/x"), { params: Promise.resolve({ path: p }) });
		fs.mkdirSync(path.join(path.dirname(SETTINGS_FILE)), { recursive: true });
		fs.writeFileSync(path.join(path.dirname(SETTINGS_FILE), "secret.svg"), "<svg/>");
		for (const p of [
			["..", "secret.svg"],
			["job_x", "..", "secret.svg"],
			["job_x", "../secret.svg"],
			["job_x", "..%2Fsecret.svg"],
			["job_..", "stage.svg"],
			["job_x/..", "stage.svg"],
			["../job_x", "stage.svg"],
			["job_x", "states.json"],
			["job_x", "stage.svg.bak"],
			["job_x", "frame-1-1.svg"],
			["job_x", ".stage.svg"],
			["job_x"],
			["job_x", "stage.svg", "extra"],
			["job_missing0", "stage.svg"],
			["job_missing0", "deck.html"],
		]) {
			assert.equal((await get(p)).status, 404, p.join("/"));
		}
	});
});

// ─── 6. the card ───────────────────────────────────────────────────────────

describe("slides: the card (fork)", () => {
	const deck = {
		version: 1 as const,
		jobId: "job_card",
		kind: "deck" as const,
		stage: "stage.svg",
		slides: [
			{ steps: [{ say: "One.", frame: "frame-01-1.svg" }, { say: "Two.", frame: "frame-01-2.svg" }] },
			{ steps: [{ say: "Three.", frame: "frame-02-1.svg" }] },
		],
	};

	it("◀/▶ move by slide to its first step; Space and clicks advance one build step", () => {
		assert.deepEqual(nextBuildStep(deck, { slide: 0, step: 0 }), { slide: 0, step: 1 });
		assert.deepEqual(nextBuildStep(deck, { slide: 0, step: 1 }), { slide: 1, step: 0 });
		assert.deepEqual(nextBuildStep(deck, { slide: 1, step: 0 }), { slide: 1, step: 0 }, "stays at the end");
		assert.deepEqual(moveSlide(deck, { slide: 0, step: 1 }, 1), { slide: 1, step: 0 });
		assert.deepEqual(moveSlide(deck, { slide: 1, step: 0 }, -1), { slide: 0, step: 0 });
		assert.deepEqual(moveSlide(deck, { slide: 0, step: 1 }, -1), { slide: 0, step: 0 });
		assert.deepEqual(deckKey(deck, { slide: 0, step: 0 }, "ArrowRight"), { slide: 1, step: 0 });
		assert.deepEqual(deckKey(deck, { slide: 0, step: 0 }, " "), { slide: 0, step: 1 });
		assert.equal(deckKey(deck, { slide: 0, step: 0 }, "a"), null);
	});

	it("renders the frame area, the slide's transcript with the current step emphasised, and the controls", () => {
		const html = renderToStaticMarkup(h(ForkSlidesCard, { result: { title: "Deck", html: "slides", tested: true, forkSlides: deck } }));
		assert.match(html, /data-testid="fork-slides-frame"/);
		assert.match(html, /<span class="font-medium text-foreground">One\.<\/span><span> Two\.<\/span>/);
		assert.match(html, /1 \/ 2/);
		for (const id of ["fork-slides-prev", "fork-slides-next", "fork-slides-download-frame", "fork-slides-download-deck"]) assert.match(html, new RegExp(`data-testid="${id}"`));
		assert.match(html, /role="switch"/, "the invert toggle");
		assert.match(html, /tabindex="0"/, "focusable for arrow keys");
	});
});

// ─── 7. hooks in upstream files, settings switch, prompt ────────────────────

describe("slides: hooks (fork)", () => {
	const stub = {} as never;

	it("the teacher registry has slides; the prober's does not", () => {
		const teacher = createTeacherTools({ chatId: "h", chatStore: stub, jobStore: stub, spawn: () => {} });
		assert.ok(teacher.slides);
		assert.equal(teacher.slides!.name, "slides");
		assert.equal(createTeacherTools({ chatId: "h", chatStore: stub, jobStore: stub, spawn: () => {} }, { slides: false }).slides, undefined, "the toggle drops it");
		const prober = createProberTools({ chatId: "h", jobStore: stub, spawn: () => {} } as never);
		assert.equal(prober.slides, undefined);
	});

	it("the tool part renders the demo dispatch card, or a quiet line for a received subject part", () => {
		assert.equal(artifactRenderers.slides, ForkSlidesDispatchCard);
		const part = (output: unknown) => ({ type: "tool-slides", state: "output-available", toolCallId: "t", output });
		const dispatched = renderToStaticMarkup(h(ForkSlidesDispatchCard, { part: part("Dispatched (job job_1). x") }));
		assert.equal(dispatched, renderToStaticMarkup(h(DemoCard, { part: part("Dispatched (job job_1). x") })), "upstream's card for a job");
		const received = renderToStaticMarkup(h(ForkSlidesDispatchCard, { part: part("Part 2 of 3 received; send the rest (still missing: part 3).") }));
		assert.match(received, /data-testid="fork-slides-part-received"/);
		assert.match(received, /part 2 of 3 received/);
	});

	it("the steer card picks the slides card for a slides result and the demo card otherwise", () => {
		const slides = buildSubagentSteer({ id: "j1", kind: "demo", toolCallId: "t1" }, {
			title: "Deck",
			html: "slides",
			tested: true,
			forkSlides: { version: 1, jobId: "job_x", kind: "deck", stage: "stage.svg", slides: [{ steps: [{ say: "Hi.", frame: "frame-01-1.svg" }] }] },
		} as never);
		assert.match(renderToStaticMarkup(h(SubagentSteerCard, { message: projectView([slides])[0] as never })), /fork-slides-card/);
		const demo = buildSubagentSteer({ id: "j2", kind: "demo", toolCallId: "t2" }, { title: "D", html: "<p>x</p>", tested: true });
		const demoHtml = renderToStaticMarkup(h(SubagentSteerCard, { message: projectView([demo])[0] as never }));
		assert.ok(!demoHtml.includes("fork-slides-card"));
		assert.match(demoHtml, /demo-iframe/);
	});

	// Replaces the skipped upstream "TOGGLEABLE_TOOLS: the sub-agent dispatch
	// tools; quiz/ask/read stay off the list" (tests/question-tools.test.ts).
	it("TOGGLEABLE_TOOLS: the sub-agent dispatch tools plus slides; quiz/ask/read stay off the list", () => {
		assert.deepEqual(TOGGLEABLE_TOOLS, ["research", "demo", "visual", "pdf", "slides"]);
	});

	// Replaces the skipped upstream "renders the owner's FINAL tool list —
	// research, demo, visual, pdf" (tests/render-settings.test.tsx).
	it("renders the fork's tool list: research, demo, visual, pdf, slides", () => {
		assert.deepEqual([...TOGGLE_TOOLS], ["research", "demo", "visual", "pdf", "slides"]);
		const html = renderToStaticMarkup(h(AgentSection, { agent: undefined, models: undefined, graph: undefined, onSectionChange: () => {}, onModelsChange: () => {} } as never));
		for (const id of TOGGLE_TOOLS) assert.ok(html.includes(`data-testid="tool-row-${id}"`), id);
	});

	// Replaces the skipped upstream "demo and visual are SERVER-EXECUTED
	// dispatch tools with the contract schemas" (tests/demos.test.tsx).
	it("jobTools: demo, pdf, research, slides and visual are server-executed dispatch tools with their schemas", () => {
		const tools = jobTools({ chatId: "chat_registry", jobStore, spawn: () => {} });
		assert.deepEqual(Object.keys(tools).sort(), ["demo", "pdf", "research", "slides", "visual"]);
		for (const name of ["demo", "visual", "research", "pdf", "slides"]) assert.equal(typeof tools[name]!.execute, "function", name);
		assert.equal(Value.Check(demoInputSchema, { title: "T", brief: "b" }), true);
		assert.equal(Value.Check(demoInputSchema, { brief: "b" }), false);
		assert.equal(Value.Check(visualInputSchema, { brief: "b" }), true);
		assert.equal(Value.Check(visualInputSchema, {}), false);
		assert.equal(Value.Check(pdfInputSchema, { path: "/tmp/doc.pdf", question: "q" }), true);
		assert.equal(Value.Check(pdfInputSchema, { question: "q" }), false);
		assert.equal(Value.Check(pdfInputSchema, { path: "/tmp/doc.pdf" }), false);
		assert.equal(Value.Check(tools.slides!.parameters, script()), true);
		assert.equal(Value.Check(tools.slides!.parameters, script({ slides: [] })), false, "at least one slide");
		assert.equal(Value.Check(tools.slides!.parameters, script({ kind: "film" })), false);
	});

	// Replaces the skipped upstream "unknown keys are rejected with the
	// supported list (the quiz wedge never persists)" (tests/tool-toggles-bridge.test.ts).
	it("settings writes accept slides and reject unknown keys with the fork's supported list", () => {
		const parse = (tools: Record<string, boolean>) => parseAgentSettingsBody({ tools }) as { ok: true } | { ok: false; error: string };
		const r = parse({ quiz: false });
		assert.equal(r.ok, false);
		assert.match(!r.ok ? r.error : "", /unknown tool "quiz" \(supported: research, demo, visual, pdf, slides, explain\)/);
		const typo = parse({ reasearch: false });
		assert.match(!typo.ok ? typo.error : "", /unknown tool "reasearch"/);
		assert.equal(parse({ slides: false }).ok, true);
	});

	it("the StatQuest fragment composes into the teacher prompt only", () => {
		const teacher = composeInstructions("teacher");
		assert.match(teacher, /# Numbers you can follow — the StatQuest method/);
		assert.match(teacher, /## Slides — the picture carries the numbers/);
		assert.match(teacher, /The deck takes a few minutes to build\. Meanwhile, keep the learner working without explaining what the deck will show/);
		assert.doesNotMatch(teacher, /call `slides`, and end your turn/, "a short deck no longer ends the turn");
		assert.doesNotMatch(composeInstructions("prober"), /StatQuest method/);
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent", "prompts", "teacher", "36-statquest.md"), "utf-8");
		assert.ok(teacher.includes(source.trim()), "composed verbatim");
	});
});

// ─── 8. deck narration reaches the knowledge-graph extractor ────────────────

describe("slides: narration as teacher prose (fork)", () => {
	const args = {
		title: "Softplus at dosage 0",
		kind: "deck",
		stage: "s",
		slides: [
			{ steps: [{ say: "  Start with the weight. ", show: "x" }, { say: "Multiply by zero.", show: "y" }] },
			{ steps: [{ say: "Add the bias.", show: "z" }] },
		],
	};
	const NARRATION = "Softplus at dosage 0\n\nStart with the weight. Multiply by zero.\n\nAdd the bias.";
	const assistant = (id: string, callId: string, callArgs: unknown, stopReason = "toolUse", name = "slides") =>
		({
			role: "assistant",
			id,
			content: [{ type: "text", text: "Here is the setup." }, { type: "toolCall", id: callId, name, arguments: callArgs }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason,
			timestamp: 1,
		}) as never;
	const toolResult = (id: string, callId: string, isError: boolean) =>
		({ role: "toolResult", id, toolCallId: callId, toolName: "slides", content: [{ type: "text", text: isError ? "Invalid tool input" : "Dispatched (job job_1)." }], isError, timestamp: 2 }) as never;

	it("builds the title and each slide's spoken narration", () => {
		assert.equal(forkSlidesNarration({ type: "toolCall", name: "slides", arguments: args }), NARRATION);
		assert.equal(forkSlidesNarration({ type: "toolCall", name: "slides", arguments: { ...args, title: 7 } }), NARRATION.split("\n\n").slice(1).join("\n\n"), "no usable title → no title line");
	});

	it("partial or malformed arguments never throw and yield nothing", () => {
		for (const a of [undefined, null, "x", {}, { title: "T" }, { title: "T", slides: "x" }, { slides: [null, 1, { steps: "x" }, { steps: [null, { say: 3 }, { say: "  " }] }] }]) {
			assert.equal(forkSlidesNarration({ type: "toolCall", name: "slides", arguments: a }), undefined, JSON.stringify(a));
		}
		const getter = { get slides() { throw new Error("boom"); } };
		assert.equal(forkSlidesNarration({ type: "toolCall", name: "slides", arguments: getter }), undefined);
		assert.equal(forkSlidesNarration(null), undefined);
		assert.equal(forkSlidesNarration({ type: "text", text: "hi" }), undefined);
		assert.equal(
			forkSlidesNarration({ type: "toolCall", name: "slides", arguments: { title: "T", slides: [{ steps: [{ say: "Half a" }] }, { steps: [{ sa: "" }] }] } }),
			"T\n\nHalf a",
			"a streaming prefix yields what is there",
		);
	});

	const delivered = (callId: string) =>
		buildSubagentSteer({ id: `job_${callId}`, kind: "demo", toolCallId: callId }, {
			title: "Deck",
			html: "slides",
			tested: true,
			forkSlides: { version: 1, jobId: `job_${callId}`, kind: "deck", stage: "stage.svg", slides: [{ steps: [{ say: "x", frame: "frame-01-1.svg" }] }] },
		} as never) as never;

	it("once delivered, appears in messageViewLines with the TEACHER prefix and in teacherProseBlocks", () => {
		const messages = [assistant("m1", "c1", args), toolResult("r1", "c1", false), delivered("c1")];
		const failed = failedOutputCallIds(messages);
		assert.deepEqual(messageViewLines(messages[0]!, "m1", failed), ["TEACHER [m1] Here is the setup.", `TEACHER [m1] ${NARRATION}`]);
		assert.deepEqual(teacherProseBlocks(messages), ["Here is the setup.", NARRATION]);
		const md = sessionMarkdown(messages, { title: "S" });
		assert.ok(md.includes(`### Teacher · m1\n\n${NARRATION}`), md);
	});

	it("a dispatch-rejected call is excluded from coverage and markdown", () => {
		const messages = [assistant("m1", "c1", args), toolResult("r1", "c1", true)];
		assert.deepEqual(teacherProseBlocks(messages), ["Here is the setup."]);
		assert.deepEqual(messageViewLines(messages[0]!, "m1", failedOutputCallIds(messages)), ["TEACHER [m1] Here is the setup."]);
		assert.ok(!sessionMarkdown(messages).includes("Multiply by zero"));
	});

	it("a call in an aborted or errored assistant message is excluded", () => {
		for (const stop of ["aborted", "error"]) {
			const messages = [assistant("m1", "c1", args, stop), delivered("c1")];
			assert.deepEqual(teacherProseBlocks(messages), ["Here is the setup."], stop);
			assert.deepEqual(messageViewLines(messages[0]!, "m1"), ["TEACHER [m1] Here is the setup."], stop);
			assert.ok(!sessionMarkdown(messages).includes("Multiply by zero"), stop);
		}
	});

	it("other tool calls stay invisible", () => {
		const messages = [assistant("m1", "c1", { title: "Demo", brief: "say: hello", slides: args.slides }, "toolUse", "demo")];
		assert.deepEqual(teacherProseBlocks(messages), ["Here is the setup."]);
		assert.ok(!sessionMarkdown(messages).includes("Multiply by zero"));
	});
});
