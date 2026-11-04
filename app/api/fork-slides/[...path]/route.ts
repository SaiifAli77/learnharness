/**
 * Fork-only: GET /api/fork-slides/<jobId>/<file> — serves a slides job's
 * stored assets read-only (FORK.md "StatQuest method and slide decks").
 *
 *   <jobId>/stage.svg, <jobId>/frame-SS-T.svg   the stored SVGs
 *   <jobId>/audio-SS-T.ogg                      a step's narration (audio/ogg, Range-capable)
 *   <jobId>/pN-…                                the same, for part N of a subject video
 *   <jobId>/deck.html                           a generated, self-contained deck (download)
 *
 * Strict validation: exactly two path segments, a job-id-shaped id, and a
 * file name from the fixed set; anything else is a 404 before any disk read
 * (no traversal). SVGs go out as image/svg+xml with nosniff and a CSP that
 * forbids scripts.
 */
// Fork files are imported directly so the upstream barrels (src/core/index.ts,
// src/server/index.ts) stay unmodified (FORK.md, "StatQuest method and slide decks").
/* eslint-disable import/no-restricted-paths */
import { FORK_SLIDES_DECK_FILE, FORK_SLIDES_JOB_ID_RE, isForkSlidesResult } from "@/src/core/fork-slides";
import { buildDeckHtml } from "@/src/agent/fork-slides/deck-html";
import { readForkSlidesAsset, readForkSlidesAssetBytes } from "@/src/agent/fork-slides/storage";
import { stores } from "@/src/server/stores";
/* eslint-enable import/no-restricted-paths */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
	const { path } = await ctx.params;
	if (!Array.isArray(path) || path.length !== 2) return NOT_FOUND();
	const [jobId, file] = path as [string, string];
	if (!FORK_SLIDES_JOB_ID_RE.test(jobId)) return NOT_FOUND();

	if (file === FORK_SLIDES_DECK_FILE) {
		const job = stores.jobStore.getJob(jobId);
		const result = job?.result;
		if (!job || !isForkSlidesResult(result) || result.forkSlides.jobId !== jobId) return NOT_FOUND();
		const frames: Record<string, string> = {};
		for (const slide of result.forkSlides.slides)
			for (const step of slide.steps) {
				const svg = readForkSlidesAsset(jobId, step.frame);
				if (svg === null) return NOT_FOUND();
				frames[step.frame] = svg;
			}
		return new Response(buildDeckHtml(result.title, result.forkSlides, frames), {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Disposition": 'attachment; filename="deck.html"',
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
			},
		});
	}

	if (file.endsWith(".ogg")) {
		const bytes = readForkSlidesAssetBytes(jobId, file);
		if (bytes === null) return NOT_FOUND();
		return audioResponse(bytes, req.headers.get("range"));
	}

	const svg = readForkSlidesAsset(jobId, file);
	if (svg === null) return NOT_FOUND();
	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
			"Cache-Control": "private, max-age=3600",
		},
	});
}

/** audio/ogg with single-range support, so the player can seek. */
function audioResponse(bytes: Buffer, range: string | null): Response {
	const headers: Record<string, string> = {
		"Content-Type": "audio/ogg",
		"Accept-Ranges": "bytes",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "private, max-age=3600",
	};
	const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (range && !m) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
	if (m && (m[1] || m[2])) {
		// "a-b", "a-" (to the end) or "-n" (the last n bytes).
		const start = m[1] ? Number(m[1]) : Math.max(bytes.length - Number(m[2]), 0);
		const end = Math.min(m[1] && m[2] ? Number(m[2]) : bytes.length - 1, bytes.length - 1);
		if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
		const body = new Uint8Array(bytes.subarray(start, end + 1));
		return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(body.length) } });
	}
	return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
}
