/**
 * Fork-only: cache chat-list summaries per chat file (src/store/chats.ts
 * listChats).
 *
 * listChats used to JSON.parse every chat file in full and run the phase,
 * pending-question and active-problem folds over every message on each call
 * (sidebar refreshes, the activity feed, the graph, job recovery). A file's
 * summary is a pure function of its bytes, so it is kept per file and reused
 * while the file's identity is unchanged: dev, inode, size, mtime and ctime
 * in nanoseconds (an atomic write renames a new inode in; an in-place write
 * changes mtime/ctime).
 *
 * - A file whose mtime or ctime is within racyMs of the moment it was
 *   statted is not cached: a coarse filesystem clock could give a second
 *   write within that window the same timestamps (the "racy git" case).
 * - Failures are never cached (unreadable, newer schema version, projection
 *   error), so their console.error and absent row repeat exactly as before.
 * - Every call returns a fresh copy; callers may mutate the summaries.
 *
 * The hook is two wrappers in listChats' chain: forkCachedChat around the
 * per-file getChat, and forkCachedSummary around the projection. For a cache
 * hit, forkCachedChat returns a stand-in that forkCachedSummary recognises
 * and answers with the cached summary, so neither the read nor the
 * projection runs. tests/fork-chat-summaries.test.ts guards it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatRecord } from "../core/contracts.ts";

/** A write this recent may share timestamps with the next one (3 s covers
 *  coarse kernel clocks and FAT's 2 s mtime). Tests may lower it. */
export const forkChatSummaryConfig = { racyMs: 3_000 };

type Key = readonly [bigint, bigint, bigint, bigint, bigint];
type Entry = { key: Key; summary: unknown };

const entries = new Map<string, Entry>();
/** Cache hits in flight: stand-in record → the cached summary. */
const standIns = new WeakMap<object, unknown>();
/** Fresh reads in flight: record → where to store its summary. */
const fresh = new WeakMap<object, { file: string; key: Key }>();
let lastListing: readonly string[] | undefined;

/** Counters for tests and measurements. */
export const forkChatSummaryStats = { reads: 0, hits: 0 };

/** Forget everything (tests). */
export function resetForkChatSummaries(): void {
	entries.clear();
	lastListing = undefined;
	forkChatSummaryStats.reads = 0;
	forkChatSummaryStats.hits = 0;
}

function fileKey(file: string): Key | undefined {
	try {
		const st = fs.statSync(file, { bigint: true });
		if (!st.isFile()) return undefined;
		const newest = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
		if (BigInt(Date.now()) * 1_000_000n - newest < BigInt(forkChatSummaryConfig.racyMs) * 1_000_000n) return undefined;
		return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs];
	} catch {
		return undefined;
	}
}

const sameKey = (a: Key, b: Key) => a.every((v, i) => v === b[i]);

/**
 * In place of `getChat(id)` for the file `name` in `dir`. `listing` is the
 * array being mapped; a new listing prunes entries for files not in it.
 */
export function forkCachedChat(dir: string, name: string, listing: readonly string[], read: () => ChatRecord | null): ChatRecord | null {
	if (listing !== lastListing) {
		lastListing = listing;
		const listed = new Set(listing.map((f) => path.join(dir, f)));
		for (const file of entries.keys()) if (!listed.has(file)) entries.delete(file);
	}
	const file = path.join(dir, name);
	const key = fileKey(file);
	const hit = entries.get(file);
	if (key && hit && sameKey(hit.key, key)) {
		forkChatSummaryStats.hits++;
		const standIn = {};
		standIns.set(standIn, hit.summary);
		return standIn as ChatRecord;
	}
	entries.delete(file);
	forkChatSummaryStats.reads++;
	const record = read();
	if (record !== null && typeof record === "object" && key) fresh.set(record, { file, key });
	return record;
}

/** Wraps listChats' projection: answers stand-ins from the cache, stores fresh summaries. */
export function forkCachedSummary<S>(project: (record: ChatRecord) => S | null): (record: ChatRecord) => S | null {
	return (record) => {
		if (standIns.has(record)) return structuredClone(standIns.get(record)) as S;
		const summary = project(record);
		const target = fresh.get(record);
		if (summary !== null && target) entries.set(target.file, { key: target.key, summary: structuredClone(summary) });
		return summary;
	};
}
