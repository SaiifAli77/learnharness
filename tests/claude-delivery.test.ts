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

const { BOUNCE_TEXT, DELIVERY_NUDGE, deliveryGuard, usesSendToUser, withDeliveryNudge } = await import("../src/agent/claude-delivery.ts");
const { createProberAgent, createTeacherAgent, createPracticeAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { SEND_TO_USER_TOOL } = await import("../src/core/native-messages.ts");
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
const note = () => fauxThinking("Here is the explanation I meant to say.");

describe("delivery rule in the system prompt", () => {
	it("is appended exactly once, last, for every agent on a Claude model", () => {
		const { engine } = scripted("anthropic", "claude-opus-5-5");
		for (const [kind, factory] of Object.entries(factories)) {
			const prompt = factory({ engine }).state.systemPrompt;
			const base = composeInstructions(kind as keyof typeof factories);
			assert.equal(prompt, `${base}\n\n${DELIVERY_NUDGE}`, kind);
			assert.equal(prompt.split(DELIVERY_NUDGE).length - 1, 1, kind);
			assert.ok(prompt.endsWith("`send_to_user` first."), kind);
		}
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

	it("shares one gate with the tool", () => {
		assert.equal(usesSendToUser("Anthropic/Claude-Opus", undefined), true);
		assert.equal(usesSendToUser("claude-opus-5-5", {}), false);
		assert.equal(usesSendToUser("gpt-4o", undefined), false);
		assert.equal(withDeliveryNudge("X"), `X\n\n${DELIVERY_NUDGE}`);
	});
});

describe("delivery guard decision", () => {
	it("bounces a thinking note + bare question with nothing visible since the learner spoke", async () => {
		const r = await guard([user(), assistant([note(), quizCall()])]);
		assert.deepEqual(r, { block: true, reason: BOUNCE_TEXT });
		assert.equal(BOUNCE_TEXT, "Your explanation didn't reach the learner: ordinary response text is hidden from them. Send it with `send_to_user`, then call this question tool again.");
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
