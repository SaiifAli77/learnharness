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
	FORK_SLIDES_HTML_PLACEHOLDER,
	FORK_SLIDES_STAGE_FILE,
	isForkSlidesInput,
	type ForkSlidesDeck,
	type ForkSlidesJobInput,
	type ForkSlidesResult,
} from "../../core/fork-slides.ts";
import { runSlidesMaker, type SlidesMakerContinuation } from "../subagents/fork-slides-maker.ts";
import { readForkSlidesContinuation, writeForkSlidesAssets } from "./storage.ts";

/** Test seam (runner.ts's *ModelOverride idiom): a scripted slides engine. */
export const forkSlidesModelOverride: { current?: PiEngine } = {};

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

/** Teacher-facing notes on a delivered deck (the steer text carries them). */
function deliveredNotes(job: JobRecord, input: ForkSlidesJobInput, makerNotes: string): string {
	const steps = input.slides.reduce((n, s) => n + s.steps.length, 0);
	const what =
		`This is not an interactive demo: it is a narrated slide deck (${input.kind}) the learner flips through, ` +
		`${input.slides.length} slide${input.slides.length === 1 ? "" : "s"}, ${steps} build step${steps === 1 ? "" : "s"}, rendered in the lesson.`;
	const next =
		input.kind === "video"
			? "Point the learner to the video in one line and carry on teaching; do not retell it."
			: "It IS the explanation: point to it in one line, then fire the check. Never repeat its walkthrough in prose.";
	return `${what} ${next} To build on this deck later, pass continues: "${job.toolCallId}". Helper notes: ${makerNotes}`;
}

/** Run one slides job to its result (never throws, except silently on abort). */
export async function runForkSlidesJob(jobId: string, engine: PiEngine, loop: LoopLike, deps: ForkSlidesRunnerDeps): Promise<void> {
	const { jobStore, finishJob, stillRunning } = deps;
	const job = jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	const input = job.input as ForkSlidesJobInput;
	const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Slides";
	const fail = async (reason: string) => {
		if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
		await finishJob(jobId, { title, html: "", tested: true, notes: reason.startsWith("FAILED:") ? reason : `FAILED: ${reason}` });
	};
	try {
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
		jobStore.updateJob(jobId, { activity: "drawing slides" });
		const made = await runSlidesMaker(input, {
			engine,
			continuation,
			abortSignal: loop.abortSignal,
			chatId: loop.chatId,
			onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
			onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
		});
		if (!made.ok) {
			await fail(made.notes);
			return;
		}
		writeForkSlidesAssets(jobId, {
			stage: made.stage,
			frames: made.frames.map((f) => ({ file: f.file, svg: f.svg })),
			states: { finalState: made.finalState, finalOverlay: made.finalState.overlay },
		});
		const deck: ForkSlidesDeck = {
			version: 1,
			jobId,
			kind: input.kind,
			stage: FORK_SLIDES_STAGE_FILE,
			slides: input.slides.map((slide, i) => ({
				steps: slide.steps.map((step, j) => ({ say: step.say, frame: made.frames.find((f) => f.slide === i + 1 && f.step === j + 1)!.file })),
			})),
		};
		const result: ForkSlidesResult = {
			title,
			html: FORK_SLIDES_HTML_PLACEHOLDER,
			tested: true,
			notes: deliveredNotes(job, input, made.notes),
			forkSlides: deck,
		};
		await finishJob(jobId, result);
	} catch (err) {
		if (loop.abortSignal.aborted) return;
		await fail(err instanceof Error ? err.message : String(err));
	}
}
