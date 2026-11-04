/**
 * Fork-only: the teacher's `slides` tool (FORK.md "StatQuest method and slide
 * decks"). Spread into upstream's jobTools() by a one-line hook, so the
 * teacher registry carries it and the prober (which takes only research/pdf
 * from jobTools) never does.
 *
 * Dispatch validates synchronously and returns every problem to the teacher;
 * only a valid call creates a job. The job is an upstream "demo" job whose
 * saved input carries FORK_SLIDES_MARKER (owner's choice: no new JobKind).
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute } from "../tool-execute.ts";
import type { JobToolContext } from "../tools/jobs.ts";
import { FORK_SLIDES_MARKER, isForkSlidesInput, type ForkSlidesInput, type ForkSlidesJobInput } from "../../core/fork-slides.ts";
import { checkNumber } from "./expr.ts";

export const SLIDES_MAX_SLIDES = 45;
export const SLIDES_MAX_STEPS_PER_SLIDE = 6;
export const SLIDES_MAX_STEPS = 120;
export const VIDEO_MIN_WORDS = 400;
export const VIDEO_MAX_WORDS = 850;

export const slidesInputSchema = Type.Object({
	title: Type.String({ description: "Card title." }),
	kind: Type.Union([Type.Literal("deck"), Type.Literal("video")], {
		description: '"deck": a short deck (about 5–15 slides) inside a step. "video": 3–6 minutes (400–850 spoken words) at the start of a plan node or for a hard concept.',
	}),
	continues: Type.Optional(
		Type.String({ description: "The toolCallId of an earlier slides call in this session whose picture and numbers carry on." }),
	),
	stage: Type.String({
		description: "The fixed diagram for the whole deck: its parts, where they sit, every number on it, and the colour of each quantity (one colour per quantity, kept everywhere).",
	}),
	slides: Type.Array(
		Type.Object({
			steps: Type.Array(
				Type.Object({
					say: Type.String({ description: "One spoken clause (about 8–12 words), plain words, no LaTeX." }),
					show: Type.String({ description: "The one visible change on the picture." }),
					pointer: Type.Optional(Type.String({ description: "A few on-slide words, drawn with an arrow to the focus." })),
					numbers: Type.Optional(
						Type.Array(
							Type.Object({
								value: Type.String({ description: 'As displayed, e.g. "2.25" (its decimals set the rounding).' }),
								expr: Type.String({ description: 'The expression it comes from, e.g. "log(1+exp(0*-34.4+2.14))".' }),
							}),
						),
					),
				}),
				{ minItems: 1, description: "1–6 build steps per slide; 120 steps per deck." },
			),
		}),
		{ minItems: 1, description: "1–45 slides." },
	),
});

const SLIDES_DESCRIPTION =
	"Dispatch a background helper that draws a narrated slide deck from your script (the StatQuest method): one fixed stage " +
	"diagram, and slides made of build steps, each one spoken clause plus exactly one visible change. Use it for every step " +
	"where numbers flow through a process. Every number you show carries its expression; the tool recomputes it and a mismatch " +
	"comes back to you before anything is drawn. The helper never sees the lesson: the script is everything it knows. " +
	"The call is ASYNC: it resolves immediately and the deck arrives later as a new message.";

const DECK_ACK =
	"The deck arrives as a new message in a few minutes and IS the explanation. Write the setup now, then keep the learner " +
	"working meanwhile without explaining what the deck will show: a recap question on earlier material, or a warm-up question " +
	"that prepares for the deck. Do not wait, poll, or mention waiting. When it arrives, point to it in one line, then fire the " +
	"check. Never repeat its walkthrough in prose.";
const VIDEO_ACK =
	"Keep teaching in prose: do not wait, poll, or mention waiting. The video arrives as a new message; point the learner to it then.";

/** Count spoken words across every step's `say`. */
export function spokenWords(input: Pick<ForkSlidesInput, "slides">): number {
	let n = 0;
	for (const slide of input.slides) for (const step of slide.steps) n += step.say.split(/\s+/).filter(Boolean).length;
	return n;
}

/** Dispatch-time validation: every reason the call is rejected (empty = valid). */
export function slidesInputProblems(input: ForkSlidesInput, ctx: Pick<JobToolContext, "chatId" | "jobStore">): string[] {
	const problems: string[] = [];
	if (input.slides.length > SLIDES_MAX_SLIDES) problems.push(`${input.slides.length} slides: at most ${SLIDES_MAX_SLIDES} per deck.`);
	let total = 0;
	input.slides.forEach((slide, i) => {
		total += slide.steps.length;
		if (slide.steps.length > SLIDES_MAX_STEPS_PER_SLIDE)
			problems.push(`slide ${i + 1} has ${slide.steps.length} steps: at most ${SLIDES_MAX_STEPS_PER_SLIDE} per slide.`);
	});
	if (total > SLIDES_MAX_STEPS) problems.push(`${total} steps in the deck: at most ${SLIDES_MAX_STEPS}.`);
	if (input.kind === "video") {
		const words = spokenWords(input);
		if (words < VIDEO_MIN_WORDS || words > VIDEO_MAX_WORDS)
			problems.push(
				`a video needs ${VIDEO_MIN_WORDS}–${VIDEO_MAX_WORDS} spoken words (3–6 minutes at about 135 words per minute); this script's "say" text has ${words}.`,
			);
	}
	input.slides.forEach((slide, i) =>
		slide.steps.forEach((step, j) =>
			(step.numbers ?? []).forEach((num, k) => {
				const check = checkNumber(num.value, num.expr);
				if (!check.ok) problems.push(`slide ${i + 1}, step ${j + 1}, number ${k + 1}: ${check.reason}.`);
			}),
		),
	);
	if (input.continues !== undefined) {
		const earlier = ctx.jobStore.findJobByToolCallId(ctx.chatId, input.continues);
		if (!earlier || earlier.kind !== "demo" || !isForkSlidesInput(earlier.input)) {
			problems.push(`continues: "${input.continues}" is not the toolCallId of an earlier slides call in this session.`);
		} else if (earlier.status !== "done") {
			problems.push(
				`continues: the deck "${input.continues}" is ${earlier.status === "running" ? "still being built" : "a failed build"}, so there is no deck to continue yet.`,
			);
		}
	}
	return problems;
}

/** The slides tool, keyed for spreading into jobTools(). */
export function forkSlidesTools(ctx: JobToolContext): Record<string, AgentTool<any>> {
	const dispatch = serverExecute("slides", slidesInputSchema, (input, { toolCallId }) => {
		const marked: ForkSlidesJobInput = { ...input, [FORK_SLIDES_MARKER]: true };
		const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
		const job = existing ?? ctx.jobStore.createJob({ kind: "demo", chatId: ctx.chatId, toolCallId, input: marked });
		// The spawn seam's input type lists upstream's tool inputs; the runner
		// hook narrows a slides job by its marker.
		if (!existing) ctx.spawn(job, marked as never);
		return `Dispatched (job ${job.id}). ${input.kind === "video" ? VIDEO_ACK : DECK_ACK}`;
	});
	return {
		slides: {
			name: "slides",
			label: "slides",
			description: SLIDES_DESCRIPTION,
			parameters: slidesInputSchema,
			execute: async (toolCallId, input, signal, onUpdate) => {
				const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
				if (!existing) {
					const problems = slidesInputProblems(input as ForkSlidesInput, ctx);
					if (problems.length > 0) return invalidInputResult("slides", problems);
				}
				return dispatch(toolCallId, input, signal, onUpdate);
			},
		},
	};
}
