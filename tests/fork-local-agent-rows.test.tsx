/**
 * Fork-only: the Claude Code and Antigravity rows (PR #151) on the
 * Subscriptions surfaces. Replaces two upstream assertions that count exactly
 * three Connect rows; those upstream tests are skipped in scripts/fork-test.mjs
 * so upstream test files stay unmodified (see FORK.md).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SubscriptionConnections, NativeSubscriptionUIProvider } from "../components/settings/subscription-connections.tsx";
import { ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { LOCAL_AGENTS } from "../src/core/index.ts";

const UPSTREAM_LABELS = ["ChatGPT", "GitHub Copilot", "Grok"];
// Local-agent rows carry the runtime in the label, e.g. "Claude (Claude Code)".
const LOCAL_LABELS = LOCAL_AGENTS.map((agent) => `${agent.label} (${agent.runtime})`);

test("compact rows render in approved order, local agents after the app-owned sign-ins, with no fabricated identities", () => {
	const html = renderToStaticMarkup(<ChatGPTUIProvider><NativeSubscriptionUIProvider><SubscriptionConnections /></NativeSubscriptionUIProvider></ChatGPTUIProvider>);
	const order = ["chatgpt", "github-copilot", "xai", "claude-code", "antigravity"].map((id) => html.indexOf(`data-testid="${id}-connection"`));
	for (const [i, at] of order.entries()) assert.ok(at >= 0, `row ${i} missing`);
	for (let i = 1; i < order.length; i++) assert.ok(order[i - 1]! < order[i]!, `row ${i} out of order`);
	assert.equal((html.match(/>Connect<\/button>/g) ?? []).length, 5);
	assert.ok(!html.includes("@"));
	assert.ok(!html.includes("Add accounts"));
});

test("only Providers subscription labels use sans, local-agent rows included; setup labels keep their compact mono styling", () => {
	const settings = renderToStaticMarkup(<SubscriptionConnections />);
	const setup = renderToStaticMarkup(<SubscriptionConnections setup />);
	for (const label of [...UPSTREAM_LABELS, ...LOCAL_LABELS]) {
		assert.ok(settings.includes(`<span class="font-prose text-(length:--lh-prose-size) text-foreground">${label}</span>`), `${label}: settings sans label`);
		assert.ok(setup.includes(`<span class="font-ui text-xs text-foreground">${label}</span>`), `${label}: unchanged setup label`);
	}
	assert.equal((settings.match(/>Connect<\/button>/g) ?? []).length, 5);
	assert.equal((setup.match(/>Connect<\/button>/g) ?? []).length, 5);
});
