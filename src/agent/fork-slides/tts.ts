/**
 * Fork-only: narration for slide decks (FORK.md "StatQuest method and slide
 * decks", Kokoro narration). Each build step's `say` is synthesised at build
 * time, after the frames are verified, into one Ogg Vorbis file per step.
 *
 * Runtime: the learner's own `uv` (resolved like the local-agent binaries:
 * env override → PATH → the login shell's PATH → known dirs) runs
 *   uv run --quiet --with kokoro-onnx==0.6.1 --with soundfile==0.14.0 python -I <script> …
 * The Python script lives in NARRATE_PY below and is written to a temp file
 * at runtime (a .py file would not be traced into the packaged server). One
 * long-lived process per job loads the model once, then reads JSON lines
 * ({id, text, out}) and answers each with its duration.
 *
 * Model: Kokoro v1.0 int8, downloaded once into ~/.cache/kokoro if missing
 * from the kokoro-onnx project's release assets; voices-v1.0.bin likewise.
 * Any failure returns { ok: false, reason }: the caller delivers the deck
 * without audio. This module never throws.
 */
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { appHeldEnvVars, resolveBinary } from "../local-agents/binaries.ts";

export const KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
export const KOKORO_MODEL_FILE = "kokoro-v1.0.int8.onnx";
export const KOKORO_VOICES_FILE = "voices-v1.0.bin";
export const KOKORO_VOICE = "am_michael";
export const KOKORO_SPEED = 0.85;
export const KOKORO_LANG = "en-us";
/** Pinned Python packages, so a new release can't change the voice or break the protocol. */
export const KOKORO_ONNX_PIN = "kokoro-onnx==0.6.1";
export const SOUNDFILE_PIN = "soundfile==0.14.0";

/** How long the process may take to start (first run installs packages). */
const STARTUP_TIMEOUT_MS = 10 * 60_000;
/** How long one utterance may take. */
const UTTERANCE_TIMEOUT_MS = 2 * 60_000;
/** Protocol lines are prefixed so library chatter on stdout is ignored. */
const MARK = "@@LH ";

export const NARRATE_PY = `import json, sys
MARK = ${JSON.stringify(MARK)}
def say(obj):
    sys.stdout.write(MARK + json.dumps(obj) + "\\n")
    sys.stdout.flush()
model, voices, voice, speed, lang = sys.argv[1:6]
from kokoro_onnx import Kokoro
import soundfile as sf
kokoro = Kokoro(model, voices)
say({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        samples, rate = kokoro.create(req["text"], voice=voice, speed=float(speed), lang=lang)
        sf.write(req["out"], samples, rate, format="OGG", subtype="VORBIS")
        say({"id": req["id"], "ok": True, "duration": len(samples) / rate})
    except Exception as exc:
        say({"id": req.get("id"), "ok": False, "error": str(exc)})
`;

export interface ChildLike {
	stdin: Writable | null;
	stdout: Readable | null;
	stderr: Readable | null;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export interface TtsDeps {
	/** Test seam: the process spawner. */
	spawn?: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;
	/** Test seam: locate uv. */
	resolveUv?: () => Promise<string | undefined>;
	/** Test seam: the downloader's fetch. */
	fetch?: typeof fetch;
	/** Where the model and voices live (default ~/.cache/kokoro). */
	cacheDir?: string;
	abortSignal?: AbortSignal;
	onActivity?: (line: string) => void;
}

export interface NarrationItem {
	text: string;
	/** Absolute path of the .ogg to write. */
	out: string;
}

export type NarrationResult = { ok: true; durations: number[] } | { ok: false; reason: string };

export function kokoroCacheDir(): string {
	return path.join(os.homedir(), ".cache", "kokoro");
}

export function resolveUv(): Promise<string | undefined> {
	const home = os.homedir();
	const knownDirs =
		process.platform === "win32"
			? [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")]
			: [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	return resolveBinary({ envVar: "LH_UV_BIN", names: process.platform === "win32" ? ["uv.exe"] : ["uv"], knownDirs });
}

/** The exact uv arguments (exported for tests). */
export function uvArgs(script: string, model: string, voices: string): string[] {
	return ["run", "--quiet", "--with", KOKORO_ONNX_PIN, "--with", SOUNDFILE_PIN, "python", "-I", script, model, voices, KOKORO_VOICE, String(KOKORO_SPEED), KOKORO_LANG];
}

/** The child environment: the server's, minus every key LearnHarness holds. */
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of appHeldEnvVars()) delete env[name];
	return env;
}

/** Download one release asset into the cache unless it is already there. */
async function ensureFile(dir: string, file: string, doFetch: typeof fetch, signal?: AbortSignal, onActivity?: (l: string) => void): Promise<string> {
	const target = path.join(dir, file);
	if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
	fs.mkdirSync(dir, { recursive: true });
	onActivity?.(`narration: downloading ${file}`);
	const url = `${KOKORO_RELEASE}/${file}`;
	const res = await doFetch(url, { signal, redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`downloading ${file} failed: HTTP ${res.status}`);
	const bytes = Buffer.from(await res.arrayBuffer());
	const expected = Number(res.headers.get("content-length") ?? NaN);
	if (Number.isFinite(expected) && expected > 0 && bytes.length !== expected)
		throw new Error(`downloading ${file} failed: got ${bytes.length} of ${expected} bytes`);
	if (bytes.length === 0) throw new Error(`downloading ${file} failed: empty file`);
	const part = `${target}.part-${process.pid}`;
	fs.writeFileSync(part, bytes);
	fs.renameSync(part, target);
	return target;
}

/** Synthesise every item in order with one Kokoro process. Never throws.
 *  A failed step (an error reply, a timeout, or the process dying) is
 *  retried once; a dead or stuck process is restarted once per deck, from
 *  the same temp script, and the deck continues from that step. An abort is
 *  never retried. */
export async function synthesizeNarration(items: NarrationItem[], deps: TtsDeps = {}): Promise<NarrationResult> {
	if (items.length === 0) return { ok: true, durations: [] };
	let tmp: string | null = null;
	let session: Session | null = null;
	try {
		const uv = await (deps.resolveUv ?? resolveUv)();
		if (!uv) return { ok: false, reason: "uv was not found (install uv from astral.sh, or set LH_UV_BIN)" };
		const dir = deps.cacheDir ?? kokoroCacheDir();
		const doFetch = deps.fetch ?? fetch;
		let model: string;
		let voices: string;
		try {
			model = await ensureFile(dir, KOKORO_MODEL_FILE, doFetch, deps.abortSignal, deps.onActivity);
			voices = await ensureFile(dir, KOKORO_VOICES_FILE, doFetch, deps.abortSignal, deps.onActivity);
		} catch (err) {
			return { ok: false, reason: `the Kokoro model could not be downloaded: ${err instanceof Error ? err.message : String(err)}` };
		}
		if (deps.abortSignal?.aborted) return { ok: false, reason: "aborted" };
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-kokoro-"));
		const script = path.join(tmp, "narrate.py");
		fs.writeFileSync(script, NARRATE_PY, "utf-8");
		const spawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
		const cwd = tmp;
		const startSession = () => {
			deps.onActivity?.("narration: starting Kokoro");
			return new Session(spawn(uv, uvArgs(script, model, voices), { cwd, env: childEnv() }), deps.abortSignal);
		};
		session = startSession();
		let restarted = false;
		const durations: number[] = [];
		for (let i = 0; i < items.length; i++) {
			deps.onActivity?.(`narration: step ${i + 1} of ${items.length}`);
			let reply = await session.say(items[i]!);
			if (!reply.ok) {
				if (deps.abortSignal?.aborted) return { ok: false, reason: "aborted" };
				const first = reply.reason;
				if (!reply.alive) {
					if (restarted) return { ok: false, reason: `step ${i + 1} failed (${first}) and the Kokoro process had already been restarted once` };
					restarted = true;
					session.kill();
					session = startSession();
				}
				deps.onActivity?.(`narration: retrying step ${i + 1}`);
				reply = await session.say(items[i]!);
				if (!reply.ok) {
					if (deps.abortSignal?.aborted) return { ok: false, reason: "aborted" };
					return { ok: false, reason: `step ${i + 1} failed twice (retried once): ${first}; then ${reply.reason}` };
				}
			}
			durations.push(reply.duration);
		}
		return { ok: true, durations };
	} catch (err) {
		return { ok: false, reason: `narration failed: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		session?.kill();
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	}
}

type StepReply = { ok: true; duration: number } | { ok: false; reason: string; alive: boolean };

/** One Kokoro process speaking the JSON-lines protocol. */
class Session {
	private stderr = "";
	private dead: string | null = null;
	private readyFlag = false;
	private readyWaiters: Array<() => void> = [];
	private pending: { id: number; item: NarrationItem; resolve: (r: StepReply) => void; timer: ReturnType<typeof setTimeout> } | null = null;
	private seq = 0;
	private readonly onAbort = () => this.die("aborted");

	constructor(
		private readonly child: ChildLike,
		private readonly abortSignal?: AbortSignal,
	) {
		abortSignal?.addEventListener("abort", this.onAbort, { once: true });
		child.stderr?.on("data", (d: Buffer | string) => {
			this.stderr = (this.stderr + String(d)).slice(-2000);
		});
		child.on("error", (err) => this.die(`could not start uv: ${err.message}`));
		// A write to a closed pipe (EPIPE) while the child is still alive is an
		// 'error' on stdin; unhandled, it would crash the whole server. Treat it
		// as a dead session, which the retry/restart logic handles.
		child.stdin?.on("error", (err) => this.die(`writing to the Kokoro process failed: ${err.message}`));
		child.on("exit", (code, signal) => {
			const tail = this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}` : "";
			this.die(`the Kokoro process exited (${signal ?? `code ${code}`})${tail}`);
		});
		if (!child.stdout) {
			this.die("no stdout from the Kokoro process");
			return;
		}
		createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
	}

	private onLine(line: string): void {
		if (!line.startsWith(MARK)) return;
		let msg: { ready?: boolean; id?: number; ok?: boolean; duration?: number; error?: string };
		try {
			msg = JSON.parse(line.slice(MARK.length));
		} catch {
			return;
		}
		if (msg.ready) {
			this.readyFlag = true;
			for (const w of this.readyWaiters.splice(0)) w();
			return;
		}
		const p = this.pending;
		if (!p || msg.id !== p.id) return;
		if (!msg.ok) return this.settle({ ok: false, reason: msg.error ?? "unknown error", alive: true });
		if (typeof msg.duration !== "number" || !Number.isFinite(msg.duration) || msg.duration <= 0)
			return this.settle({ ok: false, reason: "no audio was produced", alive: true });
		if (!fs.existsSync(p.item.out)) return this.settle({ ok: false, reason: "the audio file is missing", alive: true });
		this.settle({ ok: true, duration: msg.duration });
	}

	private settle(reply: StepReply): void {
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		clearTimeout(p.timer);
		p.resolve(reply);
	}

	private die(reason: string): void {
		if (this.dead) return;
		this.dead = reason;
		for (const w of this.readyWaiters.splice(0)) w();
		this.settle({ ok: false, reason, alive: false });
	}

	/** Synthesise one item: wait for the model to load, then send the request. */
	async say(item: NarrationItem): Promise<StepReply> {
		if (!this.readyFlag && !this.dead) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.die("timed out while starting");
					this.kill();
				}, STARTUP_TIMEOUT_MS);
				this.readyWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		if (this.dead) return { ok: false, reason: this.dead, alive: false };
		return new Promise<StepReply>((resolve) => {
			const id = this.seq++;
			const timer = setTimeout(() => {
				// A stuck process is treated as dead: it is killed and restarted.
				this.die("timed out");
				this.kill();
			}, UTTERANCE_TIMEOUT_MS);
			this.pending = { id, item, resolve, timer };
			try {
				this.child.stdin?.write(`${JSON.stringify({ id, text: item.text, out: item.out })}\n`);
			} catch (err) {
				this.die(`writing to the Kokoro process failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	kill(): void {
		this.abortSignal?.removeEventListener("abort", this.onAbort);
		try {
			this.child.stdin?.end();
		} catch {
			/* already closed */
		}
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
}
