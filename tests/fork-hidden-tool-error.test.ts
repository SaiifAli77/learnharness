/**
 * Fork-only: guards the transcript's hidden tool errors (FORK.md "StatQuest
 * method and slide decks"): a rejected `slides` call and a quiz/explain call
 * rejected by the node-video gate render nothing instead of upstream's
 * "Retrying…" line; every other errored tool, and every abort, renders as
 * upstream renders it. Also pins the hook in components/chat.tsx.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { forkHiddenStep, forkHiddenToolError } from "../components/fork-hidden-tool-error.ts";
import { NODE_VIDEO_GATE_MARKER } from "../src/core/fork-slides.ts";

const GATE_ERROR = `Invalid tool input for tool "quiz":\n- This is the first question on node "n1". ${NODE_VIDEO_GATE_MARKER} (two nodes ahead of the learner): build the video for node "n2" ("N2") now.`;
const part = (type: string, state: string, errorText?: string) => ({ type, state, ...(errorText === undefined ? {} : { errorText }) });

describe("hidden tool errors (fork)", () => {
	it("hides a rejected slides call", () => {
		assert.equal(forkHiddenToolError(part("tool-slides", "output-error", 'Invalid tool input for tool "slides":\n- 3 slides')), true);
	});

	it("hides a quiz or explain call rejected by the node-video gate", () => {
		assert.equal(forkHiddenToolError(part("tool-quiz", "output-error", GATE_ERROR)), true);
		assert.equal(forkHiddenToolError(part("tool-explain", "output-error", GATE_ERROR.replace('"quiz"', '"explain"'))), true);
	});

	it("keeps other quiz/explain errors, other tools' errors, aborts and non-errors unchanged", () => {
		assert.equal(forkHiddenToolError(part("tool-quiz", "output-error", 'Invalid tool input for tool "quiz":\n- nodeId "n9" matches no node')), false);
		assert.equal(forkHiddenToolError(part("tool-explain", "output-error", "something else")), false);
		assert.equal(forkHiddenToolError(part("tool-quiz", "output-error")), false, "no error text");
		assert.equal(forkHiddenToolError(part("tool-demo", "output-error", GATE_ERROR)), false, "the marker on another tool");
		assert.equal(forkHiddenToolError(part("tool-research", "output-error", "boom")), false);
		assert.equal(forkHiddenToolError(part("tool-slides", "output-error", "Operation aborted")), false, "an aborted slides call");
		assert.equal(forkHiddenToolError(part("tool-quiz", "output-error", "Operation aborted")), false, "an aborted quiz");
		assert.equal(forkHiddenToolError(part("tool-slides", "output-available")), false);
		assert.equal(forkHiddenToolError(part("tool-quiz", "input-available", GATE_ERROR)), false);
		assert.equal(forkHiddenToolError({ type: "text" }), false);
	});

	it("hides the step-start of a step that holds only hidden retries, so no blank separators remain", () => {
		const step = { type: "step-start" };
		const hidden = part("tool-slides", "output-error", 'Invalid tool input for tool "slides":\n- too short');
		const gated = part("tool-quiz", "output-error", GATE_ERROR);
		const text = { type: "text", text: "Here is the plan." };
		// [ok step, 4 hidden steps, ok step]
		const parts = [step, text, step, hidden, step, gated, step, hidden, step, hidden, step, part("tool-quiz", "input-available"), text];
		assert.deepEqual(
			parts.map((_, pi) => forkHiddenStep(parts, pi)),
			[false, false, true, false, true, false, true, false, true, false, false, false, false],
			"only the four hidden steps' step-starts",
		);
		const mixed = [step, text, step, hidden, text];
		assert.equal(forkHiddenStep(mixed, 2), false, "a hidden part with visible text keeps its separator");
		assert.equal(forkHiddenStep([step, text, step], 2), false, "a step with no parts is unchanged");
		assert.equal(forkHiddenStep([step, step, text], 0), false, "an empty step before another step");
		assert.equal(forkHiddenStep([step, hidden], 1), false, "not a step-start");
		assert.equal(forkHiddenStep([step, part("tool-slides", "output-error", "Operation aborted")], 0), false, "an abort is not hidden");
	});

	it("the gate's rejection carries the marker", () => {
		assert.equal(NODE_VIDEO_GATE_MARKER, "Node videos are built ahead");
		const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent", "fork-slides", "node-video-gate.ts"), "utf-8");
		assert.match(gate, /\$\{NODE_VIDEO_GATE_MARKER\} \(two nodes ahead of the learner\): \$\{which\}/);
	});

	it("hooks into components/chat.tsx with one import, one line just above upstream's Retrying… branch and one in its step-start case", () => {
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "components", "chat.tsx"), "utf-8");
		assert.match(source, /^import \{ forkHiddenStep, forkHiddenToolError \} from "@\/components\/fork-hidden-tool-error";$/m);
		assert.match(
			source,
			/\n\t+if \(forkHiddenToolError\(part\)\) return null; \/\/ Fork: [^\n]*\n\t+if \(\n\t+part\.state === "output-error" &&\n\t+part\.type\.startsWith\("tool-"\) &&\n\t+part\.errorText !== "Operation aborted"\n\t+\) \{\n\t+return \(\n\t+<SystemLine key=\{`retry-\$\{pi\}`\} testId="tool-retry">\n\t+Retrying…/,
		);
		assert.match(
			source,
			/\n\t+case "step-start":\n\t+if \(teachBoundary\)\n\t+return <PhaseDivider key=\{`teach-step-\$\{pi\}`\} phase="teach" \/>;\n\t+if \(forkHiddenStep\(m\.parts, pi\)\) return null; \/\/ Fork: [^\n]*\n\t+return pi > 0 \? <Separator key=\{pi\} className="my-3" \/> : null;/,
		);
	});
});
