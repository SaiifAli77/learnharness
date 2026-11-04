import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent, Message, TextContent, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { processImage } from "../image-processing/index.ts";
import type { PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { frameFileName, type ForkSlidesInput } from "../../core/fork-slides.ts";
import {
	assembleFrame,
	parseStage,
	resolveSlide,
	StageError,
	stepProblems,
	visibleNumbers,
	type OverlayItem,
	type ParsedStage,
	type ResolvedStep,
	type StepState,
} from "../fork-slides/frames.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";

/**
 * Fork-only: the slide helper (FORK.md "StatQuest method and slide decks").
 * Modelled on visual-maker.ts: a hand-rolled loop that feeds rendered PNGs
 * back to the model as images, but for a whole deck.
 *
 * The model authors ONE stage SVG and, per slide, each build step's state
 * relative to that stage (frames.ts). Code assembles every frame, so the
 * stage cannot drift. THE LOOK GATE: every frame is rendered and shown at
 * full size, at most FRAMES_PER_LOOK per message; after a fix only frames
 * whose SVG changed are shown again; the loop refuses to finish while any
 * frame's current version is unshown, and fails honestly at the iteration
 * cap instead of delivering unlooked frames.
 */

export interface SlidesMakerContinuation {
	/** The earlier deck's stage SVG. */
	stage: string;
	/** The earlier deck's overlay at its last step; slide 1 starts with it. */
	finalOverlay: OverlayItem[];
}

export interface SlidesMakerFrame {
	slide: number;
	step: number;
	file: string;
	svg: string;
}

export type SlidesMakerResult =
	| { ok: true; stage: string; frames: SlidesMakerFrame[]; finalState: ResolvedStep; notes: string }
	| { ok: false; notes: string };

export interface SlidesMakerOptions {
	engine: PiEngine;
	headless?: HeadlessApi;
	continuation?: SlidesMakerContinuation;
	/** Max model calls. Default 100 (120 frames at 6 per look is 20 looks). */
	maxIterations?: number;
	onActivity?: (line: string) => void;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	chatId?: string;
}

export const FRAMES_PER_LOOK = 6;
/** Image-bearing messages kept in context; older images become a text note. */
const KEEP_IMAGE_MESSAGES = 2;
const PRUNE_AFTER_IMAGE_MESSAGES = 4;

const INSTRUCTIONS = `You are a slide maker. You draw ONE narrated slide deck in the StatQuest style from a teacher's
script. You never see the lesson; the script is everything you know. You do not decide what to teach:
the teacher already did. Your job is a faithful, precise, readable picture for every build step.

HOW A DECK IS BUILT
- You write ONE stage SVG: the fixed diagram for the whole deck. Every top-level element is a PART with
  a unique id (a part may be a <g> grouping shapes). Only top-level parts can be lit, faded, hidden or
  boxed, so make every number, term, node, curve or label the script will single out its own top-level
  part. <defs>, <style>, <title> need no id.
- Every part that a step may red-box gets a companion <rect id="box-<part id>"> around it, at the
  top level. Boxes are hidden unless a step shows them; code draws a shown box red.
- For each slide you declare each build step's state relative to the stage:
    lit:    ids at full strength; every other part is faded. Omit lit to show everything at full strength.
    hide:   ids not drawn in this step (things that appear later).
    boxes:  part ids whose red box is shown.
    add:    overlay items {id, svg} drawn on top: the pointer text and its curved arrow, equation
            fragments that grow term by term, dots that accumulate on a plot. An addition stays for the
            rest of the slide unless a later step lists its id in remove.
    remove: overlay ids added earlier in this slide.
  Each slide starts with no overlay. Code assembles every frame from stage + state; you never write a
  frame by hand, so the stage stays identical in every frame.
- The stage is the same for every slide: lay it out once with room for everything the script adds
  (equations, dots, captions). Slides change state, not layout.

VISUAL GRAMMAR (StatQuest)
One stage per video. The core diagram (the network, plot, equation ladder or sentence) stays in place
for minutes. Slides change state, not layout. A small data plot (top-left) and the network (centre)
share the stage, and a data card or table is pinned in a corner with the current row red-boxed and the
other rows faded.

Focus by fading. Everything not in play is drawn faded: visible context, clearly not the subject. Only
the active path or term is full strength. Future or masked items are faded too: in masked attention,
the words after the current one are grey.

One clause per change. A caption sentence is split across changes with "…", and each change adds
exactly one element.

Captions. A short caption near the top or beside the focus, with key terms in bold and colour words in
their colour ("green squiggle" in green). Earlier captions linger faded as the next one appears.

Black curved arrows run from the caption (the step's pointer text) to the exact element it talks
about: a number, term, node or point.

Red boxes go around the one number or term in play, and around each computed result. The boxed result
is carried by an arrow to where it's used next ("let's put 0.69 here so we don't forget it"). A dashed
red box marks a sub-expression under discussion (draw a dashed box in the overlay; stage boxes are solid).

Red curved arrows mean "plug this into that" (substitution, flow of a value into the next equation or
function).

Colour is identity, everywhere. Each quantity has one colour across graph, equation, table and code,
exactly as the script's stage declares it, held in every frame. For example:
- Height green, Weight blue, Shoe Size orange; dHeight/dWeight has a green numerator and blue denominator.
- Network paths are blue (top) and orange (bottom); their sum is green.
- Inputs: petal blue, sepal pink, with each input's path in the same colour.
- Classes: Setosa green, Versicolor red/blue, Virginica purple.
- Q / K / V each have their own colour.
- Coordinates: x blue, y pink, and the "old / new / newest" points are each a different colour.
- Embedding columns match their sine/cosine squiggle.
- The long-term memory line is green and the short-term line pink.

Green = known/optimised, red = unknown. The unknown is shown inline as "+ ???" in a red box.

Numbers on the stage.
- Weights and biases sit on the connections in small boxes ("× −34.4", "+ 2.14").
- Inputs and outputs sit in boxes at the ends.
- Symbols are anchored next to the element they name ("x₁,₃ = Input₃ × 3.34 + −1.43" beside the node).
- Equations appear first as a template with names: "(Petal × −2.5) + (Sepal × 0.6) + 1.6 = x-axis
  coordinate", or "e^Setosa / (e^Setosa + e^Versicolor + e^Virginica)". Then the names are replaced
  by numbers in the same colours, and the result is red-boxed.
- When only one part changes between repetitions, that part is boxed ("only the numerator changes").
- Vectors are rows of boxed numbers, column-aligned for vertical arithmetic (embedding + position =
  result).
- Matrices sit beside the diagram they encode, with the same numbers and colours.
- Tables fill in row by row.

Points and plots.
- Each computed result becomes a dot, and the dots accumulate into the curve.
- Red X markers with dotted projection lines pick values off the axes.
- Adding two curves is shown at one x with a vertical dotted line and X marks on each curve and on the
  sum, then swept across.
- A red box on the activation function shows the range used.
- A pink loss curve has sampled points and a moving tangent line.
- Direction-of-change arrows sit on the parameter axis.
- Before/after overlays: the original curve or tangent is faded beside the transformed one (the ×−1
  flip; derivative vs updated derivative).
- Sequential transformations are shown as successive mini-panels left to right, older ones faded.
- Learned parameters are plotted as labelled points before and after training.

Derivation layout (the equation ladder).
- The full chain-rule product sits at the top, colour-coded. The factor being solved is full strength.
- Below it is one row per factor: definition → (thick grey arrow) → derivative. Finished rows stay faded.
- A red box moves over the sub-expression being transformed. Dropped terms get a red X ("these parts
  don't contain the intercept").
- A rule is first written in words as a template ("(d Numerator × Denominator − d Denominator ×
  Numerator) / Denominator²"), then filled with pieces boxed in the original formula.
- Prerequisite facts appear as small NOTE footnotes or red-boxed side facts ("d/dRaw e^S = e^S").
- The result is red-boxed and carried back up into its slot.

Linked-equation stacks. Each line defines what feeds the line above it. The shared quantity is boxed
in both lines with a small arrow, and the chain-rule product gains one factor per link.

Sentences as diagrams. For language topics the sentence itself is the stage. Curved arcs show which
word relates to or attends to which, and later words are faded when masked.

Anatomy by isolation. Fade a complex unit almost entirely and show one line or component at a time
(the cell state, then the hidden state), with tinted background panels per stage.

Orientation map. In long builds, the whole architecture sits faded at the side with the current
component lit ("you are here"), including in code.

Consolidation. Once understood, worked arithmetic collapses into an icon (⊕, a tiny wave, an icon for
softmax), or a big unit shrinks to a simplified box, so the stage can grow.

Code.
- Code is added one line or block at a time, with the current block red-boxed and the rest faded.
- Printed output is shown, and a plot beside it confirms the code reproduces the known curve and numbers.
- Tiny concrete tensor values are shown per line ("if max_len = 3, PE looks like this").
- Old vs new code is compared at the same scale.
- Training curves are read to decide whether to train more.

Style. White background, black sans-serif text, saturated flat colours, generous whitespace. No
characters, no big celebratory text ("BAM!!!"), no photos.

Useful stage patterns: network with boxed weights; plot with accumulating dots; equation template →
numbers; equation ladder; linked-equation stack; sentence-with-arcs; anatomy by isolation; before/after
overlay; pinned data table with the current row boxed.

HARD RULES
- Draw only numbers that appear in the script. Every number in it was already verified; never compute,
  round differently or invent one. Copy them exactly as written (keep "−" signs).
- Each step must show its "show" change and nothing else new. Its "pointer" text (when given) is drawn
  as on-slide words with a black curved arrow to the focus.
- SVG: width="1280" height="720" viewBox="0 0 1280 720", a white background part, sans-serif text
  (font-family="Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif") at sizes readable at that size (16px and up), nothing touching the edges, nothing overlapping. Escape
  "<" and "&" in text as &lt; and &amp;. No scripts, no foreignObject, no external images.

YOUR TOOLS
- write_stage({ svg }): the complete stage SVG (replaces the previous one).
- edit_stage({ old_text, new_text }): one exact replacement in the stage (old_text must occur once).
- set_slide({ slide, steps }): declare one slide's build-step states (one entry per script step, in
  order). You may call it for several slides in one message.
- look({}): render the next frames you have not seen yet (up to ${FRAMES_PER_LOOK}) and show them to you. Before any slide is
  declared, it shows the stage itself.

THE ONE RULE THAT MATTERS MOST: verify by looking. You are done only when you have looked at the current
render of EVERY frame and each is true to its step: the right change is visible, the right parts are lit,
the right box is red, the pointer arrow lands on its target, numbers match the script, nothing is clipped,
overlapping or unreadable. When you fix something, the frames it changed are shown to you again.

Workflow: plan the layout → write_stage → look at it → set_slide for every slide → look until every
frame is seen → fix (edit_stage / write_stage / set_slide) and look again → finish.
Your FINAL message (no tool calls): one or two sentences of notes for the teacher. If the script cannot
be drawn correctly, say exactly why in that message.`;

const stepStateSchema = Type.Object({
	lit: Type.Optional(Type.Array(Type.String(), { description: "Part ids at full strength; every other part is faded. Omit to show all at full strength." })),
	hide: Type.Optional(Type.Array(Type.String(), { description: "Part ids not drawn in this step." })),
	boxes: Type.Optional(Type.Array(Type.String(), { description: 'Part ids whose <rect id="box-<id>"> is shown in red.' })),
	add: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: "Short overlay name, unique within the slide." }),
				svg: Type.String({ description: "SVG fragment (no <svg> root) drawn on top of the stage." }),
			}),
			{ description: "Overlay items added at this step; they persist through the rest of the slide." },
		),
	),
	remove: Type.Optional(Type.Array(Type.String(), { description: "Overlay ids added earlier in this slide to remove." })),
});

export function createSlidesTools(): Record<string, Tool> {
	return {
		write_stage: {
			name: "write_stage",
			description: "Write the complete stage SVG (replaces the previous one).",
			parameters: Type.Object({ svg: Type.String({ description: 'Complete <svg xmlns="http://www.w3.org/2000/svg" …>…</svg> markup.' }) }),
		},
		edit_stage: {
			name: "edit_stage",
			description: "Replace one exact spot in the stage SVG: old_text must appear EXACTLY ONCE.",
			parameters: Type.Object({
				old_text: Type.String({ description: "Exact text to replace; must occur once." }),
				new_text: Type.String({ description: "The replacement." }),
			}),
		},
		set_slide: {
			name: "set_slide",
			description: "Declare one slide's build-step states, one entry per script step, in order (replaces that slide's previous declaration).",
			parameters: Type.Object({
				slide: Type.Integer({ minimum: 1, description: "1-based slide number." }),
				steps: Type.Array(stepStateSchema),
			}),
		},
		look: {
			name: "look",
			description: `Render the next frames you have not seen in their current version (up to ${FRAMES_PER_LOOK}) and show them. No arguments.`,
			parameters: Type.Object({}),
		},
	};
}

/** Every number token the script mentions (normalised: no sign). */
function scriptNumbers(script: ForkSlidesInput): Set<string> {
	const parts: string[] = [script.stage, script.title];
	for (const slide of script.slides)
		for (const step of slide.steps) {
			parts.push(step.say, step.show, step.pointer ?? "");
			for (const n of step.numbers ?? []) parts.push(n.value, n.expr);
		}
	const set = new Set<string>();
	for (const p of parts) for (const m of p.matchAll(/\d+(?:\.\d+)?/g)) set.add(m[0]);
	return set;
}

function scriptText(script: ForkSlidesInput, continuation?: SlidesMakerContinuation): string {
	const lines: string[] = [];
	lines.push(`Title: ${script.title}`);
	lines.push(
		script.kind === "subject"
			? `Kind: subject video, part ${script.part} of ${script.of} (this part has its own stage; the parts play back to back)`
			: `Kind: ${script.kind}`,
	);
	lines.push("", "STAGE (the fixed diagram, from the teacher):", script.stage, "");
	script.slides.forEach((slide, i) => {
		lines.push(`SLIDE ${i + 1} (${slide.steps.length} step${slide.steps.length === 1 ? "" : "s"})`);
		slide.steps.forEach((step, j) => {
			lines.push(`  step ${j + 1}`);
			lines.push(`    say: ${step.say}`);
			lines.push(`    show: ${step.show}`);
			if (step.pointer) lines.push(`    pointer: ${step.pointer}`);
			for (const n of step.numbers ?? []) lines.push(`    number: ${n.value}   (= ${n.expr}, verified)`);
		});
	});
	if (continuation) {
		lines.push(
			"",
			"THIS DECK CONTINUES AN EARLIER ONE. Its stage SVG is already loaded as your stage (below): keep it,",
			"and add only what is new (edit_stage, or write_stage keeping every existing part as it is). Slide 1",
			"starts with the earlier deck's final overlay, listed below; remove items you no longer need.",
			"",
			"Earlier stage SVG:",
			continuation.stage,
			"",
			`Earlier final overlay: ${JSON.stringify(continuation.finalOverlay)}`,
		);
	}
	return lines.join("\n");
}

interface FrameRef {
	slide: number;
	step: number;
	key: string;
}

export async function runSlidesMaker(script: ForkSlidesInput, opts: SlidesMakerOptions): Promise<SlidesMakerResult> {
	const headless = opts.headless ?? getHeadless();
	const reason = headless.unavailableReason();
	if (reason) return { ok: false, notes: `FAILED: ${reason}` };
	const maxIterations = opts.maxIterations ?? 100;
	const engine = opts.engine;
	const tools = Object.values(createSlidesTools());
	const sessionId = randomUUID();
	const knownNumbers = scriptNumbers(script);
	const observer = opts.chatId ? providerEventObserver(opts.chatId, "job:slides") : undefined;

	let stageSrc: string | null = opts.continuation?.stage ?? null;
	let stage: ParsedStage | null = null;
	if (stageSrc) {
		try {
			stage = parseStage(stageSrc);
		} catch (err) {
			return { ok: false, notes: `FAILED: the earlier deck's stage could not be loaded — ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	/** Declared step states per slide (0-based slide index). */
	const declared = new Map<number, StepState[]>();
	/** The svg last shown to the model per frame key. */
	const shown = new Map<string, string>();
	let stagePreviewShown: string | null = null;

	const initialOverlay = (slideIdx: number): OverlayItem[] => (slideIdx === 0 ? opts.continuation?.finalOverlay ?? [] : []);
	const allRefs: FrameRef[] = [];
	script.slides.forEach((s, i) => s.steps.forEach((_, j) => allRefs.push({ slide: i, step: j, key: `${i + 1}.${j + 1}` })));

	/** Current frame SVGs (only for declared slides). */
	const currentFrames = (): Map<string, string> => {
		const out = new Map<string, string>();
		if (!stage) return out;
		for (const [slideIdx, steps] of declared) {
			resolveSlide(steps, initialOverlay(slideIdx)).forEach((state, j) => out.set(`${slideIdx + 1}.${j + 1}`, assembleFrame(stage!, state)));
		}
		return out;
	};
	const unlooked = (): FrameRef[] => {
		const frames = currentFrames();
		return allRefs.filter((r) => frames.has(r.key) && shown.get(r.key) !== frames.get(r.key));
	};
	const undeclared = (): number[] => script.slides.map((_, i) => i).filter((i) => !declared.has(i));

	const numberWarning = (svgs: string[]): string => {
		const unknown = new Set<string>();
		for (const svg of svgs) for (const n of visibleNumbers(svg)) if (!knownNumbers.has(n)) unknown.add(n);
		return unknown.size
			? ` WARNING: these numbers are not in the script: ${[...unknown].slice(0, 12).join(", ")}. Draw only the script's numbers (labels like axis ticks must come from the script too).`
			: "";
	};

	/** Re-check declared slides after a stage change; drop those that no longer fit. */
	const revalidate = (): string => {
		if (!stage) return "";
		const dropped: string[] = [];
		for (const [slideIdx, steps] of [...declared]) {
			const problems = stepProblems(stage, steps, `slide ${slideIdx + 1}`, initialOverlay(slideIdx));
			if (problems.length) {
				declared.delete(slideIdx);
				dropped.push(`slide ${slideIdx + 1}: ${problems[0]}`);
			}
		}
		return dropped.length ? ` These slides no longer fit the stage and must be set again: ${dropped.join("; ")}` : "";
	};

	const renderFrames = async (
		refs: Array<{ label: string; key: string | null; svg: string }>,
	): Promise<{ content: Array<TextContent | ImageContent>; shownKeys: string[]; errors: string[] }> => {
		const content: Array<TextContent | ImageContent> = [];
		const shownKeys: string[] = [];
		const errors: string[] = [];
		for (const ref of refs) {
			let png: Buffer;
			try {
				png = await headless.renderSvg(ref.svg);
			} catch (err) {
				errors.push(`${ref.label}: RENDER ERROR — ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			const image = await processImage(png, "image/png", { resizeOptions: engine.model.inputLimits?.images?.resize });
			opts.abortSignal?.throwIfAborted();
			if (!image.ok) {
				errors.push(`${ref.label}: could not be inspected — ${image.message}`);
				continue;
			}
			content.push({ type: "text", text: [ref.label, ...image.hints].join("\n") });
			content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			if (ref.key) {
				shown.set(ref.key, ref.svg);
				shownKeys.push(ref.key);
			}
		}
		return { content, shownKeys, errors };
	};

	const frameLabel = (r: FrameRef): string => {
		const step = script.slides[r.slide]!.steps[r.step]!;
		return `Frame ${r.key} (slide ${r.slide + 1}, step ${r.step + 1}) — say: "${step.say}" — show: ${step.show}${step.pointer ? ` — pointer: "${step.pointer}"` : ""}`;
	};

	/** Render the next unlooked batch (or the stage preview). null = nothing to show. */
	const nextLook = async (): Promise<{ text: string; content: Array<TextContent | ImageContent> } | null> => {
		if (!stage || !stageSrc) return null;
		const pending = unlooked();
		if (pending.length === 0) {
			if (declared.size === 0 && stagePreviewShown !== stageSrc) {
				const preview = assembleFrame(stage, { hide: [], boxes: [], overlay: [] });
				const r = await renderFrames([{ label: "The stage (no slide declared yet; boxes hidden, nothing faded)", key: null, svg: preview }]);
				if (r.content.length) stagePreviewShown = stageSrc;
				return { text: r.errors.length ? r.errors.join("\n") : "The stage render follows.", content: r.content };
			}
			return null;
		}
		const batch = pending.slice(0, FRAMES_PER_LOOK);
		const frames = currentFrames();
		const r = await renderFrames(batch.map((ref) => ({ label: frameLabel(ref), key: ref.key, svg: frames.get(ref.key)! })));
		opts.onActivity?.(`look: ${r.shownKeys.length} frame${r.shownKeys.length === 1 ? "" : "s"} (${unlooked().length} unseen left)`);
		const left = unlooked().length;
		const text = [
			r.shownKeys.length ? `Frames ${r.shownKeys.join(", ")} follow. Check each against its step.` : "",
			...r.errors,
			r.errors.length ? "Fix the frames that failed to render (malformed overlay or stage SVG)." : "",
			left ? `${left} frame${left === 1 ? "" : "s"} not yet seen in their current version.` : "Every declared frame's current version has now been shown.",
			undeclared().length ? `Slides not declared yet: ${undeclared().map((i) => i + 1).join(", ")}.` : "",
		]
			.filter(Boolean)
			.join("\n");
		return { text, content: r.content };
	};

	const prompt = [
		"The teacher's script (verbatim; it is everything you know):",
		"",
		scriptText(script, opts.continuation),
		"",
		"Write the stage, look at it, declare every slide, look at every frame, fix what is wrong, then finish with your notes.",
	].join("\n");
	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	let finalText = "";

	const pushImages = (text: string, content: Array<TextContent | ImageContent>) => {
		messages = [...messages, { role: "user", content: [{ type: "text", text }, ...content], timestamp: Date.now() }];
		messages = pruneImages(messages);
	};

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const result = await streamOnce(engine, INSTRUCTIONS, messages, tools, sessionId, opts.abortSignal, observer);
			opts.onUsage?.(result.usage);
			messages = [...messages, result];
			const toolCalls = result.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");

			if (toolCalls.length === 0) {
				finalText = result.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
				// THE LOOK GATE: refuse to finish until the deck is complete and
				// every frame's current version has been shown.
				if (!stage) {
					messages = [...messages, userText("You have not written a valid stage yet. Call write_stage, then declare every slide and look at every frame.")];
					continue;
				}
				const missing = undeclared();
				if (missing.length) {
					messages = [...messages, userText(`You cannot finish yet: slides ${missing.map((i) => i + 1).join(", ")} are not declared. Call set_slide for each, then look at their frames.`)];
					continue;
				}
				const look = await nextLook();
				if (look) {
					opts.onActivity?.("look: showing unseen frames before finishing");
					pushImages(`You cannot finish while some frames are unseen. ${look.text}\nIf every frame is right, reply with just your notes; otherwise fix and look again.`, look.content);
					continue;
				}
				return finishDeck(stage, stageSrc!, declared, script, initialOverlay, finalText);
			}

			const results: ToolResultMessage[] = [];
			let lookContent: { text: string; content: Array<TextContent | ImageContent> } | null = null;
			for (const call of toolCalls) {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				if (call.name === "write_stage" || call.name === "edit_stage") {
					let next: string;
					if (call.name === "write_stage") {
						if (typeof args.svg !== "string" || !args.svg.includes("<svg")) {
							results.push(toolText(call, "ERROR: expected a complete <svg>…</svg> document in `svg`."));
							continue;
						}
						next = args.svg;
					} else {
						if (!stageSrc) {
							results.push(toolText(call, "ERROR: nothing to edit; call write_stage first."));
							continue;
						}
						if (typeof args.old_text !== "string" || !args.old_text || typeof args.new_text !== "string") {
							results.push(toolText(call, "ERROR: expected old_text (non-empty) and new_text strings."));
							continue;
						}
						const count = stageSrc.split(args.old_text).length - 1;
						if (count !== 1) {
							results.push(toolText(call, `ERROR: old_text occurs ${count} times; it must occur exactly once.`));
							continue;
						}
						next = stageSrc.replace(args.old_text, () => args.new_text as string);
					}
					try {
						const parsed = parseStage(next);
						stageSrc = next;
						stage = parsed;
						const dropped = revalidate();
						opts.onActivity?.(`${call.name}: ${parsed.partIds.length} parts`);
						results.push(
							toolText(
								call,
								`Stage saved: ${parsed.partIds.length} parts (${parsed.partIds.join(", ")}); boxes for: ${[...parsed.boxes.keys()].join(", ") || "none"}.${dropped}${numberWarning([next])}`,
							),
						);
					} catch (err) {
						const problems = err instanceof StageError ? err.problems : [err instanceof Error ? err.message : String(err)];
						results.push(toolText(call, `ERROR: the stage was not saved:\n${problems.map((p) => `- ${p}`).join("\n")}`));
					}
				} else if (call.name === "set_slide") {
					const slide = typeof args.slide === "number" ? args.slide : NaN;
					const steps = Array.isArray(args.steps) ? (args.steps as StepState[]) : null;
					if (!stage) {
						results.push(toolText(call, "ERROR: write the stage first."));
						continue;
					}
					if (!Number.isInteger(slide) || slide < 1 || slide > script.slides.length) {
						results.push(toolText(call, `ERROR: slide must be 1–${script.slides.length}.`));
						continue;
					}
					const expected = script.slides[slide - 1]!.steps.length;
					if (!steps || steps.length !== expected) {
						results.push(toolText(call, `ERROR: slide ${slide} has ${expected} script step${expected === 1 ? "" : "s"}; give exactly ${expected} step state${expected === 1 ? "" : "s"}.`));
						continue;
					}
					const problems = stepProblems(stage, steps, `slide ${slide}`, initialOverlay(slide - 1));
					if (problems.length) {
						results.push(toolText(call, `ERROR: slide ${slide} was not saved:\n${problems.map((p) => `- ${p}`).join("\n")}`));
						continue;
					}
					declared.set(slide - 1, steps);
					opts.onActivity?.(`set_slide: slide ${slide} of ${script.slides.length}`);
					const overlays = steps.flatMap((s) => (s.add ?? []).map((a) => a.svg));
					results.push(toolText(call, `Slide ${slide} saved (${expected} frame${expected === 1 ? "" : "s"}). Call look to see its frames.${numberWarning(overlays)}`));
				} else if (call.name === "look") {
					if (lookContent) {
						results.push(toolText(call, "Already looking in this message; the frames follow."));
						continue;
					}
					const look = await nextLook();
					if (!look) {
						results.push(
							toolText(
								call,
								!stage
									? "ERROR: nothing to look at; write the stage first."
									: undeclared().length
										? `Nothing new to show. Slides not declared yet: ${undeclared().map((i) => i + 1).join(", ")}.`
										: "Every frame's current version has been shown. If all are right, finish with your notes.",
							),
						);
						continue;
					}
					lookContent = look;
					results.push(toolText(call, look.content.length ? "Rendered; the images follow in the next message." : look.text));
					if (!look.content.length) lookContent = null;
				} else {
					results.push(toolText(call, `ERROR: unknown tool "${call.name}". Use write_stage, edit_stage, set_slide or look.`));
				}
			}
			messages = [...messages, ...results];
			if (lookContent) pushImages(lookContent.text, lookContent.content);
		}
	} catch (err) {
		if (opts.abortSignal?.aborted) throw err;
		return { ok: false, notes: `FAILED: the slide maker crashed — ${err instanceof Error ? err.message : String(err)}` };
	}
	const left = unlooked().length;
	const missing = undeclared().length;
	return {
		ok: false,
		notes: `FAILED: iteration limit (${maxIterations}) reached before every frame was drawn and looked at (${missing} slide${missing === 1 ? "" : "s"} undeclared, ${left} frame${left === 1 ? "" : "s"} unseen). Re-call slides with a shorter or simpler script.`,
	};
}

function finishDeck(
	stage: ParsedStage,
	stageSrc: string,
	declared: Map<number, StepState[]>,
	script: ForkSlidesInput,
	initialOverlay: (slideIdx: number) => OverlayItem[],
	notes: string,
): SlidesMakerResult {
	const frames: SlidesMakerFrame[] = [];
	let finalState: ResolvedStep = { hide: [], boxes: [], overlay: [] };
	script.slides.forEach((_, i) => {
		resolveSlide(declared.get(i)!, initialOverlay(i)).forEach((state, j) => {
			frames.push({ slide: i + 1, step: j + 1, file: frameFileName(i + 1, j + 1), svg: assembleFrame(stage, state) });
			finalState = state;
		});
	});
	return { ok: true, stage: stageSrc, frames, finalState, notes: notes || "Deck drawn and every frame checked." };
}

/** Keep images only in the last few image-bearing messages (context size). */
function pruneImages(messages: Message[]): Message[] {
	const imageIdx = messages
		.map((m, i) => (m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image") ? i : -1))
		.filter((i) => i >= 0);
	if (imageIdx.length <= PRUNE_AFTER_IMAGE_MESSAGES) return messages;
	const drop = new Set(imageIdx.slice(0, imageIdx.length - KEEP_IMAGE_MESSAGES));
	return messages.map((m, i) => {
		if (!drop.has(i) || m.role !== "user" || !Array.isArray(m.content)) return m;
		return { ...m, content: [...m.content.filter((c) => c.type === "text"), { type: "text", text: "[The images above were shown earlier and removed to save space.]" }] };
	});
}

function userText(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

function toolText(call: { id: string; name: string }, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: text.startsWith("ERROR:"),
		timestamp: Date.now(),
	};
}

/** One raw model call: drain the stream to the final AssistantMessage. */
async function streamOnce(
	engine: PiEngine,
	systemPrompt: string,
	messages: Message[],
	tools: Tool[],
	sessionId: string,
	abortSignal?: AbortSignal,
	onProviderStreamEvent?: unknown,
): Promise<AssistantMessage> {
	const reasoning = engine.level;
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt, messages, tools }), {
		sessionId,
		reasoning: reasoning && reasoning !== "off" ? reasoning : undefined,
		signal: abortSignal,
		onProviderStreamEvent: onProviderStreamEvent as never,
	} as never);
	for await (const event of stream) {
		if (event.type === "done") return event.message;
		if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}
	throw new Error("the model stream ended without a result");
}
