// node tests/js/plotlang.test.cjs — checks the .plot language used by the 좌표계 pane.
const assert = require("node:assert/strict");
const L = require("../../qnb/static/plotlang.js");

const kinds = (src) => L.run(src).plots.map((p) => p.kind + (p.dep ? ":" + p.dep : ""));
const out = (src, line) => L.run(src).lineInfo.get(line)?.output;

assert.deepEqual(kinds("y = x^2\nx = y^2\nx^2 + y^2 = 4\ny < x\nr = 1 + cos θ\n(cos t, sin t)"),
  ["explicit:y", "explicit:x", "implicit", "region", "polar", "param"]);
assert.deepEqual(kinds("z = x y\nx^2 + y^2 + z^2 = 1\n(cos t, sin t, t)\n(u, v, u v)"), ["surface", "implicit3", "param3", "paramSurface"]);
assert.equal(L.run("x^2 + y^2 + z^2 = 9").is3d, true);
assert.equal(L.run("x^2 + y^2 + z^2 = 9").plots[0].f(3, 0, 0), 0);

// sliders, overrides, implicit multiplication
const slid = L.run("a = 2 in 0..5\ny = a x", { a: 4 });
assert.deepEqual(slid.sliders.map((s) => [s.name, s.value, s.min, s.max]), [["a", 4, 0, 5]]);
assert.equal(slid.plots[0].f(3), 12);
assert.equal(L.run("y = 2 sin x cos x").plots[0].f(Math.PI / 4), 1);

// arrays, comprehensions, lambdas, indexing
assert.equal(out("L = [1, 2, 3]\nsum(L) + L[2]", 2), "9");
assert.equal(out("map(1..4, k -> k^2)", 1), "[1, 4, 9, 16]");
assert.equal(out("[i * j for i in 1..2, j in 1..3]", 1), "[1, 2, 3, 2, 4, 6]");
assert.equal(out("[k for k in 1..10 if k % 3 == 0]", 1), "[3, 6, 9]");
assert.equal(L.run("P = [(k, k^2) for k in 0..3]").plots[0].items.length, 4);

// conditionals and loops
assert.equal(out("g(x) = if x < 0 then -x else x^2\ng(-3) + g(2)", 2), "7");
assert.equal(out("h(x) = {x < 0: -1, x > 0: 1, 0}\n[h(-2), h(0), h(5)]", 2), "[-1, 0, 1]");
assert.ok(Number.isNaN(L.run("y = x {x > 0}").plots[0].restrictF(-1, -1)));
assert.equal(L.run("for k in 1..3 { y = k x }").plots.map((p) => p.f(2)).join(","), "2,4,6");
assert.equal(out("fn fib(n) {\n  a = 0; b = 1\n  for i in 1..n { t = a + b; a = b; b = t }\n  return a\n}\n[fib(k) for k in 0..7]", 6), "[0, 1, 1, 2, 3, 5, 8, 13]");
assert.equal(out("fn fact(n) { if n <= 1 { return 1 } else { return n * fact(n - 1) } }\nfact(6)", 2), "720");
assert.equal(out("fn collatz(n) {\n  c = 0\n  while n != 1 { n = if n % 2 == 0 then n / 2 else 3n + 1; c = c + 1 }\n  return c\n}\ncollatz(27)", 6), "111");
assert.equal(out("1..0", 1), "1..0");
assert.equal(out("len(1..0)", 1), "0");

// errors stay on their line and never stop other lines
const bad = L.run("a = (\ny = x\ny = nothing(x)\nwhile 1 { }\nfn f(n) { return f(n + 1) }\nf(1)\ny = 2x");
assert.deepEqual(bad.errors.map((e) => e.line), [1, 3, 4, 6]);
assert.equal(bad.plots.at(-1).f(1), 2);
console.log("plotlang: all checks passed");
