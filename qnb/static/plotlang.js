"use strict";

/* QNB Plot language — the text inside a .plot file.
 *
 * Desmos-style lines plus a little programming:
 *   a = 2                       number literal → slider (optional range: a = 2 in 0..5)
 *   f(x) = a sin(x)             one-line function (implicit multiplication allowed)
 *   y = f(x)                    explicit curve          x = y^2      sideways curve
 *   x^2 + y^2 = 9               implicit curve          y < x^2      region (inequality)
 *   r = 1 + cos(θ)              polar curve             (cos(t), sin(2t))  parametric curve
 *   z = sin(x) cos(y)           surface (3D)            x^2 + y^2 + z^2 = 9   implicit surface (3 variables)
 *   (cos u sin v, sin u sin v, cos v)  parametric surface,   (cos t, sin t, t/5)  space curve
 *   L = [1, 2, 3]   P = [(k, k^2) for k in 0..5]   L[2]   sum(L)   map(L, k -> k^2)
 *   g(x) = if x < 0 then -x else x^2      h(x) = {x < 0: -x, x^2}      y = x^2 {0 < x < 2}
 *   for k in 1..4 { y = k x }             fn fib(n) { a = 0; b = 1; for i in 1..n { t = a + b; a = b; b = t }; return a }
 *   xrange = -10..10   yrange   zrange   trange   urange   vrange   dim = 3      @#e11d48 (colour suffix)
 */
(function (root) {
  const PLOT_VARS = new Set(["x", "y", "z", "t", "r", "θ", "theta", "u", "v"]);
  const KEYWORDS = new Set(["if", "then", "else", "for", "in", "while", "fn", "def", "return", "and", "or", "not", "step", "true", "false"]);
  const SETTINGS = new Set(["xrange", "yrange", "zrange", "trange", "urange", "vrange", "θrange", "thetarange", "dim"]);
  const MAX_WORK = 4_000_000;
  const PREFIX_FUNCS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "asin", "acos", "atan", "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "exp", "ln", "log", "sqrt", "abs"]);

  class PlotError extends Error {
    constructor(message, line) { super(message); this.line = line; }
  }

  /* ------------------------------ values ------------------------------ */

  class Tuple { constructor(items) { this.items = items; } }
  class Range {
    constructor(a, b, step) { this.a = a; this.b = b; this.step = step; }
    toArray() {
      const step = this.step || 1; // 1..0 is empty; count down with an explicit step -1
      if (!Number.isFinite(this.a) || !Number.isFinite(this.b) || step === 0 || (this.b - this.a) / step < 0) return [];
      const n = Math.floor((this.b - this.a) / step + 1e-9);
      if (n > 100000) throw new PlotError("범위의 원소가 너무 많습니다 (최대 100000개).");
      const out = [];
      for (let i = 0; i <= n; i++) out.push(+(this.a + i * step).toPrecision(15));
      return out;
    }
  }
  class Fn {
    constructor(name, params, body, closure, native) {
      this.name = name; this.params = params; this.body = body; this.closure = closure; this.native = native;
    }
  }
  class Shape { constructor(type, points) { this.type = type; this.points = points; } }

  class Scope {
    constructor(parent = null) { this.vars = new Map(); this.parent = parent; }
    get(name) {
      for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
      return undefined;
    }
    has(name) {
      for (let s = this; s; s = s.parent) if (s.vars.has(name)) return true;
      return false;
    }
    set(name, value) { this.vars.set(name, value); }
    /* Assign to the nearest scope that already holds the name (function locals stay local). */
    assign(name, value) {
      for (let s = this; s; s = s.parent) {
        if (s.vars.has(name) && !s.isGlobalFrom) { s.vars.set(name, value); return; }
        if (s.boundary) break;
      }
      this.vars.set(name, value);
    }
    flatten() {
      const out = new Scope(this.root());
      const chain = [];
      for (let s = this; s && s !== this.root(); s = s.parent) chain.unshift(s);
      for (const s of chain) for (const [k, v] of s.vars) out.vars.set(k, v);
      return out;
    }
    root() { let s = this; while (s.parent) s = s.parent; return s; }
  }

  /* ------------------------------ lexer ------------------------------ */

  const OPS = ["..", "**", "==", "!=", "<=", ">=", "&&", "||", "->", "→", "≤", "≥", "≠", "+", "-", "*", "/", "^", "%",
    "(", ")", "[", "]", "{", "}", ",", ":", ";", "=", "<", ">", "!", "|", ".", "·", "×", "÷", "√", "∈"];
  const ID_START = /[A-Za-z_À-ɏͰ-Ͽ가-힣]/;
  const ID_PART = /[A-Za-z0-9_À-ɏͰ-Ͽ가-힣']/;

  function lex(src) {
    const tokens = [];
    let i = 0, line = 1;
    const push = (type, value) => tokens.push({ type, value, line });
    while (i < src.length) {
      const c = src[i];
      if (c === "\n") { push("nl", "\n"); line++; i++; continue; }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (c === "#" || (c === "/" && src[i + 1] === "/")) { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "@") {
        const m = /^@\s*(#[0-9a-fA-F]{3,8}|[A-Za-z]+)/.exec(src.slice(i));
        if (!m) throw new PlotError("@ 뒤에는 색상(#e11d48 또는 red)을 쓰세요.", line);
        push("style", m[1]);
        i += m[0].length;
        continue;
      }
      const num = /^(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
      if (num) { push("num", parseFloat(num[0])); i += num[0].length; continue; }
      if (ID_START.test(c)) {
        let j = i + 1;
        while (j < src.length && ID_PART.test(src[j])) j++;
        push("id", src.slice(i, j));
        i = j;
        continue;
      }
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new PlotError(`알 수 없는 문자 '${c}'`, line);
      const norm = { "→": "->", "≤": "<=", "≥": ">=", "≠": "!=", "**": "^", "·": "*", "×": "*", "÷": "/", "∈": "in" }[op] || op;
      push(norm === "in" ? "id" : "op", norm);
      i += op.length;
    }
    push("nl", "\n");
    push("eof", null);
    return tokens;
  }

  /* ------------------------------ parser ------------------------------ */

  const RELOPS = new Set(["<", ">", "<=", ">=", "==", "!="]);

  function parse(src) {
    const tokens = lex(src);
    let pos = 0;
    const peek = (k = 0) => tokens[pos + k];
    const next = () => tokens[pos++];
    const is = (type, value, k = 0) => { const t = peek(k); return t.type === type && (value === undefined || t.value === value); };
    const isOp = (value, k = 0) => is("op", value, k);
    const isKw = (value, k = 0) => is("id", value, k);
    const fail = (message, token = peek()) => { throw new PlotError(message, token.line); };
    const expectOp = (value) => { if (!isOp(value)) fail(`'${value}'가 필요합니다.`); return next(); };
    const expectId = () => {
      if (peek().type !== "id" || KEYWORDS.has(peek().value)) fail("이름이 필요합니다.");
      return next().value;
    };
    const skipNl = () => { while (is("nl") || isOp(";")) next(); };
    const skipBreaks = () => { while (is("nl")) next(); };
    const node = (type, props, token) => ({ type, line: token?.line ?? peek().line, ...props });

    function parseProgram() {
      const body = [];
      skipNl();
      while (!is("eof")) {
        body.push(parseStatementSafe());
        skipNl();
      }
      return body;
    }

    /* A broken line becomes an error node; parsing resumes on the next line. */
    function parseStatementSafe() {
      const start = peek();
      try {
        const stmt = parseStatement();
        if (!is("nl") && !isOp(";") && !isOp("}") && !is("eof")) fail(`'${peek().value}' 근처에서 문장이 끝나야 합니다.`);
        return stmt;
      } catch (error) {
        if (!(error instanceof PlotError)) throw error;
        let braces = 0;
        while (!is("eof") && !(is("nl") && braces <= 0)) {
          if (isOp("{")) braces++;
          if (isOp("}")) braces--;
          next();
        }
        const where = error.line && error.line !== start.line ? ` (${error.line}행에서 발견)` : "";
        return node("error", { message: error.message + where, errorLine: start.line }, start);
      }
    }

    function parseBlock() {
      if (isOp(":")) { next(); return [parseStatement()]; }
      expectOp("{");
      const body = [];
      skipNl();
      while (!isOp("}")) {
        if (is("eof")) fail("'}'로 블록을 닫아야 합니다.");
        body.push(parseStatement());
        skipNl();
      }
      next();
      return body;
    }

    function parseParams() {
      expectOp("(");
      const params = [];
      skipBreaks();
      if (!isOp(")")) {
        do { skipBreaks(); params.push(expectId()); skipBreaks(); } while (isOp(",") && next());
      }
      expectOp(")");
      return params;
    }

    function parseStatement() {
      const t = peek();
      if (isKw("fn") || isKw("def")) {
        next();
        const name = expectId();
        const params = parseParams();
        if (isOp("=")) { next(); return node("fndef", { name, params, body: parseExpr() }, t); }
        return node("fndef", { name, params, body: parseBlock(), block: true }, t);
      }
      if (isKw("for")) {
        next();
        const name = expectId();
        if (!isKw("in")) fail("'for 변수 in 범위' 형태로 쓰세요.");
        next();
        const iter = parseExpr();
        return node("for", { name, iter, body: parseBlock() }, t);
      }
      if (isKw("while")) {
        next();
        const cond = parseExpr();
        return node("while", { cond, body: parseBlock() }, t);
      }
      if (isKw("return")) {
        next();
        return node("return", { value: is("nl") || isOp("}") || isOp(";") ? null : parseExpr() }, t);
      }
      if (isKw("if")) {
        // `if c { … }` is a statement; `if c then a else b` is an expression.
        const save = pos;
        next();
        const cond = parseExpr();
        if (isOp("{") || isOp(":")) {
          const then = parseBlock();
          let otherwise = null;
          const mark = pos;
          skipNl();
          if (isKw("else")) {
            next();
            otherwise = isKw("if") ? [parseStatement()] : parseBlock();
          } else pos = mark;
          return node("if", { cond, then, otherwise }, t);
        }
        pos = save;
      }
      const left = parseExpr();
      let stmt;
      if (isOp("=")) {
        next();
        const right = parseExpr();
        if (left.type === "call" && left.callee.type === "id" && left.args.every((a) => a.type === "id")) {
          stmt = node("fndef", { name: left.callee.name, params: left.args.map((a) => a.name), body: right }, t);
        } else if (left.type === "index") {
          stmt = node("setindex", { target: left.target, index: left.index, value: right }, t);
        } else {
          stmt = node("equation", { left, right }, t);
        }
        if (stmt.type === "equation" && isKw("in")) {
          next();
          stmt.sliderRange = parseExpr();
        }
      } else {
        stmt = node("expr", { expr: left }, t);
      }
      if (isOp("{")) stmt.restrict = parsePiecewise();
      while (is("style")) stmt.color = next().value;
      return stmt;
    }

    function parseExpr() {
      // Lambdas: k -> expr,  (a, b) -> expr
      if (peek().type === "id" && !KEYWORDS.has(peek().value) && isOp("->", 1)) {
        const t = next();
        next();
        return node("lambda", { params: [t.value], body: parseExpr() }, t);
      }
      if (isOp("(")) {
        let k = 1;
        let ok = true;
        while (!isOp(")", k)) {
          if (!(peek(k).type === "id" || isOp(",", k))) { ok = false; break; }
          k++;
        }
        if (ok && isOp("->", k + 1)) {
          const t = peek();
          const params = parseParams();
          next();
          return node("lambda", { params, body: parseExpr() }, t);
        }
      }
      if (isKw("if")) {
        const t = next();
        const cond = parseExpr();
        if (!isKw("then")) fail("'if 조건 then 값 else 값' 형태로 쓰세요.");
        next();
        const a = parseExpr();
        if (!isKw("else")) fail("조건식에는 else가 필요합니다.");
        next();
        return node("cond", { cond, a, b: parseExpr() }, t);
      }
      return parseOr();
    }

    function parseOr() {
      let left = parseAnd();
      while (isKw("or") || isOp("||")) { const t = next(); left = node("logic", { op: "or", left, right: parseAnd() }, t); }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (isKw("and") || isOp("&&")) { const t = next(); left = node("logic", { op: "and", left, right: parseNot() }, t); }
      return left;
    }
    function parseNot() {
      if (isKw("not") || (isOp("!") )) { const t = next(); return node("not", { value: parseNot() }, t); }
      return parseCompare();
    }
    function parseCompare() {
      const first = parseRange();
      if (!(peek().type === "op" && RELOPS.has(peek().value))) return first;
      const terms = [first];
      const ops = [];
      while (peek().type === "op" && RELOPS.has(peek().value)) {
        ops.push(next().value);
        terms.push(parseRange());
      }
      return node("compare", { terms, ops }, peek());
    }
    function parseRange() {
      const a = parseAdd();
      if (!isOp("..")) return a;
      const t = next();
      const b = parseAdd();
      let step = null;
      if (isKw("step")) { next(); step = parseAdd(); }
      return node("range", { a, b, step }, t);
    }
    function parseAdd() {
      let left = parseMul();
      while (isOp("+") || isOp("-")) { const t = next(); left = node("bin", { op: t.value, left, right: parseMul() }, t); }
      return left;
    }
    function startsOperand() {
      const t = peek();
      if (t.type === "num") return true;
      if (t.type === "id") return !KEYWORDS.has(t.value);
      return t.type === "op" && (t.value === "(" || t.value === "√");
    }
    function parseMul() {
      let left = parseUnary();
      for (;;) {
        if (isOp("*") || isOp("/") || isOp("%")) {
          const t = next();
          left = node("bin", { op: t.value, left, right: parseUnary() }, t);
        } else if (startsOperand()) {
          // Implicit multiplication: 2x, 3 sin(x), (x+1)(x-1), a b
          left = node("bin", { op: "*", left, right: parsePow(), implicit: true }, peek());
        } else return left;
      }
    }
    function parseUnary() {
      if (isOp("-")) { const t = next(); return node("neg", { value: parseUnary() }, t); }
      if (isOp("+")) { next(); return parseUnary(); }
      return parsePow();
    }
    function parsePow() {
      if (isOp("√")) { const t = next(); return node("call", { callee: { type: "id", name: "sqrt" }, args: [parsePow()] }, t); }
      const base = parsePostfix();
      if (isOp("^")) {
        const t = next();
        return node("bin", { op: "^", left: base, right: parseUnary() }, t);
      }
      return base;
    }
    function parsePostfix() {
      let value = parsePrimary();
      // sin x, ln 2x, cos θ: a known math function followed by an operand without parentheses
      if (value.type === "id" && PREFIX_FUNCS.has(value.name) && !isOp("(") && startsOperand()) {
        return node("call", { callee: value, args: [parsePow()] }, peek());
      }
      for (;;) {
        if (isOp("(") && value.type === "id") {
          const t = next();
          const args = [];
          skipBreaks();
          if (!isOp(")")) { do { skipBreaks(); args.push(parseExpr()); skipBreaks(); } while (isOp(",") && next()); }
          expectOp(")");
          value = node("call", { callee: value, args }, t);
        } else if (isOp("[")) {
          const t = next();
          const index = parseExpr();
          expectOp("]");
          value = node("index", { target: value, index }, t);
        } else if (isOp(".") && peek(1).type === "id") {
          const t = next();
          value = node("member", { target: value, name: next().value }, t);
        } else if (isOp("!") && !(isOp("=", 1))) {
          const t = next();
          value = node("call", { callee: { type: "id", name: "factorial" }, args: [value] }, t);
        } else return value;
      }
    }
    function parsePiecewise() {
      const t = expectOp("{");
      const branches = [];
      let otherwise = null;
      skipNl();
      while (!isOp("}")) {
        const cond = parseExpr();
        if (isOp(":")) { next(); branches.push({ cond, value: parseExpr() }); }
        else if (otherwise === null) otherwise = cond;
        else fail("조건부 함수에는 기본값을 하나만 쓸 수 있습니다.");
        skipNl();
        if (isOp(",")) { next(); skipNl(); }
        else if (!isOp("}")) fail("조건부 함수의 항목은 쉼표로 구분하세요.");
      }
      next();
      return node("piecewise", { branches, otherwise }, t);
    }
    function parsePrimary() {
      const t = peek();
      if (t.type === "num") { next(); return node("num", { value: t.value }, t); }
      if (t.type === "id") {
        if (t.value === "true" || t.value === "false") { next(); return node("num", { value: t.value === "true" ? 1 : 0, bool: true }, t); }
        if (KEYWORDS.has(t.value)) fail(`'${t.value}'는 여기에 올 수 없습니다.`);
        next();
        return node("id", { name: t.value }, t);
      }
      if (isOp("(")) {
        next();
        skipBreaks();
        const items = [parseExpr()];
        skipBreaks();
        while (isOp(",")) { next(); skipBreaks(); items.push(parseExpr()); skipBreaks(); }
        expectOp(")");
        return items.length === 1 ? items[0] : node("tuple", { items }, t);
      }
      if (isOp("[")) {
        next();
        skipBreaks();
        if (isOp("]")) { next(); return node("list", { items: [] }, t); }
        const first = parseExpr();
        skipBreaks();
        if (isKw("for")) {
          const loops = [];
          const loopVar = () => {
            const name = expectId();
            if (!isKw("in")) fail("'for 변수 in 범위' 형태로 쓰세요.");
            next();
            loops.push({ name, iter: parseRange() });
            skipBreaks();
          };
          while (isKw("for")) {
            next();
            loopVar();
            // [… for i in A, j in B] is a nested loop as well
            while (isOp(",") && peek(1).type === "id" && isKw("in", 2)) { next(); loopVar(); }
          }
          skipBreaks();
          let filter = null;
          if (isKw("if")) { next(); filter = parseExpr(); skipBreaks(); }
          expectOp("]");
          return node("comprehension", { value: first, loops, filter }, t);
        }
        const items = [first];
        while (isOp(",")) { next(); skipBreaks(); if (isOp("]")) break; items.push(parseExpr()); skipBreaks(); }
        expectOp("]");
        return node("list", { items }, t);
      }
      if (isOp("{")) return parsePiecewise();
      if (isOp("|")) {
        next();
        const inner = parseAdd();
        expectOp("|");
        return node("call", { callee: { type: "id", name: "abs" }, args: [inner] }, t);
      }
      fail(t.type === "eof" || t.type === "nl" ? "식이 끝나지 않았습니다." : `'${t.value}'를 해석할 수 없습니다.`);
    }

    return parseProgram();
  }

  /* ------------------------------ evaluation ------------------------------ */

  class ReturnSignal { constructor(value) { this.value = value; } }

  function typeName(v) {
    if (typeof v === "number") return "수";
    if (typeof v === "boolean") return "참/거짓";
    if (Array.isArray(v)) return "배열";
    if (v instanceof Tuple) return "점/튜플";
    if (v instanceof Range) return "범위";
    if (v instanceof Fn) return "함수";
    if (v instanceof Shape) return "도형";
    return "값";
  }

  function toList(v) {
    if (Array.isArray(v)) return v;
    if (v instanceof Range) return v.toArray();
    if (v instanceof Tuple) return v.items;
    throw new PlotError(`${typeName(v)}는 반복할 수 없습니다.`);
  }

  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return NaN;
  }

  function truthy(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (Array.isArray(v)) return v.length > 0;
    return Boolean(v);
  }

  function arith(op, a, b) {
    if (typeof a === "boolean") a = a ? 1 : 0;
    if (typeof b === "boolean") b = b ? 1 : 0;
    if (typeof a === "number" && typeof b === "number") {
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return ((a % b) + b) % b;
        case "^": return a < 0 && Number.isFinite(b) && !Number.isInteger(b) ? oddRoot(a, b) : Math.pow(a, b);
      }
    }
    if (a instanceof Range) a = a.toArray();
    if (b instanceof Range) b = b.toArray();
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = arith(op, a[i], b[i]);
      return out;
    }
    if (Array.isArray(a)) return a.map((item) => arith(op, item, b));
    if (Array.isArray(b)) return b.map((item) => arith(op, a, item));
    if (a instanceof Tuple && b instanceof Tuple) {
      if (op === "+" || op === "-") return new Tuple(a.items.map((item, i) => arith(op, item, b.items[i] ?? 0)));
      if (op === "*") return a.items.reduce((s, item, i) => s + num(item) * num(b.items[i] ?? 0), 0); // dot product
      throw new PlotError(`점끼리는 '${op}' 연산을 할 수 없습니다.`);
    }
    if (a instanceof Tuple) return new Tuple(a.items.map((item) => arith(op, item, b)));
    if (b instanceof Tuple) return new Tuple(b.items.map((item) => arith(op, a, item)));
    throw new PlotError(`${typeName(a)}와 ${typeName(b)}는 '${op}' 연산을 할 수 없습니다.`);
  }

  // (-8)^(1/3) = -2 like Desmos: odd roots of negatives stay real.
  function oddRoot(a, b) {
    const inv = 1 / b;
    const n = Math.round(inv);
    if (Math.abs(inv - n) < 1e-9 && n % 2 !== 0) return -Math.pow(-a, b);
    return NaN;
  }

  function compareOp(op, a, b) {
    if (op === "==") return Array.isArray(a) || a instanceof Tuple ? JSON.stringify(a) === JSON.stringify(b) : num(a) === num(b);
    if (op === "!=") return !compareOp("==", a, b);
    a = num(a); b = num(b);
    if (op === "<") return a < b;
    if (op === ">") return a > b;
    if (op === "<=") return a <= b;
    return a >= b;
  }

  function mapNum(fn) {
    const f = (v) => (Array.isArray(v) ? v.map(f) : v instanceof Range ? v.toArray().map(f) : fn(num(v)));
    return f;
  }

  function gcd(a, b) { a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b)); while (b) [a, b] = [b, a % b]; return a; }
  function factorial(n) {
    if (n < 0 || !Number.isFinite(n)) return NaN;
    if (Number.isInteger(n)) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
    return gamma(n + 1);
  }
  function gamma(x) { // Lanczos approximation
    if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
  }

  function numbersOf(args) {
    const flat = args.length === 1 && (Array.isArray(args[0]) || args[0] instanceof Range) ? toList(args[0]) : args;
    return flat.map(num);
  }

  function builtins(ctx) {
    const call = (fn, args) => ctx.callFn(fn, args);
    const B = {
      sin: mapNum(Math.sin), cos: mapNum(Math.cos), tan: mapNum(Math.tan),
      asin: mapNum(Math.asin), acos: mapNum(Math.acos), atan: mapNum(Math.atan),
      arcsin: mapNum(Math.asin), arccos: mapNum(Math.acos), arctan: mapNum(Math.atan),
      sec: mapNum((x) => 1 / Math.cos(x)), csc: mapNum((x) => 1 / Math.sin(x)), cot: mapNum((x) => 1 / Math.tan(x)),
      sinh: mapNum(Math.sinh), cosh: mapNum(Math.cosh), tanh: mapNum(Math.tanh),
      exp: mapNum(Math.exp), ln: mapNum(Math.log), sqrt: mapNum(Math.sqrt), cbrt: mapNum(Math.cbrt),
      abs: (v) => (v instanceof Tuple ? Math.hypot(...v.items.map(num)) : mapNum(Math.abs)(v)),
      floor: mapNum(Math.floor), ceil: mapNum(Math.ceil), sign: mapNum(Math.sign),
      round: (v, d) => (d === undefined ? mapNum(Math.round)(v) : mapNum((x) => Math.round(x * 10 ** num(d)) / 10 ** num(d))(v)),
      log: (a, b) => (b === undefined ? mapNum(Math.log10)(a) : Math.log(num(b)) / Math.log(num(a))),
      log2: mapNum(Math.log2),
      atan2: (y, x) => Math.atan2(num(y), num(x)),
      mod: (a, b) => arith("%", a, b),
      min: (...a) => Math.min(...numbersOf(a)),
      max: (...a) => Math.max(...numbersOf(a)),
      sum: (...a) => numbersOf(a).reduce((s, x) => s + x, 0),
      prod: (...a) => numbersOf(a).reduce((s, x) => s * x, 1),
      mean: (...a) => { const v = numbersOf(a); return v.reduce((s, x) => s + x, 0) / v.length; },
      median: (...a) => { const v = numbersOf(a).sort((p, q) => p - q); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; },
      stdev: (...a) => { const v = numbersOf(a); const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1)); },
      len: (v) => toList(v).length, length: (v) => toList(v).length, count: (v) => toList(v).length,
      range: (a, b, s) => (b === undefined ? new Range(0, num(a) - 1, 1) : new Range(num(a), num(b), s === undefined ? undefined : num(s))),
      list: (v) => toList(v).slice(),
      map: (v, f) => toList(v).map((item, i) => call(f, f.params?.length >= 2 ? [item, i] : [item])),
      filter: (v, f) => toList(v).filter((item) => truthy(call(f, [item]))),
      reduce: (v, f, init) => { const l = toList(v); let acc = init === undefined ? l[0] : init; for (let i = init === undefined ? 1 : 0; i < l.length; i++) acc = call(f, [acc, l[i]]); return acc; },
      sort: (v, f) => toList(v).slice().sort(f ? (p, q) => num(call(f, [p])) - num(call(f, [q])) : (p, q) => num(p) - num(q)),
      reverse: (v) => toList(v).slice().reverse(),
      join: (...a) => a.flatMap((v) => (Array.isArray(v) || v instanceof Range ? toList(v) : [v])),
      push: (v, item) => { if (!Array.isArray(v)) throw new PlotError("push는 배열에만 쓸 수 있습니다."); v.push(item); return v; },
      slice: (v, a, b) => toList(v).slice(num(a), b === undefined ? undefined : num(b)),
      cumsum: (v) => { let s = 0; return toList(v).map((x) => (s += num(x))); },
      diff: (v) => { const l = toList(v).map(num); return l.slice(1).map((x, i) => x - l[i]); },
      linspace: (a, b, n) => { const k = Math.max(2, Math.round(num(n))); return Array.from({ length: k }, (_, i) => num(a) + (num(b) - num(a)) * i / (k - 1)); },
      repeat: (v, n) => Array.from({ length: Math.max(0, Math.round(num(n))) }, () => v),
      gcd: (a, b) => gcd(num(a), num(b)), lcm: (a, b) => Math.abs(num(a) * num(b)) / gcd(num(a), num(b)),
      factorial: mapNum(factorial), gamma: mapNum(gamma),
      nCr: (n, k) => factorial(num(n)) / (factorial(num(k)) * factorial(num(n) - num(k))),
      choose: (n, k) => factorial(num(n)) / (factorial(num(k)) * factorial(num(n) - num(k))),
      nPr: (n, k) => factorial(num(n)) / factorial(num(n) - num(k)),
      hypot: (...a) => Math.hypot(...numbersOf(a)),
      clamp: (x, a, b) => Math.min(num(b), Math.max(num(a), num(x))),
      lerp: (a, b, t) => arith("+", a, arith("*", arith("-", b, a), t)),
      deg: mapNum((x) => x * 180 / Math.PI), rad: mapNum((x) => x * Math.PI / 180),
      random: (seed) => { let s = Math.sin(num(seed ?? 1) * 12.9898) * 43758.5453; return s - Math.floor(s); },
      point: (...a) => new Tuple(a.map(num)),
      dist: (p, q) => Math.hypot(...p.items.map((v, i) => num(v) - num(q.items[i]))),
      dot: (p, q) => p.items.reduce((s, v, i) => s + num(v) * num(q.items[i]), 0),
      cross: (p, q) => { const [a1, a2, a3 = 0] = p.items.map(num); const [b1, b2, b3 = 0] = q.items.map(num); return new Tuple([a2 * b3 - a3 * b2, a3 * b1 - a1 * b3, a1 * b2 - a2 * b1]); },
      norm: (p) => Math.hypot(...p.items.map(num)),
      polygon: (...a) => new Shape("polygon", a.length === 1 ? toList(a[0]) : a),
      polyline: (...a) => new Shape("polyline", a.length === 1 ? toList(a[0]) : a),
      segment: (p, q) => new Shape("polyline", [p, q]),
      vector: (p, q) => (q === undefined ? new Shape("vector", [new Tuple(p.items.map(() => 0)), p]) : new Shape("vector", [p, q])),
      if_: (c, a, b) => (truthy(c) ? a : b),
    };
    const out = new Map();
    for (const [name, fn] of Object.entries(B)) out.set(name, new Fn(name, null, null, null, fn));
    return out;
  }

  const CONSTANTS = { pi: Math.PI, "π": Math.PI, e: Math.E, tau: 2 * Math.PI, "τ": 2 * Math.PI, inf: Infinity, "∞": Infinity, phi: (1 + Math.sqrt(5)) / 2, "φ": (1 + Math.sqrt(5)) / 2 };

  /* Compile an expression node into a closure (scope) => value. */
  function compile(n, ctx) {
    switch (n.type) {
      case "num": { const v = n.bool ? Boolean(n.value) : n.value; return () => v; }
      case "id": {
        const name = n.name === "theta" ? "θ" : n.name;
        return (s) => {
          const v = s.get(name);
          if (v !== undefined) return v;
          if (name in CONSTANTS) return CONSTANTS[name];
          const b = ctx.builtins.get(name);
          if (b) return b;
          throw new PlotError(PLOT_VARS.has(name) ? `좌표 변수 '${name}'는 여기서 쓸 수 없습니다. 함수로 정의하세요: f(${name}) = …` : `'${name}'이(가) 정의되지 않았습니다.`, n.line);
        };
      }
      case "neg": { const f = compile(n.value, ctx); return (s) => arith("*", -1, f(s)); }
      case "not": { const f = compile(n.value, ctx); return (s) => !truthy(f(s)); }
      case "bin": {
        const a = compile(n.left, ctx), b = compile(n.right, ctx), op = n.op;
        if (n.implicit && n.right.type === "id") {
          // `a b` where a is a function: treat as a call (e.g. sin x).
          return (s) => { const l = a(s); return l instanceof Fn ? ctx.callFn(l, [b(s)], n.line) : arith(op, l, b(s)); };
        }
        return (s) => {
          const l = a(s), r = b(s);
          if (typeof l === "number" && typeof r === "number") {
            switch (op) {
              case "+": return l + r;
              case "-": return l - r;
              case "*": return l * r;
              case "/": return l / r;
            }
          }
          if (op === "*" && l instanceof Fn) return ctx.callFn(l, [r], n.line);
          return arith(op, l, r);
        };
      }
      case "logic": {
        const a = compile(n.left, ctx), b = compile(n.right, ctx);
        return n.op === "and" ? (s) => truthy(a(s)) && truthy(b(s)) : (s) => truthy(a(s)) || truthy(b(s));
      }
      case "compare": {
        const terms = n.terms.map((t) => compile(t, ctx));
        const ops = n.ops;
        return (s) => {
          let left = terms[0](s);
          for (let i = 0; i < ops.length; i++) {
            const right = terms[i + 1](s);
            if (!compareOp(ops[i], left, right)) return false;
            left = right;
          }
          return true;
        };
      }
      case "range": {
        const a = compile(n.a, ctx), b = compile(n.b, ctx), st = n.step ? compile(n.step, ctx) : null;
        return (s) => new Range(num(a(s)), num(b(s)), st ? num(st(s)) : undefined);
      }
      case "tuple": { const items = n.items.map((i) => compile(i, ctx)); return (s) => new Tuple(items.map((f) => f(s))); }
      case "list": { const items = n.items.map((i) => compile(i, ctx)); return (s) => items.map((f) => f(s)); }
      case "comprehension": {
        const value = compile(n.value, ctx);
        const loops = n.loops.map((l) => ({ name: l.name, iter: compile(l.iter, ctx) }));
        const filter = n.filter ? compile(n.filter, ctx) : null;
        return (s) => {
          const out = [];
          const inner = new Scope(s);
          const walk = (depth) => {
            if (depth === loops.length) {
              if (!filter || truthy(filter(inner))) out.push(value(inner));
              return;
            }
            for (const item of toList(loops[depth].iter(inner))) {
              ctx.tick();
              inner.vars.set(loops[depth].name, item);
              walk(depth + 1);
            }
          };
          walk(0);
          return out;
        };
      }
      case "cond": {
        const c = compile(n.cond, ctx), a = compile(n.a, ctx), b = compile(n.b, ctx);
        return (s) => (truthy(c(s)) ? a(s) : b(s));
      }
      case "piecewise": {
        const branches = n.branches.map((br) => ({ cond: compile(br.cond, ctx), value: compile(br.value, ctx) }));
        const otherwise = n.otherwise ? compile(n.otherwise, ctx) : null;
        const onlyCondition = !branches.length;
        return (s) => {
          for (const br of branches) if (truthy(br.cond(s))) return br.value(s);
          if (!otherwise) return NaN;
          const v = otherwise(s);
          // `{x > 0}` on its own means 1 where true, undefined elsewhere (Desmos restriction).
          if (onlyCondition && typeof v === "boolean") return v ? 1 : NaN;
          return v;
        };
      }
      case "call": {
        const callee = compile(n.callee, ctx);
        const args = n.args.map((a) => compile(a, ctx));
        return (s) => {
          const f = callee(s);
          const values = args.map((a) => a(s));
          if (f instanceof Fn) return ctx.callFn(f, values, n.line);
          if (values.length === 1) return arith("*", f, values[0]); // a(x+1) = a·(x+1)
          throw new PlotError(`'${n.callee.name}'은(는) 함수가 아닙니다.`, n.line);
        };
      }
      case "index": {
        const target = compile(n.target, ctx), index = compile(n.index, ctx);
        return (s) => {
          const list = target(s);
          const i = index(s);
          const items = list instanceof Tuple ? list.items : toList(list);
          if (i instanceof Range || Array.isArray(i)) return toList(i).map((k) => items[Math.round(num(k))]);
          const k = Math.round(num(i));
          if (k < 0 || k >= items.length) throw new PlotError(`인덱스 ${k}가 범위(0~${items.length - 1})를 벗어났습니다.`, n.line);
          return items[k];
        };
      }
      case "member": {
        const target = compile(n.target, ctx);
        const slot = { x: 0, y: 1, z: 2 }[n.name];
        return (s) => {
          const v = target(s);
          if (n.name === "length" || n.name === "len") return toList(v).length;
          if (slot !== undefined) {
            if (v instanceof Tuple) return v.items[slot];
            if (Array.isArray(v)) return v.map((p) => (p instanceof Tuple ? p.items[slot] : NaN));
          }
          throw new PlotError(`'.${n.name}'을(를) 읽을 수 없습니다.`, n.line);
        };
      }
      case "lambda": {
        return (s) => new Fn("λ", n.params, n.body, s);
      }
      default:
        throw new PlotError("이 식은 계산할 수 없습니다.", n.line);
    }
  }

  function compileCached(n, ctx) {
    if (!n.compiled) n.compiled = compile(n, ctx);
    return n.compiled;
  }

  /* Run statements inside function bodies (no plotting). */
  function execBlock(stmts, scope, ctx) {
    for (const st of stmts) execStatement(st, scope, ctx);
  }

  function execStatement(st, scope, ctx) {
    ctx.tick();
    switch (st.type) {
      case "equation": {
        if (st.left.type !== "id") throw new PlotError("함수 안에서는 '이름 = 값' 형태로만 대입할 수 있습니다.", st.line);
        scope.assign(st.left.name, compileCached(st.right, ctx)(scope));
        return;
      }
      case "setindex": {
        const list = compileCached(st.target, ctx)(scope);
        if (!Array.isArray(list)) throw new PlotError("배열에만 원소를 대입할 수 있습니다.", st.line);
        const k = Math.round(num(compileCached(st.index, ctx)(scope)));
        if (k < 0 || k > 100000) throw new PlotError(`인덱스 ${k}가 올바르지 않습니다.`, st.line);
        list[k] = compileCached(st.value, ctx)(scope);
        return;
      }
      case "fndef":
        scope.set(st.name, new Fn(st.name, st.params, st.body, scope, null, st.block));
        scope.get(st.name).block = st.block;
        return;
      case "for":
        for (const item of toList(compileCached(st.iter, ctx)(scope))) {
          ctx.tick();
          scope.assign(st.name, item);
          execBlock(st.body, scope, ctx);
        }
        return;
      case "while":
        while (truthy(compileCached(st.cond, ctx)(scope))) {
          ctx.tick();
          execBlock(st.body, scope, ctx);
        }
        return;
      case "if":
        if (truthy(compileCached(st.cond, ctx)(scope))) execBlock(st.then, scope, ctx);
        else if (st.otherwise) execBlock(st.otherwise, scope, ctx);
        return;
      case "return":
        throw new ReturnSignal(st.value ? compileCached(st.value, ctx)(scope) : NaN);
      case "expr":
        compileCached(st.expr, ctx)(scope);
        return;
      case "error":
        throw new PlotError(st.message, st.errorLine);
      default:
        throw new PlotError("함수 안에서 쓸 수 없는 문장입니다.", st.line);
    }
  }

  function makeContext() {
    const ctx = {
      work: 0,
      depth: 0,
      tick() {
        if (++ctx.work > MAX_WORK) throw new PlotError("반복·재귀가 너무 많습니다 (계산 한도 초과).");
      },
      callFn(f, args, line) {
        if (f.native) return f.native(...args);
        if (args.length !== f.params.length) {
          throw new PlotError(`${f.name}은(는) 인자 ${f.params.length}개가 필요합니다 (받은 개수 ${args.length}).`, line);
        }
        if (++ctx.depth > 400) { ctx.depth = 0; throw new PlotError("재귀가 너무 깊습니다.", line); }
        ctx.tick();
        const scope = new Scope(f.closure);
        scope.boundary = true;
        f.params.forEach((p, i) => scope.vars.set(p === "theta" ? "θ" : p, args[i]));
        try {
          if (f.block) {
            try { execBlock(f.body, scope, ctx); } catch (signal) {
              if (signal instanceof ReturnSignal) return signal.value;
              throw signal;
            }
            return NaN;
          }
          return compileCached(f.body, ctx)(scope);
        } finally { ctx.depth--; }
      },
    };
    ctx.builtins = builtins(ctx);
    return ctx;
  }

  /* ------------------------------ plot classification ------------------------------ */

  function freeVars(n, bound = new Set(), out = new Set()) {
    if (!n || typeof n !== "object") return out;
    if (n.type === "id") {
      const name = n.name === "theta" ? "θ" : n.name;
      if (!bound.has(name)) out.add(name);
      return out;
    }
    if (n.type === "lambda") {
      const inner = new Set(bound);
      for (const p of n.params) inner.add(p);
      return freeVars(n.body, inner, out);
    }
    if (n.type === "comprehension") {
      const inner = new Set(bound);
      for (const l of n.loops) { freeVars(l.iter, inner, out); inner.add(l.name); }
      freeVars(n.value, inner, out);
      if (n.filter) freeVars(n.filter, inner, out);
      return out;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === "compiled" || key === "line") continue;
      if (Array.isArray(value)) for (const item of value) freeVars(item, bound, out);
      else if (value && typeof value === "object") {
        if (value.type) freeVars(value, bound, out);
        else for (const inner of Object.values(value)) if (inner && typeof inner === "object" && inner.type) freeVars(inner, bound, out);
      }
    }
    return out;
  }

  function plotVarsOf(n, scope) {
    const vars = new Set();
    for (const name of freeVars(n)) if (PLOT_VARS.has(name) && !scope.has(name)) vars.add(name === "theta" ? "θ" : name);
    return vars;
  }

  const isId = (n, name) => n && n.type === "id" && (n.name === name || (name === "θ" && n.name === "theta"));

  function formatValue(v, depth = 0) {
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "정의되지 않음";
      if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
      return Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0) ? v.toExponential(4) : String(+v.toPrecision(10));
    }
    if (typeof v === "boolean") return v ? "참" : "거짓";
    if (v instanceof Tuple) return "(" + v.items.map((i) => formatValue(i, depth + 1)).join(", ") + ")";
    if (v instanceof Range) return `${formatValue(v.a)}..${formatValue(v.b)}` + (v.step ? ` step ${formatValue(v.step)}` : "");
    if (Array.isArray(v)) {
      if (depth > 1) return `[…${v.length}]`;
      const shown = v.slice(0, 12).map((i) => formatValue(i, depth + 1));
      return "[" + shown.join(", ") + (v.length > 12 ? `, … (${v.length}개)` : "") + "]";
    }
    if (v instanceof Fn) return v.native ? `내장 함수 ${v.name}` : `함수 ${v.name}(${(v.params || []).join(", ")})`;
    if (v instanceof Shape) return `${v.type} (${v.points.length}점)`;
    return String(v);
  }

  /* Run a whole .plot program. `overrides` replaces slider values without editing the text. */
  function run(src, overrides = {}) {
    const result = { plots: [], outputs: [], sliders: [], errors: [], settings: {}, lineInfo: new Map() };
    let program;
    try { program = parse(src); }
    catch (error) {
      result.errors.push({ line: error.line || 1, message: error.message });
      return result;
    }
    const ctx = makeContext();
    const globals = new Scope();
    let colorIndex = 0;
    const lineOf = (st) => st.line;
    const note = (line, info) => result.lineInfo.set(line, { ...(result.lineInfo.get(line) || {}), ...info });

    // Hoist function definitions so order of lines does not matter (like Desmos).
    for (const st of program) {
      if (st.type === "fndef") globals.set(st.name, Object.assign(new Fn(st.name, st.params, st.body, globals), { block: st.block }));
    }

    function probe(plot) {
      const tries = [[0.3712, -0.5417, 0.2231], [1.913, 0.731, -1.37], [-2.47, 1.65, 0.97]];
      const fns = plot.f ? [plot.f] : plot.test ? [plot.test] : plot.fs || [];
      for (const f of fns) {
        let lastError = null;
        for (const args of tries) {
          try { f(...args); lastError = null; break; } catch (error) { lastError = error; }
        }
        if (lastError) throw lastError;
      }
    }

    function addPlot(plot, st) {
      probe(plot);
      plot.line = lineOf(st);
      plot.colorIndex = st.color ? null : colorIndex++;
      plot.color = st.color || null;
      plot.restrict = st.restrict ? compileCached(st.restrict, ctx) : null;
      result.plots.push(plot);
      note(plot.line, { plot: true, colorIndex: plot.colorIndex, color: plot.color, kind: plot.kind });
    }

    /* Build a numeric sampler f(vars…) for `expr` bound to a frozen copy of `scope`. */
    function sampler(expr, scope, names) {
      const f = compileCached(expr, ctx);
      const s = new Scope(scope);
      const keys = names.map((n) => (n === "theta" ? "θ" : n));
      if (keys.length === 1) return (a) => { s.vars.set(keys[0], a); ctx.work = 0; return f(s); };
      if (keys.length === 2) return (a, b) => { s.vars.set(keys[0], a); s.vars.set(keys[1], b); ctx.work = 0; return f(s); };
      return (a, b, c) => { s.vars.set(keys[0], a); s.vars.set(keys[1], b); s.vars.set(keys[2], c); ctx.work = 0; return f(s); };
    }

    function restrictFor(st, scope, names) {
      if (!st.restrict) return null;
      return sampler(st.restrict, scope, names);
    }

    function plotEquation(st, scope) {
      const { left, right } = st;
      const frozen = scope.flatten();
      const vars = new Set([...plotVarsOf(left, frozen), ...plotVarsOf(right, frozen)]);
      const has3 = vars.has("z");
      const diff = { type: "bin", op: "-", left, right, line: st.line };
      if (isId(left, "y") && !plotVarsOf(right, frozen).has("y") && !has3) {
        return addPlot({ kind: "explicit", dep: "y", f: sampler(right, frozen, ["x"]), restrictF: restrictFor(st, frozen, ["x", "y"]) }, st);
      }
      if (isId(left, "x") && !plotVarsOf(right, frozen).has("x") && !has3 && !plotVarsOf(right, frozen).has("t")) {
        return addPlot({ kind: "explicit", dep: "x", f: sampler(right, frozen, ["y"]), restrictF: restrictFor(st, frozen, ["x", "y"]) }, st);
      }
      if (isId(left, "r") && !plotVarsOf(right, frozen).has("r")) {
        return addPlot({ kind: "polar", f: sampler(right, frozen, ["θ"]), restrictF: restrictFor(st, frozen, ["θ"]) }, st);
      }
      if (isId(left, "z") && !plotVarsOf(right, frozen).has("z")) {
        return addPlot({ kind: "surface", f: sampler(right, frozen, ["x", "y"]), restrictF: restrictFor(st, frozen, ["x", "y", "z"]) }, st);
      }
      if (has3) {
        return addPlot({ kind: "implicit3", f: sampler(diff, frozen, ["x", "y", "z"]), restrictF: restrictFor(st, frozen, ["x", "y", "z"]) }, st);
      }
      if (vars.has("x") || vars.has("y")) {
        return addPlot({ kind: "implicit", f: sampler(diff, frozen, ["x", "y"]), restrictF: restrictFor(st, frozen, ["x", "y"]) }, st);
      }
      // No coordinate variables: a numeric identity, evaluate both sides.
      const a = compileCached(left, ctx)(frozen), b = compileCached(right, ctx)(frozen);
      note(st.line, { output: compareOp("==", a, b) ? "참 (양변이 같습니다)" : `거짓: ${formatValue(a)} ≠ ${formatValue(b)}` });
    }

    function plotRegion(st, expr, scope) {
      const frozen = scope.flatten();
      const vars = plotVarsOf(expr, frozen);
      const is3 = vars.has("z");
      const names = is3 ? ["x", "y", "z"] : ["x", "y"];
      const plot = { kind: is3 ? "region3" : "region", test: sampler(expr, frozen, names), restrictF: restrictFor(st, frozen, names) };
      // Boundary of a single comparison a < b is the curve a = b (dashed when strict).
      if (expr.type === "compare" && expr.ops.length === 1) {
        plot.boundary = sampler({ type: "bin", op: "-", left: expr.terms[0], right: expr.terms[1], line: st.line }, frozen, names);
        plot.strict = expr.ops[0] === "<" || expr.ops[0] === ">";
      }
      addPlot(plot, st);
    }

    function plotExpression(st, scope) {
      const frozen = scope.flatten();
      const vars = plotVarsOf(st.expr, frozen);
      if (vars.size === 0) {
        const value = compileCached(st.expr, ctx)(frozen);
        if (value instanceof Tuple || value instanceof Shape || (Array.isArray(value) && value.length && value.every((p) => p instanceof Tuple || p instanceof Shape))) {
          const items = Array.isArray(value) ? value : [value];
          addPlot({ kind: "points", items }, st);
          note(st.line, { output: formatValue(value) });
          return;
        }
        if (typeof value === "boolean" || typeof value === "number" || Array.isArray(value) || value instanceof Range) note(st.line, { output: formatValue(value) });
        return;
      }
      if (st.expr.type === "compare" || st.expr.type === "logic" || st.expr.type === "not") return plotRegion(st, st.expr, scope);
      if (st.expr.type === "tuple") {
        const n = st.expr.items.length;
        if ((vars.has("u") || vars.has("v")) && n === 3) {
          return addPlot({ kind: "paramSurface", fs: st.expr.items.map((e) => sampler(e, frozen, ["u", "v"])) }, st);
        }
        if (vars.has("t") && !vars.has("x") && !vars.has("y")) {
          return addPlot({ kind: n === 3 ? "param3" : "param", fs: st.expr.items.map((e) => sampler(e, frozen, ["t"])), restrictF: restrictFor(st, frozen, ["t"]) }, st);
        }
      }
      if ([...vars].every((v) => v === "x")) {
        return addPlot({ kind: "explicit", dep: "y", f: sampler(st.expr, frozen, ["x"]), restrictF: restrictFor(st, frozen, ["x", "y"]) }, st);
      }
      if ([...vars].every((v) => v === "x" || v === "y")) {
        return addPlot({ kind: "surface", f: sampler(st.expr, frozen, ["x", "y"]) }, st);
      }
      throw new PlotError(`그릴 수 없는 식입니다 (자유 변수: ${[...vars].join(", ")}).`, st.line);
    }

    function topLevel(st, scope, inLoop) {
      switch (st.type) {
        case "error":
          throw new PlotError(st.message, st.errorLine);
        case "fndef":
          if (inLoop) scope.set(st.name, Object.assign(new Fn(st.name, st.params, st.body, scope), { block: st.block }));
          note(st.line, { output: null, defined: st.name });
          return;
        case "equation": {
          const { left } = st;
          if (left.type === "id" && !PLOT_VARS.has(left.name)) {
            if (SETTINGS.has(left.name)) {
              const v = compileCached(st.right, ctx)(scope);
              result.settings[left.name === "thetarange" ? "θrange" : left.name] = v instanceof Range ? [v.a, v.b] : num(v);
              note(st.line, { output: formatValue(v), setting: true });
              return;
            }
            const literal = !inLoop && (st.right.type === "num" || (st.right.type === "neg" && st.right.value.type === "num"));
            if (literal) {
              const base = st.right.type === "num" ? st.right.value : -st.right.value.value;
              let min, max;
              if (st.sliderRange) {
                const r = compileCached(st.sliderRange, ctx)(scope);
                if (r instanceof Range) { min = r.a; max = r.b; }
              }
              if (min === undefined) {
                const span = Math.max(10, Math.ceil(Math.abs(base) * 2));
                min = base >= 0 && base <= 10 ? -10 : -span;
                max = span;
              }
              const value = Object.hasOwn(overrides, left.name) ? overrides[left.name] : base;
              const step = st.sliderRange?.step ? num(compileCached(st.sliderRange.step, ctx)(scope)) : (max - min) / 200;
              result.sliders.push({ name: left.name, value, base, min, max, step, line: st.line });
              scope.set(left.name, value);
              note(st.line, { slider: left.name });
              return;
            }
            const v = compileCached(st.right, ctx)(scope);
            if (inLoop) scope.assign(left.name, v); else scope.set(left.name, v);
            if (v instanceof Tuple || (Array.isArray(v) && v.length && v.every((p) => p instanceof Tuple || p instanceof Shape)) || v instanceof Shape) {
              addPlot({ kind: "points", items: Array.isArray(v) ? v : [v], label: left.name }, st);
            }
            note(st.line, { output: formatValue(v) });
            return;
          }
          return plotEquation(st, scope);
        }
        case "setindex":
        case "while":
          return execStatement(st, scope, ctx);
        case "for": {
          const items = toList(compileCached(st.iter, ctx)(scope));
          if (items.length > 400) throw new PlotError("그래프를 그리는 for 반복은 400회까지 가능합니다.", st.line);
          for (const item of items) {
            const inner = new Scope(scope);
            inner.vars.set(st.name, item);
            for (const child of st.body) topLevel(child, inner, true);
          }
          return;
        }
        case "if": {
          const branch = truthy(compileCached(st.cond, ctx)(scope)) ? st.then : st.otherwise;
          for (const child of branch || []) topLevel(child, new Scope(scope), true);
          return;
        }
        case "return":
          throw new PlotError("return은 함수(fn) 안에서만 쓸 수 있습니다.", st.line);
        case "expr":
          return plotExpression(st, scope);
        default:
          throw new PlotError("알 수 없는 문장입니다.", st.line);
      }
    }

    for (const st of program) {
      try {
        ctx.work = 0;
        topLevel(st, globals, false);
      } catch (error) {
        // Report on the statement being run; mention where inside it (a function body) it failed.
        const line = st.type === "error" ? st.errorLine : st.line;
        let message = error instanceof PlotError ? error.message : error instanceof RangeError ? "재귀가 너무 깊습니다." : String(error.message || error);
        if (error instanceof PlotError && error.line && error.line !== line && st.type !== "error") message += ` (${error.line}행)`;
        result.errors.push({ line, message });
        note(line, { error: message });
      }
    }
    const dim = result.settings.dim;
    result.is3d = dim === 3 || (dim !== 2 && result.plots.some((p) => ["surface", "implicit3", "region3", "param3", "paramSurface"].includes(p.kind) ||
      (p.kind === "points" && p.items.some((item) => (item instanceof Tuple && item.items.length === 3) || (item instanceof Shape && item.points[0]?.items?.length === 3)))));
    return result;
  }

  const api = { run, parse, lex, formatValue, Tuple, Range, Shape, Fn, PlotError, PLOT_VARS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QNBPlotLang = api;
})(typeof window !== "undefined" ? window : globalThis);
