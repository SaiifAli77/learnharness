/**
 * Fork-only: GET /api/fork-slides/<jobId>/<file> — serves a slides job's
 * stored assets read-only (FORK.md "StatQuest method and slide decks").
 *
 *   <jobId>/stage.svg, <jobId>/frame-SS-T.svg   the stored SVGs
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
import { readForkSlidesAsset } from "@/src/agent/fork-slides/storage";
import { stores } from "@/src/server/stores";
/* eslint-enable import/no-restricted-paths */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
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
