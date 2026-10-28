import type { AgentMessage, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, nativeInputCause } from "../core/native-messages.ts";

/**
 * Claude delivery hardening (fork): on Claude, prose written right before a
 * tool call can come back as a hidden progress-update thinking block, so the
 * teacher's explanation before a question never reaches the learner. The
 * `send_to_user` tool is the visible channel; this file makes models actually
 * use it — a system-prompt rule plus a one-shot guard on question calls.
 * Everything here is gated by ONE predicate, shared with the tool's inclusion.
 */

/** The agents that get `send_to_user` (and so the rule and the guard):
 *  explicit test registries stay caller-owned, and the match is on Claude
 *  across providers (including OpenRouter), not the API transport. */
export function usesSendToUser(modelId: string, explicitTools: unknown): boolean {
	return explicitTools === undefined && modelId.toLowerCase().includes("claude");
}

export const DELIVERY_NUDGE =
	"Delivery rule: ordinary response text does not reach the learner. Everything the learner should read — explanations, feedback, corrections — MUST go through `send_to_user`. Before every question tool call, send the explanation it belongs to with `send_to_user` first.";

/** Appended last so the composed prompt stays deterministic (cacheable). */
export function withDeliveryNudge(systemPrompt: string): string {
	return `${systemPrompt}\n\n${DELIVERY_NUDGE}`;
}

export const BOUNCE_TEXT =
	"Your explanation didn't reach the learner: ordinary response text is hidden from them. Send it with `send_to_user`, then call this question tool again.";

const isQuestionTool = (name: string) => (QUESTION_TOOLS as readonly string[]).includes(name);

function textOf(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/**
 * beforeToolCall hook: bounce a question call (as an error tool result, the
 * same path as an invalid quiz) when the model left a hidden thinking note
 * and nothing visible has reached the learner since the learner last spoke.
 * Stateless — derived from the transcript, so it also holds across rebuilt
 * agents and the local-agent bridge. At most one bounce per window: a prior
 * bounce result in the window lets the next attempt through.
 *
 * "The learner last spoke" = the latest native learner input: a user message
 * or a question tool's real answer (the answer arrives as that call's
 * toolResult, details set — see nativeInputCause).
 */
export async function deliveryGuard(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
	const { toolCall } = context;
	if (!isQuestionTool(toolCall.name)) return undefined;
	if (!context.context.tools?.some((t) => t.name === SEND_TO_USER_TOOL)) return undefined;
	// (a) A non-empty hidden note in the message that holds the question.
	if (!context.assistantMessage.content.some((b) => b.type === "thinking" && b.thinking.trim() !== "")) return undefined;
	const messages = context.context.messages;
	let boundary = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (nativeInputCause(messages[i]!, messages.slice(0, i)) === "learner") { boundary = i; break; }
	}
	const window = messages.slice(boundary + 1);
	const failed = new Set<string>();
	for (const m of window) {
		if (m.role !== "toolResult") continue;
		// (c) Already bounced once in this window.
		if (m.isError && isQuestionTool(m.toolName) && textOf(m) === BOUNCE_TEXT) return undefined;
		if (m.isError) failed.add(m.toolCallId);
	}
	// (b) Anything visible since: ordinary text, or a send_to_user that did
	// not error. Calls earlier in this very batch have no result yet and count.
	for (const m of window) {
		if (m.role !== "assistant") continue;
		const own = m.content.some((b) => b.type === "toolCall" && b.id === toolCall.id);
		for (const b of m.content) {
			if (own && b.type === "toolCall" && b.id === toolCall.id) break;
			if (b.type === "text" && b.text.trim() !== "") return undefined;
			if (b.type === "toolCall" && b.name === SEND_TO_USER_TOOL && !failed.has(b.id)) return undefined;
		}
	}
	return { block: true, reason: BOUNCE_TEXT };
}
