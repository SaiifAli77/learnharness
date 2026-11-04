/**
 * Fork-only: the model's view of delivered slides calls (FORK.md "StatQuest
 * method and slide decks"). A slides call carries the whole script (stage,
 * show, pointer, numbers with expressions, say), and history is resent every
 * turn. Once a call is delivered (a drawn slides result arrived; for a
 * subject video, every part call once the video arrived, a missing part
 * too), the model sees its arguments reduced to the title, kind, the
 * node/part fields, the stage (so a later `continues` deck can name the same
 * parts and colours) and the narration per slide, plus a note that the rest
 * was trimmed. Calls still building, rejected, failed, aborted or never
 * delivered keep their full arguments, so the teacher can fix and resend.
 *
 * Runs in front of upstream's toLlmMessages (one hook line in
 * teacher-agent.ts's convertToLlm). The persisted record is never touched:
 * the card, the extractor and the export read the full call. The latest
 * assistant message and every non-slides block (thinking and its
 * signature included) pass through as the same objects.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { forkSlidesDelivered } from "../../core/fork-slides.ts";

export const SLIMMED_NOTE = "Delivered; the per-step show, pointer and numbers were trimmed from this history after delivery.";

/** A delivered call's arguments as the model sees them. Tolerates malformed arguments. */
export function slimSlidesArguments(args: unknown): Record<string, unknown> {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const out: Record<string, unknown> = { title: a.title, kind: a.kind };
	for (const key of ["nodeId", "part", "of", "minutes", "stage"]) if (a[key] !== undefined) out[key] = a[key];
	const slides = Array.isArray(a.slides) ? a.slides : [];
	out.narration = slides.map((slide) => {
		const steps = slide && typeof slide === "object" ? (slide as { steps?: unknown }).steps : undefined;
		return Array.isArray(steps)
			? steps.map((step) => (step && typeof step === "object" ? (step as { say?: unknown }).say : undefined)).filter((say): say is string => typeof say === "string").join(" ")
			: "";
	});
	out.trimmed = SLIMMED_NOTE;
	return out;
}

/** The history with every delivered slides call slimmed (a new array only when something changed). */
export function forkSlimDeliveredSlides(messages: AgentMessage[]): AgentMessage[] {
	const { slim } = forkSlidesDelivered(messages);
	if (slim.size === 0) return messages;
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role?: string }).role === "assistant") {
			last = i;
			break;
		}
	}
	let out: AgentMessage[] | null = null;
	for (let i = 0; i < last; i++) {
		const message = messages[i] as AgentMessage & { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const content = message.content as Array<{ type?: string; name?: string; id?: string; arguments?: unknown }>;
		if (!content.some((b) => b.type === "toolCall" && b.name === "slides" && slim.has(b.id ?? ""))) continue;
		out ??= messages.slice();
		out[i] = {
			...message,
			content: content.map((b) => (b.type === "toolCall" && b.name === "slides" && slim.has(b.id ?? "") ? { ...b, arguments: slimSlidesArguments(b.arguments) } : b)),
		} as AgentMessage;
	}
	return out ?? messages;
}
