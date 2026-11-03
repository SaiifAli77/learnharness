import type { AgentMessage, BeforeToolCallContext, BeforeToolCallResult, ToolCallHooks } from "@earendil-works/pi-agent-core";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, nativeInputCause } from "../core/native-messages.ts";
import { isNarrationBlock, NARRATION_BLOCK_REASON, SEND_TO_USER_DELIVERY_RULE } from "./narration-guard.ts";

/**
 * Claude delivery hardening (fork): on Claude, prose written right before a
 * tool call can come back as a hidden progress-update thinking block, so the
 * teacher's explanation before a question never reaches the learner. The
 * `send_to_user` tool is the visible channel; this file makes models actually
 * use it — an opening system-prompt section, a closing rule where upstream
 * has none, and a one-shot guard on question calls. teacher-agent.ts gates
 * every hook with upstream's own predicate (sendToUserApplies), so they apply
 * exactly where upstream gives the agent `send_to_user`.
 */

export const DELIVERY_NUDGE =
	"Delivery rule: ordinary response text does not reach the learner. Everything the learner should read — explanations, feedback, corrections — MUST go through `send_to_user`. Before every question tool call, send the explanation it belongs to with `send_to_user` first.";

/** Leads the prompt: the upstream body repeatedly says to write prose before a
 *  check, and the closing rule alone did not hold for Sonnet 5.5. */
export const DELIVERY_PREAMBLE =
	"# How your words reach the learner\n\nIn this session, ordinary response text never reaches the learner: anything you write outside a tool call is hidden from him. His one visible channel is the `send_to_user` tool.\n\nSo wherever these instructions say to write, explain, teach \"in prose\", resolve a prediction, or put teaching \"above the check\" or \"in the transcript\", that means: put it in a `send_to_user` call. A turn that teaches and then asks is one message with:\n\n1. `send_to_user` with the full explanation (markdown, LaTeX, diagrams as usual);\n2. then the question tool.\n\nNever write the explanation as ordinary text first: he would get a question with no teaching before it.";

/** The preamble leads and the rule closes; both are fixed text, so the
 *  composed prompt stays deterministic (cacheable). */
export function withDeliveryNudge(systemPrompt: string): string {
	return `${DELIVERY_PREAMBLE}\n\n${systemPrompt}\n\n${DELIVERY_NUDGE}`;
}

export const BOUNCE_TEXT =
	"Your explanation didn't reach the learner: ordinary response text is hidden from them. Send it with `send_to_user`, then call this question tool again.";

const isQuestionTool = (name: string) => (QUESTION_TOOLS as readonly string[]).includes(name);

function textOf(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** Whether a thinking signature marks narration (upstream's isNarrationBlock).
 *  On OpenAI-compatible APIs (OpenRouter) pi-ai stores the signature as the
 *  reasoning field's name ("reasoning": signed, not narration) or as the JSON
 *  of `reasoning_details` (an array, or one legacy object), whose entries may
 *  carry the provider's own signature: narration if any of them is. */
function narrationSigned(signature: string): boolean {
	if (!/^[[{]/.test(signature)) return isNarrationBlock({ type: "thinking", thinkingSignature: signature });
	try {
		const parsed: unknown = JSON.parse(signature);
		return (Array.isArray(parsed) ? parsed : [parsed]).some(
			(d) => typeof (d as { signature?: unknown } | null)?.signature === "string" && isNarrationBlock({ type: "thinking", thinkingSignature: (d as { signature: string }).signature }),
		);
	} catch {
		return false;
	}
}

/** A thinking block that may hide the explanation: one with no signature
 *  (the Claude Code/Antigravity bridge, where upstream's guard can't tell)
 *  and non-empty text, or one whose signature marks it as narration
 *  (narrationSigned). Plain signed thinking is real reasoning. */
function hidesProse(block: { type: string; thinking?: string; thinkingSignature?: string }): boolean {
	if (block.type !== "thinking") return false;
	if (block.thinkingSignature) return narrationSigned(block.thinkingSignature);
	return (block.thinking ?? "").trim() !== "";
}

/**
 * beforeToolCall hook: bounce a question call (as an error tool result, the
 * same path as an invalid quiz) when the model left a hidden note (see
 * hidesProse) and nothing visible has reached the learner since the learner
 * last spoke. Stateless — derived from the transcript, so it also holds
 * across rebuilt agents and the local-agent bridge. At most one bounce per
 * window: a prior bounce in the window, the fork's or upstream's narration
 * guard's, lets the next attempt through.
 *
 * "The learner last spoke" = the latest native learner input: a user message
 * or a question tool's real answer (the answer arrives as that call's
 * toolResult, details set — see nativeInputCause).
 */
export async function deliveryGuard(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
	const { toolCall } = context;
	if (!isQuestionTool(toolCall.name)) return undefined;
	if (!context.context.tools?.some((t) => t.name === SEND_TO_USER_TOOL)) return undefined;
	// (a) A hidden note in the message that holds the question.
	if (!context.assistantMessage.content.some(hidesProse)) return undefined;
	const messages = context.context.messages;
	let boundary = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (nativeInputCause(messages[i]!, messages.slice(0, i)) === "learner") { boundary = i; break; }
	}
	const window = messages.slice(boundary + 1);
	const failed = new Set<string>();
	for (const m of window) {
		if (m.role !== "toolResult") continue;
		// (c) Already bounced once in this window (by this guard or upstream's).
		if (m.isError && isQuestionTool(m.toolName) && [BOUNCE_TEXT, NARRATION_BLOCK_REASON].includes(textOf(m))) return undefined;
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

/** teacher-agent.ts hook: when send_to_user applies, lead with the preamble.
 *  The closing rule is added only where upstream's own delivery rule is not
 *  already appended: upstream closes the teacher prompt with
 *  SEND_TO_USER_DELIVERY_RULE (when narrationGuardApplies), which replaces the
 *  fork's nudge there; the prober has no upstream rule and keeps the nudge. */
export function forkDeliveryPrompt(applies: boolean, systemPrompt: string): string {
	if (!applies) return systemPrompt;
	if (systemPrompt.endsWith(SEND_TO_USER_DELIVERY_RULE)) return `${DELIVERY_PREAMBLE}\n\n${systemPrompt}`;
	return withDeliveryNudge(systemPrompt);
}

/** teacher-agent.ts hook: keep upstream's tool-call hooks (its narration
 *  guard) and add the fork's deliveryGuard after them. Upstream's guard runs
 *  first; when it lets a question through, the fork's guard decides. The
 *  fork's guard stays (owner, v0.5.0) because upstream's only fires on
 *  thinking whose signature marks it as narration, and the Claude Code bridge
 *  (src/agent/local-agents/run.ts) emits thinking blocks with no signature:
 *  there upstream's guard is inert, so the fork's guard bounces an unsigned
 *  thinking question once. On API connections plain signed thinking passes, as
 *  upstream intends; after upstream's guard has bounced, the fork stands down. */
export function withForkDeliveryGuard(applies: boolean, hooks: ToolCallHooks): ToolCallHooks {
	if (!applies) return hooks;
	const upstream = hooks.beforeToolCall;
	return {
		...hooks,
		beforeToolCall: async (context, signal) => (await upstream?.(context, signal)) ?? deliveryGuard(context),
	};
}
