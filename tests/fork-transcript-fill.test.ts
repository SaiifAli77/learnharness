/**
 * Fork-only: guards the "newest transcript blocks first" hook
 * (components/transcript-fill.ts, used by components/chat.tsx).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { TRANSCRIPT_TAIL, useTranscriptFill } from "../components/transcript-fill.ts";
import { kbdEventForAction } from "../src/core/index.ts";
import { propositionSessionHref } from "../src/core/session-navigation.ts";

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

type Scroller = { scrollHeight: number; clientHeight: number; scrollTop: number } & EventTarget;

async function fixture(total: number, hash = "", opts: { full?: boolean; scroller?: Scroller } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window as unknown as EventTarget & { location?: unknown };
	// Manual idle scheduler: the background fill runs only when the test says.
	const idle: Array<() => void> = [];
	Object.defineProperty(win, "requestIdleCallback", { configurable: true, value: (fn: () => void) => idle.push(fn) });
	Object.defineProperty(win, "cancelIdleCallback", { configurable: true, value: () => {} });
	const location = { hash };
	Object.defineProperty(win, "location", { configurable: true, value: location });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: win, document: dom.document, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	dispose = async () => { await act(async () => { root.unmount(); }); };
	const seen: number[] = [];
	let currentTotal = total;
	function Harness({ total }: { total: number }) {
		const hidden = useTranscriptFill(total, () => (opts.scroller as unknown as HTMLElement) ?? null, opts.full);
		seen.push(hidden);
		return null;
	}
	const render = (next: number) => act(async () => { currentTotal = next; root.render(React.createElement(Harness, { total: next })); });
	await render(total);
	const settle = () => act(async () => { for (const run of idle.splice(0)) run(); await new Promise((r) => setTimeout(r, 5)); });
	return {
		seen, location, render, settle,
		get hidden() { return seen[seen.length - 1]!; },
		get total() { return currentTotal; },
		emit: (name: string) => act(async () => { window.dispatchEvent(new CustomEvent(name)); }),
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("first render hides all but the newest TAIL messages (and nothing for short chats)", async () => {
	const long = await fixture(40);
	assert.equal(long.seen[0], 40 - TRANSCRIPT_TAIL);
	await dispose!(); restore!();
	const short = await fixture(TRANSCRIPT_TAIL);
	assert.equal(short.seen[0], 0);
	assert.ok(short.seen.every((h) => h === 0));
});

test("server render matches the first client render (deterministic from the count)", () => {
	const seen: number[] = [];
	function Harness() { seen.push(useTranscriptFill(40, () => null)); return null; }
	renderToStaticMarkup(React.createElement(Harness));
	assert.equal(seen[0], 40 - TRANSCRIPT_TAIL);
});

test("after mount it fills to zero in one step, not batches", async () => {
	const f = await fixture(40);
	await f.settle();
	assert.equal(f.hidden, 0);
	assert.deepEqual([...new Set(f.seen)], [40 - TRANSCRIPT_TAIL, 0]);
});

test("the full option starts with nothing hidden (also on the server)", async () => {
	const f = await fixture(40, "", { full: true });
	assert.ok(f.seen.every((h) => h === 0));
	const seen: number[] = [];
	function Harness() { seen.push(useTranscriptFill(40, () => null, true)); return null; }
	renderToStaticMarkup(React.createElement(Harness));
	assert.equal(seen[0], 0);
});

test("scroll hold: a prepend keeps the reader's distance from the bottom", async () => {
	const listeners = new Map<string, () => void>();
	const el = {
		scrollHeight: 1000, clientHeight: 400, scrollTop: 300,
		addEventListener: (n: string, fn: () => void) => listeners.set(n, fn),
		removeEventListener: (n: string) => listeners.delete(n),
	} as unknown as Scroller;
	const f = await fixture(40, "", { scroller: el });
	// distance from bottom = 1000 - 400 - 300 = 300; the reader then scrolls.
	el.scrollTop = 100; listeners.get("scroll")!(); // distance 500
	// The fill grows the document by 5000 px: scrollTop must follow.
	el.scrollHeight = 6000;
	await f.settle();
	assert.equal(f.hidden, 0);
	assert.equal(el.scrollHeight - el.clientHeight - el.scrollTop, 500);
});

test("propositionSessionHref opens old messages with ?full=1, plain without a message", () => {
	assert.equal(propositionSessionHref({ provenance: [{ chatId: "c", messageId: "m1" }] }, "c"), "/chat/c?full=1#message-m1");
	assert.equal(propositionSessionHref({ provenance: [{ chatId: "c", messageId: "" }] }, "c"), "/chat/c");
	assert.equal(propositionSessionHref({ provenance: [] }, "c"), "/chat/c");
});

test("the Find event fills everything at once", async () => {
	const f = await fixture(400);
	assert.equal(f.seen[0], 400 - TRANSCRIPT_TAIL);
	assert.ok(f.hidden > 0, "still filling in the background");
	await f.emit(kbdEventForAction("find"));
	assert.equal(f.hidden, 0);
});

test("a hash at mount fills everything at once", async () => {
	const f = await fixture(400, "#message-abc");
	assert.equal(f.hidden, 0);
});

test("hashchange fills everything at once", async () => {
	const f = await fixture(400);
	assert.ok(f.hidden > 0);
	f.location.hash = "#message-abc";
	await f.emit("hashchange");
	assert.equal(f.hidden, 0);
});

test("appended messages are never hidden; shrinking clamps", async () => {
	const f = await fixture(40);
	const visibleBefore = 40 - f.hidden;
	await f.render(41);
	// Hidden counts from the start (and the background fill only lowers it),
	// so the new message is rendered: at least one more block is visible.
	assert.ok(41 - f.hidden >= visibleBefore + 1);
	await f.render(3);
	assert.equal(f.hidden, 3, "clamped to the new total");
	await f.render(2);
	assert.equal(f.hidden, 2);
});
