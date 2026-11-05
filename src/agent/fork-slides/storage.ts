/**
 * Fork-only: where a slides job's assets live. Frame SVGs stay on disk (not
 * inline in the chat record, which keeps chat files small for the long-chat
 * work): <data root>/fork-slides/<jobId>/. The data root is derived from
 * upstream's exported SETTINGS_FILE, so config.ts stays untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, SETTINGS_FILE } from "../../../config.ts";
// Upstream's crash-safe file replacement: a pure fs helper with no store
// state, imported directly so no upstream file changes.
// eslint-disable-next-line import/no-restricted-paths
import { removeLeftoverTemps, writeFileAtomicSync } from "../../store/atomic-write.ts";
import {
	FORK_SLIDES_AUDIO_RE,
	FORK_SLIDES_FILE_RE,
	FORK_SLIDES_JOB_ID_RE,
	FORK_SLIDES_STAGE_FILE,
	stageFileName,
	type ForkSlidesInput,
	type ForkSlidesPartsKind,
} from "../../core/fork-slides.ts";
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

/** Write a finished deck's files (stage, frames, final state). A subject or
 *  recap video part writes its own prefixed stage and no final state (neither
 *  is ever continued). */
export function writeForkSlidesAssets(
	jobId: string,
	files: { stage: string; frames: Array<{ file: string; svg: string }>; states?: ForkSlidesStates; part?: number },
): void {
	const dir = forkSlidesDir(jobId);
	if (!dir) throw new Error(`invalid job id for slide assets: ${jobId}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, stageFileName(files.part)), files.stage, "utf-8");
	for (const f of files.frames) {
		if (!FORK_SLIDES_FILE_RE.test(f.file)) throw new Error(`invalid frame file name: ${f.file}`);
		fs.writeFileSync(path.join(dir, f.file), f.svg, "utf-8");
	}
	if (files.states) fs.writeFileSync(path.join(dir, FORK_SLIDES_STATES_FILE), JSON.stringify(files.states, null, "\t"), "utf-8");
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

/** Read one servable asset as bytes; null when missing or not servable. */
export function readForkSlidesAssetBytes(jobId: string, file: string): Buffer | null {
	const full = forkSlidesAssetPath(jobId, file);
	if (!full) return null;
	try {
		return fs.readFileSync(full);
	} catch {
		return null;
	}
}

/** Remove a job's narration files (after a failed synthesis). */
export function removeForkSlidesAudio(jobId: string): void {
	const dir = forkSlidesDir(jobId);
	if (!dir) return;
	try {
		for (const f of fs.readdirSync(dir)) if (FORK_SLIDES_AUDIO_RE.test(f)) fs.rmSync(path.join(dir, f), { force: true });
	} catch {
		/* nothing to remove */
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

// ─── subject and recap video parts, collected per chat until every part is in ─

/** One chat's subject (or recap) video parts received so far (the same `of` and `minutes` on each). */
export interface SubjectPartsCollection {
	of: number;
	minutes: number;
	/** Sorted by part number; at most one entry per part. */
	parts: Array<{ toolCallId: string; input: ForkSlidesInput }>;
}

/** Chat ids the collection accepts: the chat store's own id alphabet, no dots or slashes. */
const CHAT_ID_RE = /^chat_[A-Za-z0-9_-]{1,60}$/;

/** Each parts kind keeps its own collection folder, so a subject video and a
 *  recap video collected in the same chat never interfere. */
const PARTS_DIRS: Record<ForkSlidesPartsKind, string> = { subject: "subject-parts", recap: "recap-parts" };

function partsFile(kind: ForkSlidesPartsKind, chatId: string): string | null {
	return CHAT_ID_RE.test(chatId) ? path.join(forkSlidesRoot(), PARTS_DIRS[kind], `${chatId}.json`) : null;
}

/** The chat's collected parts of this kind; null when none (or an id that is not a chat id). */
export function readPartsCollection(kind: ForkSlidesPartsKind, chatId: string): SubjectPartsCollection | null {
	const file = partsFile(kind, chatId);
	if (!file) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as SubjectPartsCollection;
	} catch {
		return null;
	}
}

export function writePartsCollection(kind: ForkSlidesPartsKind, chatId: string, collection: SubjectPartsCollection): void {
	const file = partsFile(kind, chatId);
	if (!file) throw new Error(`invalid chat id for ${kind} parts: ${chatId}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, JSON.stringify(collection));
}

export function clearPartsCollection(kind: ForkSlidesPartsKind, chatId: string): void {
	const file = partsFile(kind, chatId);
	if (!file) return;
	fs.rmSync(file, { force: true });
	removeLeftoverTemps(file);
}

/** The subject video's collection (the parts-kind functions above, kind "subject"). */
export const readSubjectParts = (chatId: string) => readPartsCollection("subject", chatId);
export const writeSubjectParts = (chatId: string, collection: SubjectPartsCollection) => writePartsCollection("subject", chatId, collection);
export const clearSubjectParts = (chatId: string) => clearPartsCollection("subject", chatId);

// ─── the orphan sweep (run at the start of each slides job) ─────────────────

/** Where the job store keeps job records (src/store/jobs.ts: <PATHS.data>/jobs/<id>.json). */
const JOBS_DIR = path.join(PATHS.data, "jobs");

/** Remove what deleted chats left behind: job asset folders (job-id names
 *  only) whose job file is gone, and subject- and recap-part collections (with any
 *  atomic-write temp files `<chatId>.json.tmp-…`) whose chat file is gone
 *  (the chat store keeps each chat at <PATHS.chats>/<id>.json). Existence is
 *  read from the files, never from a parse that can fail transiently.
 *  Folders of existing jobs are never touched. Never throws. */
export function sweepForkSlidesOrphans(): void {
	const root = forkSlidesRoot();
	if (fs.existsSync(JOBS_DIR)) {
		try {
			for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory() && FORK_SLIDES_JOB_ID_RE.test(entry.name) && !fs.existsSync(path.join(JOBS_DIR, `${entry.name}.json`)))
					fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
			}
		} catch {
			/* no slides yet */
		}
	}
	if (!fs.existsSync(PATHS.chats)) return; // no chat folder to check against: keep every collection
	for (const kind of Object.keys(PARTS_DIRS) as ForkSlidesPartsKind[]) {
		try {
			const chatIds = new Set<string>();
			for (const name of fs.readdirSync(path.join(root, PARTS_DIRS[kind]))) {
				const chatId = /^(.+)\.json(?:\.tmp-.+)?$/.exec(name)?.[1];
				if (chatId && CHAT_ID_RE.test(chatId)) chatIds.add(chatId);
			}
			for (const chatId of chatIds) if (!fs.existsSync(path.join(PATHS.chats, `${chatId}.json`))) clearPartsCollection(kind, chatId);
		} catch {
			/* no collections of this kind */
		}
	}
}
