/**
 * Fork-only: which errored tool calls the transcript hides instead of
 * showing upstream's "Retrying…" line (FORK.md "StatQuest method and slide
 * decks"). A rejected `slides` call (the script fails a check and the teacher
 * fixes it) and a quiz/explain call rejected by the node-video gate (the
 * teacher builds the named videos and re-poses the question) are expected
 * steps, not a struggling teacher. Display only: the error stays in the
 * record and in the model's context. An aborted call ("Operation aborted")
 * renders as upstream renders it, and every other errored tool keeps
 * upstream's line.
 *
 * Each hidden retry is its own model step, so its `step-start` would still
 * draw a separator hairline: forkHiddenStep hides a step-start whose step
 * holds only hidden tool errors.
 *
 * Hooked into components/chat.tsx with one import, one line just above
 * upstream's "Retrying…" branch and one line in its `step-start` case.
 */
/* eslint-disable import/no-restricted-paths */
import { NODE_VIDEO_GATE_MARKER } from "@/src/core/fork-slides";
/* eslint-enable import/no-restricted-paths */

type PartLike = { type: string; state?: unknown; errorText?: unknown };

export function forkHiddenToolError(part: PartLike): boolean {
	if (part.state !== "output-error" || part.errorText === "Operation aborted") return false;
	if (part.type === "tool-slides") return true;
	return (part.type === "tool-quiz" || part.type === "tool-explain") && typeof part.errorText === "string" && part.errorText.includes(NODE_VIDEO_GATE_MARKER);
}

/** True when parts[pi] is a step-start and every part of its step (up to
 *  the next step-start or the end, at least one) is hidden by forkHiddenToolError. */
export function forkHiddenStep(parts: readonly PartLike[], pi: number): boolean {
	if (parts[pi]?.type !== "step-start") return false;
	let hidden = 0;
	for (let i = pi + 1; i < parts.length && parts[i]!.type !== "step-start"; i++) {
		if (!forkHiddenToolError(parts[i]!)) return false;
		hidden++;
	}
	return hidden > 0;
}
