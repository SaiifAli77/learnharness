/**
 * Fork-only: reuse unchanged transcript rows while a turn streams.
 *
 * Every streamed message_update makes SessionModel re-project the whole view
 * (projectView builds new row objects each time), so the transcript memo in
 * components/chat.tsx recomputed and React reconciled EVERY row on every
 * chunk. forkRows runs the same row callback, but while `busy` it hands back
 * the previous React element for a row whose inputs are unchanged:
 *
 * - the row's view message is deep-equal to the one the element was built from,
 * - its per-row signature is equal (index, last-row flag, the phase at the row
 *   and the row before, the anchor lookup of each of its parts), and
 * - every Chat-scope value in `epoch` is the same (Object.is); any change
 *   drops the whole cache.
 *
 * A row holding a background-job dispatch part is never reused: its card
 * (DispatchCard → DispatchActivityCard) computes the job's elapsed seconds
 * from Date.now() while rendering, so it must render whenever Chat does, as
 * before. FORK_ROW_DISPATCH_PARTS lists those part types; the test derives
 * the same set from the artifact registry.
 *
 * When not busy it renders every row, exactly as `messages.map` did, and
 * drops the cache. tests/fork-transcript-memo.test.ts checks that the row
 * callback reads nothing outside these inputs; tests/fork-transcript-rows.test.ts
 * replays a stream with and without the cache and compares the markup.
 */
import type { ReactNode } from "react";
import { textPartMessageId, type LhViewMessage, type Phase3 } from "@/src/core";

type CachedRow = { m: LhViewMessage; sig: unknown[]; el: ReactNode };

/** Per mounted Chat (held in a ref). */
export type ForkRowCache = { epoch: ForkRowEpoch; rows: Map<string, CachedRow> };

/** The per-row values the callback reads, besides `m` and `mi`. */
export type ForkRowInputs = {
	phases: readonly Phase3[];
	sourceTextParts: ReadonlyMap<string, string>;
};

/** Every other Chat-scope value the callback reads; `busy` gates the reuse. */
export type ForkRowEpoch = { busy: boolean } & Record<string, unknown>;

/** Part types whose registry renderer can render DispatchCard (a clock read in render). */
export const FORK_ROW_DISPATCH_PARTS: ReadonlySet<string> = new Set(["tool-research", "tool-pdf", "tool-demo", "tool-slides", "tool-visual"]);

export function forkRows(
	cache: { current: ForkRowCache | undefined },
	messages: readonly LhViewMessage[],
	inputs: ForkRowInputs,
	epoch: ForkRowEpoch,
	renderRow: (m: LhViewMessage, mi: number) => ReactNode,
): ReactNode[] {
	if (!epoch.busy) {
		cache.current = undefined;
		return messages.map((m, mi) => renderRow(m, mi));
	}
	const prev = cache.current && sameEpoch(cache.current.epoch, epoch) ? cache.current.rows : undefined;
	const rows = new Map<string, CachedRow>();
	const out = messages.map((m, mi) => {
		// The key the row body gives its element (index fallback for empty ids).
		const key = m.id || `m-${mi}`;
		const sig = forkRowSignature(messages, inputs, m, mi);
		if (m.parts.some((p) => FORK_ROW_DISPATCH_PARTS.has(p.type))) return renderRow(m, mi);
		const old = prev?.get(key);
		const el = old && sameList(old.sig, sig) && forkDeepEqual(old.m, m) ? old.el : renderRow(m, mi);
		rows.set(key, { m, sig, el });
		return el;
	});
	cache.current = { epoch, rows };
	return out;
}

/** Everything the row body reads that depends on the row's position. */
export function forkRowSignature(messages: readonly LhViewMessage[], inputs: ForkRowInputs, m: LhViewMessage, mi: number): unknown[] {
	const sig: unknown[] = [mi, mi === messages.length - 1, inputs.phases[mi], inputs.phases[mi - 1]];
	for (const part of m.parts) {
		const sourceId = textPartMessageId(part.id);
		sig.push(sourceId ? inputs.sourceTextParts.get(sourceId) : undefined);
	}
	return sig;
}

function sameEpoch(a: ForkRowEpoch, b: ForkRowEpoch): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

const MAX_DEPTH = 200;

/**
 * Structural equality for view data: primitives by Object.is; arrays and
 * plain objects by their own keys IN ORDER (tool cards show JSON.stringify
 * of their input, which keeps key order) and the values under every key
 * (`length`, holes and extra array properties included; a key holding
 * `undefined` differs from a missing key); anything else only by identity.
 * Same-instance values (the strings and objects projectView carries over
 * from the record) short-cut.
 */
export function forkDeepEqual(a: unknown, b: unknown, depth = 0): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (depth > MAX_DEPTH) return false;
	const proto = Object.getPrototypeOf(a);
	if (proto !== Object.getPrototypeOf(b)) return false;
	if (proto !== Array.prototype && proto !== Object.prototype && proto !== null) return false;
	const oa = a as Record<PropertyKey, unknown>;
	const ob = b as Record<PropertyKey, unknown>;
	const ka = Reflect.ownKeys(oa);
	const kb = Reflect.ownKeys(ob);
	if (ka.length !== kb.length) return false;
	for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
	for (const k of ka) if (!forkDeepEqual(oa[k], ob[k], depth + 1)) return false;
	return true;
}
