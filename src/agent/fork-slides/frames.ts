/**
 * Fork-only: slide frames are ASSEMBLED BY CODE from one stage SVG plus a
 * per-step state, never hand-written per frame, so the stage cannot drift
 * between frames (FORK.md "StatQuest method and slide decks").
 *
 * The stage: a root <svg> whose top-level children are its PARTS, each with
 * a unique id. A part `box-<id>` is the red box of part <id>: a <rect>,
 * hidden unless a step shows it. Non-drawing children (defs, style, title,
 * desc, metadata) need no id and pass through untouched.
 *
 * A step state (all fields relative to the stage):
 *   lit    ids drawn at full strength; when given, every other part is faded
 *          to FADE_OPACITY. Absent = every part at full strength.
 *   hide   ids not drawn in this step.
 *   boxes  ids whose box-<id> is shown, forced red.
 *   add    overlay items {id, svg} drawn on top (pointer text, curved
 *          arrows, equation fragments). Additions persist from step to step
 *          within a slide until listed in `remove`.
 *   remove ids of overlay items added earlier in this slide.
 * Each slide starts with no overlay (a continued deck's slide 1 starts with
 * the earlier deck's final overlay).
 */

export const FADE_OPACITY = 0.2;
export const BOX_RED = "#e3262b";
export const BOX_PREFIX = "box-";

/** Top-level children that are not drawn parts. */
const PASS_THROUGH = new Set(["defs", "style", "title", "desc", "metadata"]);

export interface OverlayItem {
	id: string;
	svg: string;
}

export interface StepState {
	lit?: string[];
	hide?: string[];
	boxes?: string[];
	add?: OverlayItem[];
	remove?: string[];
}

/** A step's state with the slide's accumulated overlay resolved. */
export interface ResolvedStep {
	lit?: string[];
	hide: string[];
	boxes: string[];
	overlay: OverlayItem[];
}

interface StageNode {
	/** The node's full source. */
	src: string;
	/** Element name (lower-case) for element nodes; null for text/comments. */
	tag: string | null;
	id: string | null;
	/** Start-tag source (element nodes only). */
	startTag: string;
	selfClosing: boolean;
}

export interface ParsedStage {
	/** Everything up to and including the root start tag. */
	head: string;
	nodes: StageNode[];
	/** The root close tag and anything after it. */
	tail: string;
	partIds: string[];
	/** Part id → its box id, for parts that have a companion box. */
	boxes: Map<string, string>;
	width: number | null;
	height: number | null;
}

const TOKEN_RE =
	/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[A-Za-z][\w:.-]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*\s*\/?>/g;

function tagName(tag: string): string {
	return /^<\/?([A-Za-z][\w:.-]*)/.exec(tag)![1]!.toLowerCase();
}

function attr(tag: string, name: string): string | null {
	const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i");
	const m = re.exec(tag);
	return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Walk a markup string: every tag balanced, no unsafe content. Returns problems. */
export function markupProblems(src: string, label: string): string[] {
	const problems: string[] = [];
	if (/<script\b/i.test(src)) problems.push(`${label}: <script> is not allowed.`);
	if (/<foreignObject\b/i.test(src)) problems.push(`${label}: <foreignObject> is not allowed.`);
	if (/\son[a-z]+\s*=/i.test(src.replace(/<!--[\s\S]*?-->/g, ""))) problems.push(`${label}: event-handler attributes are not allowed.`);
	const stack: string[] = [];
	for (const m of src.matchAll(TOKEN_RE)) {
		const tok = m[0];
		if (!tok.startsWith("<") || tok.startsWith("<!") || tok.startsWith("<?")) continue;
		const name = tagName(tok);
		if (tok.startsWith("</")) {
			const open = stack.pop();
			if (open !== name) {
				problems.push(`${label}: </${name}> closes ${open ? `<${open}>` : "nothing"}.`);
				return problems;
			}
		} else if (!tok.endsWith("/>")) stack.push(name);
	}
	// Stray "<" that is not a tag (e.g. "a < b" in text) breaks XML parsing.
	const stripped = src.replace(TOKEN_RE, "");
	if (stripped.includes("<")) problems.push(`${label}: a bare "<" in text; write &lt; instead.`);
	if (/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/.test(stripped)) problems.push(`${label}: a bare "&" in text; write &amp; instead.`);
	if (stack.length > 0) problems.push(`${label}: <${stack[stack.length - 1]}> is never closed.`);
	return problems;
}

/** Parse a stage SVG into its top-level parts. Throws with every problem found. */
export function parseStage(svg: string): ParsedStage {
	const problems = markupProblems(svg, "stage");
	if (problems.length) throw new StageError(problems);
	const tokens = [...svg.matchAll(TOKEN_RE)].filter((m) => !m[0].startsWith("<!") && !m[0].startsWith("<?"));
	const rootIdx = tokens.findIndex((m) => /^<svg[\s>]/i.test(m[0]));
	if (rootIdx < 0) throw new StageError(["stage: no <svg> root element."]);
	const root = tokens[rootIdx]!;
	if (root[0].endsWith("/>")) throw new StageError(["stage: the <svg> root is empty."]);
	const head = svg.slice(0, root.index! + root[0].length);
	const nodes: StageNode[] = [];
	let depth = 0;
	let cursor = head.length;
	let current: { start: number; startTag: string } | null = null;
	let tailStart = -1;
	for (let i = rootIdx + 1; i < tokens.length; i++) {
		const m = tokens[i]!;
		const tok = m[0];
		const at = m.index!;
		if (tok.startsWith("</")) {
			if (depth === 0) {
				// The root's close tag.
				if (at > cursor) nodes.push(textNode(svg.slice(cursor, at)));
				tailStart = at;
				break;
			}
			depth--;
			if (depth === 0 && current) {
				const end = at + tok.length;
				nodes.push(elementNode(svg.slice(current.start, end), current.startTag, false));
				cursor = end;
				current = null;
			}
			continue;
		}
		const selfClosing = tok.endsWith("/>");
		if (depth === 0) {
			if (at > cursor) nodes.push(textNode(svg.slice(cursor, at)));
			if (selfClosing) {
				nodes.push(elementNode(tok, tok, true));
				cursor = at + tok.length;
			} else {
				current = { start: at, startTag: tok };
				depth = 1;
			}
			continue;
		}
		if (!selfClosing) depth++;
	}
	if (tailStart < 0) throw new StageError(["stage: the <svg> root is never closed."]);
	const tail = svg.slice(tailStart);

	const errors: string[] = [];
	const seen = new Set<string>();
	const partIds: string[] = [];
	for (const n of nodes) {
		if (!n.tag || PASS_THROUGH.has(n.tag)) continue;
		if (!n.id) {
			errors.push(`stage: a top-level <${n.tag}> has no id (every top-level part needs a unique id): ${n.startTag.slice(0, 80)}`);
			continue;
		}
		if (seen.has(n.id)) errors.push(`stage: duplicate part id "${n.id}".`);
		seen.add(n.id);
		partIds.push(n.id);
	}
	const boxes = new Map<string, string>();
	for (const n of nodes) {
		if (!n.id?.startsWith(BOX_PREFIX)) continue;
		const target = n.id.slice(BOX_PREFIX.length);
		if (n.tag !== "rect") errors.push(`stage: box "${n.id}" must be a <rect>.`);
		if (!seen.has(target)) errors.push(`stage: box "${n.id}" has no part "${target}" to box.`);
		boxes.set(target, n.id);
	}
	const width = numericAttr(root[0], "width");
	const height = numericAttr(root[0], "height");
	if (width === null || height === null) errors.push('stage: the <svg> root needs numeric width and height (e.g. width="1280" height="720").');
	if (attr(root[0], "viewBox") === null) errors.push('stage: the <svg> root needs a viewBox (e.g. viewBox="0 0 1280 720").');
	if (errors.length) throw new StageError(errors);
	return { head, nodes, tail, partIds, boxes, width, height };
}

export class StageError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("\n"));
	}
}

function numericAttr(tag: string, name: string): number | null {
	const v = attr(tag, name);
	if (v === null) return null;
	const m = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/.exec(v);
	return m ? Number(m[1]) : null;
}

function textNode(src: string): StageNode {
	return { src, tag: null, id: null, startTag: "", selfClosing: false };
}

function elementNode(src: string, startTag: string, selfClosing: boolean): StageNode {
	return { src, tag: tagName(startTag), id: attr(startTag, "id"), startTag, selfClosing };
}

/** Check one slide's step states against the stage; returns problems. */
export function stepProblems(stage: ParsedStage, steps: StepState[], slideLabel: string, initialOverlay: OverlayItem[] = []): string[] {
	const problems: string[] = [];
	const parts = new Set(stage.partIds);
	let overlayIds = new Set(initialOverlay.map((o) => o.id));
	steps.forEach((step, i) => {
		const label = `${slideLabel}, step ${i + 1}`;
		for (const id of step.lit ?? []) if (!parts.has(id)) problems.push(`${label}: lit "${id}" is not a stage part.`);
		for (const id of step.hide ?? []) if (!parts.has(id)) problems.push(`${label}: hide "${id}" is not a stage part.`);
		for (const id of step.boxes ?? [])
			if (!stage.boxes.has(id)) problems.push(`${label}: boxes "${id}" has no <rect id="${BOX_PREFIX}${id}"> on the stage.`);
		for (const id of step.remove ?? []) {
			if (!overlayIds.has(id)) problems.push(`${label}: remove "${id}" is not an overlay item present at this step.`);
		}
		overlayIds = new Set([...overlayIds].filter((id) => !(step.remove ?? []).includes(id)));
		for (const item of step.add ?? []) {
			if (!/^[A-Za-z][\w-]{0,40}$/.test(item.id)) problems.push(`${label}: overlay id "${item.id}" must be a short name (letters, digits, - or _).`);
			if (overlayIds.has(item.id)) problems.push(`${label}: overlay "${item.id}" is already present (remove it first, or use a new id).`);
			problems.push(...markupProblems(item.svg, `${label}, overlay "${item.id}"`));
			overlayIds.add(item.id);
		}
	});
	return problems;
}

/** Resolve a slide's steps: each step's overlay is the running accumulation. */
export function resolveSlide(steps: StepState[], initialOverlay: OverlayItem[] = []): ResolvedStep[] {
	let overlay = [...initialOverlay];
	return steps.map((step) => {
		const removed = new Set(step.remove ?? []);
		overlay = [...overlay.filter((o) => !removed.has(o.id)), ...(step.add ?? [])];
		return {
			...(step.lit ? { lit: [...step.lit] } : {}),
			hide: [...(step.hide ?? [])],
			boxes: [...(step.boxes ?? [])],
			overlay: [...overlay],
		};
	});
}

/** Rewrite a box's start tag: drop its own paint and visibility, force red. */
function redBox(startTag: string): string {
	const stripped = startTag.replace(
		/\s(?:fill|stroke|stroke-width|stroke-opacity|fill-opacity|display|visibility|opacity|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi,
		"",
	);
	return stripped.replace(/\s*(\/?)>$/, ` fill="none" stroke="${BOX_RED}" stroke-width="3"$1>`);
}

/** Every frame's first child: a white background, guaranteed by code (a stage
 *  without its own background would otherwise show through to whatever is
 *  behind the image, e.g. the app's dark background in fullscreen). */
export const FRAME_BACKGROUND = '<rect width="100%" height="100%" fill="#fff"/>';

/** Assemble one frame: stage + resolved state → frame SVG (pure, deterministic). */
export function assembleFrame(stage: ParsedStage, state: ResolvedStep): string {
	const lit = state.lit ? new Set(state.lit) : null;
	const hide = new Set(state.hide);
	const shownBoxes = new Set(state.boxes.map((id) => `${BOX_PREFIX}${id}`));
	let body = FRAME_BACKGROUND;
	for (const n of stage.nodes) {
		if (!n.tag || PASS_THROUGH.has(n.tag) || !n.id) {
			body += n.src;
			continue;
		}
		if (n.id.startsWith(BOX_PREFIX) && stage.boxes.has(n.id.slice(BOX_PREFIX.length))) {
			if (shownBoxes.has(n.id)) body += n.selfClosing ? redBox(n.src) : redBox(n.startTag) + n.src.slice(n.startTag.length);
			continue;
		}
		if (hide.has(n.id)) continue;
		if (lit && !lit.has(n.id)) body += `<g opacity="${FADE_OPACITY}">${n.src}</g>`;
		else body += n.src;
	}
	for (const item of state.overlay) body += `<g data-overlay="${item.id}">${item.svg}</g>`;
	return stage.head + body + stage.tail;
}

/** Numbers in an SVG's visible text (style blocks and comments excluded). */
export function visibleNumbers(svg: string): string[] {
	const text = svg
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>/g, " ");
	return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}
