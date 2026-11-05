"use client";

import { memo, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileDownIcon, MaximizeIcon, MinimizeIcon, PauseIcon, PlayIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { SvgImage } from "@/components/artifacts/svg-image";
import { DemoCard } from "@/components/artifacts/demo-card";
import type { ArtifactPartProps } from "@/src/core";
// A pure core fork module, imported directly so the upstream core barrel stays
// unmodified (FORK.md, "StatQuest method and slide decks").
/* eslint-disable import/no-restricted-paths */
import {
	FORK_SLIDES_DECK_FILE,
	deckTimeline,
	forkSlidesAssetUrl,
	forkSlidesFlatSteps,
	formatClock,
	isForkSlidesResult,
	subjectPartReceived,
	timelineAt,
	timelineIndex,
	timelineTime,
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
 * Layout: the current frame, the narration player (▶/⏸, a scrub bar over
 * the whole deck, elapsed/total) when the deck has audio, the slide's
 * transcript (its steps' `say` text, the step being shown or spoken
 * emphasised), then ◀ n / N ▶. ◀/▶ move by slide, landing on its first
 * build step (the audio jumps there too); clicking the frame advances one
 * build step. Space toggles play (without audio it advances one step).
 * Arrow keys work while the card is focused. Playback runs through every
 * build step in order, each step's audio advancing the frame in sync, with
 * a pause after each step (longer at a slide boundary, none after the last)
 * that the clock, scrub bar and seeking count; the timeline math is pure
 * (src/core/fork-slides.ts). The expand button makes
 * this same live card fill the app window with CSS (fixed inset-0 z-50, the
 * z-index upstream's full-window dialogs use), so the player, scrub bar,
 * keys and invert keep working with no remount; Esc exits from anywhere.
 * (The Fullscreen API is not used: the desktop app's permission handler
 * denies "fullscreen", so requestFullscreen never settles there.) The card
 * stays in place in the transcript (a wrapper keeps its height), so no
 * portal: none of the transcript's ancestors sets a transform or filter
 * that would trap position: fixed.
 */

/** The `slides` tool part (the artifact registry's renderer): a subject or
 *  recap video part that did not complete the video has no job of its own, so it
 *  shows a quiet "received" line; every other call is upstream's demo
 *  dispatch card. */
export function ForkSlidesDispatchCard({ part }: ArtifactPartProps) {
	const received = part.state === "output-available" ? subjectPartReceived(part.output) : null;
	if (!received) return <DemoCard part={part} />;
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="fork-slides-part-received">
			<span className="font-medium uppercase tracking-wide">Video</span>
			<span>
				part {received.part} of {received.of} received
			</span>
		</div>
	);
}

/** The kind label above the card's title (the CSS uppercases it). Pure. */
export function forkSlidesKindLabel(kind: ForkSlidesDeck["kind"]): string {
	return kind === "deck" ? "slides" : kind === "recap" ? "recap video" : "video";
}

/** The visible note for subject or recap video parts that could not be drawn ("" when none). Pure. */
export function missingPartsNote(deck: ForkSlidesDeck): string {
	return (deck.parts?.missing ?? []).map((p) => `Part ${p} of ${deck.parts!.of} could not be drawn.`).join(" ");
}

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

/** The card's classes, inline and expanded. Pure. Expanded, the card fills
 *  the app window over everything (z-50, as upstream's full-window dialogs);
 *  the frame takes the height left by the transcript and controls and scales
 *  to fit, keeping its aspect ratio, on the app's background colour.
 *  lh-no-drag keeps the desktop window's top drag band from swallowing
 *  clicks on the expanded card. */
export function forkSlidesLayout(expanded: boolean): { root: string; frame: string; image: string } {
	return expanded
		? {
				root: "lh-no-drag fixed inset-0 z-50 flex flex-col overflow-auto overscroll-contain bg-background p-4 text-foreground outline-none",
				frame: "flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center",
				image: "block h-full w-full object-contain",
			}
		: {
				root: "my-4 w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
				frame: "block w-full cursor-pointer overflow-hidden rounded-lg border bg-white",
				image: "block h-auto w-full",
			};
}

/** The expand button's label. Pure. */
export function expandLabel(expanded: boolean): { aria: string; title: string } {
	return expanded
		? { aria: "Exit the expanded deck (Esc)", title: "Exit (Esc)" }
		: { aria: "Expand the deck to fill the window", title: "Fill the window" };
}

/** Whether a key leaves the expanded view. Pure. */
export function exitsExpanded(expanded: boolean, key: string): boolean {
	return expanded && (key === "Escape" || key === "Esc");
}

/** The frame image, memoised: the pause clock (every 100 ms) and the audio's
 *  timeupdate re-render the card, and SvgImage repairs and URI-encodes the
 *  whole SVG on every render. Same props, same image. */
export const FrameImage = memo(SvgImage);

export function ForkSlidesCard({
	result,
	messageId,
	initialInverted = false,
	initialExpanded = false,
}: {
	result: ForkSlidesResult;
	messageId?: string;
	initialInverted?: boolean;
	/** Test/preview seam: start expanded. */
	initialExpanded?: boolean;
}) {
	const deck = result.forkSlides;
	const actions = useContext(ChatActionsContext);
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

	// ── the narration player ──
	const timeline = useMemo(() => deckTimeline(deck), [deck]);
	const flat = useMemo(() => forkSlidesFlatSteps(deck), [deck]);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const playingRef = useRef(false);
	const [offset, setOffset] = useState(0);
	const pendingSeek = useRef(0);
	const index = timeline ? timelineIndex(timeline, pos.slide, pos.step) : -1;
	const stepAudio = index >= 0 ? timeline!.steps[index]!.audio : undefined;
	const setPlay = (next: boolean) => {
		playingRef.current = next;
		setPlaying(next);
	};
	// The silence after a step (src/core/fork-slides.ts STEP_PAUSE/SLIDE_PAUSE)
	// runs on a timer that advances the clock, then moves to the next step.
	const pauseTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	const stopPause = () => {
		if (pauseTimer.current) clearInterval(pauseTimer.current);
		pauseTimer.current = null;
	};
	/** Run step i's trailing pause from `from` seconds into the step, then go on (or stop after the last). */
	const runPause = (i: number, from: number) => {
		stopPause();
		const s = timeline!.steps[i]!;
		const t0 = Date.now() - Math.max(from - s.duration, 0) * 1000;
		const tick = () => {
			const at = s.duration + (Date.now() - t0) / 1000;
			if (at < s.duration + s.pause) {
				setOffset(at);
				return;
			}
			stopPause();
			const next = timeline!.steps[i + 1];
			if (next) go({ slide: next.slide, step: next.step });
			else setPlay(false);
		};
		tick();
		if (s.pause > 0) pauseTimer.current = setInterval(tick, 100);
	};
	/** Move to a position (and an offset into its narration or its pause). */
	const go = (next: DeckPosition, seek = 0) => {
		stopPause();
		pendingSeek.current = seek;
		setOffset(seek);
		setPos({ ...next });
	};
	// Load the current step's narration on every move; keep playing if playing.
	useEffect(() => {
		const a = audioRef.current;
		if (!a || !stepAudio) return;
		const url = forkSlidesAssetUrl(deck.jobId, stepAudio);
		const seek = pendingSeek.current;
		pendingSeek.current = 0;
		const apply = () => {
			try {
				a.currentTime = seek;
			} catch {
				/* not seekable yet */
			}
			if (!playingRef.current) return;
			// A seek into the pause resumes the silence, not the narration.
			if (timeline && index >= 0 && seek >= timeline.steps[index]!.duration) runPause(index, seek);
			else void a.play().catch(() => setPlay(false));
		};
		if (a.dataset.src !== url) {
			a.dataset.src = url;
			a.src = url;
			a.addEventListener("loadedmetadata", apply, { once: true });
			a.load();
		} else apply();
	}, [pos, stepAudio, deck.jobId]);
	useEffect(() => {
		const a = audioRef.current;
		return () => {
			a?.pause();
			if (pauseTimer.current) clearInterval(pauseTimer.current);
		};
	}, []);
	const togglePlay = () => {
		const a = audioRef.current;
		if (!timeline || !a) return;
		if (playingRef.current) {
			setPlay(false);
			stopPause();
			a.pause();
			return;
		}
		setPlay(true);
		const last = timeline.steps.length - 1;
		if (index === last && a.ended) {
			const first = timeline.steps[0]!;
			go({ slide: first.slide, step: first.step });
			return;
		}
		if (index >= 0 && offset >= timeline.steps[index]!.duration) runPause(index, offset);
		else void a.play().catch(() => setPlay(false));
	};
	const onEnded = () => {
		if (timeline && index >= 0) runPause(index, timeline.steps[index]!.duration);
	};
	const elapsed = timeline && index >= 0 ? timelineTime(timeline, index, offset) : 0;

	// ── expanded: the same live card fills the app window (CSS only) ──
	const rootRef = useRef<HTMLDivElement | null>(null);
	const expandButtonRef = useRef<HTMLButtonElement | null>(null);
	const [expanded, setExpanded] = useState(initialExpanded);
	// The card's inline height while expanded, so the transcript doesn't
	// reflow under it (measured on entering).
	const [placeholder, setPlaceholder] = useState<number | null>(null);
	const toggleExpanded = () => {
		if (!expanded) setPlaceholder(rootRef.current?.offsetHeight ?? null);
		setExpanded(!expanded);
	};
	const wasExpanded = useRef(initialExpanded);
	useEffect(() => {
		if (wasExpanded.current === expanded) return;
		wasExpanded.current = expanded;
		// Focus follows the mode: the card on entering (keys and Space work),
		// the button again on exit.
		if (expanded) rootRef.current?.focus();
		else expandButtonRef.current?.focus();
	}, [expanded]);
	useEffect(() => {
		if (!expanded) return;
		// Esc exits even when focus is elsewhere; captured so nothing else
		// in the app acts on this Esc too.
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (!exitsExpanded(true, e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			setExpanded(false);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [expanded]);

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
		if (exitsExpanded(expanded, e.key)) {
			e.preventDefault();
			setExpanded(false);
			return;
		}
		// Space on a focused button is that button's own click.
		const target = e.target as HTMLElement;
		const onButton = e.target !== e.currentTarget && target.closest?.("button") !== null;
		const isSpace = e.key === " " || e.key === "Spacebar";
		if (onButton && isSpace) return;
		if (target.tagName === "INPUT" && e.key !== " ") return; // the scrub bar keeps its own arrow keys
		if (isSpace && timeline) {
			e.preventDefault();
			togglePlay();
			return;
		}
		const next = deckKey(deck, pos, e.key);
		if (!next) return;
		e.preventDefault();
		go(next);
	};
	const downloadDeck = () => {
		void fetch(forkSlidesAssetUrl(deck.jobId, FORK_SLIDES_DECK_FILE))
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
			.then((html) => downloadFile(`${slugFilename(result.title)}.html`, html, "text/html"))
			.catch(() => {});
	};
	const flatIndex = flat.findIndex((s) => s.slide === pos.slide && s.step === pos.step);

	const layout = forkSlidesLayout(expanded);
	const label = expandLabel(expanded);
	const missingNote = missingPartsNote(deck);

	return (
		// The wrapper is always rendered, so expanding never changes the tree
		// above the card: React keeps every node (the <audio> included).
		<div data-testid="fork-slides-slot" style={expanded && placeholder ? { height: placeholder } : undefined}>
		<div
			ref={rootRef}
			className={layout.root}
			tabIndex={0}
			onKeyDown={onKeyDown}
			data-testid="fork-slides-card"
			data-expanded={expanded ? "true" : undefined}
			role={expanded ? "dialog" : undefined}
			aria-modal={expanded ? true : undefined}
			aria-label={`Slide deck: ${result.title}`}
		>
			<div className="mb-2 flex min-w-0 items-baseline gap-2">
				<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{forkSlidesKindLabel(deck.kind)}
				</span>
				<span className="truncate text-xs font-medium tracking-wide text-foreground">{result.title}</span>
			</div>
			{missingNote && (
				<p className="mb-2 text-xs text-amber-500" data-testid="fork-slides-missing-parts">
					{missingNote}
				</p>
			)}
			<button
				type="button"
				className={layout.frame}
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				onClick={() => go(nextBuildStep(deck, pos))}
				aria-label="Next build step"
				data-testid="fork-slides-frame"
			>
				{svg ? (
					<FrameImage svg={svg} className={layout.image} />
				) : (
					<div className="flex aspect-video w-full items-center justify-center text-sm text-neutral-500">
						{currentFile && missing[currentFile] ? "This frame could not be loaded." : "Loading…"}
					</div>
				)}
			</button>
			{timeline && (
				<div className="mt-2 flex items-center gap-2" data-testid="fork-slides-player">
					<button
						type="button"
						aria-label={playing ? "Pause narration" : "Play narration"}
						title={playing ? "Pause" : "Play"}
						onClick={togglePlay}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						data-testid="fork-slides-play"
					>
						{playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
					</button>
					<input
						type="range"
						min={0}
						max={timeline.total}
						step={0.1}
						value={elapsed}
						aria-label="Narration position"
						onChange={(e) => {
							const at = timelineAt(timeline, Number(e.target.value));
							const s = timeline.steps[at.index]!;
							go({ slide: s.slide, step: s.step }, at.offset);
						}}
						className="h-1 min-w-0 flex-1 cursor-pointer accent-foreground"
						data-testid="fork-slides-scrub"
					/>
					<span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="fork-slides-clock">
						{formatClock(elapsed)} / {formatClock(timeline.total)}
					</span>
					<audio
						ref={audioRef}
						preload="none"
						onEnded={onEnded}
						onTimeUpdate={(e) => setOffset(e.currentTarget.currentTime)}
						className="hidden"
					/>
				</div>
			)}
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
						onClick={() => go(moveSlide(deck, pos, -1))}
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
						onClick={() => go(moveSlide(deck, pos, 1))}
						disabled={pos.slide >= total - 1}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
						data-testid="fork-slides-next"
					>
						<ChevronRightIcon className="size-4" />
					</button>
					<span className="ml-2 text-xs tabular-nums text-muted-foreground/70">
						{slide.part !== undefined && deck.parts ? `part ${slide.part} of ${deck.parts.of} · ` : ""}step {pos.step + 1} of {slide.steps.length} · {flatIndex + 1}/{flat.length}
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
					<button
						ref={expandButtonRef}
						type="button"
						aria-label={label.aria}
						title={label.title}
						aria-pressed={expanded}
						onClick={toggleExpanded}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						data-testid="fork-slides-open"
					>
						{expanded ? <MinimizeIcon className="size-3.5" /> : <MaximizeIcon className="size-3.5" />}
					</button>
				</div>
			</div>
		</div>
		</div>
	);
}
