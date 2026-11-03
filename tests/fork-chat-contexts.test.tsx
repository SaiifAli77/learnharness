/**
 * Fork-only: guards the stable context values Chat provides
 * (components/fork-chat-contexts.ts, hooked into components/chat.tsx).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseHTML } from "linkedom";
import ts from "typescript";
import { useForkChatActions, useForkSessionMermaid, type ForkChatActions, type ForkSessionMermaid } from "../components/fork-chat-contexts.ts";
import type { ChatInput } from "../src/core/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

const globals = globalThis as Record<string, unknown>;
const previous = new Map<string, PropertyDescriptor | undefined>();
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
	previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
after(() => {
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete globals[key];
	}
});

type Inputs = {
	chatId: string;
	syncFromServer: () => Promise<void>;
	send: (input: ChatInput) => unknown;
	setSetupOpen: (open: boolean) => void;
	setMermaidFocus: (chart: string) => void;
	setFigureFocus: (figure: { svg: string; inverted: boolean }) => void;
	tick: number;
};

async function harness(initial: Inputs) {
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const seen: Array<{ actions: ForkChatActions; mermaid: ForkSessionMermaid }> = [];
	function Harness(p: Inputs) {
		const actions = useForkChatActions(p.chatId, p.syncFromServer, p.send, p.setSetupOpen);
		const mermaid = useForkSessionMermaid(p.setMermaidFocus, p.setFigureFocus);
		seen.push({ actions, mermaid });
		return null;
	}
	let props = initial;
	const render = (next: Partial<Inputs>) =>
		act(async () => {
			props = { ...props, ...next };
			root.render(React.createElement(Harness, props));
		});
	await render({});
	return { seen, render, last: () => seen[seen.length - 1]!, unmount: () => act(async () => root.unmount()) };
}

test("chat contexts: values stay the same object across re-renders, change with an input, and behave as before", async () => {
	const calls: unknown[] = [];
	const sync = async () => {};
	const inputs: Inputs = {
		chatId: "c1",
		syncFromServer: sync,
		send: (input) => calls.push(["send", input]),
		setSetupOpen: (open) => calls.push(["setup", open]),
		setMermaidFocus: (chart) => calls.push(["mermaid", chart]),
		setFigureFocus: (figure) => calls.push(["figure", figure]),
		tick: 0,
	};
	const h = await harness(inputs);
	const first = h.last();
	await h.render({ tick: 1 });
	await h.render({ tick: 2 });
	assert.equal(h.seen.length, 3);
	for (const s of h.seen) {
		assert.equal(s.actions, first.actions, "chat actions are the same object while their inputs are");
		assert.equal(s.mermaid, first.mermaid, "mermaid actions are the same object while their inputs are");
	}

	// Same fields and behaviour as the inline objects chat.tsx used to build.
	assert.deepEqual(Object.keys(first.actions).sort(), ["chatId", "openSetup", "sendText", "syncFromServer"]);
	assert.deepEqual(Object.keys(first.mermaid).sort(), ["openFigure", "openMermaid"]);
	assert.equal(first.actions.chatId, "c1");
	assert.equal(first.actions.syncFromServer, sync);
	assert.equal(first.actions.sendText("hello"), undefined);
	first.actions.openSetup();
	assert.equal(first.mermaid.openMermaid, inputs.setMermaidFocus, "openMermaid is the setter itself");
	first.mermaid.openMermaid("graph TD; a-->b");
	first.mermaid.openFigure("<svg/>", true);
	assert.deepEqual(calls, [
		["send", { type: "text", text: "hello" }],
		["setup", true],
		["mermaid", "graph TD; a-->b"],
		["figure", { svg: "<svg/>", inverted: true }],
	]);

	// Each input produces a new value.
	const changes: Array<[Partial<Inputs>, "actions" | "mermaid"]> = [
		[{ chatId: "c2" }, "actions"],
		[{ syncFromServer: async () => {} }, "actions"],
		[{ send: () => {} }, "actions"],
		[{ setSetupOpen: () => {} }, "actions"],
		[{ setMermaidFocus: () => {} }, "mermaid"],
		[{ setFigureFocus: () => {} }, "mermaid"],
	];
	for (const [change, which] of changes) {
		const before = h.last();
		await h.render(change);
		const now = h.last();
		const other = which === "actions" ? "mermaid" : "actions";
		assert.notEqual(now[which], before[which], `${Object.keys(change)[0]} changes the ${which} value`);
		assert.equal(now[other], before[other], `${Object.keys(change)[0]} leaves the ${other} value alone`);
	}
	assert.equal(h.last().actions.chatId, "c2");
	await h.unmount();
});

test("chat contexts: the hooks supply every field of both context types", () => {
	// A new REQUIRED field already fails typecheck (the hooks' return types are
	// the context types); this also catches a new optional field.
	const file = path.join(ROOT, "components", "fork-chat-contexts.ts");
	const program = ts.createProgram([file], {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.Preserve,
		allowImportingTsExtensions: true,
		noEmit: true,
		skipLibCheck: true,
		esModuleInterop: true,
		resolveJsonModule: true,
		strict: true,
		baseUrl: ROOT,
		paths: { "@/*": ["./*"] },
		types: ["node"],
	});
	const checker = program.getTypeChecker();
	const sf = program.getSourceFile(file)!;
	const fields: Record<string, string[]> = {};
	sf.forEachChild((n) => {
		if (ts.isTypeAliasDeclaration(n) && (n.name.text === "ForkChatActions" || n.name.text === "ForkSessionMermaid")) {
			fields[n.name.text] = checker.getTypeAtLocation(n.name).getProperties().map((p) => p.name).sort();
		}
	});
	assert.deepEqual(fields.ForkChatActions, ["chatId", "openSetup", "sendText", "syncFromServer"], "ChatActionsContext's fields changed: update useForkChatActions (and this list)");
	assert.deepEqual(fields.ForkSessionMermaid, ["openFigure", "openMermaid"], "SessionMermaidContext's fields changed: update useForkSessionMermaid (and this list)");
});

test("chat contexts: chat.tsx provides the hook values", () => {
	const src = fs.readFileSync(path.join(ROOT, "components", "chat.tsx"), "utf8");
	assert.match(src, /<ChatActionsContext\.Provider\s+value=\{useForkChatActions\(chatId, syncFromServer, send, setSetupOpen\)\}\s*>/);
	assert.match(src, /<SessionMermaidContext\.Provider\s+value=\{useForkSessionMermaid\(setMermaidFocus, setFigureFocus\)\}\s*>/);
});
