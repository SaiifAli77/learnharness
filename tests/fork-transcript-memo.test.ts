/**
 * Fork-only: guards the fork's transcript memo (components/chat.tsx) against
 * upstream changes. fork-sync merges upstream automatically, so if upstream
 * starts reading a new Chat-scope variable inside the memoized transcript
 * block, the useMemo deps would silently go stale. This test recomputes the
 * block's free variables with the TypeScript checker and compares them to the
 * deps array. It also checks that the row callback handed to forkRows
 * (components/fork-transcript-rows.ts, which reuses unchanged rows while a
 * turn streams) reads nothing its signature or epoch doesn't cover.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { FORK_ROW_DISPATCH_PARTS } from "../components/fork-transcript-rows.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHAT = path.join(ROOT, "components", "chat.tsx");

function analyse() {
	const program = ts.createProgram([CHAT], {
		jsx: ts.JsxEmit.Preserve,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2022,
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
	const sf = program.getSourceFile(CHAT);
	assert.ok(sf, "could not load components/chat.tsx");

	let chatFn: ts.FunctionDeclaration | undefined;
	sf.forEachChild((n) => {
		if (ts.isFunctionDeclaration(n) && n.name?.text === "Chat") chatFn = n;
	});
	assert.ok(chatFn, "exported function Chat not found in components/chat.tsx");
	const chat = chatFn as ts.FunctionDeclaration;

	const calls: ts.CallExpression[] = [];
	const visit = (n: ts.Node) => {
		if (
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			n.expression.text === "useMemo" &&
			n.arguments[0] &&
			(ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0])) &&
			n.arguments[0].getText(sf).includes("forkRows(")
		) {
			calls.push(n);
		}
		ts.forEachChild(n, visit);
	};
	visit(chat);
	assert.equal(
		calls.length,
		1,
		`expected exactly one useMemo(...) containing forkRows( inside Chat, found ${calls.length}`,
	);
	const call = calls[0]!;
	const callback = call.arguments[0]!;
	const depsArg = call.arguments[1];
	assert.ok(depsArg && ts.isArrayLiteralExpression(depsArg), "transcript useMemo has no deps array literal");

	const inside = (node: ts.Node, outer: ts.Node) => node.pos >= outer.pos && node.end <= outer.end;

	// Chat-scope identifiers read inside `root` (declared in Chat, outside `own`).
	const freeVars = (root: ts.Node, own: ts.Node) => {
		const found = new Set<string>();
		const walk = (n: ts.Node) => {
			if (ts.isIdentifier(n)) {
				const p = n.parent;
				const isName =
					(ts.isPropertyAccessExpression(p) && p.name === n) ||
					(ts.isPropertyAssignment(p) && p.name === n) ||
					(ts.isJsxAttribute(p) && p.name === n) ||
					(ts.isPropertySignature(p) && p.name === n) ||
					(ts.isQualifiedName(p) && p.right === n) ||
					(ts.isBindingElement(p) && p.propertyName === n);
				if (!isName) {
					let sym = ts.isShorthandPropertyAssignment(p) && p.name === n
						? checker.getShorthandAssignmentValueSymbol(p)
						: checker.getSymbolAtLocation(n);
					if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
					for (const d of sym?.declarations ?? []) {
						if (d.getSourceFile() === sf && inside(d, chat) && !inside(d, own)) {
							found.add(n.text);
						}
					}
				}
			}
			ts.forEachChild(n, walk);
		};
		walk(root);
		return found;
	};
	const used = freeVars(callback, callback);

	// For each DERIVED value, the Chat-scope identifiers its declaration reads.
	const derivedInputs = new Map<string, Set<string>>();
	const findDecl = (n: ts.Node) => {
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text in DERIVED && n.initializer && !inside(n, callback)) {
			derivedInputs.set(n.name.text, freeVars(n.initializer, n));
		}
		ts.forEachChild(n, findDecl);
	};
	findDecl(chat);

	const deps = new Set<string>();
	for (const el of depsArg.elements) deps.add(el.getText(sf));

	// The forkRows(cache, messages, { per-row }, { epoch }, rowCallback) call.
	const body = (callback as ts.ArrowFunction).body;
	assert.ok(
		ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === "forkRows" && body.arguments.length === 5,
		"the transcript useMemo must return forkRows(cache, messages, { per-row }, { epoch }, (m, mi) => …) directly",
	);
	const [, messagesArg, perRowArg, epochArg, rowArg] = body.arguments as unknown as [ts.Expression, ts.Expression, ts.Expression, ts.Expression, ts.Expression];
	assert.equal(messagesArg.getText(sf), "messages", "forkRows must receive `messages`");
	const shorthandKeys = (obj: ts.Expression, what: string) => {
		assert.ok(ts.isObjectLiteralExpression(obj), `forkRows ${what} must be an object literal`);
		return obj.properties.map((p) => {
			assert.ok(ts.isShorthandPropertyAssignment(p), `forkRows ${what}: use shorthand properties ({ ${p.getText(sf)} })`);
			return p.name.text;
		});
	};
	const perRow = shorthandKeys(perRowArg, "per-row inputs");
	const epoch = shorthandKeys(epochArg, "epoch");
	assert.ok(ts.isArrowFunction(rowArg) && rowArg.parameters.length === 2, "the row callback must be (m, mi) => …");
	const row = rowArg as ts.ArrowFunction;
	const rowUsed = freeVars(row, row);
	const rowRefs = (name: string) => {
		const refs: ts.Identifier[] = [];
		const walk = (n: ts.Node) => {
			if (ts.isIdentifier(n) && n.text === name && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isJsxAttribute(n.parent) && n.parent.name === n)) refs.push(n);
			ts.forEachChild(n, walk);
		};
		walk(row.body);
		return refs;
	};
	return { used, deps, derivedInputs, perRow, epoch, row, rowUsed, rowRefs, sf, program, checker };
}

let analysed: ReturnType<typeof analyse> | undefined;
const analyseOnce = () => (analysed ??= analyse());

/**
 * Values the block reads that Chat recomputes on EVERY render (new object or
 * array identity), so listing them would re-run the memo on every keystroke.
 * The deps list what they are computed from instead. The test checks that
 * upstream still computes each one from only these Chat-scope identifiers.
 */
const DERIVED: Record<string, readonly string[]> = {
	// findPendingToolCall(messages, pendingQuestionOf(nativeMessages))
	pending: ["messages", "nativeMessages"],
	// malformedQuestionsOf(nativeMessages)
	malformedQuestions: ["nativeMessages"],
};

test("transcript useMemo deps match the Chat-scope identifiers the block reads", () => {
	const { used, deps } = analyseOnce();
	const expected = new Set<string>();
	for (const id of used) {
		if (id in DERIVED) for (const input of DERIVED[id]!) expected.add(input);
		else expected.add(id);
	}
	const missing = [...expected].filter((x) => !deps.has(x)).sort();
	const extra = [...deps].filter((x) => !expected.has(x)).sort();
	assert.ok(
		missing.length === 0 && extra.length === 0,
		`components/chat.tsx transcript useMemo deps are out of date (fork perf memo) — update the deps array. ` +
			`missing: [${missing.join(", ")}]; extra: [${extra.join(", ")}]`,
	);
});

test("derived transcript inputs are still computed only from their listed inputs", () => {
	const { used, derivedInputs } = analyseOnce();
	for (const id of Object.keys(DERIVED)) {
		if (!used.has(id)) continue;
		const inputs = derivedInputs.get(id);
		assert.ok(inputs, `could not find the declaration of \`${id}\` in Chat (tests/fork-transcript-memo.test.ts DERIVED)`);
		const unexpected = [...inputs].filter((x) => !DERIVED[id]!.includes(x)).sort();
		assert.deepEqual(
			unexpected,
			[],
			`\`${id}\` now also reads [${unexpected.join(", ")}] — add them to DERIVED.${id} and to the transcript useMemo deps`,
		);
	}
});

test("ToolContentResponse stays wrapped in memo(", () => {
	const src = fs.readFileSync(path.join(ROOT, "components", "ai-elements", "message.tsx"), "utf8");
	assert.match(src, /export const ToolContentResponse = memo\(/);
});

/**
 * Chat-scope values the row callback reads that forkRows does NOT track,
 * because they are read only on a path that can't run while `busy` (and
 * forkRows reuses rows only while busy). The test below checks the guard.
 */
const UNREACHABLE_WHILE_BUSY = ["pending", "malformedQuestions"] as const;

/** The per-row values, which forkRowSignature reads in exactly these forms. */
const PER_ROW_FORMS: Record<string, readonly string[]> = {
	messages: ["mi === messages.length - 1"],
	phases: ["phases[mi]", "phases[mi - 1]"],
	sourceTextParts: ["sourceTextParts.get(sourceId)"],
};

test("forkRows: every Chat-scope value the row callback reads is in its signature, its epoch, or unreachable while busy", () => {
	const { perRow, epoch, rowUsed } = analyseOnce();
	assert.deepEqual([...perRow].sort(), ["phases", "sourceTextParts"], "forkRows per-row inputs must be exactly { phases, sourceTextParts } (forkRowSignature reads them)");
	assert.ok(epoch.includes("busy"), "forkRows epoch must include busy");
	const covered = new Set<string>(["messages", ...perRow, ...epoch, ...UNREACHABLE_WHILE_BUSY]);
	const uncovered = [...rowUsed].filter((id) => !covered.has(id)).sort();
	assert.deepEqual(
		uncovered,
		[],
		`the transcript row callback now reads [${uncovered.join(", ")}] — add each to the forkRows epoch in components/chat.tsx ` +
			`(and the useMemo deps), or to forkRowSignature if it differs per row`,
	);
});

test("forkRows: per-row values are read only in the forms forkRowSignature covers", () => {
	const { rowRefs, sf } = analyseOnce();
	for (const [name, forms] of Object.entries(PER_ROW_FORMS)) {
		for (const ref of rowRefs(name)) {
			let n: ts.Node = ref;
			let matched = false;
			for (let up = 0; up < 3 && n.parent; up++) {
				n = n.parent;
				if (forms.includes(n.getText(sf))) {
					matched = true;
					break;
				}
			}
			assert.ok(matched, `\`${name}\` is read as \`${ref.parent.getText(sf).slice(0, 80)}\` in the row callback; forkRowSignature covers only ${forms.join(", ")}`);
		}
	}
	// sourceId is the text-part lookup forkRowSignature repeats for each part.
	const [decl, ...more] = rowRefs("sourceId")
		.map((r) => r.parent)
		.filter((p): p is ts.VariableDeclaration => ts.isVariableDeclaration(p));
	assert.ok(decl && more.length === 0, "expected one `const sourceId = …` in the row callback");
	assert.equal(decl.initializer?.getText(sf), "textPartMessageId(part.id)");
	const partParam = rowRefs("part").find((r) => ts.isParameter(r.parent));
	const partsMap = partParam?.parent.parent.parent;
	assert.ok(partsMap && ts.isCallExpression(partsMap) && partsMap.expression.getText(sf) === "m.parts.map", "`part` must be the m.parts.map callback's element");
});

test("forkRows: values outside the epoch are read only behind `!busy`", () => {
	const { row, rowRefs, sf } = analyseOnce();
	// `x` is guarded when it sits right of `!busy && …`, or inside `if (g)`
	// where g is declared as `!busy && …`.
	const notBusyAnd = (n: ts.Node | undefined): n is ts.BinaryExpression =>
		!!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && n.left.getText(sf) === "!busy";
	const guards = new Set<string>();
	const findGuards = (n: ts.Node) => {
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && notBusyAnd(n.initializer)) guards.add(n.name.text);
		ts.forEachChild(n, findGuards);
	};
	findGuards(row);
	for (const name of UNREACHABLE_WHILE_BUSY) {
		const refs = rowRefs(name);
		assert.ok(refs.length > 0, `\`${name}\` is no longer read by the row callback — remove it from UNREACHABLE_WHILE_BUSY`);
		for (const ref of refs) {
			let guarded = false;
			for (let n: ts.Node = ref; n !== row && n.parent; n = n.parent) {
				const p = n.parent;
				if (notBusyAnd(p) && p.right === n) guarded = true;
				if (ts.isIfStatement(p) && p.thenStatement === n && ts.isIdentifier(p.expression) && guards.has(p.expression.text)) guarded = true;
				if (guarded) break;
			}
			assert.ok(guarded, `\`${name}\` is now read where busy can be true (\`${ref.parent.getText(sf).slice(0, 80)}\`) — add it to the forkRows epoch`);
		}
	}
});

/**
 * Whether `decl` (a function or variable in the repo) can reach DispatchCard
 * through any identifier it references, transitively. DispatchActivityCard
 * reads Date.now() while rendering, so forkRows must not reuse a row that can
 * render it (FORK_ROW_DISPATCH_PARTS).
 */
function dispatchReach(checker: ts.TypeChecker) {
	const ROOT_DIR = ROOT + path.sep;
	const ownDecl = (d: ts.Node) => {
		const f = d.getSourceFile().fileName;
		return f.startsWith(ROOT_DIR) && !f.includes(`${path.sep}node_modules${path.sep}`) && !f.endsWith(".d.ts");
	};
	const isTarget = (d: ts.Node) => ts.isFunctionDeclaration(d) && d.name?.text === "DispatchCard" && d.getSourceFile().fileName.endsWith(path.join("components", "artifacts", "dispatch-card.tsx"));
	const resolve = (id: ts.Identifier) => {
		let sym = checker.getSymbolAtLocation(id);
		if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
		return (sym?.declarations ?? []).filter(ownDecl);
	};
	const memo = new Map<ts.Node, boolean>();
	const reaches = (d: ts.Node, stack = new Set<ts.Node>()): boolean => {
		if (isTarget(d)) return true;
		const known = memo.get(d);
		if (known !== undefined) return known;
		if (stack.has(d)) return false;
		stack.add(d);
		const body = ts.isFunctionDeclaration(d) ? d.body : ts.isVariableDeclaration(d) ? d.initializer : undefined;
		const hit = !!body && walkReaches(body, d, stack);
		stack.delete(d);
		memo.set(d, hit);
		return hit;
	};
	const walkReaches = (root: ts.Node, skip: ts.Node, stack: Set<ts.Node>, ignore: (id: ts.Identifier, d: ts.Node) => boolean = () => false): boolean => {
		let hit = false;
		const walk = (n: ts.Node) => {
			if (hit) return;
			if (ts.isIdentifier(n)) {
				for (const d of resolve(n)) {
					if (d !== skip && !ignore(n, d) && reaches(d, stack)) {
						hit = true;
						return;
					}
				}
			}
			ts.forEachChild(n, walk);
		};
		walk(root);
		return hit;
	};
	return { resolve, reaches, walkReaches };
}

test("forkRows: FORK_ROW_DISPATCH_PARTS is exactly the registry renderers that can render DispatchCard", () => {
	const { program, checker } = analyseOnce();
	const index = program.getSourceFile(path.join(ROOT, "components", "artifacts", "index.ts"));
	assert.ok(index, "components/artifacts/index.ts not in the program");
	const { resolve, reaches } = dispatchReach(checker);
	let registry: ts.ObjectLiteralExpression | undefined;
	index.forEachChild((n) => {
		if (!ts.isVariableStatement(n)) return;
		for (const d of n.declarationList.declarations) {
			if (d.name.getText(index) === "artifactRenderers" && d.initializer && ts.isObjectLiteralExpression(d.initializer)) registry = d.initializer;
		}
	});
	assert.ok(registry, "artifactRenderers object literal not found");
	const derived = new Set<string>();
	for (const p of registry.properties) {
		assert.ok(ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer), `unexpected registry entry shape: ${p.getText(index)}`);
		const decls = resolve(p.initializer);
		assert.ok(decls.length > 0, `could not resolve the renderer ${p.initializer.text}`);
		if (decls.some((d) => reaches(d))) derived.add(`tool-${p.name.getText(index).replace(/^["']|["']$/g, "")}`);
	}
	assert.deepEqual(
		[...FORK_ROW_DISPATCH_PARTS].sort(),
		[...derived].sort(),
		"the registry renderers that render DispatchCard changed: update FORK_ROW_DISPATCH_PARTS in components/fork-transcript-rows.ts",
	);
});

test("forkRows: the row callback renders DispatchCard only through the registry", () => {
	const { row, checker } = analyseOnce();
	const { walkReaches } = dispatchReach(checker);
	const inside = (d: ts.Node) => d.pos >= row.pos && d.end <= row.end;
	// The registry lookup is covered by part type above; anything else the
	// row renders must not reach DispatchCard (it would have no dispatch part).
	const reached = walkReaches(row, row, new Set(), (id, d) => id.text === "artifactRenderers" || inside(d));
	assert.equal(reached, false, "a component the transcript row renders directly can now render DispatchCard; extend forkRows' exclusion to those rows");
});
