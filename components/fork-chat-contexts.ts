"use client";

/**
 * Fork-only: stable values for the two contexts Chat provides
 * (components/chat.tsx). Chat used to build both objects inline, so every
 * Chat render (each streamed chunk, each keystroke) handed every consumer
 * (artifact cards, image cards, MermaidInline) a new value and re-rendered
 * it, even inside memoised transcript rows. These hooks return the SAME
 * fields with the same behaviour, rebuilt only when an input changes.
 * tests/fork-chat-contexts.test.tsx guards them.
 */
import { useMemo, type ContextType } from "react";
import type { ChatActionsContext } from "@/components/chat";
import type { SessionMermaidContext } from "@/components/session-overlay";
import type { ChatInput } from "@/src/core";

export type ForkChatActions = NonNullable<ContextType<typeof ChatActionsContext>>;
export type ForkSessionMermaid = NonNullable<ContextType<typeof SessionMermaidContext>>;

export function useForkChatActions(
	chatId: string,
	syncFromServer: () => Promise<void>,
	send: (input: ChatInput) => unknown,
	setSetupOpen: (open: boolean) => void,
): ForkChatActions {
	return useMemo(
		(): ForkChatActions => ({
			chatId,
			syncFromServer,
			sendText: (t: string) => {
				void send({ type: "text", text: t });
			},
			openSetup: () => setSetupOpen(true),
		}),
		[chatId, syncFromServer, send, setSetupOpen],
	);
}

export function useForkSessionMermaid(
	setMermaidFocus: (chart: string) => void,
	setFigureFocus: (figure: { svg: string; inverted: boolean }) => void,
): ForkSessionMermaid {
	return useMemo(
		(): ForkSessionMermaid => ({
			openMermaid: setMermaidFocus,
			openFigure: (svg, inverted) => setFigureFocus({ svg, inverted }),
		}),
		[setMermaidFocus, setFigureFocus],
	);
}
