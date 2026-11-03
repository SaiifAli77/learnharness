// Fork-only (see FORK.md, "Opening long chats fast"): not part of upstream.
"use client";

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { kbdEventForAction } from "@/src/core";

/** Newest messages rendered on the server and in the first client render.
 * Enough to fill the screen at the bottom of the transcript, where a chat
 * opens, while keeping SSR and hydration of the (markdown-heavy) older blocks
 * off the critical path. */
export const TRANSCRIPT_TAIL = 6;

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
 * pure function of the initial message count and `full` (SSR and the client's
 * first render agree, so hydration matches); after mount, one idle-scheduled
 * transition reveals every older message at once (a single render, so the
 * visible transcript is not re-rendered per batch), and the settled DOM is the
 * full transcript. Hidden counts from the start: appended (streaming) messages
 * are never hidden, and a shrinking transcript clamps.
 *
 * Scroll hold: the reader's distance from the transcript's bottom is tracked
 * on scroll and restored in a layout effect whenever `hidden` changes, so the
 * prepend never moves the view (at the bottom stays at the bottom; scrolled up
 * stays on the same text).
 *
 * `full` (graph links, `?full=1`) starts with nothing hidden: an old message
 * must be in the first render. The same happens at once when something needs
 * older DOM later: a hash on the URL at mount or change, and the in-chat Find
 * opening. */
export function useTranscriptFill(total: number, scroller: () => HTMLElement | null | undefined, full = false): number {
	const [hidden, setHidden] = useState(() => (full ? 0 : Math.max(0, total - TRANSCRIPT_TAIL)));
	const fillNow = useCallback(() => setHidden(0), []);
	// The reader's distance from the transcript's bottom, kept current on
	// scroll: prepending older messages restores it, so the view never moves
	// (at the bottom stays at the bottom; scrolled up stays on the same text).
	const fromBottom = useRef(0);
	useEffect(() => {
		const el = scroller();
		if (!el) return;
		const track = () => { fromBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop; };
		track();
		el.addEventListener("scroll", track, { passive: true });
		return () => el.removeEventListener("scroll", track);
	}, [scroller]);
	useLayoutEffect(() => {
		const el = scroller();
		if (el) el.scrollTop = el.scrollHeight - el.clientHeight - fromBottom.current;
	}, [hidden, scroller]);

	useEffect(() => {
		if (hidden <= 0) return;
		const scheduler = idleScheduler();
		const handle = scheduler.schedule(() => {
			startTransition(() => setHidden(0));
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
