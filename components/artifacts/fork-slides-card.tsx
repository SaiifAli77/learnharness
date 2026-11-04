"use client";

import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileDownIcon, MaximizeIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { SvgImage } from "@/components/artifacts/svg-image";
// A pure core fork module, imported directly so the upstream core barrel stays
// unmodified (FORK.md, "StatQuest method and slide decks").
/* eslint-disable import/no-restricted-paths */
import {
	FORK_SLIDES_DECK_FILE,
	forkSlidesAssetUrl,
	forkSlidesFlatSteps,
	isForkSlidesResult,
	type ForkSlidesDeck,
	type ForkSlidesResult,
} from "@/src/core/fork-slides";
/* eslint-enable import/no-restricted-paths */

export { isForkSlidesResult };

/**
 * Fork-only: the slide deck card (FORK.md "StatQuest method and slide
 * decks"). Picked by a one-line branch in steer-card.tsx's demo case when
 * the result is a slides result. Frame SVGs are fetched from the read-only
 * fork route and shown through SvgImage (an image document, like the figure
 * card), never inline in the app's DOM.
 *
 * Layout: the current frame, the slide's transcript (its steps' `say` text,
 * the current step emphasised), then ◀ n / N ▶. ◀/▶ move by slide, landing
 * on its first build step; clicking the frame or Space advances one build
 * step. Arrow keys work while the card is focused.
 */

/** A position in the deck: slide and build step, both 0-based. */
export interface DeckPosition {
	slide: number;
	step: number;
}

/** One build step forward, across slide ends; stays put at the deck's end. Pure. */
export function nextBuildStep(deck: ForkSlidesDeck, pos: DeckPosition): DeckPosition {
	const steps = deck.slides[pos.slide]?.steps.length ?? 0;
	if (pos.step + 1 < steps) return { slide: pos.slide, step: pos.step + 1 };
	if (pos.slide + 1 < deck.slides.length) return { slide: pos.slide + 1, step: 0 };
	return pos;
}

/** Move by whole slides, landing on the target slide's first build step. Pure. */
export function moveSlide(deck: ForkSlidesDeck, pos: DeckPosition, delta: number): DeckPosition {
	const slide = Math.min(Math.max(pos.slide + delta, 0), Math.max(deck.slides.length - 1, 0));
	return { slide, step: 0 };
}

/** Key handling while the card is focused. Pure: returns the new position, or null to ignore the key. */
export function deckKey(deck: ForkSlidesDeck, pos: DeckPosition, key: string): DeckPosition | null {
	if (key === "ArrowRight") return moveSlide(deck, pos, 1);
	if (key === "ArrowLeft") return moveSlide(deck, pos, -1);
	if (key === " " || key === "Spacebar") return nextBuildStep(deck, pos);
	return null;
}

export function ForkSlidesCard({
	result,
	messageId,
	initialInverted = false,
}: {
	result: ForkSlidesResult;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const deck = result.forkSlides;
	const actions = useContext(ChatActionsContext);
	const overlay = useSessionMermaid();
	const [pos, setPos] = useState<DeckPosition>({ slide: 0, step: 0 });
	const [frames, setFrames] = useState<Record<string, string>>({});
	const [missing, setMissing] = useState<Record<string, true>>({});
	// Invert persists on the steer record via the artifact-ui route (it
	// accepts demo steers), exactly like the figure and demo cards.
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};

	const slide = deck.slides[pos.slide];
	const current = slide?.steps[pos.step];
	const currentFile = current?.frame;

	// Fetch the current slide's frames (the current one first), once each.
	const requested = useRef(new Set<string>());
	useEffect(() => {
		if (!slide) return;
		const files = [currentFile, ...slide.steps.map((s) => s.frame)].filter((f, i, a): f is string => !!f && a.indexOf(f) === i);
		for (const file of files) {
			if (requested.current.has(file)) continue;
			requested.current.add(file);
			void fetch(forkSlidesAssetUrl(deck.jobId, file))
				.then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
				.then((svg) => setFrames((prev) => ({ ...prev, [file]: svg })))
				.catch(() => setMissing((prev) => ({ ...prev, [file]: true })));
		}
	}, [deck.jobId, slide, currentFile]);

	if (!slide || !current) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" data-testid="fork-slides-empty">
				The slide deck is empty.
			</div>
		);
	}
	const svg = currentFile ? frames[currentFile] : undefined;
	const total = deck.slides.length;
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// Space on a focused button is that button's own click.
		const onButton = e.target !== e.currentTarget && (e.target as HTMLElement).closest?.("button") !== null;
		if (onButton && (e.key === " " || e.key === "Spacebar")) return;
		const next = deckKey(deck, pos, e.key);
		if (!next) return;
		e.preventDefault();
		setPos(next);
	};
	const downloadDeck = () => {
		void fetch(forkSlidesAssetUrl(deck.jobId, FORK_SLIDES_DECK_FILE))
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
			.then((html) => downloadFile(`${slugFilename(result.title)}.html`, html, "text/html"))
			.catch(() => {});
	};
	const flat = forkSlidesFlatSteps(deck);
	const flatIndex = flat.findIndex((s) => s.slide === pos.slide && s.step === pos.step);

	return (
		<div
			className="my-4 w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
			tabIndex={0}
			onKeyDown={onKeyDown}
			data-testid="fork-slides-card"
			aria-label={`Slide deck: ${result.title}`}
		>
			<div className="mb-2 flex min-w-0 items-baseline gap-2">
				<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{deck.kind === "video" ? "video" : "slides"}
				</span>
				<span className="truncate text-xs font-medium tracking-wide text-foreground">{result.title}</span>
			</div>
			<button
				type="button"
				className="block w-full cursor-pointer overflow-hidden rounded-lg border bg-white"
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				onClick={() => setPos(nextBuildStep(deck, pos))}
				aria-label="Next build step"
				data-testid="fork-slides-frame"
			>
				{svg ? (
					<SvgImage svg={svg} className="block h-auto w-full" />
				) : (
					<div className="flex aspect-video w-full items-center justify-center text-sm text-neutral-500">
						{currentFile && missing[currentFile] ? "This frame could not be loaded." : "Loading…"}
					</div>
				)}
			</button>
			<p className="mt-3 text-sm leading-relaxed text-muted-foreground" data-testid="fork-slides-transcript">
				{slide.steps.map((s, i) => (
					<span key={i} className={i === pos.step ? "font-medium text-foreground" : undefined}>
						{i > 0 ? " " : ""}
						{s.say}
					</span>
				))}
			</p>
			<div className="mt-2 flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<button
						type="button"
						aria-label="Previous slide"
						title="Previous slide"
						onClick={() => setPos(moveSlide(deck, pos, -1))}
						disabled={pos.slide === 0}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
						data-testid="fork-slides-prev"
					>
						<ChevronLeftIcon className="size-4" />
					</button>
					<span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" data-testid="fork-slides-counter">
						{pos.slide + 1} / {total}
					</span>
					<button
						type="button"
						aria-label="Next slide"
						title="Next slide"
						onClick={() => setPos(moveSlide(deck, pos, 1))}
						disabled={pos.slide >= total - 1}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
						data-testid="fork-slides-next"
					>
						<ChevronRightIcon className="size-4" />
					</button>
					<span className="ml-2 text-xs tabular-nums text-muted-foreground/70">
						step {pos.step + 1} of {slide.steps.length} · {flatIndex + 1}/{flat.length}
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert slide brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						aria-label="Download this frame as SVG"
						title="Download frame as SVG"
						disabled={!svg}
						onClick={() => svg && downloadFile(`${slugFilename(result.title)}-${pos.slide + 1}-${pos.step + 1}.svg`, svg, "image/svg+xml")}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
						data-testid="fork-slides-download-frame"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="Download the deck as HTML"
						title="Download deck as HTML"
						onClick={downloadDeck}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						data-testid="fork-slides-download-deck"
					>
						<FileDownIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open frame fullscreen"
							title="Open fullscreen"
							disabled={!svg}
							onClick={() => svg && overlay.openFigure(svg, inverted)}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
							data-testid="fork-slides-open"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
