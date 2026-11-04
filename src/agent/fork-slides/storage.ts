/**
 * Fork-only: where a slides job's assets live. Frame SVGs stay on disk (not
 * inline in the chat record, which keeps chat files small for the long-chat
 * work): <data root>/fork-slides/<jobId>/. The data root is derived from
 * upstream's exported SETTINGS_FILE, so config.ts stays untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTINGS_FILE } from "../../../config.ts";
import { FORK_SLIDES_FILE_RE, FORK_SLIDES_JOB_ID_RE, FORK_SLIDES_STAGE_FILE } from "../../core/fork-slides.ts";
import type { OverlayItem, ResolvedStep } from "./frames.ts";

/** The final state of a deck, kept so a later deck can continue it. */
export interface ForkSlidesStates {
	finalState: ResolvedStep;
	/** The overlay present at the end of the last step (same as finalState.overlay). */
	finalOverlay: OverlayItem[];
}

export const FORK_SLIDES_STATES_FILE = "states.json";

export function forkSlidesRoot(): string {
	return path.join(path.dirname(SETTINGS_FILE), "fork-slides");
}

/** The job's asset folder; null for an id that is not a job id. */
export function forkSlidesDir(jobId: string): string | null {
	if (!FORK_SLIDES_JOB_ID_RE.test(jobId)) return null;
	return path.join(forkSlidesRoot(), jobId);
}

/** Resolve a servable asset path; null for anything that is not one. */
export function forkSlidesAssetPath(jobId: string, file: string): string | null {
	const dir = forkSlidesDir(jobId);
	if (!dir || !FORK_SLIDES_FILE_RE.test(file)) return null;
	const full = path.join(dir, file);
	// Belt and braces: the regexes already exclude separators and dots.
	return path.dirname(full) === dir ? full : null;
}

/** Write a finished deck's files (stage, frames, final state). */
export function writeForkSlidesAssets(
	jobId: string,
	files: { stage: string; frames: Array<{ file: string; svg: string }>; states: ForkSlidesStates },
): void {
	const dir = forkSlidesDir(jobId);
	if (!dir) throw new Error(`invalid job id for slide assets: ${jobId}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, FORK_SLIDES_STAGE_FILE), files.stage, "utf-8");
	for (const f of files.frames) {
		if (!FORK_SLIDES_FILE_RE.test(f.file)) throw new Error(`invalid frame file name: ${f.file}`);
		fs.writeFileSync(path.join(dir, f.file), f.svg, "utf-8");
	}
	fs.writeFileSync(path.join(dir, FORK_SLIDES_STATES_FILE), JSON.stringify(files.states, null, "\t"), "utf-8");
}

/** Read an earlier deck's stage and final state (for `continues`); null if missing. */
export function readForkSlidesContinuation(jobId: string): { stage: string; states: ForkSlidesStates } | null {
	const dir = forkSlidesDir(jobId);
	if (!dir) return null;
	try {
		const stage = fs.readFileSync(path.join(dir, FORK_SLIDES_STAGE_FILE), "utf-8");
		const states = JSON.parse(fs.readFileSync(path.join(dir, FORK_SLIDES_STATES_FILE), "utf-8")) as ForkSlidesStates;
		return { stage, states };
	} catch {
		return null;
	}
}

/** Read one servable asset as text; null when missing or not servable. */
export function readForkSlidesAsset(jobId: string, file: string): string | null {
	const full = forkSlidesAssetPath(jobId, file);
	if (!full) return null;
	try {
		return fs.readFileSync(full, "utf-8");
	} catch {
		return null;
	}
}
