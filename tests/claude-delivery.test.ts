/** Claude delivery hardening: the system-prompt rule and the one-shot guard on
 * question calls. Closed-network synthetic fixtures only. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-delivery-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
};
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { BOUNCE_TEXT, DELIVERY_NUDGE, DELIVERY_PREAMBLE, deliveryGuard, forkDeliveryPrompt, withDeliveryNudge, withForkDeliveryGuard } = await import("../src/agent/claude-delivery.ts");
const { createProberAgent, createTeacherAgent, createPracticeAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { SEND_TO_USER_TOOL } = await import("../src/core/native-messages.ts");
const { NARRATION_BLOCK_REASON, SEND_TO_USER_DELIVERY_RULE } = await import("../src/agent/narration-guard.ts");
const { sendToUserTool } = await import("../src/agent/tools/send-to-user.ts");
const { projectView } = await import("../src/core/view.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

function scripted(provider: string, id: string, steps: FauxResponseStep[] = []) {
	const faux = createFauxCore({ provider, models: [{ id }] });
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, faux };
}

const chatId = chatStore.createChat("Synthetic delivery guard").id;
const factories = {
	prober: (opts: Parameters<typeof createTeacherAgent>[1]) => createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, opts),
	teacher: (opts: Parameters<typeof createTeacherAgent>[1]) => createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, opts),
	practice: (opts: Parameters<typeof createTeacherAgent>[1]) => createPracticeAgent({ chatId, chatStore }, opts),
};

const quizArgs = {
	type: "check", nodeId: "synthetic", question: "What is two plus two?",
	options: [{ label: "Four", value: "4" }, { label: "Five", value: "5" }],
	correctAnswer: "4", explanation: "Add two pairs.",
};
const sendCall = (id = "send-1") => ({ type: "toolCall" as const, id, name: SEND_TO_USER_TOOL, arguments: { message: "An explanation." } });
const quizCall = (id = "quiz-1", name = "quiz") => ({ type: "toolCall" as const, id, name, arguments: quizArgs });
let seq = 0;
function assistant(content: unknown[]): LhMessage {
	return { ...fauxAssistantMessage(""), content, id: `a${++seq}` } as LhMessage;
}
function user(text = "Teach me."): LhMessage {
	return { id: `u${++seq}`, role: "user", content: text, timestamp: 1 } as LhMessage;
}
function result(callId: string, toolName: string, text: string, isError = false, details: unknown = null): LhMessage {
	return {
		id: `r${++seq}`, role: "toolResult", toolCallId: callId, toolName,
		content: [{ type: "text", text }], details, isError, timestamp: 1,
	} as LhMessage;
}
const ack = (callId = "send-1", isError = false) => result(callId, SEND_TO_USER_TOOL, isError ? "Invalid tool input" : "Message received for display.", isError);
const bounce = (callId = "quiz-1", name = "quiz") => result(callId, name, BOUNCE_TEXT, true);
function answer(callId = "quiz-1", toolName = "quiz") {
	return result(callId, toolName, "Learner answered.", false, {
		kind: "quiz", questionText: "What is two plus two?", dontKnow: false, answers: ["4"], answeredAt: "2026-01-01T00:00:00.000Z",
	});
}

/** Ask the guard about `messages`' LAST assistant message's question call. */
async function guard(messages: LhMessage[], { call = "quiz-1", tools = [SEND_TO_USER_TOOL] } = {}) {
	const assistantMessage = [...messages].reverse().find((m) => m.role === "assistant") as never as BeforeToolCallContext["assistantMessage"];
	const toolCall = assistantMessage.content.find((b) => b.type === "toolCall" && b.id === call) as BeforeToolCallContext["toolCall"];
	return deliveryGuard({
		assistantMessage, toolCall, args: toolCall.arguments,
		context: { systemPrompt: "", messages, tools: tools.map((name) => ({ name })) } as never,
	});
}
/** Bridge thinking (Claude Code/Antigravity): no signature. */
const note = () => fauxThinking("Here is the explanation I meant to say.");
/** API thinking: plain reasoning, signed. */
const signedNote = () => ({ ...fauxThinking("Plain internal reasoning."), thinkingSignature: Buffer.from("synthetic-header:reasoning:payload").toString("base64") });
/** API thinking whose signature marks it as narration (upstream's isNarrationBlock). */
const narrationNote = () => ({ ...fauxThinking("Narration summary."), thinkingSignature: Buffer.from("synthetic-header:narration:payload").toString("base64") });

/** The Claude prompt per agent since upstream v0.5.0: upstream gives
 *  send_to_user to the prober and teacher only (practice uses ordinary prose)
 *  and closes the teacher prompt with its own delivery rule, which replaces the
 *  fork's closing nudge there. The fork's preamble leads both; the prober,
 *  with no upstream rule, keeps the nudge. */
function claudePrompt(kind: keyof typeof factories): string {
	const base = composeInstructions(kind);
	if (kind === "practice") return base;
	if (kind === "teacher") return `${DELIVERY_PREAMBLE}\n\n${base}\n\n---\n\n${SEND_TO_USER_DELIVERY_RULE}`;
	return `${DELIVERY_PREAMBLE}\n\n${base}\n\n${DELIVERY_NUDGE}`;
}

describe("delivery rule in the system prompt", () => {
	it("Claude teacher: the preamble, then upstream's composition with its own delivery rule, and no fork nudge", () => {
		const { engine } = scripted("anthropic", "claude-opus-5-5");
		const prompt = factories.teacher({ engine }).state.systemPrompt;
		assert.equal(prompt, `${DELIVERY_PREAMBLE}\n\n${composeInstructions("teacher")}\n\n---\n\n${SEND_TO_USER_DELIVERY_RULE}`);
		assert.equal(prompt.split(DELIVERY_PREAMBLE).length - 1, 1);
		assert.equal(prompt.split(SEND_TO_USER_DELIVERY_RULE).length - 1, 1);
		assert.ok(!prompt.includes(DELIVERY_NUDGE), "upstream's teacher rule replaces the fork's closing nudge");
	});

	it("leads with the preamble and ends with the rule, each exactly once, for the prober on a Claude model", () => {
		const { engine } = scripted("anthropic", "claude-opus-5-5");
		for (const [kind, factory] of Object.entries(factories)) {
			const prompt = factory({ engine }).state.systemPrompt;
			assert.equal(prompt, claudePrompt(kind as keyof typeof factories), kind);
			if (kind !== "prober") continue;
			assert.equal(prompt, `${DELIVERY_PREAMBLE}\n\n${composeInstructions("prober")}\n\n${DELIVERY_NUDGE}`);
			assert.ok(prompt.startsWith("# How your words reach the learner\n\n"), kind);
			assert.equal(prompt.split(DELIVERY_PREAMBLE).length - 1, 1, kind);
			assert.equal(prompt.split(DELIVERY_NUDGE).length - 1, 1, kind);
			assert.ok(prompt.endsWith("`send_to_user` first."), kind);
			assert.ok(!prompt.includes(SEND_TO_USER_DELIVERY_RULE), "the prober has no upstream rule");
		}
		assert.equal(DELIVERY_PREAMBLE, "# How your words reach the learner\n\nIn this session, ordinary response text never reaches the learner: anything you write outside a tool call is hidden from him. His one visible channel is the `send_to_user` tool.\n\nSo wherever these instructions say to write, explain, teach \"in prose\", resolve a prediction, or put teaching \"above the check\" or \"in the transcript\", that means: put it in a `send_to_user` call. A turn that teaches and then asks is one message with:\n\n1. `send_to_user` with the full explanation (markdown, LaTeX, diagrams as usual);\n2. then the question tool.\n\nNever write the explanation as ordinary text first: he would get a question with no teaching before it.");
		assert.equal(DELIVERY_NUDGE, "Delivery rule: ordinary response text does not reach the learner. Everything the learner should read — explanations, feedback, corrections — MUST go through `send_to_user`. Before every question tool call, send the explanation it belongs to with `send_to_user` first.");
	});

	it("leaves non-Claude prompts byte-identical, and explicit registries too", () => {
		for (const [provider, id] of [["openai", "gpt-4o-mini"], ["openrouter", "z-ai/glm-5.3-flash"], ["anthropic", "opaque-alias"]] as const) {
			const { engine } = scripted(provider, id);
			for (const [kind, factory] of Object.entries(factories)) {
				assert.equal(factory({ engine }).state.systemPrompt, composeInstructions(kind as keyof typeof factories), `${id} ${kind}`);
			}
		}
		const { engine } = scripted("anthropic", "claude-opus-5-5");
		assert.equal(factories.teacher({ engine, tools: {} }).state.systemPrompt, composeInstructions("teacher"));
	});

	// Replaces upstream tests/send-to-user.test.ts's "includes" cases (skipped in
	// scripts/fork-test.mjs): same tool checks, but the prompt carries the rule.
	for (const [provider, id] of [
		["anthropic", "claude-opus-5-5"],
		["anthropic", "claude-haiku-4-5-20251001"],
		["openrouter", "anthropic/claude-opus-5.5"],
		["openrouter", "anthropic/claude-sonnet-5.5"],
		["amazon-bedrock", "us.anthropic.claude-opus-5-5-v1:0"],
		["fixture", "CLAUDE-fixture"],
	] as const) {
		it(`${provider}/${id}: send_to_user tool plus the delivery rule in the prober and teacher`, () => {
			const { engine } = scripted(provider, id);
			for (const [kind, factory] of Object.entries(factories)) {
				const agent = factory({ engine });
				const output = agent.state.tools.find((tool) => tool.name === SEND_TO_USER_TOOL);
				if (kind === "practice") {
					assert.equal(output, undefined, "upstream v0.5.0: practice has no output tool");
					assert.equal(agent.state.systemPrompt, composeInstructions("practice"));
					continue;
				}
				assert.ok(output, kind);
				assert.equal(output.description, sendToUserTool.description, kind);
				assert.equal(typeof output.prepareArguments, "function", "standard argument healing is wired");
				assert.equal(agent.state.systemPrompt, claudePrompt(kind as keyof typeof factories), kind);
			}
		});
	}

	it("the nudge wraps the prompt with the preamble and the rule", () => {
		assert.equal(withDeliveryNudge("X"), `${DELIVERY_PREAMBLE}\n\nX\n\n${DELIVERY_NUDGE}`);
	});
});

describe("hooks alongside upstream's narration guard (v0.5.0)", () => {
	it("wraps the prompt only when send_to_user applies; adds the nudge only without upstream's rule", () => {
		assert.equal(forkDeliveryPrompt(true, "X"), withDeliveryNudge("X"));
		assert.equal(forkDeliveryPrompt(false, "X"), "X");
		const upstream = `X\n\n---\n\n${SEND_TO_USER_DELIVERY_RULE}`;
		assert.equal(forkDeliveryPrompt(true, upstream), `${DELIVERY_PREAMBLE}\n\n${upstream}`);
		assert.equal(forkDeliveryPrompt(false, upstream), upstream);
	});

	it("keeps upstream's hooks, runs its beforeToolCall first, then the fork's guard", async () => {
		const after = async () => undefined;
		const off = { beforeToolCall: async () => undefined, afterToolCall: after };
		assert.equal(withForkDeliveryGuard(false, off), off, "untouched when send_to_user does not apply");
		const order: string[] = [];
		const upstreamBlocks = withForkDeliveryGuard(true, { beforeToolCall: async () => (order.push("upstream"), { block: true, reason: "upstream" }), afterToolCall: after });
		assert.equal(upstreamBlocks.afterToolCall, after, "upstream's afterToolCall is kept");
		const messages = [user(), assistant([note(), quizCall()])];
		const assistantMessage = messages[1] as never as BeforeToolCallContext["assistantMessage"];
		const toolCall = (messages[1] as { content: Array<{ type: string; id?: string }> }).content.find((b) => b.id === "quiz-1") as BeforeToolCallContext["toolCall"];
		const ctx = { assistantMessage, toolCall, args: {}, context: { systemPrompt: "", messages, tools: [{ name: SEND_TO_USER_TOOL }] } } as never;
		assert.deepEqual(await upstreamBlocks.beforeToolCall!(ctx), { block: true, reason: "upstream" });
		assert.deepEqual(order, ["upstream"]);
		const upstreamPasses = withForkDeliveryGuard(true, { beforeToolCall: async () => (order.push("upstream"), undefined) });
		assert.deepEqual(await upstreamPasses.beforeToolCall!(ctx), { block: true, reason: BOUNCE_TEXT }, "then the fork's guard decides");
		const noUpstream = withForkDeliveryGuard(true, {});
		assert.deepEqual(await noUpstream.beforeToolCall!(ctx), { block: true, reason: BOUNCE_TEXT }, "the prober has no upstream guard; the fork's still applies");
	});
});

describe("delivery guard decision", () => {
	it("bounces a thinking note + bare question with nothing visible since the learner spoke", async () => {
		const r = await guard([user(), assistant([note(), quizCall()])]);
		assert.deepEqual(r, { block: true, reason: BOUNCE_TEXT });
		assert.equal(BOUNCE_TEXT, "Your explanation didn't reach the learner: ordinary response text is hidden from them. Send it with `send_to_user`, then call this question tool again.");
	});

	it("bridge thinking (no signature) and narration-signed thinking bounce; plain signed thinking passes, as upstream intends", async () => {
		assert.deepEqual(await guard([user(), assistant([note(), quizCall()])]), { block: true, reason: BOUNCE_TEXT }, "bridge");
		assert.deepEqual(await guard([user(), assistant([narrationNote(), quizCall()])]), { block: true, reason: BOUNCE_TEXT }, "narration-signed");
		assert.equal(await guard([user(), assistant([signedNote(), quizCall()])]), undefined, "a legitimate question-only turn on the API");
		assert.equal((await guard([user(), assistant([{ ...note(), thinkingSignature: "" }, quizCall()])]))?.block, true, "an empty signature is no signature");
	});

	it("OpenRouter signatures: reasoning_details JSON is narration when an entry's signature is; a field name or other JSON is signed", async () => {
		const sig = (s: string) => ({ ...fauxThinking("Thinking via OpenRouter."), thinkingSignature: s });
		const narrationB64 = Buffer.from("synthetic-header:narration:payload").toString("base64");
		const plainB64 = Buffer.from("synthetic-header:reasoning:payload").toString("base64");
		const details = (signature: string) => JSON.stringify([{ type: "reasoning.text", text: "x", signature, format: "anthropic-claude-v1", index: 0 }]);
		assert.ok((await guard([user(), assistant([sig(details(narrationB64)), quizCall()])]))?.block, "a narration-signed reasoning_details entry");
		assert.ok((await guard([user(), assistant([sig(JSON.stringify({ type: "reasoning.text", text: "x", signature: narrationB64 })), quizCall()])]))?.block, "one legacy object");
		for (const signed of [details(plainB64), "reasoning", "reasoning_content", JSON.stringify({ type: "reasoning.encrypted", id: "r1", data: "opaque" }), "[not json"]) {
			assert.equal(await guard([user(), assistant([sig(signed), quizCall()])]), undefined, signed);
		}
	});

	it("stands down after upstream's narration guard has bounced in the window: never a second bounce", async () => {
		const first = assistant([narrationNote(), quizCall()]);
		const upstreamBounce = result("quiz-1", "quiz", NARRATION_BLOCK_REASON, true);
		assert.equal(await guard([user(), first, upstreamBounce, assistant([note(), quizCall("quiz-2")])], { call: "quiz-2" }), undefined);
	});

	it("bounces the mechanic variants and ask_user_question too", async () => {
		for (const name of ["explain", "ask_user_question", "probe", "recall"]) {
			assert.ok((await guard([user(), assistant([note(), quizCall("q", name)])], { call: "q" }))?.block, name);
		}
	});

	it("ignores non-question tools", async () => {
		const call = { type: "toolCall", id: "t", name: "web_search", arguments: {} };
		assert.equal(await guard([user(), assistant([note(), call])], { call: "t" }), undefined);
	});

	it("passes after a send_to_user earlier in the window (earlier message or earlier in the batch)", async () => {
		assert.equal(await guard([user(), assistant([sendCall()]), ack(), assistant([note(), quizCall()])]), undefined);
		assert.equal(await guard([user(), assistant([sendCall(), note(), quizCall()])]), undefined);
	});

	it("does not count a failed send_to_user, nor one after the question in the batch", async () => {
		assert.ok((await guard([user(), assistant([sendCall()]), ack("send-1", true), assistant([note(), quizCall()])]))?.block);
		assert.ok((await guard([user(), assistant([note(), quizCall(), sendCall()])]))?.block);
	});

	it("passes after non-empty ordinary text, but not blank text", async () => {
		assert.equal(await guard([user(), assistant([fauxText("Visible.")]), assistant([note(), quizCall()])]), undefined);
		assert.equal(await guard([user(), assistant([fauxText("Before."), note(), quizCall()])]), undefined);
		assert.ok((await guard([user(), assistant([fauxText("  \n"), note(), quizCall()])]))?.block);
	});

	it("passes without a non-empty thinking block in the question's message", async () => {
		assert.equal(await guard([user(), assistant([quizCall()])]), undefined);
		assert.equal(await guard([user(), assistant([fauxThinking("  "), quizCall()])]), undefined);
		// Thinking in an earlier message is not the evidence; the question's own message is.
		assert.equal(await guard([user(), assistant([note(), sendCall()]), ack(), assistant([quizCall()])]), undefined);
	});

	it("passes the second attempt after a bounce, never looping", async () => {
		const first = assistant([note(), quizCall()]);
		assert.ok((await guard([user(), first]))?.block);
		const second = assistant([note(), quizCall("quiz-2")]);
		assert.equal(await guard([user(), first, bounce(), second], { call: "quiz-2" }), undefined);
	});

	it("passes for an agent without send_to_user", async () => {
		assert.equal(await guard([user(), assistant([note(), quizCall()])], { tools: [] }), undefined);
	});

	it("a learner answer and a new user message each reset the window", async () => {
		// Visible output and a prior bounce belong to the previous window.
		const earlier = [user(), assistant([sendCall()]), ack(), assistant([note(), quizCall()]), bounce()];
		const afterAnswer = [...earlier, answer(), assistant([note(), quizCall("quiz-2")])];
		assert.ok((await guard(afterAnswer, { call: "quiz-2" }))?.block, "after the quiz answer");
		const afterUser = [...earlier, user("Next."), assistant([note(), quizCall("quiz-2")])];
		assert.ok((await guard(afterUser, { call: "quiz-2" }))?.block, "after a user message");
	});

	it("only a real answer resets: the posed placeholder, a dismissal and a bounce do not", async () => {
		const posed = result("quiz-1", "quiz", "Question posed", false, null);
		const dismissed = result("quiz-1", "quiz", "Dismissed", false, { dismissed: true });
		for (const neutral of [posed, dismissed]) {
			const messages = [user(), assistant([sendCall()]), ack(), assistant([quizCall()]), neutral, assistant([note(), quizCall("quiz-2")])];
			assert.equal(await guard(messages, { call: "quiz-2" }), undefined);
		}
	});
});

describe("delivery guard in the agent loop (offline)", () => {
	it("bounces once as an error result, then lets the retry through", async () => {
		const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
			fauxAssistantMessage([note(), fauxToolCall("quiz", quizArgs, { id: "quiz-1" })], { stopReason: "toolUse" }),
			(context) => {
				const last = context.messages.at(-1)!;
				assert.ok(last.role === "toolResult" && last.isError);
				assert.equal((last as { content: Array<{ text: string }> }).content[0]!.text, BOUNCE_TEXT);
				return fauxAssistantMessage([note(), fauxToolCall("quiz", quizArgs, { id: "quiz-2" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Premature continuation must not run."),
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("Teach me.");
		assert.equal(faux.state.callCount, 2, "the clean retry pose ends the run");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		assert.deepEqual(results.map((m) => m.isError), [true, false]);
	});

	it("on the API, a teacher question with plain signed thinking and no prose is posed at once", async () => {
		const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
			fauxAssistantMessage([signedNote(), fauxToolCall("quiz", quizArgs, { id: "quiz-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Premature continuation must not run."),
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("Teach me.");
		assert.equal(faux.state.callCount, 1);
		assert.deepEqual(agent.state.messages.filter((m) => m.role === "toolResult").map((m) => m.isError), [false]);
	});

	it("the prober bounces a plain-thinking question once too (upstream's guard is teacher-only)", async () => {
		const { type: _t, nodeId: _n, ...probeArgs } = quizArgs;
		const { engine, faux } = scripted("anthropic", "claude-opus-5-5", [
			fauxAssistantMessage([note(), fauxToolCall("probe", probeArgs, { id: "probe-1" })], { stopReason: "toolUse" }),
			(context) => {
				const last = context.messages.at(-1)!;
				assert.ok(last.role === "toolResult" && last.isError);
				assert.equal((last as { content: Array<{ text: string }> }).content[0]!.text, BOUNCE_TEXT);
				return fauxAssistantMessage([note(), fauxToolCall("probe", probeArgs, { id: "probe-2" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Premature continuation must not run."),
		]);
		const agent = factories.prober({ engine });
		await agent.prompt("Assess me.");
		assert.equal(faux.state.callCount, 2, "the clean retry pose ends the run");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		assert.deepEqual(results.map((m) => m.isError), [true, false]);
	});

	it("view: the bounced question is the retry error state and never mounts", async () => {
		const { engine } = scripted("anthropic", "claude-opus-5-5", [
			fauxAssistantMessage([note(), fauxToolCall("quiz", quizArgs, { id: "quiz-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Stop."),
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("Teach me.");
		const messages = agent.state.messages.map((m, i) => ({ ...m, id: `v${i}` })) as LhMessage[];
		const part = projectView(messages).flatMap((m) => m.parts).find((p) => p.type === "tool-quiz")!;
		assert.equal(part.state, "output-error");
		assert.equal(part.errorText, BOUNCE_TEXT);
		// Live, before the settled result lands, the clean-end mount gate stays closed on an errored execution.
		const live = projectView(messages.slice(0, 3), {
			inFlight: true, streamingIds: new Set(["v2"]),
			executions: new Map([["quiz-1", { isError: true, errorText: BOUNCE_TEXT }]]),
		}).flatMap((m) => m.parts).find((p) => p.type === "tool-quiz")!;
		assert.equal(live.state, "output-error");
	});

	it("a non-Claude agent never bounces", async () => {
		const { engine, faux } = scripted("openai", "gpt-4o-mini", [
			fauxAssistantMessage([note(), fauxToolCall("quiz", quizArgs, { id: "quiz-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Premature continuation must not run."),
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("Teach me.");
		assert.equal(faux.state.callCount, 1);
		assert.ok(agent.state.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError));
	});
});
