/**
 * Fork-only: guards the "newest transcript blocks first" hook
 * (components/transcript-fill.ts, used by components/chat.tsx).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { TRANSCRIPT_BATCH, TRANSCRIPT_TAIL, useTranscriptFill } from "../components/transcript-fill.ts";
import { kbdEventForAction } from "../src/core/index.ts";

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(total: number, hash = "") {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const win = dom.window as unknown as EventTarget & { location?: unknown };
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
		const hidden = useTranscriptFill(total);
		seen.push(hidden);
		return null;
	}
	const render = (next: number) => act(async () => { currentTotal = next; root.render(React.createElement(Harness, { total: next })); });
	await render(total);
	const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
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
	function Harness() { seen.push(useTranscriptFill(40)); return null; }
	renderToStaticMarkup(React.createElement(Harness));
	assert.equal(seen[0], 40 - TRANSCRIPT_TAIL);
});

test("fills to zero in batches without ever growing", async () => {
	const f = await fixture(40);
	for (let i = 0; i < 20 && f.hidden > 0; i++) await f.settle();
	assert.equal(f.hidden, 0);
	const distinct = [...new Set(f.seen)];
	assert.deepEqual(distinct, distinct.slice().sort((a, b) => b - a), "monotonically decreasing");
	for (let i = 1; i < distinct.length; i++) assert.ok(distinct[i - 1]! - distinct[i]! <= TRANSCRIPT_BATCH);
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
