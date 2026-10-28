/**
 * Claude delivery hardening (fork): on Claude, prose written right before a
 * tool call can come back as a hidden progress-update thinking block, so the
 * teacher's explanation before a question never reaches the learner. The
 * `send_to_user` tool is the visible channel; this file makes models actually
 * use it — a system-prompt rule (and, separately, a guard on question calls).
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
