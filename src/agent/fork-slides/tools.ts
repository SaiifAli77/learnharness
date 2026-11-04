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
import { invalidInputResult, serverExecute, toToolResult } from "../tool-execute.ts";
import type { JobToolContext } from "../tools/jobs.ts";
import type { ChatStore } from "../../core/ports.ts";
import type { JobRecord } from "../../core/contracts.ts";
import {
	FORK_SLIDES_MARKER,
	isForkSlidesInput,
	SUBJECT_MAX_MINUTES,
	SUBJECT_MAX_PARTS,
	type ForkSlidesInput,
	type ForkSlidesJobInput,
	type ForkSlidesSubjectInput,
} from "../../core/fork-slides.ts";
import { checkNumber } from "./expr.ts";
import { clearSubjectParts, readSubjectParts, writeSubjectParts, type SubjectPartsCollection } from "./storage.ts";
import { getHeadless } from "../subagents/headless.ts";
import { nextVideoTargets, nodeLabel, nodeVideoJobs, pendingNodeVideoGate, reachedNodes } from "./node-video-gate.ts";

/** The job tool context plus the chat store: createTeacherTools passes its
 *  whole context to jobTools(), so a video's nodeId is checked against the
 *  plan map (the prober's registry never carries `slides`). */
export type ForkSlidesToolContext = JobToolContext & { chatStore?: ChatStore };

export const SLIDES_MAX_SLIDES = 45;
export const SLIDES_MAX_STEPS_PER_SLIDE = 6;
export const SLIDES_MAX_STEPS = 120;
export const VIDEO_MIN_WORDS = 400;
export const VIDEO_MAX_WORDS = 850;
/** The spoken words a node video aims for. */
export const NODE_VIDEO_TARGET_WORDS = 550;
/** Spoken words per minute of narration. */
export const WORDS_PER_MINUTE = 135;
/** The most minutes of narration one subject part may carry (minutes ÷ of). */
export const SUBJECT_MAX_PART_MINUTES = 7;

/** The spoken words each part of a subject video of `minutes` in `of` parts
 *  must have: 80–120% of its share, minutes ÷ of × WORDS_PER_MINUTE. Integer
 *  math (108 and 162 are 80% and 120% of 135), so the bounds are exact. */
export function subjectPartWordRange(minutes: number, of: number): { min: number; max: number } {
	return { min: Math.ceil((minutes * 108) / of), max: Math.floor((minutes * 162) / of) };
}

export const slidesInputSchema = Type.Object({
	title: Type.String({ description: "Card title (a subject video's card shows part 1's title)." }),
	kind: Type.Union([Type.Literal("subject"), Type.Literal("video"), Type.Literal("deck")], {
		description:
			'"subject": one part of the subject video, the whole subject end to end as one story (set part, of and minutes). ' +
			'"video": a node video of 400–850 spoken words (aim for about 550 words, about 50–60 steps), for the plan node in nodeId, built two nodes ahead. ' +
			'"deck": a short deck (about 5–15 slides), only when the learner asks for one.',
	}),
	nodeId: Type.Optional(
		Type.String({ description: 'kind "video" only, and required there: the plan node this video is for (an exact plan_init slug).' }),
	),
	part: Type.Optional(
		Type.Integer({ minimum: 1, description: 'kind "subject" only: this part\'s number, 1-based. Sending a part number again replaces that part.' }),
	),
	of: Type.Optional(
		Type.Integer({ minimum: 1, description: `kind "subject" only: how many parts the video has (at most ${SUBJECT_MAX_PARTS}); the same on every part.` }),
	),
	minutes: Type.Optional(
		Type.Integer({
			description: `kind "subject" only: the length the learner picked, in whole minutes (at most ${SUBJECT_MAX_MINUTES}); the same on every part. Each part must have 80–120% of minutes ÷ of × ${WORDS_PER_MINUTE} spoken words, and minutes ÷ of is at most ${SUBJECT_MAX_PART_MINUTES}.`,
		}),
	),
	continues: Type.Optional(
		Type.String({
			description: "Deck or node video only: the toolCallId of an earlier deck or node video in this session whose picture and numbers carry on.",
		}),
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
				{ minItems: 1, description: "1–6 build steps per slide; 120 steps per deck (per part for a subject video)." },
			),
		}),
		{ minItems: 1, description: "1–45 slides (per part for a subject video)." },
	),
});

const SLIDES_DESCRIPTION =
	"Dispatch a background helper that draws a narrated slide video or deck from your script (the StatQuest method): one fixed " +
	"stage diagram, and slides made of build steps, each one spoken clause plus exactly one visible change. Every number you show " +
	"carries its expression; the tool recomputes it and a mismatch comes back to you before anything is drawn. The helper never " +
	"sees the lesson: the script is everything it knows. " +
	"A subject video is sent as several calls, one per part (kind \"subject\" with part, of and minutes); its parts are collected " +
	"for this session and the video is built once parts 1 to `of` are all in, as one video that plays straight through. Sending a " +
	"part number again replaces that part. Every part carries the same `of` and `minutes`; part 1 sent with a different `of` or " +
	"`minutes` starts the video over (the parts received so far are dropped), and any other part that disagrees is rejected. " +
	"The call is ASYNC: it resolves immediately and the video or deck arrives later as a new message.";

const DECK_ACK =
	"The deck arrives as a new message in a few minutes and IS the explanation. Write the setup now, then keep the learner " +
	"working meanwhile without explaining what the deck will show: a recap question on earlier material, or a warm-up question " +
	"that prepares for the deck. Do not wait, poll, or mention waiting. When it arrives, point to it in one line, then fire the " +
	"check. Never repeat its walkthrough in prose.";
const VIDEO_ACK =
	"Carry on with the current activity while it builds (during the subject video, the invention questions; otherwise teach in " +
	"prose): do not wait, poll, or mention waiting. The node video arrives as a new message. At its node, point " +
	"the learner to it first and wait for them to watch it and send a message; then teach that node in full (worked numbers, " +
	"predict and check questions, its closing essay): the video never replaces the teaching.";
const SUBJECT_ACK =
	"The subject video is built from every part and arrives as a new message. Meanwhile let the learner try to invent the " +
	"subject from the start: pose the problem it solves and ask, one question at a time with ask_user_question (not quiz or " +
	"explain), how they would attack it, reacting to each attempt in a line without giving the answer away. Do not wait, poll, " +
	"or mention waiting. When it arrives, stop asking: tell the learner to watch it and to send a message when done; begin node 1 after that.";

/** Count spoken words across every step's `say`. */
export function spokenWords(input: Pick<ForkSlidesInput, "slides">): number {
	let n = 0;
	for (const slide of input.slides) for (const step of slide.steps) n += step.say.split(/\s+/).filter(Boolean).length;
	return n;
}

/** The parts already collected that a subject part joins: null when there
 *  are none, or when part 1 arrives with a different `of`/`minutes` (it
 *  starts the video over); "mismatch" when a later part disagrees (rejected). */
function joinedCollection(input: ForkSlidesInput, collection: SubjectPartsCollection | null): SubjectPartsCollection | null | "mismatch" {
	if (!collection) return null;
	if (collection.of === input.of && collection.minutes === input.minutes) return collection;
	return input.part === 1 ? null : "mismatch";
}

/** The subject-only checks: part/of/minutes, the length cap, at most
 *  SUBJECT_MAX_PART_MINUTES per part and this part's own word range (per part,
 *  independent of the other parts), then the collection checks. */
function subjectProblems(input: ForkSlidesInput, chatId: string): string[] {
	const { part, of, minutes } = input;
	if (part === undefined || of === undefined || minutes === undefined)
		return ["a subject part needs part, of and minutes (the same of and minutes on every part)."];
	const problems: string[] = [];
	if (of > SUBJECT_MAX_PARTS) problems.push(`of: ${of} parts; a subject video has at most ${SUBJECT_MAX_PARTS}.`);
	if (part > of) problems.push(`part ${part} of ${of}: the part number cannot exceed of.`);
	if (minutes > SUBJECT_MAX_MINUTES)
		problems.push(
			`minutes: ${minutes} is over the ${SUBJECT_MAX_MINUTES}-minute cap. Use minutes: ${SUBJECT_MAX_MINUTES}, and tell the learner the video is capped at ${SUBJECT_MAX_MINUTES} minutes.`,
		);
	else if (!(minutes >= 1)) problems.push(`minutes: ${minutes}; the video needs at least 1 minute.`);
	else problems.push(...partLengthProblems(input, part, of, minutes));
	if (input.continues !== undefined) problems.push("continues: a subject part never continues another deck; drop it.");
	if (problems.length) return problems;
	return collectionProblems(input, readSubjectParts(chatId));
}

/** At most SUBJECT_MAX_PART_MINUTES per part (else how many parts are needed),
 *  then this part's spoken words within subjectPartWordRange. Only run for a valid `minutes`. */
function partLengthProblems(input: ForkSlidesInput, part: number, of: number, minutes: number): string[] {
	const parts = (n: number) => `${n} part${n === 1 ? "" : "s"}`;
	if (minutes > SUBJECT_MAX_PART_MINUTES * of) {
		const perPart = Math.round((minutes / of) * 10) / 10;
		const need = Math.ceil(minutes / SUBJECT_MAX_PART_MINUTES);
		return [
			`minutes ${minutes} in ${parts(of)} is ${perPart} minutes per part; a part is at most ${SUBJECT_MAX_PART_MINUTES} minutes, so a ${minutes}-minute video needs at least ${parts(need)} (of: ${need}).`,
		];
	}
	const { min, max } = subjectPartWordRange(minutes, of);
	const words = spokenWords(input);
	if (words >= min && words <= max) return [];
	return [
		`part ${part} has ${words} spoken words; a ${minutes}-minute video in ${parts(of)} needs ${min}–${max} per part (80–120% of minutes ÷ of × ${WORDS_PER_MINUTE}). ${words < min ? "Lengthen" : "Shorten"} this part's "say" text.`,
	];
}

/** The check that depends on the parts already collected: the same of/minutes.
 *  Run at validation and again inside the synchronous collect step, so parts
 *  dispatched together cannot slip past. */
function collectionProblems(input: ForkSlidesInput, collection: SubjectPartsCollection | null): string[] {
	const { part, of, minutes } = input as Required<Pick<ForkSlidesInput, "part" | "of" | "minutes">>;
	const joined = joinedCollection(input, collection);
	if (joined === "mismatch") {
		const c = collection!;
		return [
			`part ${part} says of ${of}, minutes ${minutes}, but the parts received so far say of ${c.of}, minutes ${c.minutes}. ` +
				"Send every part with the same of and minutes, or send part 1 again to start the video over.",
		];
	}
	return [];
}

/** The plan-map check for a video's nodeId (the same rule as the teach quiz's nodeId check in upstream tools.ts). */
function videoNodeProblem(nodeId: string | undefined, ctx: Pick<ForkSlidesToolContext, "chatId" | "chatStore">): string | null {
	if (nodeId === undefined) return "a video needs nodeId: the plan node it is for (built two nodes ahead).";
	const known = ctx.chatStore?.getChat(ctx.chatId)?.tree?.nodes.map((n) => n.id) ?? [];
	if (known.includes(nodeId)) return null;
	return (
		`nodeId "${nodeId}" matches no node in this session's plan map. ` +
		(known.length > 0
			? `Copy one of your plan_init slugs exactly (${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}).`
			: "No plan map exists yet — call plan_init first.")
	);
}

/** While a node-video gate rejection is pending in this chat (within its
 *  turn), a video for the node the learner is at or has passed is the wrong
 *  one: name the targets the gate asked for instead. Outside a pending gate
 *  any node is fine. */
function wrongNodeVideoProblem(nodeId: string, ctx: Pick<ForkSlidesToolContext, "chatId" | "jobStore" | "chatStore">): string | null {
	const record = ctx.chatStore?.getChat(ctx.chatId);
	const gate = record ? pendingNodeVideoGate(ctx.chatId, record) : undefined;
	if (!gate || !record || !reachedNodes(ctx.chatId, record).has(nodeId)) return null;
	const where = nodeId === gate.k ? `already at "${gate.k}"` : `already past "${nodeId}"`;
	const { covered } = nodeVideoJobs(ctx.jobStore.listJobs(ctx.chatId));
	const left = gate.missing.filter((n) => !covered.has(n.id));
	const named = (nodes: typeof left) => nodes.map(nodeLabel).join(" and ");
	if (left.length === 0)
		return `The learner is ${where}; the videos for ${named(gate.missing)} are already dispatched, so re-pose the question instead.`;
	return `The learner is ${where}; build the video for ${named(left)} instead.`;
}

/** Dispatch-time validation: every reason the call is rejected (empty = valid). */
export function slidesInputProblems(
	input: ForkSlidesInput,
	ctx: Pick<ForkSlidesToolContext, "chatId" | "jobStore" | "chatStore">,
): string[] {
	// A video for the wrong node: its length and contents don't matter, only the redirect.
	if (input.kind === "video" && !videoNodeProblem(input.nodeId, ctx)) {
		const wrong = wrongNodeVideoProblem(input.nodeId!, ctx);
		if (wrong) return [wrong];
	}
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
		const range = `a node video needs ${VIDEO_MIN_WORDS}–${VIDEO_MAX_WORDS} spoken words; this script's "say" text has ${words} words: `;
		if (words < VIDEO_MIN_WORDS)
			problems.push(
				`${range}at least ${VIDEO_MIN_WORDS - words} more are needed; aim for about ${NODE_VIDEO_TARGET_WORDS} (about ${NODE_VIDEO_TARGET_WORDS - words} more).`,
			);
		else if (words > VIDEO_MAX_WORDS)
			problems.push(`${range}cut at least ${words - VIDEO_MAX_WORDS}; aim for about ${NODE_VIDEO_TARGET_WORDS}.`);
		const node = videoNodeProblem(input.nodeId, ctx);
		if (node) problems.push(node);
	}
	if (input.kind === "subject") problems.push(...subjectProblems(input, ctx.chatId));
	input.slides.forEach((slide, i) =>
		slide.steps.forEach((step, j) =>
			(step.numbers ?? []).forEach((num, k) => {
				const check = checkNumber(num.value, num.expr);
				if (!check.ok) problems.push(`slide ${i + 1}, step ${j + 1}, number ${k + 1}: ${check.reason}.`);
			}),
		),
	);
	if (input.continues !== undefined && input.kind !== "subject") {
		const earlier = ctx.jobStore.findJobByToolCallId(ctx.chatId, input.continues);
		if (!earlier || earlier.kind !== "demo" || !isForkSlidesInput(earlier.input)) {
			problems.push(`continues: "${input.continues}" is not the toolCallId of an earlier slides call in this session.`);
		} else if (earlier.input.kind === "subject") {
			problems.push(`continues: "${input.continues}" is the subject video, which has one stage per part and cannot be continued.`);
		} else if (earlier.status !== "done") {
			problems.push(
				`continues: the deck "${input.continues}" is ${earlier.status === "running" ? "still being built" : "a failed build"}, so there is no deck to continue yet.`,
			);
		}
	}
	return problems;
}

/** Collect one subject part; when parts 1..of are all in, create the one
 *  subject job and clear the collection. Synchronous from read to write (the
 *  collection checks run again here), so parts dispatched together cannot
 *  interleave. Returns the ACK, or the problems that reject the part. */
function dispatchSubjectPart(ctx: ForkSlidesToolContext, toolCallId: string, input: ForkSlidesInput): string | { problems: string[] } {
	const of = input.of!;
	const collection = readSubjectParts(ctx.chatId);
	const problems = collectionProblems(input, collection);
	if (problems.length) return { problems };
	const joined = joinedCollection(input, collection);
	const kept = joined && joined !== "mismatch" ? joined.parts.filter((p) => p.input.part !== input.part) : [];
	const parts = [...kept, { toolCallId, input }].sort((a, b) => a.input.part! - b.input.part!);
	const missing = Array.from({ length: of }, (_, i) => i + 1).filter((n) => !parts.some((p) => p.input.part === n));
	if (missing.length) {
		writeSubjectParts(ctx.chatId, { of, minutes: input.minutes!, parts });
		return `Part ${input.part} of ${of} received; send the rest (still missing: part${missing.length === 1 ? "" : "s"} ${missing.join(", ")}).`;
	}
	const marked: ForkSlidesJobInput = {
		kind: "subject",
		title: parts[0]!.input.title,
		of,
		minutes: input.minutes!,
		parts: parts.map((p) => p.input),
		calls: parts.map((p) => p.toolCallId),
		[FORK_SLIDES_MARKER]: true,
	};
	const nodeVideos = firstNodeVideosAck(ctx);
	if (nodeVideos) (marked as ForkSlidesSubjectInput).nodeVideosAck = nodeVideos;
	const job = ctx.jobStore.createJob({ kind: "demo", chatId: ctx.chatId, toolCallId, input: marked });
	clearSubjectParts(ctx.chatId);
	ctx.spawn(job, marked as never);
	return completedAck(job.id, marked as ForkSlidesSubjectInput);
}

/** The completing part's ACK: the subject ACK, plus the line naming the first node videos. */
function completedAck(jobId: string, input: ForkSlidesSubjectInput): string {
	return `Dispatched (job ${jobId}). ${SUBJECT_ACK}${input.nodeVideosAck ? ` ${input.nodeVideosAck}` : ""}`;
}

/** When the subject video dispatches: the line asking for the videos of
 *  nodes 1 and 2 (those not already running or done), or null when headless
 *  rendering is unavailable or no such node is left. */
function firstNodeVideosAck(ctx: ForkSlidesToolContext): string | null {
	const record = ctx.chatStore?.getChat(ctx.chatId);
	if (!record?.tree || getHeadless().unavailableReason()) return null;
	const { covered } = nodeVideoJobs(ctx.jobStore.listJobs(ctx.chatId));
	const targets = nextVideoTargets(record.tree, reachedNodes(ctx.chatId, record), null).filter((n) => !covered.has(n.id));
	if (targets.length === 0) return null;
	return targets.length === 1
		? `Now, before the invention questions, build the node video for ${nodeLabel(targets[0]!)}: one slides call, kind "video".`
		: `Now, before the invention questions, build the node videos for ${targets.map(nodeLabel).join(" and ")}: one slides call each, kind "video".`;
}

/** The saved subject video job a part call already went into (a replay of that call), if any. */
function subjectJobOf(ctx: ForkSlidesToolContext, toolCallId: string): JobRecord | undefined {
	return ctx.jobStore
		.listJobs(ctx.chatId)
		.find((j) => j.kind === "demo" && isForkSlidesInput(j.input) && j.input.kind === "subject" && j.input.calls.includes(toolCallId));
}

/** The ACK a replayed part call originally got: the completing call's
 *  dispatch, or an earlier part's "received" line (so the card still knows it). */
function replayAck(job: JobRecord, toolCallId: string): string {
	const input = job.input as ForkSlidesSubjectInput;
	return toolCallId === job.toolCallId ? completedAck(job.id, input) : `Part ${input.calls.indexOf(toolCallId) + 1} of ${input.of} received.`;
}

/** Clear a collection left behind by a crash between creating the subject
 *  job and clearing it: every collected call is already in one saved subject
 *  job. A collection with any call not consumed is kept. */
function discardConsumedCollection(ctx: ForkSlidesToolContext): void {
	const collection = readSubjectParts(ctx.chatId);
	if (!collection?.parts.length) return;
	const consumed = ctx.jobStore
		.listJobs(ctx.chatId)
		.some((j) => isForkSlidesInput(j.input) && j.input.kind === "subject" && collection.parts.every((p) => (j.input as ForkSlidesSubjectInput).calls.includes(p.toolCallId)));
	if (consumed) clearSubjectParts(ctx.chatId);
}

/** The slides tool, keyed for spreading into jobTools(). */
export function forkSlidesTools(ctx: ForkSlidesToolContext): Record<string, AgentTool<any>> {
	const dispatch = serverExecute("slides", slidesInputSchema, (input, { toolCallId }) => {
		const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
		const marked = { ...input, [FORK_SLIDES_MARKER]: true } as ForkSlidesJobInput;
		const job = existing ?? ctx.jobStore.createJob({ kind: "demo", chatId: ctx.chatId, toolCallId, input: marked });
		// The spawn seam's input type lists upstream's tool inputs; the runner
		// hook narrows a slides job by its marker.
		if (!existing) ctx.spawn(job, marked as never);
		return `Dispatched (job ${job.id}). ${input.kind === "subject" ? SUBJECT_ACK : input.kind === "video" ? VIDEO_ACK : DECK_ACK}`;
	});
	return {
		slides: {
			name: "slides",
			label: "slides",
			description: SLIDES_DESCRIPTION,
			parameters: slidesInputSchema,
			// One call at a time: parts sent in one message each see the
			// parts collected before them.
			executionMode: "sequential",
			execute: async (toolCallId, input, signal, onUpdate) => {
				if ((input as ForkSlidesInput).kind === "subject") discardConsumedCollection(ctx);
				// A replayed part call that is already in a subject video: the ACK it got, the collection untouched.
				const replayed = subjectJobOf(ctx, toolCallId);
				if (replayed) return toToolResult(replayAck(replayed, toolCallId));
				const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
				if (!existing) {
					const problems = slidesInputProblems(input as ForkSlidesInput, ctx);
					if (problems.length > 0) return invalidInputResult("slides", problems);
					if ((input as ForkSlidesInput).kind === "subject") {
						const collected = dispatchSubjectPart(ctx, toolCallId, input as ForkSlidesInput);
						return typeof collected === "string" ? toToolResult(collected) : invalidInputResult("slides", collected.problems);
					}
				}
				return dispatch(toolCallId, input, signal, onUpdate);
			},
		},
	};
}
