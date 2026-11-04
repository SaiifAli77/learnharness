/**
 * Fork-only: the node-video gate (FORK.md "StatQuest method and slide
 * decks"). Node videos are built two nodes ahead (NODE_VIDEO_LOOKAHEAD):
 * nodes 1 and 2 while the subject video builds, and at node k the videos for
 * the next two nodes. upstream createTeacherTools keeps one hook line: its
 * quizzing tools (quiz/explain) pass through forkNodeVideoGate, which wraps
 * their execute.
 *
 * The first question about a node k (a quiz/explain call, valid otherwise,
 * whose nodeId is not yet reached) is rejected ONCE, so the teacher builds
 * the missing videos in the same turn and re-poses the question, when the
 * slides tool is on, headless rendering is available (videos can be drawn),
 * no subject video job is running in this chat, and some target is missing.
 * The targets are the exact next nodes (nextVideoTargets); a target is
 * covered by a node video job for it that is running or done, and excused
 * when the newest node video job for it ended in error (no rejection loop
 * when that node's video keeps failing; a failure elsewhere excuses nothing).
 *
 * "Reached" is read from the chat record's persisted messages with
 * upstream's plan-position fold (derivePlanStatusesLh: the current node plus
 * the visited ones). A rejected call is persisted with its nodeId at the end
 * of the turn, so after that turn k counts as reached and the gate stays
 * open, across restarts too. Within the turn of the rejection the record
 * does not have the call yet, so the rejection is also remembered in memory
 * per (chat, node) for the life of the process: those nodes count as
 * reached, and the second attempt always passes.
 *
 * While a rejection is pending, pendingNodeVideoGate names k and its
 * missing targets, so the slides tool can refuse a video for k or a node
 * already passed. It is pending only within the turn of the rejection (the
 * persisted record still has the length it had then; calls persist at turn
 * end, so the next turn, after an abort or error too, sees a longer record)
 * and until any quiz/explain call passes the gate (the re-posed question on
 * k, or a question elsewhere when the teacher moves on). A new rejection
 * replaces it.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";
import type { EnabledTools } from "../../core/pending.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
import { derivePlanStatusesLh, type ChatRecord, type PlanNode, type PlanTree } from "../../core/contracts.ts";
import { isForkSlidesInput, NODE_VIDEO_GATE_MARKER } from "../../core/fork-slides.ts";
import type { JobRecord } from "../../core/contracts.ts";
import { getHeadless } from "../subagents/headless.ts";

export interface NodeVideoGateContext {
	chatId: string;
	chatStore: ChatStore;
	jobStore: JobStore;
}

/** How many nodes ahead node videos are built. */
export const NODE_VIDEO_LOOKAHEAD = 2;

/** chatId → nodes whose first question was already rejected once (this process). */
const rejected = new Map<string, Set<string>>();

/** chatId → the gate rejection waiting for its re-posed question: the node,
 *  the targets it named, and the record's message count at the rejection. */
const pending = new Map<string, { k: string; missing: PlanNode[]; messages: number }>();

/** The gate rejection pending in this chat: only within its turn (the
 *  persisted record has not grown since), cleared when any quiz/explain call
 *  passes the gate. */
export function pendingNodeVideoGate(chatId: string, record: Pick<ChatRecord, "messages">): { k: string; missing: PlanNode[] } | undefined {
	const entry = pending.get(chatId);
	return entry && entry.messages === record.messages.length ? entry : undefined;
}

/** The nodes the learner has reached: the persisted current and visited
 *  nodes, plus the nodes whose first question was rejected in this process. */
export function reachedNodes(chatId: string, record: Pick<ChatRecord, "tree" | "messages">): Set<string> {
	const reached = new Set(rejected.get(chatId) ?? []);
	if (!record.tree) return reached;
	const { current, visited } = derivePlanStatusesLh(record.tree, record.messages);
	if (current) reached.add(current);
	for (const n of visited) reached.add(n);
	return reached;
}

/** The next `count` nodes whose videos are due, after node k (null: before
 *  node 1). Candidates are the plan nodes in order, not reached and not k;
 *  each pick is the first candidate whose prerequisites are all reached, k or
 *  already picked, else the first remaining candidate. */
export function nextVideoTargets(tree: PlanTree, reached: ReadonlySet<string>, k: string | null, count = NODE_VIDEO_LOOKAHEAD): PlanNode[] {
	const known = new Set(reached);
	if (k !== null) known.add(k);
	const picked: PlanNode[] = [];
	while (picked.length < count) {
		const candidates = tree.nodes.filter((n) => !known.has(n.id));
		if (candidates.length === 0) break;
		const next = candidates.find((c) => tree.edges.every((e) => e.to !== c.id || known.has(e.from))) ?? candidates[0]!;
		picked.push(next);
		known.add(next.id);
	}
	return picked;
}

/** Per plan node: whether a node video job for it is running or done, and its newest node video job. */
export function nodeVideoJobs(jobs: readonly JobRecord[]): { covered: Set<string>; newest: Map<string, JobRecord> } {
	const covered = new Set<string>();
	const newest = new Map<string, JobRecord>();
	for (const job of jobs) {
		if (job.kind !== "demo" || !isForkSlidesInput(job.input) || job.input.kind !== "video") continue;
		const nodeId = job.input.nodeId ?? "";
		if (job.status === "running" || job.status === "done") covered.add(nodeId);
		const prev = newest.get(nodeId);
		if (!prev || job.createdAt > prev.createdAt) newest.set(nodeId, job);
	}
	return { covered, newest };
}

/** `node "id" ("title")` for the messages. */
export const nodeLabel = (n: PlanNode) => `"${n.id}" ("${n.title}")`;

/** The rejection text for a first question about `nodeId`, or null to let
 *  it through. Records a rejection as pending; any question that passes ends
 *  the pending one (the re-posed question, or the teacher moving on). */
export function nodeVideoGateProblem(ctx: NodeVideoGateContext, nodeId: string): string | null {
	const problem = gateProblem(ctx, nodeId);
	if (problem === null) pending.delete(ctx.chatId);
	return problem;
}

function gateProblem(ctx: NodeVideoGateContext, nodeId: string): string | null {
	const record = ctx.chatStore.getChat(ctx.chatId);
	if (!record?.tree) return null;
	// The re-posed question always passes.
	if (rejected.get(ctx.chatId)?.has(nodeId)) return null;
	const reached = reachedNodes(ctx.chatId, record);
	if (reached.has(nodeId)) return null;
	// No videos can be drawn here (no browser to render frames): never ask for one.
	if (getHeadless().unavailableReason()) return null;
	const targets = nextVideoTargets(record.tree, reached, nodeId);
	if (targets.length === 0) return null;
	const jobs = ctx.jobStore.listJobs(ctx.chatId);
	if (jobs.some((j) => j.kind === "demo" && isForkSlidesInput(j.input) && j.input.kind === "subject" && j.status === "running")) return null;
	const { covered, newest } = nodeVideoJobs(jobs);
	// A target whose newest video failed is excused: asking again would loop.
	const missing = targets.filter((t) => !covered.has(t.id) && newest.get(t.id)?.status !== "error");
	if (missing.length === 0) return null;
	const once = rejected.get(ctx.chatId) ?? new Set<string>();
	once.add(nodeId);
	rejected.set(ctx.chatId, once);
	pending.set(ctx.chatId, { k: nodeId, missing, messages: record.messages.length });
	const which =
		missing.length === 1
			? `build the video for node ${nodeLabel(missing[0]!)} now — a node after "${nodeId}", not "${nodeId}" itself (slides with kind: "video" and that nodeId)`
			: `build the video for ${missing.map((n) => `node ${nodeLabel(n)}`).join(" and ")} now — the nodes after "${nodeId}", not "${nodeId}" itself (slides with kind: "video" and that nodeId, one call per node)`;
	return `This is the first question on node "${nodeId}". ${NODE_VIDEO_GATE_MARKER} (two nodes ahead of the learner): ${which} — then re-pose this question.`;
}

/** Wrap the teacher's quizzing tools with the gate; unchanged when the slides tool is switched off. */
export function forkNodeVideoGate(
	quizzing: Record<string, AgentTool<any>>,
	ctx: NodeVideoGateContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	if (enabled?.slides === false) return quizzing;
	const out: Record<string, AgentTool<any>> = {};
	for (const [name, tool] of Object.entries(quizzing)) {
		out[name] = {
			...tool,
			execute: async (toolCallId, input, signal, onUpdate) => {
				const result = await tool.execute(toolCallId, input, signal, onUpdate);
				if ((result as { isError?: boolean }).isError) return result;
				const problem = nodeVideoGateProblem(ctx, (input as { nodeId: string }).nodeId);
				return problem ? invalidInputResult(name, [problem]) : result;
			},
		};
	}
	return out;
}
