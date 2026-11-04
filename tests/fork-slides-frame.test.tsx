/**
 * Fork-only: guards the memoised slide frame (FrameImage in
 * components/artifacts/fork-slides-card.tsx). The narration clock re-renders
 * the card every 100 ms during a pause and on every audio timeupdate;
 * SvgImage repairs and URI-encodes the whole SVG on each of its renders.
 * SvgImage's work is counted through encodeURIComponent calls on the frame.
 */
import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const h = React.createElement;
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
const realEncode = globalThis.encodeURIComponent;
const encodes = new Map<string, number>();
const MARKS = ["frame-mark-A", "frame-mark-B", "frame-mark-C"];
const realFetch = globalThis.fetch;
const svgFor = (file: string) =>
	`<svg width="1280" height="720" viewBox="0 0 1280 720"><text>${file.includes("01-1") ? MARKS[0] : file.includes("01-2") ? MARKS[1] : MARKS[2]}&nbsp;</text></svg>`;

const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
	React,
	window: dom.window,
	document: dom.document,
	IS_REACT_ACT_ENVIRONMENT: true,
	encodeURIComponent: (s: string | number | boolean) => {
		for (const m of MARKS) if (String(s).includes(m)) encodes.set(m, (encodes.get(m) ?? 0) + 1);
		return realEncode(s);
	},
	fetch: async (url: string) => ({ ok: true, status: 200, text: async () => svgFor(String(url)) }),
})) {
	previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
// linkedom's <audio> has no media methods.
const audioProto = Object.getPrototypeOf(dom.document.createElement("audio")) as Record<string, unknown>;
Object.assign(audioProto, { load() {}, pause() {}, play: () => Promise.resolve() });
after(() => {
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
	globalThis.fetch = realFetch;
});

const { FrameImage, ForkSlidesCard, forkSlidesLayout } = await import("../components/artifacts/fork-slides-card.tsx");
const { SvgImage } = await import("../components/artifacts/svg-image.tsx");
const { createRoot } = await import("react-dom/client");

const count = (mark: string) => encodes.get(mark) ?? 0;
const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

test("FrameImage renders SvgImage's exact markup, and re-runs it only when svg or className change", async () => {
	const svg = svgFor("frame-01-1.svg");
	for (const className of ["h-auto w-full", undefined]) {
		assert.equal(renderToStaticMarkup(h(FrameImage, { svg, className })), renderToStaticMarkup(h(SvgImage, { svg, className })));
	}
	encodes.clear();
	const root = createRoot(dom.document.createElement("div"));
	let setTick: (n: number) => void = () => {};
	let setFrame: (f: { svg: string; className: string }) => void = () => {};
	function Parent() {
		const [tick, st] = useState(0);
		const [frame, sf] = useState({ svg, className: "a" });
		setTick = st;
		setFrame = sf;
		return h("div", { "data-tick": tick }, h(FrameImage, frame));
	}
	await act(async () => root.render(h(Parent)));
	assert.equal(count(MARKS[0]!), 1);
	for (let i = 1; i <= 5; i++) await act(async () => setTick(i));
	assert.equal(count(MARKS[0]!), 1, "a clock-only re-render does not re-run SvgImage");
	await act(async () => setFrame({ svg, className: "b" }));
	assert.equal(count(MARKS[0]!), 2, "a new className re-runs it");
	await act(async () => setFrame({ svg: svgFor("frame-01-2.svg"), className: "b" }));
	assert.equal(count(MARKS[1]!), 1, "a new svg re-runs it");
	await act(async () => root.unmount());
});

test("the slides card: timeupdate and pause-clock renders keep the frame; a mode or frame change redraws it", async () => {
	encodes.clear();
	const deck = {
		version: 1 as const,
		jobId: "job_frame",
		kind: "deck" as const,
		stage: "stage.svg",
		slides: [
			{
				steps: [
					{ say: "One.", frame: "frame-01-1.svg", audio: "audio-01-1.ogg", duration: 2 },
					{ say: "Two.", frame: "frame-01-2.svg", audio: "audio-01-2.ogg", duration: 2 },
				],
			},
		],
	};
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(h(ForkSlidesCard, { result: { title: "Deck", html: "slides", tested: true, forkSlides: deck } as never })));
	await flush();
	const img = () => host.querySelector('[data-testid="fork-slides-frame"] img');
	const clock = () => host.querySelector('[data-testid="fork-slides-clock"]')!.textContent;
	assert.ok(img(), "the first frame is shown");
	const drawn = count(MARKS[0]!);
	const expected = parseHTML(renderToStaticMarkup(h(SvgImage, { svg: svgFor("frame-01-1.svg"), className: forkSlidesLayout(false).image }))).document.querySelector("img")!;
	for (const attr of ["src", "alt", "class", "draggable", "width"]) assert.equal(img()!.getAttribute(attr), expected.getAttribute(attr), `same image ${attr} as SvgImage`);
	encodes.set(MARKS[0]!, drawn); // the reference render above isn't the card's
	assert.equal(count(MARKS[0]!), 1, "drawn once, although the second frame's arrival re-rendered the card");

	const audio = host.querySelector("audio")!;
	const clocks = new Set<string | null>();
	for (const t of [0.4, 0.9, 1.3, 1.8]) {
		(audio as unknown as { currentTime: number }).currentTime = t;
		await act(async () => { audio.dispatchEvent(new dom.window.Event("timeupdate")); });
		clocks.add(clock());
	}
	assert.ok(clocks.size >= 2, `the clock moved (${[...clocks].join(", ")}), so the card re-rendered`);
	assert.equal(count(MARKS[0]!), 1, "timeupdate re-renders don't redraw the frame");

	// The step ends: the 1.2 s pause ticks every 100 ms on the same frame.
	(audio as unknown as { currentTime: number }).currentTime = 2;
	await act(async () => { audio.dispatchEvent(new dom.window.Event("ended")); });
	await flush(450);
	assert.equal(count(MARKS[0]!), 1, "pause ticks don't redraw the frame");
	assert.equal(count(MARKS[1]!), 0);
	await flush(1000);
	assert.equal(count(MARKS[1]!), 1, "after the pause the next step's frame is drawn once");

	await act(async () => { (host.querySelector('[data-testid="fork-slides-open"]') as unknown as { click(): void } | null)?.click(); });
	assert.equal(host.querySelector('[data-testid="fork-slides-card"]')!.getAttribute("data-expanded"), "true");
	assert.equal(count(MARKS[1]!), 2, "expanding changes the image class, so the frame is drawn again");
	await act(async () => root.unmount());
});
