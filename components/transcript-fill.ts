// Fork-only (see FORK.md, "Opening long chats fast"): not part of upstream.
"use client";

import { startTransition, useCallback, useEffect, useState } from "react";
import { kbdEventForAction } from "@/src/core";

/** Newest messages rendered on the server and in the first client render.
 * Enough to fill the screen at the bottom of the transcript, where a chat
 * opens, while keeping SSR and hydration of the (markdown-heavy) older blocks
 * off the critical path. */
export const TRANSCRIPT_TAIL = 6;
/** Older messages prepended per interruptible fill step. */
export const TRANSCRIPT_BATCH = 4;

type IdleScheduler = { schedule: (run: () => void) => unknown; cancel: (handle: unknown) => void };

/** requestIdleCallback where it exists (Chromium), a macrotask otherwise. */
function idleScheduler(): IdleScheduler {
	if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
		return {
			schedule: (run) => window.requestIdleCallback(run, { timeout: 250 }),
			cancel: (handle) => window.cancelIdleCallback(handle as number),
		};
	}
	return {
		schedule: (run) => setTimeout(run, 0),
		cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

/** How many of the OLDEST messages are not rendered yet. The first value is a
 * pure function of the initial message count (SSR and the client's first
 * render agree, so hydration matches); after mount, older messages are
 * revealed in small transition batches until none are hidden, so the settled
 * DOM is the full transcript. Hidden counts from the start: appended
 * (streaming) messages are never hidden, and a shrinking transcript clamps.
 *
 * The full transcript is forced at once (no batching) when something needs
 * older DOM: a hash on the URL (message deep links) at mount or change, and
 * the in-chat Find opening. */
export function useTranscriptFill(total: number): number {
	const [hidden, setHidden] = useState(() => Math.max(0, total - TRANSCRIPT_TAIL));
	const fillNow = useCallback(() => setHidden(0), []);

	useEffect(() => {
		if (hidden <= 0) return;
		const scheduler = idleScheduler();
		const handle = scheduler.schedule(() => {
			startTransition(() => setHidden((h) => Math.max(0, h - TRANSCRIPT_BATCH)));
		});
		return () => scheduler.cancel(handle);
	}, [hidden]);

	useEffect(() => {
		if (window.location.hash) fillNow();
		const find = kbdEventForAction("find");
		window.addEventListener("hashchange", fillNow);
		window.addEventListener("popstate", fillNow);
		window.addEventListener(find, fillNow);
		return () => {
			window.removeEventListener("hashchange", fillNow);
			window.removeEventListener("popstate", fillNow);
			window.removeEventListener(find, fillNow);
		};
	}, [fillNow]);

	return Math.min(hidden, total);
}
