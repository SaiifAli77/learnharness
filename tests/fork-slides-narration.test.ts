/**
 * Fork-only: guards the Kokoro narration of slide decks (FORK.md "StatQuest
 * method and slide decks"): the TTS module with a fake spawner (arguments,
 * uv resolution through PATH, the protocol, every failure path), the
 * runner delivering the deck with or without audio, the route serving
 * audio/ogg with ranges, the timeline math behind the card's player, and
 * the player's controls.
 */
import React from "react";
const h = React.createElement;

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-narration-"));
const originalEnv = process.env;
const fakeBin = path.join(scratch, "bin");
fs.mkdirSync(fakeBin, { recursive: true });
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	PATH: [fakeBin, originalEnv.PATH ?? ""].join(path.delimiter),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
	OPENAI_API_KEY: "sk-held-by-the-app",
};
after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { renderToStaticMarkup } = await import("react-dom/server");
const { createCanvas } = await import("@napi-rs/canvas");
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type PiEngine = import("../src/agent/models.ts").PiEngine;
type ChildLike = import("../src/agent/fork-slides/tts.ts").ChildLike;

const tts = await import("../src/agent/fork-slides/tts.ts");
const { synthesizeNarration, uvArgs, resolveUv, NARRATE_PY, KOKORO_MODEL_FILE, KOKORO_VOICES_FILE, KOKORO_RELEASE } = tts;
const { resetBinaryCache } = await import("../src/agent/local-agents/binaries.ts");
const { forkSlidesModelOverride, forkSlidesTtsOverride } = await import("../src/agent/fork-slides/runner-hook.ts");
const { forkSlidesDir } = await import("../src/agent/fork-slides/storage.ts");
const { deckTimeline, timelineAt, timelineIndex, timelineTime, formatClock, isForkSlidesResult, FORK_SLIDES_MARKER, STEP_PAUSE, SLIDE_PAUSE } = await import("../src/core/fork-slides.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { ForkSlidesCard, forkSlidesLayout, expandLabel, exitsExpanded } = await import("../components/artifacts/fork-slides-card.tsx");
const { GET } = await import("../app/api/fork-slides/[...path]/route.ts");

// ─── fixtures ───────────────────────────────────────────────────────────────

const STAGE =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect id="bg" width="1280" height="720" fill="#fff"/><text id="w1" x="100" y="100">× −34.4</text><rect id="box-w1" x="90" y="75" width="120" height="35"/></svg>';
const SCRIPT = {
	title: "Weight",
	kind: "deck" as const,
	stage: "Weight × −34.4.",
	slides: [{ steps: [{ say: "Here is the weight.", show: "lit" }, { say: "Box it.", show: "box" }] }, { steps: [{ say: "Done.", show: "all" }] }],
};

function scriptedModel(turns: Array<{ toolCalls?: Array<{ id: string; name: string; input: unknown }>; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((t) =>
		t.toolCalls
			? fauxAssistantMessage(t.toolCalls.map((c) => fauxToolCall(c.name, c.input as never, { id: c.id })), { stopReason: "toolUse" })
			: fauxAssistantMessage(t.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const fakeHeadless = {
	available: () => true,
	unavailableReason: () => null,
	runDemo: async () => ({ consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }),
	async renderSvg(): Promise<Buffer> {
		const canvas = createCanvas(1, 1);
		canvas.getContext("2d").fillRect(0, 0, 1, 1);
		return canvas.toBuffer("image/png");
	},
	renderPdfPages: async () => [],
};

/** A fake Kokoro process speaking the JSON-lines protocol. `fail` makes a
 *  text get an error reply that many times; `die` makes the process exit
 *  on receiving that text that many times; `exitBeforeReady` makes that
 *  many spawns (true = all) exit before the model loads. */
function fakeKokoro(opts: { fail?: Record<string, number>; die?: Record<string, number>; epipe?: Record<string, number>; exitBeforeReady?: boolean | number; durations?: Record<string, number>; onRequest?: () => void } = {}) {
	const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; script: string }> = [];
	const requests: Array<{ id: number; text: string; out: string }> = [];
	const fail = { ...opts.fail };
	const die = { ...opts.die };
	const epipe = { ...opts.epipe };
	let kills = 0;
	const spawn = (command: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }): ChildLike => {
		calls.push({ command, args, cwd: o.cwd, env: o.env, script: fs.readFileSync(args[8]!, "utf-8") });
		const spawnNo = calls.length;
		const emitter = new EventEmitter();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let exited = false;
		const exit = (code: number) => {
			if (exited) return;
			exited = true;
			setImmediate(() => emitter.emit("exit", code, null));
		};
		let buf = "";
		const stdin = new Writable({
			write(chunk, _enc, cb) {
				buf += String(chunk);
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const req = JSON.parse(buf.slice(0, nl)) as { id: number; text: string; out: string };
					buf = buf.slice(nl + 1);
					requests.push(req);
					opts.onRequest?.();
					if ((epipe[req.text] ?? 0) > 0) {
						// The reader closed its end while the child stays alive: the
						// next write fails with EPIPE, emitted as 'error' on stdin.
						epipe[req.text]!--;
						const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
						setImmediate(() => stdin.emit("error", err));
					} else if ((die[req.text] ?? 0) > 0) {
						die[req.text]!--;
						stderr.write("Segmentation fault\n");
						exit(139);
					} else if ((fail[req.text] ?? 0) > 0) {
						fail[req.text]!--;
						stdout.write(`@@LH ${JSON.stringify({ id: req.id, ok: false, error: "phonemizer exploded" })}\n`);
					} else {
						fs.writeFileSync(req.out, "OggS-fake");
						stdout.write(`library chatter on stdout\n@@LH ${JSON.stringify({ id: req.id, ok: true, duration: opts.durations?.[req.text] ?? 1.5 })}\n`);
					}
				}
				cb();
			},
		});
		setImmediate(() => {
			const before = opts.exitBeforeReady === true || (typeof opts.exitBeforeReady === "number" && spawnNo <= opts.exitBeforeReady);
			if (before) {
				stderr.write("ModuleNotFoundError: No module named 'kokoro_onnx'\n");
				exit(1);
			} else stdout.write(`@@LH ${JSON.stringify({ ready: true })}\n`);
		});
		return {
			stdin,
			stdout,
			stderr,
			on: (event: string, listener: (...a: unknown[]) => void) => emitter.on(event, listener),
			kill: () => {
				kills++;
				exit(143);
			},
		} as unknown as ChildLike;
	};
	return { spawn, calls, requests, killed: () => kills > 0 };
}

function cacheWithModel(): string {
	const dir = fs.mkdtempSync(path.join(scratch, "kokoro-"));
	fs.writeFileSync(path.join(dir, KOKORO_MODEL_FILE), "model");
	fs.writeFileSync(path.join(dir, KOKORO_VOICES_FILE), "voices");
	return dir;
}

function outDir(): string {
	return fs.mkdtempSync(path.join(scratch, "out-"));
}

// ─── 1. the TTS module ─────────────────────────────────────────────────────

describe("narration: the TTS module (fork)", () => {
	it("spawns uv with the exact arguments, the script, a clean env, and returns each step's duration", async () => {
		const fake = fakeKokoro({ durations: { "Here is the weight.": 1.5, "Box it.": 2.5 } });
		const cache = cacheWithModel();
		const out = outDir();
		const items = [
			{ text: "Here is the weight.", out: path.join(out, "audio-01-1.ogg") },
			{ text: "Box it.", out: path.join(out, "audio-01-2.ogg") },
		];
		const res = await synthesizeNarration(items, { spawn: fake.spawn, resolveUv: async () => "/opt/uv/bin/uv", cacheDir: cache });
		assert.deepEqual(res, { ok: true, durations: [1.5, 2.5] });
		assert.equal(fake.calls.length, 1, "one long-lived process for the whole deck");
		const call = fake.calls[0]!;
		assert.equal(call.command, "/opt/uv/bin/uv");
		assert.deepEqual(call.args.slice(0, 8), ["run", "--quiet", "--with", "kokoro-onnx==0.6.1", "--with", "soundfile==0.14.0", "python", "-I"]);
		assert.deepEqual(call.args.slice(9), [path.join(cache, KOKORO_MODEL_FILE), path.join(cache, KOKORO_VOICES_FILE), "am_michael", "0.85", "en-us"]);
		assert.equal(call.script, NARRATE_PY, "the script is written from the TS constant");
		assert.match(NARRATE_PY, /format="OGG", subtype="VORBIS"/);
		assert.equal(path.dirname(call.args[8]!), call.cwd, "runs in its own temp dir (no project picked up)");
		assert.ok(!fs.existsSync(call.cwd), "the temp script dir is removed afterwards");
		assert.equal(call.env.OPENAI_API_KEY, undefined, "app-held keys never reach the child");
		assert.deepEqual(fake.requests.map((r) => r.text), ["Here is the weight.", "Box it."]);
		assert.ok(fake.killed(), "the process is stopped at the end");
		assert.deepEqual(uvArgs("s.py", "m", "v"), ["run", "--quiet", "--with", "kokoro-onnx==0.6.1", "--with", "soundfile==0.14.0", "python", "-I", "s.py", "m", "v", "am_michael", "0.85", "en-us"]);
		assert.equal(tts.KOKORO_SPEED, 0.85, "the slower voice (new builds only; stored audio is never re-made)");
	});

	it("resolves uv through LH_UV_BIN or PATH", async () => {
		const uv = path.join(fakeBin, "uv");
		fs.writeFileSync(uv, "#!/bin/sh\n");
		fs.chmodSync(uv, 0o755);
		resetBinaryCache();
		assert.equal(await resolveUv(), uv, "found on PATH");
		const other = path.join(scratch, "custom-uv");
		fs.writeFileSync(other, "#!/bin/sh\n");
		fs.chmodSync(other, 0o755);
		process.env.LH_UV_BIN = other;
		try {
			assert.equal(await resolveUv(), other, "the override wins");
		} finally {
			delete process.env.LH_UV_BIN;
		}
	});

	it("fails honestly: no uv, a failed download, a crashed process, a failed step", async () => {
		const items = [{ text: "a", out: path.join(outDir(), "audio-01-1.ogg") }];
		const noUv = await synthesizeNarration(items, { resolveUv: async () => undefined });
		assert.equal(noUv.ok, false);
		assert.match(!noUv.ok ? noUv.reason : "", /uv was not found/);

		const empty = fs.mkdtempSync(path.join(scratch, "kokoro-empty-"));
		const urls: string[] = [];
		const badFetch = (async (url: string) => {
			urls.push(url);
			return new Response("nope", { status: 404 });
		}) as unknown as typeof fetch;
		const noModel = await synthesizeNarration(items, { resolveUv: async () => "uv", cacheDir: empty, fetch: badFetch, spawn: fakeKokoro().spawn });
		assert.match(!noModel.ok ? noModel.reason : "", /could not be downloaded: downloading kokoro-v1\.0\.int8\.onnx failed: HTTP 404/);
		assert.deepEqual(urls, [`${KOKORO_RELEASE}/${KOKORO_MODEL_FILE}`]);
		assert.equal(KOKORO_RELEASE, "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0");

		const crashedFake = fakeKokoro({ exitBeforeReady: true });
		const crashed = await synthesizeNarration(items, { resolveUv: async () => "uv", cacheDir: cacheWithModel(), spawn: crashedFake.spawn });
		assert.match(!crashed.ok ? crashed.reason : "", /step 1 failed twice \(retried once\): the Kokoro process exited \(code 1\).*No module named 'kokoro_onnx'/);
		assert.equal(crashedFake.calls.length, 2, "restarted once, then gave up");

		const aborted = new AbortController();
		aborted.abort();
		const ab = await synthesizeNarration(items, { resolveUv: async () => "uv", cacheDir: cacheWithModel(), spawn: fakeKokoro().spawn, abortSignal: aborted.signal });
		assert.equal(ab.ok, false);
	});

	it("retries a failed step once: a step that fails once still gives full audio", async () => {
		const fake = fakeKokoro({ fail: { b: 1 } });
		const out = outDir();
		const res = await synthesizeNarration(["a", "b", "c"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
			resolveUv: async () => "uv",
			cacheDir: cacheWithModel(),
			spawn: fake.spawn,
		});
		assert.deepEqual(res, { ok: true, durations: [1.5, 1.5, 1.5] });
		assert.deepEqual(fake.requests.map((r) => r.text), ["a", "b", "b", "c"]);
		assert.equal(fake.calls.length, 1, "an error reply is retried on the same process");
	});

	it("a step that fails twice gives no audio, naming the step and the retry", async () => {
		const fake = fakeKokoro({ fail: { b: 2 } });
		const out = outDir();
		const res = await synthesizeNarration(["a", "b", "c"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
			resolveUv: async () => "uv",
			cacheDir: cacheWithModel(),
			spawn: fake.spawn,
		});
		assert.equal(res.ok, false);
		assert.match(!res.ok ? res.reason : "", /^step 2 failed twice \(retried once\): phonemizer exploded; then phonemizer exploded$/);
		assert.deepEqual(fake.requests.map((r) => r.text), ["a", "b", "b"], "never reaches step 3");
	});

	it("a process that dies mid-deck is restarted once and the deck completes", async () => {
		const fake = fakeKokoro({ die: { b: 1 } });
		const out = outDir();
		const res = await synthesizeNarration(["a", "b", "c"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
			resolveUv: async () => "uv",
			cacheDir: cacheWithModel(),
			spawn: fake.spawn,
		});
		assert.deepEqual(res, { ok: true, durations: [1.5, 1.5, 1.5] });
		assert.equal(fake.calls.length, 2, "one restart");
		assert.equal(fake.calls[1]!.args[8], fake.calls[0]!.args[8], "the same temp script is reused");
		assert.deepEqual(fake.requests.map((r) => r.text), ["a", "b", "b", "c"], "continues from the step that died");
	});

	it("an EPIPE on stdin (child still alive) is a dead session: restarted once, the deck completes, nothing crashes", async () => {
		const fake = fakeKokoro({ epipe: { b: 1 } });
		const out = outDir();
		const uncaught: unknown[] = [];
		const onUncaught = (err: unknown) => uncaught.push(err);
		process.on("uncaughtException", onUncaught);
		try {
			const res = await synthesizeNarration(["a", "b", "c"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
				resolveUv: async () => "uv",
				cacheDir: cacheWithModel(),
				spawn: fake.spawn,
			});
			await new Promise((r) => setImmediate(r));
			assert.deepEqual(res, { ok: true, durations: [1.5, 1.5, 1.5] });
			assert.equal(fake.calls.length, 2, "restarted once");
			assert.deepEqual(fake.requests.map((r) => r.text), ["a", "b", "b", "c"]);
			assert.deepEqual(uncaught, [], "the stdin error was handled");
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});

	it("a second EPIPE fails honestly instead of throwing", async () => {
		const fake = fakeKokoro({ epipe: { a: 1, b: 1 } });
		const out = outDir();
		const res = await synthesizeNarration(["a", "b"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
			resolveUv: async () => "uv",
			cacheDir: cacheWithModel(),
			spawn: fake.spawn,
		});
		assert.equal(res.ok, false);
		assert.match(!res.ok ? res.reason : "", /^step 2 failed \(writing to the Kokoro process failed: write EPIPE\) and the Kokoro process had already been restarted once$/);
	});

	it("a second death is not restarted again", async () => {
		const fake = fakeKokoro({ die: { a: 1, c: 1 } });
		const out = outDir();
		const res = await synthesizeNarration(["a", "b", "c"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
			resolveUv: async () => "uv",
			cacheDir: cacheWithModel(),
			spawn: fake.spawn,
		});
		assert.equal(res.ok, false);
		assert.match(!res.ok ? res.reason : "", /^step 3 failed \(the Kokoro process exited \(code 139\): Segmentation fault\) and the Kokoro process had already been restarted once$/);
		assert.equal(fake.calls.length, 2);
	});

	it("an abort is never retried", async () => {
		const controller = new AbortController();
		const fake = fakeKokoro({ onRequest: () => controller.abort() });
		const out = outDir();
		const res = await synthesizeNarration(["a", "b"].map((t) => ({ text: t, out: path.join(out, `${t}.ogg`) })), {
			resolveUv: async () => "uv",
			cacheDir: cacheWithModel(),
			spawn: fake.spawn,
			abortSignal: controller.signal,
		});
		assert.deepEqual(res, { ok: false, reason: "aborted" });
		assert.equal(fake.requests.length, 1, "no retry after the abort");
		assert.equal(fake.calls.length, 1, "no restart after the abort");
		assert.ok(fake.killed());
	});

	it("downloads a missing model and voices file once into the cache", async () => {
		const dir = path.join(scratch, "kokoro-dl");
		const fetched: string[] = [];
		const okFetch = (async (url: string) => {
			fetched.push(url);
			return new Response("bytes!", { headers: { "content-length": "6" } });
		}) as unknown as typeof fetch;
		const items = [{ text: "a", out: path.join(outDir(), "audio-01-1.ogg") }];
		const res = await synthesizeNarration(items, { resolveUv: async () => "uv", cacheDir: dir, fetch: okFetch, spawn: fakeKokoro().spawn });
		assert.equal(res.ok, true);
		assert.deepEqual(fetched, [`${KOKORO_RELEASE}/${KOKORO_MODEL_FILE}`, `${KOKORO_RELEASE}/${KOKORO_VOICES_FILE}`]);
		assert.equal(fs.readFileSync(path.join(dir, KOKORO_MODEL_FILE), "utf-8"), "bytes!");
		await synthesizeNarration(items, { resolveUv: async () => "uv", cacheDir: dir, fetch: okFetch, spawn: fakeKokoro().spawn });
		assert.equal(fetched.length, 2, "cached files are reused");
		assert.deepEqual(fs.readdirSync(dir).sort(), [KOKORO_MODEL_FILE, KOKORO_VOICES_FILE], "no partial files left");
	});
});

// ─── 2. the runner: with and without audio; the route ───────────────────────

describe("narration: the deck is delivered with or without audio (fork)", () => {
	const run = async (toolCallId: string, synth: (typeof forkSlidesTtsOverride)["current"]) => {
		const chatId = chatStore.createChat("narration").id;
		headlessOverride.current = fakeHeadless;
		forkSlidesTtsOverride.current = synth;
		forkSlidesModelOverride.current = scriptedModel([
			{
				toolCalls: [
					{ id: "w", name: "write_stage", input: { svg: STAGE } },
					{ id: "s1", name: "set_slide", input: { slide: 1, steps: [{ lit: ["w1"] }, { boxes: ["w1"] }] } },
					{ id: "s2", name: "set_slide", input: { slide: 2, steps: [{}] } },
				],
			},
			{ text: "x" },
			{ text: "Checked." },
		]);
		try {
			await jobTools({ chatId, jobStore, spawn: () => {} } as never).slides!.execute(toolCallId, SCRIPT as never, undefined as never);
			const job = jobStore.findJobByToolCallId(chatId, toolCallId)!;
			await createJobRunner({ chatStore, jobStore, deliver: async () => {} }).runJob(job.id);
			return jobStore.getJob(job.id)!;
		} finally {
			headlessOverride.current = undefined;
			forkSlidesTtsOverride.current = undefined;
			forkSlidesModelOverride.current = undefined;
		}
	};

	it("writes one ogg per build step next to the frames and stores the durations; the route serves audio/ogg", async () => {
		let seen: Array<{ text: string; out: string }> = [];
		const job = await run("tc-audio", async (items) => {
			seen = items;
			for (const it of items) fs.writeFileSync(it.out, Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5, 6]));
			return { ok: true, durations: [2.25, 1.5, 0.75] };
		});
		assert.equal(job.status, "done", job.error);
		assert.ok(isForkSlidesResult(job.result));
		const deck = (job.result as { forkSlides: import("../src/core/fork-slides.ts").ForkSlidesDeck }).forkSlides;
		const dir = forkSlidesDir(job.id)!;
		assert.deepEqual(seen.map((s) => [s.text, path.relative(dir, s.out)]), [
			["Here is the weight.", "audio-01-1.ogg"],
			["Box it.", "audio-01-2.ogg"],
			["Done.", "audio-02-1.ogg"],
		]);
		assert.deepEqual(deck.slides.flatMap((s) => s.steps.map((st) => [st.audio, st.duration])), [
			["audio-01-1.ogg", 2.25],
			["audio-01-2.ogg", 1.5],
			["audio-02-1.ogg", 0.75],
		]);
		assert.match((job.result as { notes: string }).notes, /It is narrated \(0:07 with the pauses between steps\)/);

		const get = (file: string, range?: string) =>
			GET(new Request("http://localhost/x", range ? { headers: { range } } : {}), { params: Promise.resolve({ path: [job.id, file] }) });
		const full = await get("audio-01-1.ogg");
		assert.equal(full.status, 200);
		assert.equal(full.headers.get("content-type"), "audio/ogg");
		assert.equal(full.headers.get("accept-ranges"), "bytes");
		assert.deepEqual([...new Uint8Array(await full.arrayBuffer())], [0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5, 6]);
		const part = await get("audio-01-1.ogg", "bytes=2-5");
		assert.equal(part.status, 206);
		assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
		assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [0x67, 0x53, 1, 2]);
		const tail = await get("audio-01-1.ogg", "bytes=-3");
		assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [4, 5, 6]);
		assert.equal((await get("audio-01-1.ogg", "bytes=50-60")).status, 416);
		assert.equal((await get("audio-09-9.ogg")).status, 404);
		assert.equal((await get("audio-01-1.ogg.bak")).status, 404);
		assert.equal((await get("../audio-01-1.ogg")).status, 404);
	});

	it("a failed synthesis still delivers the deck, without audio, and tells the teacher why", async () => {
		const job = await run("tc-noaudio", async (items) => {
			fs.writeFileSync(items[0]!.out, "partial");
			return { ok: false, reason: "uv was not found" };
		});
		assert.equal(job.status, "done", job.error);
		const result = job.result as { notes: string; forkSlides: import("../src/core/fork-slides.ts").ForkSlidesDeck };
		assert.ok(result.forkSlides.slides.every((s) => s.steps.every((st) => st.audio === undefined && st.duration === undefined)));
		assert.match(result.notes, /NO narration audio \(uv was not found\)/);
		assert.ok(!fs.readdirSync(forkSlidesDir(job.id)!).some((f) => f.endsWith(".ogg")), "partial audio removed");
		assert.equal(deckTimeline(result.forkSlides), null, "no player without audio");
	});

	it("a throwing synthesis or an incomplete one is treated the same way", async () => {
		const thrown = await run("tc-throw", async () => {
			throw new Error("boom");
		});
		assert.equal(thrown.status, "done");
		assert.match((thrown.result as { notes: string }).notes, /NO narration audio \(boom\)/);
		const short = await run("tc-short", async () => ({ ok: true, durations: [1] }));
		assert.equal(short.status, "done");
		assert.match((short.result as { notes: string }).notes, /NO narration audio \(the narration came back incomplete\)/);
	});

	it("a video is just a kind:video deck: the same pipeline, narrated", async () => {
		const chatId = chatStore.createChat("video").id;
		chatStore.saveTree(chatId, { nodes: [{ id: "n1", title: "One" }], edges: [], version: 1 });
		const say = Array.from({ length: 45 }, () => "one two three four five six seven eight nine ten").join(" ");
		const video = { ...SCRIPT, kind: "video", nodeId: "n1", slides: [{ steps: [{ say, show: "x" }] }] };
		const res = await jobTools({ chatId, jobStore, chatStore, spawn: () => {} } as never).slides!.execute("tc-video", video as never, undefined as never);
		assert.match((res.content[0] as { text: string }).text, /Carry on with the current activity while it builds/);
		const job = jobStore.findJobByToolCallId(chatId, "tc-video")!;
		assert.equal(job.kind, "demo");
		assert.equal((job.input as Record<string, unknown>)[FORK_SLIDES_MARKER], true);
	});
});

// ─── 3. the timeline and the player ────────────────────────────────────────

describe("narration: the player's timeline (fork)", () => {
	const deck = {
		version: 1 as const,
		jobId: "job_player",
		kind: "deck" as const,
		stage: "stage.svg",
		slides: [
			{
				steps: [
					{ say: "One.", frame: "frame-01-1.svg", audio: "audio-01-1.ogg", duration: 2 },
					{ say: "Two.", frame: "frame-01-2.svg", audio: "audio-01-2.ogg", duration: 3 },
				],
			},
			{ steps: [{ say: "Three.", frame: "frame-02-1.svg", audio: "audio-02-1.ogg", duration: 4.5 }] },
		],
	};

	it("lays the steps end to end with a pause after each: 1.2 s within a slide, 2 s at a slide boundary, none after the last", () => {
		assert.equal(STEP_PAUSE, 1.2);
		assert.equal(SLIDE_PAUSE, 2);
		const tl = deckTimeline(deck)!;
		assert.deepEqual(tl.steps.map((s) => [s.slide, s.step, s.start, s.duration, s.pause]), [
			[0, 0, 0, 2, 1.2],
			[0, 1, 3.2, 3, 2],
			[1, 0, 8.2, 4.5, 0],
		]);
		assert.equal(tl.total, 12.7, "2 + 1.2 + 3 + 2 + 4.5: the pauses count, nothing after the last step");
	});

	it("maps times to steps; a time inside a pause belongs to the step that just ended", () => {
		const tl = deckTimeline(deck)!;
		assert.deepEqual(timelineAt(tl, 0), { index: 0, offset: 0 });
		assert.deepEqual(timelineAt(tl, 1.99), { index: 0, offset: 1.99 });
		assert.deepEqual(timelineAt(tl, 2.5), { index: 0, offset: 2.5 }, "in the step pause: step 1's frame, past its narration");
		assert.deepEqual(timelineAt(tl, 3.2), { index: 1, offset: 0 });
		assert.deepEqual(timelineAt(tl, 7), { index: 1, offset: 3.8 }, "in the slide pause");
		assert.deepEqual(timelineAt(tl, 8.2), { index: 2, offset: 0 });
		assert.deepEqual(timelineAt(tl, 9.2), { index: 2, offset: 1 });
		assert.deepEqual(timelineAt(tl, 99), { index: 2, offset: 4.5 }, "clamped to the end");
		assert.deepEqual(timelineAt(tl, -3), { index: 0, offset: 0 }, "clamped to the start");
		assert.deepEqual(timelineAt(tl, Number.NaN), { index: 0, offset: 0 });
		assert.equal(timelineIndex(tl, 1, 0), 2, "a slide's start: ◀/▶ land here");
		assert.equal(timelineIndex(tl, 5, 0), -1);
		assert.equal(timelineTime(tl, 2), 8.2, "the next slide starts after both earlier pauses");
		assert.equal(timelineTime(tl, 1, 1.25), 4.45);
		assert.equal(timelineTime(tl, 0, 2.6), 2.6, "an offset into the pause");
		assert.equal(timelineTime(tl, 1, 99), 8.2, "offset clamped to the step and its pause");
		assert.equal(timelineTime(tl, 2, 99), 12.7, "the last step has no pause");
		assert.equal(formatClock(0), "0:00");
		assert.equal(formatClock(9.5), "0:09");
		assert.equal(formatClock(125), "2:05");
		assert.equal(formatClock(-1), "0:00");
	});

	it("an old one-slide deck gets the step pauses too (player-side; stored audio unchanged)", () => {
		const old = { ...deck, slides: [{ steps: deck.slides[0]!.steps }] };
		assert.deepEqual(deckTimeline(old)!.steps.map((s) => s.pause), [1.2, 0]);
		assert.equal(deckTimeline(old)!.total, 6.2);
	});

	it("no player unless every step has audio and a positive duration", () => {
		assert.equal(deckTimeline({ ...deck, slides: [{ steps: [{ say: "x", frame: "frame-01-1.svg" }] }] }), null);
		assert.equal(deckTimeline({ ...deck, slides: [{ steps: [{ say: "x", frame: "frame-01-1.svg", audio: "audio-01-1.ogg", duration: 0 }] }] }), null);
	});

	it("the card shows ▶, a scrub bar over the whole deck and elapsed/total when the deck has audio", () => {
		const html = renderToStaticMarkup(h(ForkSlidesCard, { result: { title: "Deck", html: "slides", tested: true, forkSlides: deck } }));
		assert.match(html, /data-testid="fork-slides-play"/);
		assert.match(html, /aria-label="Play narration"/);
		assert.match(html, /type="range"[^>]*max="12.7"/, "the scrub bar spans the pauses too");
		assert.match(html, /0:00 \/ 0:12/);
		assert.match(html, /<audio[^>]*preload="none"/);
		const silent = renderToStaticMarkup(
			h(ForkSlidesCard, { result: { title: "Deck", html: "slides", tested: true, forkSlides: { ...deck, slides: [{ steps: [{ say: "x", frame: "frame-01-1.svg" }] }] } } }),
		);
		assert.ok(!silent.includes("fork-slides-player"), "no player without audio");
	});
});

// ─── 4. expanded: the live card fills the app window ───────────────────────

describe("narration: the expanded card fills the window (fork)", () => {
	const deck = {
		version: 1 as const,
		jobId: "job_fs",
		kind: "deck" as const,
		stage: "stage.svg",
		slides: [{ steps: [{ say: "x", frame: "frame-01-1.svg", audio: "audio-01-1.ogg", duration: 2 }] }],
	};
	const card = (initialExpanded: boolean) =>
		renderToStaticMarkup(h(ForkSlidesCard, { result: { title: "Deck", html: "slides", tested: true, forkSlides: deck }, initialExpanded }));

	it("expanded, the card is fixed over the whole window at the dialogs' z-index, on the app background; the frame fits the height", () => {
		const inline = forkSlidesLayout(false);
		const full = forkSlidesLayout(true);
		for (const c of ["fixed", "inset-0", "z-50", "flex", "flex-col", "bg-background", "lh-no-drag", "overscroll-contain"]) assert.match(full.root, new RegExp(`(^| )${c}( |$)`), c);
		assert.match(full.frame, /\bflex-1\b/);
		assert.match(full.frame, /\bmin-h-0\b/);
		assert.match(full.image, /\bobject-contain\b/);
		assert.match(full.image, /\bh-full\b/);
		assert.ok(!/\bfixed\b/.test(inline.root), "inline is in the flow");
		assert.match(inline.root, /\bmy-4\b/);
		assert.match(inline.image, /\bh-auto w-full\b/);
	});

	it("Esc exits only while expanded; the button says what it does", () => {
		assert.equal(exitsExpanded(true, "Escape"), true);
		assert.equal(exitsExpanded(true, "Esc"), true);
		assert.equal(exitsExpanded(false, "Escape"), false);
		assert.equal(exitsExpanded(true, " "), false);
		assert.deepEqual(expandLabel(false), { aria: "Expand the deck to fill the window", title: "Fill the window" });
		assert.deepEqual(expandLabel(true), { aria: "Exit the expanded deck (Esc)", title: "Exit (Esc)" });
	});

	it("the button is always there (no Fullscreen API, no overlay needed) and reflects the state", () => {
		const inline = card(false);
		assert.match(inline, /data-testid="fork-slides-open"/);
		assert.match(inline, /aria-label="Expand the deck to fill the window"/);
		assert.match(inline, /aria-pressed="false"/);
		const expanded = card(true);
		assert.match(expanded, /aria-label="Exit the expanded deck \(Esc\)"/);
		assert.match(expanded, /aria-pressed="true"/);
		assert.match(expanded, /data-expanded="true"/);
		assert.match(expanded, /role="dialog"/);
		assert.match(expanded, /class="lh-no-drag fixed inset-0 z-50/);
	});

	it("expanding changes classes and labels only: the same tree, so React keeps every node (the audio element is not recreated)", () => {
		const normalise = (html: string) =>
			html
				.replace(/ (class|aria-label|title|aria-pressed|data-expanded|role|aria-modal|style)="[^"]*"/g, "")
				.replace(/<svg[^>]*>[\s\S]*?<\/svg>/g, "<svg/>");
		const inline = card(false);
		const expanded = card(true);
		assert.equal(normalise(expanded), normalise(inline));
		assert.equal(inline.split("<audio").length - 1, 1);
		assert.equal(expanded.split("<audio").length - 1, 1);
		assert.match(inline, /^<div data-testid="fork-slides-slot"><div /, "an always-present wrapper keeps the card's place");
	});
});
