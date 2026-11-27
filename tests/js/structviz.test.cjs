// node tests/js/structviz.test.cjs — graph / network detection on real C++, Java and Python
// tracer output (one step each, see fixtures/stdlib_steps.json).
const assert = require("node:assert/strict");
global.window = {};
global.document = { documentElement: { dataset: {} }, body: {} };
require("../../qnb/static/structviz.js");
const SV = window.QNBStructViz;
const steps = require("./fixtures/stdlib_steps.json");

const graphs = (key) => Object.fromEntries(SV.detectAll(steps[key]).map((g) => [g.name, g]));
const summary = (g) => `${g.kind} ${g.nodes.length}v ${g.edges.length}e${g.weighted ? " W" : ""}`;

// standard containers
for (const lang of ["cpp", "java", "python"]) {
  const g = graphs(`containers:${lang}`);
  assert.equal(summary(g.adj), lang === "python" ? "adjacency 5v 5e" : "adjacency-list 5v 5e", lang + " adj");
  assert.ok(g.net.weighted, lang + " weighted net");
  assert.equal(g.mat.kind, "matrix", lang + " matrix");
  assert.equal(g.g2.kind, "adjacency", lang + " map of sets");
  assert.ok(!g.pq, lang + " priority queue is not an edge list");
}
assert.equal(summary(graphs("containers:cpp").edges), "weighted-edges 3v 3e W");         // vector<tuple<int,int,int>>
assert.equal(summary(graphs("containers:cpp").elist), "weighted-edges 3v 2e W");         // vector<Edge{u,v,w}>
assert.equal(summary(graphs("containers:cpp").pairs), "edges 3v 3e");                    // vector<pair<int,int>>
assert.equal(summary(graphs("containers:java").roads), "weighted-adjacency 3v 2e W");    // TreeMap<String, Map.of(...)>
assert.equal(summary(graphs("containers:java").es), "edges 5v 5e");                      // int[][]
assert.equal(summary(graphs("containers:python").edges), "weighted-edges 3v 2e W");      // namedtuple Edge

// traversal state from queue / visited / parent / dist / priority queue
const cppAdj = graphs("containers:cpp").adj;
const t = SV.traversal(steps["containers:cpp"], cppAdj);
assert.deepEqual([...t.visited].sort(), ["0", "1", "2"]);                                 // vector<bool>
assert.deepEqual([...t.frontier.keys()].slice(0, 2), ["1", "2"]);                          // queue<int>
assert.deepEqual(t.current.get("0"), ["u"]);
assert.equal(t.parentEdges.size, 2);
const cppNet = SV.traversal(steps["containers:cpp"], graphs("containers:cpp").net);
assert.deepEqual([...cppNet.frontier.keys()], ["B", "D"]);                                 // priority_queue<pair<int,string>>
assert.equal(cppNet.dist.get("C"), "1");

// node objects, graphs inside classes, weighted lists of records, ∞ distances
const co = graphs("objects:cpp");
assert.equal(summary(co.n0), "objects 3v 3e");                                            // Node{vector<Node*>} with &n1
assert.equal(summary(co["g.adj"]), "adjacency-list 3v 3e");                                // struct Graph{adj}
assert.equal(summary(co.wadj), "adjacency-list 3v 3e W");                                  // vector<vector<pair<int,int>>>
assert.equal(Object.keys(co).length, 3, "sub-graphs of n0 are not listed twice");
const jo = graphs("objects:java");
assert.equal(summary(jo["graph.adj"]), "adjacency 3v 2e");                                 // class Graph{Map<Integer,List<Integer>>}
assert.equal(summary(jo.g), "adjacency-list 3v 3e W");                                     // List<Edge>[] with Edge{to, cost}
assert.equal(SV.traversal(steps["objects:java"], jo.g).dist.get("2"), "∞");                // Long.MAX_VALUE
const po = graphs("objects:python");
assert.equal(summary(po.a), "objects 3v 3e");                                              // Vertex.neighbors
assert.equal(summary(po["g.adj"]), "adjacency 3v 2e");                                     // self.adj
assert.equal(SV.traversal(steps["objects:python"], po.wadj).dist.get("1"), "∞");           // float("inf")
console.log("structviz: all checks passed");
