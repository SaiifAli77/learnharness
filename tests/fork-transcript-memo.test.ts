/**
 * Fork-only: guards the fork's transcript memo (components/chat.tsx) against
 * upstream changes. fork-sync merges upstream automatically, so if upstream
 * starts reading a new Chat-scope variable inside the memoized transcript
 * block, the useMemo deps would silently go stale. This test recomputes the
 * block's free variables with the TypeScript checker and compares them to the
 * deps array.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

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
			// The fork's fill hook renders `messages.slice(hidden).map(`.
			/messages(\.slice\([^)]*\))?\.map\(/.test(n.arguments[0].getText(sf))
		) {
			calls.push(n);
		}
		ts.forEachChild(n, visit);
	};
	visit(chat);
	assert.equal(
		calls.length,
		1,
		`expected exactly one useMemo(...) containing messages(.slice(..)).map( inside Chat, found ${calls.length}`,
	);
	const call = calls[0]!;
	const callback = call.arguments[0]!;
	const depsArg = call.arguments[1];
	assert.ok(depsArg && ts.isArrayLiteralExpression(depsArg), "transcript useMemo has no deps array literal");

	const inside = (node: ts.Node, outer: ts.Node) => node.pos >= outer.pos && node.end <= outer.end;

	const used = new Set<string>();
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
					if (d.getSourceFile() === sf && inside(d, chat) && !inside(d, callback)) {
						used.add(n.text);
					}
				}
			}
		}
		ts.forEachChild(n, walk);
	};
	walk(callback);

	const deps = new Set<string>();
	for (const el of depsArg.elements) deps.add(el.getText(sf));
	return { used, deps };
}

test("transcript useMemo deps match the Chat-scope identifiers the block reads", () => {
	const { used, deps } = analyse();
	const missing = [...used].filter((x) => !deps.has(x)).sort();
	const extra = [...deps].filter((x) => !used.has(x)).sort();
	assert.ok(
		missing.length === 0 && extra.length === 0,
		`components/chat.tsx transcript useMemo deps are out of date (fork perf memo) — update the deps array. ` +
			`missing: [${missing.join(", ")}]; extra: [${extra.join(", ")}]`,
	);
});

test("ToolContentResponse stays wrapped in memo(", () => {
	const src = fs.readFileSync(path.join(ROOT, "components", "ai-elements", "message.tsx"), "utf8");
	assert.match(src, /export const ToolContentResponse = memo\(/);
});
