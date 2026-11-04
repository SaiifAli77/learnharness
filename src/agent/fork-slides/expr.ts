/**
 * Fork-only: the slides number checker. A small, safe arithmetic parser and
 * evaluator: no eval, no Function, no dependency. Every number the teacher
 * shows on a slide carries the expression it comes from; dispatch recomputes
 * it here and rejects the call when the displayed value does not match.
 *
 * Grammar (standard precedence, ^ right-associative, unary minus below ^):
 *   expr    = term (("+" | "-") term)*
 *   term    = unary (("*" | "/") unary)*
 *   unary   = ("-" | "+") unary | power
 *   power   = primary ("^" unary)?
 *   primary = number | constant | func "(" expr ("," expr)* ")" | "(" expr ")"
 * Numbers allow scientific notation (2.5e-3). Functions: exp, log (natural),
 * ln, sqrt, abs, min, max. Constants: pi, e. "−" (U+2212) reads as minus.
 */

type Token =
	| { t: "num"; v: number; at: number }
	| { t: "id"; v: string; at: number }
	| { t: "op"; v: string; at: number };

const FUNCS: Record<string, { arity: "one" | "many"; fn: (...xs: number[]) => number }> = {
	exp: { arity: "one", fn: Math.exp },
	log: { arity: "one", fn: Math.log },
	ln: { arity: "one", fn: Math.log },
	sqrt: { arity: "one", fn: Math.sqrt },
	abs: { arity: "one", fn: Math.abs },
	min: { arity: "many", fn: Math.min },
	max: { arity: "many", fn: Math.max },
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const MAX_EXPR_LENGTH = 2000;
const MAX_DEPTH = 100;

export class ExprError extends Error {}

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
		if (num) {
			tokens.push({ t: "num", v: Number(num[0]), at: i });
			i += num[0].length;
			continue;
		}
		const id = /^[A-Za-z]+/.exec(src.slice(i));
		if (id) {
			tokens.push({ t: "id", v: id[0], at: i });
			i += id[0].length;
			continue;
		}
		if ("+-*/^(),".includes(c)) {
			tokens.push({ t: "op", v: c, at: i });
			i++;
			continue;
		}
		if (c === "−") {
			tokens.push({ t: "op", v: "-", at: i });
			i++;
			continue;
		}
		throw new ExprError(`unexpected character "${c}" at position ${i + 1}`);
	}
	return tokens;
}

/** Parse and evaluate an arithmetic expression; throws ExprError. */
export function evaluateExpr(src: string): number {
	if (typeof src !== "string" || !src.trim()) throw new ExprError("empty expression");
	if (src.length > MAX_EXPR_LENGTH) throw new ExprError(`expression longer than ${MAX_EXPR_LENGTH} characters`);
	const tokens = tokenize(src);
	let pos = 0;
	let depth = 0;
	const peek = () => tokens[pos];
	const isOp = (v: string) => {
		const tok = tokens[pos];
		return tok?.t === "op" && tok.v === v;
	};
	const expectOp = (v: string) => {
		if (!isOp(v)) {
			const tok = peek();
			throw new ExprError(tok ? `expected "${v}" at position ${tok.at + 1}` : `expected "${v}" at the end`);
		}
		pos++;
	};
	const enter = () => {
		if (++depth > MAX_DEPTH) throw new ExprError("expression nested too deeply");
	};

	function expr(): number {
		enter();
		let v = term();
		while (isOp("+") || isOp("-")) {
			const op = (tokens[pos++] as { v: string }).v;
			const r = term();
			v = op === "+" ? v + r : v - r;
		}
		depth--;
		return v;
	}
	function term(): number {
		let v = unary();
		while (isOp("*") || isOp("/")) {
			const op = (tokens[pos++] as { v: string }).v;
			const r = unary();
			v = op === "*" ? v * r : v / r;
		}
		return v;
	}
	function unary(): number {
		if (isOp("-")) {
			pos++;
			enter();
			const v = -unary();
			depth--;
			return v;
		}
		if (isOp("+")) {
			pos++;
			enter();
			const v = unary();
			depth--;
			return v;
		}
		return power();
	}
	function power(): number {
		const base = primary();
		if (isOp("^")) {
			pos++;
			enter();
			const exponent = unary();
			depth--;
			return Math.pow(base, exponent);
		}
		return base;
	}
	function primary(): number {
		const tok = peek();
		if (!tok) throw new ExprError("unexpected end of expression");
		if (tok.t === "num") {
			pos++;
			return tok.v;
		}
		if (tok.t === "id") {
			pos++;
			const name = tok.v.toLowerCase();
			const func = Object.hasOwn(FUNCS, name) ? FUNCS[name] : undefined;
			if (func) {
				expectOp("(");
				const args = [expr()];
				while (isOp(",")) {
					pos++;
					args.push(expr());
				}
				expectOp(")");
				if (func.arity === "one" && args.length !== 1) throw new ExprError(`${name}() takes one argument`);
				return func.fn(...args);
			}
			if (Object.hasOwn(CONSTS, name) && tok.v === name) return CONSTS[name]!;
			throw new ExprError(`unknown name "${tok.v}" (allowed: ${[...Object.keys(FUNCS), ...Object.keys(CONSTS)].join(", ")})`);
		}
		if (tok.v === "(") {
			pos++;
			const v = expr();
			expectOp(")");
			return v;
		}
		throw new ExprError(`unexpected "${tok.v}" at position ${tok.at + 1}`);
	}

	const value = expr();
	if (pos < tokens.length) {
		const tok = tokens[pos]!;
		throw new ExprError(`unexpected "${String(tok.v)}" at position ${tok.at + 1}`);
	}
	if (!Number.isFinite(value)) throw new ExprError("the result is not a finite number");
	return value;
}

/** A displayed value parsed into its number and rounding step. */
export interface DisplayedValue {
	value: number;
	/** Decimal places implied by the display (may be negative for 1.2e3). */
	decimals: number;
}

/** Parse a displayed value like "2.25", "−0.5", "-3", "1.5e-4"; null if not a number. */
export function parseDisplayedValue(raw: string): DisplayedValue | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim().replace(/^−/, "-");
	const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
	if (!m) return null;
	const frac = m[3] ?? "";
	const exp = m[4] ? Number(m[4]) : 0;
	const value = Number(`${m[1]}${m[2]}${frac ? `.${frac}` : ""}e${exp}`);
	if (!Number.isFinite(value)) return null;
	return { value, decimals: frac.length - exp };
}

/** Round to a number of decimals (negative = tens, hundreds, ...). */
export function roundTo(x: number, decimals: number): number {
	const f = Math.pow(10, decimals);
	return Math.round(x * f) / f;
}

export type NumberCheck =
	| { ok: true; computed: number }
	| { ok: false; reason: string; computed?: number };

/** Check one displayed value against its expression: the expression's result,
 *  rounded to the display's decimals, must equal the display. */
export function checkNumber(value: string, expr: string): NumberCheck {
	const shown = parseDisplayedValue(value);
	if (!shown) return { ok: false, reason: `value "${value}" is not a plain number` };
	let computed: number;
	try {
		computed = evaluateExpr(expr);
	} catch (err) {
		return { ok: false, reason: `expression "${expr}" does not parse: ${err instanceof Error ? err.message : String(err)}` };
	}
	// Half a unit in the last displayed place, plus a relative epsilon for
	// binary floating point at exact .5 boundaries.
	const half = 0.5 * Math.pow(10, -shown.decimals);
	const slack = 1e-9 * Math.max(1, Math.abs(computed));
	if (Math.abs(computed - shown.value) <= half + slack) return { ok: true, computed };
	const rounded = roundTo(computed, shown.decimals);
	return {
		ok: false,
		computed,
		reason: `"${expr}" computes ${formatComputed(computed)}, which rounds to ${formatRounded(rounded, shown.decimals)}, not ${value}`,
	};
}

function formatComputed(x: number): string {
	return Number(x.toPrecision(8)).toString();
}

function formatRounded(x: number, decimals: number): string {
	return decimals > 0 && decimals <= 20 ? x.toFixed(decimals) : String(x);
}
