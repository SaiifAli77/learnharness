/**
 * Fork-only: the slides deck contract (see FORK.md "StatQuest method and
 * slide decks"). Pure types and helpers, safe on server and client.
 *
 * A slides call runs as an upstream job of kind "demo" (owner's choice: no
 * new JobKind). Its saved input carries FORK_SLIDES_MARKER, and its result
 * is a DemoResult with a `forkSlides` field holding only references and the
 * script text. Frame SVGs live on disk (src/agent/fork-slides/storage.ts)
 * and are served by app/api/fork-slides/[...path]/route.ts.
 */
import type { DemoResult } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";

export interface ForkSlidesNumber {
	/** As displayed, e.g. "2.25"; its decimal count sets the rounding. */
	value: string;
	/** The expression it comes from, e.g. "log(1+exp(0*-34.4+2.14))". */
	expr: string;
}

export interface ForkSlidesStepInput {
	say: string;
	show: string;
	pointer?: string;
	numbers?: ForkSlidesNumber[];
}

/** The teacher's `slides` call, exactly as the tool schema takes it. */
export interface ForkSlidesInput {
	title: string;
	kind: "deck" | "video";
	continues?: string;
	stage: string;
	slides: { steps: ForkSlidesStepInput[] }[];
}

/** The key that marks a demo job's saved input as a slides job. */
export const FORK_SLIDES_MARKER = "forkSlides";

/** The saved job input: the call plus the marker. */
export type ForkSlidesJobInput = ForkSlidesInput & { [FORK_SLIDES_MARKER]: true };

/** One build step as stored in the result: its narration and its frame file. */
export interface ForkSlidesStep {
	say: string;
	frame: string;
}

/** The deck as the result keeps it: references plus the script text. */
export interface ForkSlidesDeck {
	version: 1;
	jobId: string;
	kind: "deck" | "video";
	/** The stage SVG's file name in the job's asset folder. */
	stage: string;
	slides: { steps: ForkSlidesStep[] }[];
}

/** A DemoResult-compatible slides result (html is a short placeholder;
 *  an empty html is the upstream demo failure shape). */
export interface ForkSlidesResult extends DemoResult {
	forkSlides: ForkSlidesDeck;
}

/** Placeholder for DemoResult.html (non-empty means success upstream). */
export const FORK_SLIDES_HTML_PLACEHOLDER = "slides";

export function isForkSlidesInput(input: unknown): input is ForkSlidesJobInput {
	return typeof input === "object" && input !== null && (input as Record<string, unknown>)[FORK_SLIDES_MARKER] === true;
}

export function isForkSlidesResult(result: unknown): result is ForkSlidesResult {
	if (typeof result !== "object" || result === null) return false;
	const deck = (result as { forkSlides?: unknown }).forkSlides as Partial<ForkSlidesDeck> | undefined;
	return typeof deck === "object" && deck !== null && deck.version === 1 && Array.isArray(deck.slides) && typeof deck.jobId === "string";
}

/** Frame file name for a 1-based slide/step, e.g. frame-03-2.svg. */
export function frameFileName(slide: number, step: number): string {
	return `frame-${String(slide).padStart(2, "0")}-${step}.svg`;
}

export const FORK_SLIDES_STAGE_FILE = "stage.svg";
export const FORK_SLIDES_DECK_FILE = "deck.html";

/** Asset names the route may serve (everything else is a 404). */
export const FORK_SLIDES_FILE_RE = /^(?:stage|frame-\d{2}-[1-9])\.svg$/;
/** Job ids the route accepts: the job store's own id alphabet, no dots or slashes. */
export const FORK_SLIDES_JOB_ID_RE = /^job_[A-Za-z0-9_-]{1,60}$/;

/** The served URL of one asset. */
export function forkSlidesAssetUrl(jobId: string, file: string): string {
	return `/api/fork-slides/${encodeURIComponent(jobId)}/${encodeURIComponent(file)}`;
}

/** The flat list of build steps in deck order (slide index, step index, both 0-based). */
export function forkSlidesFlatSteps(deck: ForkSlidesDeck): Array<{ slide: number; step: number; say: string; frame: string }> {
	const out: Array<{ slide: number; step: number; say: string; frame: string }> = [];
	deck.slides.forEach((s, slide) => s.steps.forEach((st, step) => out.push({ slide, step, say: st.say, frame: st.frame })));
	return out;
}

// ─── deck narration as teacher prose (the knowledge-graph extractor) ────────

/** The teacher prose of a `slides` call: its title, then each slide's spoken
 *  narration (the steps' `say`, joined with spaces), slides separated by a
 *  blank line. Tolerates partial (streaming) and malformed arguments; never
 *  throws. undefined for any other block or a call with no `say` text.
 *  Hooked into upstream's userFacingTextOf, so coverage/extraction and the
 *  session Markdown read what the deck taught. */
export function forkSlidesNarration(block: unknown): string | undefined {
	try {
		if (!block || typeof block !== "object") return undefined;
		const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
		if (call.type !== "toolCall" || call.name !== "slides") return undefined;
		if (!call.arguments || typeof call.arguments !== "object") return undefined;
		const args = call.arguments as { title?: unknown; slides?: unknown };
		if (!Array.isArray(args.slides)) return undefined;
		const paragraphs: string[] = [];
		for (const slide of args.slides) {
			const steps = slide && typeof slide === "object" ? (slide as { steps?: unknown }).steps : undefined;
			if (!Array.isArray(steps)) continue;
			const says: string[] = [];
			for (const step of steps) {
				const say = step && typeof step === "object" ? (step as { say?: unknown }).say : undefined;
				if (typeof say === "string" && say.trim()) says.push(say.trim());
			}
			if (says.length) paragraphs.push(says.join(" "));
		}
		if (!paragraphs.length) return undefined;
		const title = typeof args.title === "string" ? args.title.trim() : "";
		return `${title ? `${title}\n\n` : ""}${paragraphs.join("\n\n")}`;
	} catch {
		return undefined;
	}
}

/** Add the ids of failed slides calls to upstream's failed-output set:
 *  a dispatch-rejected call (error toolResult) and any slides call in an
 *  errored/aborted assistant message, mirroring the send_to_user rules in
 *  failedOutputCallIds. Their narration was never delivered. */
export function forkSlidesFailedCalls(messages: readonly LhMessage[], failed: Set<string>): void {
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === "slides" && message.isError) {
			failed.add(message.toolCallId);
		} else if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "slides") failed.add(block.id);
			}
		}
	}
}
