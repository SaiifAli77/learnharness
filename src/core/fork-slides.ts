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
	kind: "deck" | "video" | ForkSlidesPartsKind;
	continues?: string;
	/** kind "video": the plan node the video is for. */
	nodeId?: string;
	/** kind "subject" or "recap": this part's number (1-based), the part count, and the learner's length pick in minutes. */
	part?: number;
	of?: number;
	minutes?: number;
	stage: string;
	slides: { steps: ForkSlidesStepInput[] }[];
}

/** The kinds sent in parts and built as one video: the subject video and
 *  the recap video (this session retold). Each kind has its own collection. */
export type ForkSlidesPartsKind = "subject" | "recap";

export function isPartsKind(kind: unknown): kind is ForkSlidesPartsKind {
	return kind === "subject" || kind === "recap";
}

/** The most parts one subject (or recap) video may have. */
export const SUBJECT_MAX_PARTS = 8;
/** The longest subject (or recap) video, in minutes. */
export const SUBJECT_MAX_MINUTES = 25;

/** The key that marks a demo job's saved input as a slides job. */
export const FORK_SLIDES_MARKER = "forkSlides";

/** A stable phrase in the node-video gate's rejection of a quiz/explain call
 *  (src/agent/fork-slides/node-video-gate.ts). The transcript hides a tool
 *  error carrying it (components/fork-hidden-tool-error.ts); it lives here so
 *  the client bundle can import it without server modules. */
export const NODE_VIDEO_GATE_MARKER = "Node videos are built ahead";

/** A subject or recap video's job input: every part, in order (parts[i] is part i + 1). */
export interface ForkSlidesSubjectInput {
	kind: ForkSlidesPartsKind;
	/** Part 1's title. */
	title: string;
	of: number;
	minutes: number;
	parts: ForkSlidesInput[];
	/** The toolCallId of each part's call, in the same order. */
	calls: string[];
	/** Subject video only: the line naming the first node videos to build,
	 *  appended to the completing call's ACK at dispatch and replayed unchanged. */
	nodeVideosAck?: string;
}

/** The saved job input: the call (or, for a subject or recap video, all its parts) plus the marker. */
export type ForkSlidesJobInput = ((ForkSlidesInput & { kind: "deck" | "video" }) | ForkSlidesSubjectInput) & { [FORK_SLIDES_MARKER]: true };

/** True for a subject or recap video's job input (every part in one job). */
export function isPartsJobInput(input: ForkSlidesJobInput): input is ForkSlidesSubjectInput & { [FORK_SLIDES_MARKER]: true } {
	return isPartsKind(input.kind);
}

/** One build step as stored in the result: its narration and its frame file. */
export interface ForkSlidesStep {
	say: string;
	frame: string;
	/** The step's narration file (Stage 2); absent when the deck has no audio. */
	audio?: string;
	/** The narration's length in seconds. */
	duration?: number;
}

/** The deck as the result keeps it: references plus the script text. */
export interface ForkSlidesDeck {
	version: 1;
	jobId: string;
	kind: "deck" | "video" | ForkSlidesPartsKind;
	/** The stage SVG's file name in the job's asset folder (a subject or recap video: its first drawn part's). */
	stage: string;
	/** A subject or recap video's slides carry their part number; all parts play as one timeline. */
	slides: { steps: ForkSlidesStep[]; part?: number }[];
	/** Subject and recap videos only: the part count, the parts that could not be drawn,
	 *  and each part's call id in part order (calls[i] is part i + 1). */
	parts?: { of: number; missing: number[]; calls: string[] };
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

/** A subject or recap video part's file-name prefix ("p3-"); none for a deck or node video. */
function partPrefix(part?: number): string {
	return part === undefined ? "" : `p${part}-`;
}

/** Frame file name for a 1-based slide/step, e.g. frame-03-2.svg (a subject part: p2-frame-03-2.svg). */
export function frameFileName(slide: number, step: number, part?: number): string {
	return `${partPrefix(part)}frame-${String(slide).padStart(2, "0")}-${step}.svg`;
}

export const FORK_SLIDES_STAGE_FILE = "stage.svg";
export const FORK_SLIDES_DECK_FILE = "deck.html";

/** Stage file name: stage.svg (a subject part: p2-stage.svg). */
export function stageFileName(part?: number): string {
	return `${partPrefix(part)}${FORK_SLIDES_STAGE_FILE}`;
}

/** Asset names the route may serve (everything else is a 404). The optional
 *  p1-…p8- prefix is a subject video part (SUBJECT_MAX_PARTS). */
export const FORK_SLIDES_FILE_RE = /^(?:p[1-8]-)?(?:(?:stage|frame-\d{2}-[1-9])\.svg|audio-\d{2}-[1-9]\.ogg)$/;

/** Narration file names (a subset of FORK_SLIDES_FILE_RE). */
export const FORK_SLIDES_AUDIO_RE = /^(?:p[1-8]-)?audio-\d{2}-[1-9]\.ogg$/;

/** Narration file name for a 1-based slide/step, e.g. audio-03-2.ogg (a subject part: p2-audio-03-2.ogg). */
export function audioFileName(slide: number, step: number, part?: number): string {
	return `${partPrefix(part)}audio-${String(slide).padStart(2, "0")}-${step}.ogg`;
}

/** The part number and count of a subject or recap part's "received" ACK, else null
 *  (the tool part of a part that did not complete the video has no job). */
export function subjectPartReceived(output: unknown): { part: number; of: number } | null {
	const m = typeof output === "string" ? /^Part (\d+) of (\d+) received/.exec(output) : null;
	return m ? { part: Number(m[1]), of: Number(m[2]) } : null;
}
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
 *  session Markdown read what the deck taught. A recap call (kind "recap")
 *  is never teacher prose, delivered or not: it retells what the session
 *  already taught, so its narration stays out of the knowledge graph and the
 *  Markdown export, and a delivered recap never changes a message's coverage
 *  fingerprint (this is the only place slides narration enters userFacingTextOf). */
export function forkSlidesNarration(block: unknown): string | undefined {
	try {
		if (!block || typeof block !== "object") return undefined;
		const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
		if (call.type !== "toolCall" || call.name !== "slides") return undefined;
		if (!call.arguments || typeof call.arguments !== "object") return undefined;
		const args = call.arguments as { title?: unknown; kind?: unknown; slides?: unknown };
		if (args.kind === "recap" || !Array.isArray(args.slides)) return undefined;
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

/** Which slides calls were delivered, read from the transcript's
 *  `subagent-steer` messages that carry a drawn slides result. `slim`: every
 *  delivered call (a subject or recap video: all its part calls, a missing
 *  part too). `narrated`: the calls whose narration counts as teacher prose
 *  (a subject video's missing parts excluded; a recap video's calls never).
 *  One pass; pure. */
export function forkSlidesDelivered(messages: readonly unknown[]): { narrated: Set<string>; slim: Set<string> } {
	const narrated = new Set<string>();
	const slim = new Set<string>();
	for (const message of messages) {
		const m = message as { role?: unknown; customType?: unknown; details?: { toolCallId?: unknown; result?: unknown } };
		if (m.role !== "custom" || m.customType !== "subagent-steer" || !isForkSlidesResult(m.details?.result)) continue;
		const { parts, kind } = m.details.result.forkSlides;
		if (parts) {
			parts.calls.forEach((id, i) => {
				slim.add(id);
				if (kind !== "recap" && !parts.missing.includes(i + 1)) narrated.add(id);
			});
		} else if (typeof m.details.toolCallId === "string") {
			slim.add(m.details.toolCallId);
			narrated.add(m.details.toolCallId);
		}
	}
	return { narrated, slim };
}

/** Add to upstream's failed-output set every slides call whose narration
 *  the learner did not get: not (yet) delivered and drawn (still building,
 *  failed, rejected, a replaced subject part, a part of a restarted or
 *  unfinished collection, a missing part, any recap part), or sitting in an errored/aborted
 *  assistant message (mirroring the send_to_user rule in
 *  failedOutputCallIds). Needs the whole transcript: the delivering steer
 *  comes after the call. */
export function forkSlidesFailedCalls(messages: readonly LhMessage[], failed: Set<string>): void {
	const { narrated } = forkSlidesDelivered(messages);
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const broken = message.stopReason === "error" || message.stopReason === "aborted";
		for (const block of message.content) {
			if (block.type === "toolCall" && block.name === "slides" && (broken || !narrated.has(block.id))) failed.add(block.id);
		}
	}
}

// ─── the narration timeline (the card's player) ─────────────────────────────

/** Seconds of silence after a narrated step whose next step is on the same slide. */
export const STEP_PAUSE = 1.2;
/** Seconds of silence after the last step of a slide (instead of STEP_PAUSE). The deck's last step has none. */
export const SLIDE_PAUSE = 2;

export interface TimelineStep {
	slide: number;
	step: number;
	/** Seconds from the deck's start. */
	start: number;
	/** The narration's length. */
	duration: number;
	/** Silence after the narration, before the next step (0 after the last). */
	pause: number;
	audio: string;
}

export interface DeckTimeline {
	steps: TimelineStep[];
	total: number;
}

/** The deck's narration timeline, pauses included; null unless every step has
 *  audio and a positive duration. Player-side, so older decks get the pauses too. Pure. */
export function deckTimeline(deck: ForkSlidesDeck): DeckTimeline | null {
	const steps: TimelineStep[] = [];
	for (let i = 0; i < deck.slides.length; i++) {
		for (let j = 0; j < deck.slides[i]!.steps.length; j++) {
			const st = deck.slides[i]!.steps[j]!;
			if (typeof st.audio !== "string" || typeof st.duration !== "number" || !(st.duration > 0)) return null;
			steps.push({ slide: i, step: j, start: 0, duration: st.duration, pause: 0, audio: st.audio });
		}
	}
	let t = 0;
	steps.forEach((s, k) => {
		const next = steps[k + 1];
		s.start = t;
		s.pause = !next ? 0 : next.slide !== s.slide ? SLIDE_PAUSE : STEP_PAUSE;
		t += s.duration + s.pause;
	});
	return steps.length ? { steps, total: t } : null;
}

/** The step at time t (clamped into the deck), and the offset into it. A time
 *  inside a pause belongs to the step that just ended (its frame stays; the
 *  offset is past its narration). Pure. */
export function timelineAt(tl: DeckTimeline, t: number): { index: number; offset: number } {
	const time = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), tl.total);
	let index = 0;
	for (let i = 0; i < tl.steps.length; i++) if (tl.steps[i]!.start <= time) index = i;
	const s = tl.steps[index]!;
	return { index, offset: Math.min(time - s.start, s.duration + s.pause) };
}

/** Index of a (slide, step) in the timeline; -1 if absent. Pure. */
export function timelineIndex(tl: DeckTimeline, slide: number, step: number): number {
	return tl.steps.findIndex((s) => s.slide === slide && s.step === step);
}

/** Deck time of a step's start plus an offset into it (its pause included). Pure. */
export function timelineTime(tl: DeckTimeline, index: number, offset = 0): number {
	const s = tl.steps[index];
	return s ? s.start + Math.min(Math.max(offset, 0), s.duration + s.pause) : 0;
}

/** m:ss for the player clock. Pure. */
export function formatClock(seconds: number): string {
	const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
