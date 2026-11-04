/**
 * Fork-only: the job runner's slides branch (FORK.md "StatQuest method and
 * slide decks"). upstream runner.ts keeps three one-line hooks: the engine
 * choice, the tier used by the refusal/key checks, and the demo runner
 * branch. A slides job is a "demo" job whose saved input carries the marker;
 * it runs on the teacher's (Strong) engine, not the demo builder's.
 */
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import {
	piUsageToStep,
	type DemoResult,
	type JobRecord,
	type UsageStepLike,
} from "../../core/contracts.ts";
import type { JobStore } from "../../core/ports.ts";
import {
	audioFileName,
	deckTimeline,
	formatClock,
	frameFileName,
	FORK_SLIDES_HTML_PLACEHOLDER,
	isForkSlidesInput,
	stageFileName,
	type ForkSlidesDeck,
	type ForkSlidesInput,
	type ForkSlidesJobInput,
	type ForkSlidesResult,
} from "../../core/fork-slides.ts";
import { runSlidesMaker, type SlidesMakerContinuation, type SlidesMakerResult } from "../subagents/fork-slides-maker.ts";
import * as path from "node:path";
import { forkSlidesDir, readForkSlidesContinuation, removeForkSlidesAudio, sweepForkSlidesOrphans, writeForkSlidesAssets } from "./storage.ts";
import { synthesizeNarration, type NarrationItem, type NarrationResult, type TtsDeps } from "./tts.ts";

/** Test seam (runner.ts's *ModelOverride idiom): a scripted slides engine. */
export const forkSlidesModelOverride: { current?: PiEngine } = {};

/** Test seam: replaces the Kokoro synthesis (the e2e tests never spawn uv). */
export const forkSlidesTtsOverride: { current?: (items: NarrationItem[], deps: TtsDeps) => Promise<NarrationResult> } = {};

/** The role whose engine a slides job runs on. */
export const FORK_SLIDES_ROLE: ModelRole = "teacher";

/** True for a demo job that is really a slides job (marker in its saved input). */
export function isForkSlidesJob(job: Pick<JobRecord, "kind" | "input"> | null | undefined): boolean {
	return !!job && job.kind === "demo" && isForkSlidesInput(job.input);
}

/** The role used for a job's engine and refusal tier: teacher for slides jobs. */
export function forkSlidesRole(job: Pick<JobRecord, "kind" | "input">, role: ModelRole): ModelRole {
	return isForkSlidesJob(job) ? FORK_SLIDES_ROLE : role;
}

/** The engine for a slides job: the test override, else the teacher's (Strong) engine. */
export function forkSlidesEngine(engineFor: ((role: ModelRole) => PiEngine | undefined) | undefined): PiEngine | undefined {
	return forkSlidesModelOverride.current ?? engineFor?.(FORK_SLIDES_ROLE);
}

/** What the runner lends the slides branch. */
export interface ForkSlidesRunnerDeps {
	jobStore: JobStore;
	finishJob: (jobId: string, result: DemoResult) => Promise<void>;
	stillRunning: (jobId: string) => boolean;
}

interface LoopLike {
	abortSignal: AbortSignal;
	chatId?: string;
	onUsage: (step: UsageStepLike) => void;
}

/** One drawn script: a deck or node video, or one subject video part. */
interface DrawnPart {
	/** The subject part number; undefined for a deck or node video. */
	part?: number;
	script: ForkSlidesInput;
	made: Extract<SlidesMakerResult, { ok: true }>;
}

/** A subject part that still failed after its retry. */
interface MissingPart {
	part: number;
	notes: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Teacher-facing notes on a delivered deck (the steer text carries them). */
function deliveredNotes(job: JobRecord, input: ForkSlidesJobInput, deck: ForkSlidesDeck, drawn: DrawnPart[], missing: MissingPart[], narration: NarrationResult): string {
	const slides = drawn.reduce((n, d) => n + d.script.slides.length, 0);
	const steps = drawn.reduce((n, d) => n + d.script.slides.reduce((m, s) => m + s.steps.length, 0), 0);
	const audio = narration.ok
		? `It is narrated (${formatClock(deckTimeline(deck)?.total ?? 0)} with the pauses between steps); the learner can play it or flip through it.`
		: `It has NO narration audio (${narration.reason}); the learner flips through it and reads the transcript under each slide. Mention that the audio is missing only if the learner asks.`;
	const helper = `Helper notes: ${drawn.map((d) => (d.part ? `part ${d.part}: ${d.made.notes}` : d.made.notes)).join(" ")}`;
	if (input.kind === "subject") {
		const what =
			`This is not an interactive demo: it is the narrated subject video, ${drawn.length} of ${input.of} parts played straight ` +
			`through as one video (${plural(slides, "slide")}, ${plural(steps, "build step")}), rendered in the lesson.`;
		const gaps = missing.map(
			(m) =>
				`Part ${m.part} of ${input.of} could not be drawn (${m.notes}), so the video skips that stretch: cover your part ${m.part} script in prose once the learner has watched the video.`,
		);
		const next = "Stop the invention questions now: tell the learner to watch it and to send a message when done; begin node 1 after that. Do not retell it.";
		return [what, audio, ...gaps, next, helper].join(" ");
	}
	const what =
		`This is not an interactive demo: it is a narrated slide deck (${input.kind}) the learner flips through, ` +
		`${plural(slides, "slide")}, ${plural(steps, "build step")}, rendered in the lesson.`;
	const next =
		input.kind === "video"
			? `It is the video for node "${input.nodeId}", built ahead: when the learner reaches that node, point them to it first and wait for them to watch it and send a message; then teach that node in full (worked numbers, predict and check questions, its closing essay): the video never replaces the teaching. Do not retell it.`
			: "It IS the explanation: point to it in one line, then fire the check. Never repeat its walkthrough in prose.";
	return `${what} ${audio} ${next} To build on this deck later, pass continues: "${job.toolCallId}". ${helper}`;
}

/** Run one slides job to its result (never throws, except silently on abort). */
export async function runForkSlidesJob(jobId: string, engine: PiEngine, loop: LoopLike, deps: ForkSlidesRunnerDeps): Promise<void> {
	const { jobStore, finishJob, stillRunning } = deps;
	const job = jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	sweepForkSlidesOrphans();
	const input = job.input as ForkSlidesJobInput;
	const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Slides";
	const fail = async (reason: string) => {
		if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
		await finishJob(jobId, { title, html: "", tested: true, notes: reason.startsWith("FAILED:") ? reason : `FAILED: ${reason}` });
	};
	const draw = (script: ForkSlidesInput, continuation?: SlidesMakerContinuation, part?: number) =>
		runSlidesMaker(script, {
			engine,
			continuation,
			abortSignal: loop.abortSignal,
			chatId: loop.chatId,
			onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
			onActivity: (line) => jobStore.updateJob(jobId, { activity: part ? `part ${part}: ${line}` : line }),
		});
	try {
		const drawn: DrawnPart[] = [];
		const missing: MissingPart[] = [];
		jobStore.updateJob(jobId, { activity: "drawing slides" });
		if (input.kind === "subject") {
			// Every part draws at once, each on its own stage; a failed part is
			// retried once (never after an abort), then left out.
			const results = await Promise.all(
				input.parts.map(async (script, i) => {
					const first = await draw(script, undefined, i + 1);
					return first.ok || loop.abortSignal.aborted ? first : draw(script, undefined, i + 1);
				}),
			);
			if (loop.abortSignal.aborted) return;
			results.forEach((made, i) => {
				if (made.ok) drawn.push({ part: i + 1, script: input.parts[i]!, made });
				else missing.push({ part: i + 1, notes: made.notes.replace(/^FAILED:\s*/, "") });
			});
			if (!drawn.length) {
				await fail(`FAILED: no part of the subject video could be drawn (each was retried once). ${missing.map((m) => `Part ${m.part}: ${m.notes}`).join(" ")}`);
				return;
			}
		} else {
			let continuation: SlidesMakerContinuation | undefined;
			if (input.continues) {
				const earlier = jobStore.findJobByToolCallId(job.chatId, input.continues);
				const assets = earlier ? readForkSlidesContinuation(earlier.id) : null;
				if (!assets) {
					await fail("FAILED: the earlier deck named in `continues` has no stored stage to continue from.");
					return;
				}
				continuation = { stage: assets.stage, finalOverlay: assets.states.finalOverlay };
			}
			const made = await draw(input, continuation);
			if (!made.ok) {
				await fail(made.notes);
				return;
			}
			drawn.push({ script: input, made });
		}
		for (const d of drawn)
			writeForkSlidesAssets(jobId, {
				stage: d.made.stage,
				frames: d.made.frames.map((f) => ({ file: frameFileName(f.slide, f.step, d.part), svg: f.svg })),
				states: d.part ? undefined : { finalState: d.made.finalState, finalOverlay: d.made.finalState.overlay },
				part: d.part,
			});
		// Narration at build time, after the frames are verified, in one Kokoro
		// session for every step. Any failure delivers the deck without audio;
		// it never fails the deck.
		jobStore.updateJob(jobId, { activity: "narrating" });
		const dir = forkSlidesDir(jobId)!;
		const items: NarrationItem[] = drawn.flatMap((d) =>
			d.script.slides.flatMap((slide, i) =>
				slide.steps.map((step, j) => ({ text: step.say, out: path.join(dir, audioFileName(i + 1, j + 1, d.part)) })),
			),
		);
		const synthesize = forkSlidesTtsOverride.current ?? synthesizeNarration;
		let narration: NarrationResult;
		try {
			narration = await synthesize(items, {
				abortSignal: loop.abortSignal,
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
			});
		} catch (err) {
			narration = { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
		if (loop.abortSignal.aborted) return;
		if (!narration.ok || narration.durations.length !== items.length) {
			if (narration.ok) narration = { ok: false, reason: "the narration came back incomplete" };
			removeForkSlidesAudio(jobId);
		}
		const durations = narration.ok ? narration.durations : null;
		let k = 0;
		const deck: ForkSlidesDeck = {
			version: 1,
			jobId,
			kind: input.kind,
			stage: stageFileName(drawn[0]!.part),
			slides: drawn.flatMap((d) =>
				d.script.slides.map((slide, i) => ({
					...(d.part ? { part: d.part } : {}),
					steps: slide.steps.map((step, j) => {
						const duration = durations?.[k++];
						return {
							say: step.say,
							frame: frameFileName(i + 1, j + 1, d.part),
							...(duration !== undefined
								? { audio: audioFileName(i + 1, j + 1, d.part), duration: Math.round(duration * 1000) / 1000 }
								: {}),
						};
					}),
				})),
			),
			...(input.kind === "subject" ? { parts: { of: input.of, missing: missing.map((m) => m.part), calls: input.calls } } : {}),
		};
		const result: ForkSlidesResult = {
			title,
			html: FORK_SLIDES_HTML_PLACEHOLDER,
			tested: true,
			notes: deliveredNotes(job, input, deck, drawn, missing, narration),
			forkSlides: deck,
		};
		await finishJob(jobId, result);
	} catch (err) {
		if (loop.abortSignal.aborted) return;
		await fail(err instanceof Error ? err.message : String(err));
	}
}
