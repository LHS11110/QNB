"use strict";

/* Data structure · graph · network views of one execution step (Python / C++ / Java).
 *
 * Input is a stepper step: { stack: [{ func, locals: {name: value} }], heap: {id: obj} } where a
 * value is {kind: "prim"|"ref"|"repr"} and a heap object has items (sequences) or fields
 * (dicts, objects, structs).
 *   자료구조  boxes-and-pointers: variables → arrays / dicts / objects, linked lists in a row,
 *            binary trees as trees.
 *   그래프    adjacency (dict→list, list of lists, 0/1 matrix, edge list, node objects) drawn as
 *            vertices and edges, with traversal state taken from the other variables
 *            (visited / queue / stack / current vertex / parent).
 *   네트워크  the same detection with weights (dict→dict, weighted edge list, weight matrix):
 *            edge thickness and labels, degree-sized nodes, distance labels (dist / d / cost).
 */
window.QNBStructViz = (() => {
  const NEXT_KEYS = ["next", "nxt", "link", "succ", "_next"];
  const PREV_KEYS = ["prev", "previous", "_prev"];
  const LEFT_KEYS = ["left", "l", "lchild", "left_child", "_left"];
  const RIGHT_KEYS = ["right", "r", "rchild", "right_child", "_right"];
  const CHILD_LIST_KEYS = ["children", "kids", "child"];
  const NEIGHBOR_KEYS = ["neighbors", "neighbours", "adj", "edges", "adjacent", "links", "out"];
  const VALUE_KEYS = ["val", "value", "key", "data", "item", "name", "id", "label", "v"];
  const VISITED_RE = /^(visited|seen|vis|done|closed|explored|marked|used)$/i;
  const FRONTIER_RE = /^(queue|q|dq|deque|stack|st|frontier|open|pq|heap|todo|worklist|bag)$/i;
  const CURRENT_RE = /^(u|v|cur|curr|current|node|n|nd|vertex|x|w|nxt|neighbor|neighbour|nb|nei|child|start|src|s|source|target|dst|t)$/i;
  const DIST_RE = /^(dist|distance|distances|d|cost|costs|depth|level|order|low|disc|indeg|indegree|deg|degree)$/i;
  const PARENT_RE = /^(parent|parents|prev|pred|predecessor|came_from|from_)$/i;

  /* ------------------------------ value helpers ------------------------------ */

  const isRef = (v) => v && v.kind === "ref";
  const isPrim = (v) => v && v.kind === "prim";
  const isNullish = (v) => !v || (v.kind === "prim" && (v.value === null || v.type === "NoneType")) ||
    (v.kind === "repr" && /^(None|null|nullptr|NULL|0x0)$/.test(String(v.text || "").trim()));

  function primText(v) {
    if (!v) return "None";
    if (v.kind === "prim") {
      if (v.value === null) return "None";
      return v.type === "str" ? JSON.stringify(v.value) : String(v.value);
    }
    if (v.kind === "repr") return String(v.text || "");
    return "•";
  }

  /* Node identity for graph vertices: strings keep their text, numbers their value. */
  function keyOf(v) {
    if (!v) return null;
    if (v.kind === "prim") return v.value === null ? null : String(v.value);
    if (v.kind === "repr") return String(v.text || "").replace(/^"|"$/g, "");
    if (v.kind === "ref") return "@" + v.id;
    return null;
  }

  // C++ map/vector field names look like "[3]" or "\"a\""; Python dict keys are plain.
  const cleanKey = (k) => String(k).replace(/^\[(.*)\]$/, "$1").replace(/^"(.*)"$/, "$1");
  const numberOf = (v) => {
    if (!v) return NaN;
    if (v.kind === "prim") return typeof v.value === "number" ? v.value : typeof v.value === "boolean" ? +v.value : Number(v.value);
    if (v.kind === "repr") return Number(v.text);
    return NaN;
  };

  function fieldsOf(obj) {
    if (!obj) return [];
    if (Array.isArray(obj.fields)) return obj.fields.map(([k, v]) => [cleanKey(k), v]);
    return [];
  }
  const field = (obj, names) => {
    for (const [k, v] of fieldsOf(obj)) if (names.includes(k)) return v;
    return undefined;
  };
  const itemsOf = (obj, heap) => (obj && Array.isArray(obj.items) ? obj.items : null);

  function variables(step) {
    // Innermost frame first so local names win; globals (<module>) last.
    const seen = new Map();
    const frames = [...(step?.stack || [])].reverse();
    frames.forEach((frame, depth) => {
      for (const [name, value] of Object.entries(frame.locals || {})) {
        if (name.startsWith("__")) continue;
        if (!seen.has(name)) seen.set(name, { name, value, frame: frame.func, depth });
      }
    });
    return [...seen.values()];
  }

  /* ------------------------------ graph detection ------------------------------ */

  function valueLabel(obj, heap) {
    const v = field(obj, VALUE_KEYS);
    if (v && !isRef(v)) return primText(v).replace(/^"|"$/g, "");
    return "#" + obj.id.replace("obj_", "");
  }

  function addEdge(edges, from, to, w) {
    if (from === null || to === null) return;
    edges.push({ from, to, w: Number.isFinite(w) ? w : undefined });
  }

  function finishGraph(name, nodes, edges, kind) {
    const nodeMap = new Map();
    for (const n of nodes) if (n.id !== null && !nodeMap.has(n.id)) nodeMap.set(n.id, n);
    for (const e of edges) {
      for (const id of [e.from, e.to]) if (!nodeMap.has(id)) nodeMap.set(id, { id, label: id });
    }
    const set = new Set(edges.map((e) => e.from + "\u0000" + e.to));
    const directed = edges.some((e) => e.from !== e.to && !set.has(e.to + "\u0000" + e.from));
    // An undirected graph stored both ways is drawn with one edge per pair.
    let shown = edges;
    if (!directed) {
      const once = new Set();
      shown = edges.filter((e) => {
        const k = [e.from, e.to].sort().join("\u0000");
        if (once.has(k)) return false;
        once.add(k);
        return true;
      });
    }
    const weighted = shown.some((e) => e.w !== undefined && e.w !== 1);
    return { name, kind, nodes: [...nodeMap.values()], edges: shown, directed, weighted };
  }

  /* ---------------- standard library normalisation ----------------
   * The tracers hand us the same ideas in different clothes:
   *   C++   vector/deque/list/set/queue/stack/priority_queue → items; map/unordered_map → fields;
   *         pair/tuple → items; std::array → {_M_elems: [...]}; structs → fields; T* → ref (ptr)
   *   Java  ArrayList/LinkedList/ArrayDeque/PriorityQueue/HashSet/TreeSet/Stack/arrays → items;
   *         HashMap/TreeMap/LinkedHashMap → fields; List.of/Map.of → List12/ListN/Map1/MapN;
   *         records & classes → fields
   *   Python list/tuple/set/frozenset/deque/namedtuple → items; dict/defaultdict/OrderedDict/Counter → fields
   * normalise() renames the oddities and unwraps wrappers so detection sees one shape. */
  const JAVA_ALIASES = [
    [/^(List12|ListN|SubList|ArrayList\$SubList|UnmodifiableRandomAccessList|UnmodifiableList|SynchronizedRandomAccessList|SynchronizedList|CopyOnWriteArrayList)$/, "List"],
    [/^(Set12|SetN|UnmodifiableSet|SynchronizedSet|KeySet|EntrySetView)$/, "Set"],
    [/^(Map1|MapN|UnmodifiableMap|SynchronizedMap)$/, "Map"],
  ];
  const normalised = new WeakMap();

  function normalise(step) {
    if (!step?.heap) return step;
    if (normalised.has(step)) return normalised.get(step);
    const heap = {};
    for (const [id, obj] of Object.entries(step.heap)) {
      let entry = obj;
      const alias = JAVA_ALIASES.find(([re]) => re.test(obj.type || ""));
      if (alias) entry = { ...entry, type: alias[1] };
      // std::array<T, N> is a struct around a C array
      const f = Array.isArray(obj.fields) ? obj.fields : null;
      if (f && f.length === 1 && f[0][0] === "_M_elems" && isRef(f[0][1]) && step.heap[f[0][1].id]?.items) {
        const inner = step.heap[f[0][1].id];
        entry = { ...entry, items: inner.items, fields: undefined, length: inner.length, truncated: inner.truncated };
      }
      heap[id] = entry;
    }
    const out = { ...step, heap };
    normalised.set(step, out);
    return out;
  }

  const SRC_RE = /^(u|from|src|source|start|a|first|x|tail)$/i;
  const DST_RE = /^(v|to|dst|dest|destination|target|end|b|second|node|vertex|nb|nei|neighbor|neighbour|y|head|id)$/i;
  const W_RE = /^(w|weight|wt|cost|dist|distance|d|len|length|c|cap|capacity|time|price|third|value|val)$/i;

  /* Pair / tuple / edge-record view of a value: {items, src?, dst?, w?} or null. */
  function tupleOf(v, heap) {
    if (!isRef(v)) return null;
    const o = heap[v.id];
    if (!o) return null;
    if (Array.isArray(o.items)) return o.items.length >= 2 && o.items.length <= 4 && !/set/i.test(o.type) ? { items: o.items } : null;
    const f = fieldsOf(o);
    if (!f.length || f.length > 4) return null;
    const named = Object.fromEntries(f);
    if (named.first && named.second) return { items: [named.first, named.second, ...(named.third ? [named.third] : [])] };
    if (named.key && named.value && f.length === 2) return { items: [named.key, named.value], dst: named.key, w: named.value };
    if (f.length >= 2 && f.every(([, x]) => !isRef(x))) {
      const pick = (re, skip) => f.find(([k, x]) => re.test(k) && x !== skip)?.[1];
      const dst = pick(DST_RE);
      return { items: f.map(([, x]) => x), src: pick(SRC_RE, dst), dst, w: pick(W_RE, dst) };
    }
    return null;
  }

  /* (vertex, weight) of one adjacency entry: 3, (3, w), pair{3, w}, Edge{to: 3, w}. */
  function adjacencyEntry(x, heap) {
    if (!isRef(x)) return isNullish(x) ? null : { to: keyOf(x) };
    const t = tupleOf(x, heap);
    if (!t) return null;
    const to = t.dst ?? t.items[0];
    if (isRef(to)) return null;
    const w = t.w ?? t.items.find((item, i) => i > 0 && item !== to);
    return { to: keyOf(to), w: numberOf(w) };
  }

  const sameKind = (a, b) => isPrim(a) && isPrim(b) && typeof a.value === typeof b.value;
  const MAP_TYPE = /dict|map|Map|Hashtable|Properties|Counter/;

  function detectGraph(name, value, heap) {
    if (!isRef(value)) return null;
    const obj = heap[value.id];
    if (!obj) return null;
    const fields = fieldsOf(obj);
    const items = itemsOf(obj);

    // map: vertex → list/set of vertices | vertex → [(vertex, w)] | vertex → {vertex: w}
    if (fields.length && (MAP_TYPE.test(obj.type) || (!items && fields.length > 1 && fields.every(([, v]) => isRef(v))))) {
      const nodes = [], edges = [];
      let ok = 0, weighted = 0;
      for (const [k, v] of fields) {
        nodes.push({ id: k, label: k });
        if (!isRef(v)) continue;
        const inner = heap[v.id];
        if (!inner) continue;
        const list = itemsOf(inner);
        if (list) {
          const entries = list.map((x) => adjacencyEntry(x, heap));
          if (entries.every(Boolean)) {
            for (const e of entries) { addEdge(edges, k, e.to, e.w); if (Number.isFinite(e.w)) weighted++; }
            ok++;
          }
        } else if (fieldsOf(inner).length && fieldsOf(inner).every(([, w]) => !isRef(w)) &&
                   (MAP_TYPE.test(inner.type) || fieldsOf(inner).every(([k2]) => fields.some(([k1]) => k1 === k2)))) {
          // {vertex: weight}; a plain struct only counts when its field names are vertices
          for (const [k2, w] of fieldsOf(inner)) addEdge(edges, k, k2, numberOf(w));
          weighted++;
          ok++;
        }
      }
      if (ok && ok >= fields.length * 0.6) return finishGraph(name, nodes, edges, weighted ? "weighted-adjacency" : "adjacency");
    }

    if (items && items.length) {
      const sub = items.map((x) => (isRef(x) ? heap[x.id] : null));
      // edge list: [(u, v)], [(u, v, w)], vector<pair>, vector<tuple>, Edge{u, v, w}, int[][] {{u, v}}
      const tuples = items.map((x) => tupleOf(x, heap));
      // queues / heaps / stacks of (dist, v) pairs are work lists, not edge lists
      const workList = /queue|heap|stack|deque/i.test(obj.type) || FRONTIER_RE.test(name);
      if (!workList && tuples.every((t) => t && t.items.every((x) => !isRef(x)))) {
        const ends = tuples.map((t) => (t.src && t.dst ? [t.src, t.dst, t.w] : [t.items[0], t.items[1], t.items[2]]));
        const rows = tuples.map((t) => t.items);
        const square = rows.length === rows[0].length && rows.every((r) => r.length === rows.length);
        const looksLikeMatrix = square && rows.every((r) => r.every((x) => [0, 1].includes(numberOf(x))));
        if (!looksLikeMatrix && ends.every(([a, b]) => sameKind(a, b))) {
          const edges = [];
          for (const [a, b, w] of ends) addEdge(edges, keyOf(a), keyOf(b), w ? numberOf(w) : undefined);
          return finishGraph(name, [], edges, ends.some(([, , w]) => w && Number.isFinite(numberOf(w))) ? "weighted-edges" : "edges");
        }
      }
      const rows = sub.map((o) => itemsOf(o));
      // adjacency matrix (square, numeric; 0 / INF / null = no edge)
      const n = items.length;
      if (n >= 2 && n <= 40 && rows.every((r) => r && r.length === n && r.every((x) => !isRef(x) && (Number.isFinite(numberOf(x)) || isNullish(x) || /inf/i.test(primText(x)))))) {
        const edges = [];
        const binary = rows.every((r) => r.every((x) => [0, 1].includes(numberOf(x))));
        rows.forEach((r, i) => r.forEach((x, j) => {
          const w = numberOf(x);
          if (!Number.isFinite(w) || w === 0 || isInfinite(w)) return;
          addEdge(edges, String(i), String(j), binary ? undefined : w);
        }));
        return finishGraph(name, Array.from({ length: n }, (_, i) => ({ id: String(i), label: String(i) })), edges, binary ? "matrix" : "weight-matrix");
      }
      // adjacency list by index: [[1, 2], [0], …], vector<vector<pair<int,int>>>, List<List<Edge>>
      if (rows.every((r) => r) && rows.some((r) => r.length)) {
        const edges = [];
        let fits = true;
        rows.forEach((r, i) => r.forEach((x) => {
          const e = adjacencyEntry(x, heap);
          const j = e ? Number(e.to) : NaN;
          if (!(Number.isInteger(j) && j >= 0 && j < n)) { fits = false; return; }
          addEdge(edges, String(i), String(j), e.w);
        }));
        if (fits) return finishGraph(name, Array.from({ length: n }, (_, i) => ({ id: String(i), label: String(i) })), edges, "adjacency-list");
      }
      // list of node objects with neighbour lists (Node* / Node / node objects)
      if (sub.every((o) => o && field(o, NEIGHBOR_KEYS))) return objectGraph(name, sub.map((o) => ({ kind: "ref", id: o.id })), heap);
    }

    // a single node object whose neighbour/children list holds other node objects
    const nb = field(obj, NEIGHBOR_KEYS) || field(obj, CHILD_LIST_KEYS);
    const nbItems = isRef(nb) ? itemsOf(heap[nb.id]) : null;
    if (nbItems && nbItems.some((x) => isRef(x) && heap[x.id] && !itemsOf(heap[x.id]) && fieldsOf(heap[x.id]).length && !MAP_TYPE.test(heap[x.id].type))) {
      return objectGraph(name, [value], heap);
    }
    return null;
  }

  const isInfinite = (w) => !Number.isFinite(w) || Math.abs(w) >= 1e9 || w === 2147483647 || w === 9223372036854775807;

  function objectGraph(name, roots, heap) {
    const nodes = [], edges = [];
    const seen = new Set();
    const queue = [...roots];
    const isNode = (o) => o && !itemsOf(o) && fieldsOf(o).length;
    while (queue.length && seen.size < 80) {
      const ref = queue.shift();
      if (!isRef(ref) || seen.has(ref.id)) continue;
      seen.add(ref.id);
      const obj = heap[ref.id];
      if (!obj) continue;
      nodes.push({ id: "@" + obj.id, label: valueLabel(obj, heap), objId: obj.id });
      for (const key of [...NEIGHBOR_KEYS, ...CHILD_LIST_KEYS, ...NEXT_KEYS, ...LEFT_KEYS, ...RIGHT_KEYS]) {
        const v = field(obj, [key]);
        if (!v) continue;
        const targets = isRef(v) && itemsOf(heap[v.id]) ? itemsOf(heap[v.id]) : [v];
        for (const t of targets) {
          if (!isRef(t) || !heap[t.id]) continue;
          // same class as this node (Vertex → Vertex) is always a neighbour, even a leaf whose
          // fields are all plain values; other small records may be (node, weight) entries
          if (isNode(heap[t.id]) && (heap[t.id].type === obj.type || !tupleOf(t, heap))) { addEdge(edges, "@" + obj.id, "@" + t.id); queue.push(t); continue; }
          // (Node*, weight) pairs and Edge{node, w} records
          const tu = tupleOf(t, heap) || { items: fieldsOf(heap[t.id]).map(([, x]) => x) };
          const target = tu.items.find((x) => isRef(x) && isNode(heap[x.id]));
          if (target) {
            const w = tu.items.find((x) => !isRef(x) && Number.isFinite(numberOf(x)));
            addEdge(edges, "@" + obj.id, "@" + target.id, w ? numberOf(w) : undefined);
            queue.push(target);
          }
        }
      }
    }
    return finishGraph(name, nodes, edges, "objects");
  }

  const KIND_RANK = { "weighted-adjacency": 4, adjacency: 4, objects: 4, "weight-matrix": 3, matrix: 3, "adjacency-list": 3, "weighted-edges": 2, edges: 1 };
  const GRAPH_NAME_RE = /^(g|graph|adj|adjacency|net|network|edges|tree|neighbors|nbrs|links|roads|map)$/i;
  const GRAPH_FIELD_RE = /^(adj|adjacency|adjlist|adj_list|graph|g|edges|edge|edgelist|neighbors|neighbours|nbrs|links|matrix|mat|nodes|vertices)$/i;

  function detectAll(rawStep) {
    const step = normalise(rawStep);
    const heap = step?.heap || {};
    const vars = variables(step);
    const out = [];
    const used = new Set();
    const consider = (name, value) => {
      if (!isRef(value) || used.has(value.id)) return;
      const g = detectGraph(name, value, heap);
      if (g && g.nodes.length >= 2 && g.edges.length >= 1) { out.push(g); used.add(value.id); }
    };
    for (const v of vars) {
      consider(v.name, v.value);
      // graphs kept inside an object: Graph{adj}, this.adj in Java / C++ member functions
      const obj = isRef(v.value) ? heap[v.value.id] : null;
      if (obj && !itemsOf(obj) && !MAP_TYPE.test(obj.type)) {
        for (const [k, fv] of fieldsOf(obj)) if (GRAPH_FIELD_RE.test(k)) consider(`${v.name}.${k}`, fv);
      }
    }
    // A node-object graph reached from n0 already contains the ones reached from n1 or n0.adj.
    const objectGraphs = out.filter((g) => g.kind === "objects");
    for (const g of objectGraphs) {
      const ids = new Set(g.nodes.map((n) => n.id));
      const bigger = objectGraphs.find((o) => o !== g && o.nodes.length > g.nodes.length && [...ids].every((id) => o.nodes.some((n) => n.id === id)));
      if (bigger) out.splice(out.indexOf(g), 1);
    }
    // Most graph-like first: real adjacency structures and graph-ish names beat incidental pairs.
    const score = (g) => (KIND_RANK[g.kind] || 0) * 10 + (GRAPH_NAME_RE.test(g.name.split(".").pop()) ? 15 : 0) + Math.min(9, g.edges.length / 3);
    return out.sort((a, b) => score(b) - score(a));
  }

  const distText = (v) => {
    const n = numberOf(v);
    if (/^-?inf/i.test(primText(v)) || (Number.isFinite(n) && isInfinite(n))) return "∞";
    return primText(v);
  };

  /* Traversal state for a graph, read from the other variables of the step. */
  function traversal(rawStep, graph) {
    const step = normalise(rawStep);
    const heap = step?.heap || {};
    const ids = new Set(graph.nodes.map((n) => n.id));
    const state = { visited: new Set(), frontier: new Map(), current: new Map(), dist: new Map(), distName: "", parentEdges: new Set() };
    const markCurrent = (k, name) => state.current.set(k, [...(state.current.get(k) || []), name]);
    // a queue / stack / heap entry → the vertex it stands for: 3, (dist, 3), pair{dist, "B"}, int[]{d, v}, Node*
    const vertexOf = (x) => {
      if (!isRef(x)) return keyOf(x);
      if (graph.kind === "objects") return ids.has("@" + x.id) ? "@" + x.id : null;
      const t = tupleOf(x, heap);
      if (!t) return null;
      // (priority, vertex): the vertex is the named target or the last component
      const cand = t.dst ?? t.items.at(-1);
      return cand && !isRef(cand) ? keyOf(cand) : null;
    };
    const graphRoot = graph.name.split(".")[0];
    for (const { name, value } of variables(step)) {
      if (name === graph.name || (name === graphRoot && graph.name.includes("."))) continue;
      if (!isRef(value)) {
        const k = keyOf(value);
        if (k !== null && ids.has(k) && CURRENT_RE.test(name)) markCurrent(k, name);
        continue;
      }
      const obj = heap[value.id];
      if (!obj) continue;
      if (graph.kind === "objects" && !itemsOf(obj) && ids.has("@" + obj.id) && CURRENT_RE.test(name)) {
        markCurrent("@" + obj.id, name);
        continue;
      }
      // a pair/record variable naming a vertex: auto [d, u] = pq.top(); Edge e
      if (!itemsOf(obj) && CURRENT_RE.test(name)) {
        const k = vertexOf(value);
        if (k !== null && ids.has(k)) { markCurrent(k, name); continue; }
      }
      const items = itemsOf(obj);
      const fields = fieldsOf(obj);
      if (items) {
        const keys = items.map(vertexOf);
        const hits = keys.filter((k) => k !== null && ids.has(k));
        if (!hits.length || hits.length < keys.length * 0.5) {
          // arrays indexed by vertex: visited[], dist[], parent[]
          const prims = items.every((x) => !isRef(x));
          if (VISITED_RE.test(name) && prims && items.every((x) => typeof x.value === "boolean" || [0, 1].includes(numberOf(x)))) {
            items.forEach((x, i) => { if ((x.value === true || numberOf(x) === 1) && ids.has(String(i))) state.visited.add(String(i)); });
          } else if (DIST_RE.test(name) && prims && items.length >= graph.nodes.length * 0.8 && items.some((x, i) => ids.has(String(i)))) {
            state.dist.clear();
            items.forEach((x, i) => { if (ids.has(String(i))) state.dist.set(String(i), distText(x)); });
            state.distName = name;
          } else if (PARENT_RE.test(name) && prims) {
            items.forEach((x, i) => { const p = keyOf(x); if (p !== null && ids.has(p) && ids.has(String(i))) state.parentEdges.add(p + "\u0000" + String(i)); });
          }
          continue;
        }
        const isSet = /set/i.test(obj.type);
        if (VISITED_RE.test(name) || (isSet && !FRONTIER_RE.test(name))) hits.forEach((k) => state.visited.add(k));
        else if (FRONTIER_RE.test(name) || /deque|queue|stack|heap/i.test(obj.type)) {
          keys.forEach((k, i) => { if (k !== null && ids.has(k) && !state.frontier.has(k)) state.frontier.set(k, { name, order: i + 1 }); });
        }
      } else if (fields.length) {
        const entries = fields.filter(([k]) => ids.has(k));
        if (entries.length < fields.length * 0.5) continue;
        if (PARENT_RE.test(name)) {
          for (const [k, v] of entries) { const p = keyOf(v); if (p !== null && ids.has(p)) state.parentEdges.add(p + "\u0000" + k); }
        } else if (VISITED_RE.test(name)) {
          for (const [k, v] of entries) if (!isPrim(v) || v.value) state.visited.add(k);
        } else if (entries.every(([, v]) => !isRef(v))) {
          if (!state.distName || DIST_RE.test(name)) {
            state.dist.clear();
            for (const [k, v] of entries) state.dist.set(k, distText(v));
            state.distName = name;
          }
        }
      }
    }
    return state;
  }

  /* ------------------------------ layout ------------------------------ */

  const layoutCache = new Map(); // `${graph.name}:${mode}` -> Map(node id -> {x, y})

  function forceLayout(graph, mode, w, h) {
    const key = graph.name + ":" + mode;
    const known = layoutCache.get(key) || new Map();
    const nodes = graph.nodes.map((n, i) => {
      const prev = known.get(n.id);
      if (prev) return { id: n.id, x: prev.x, y: prev.y, fixed: prev.fixed };
      // new vertices: start on a circle (deterministic), or next to an already placed neighbour
      const e = graph.edges.find((ed) => (ed.from === n.id && known.has(ed.to)) || (ed.to === n.id && known.has(ed.from)));
      if (e) {
        const anchor = known.get(e.from === n.id ? e.to : e.from);
        return { id: n.id, x: anchor.x + 40 * Math.cos(i * 2.4), y: anchor.y + 40 * Math.sin(i * 2.4) };
      }
      const a = (i / graph.nodes.length) * Math.PI * 2 - Math.PI / 2;
      const r = Math.min(w, h) * 0.36;
      return { id: n.id, x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) };
    });
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const weights = graph.edges.map((e) => e.w).filter(Number.isFinite);
    const wMin = Math.min(...weights, 1), wMax = Math.max(...weights, 1);
    const ideal = Math.max(60, Math.min(140, Math.sqrt((w * h) / Math.max(1, nodes.length)) * 0.75));
    const iterations = known.size ? 60 : 260;
    for (let it = 0; it < iterations; it++) {
      const cool = 1 - it / iterations;
      const disp = nodes.map(() => [0, 0]);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        let d = Math.hypot(dx, dy) || 0.01;
        const f = (ideal * ideal) / d;
        dx /= d; dy /= d;
        disp[i][0] += dx * f; disp[i][1] += dy * f;
        disp[j][0] -= dx * f; disp[j][1] -= dy * f;
      }
      for (const e of graph.edges) {
        const a = index.get(e.from), b = index.get(e.to);
        if (a === undefined || b === undefined || a === b) continue;
        let dx = nodes[a].x - nodes[b].x, dy = nodes[a].y - nodes[b].y;
        const d = Math.hypot(dx, dy) || 0.01;
        // networks: heavier (larger) weights pull to longer edges
        const len = mode === "network" && Number.isFinite(e.w) && wMax > wMin ? ideal * (0.6 + 0.9 * (e.w - wMin) / (wMax - wMin)) : ideal;
        const f = ((d - len) / d) * 0.12;
        disp[a][0] -= dx * f * d * 0.1; disp[a][1] -= dy * f * d * 0.1;
        disp[b][0] += dx * f * d * 0.1; disp[b][1] += dy * f * d * 0.1;
      }
      nodes.forEach((n, i) => {
        if (n.fixed) return;
        // gentle pull to the centre keeps disconnected parts on screen
        disp[i][0] += (w / 2 - n.x) * 0.02;
        disp[i][1] += (h / 2 - n.y) * 0.02;
        const d = Math.hypot(...disp[i]) || 1;
        const lim = Math.min(d, 18 * cool + 1);
        n.x += (disp[i][0] / d) * lim;
        n.y += (disp[i][1] / d) * lim;
      });
    }
    const out = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, fixed: n.fixed }]));
    layoutCache.set(key, out);
    return out;
  }

  /* ------------------------------ drawing helpers ------------------------------ */

  function palette() {
    const dark = document.documentElement.dataset.ideTheme === "dark";
    const css = getComputedStyle(document.body);
    return {
      dark,
      bg: css.getPropertyValue("--panel").trim() || (dark ? "#191917" : "#fff"),
      text: dark ? "#ece9e1" : "#22211e",
      soft: dark ? "#9b978d" : "#6b6860",
      line: dark ? "rgba(255,255,255,.16)" : "rgba(20,20,19,.16)",
      box: dark ? "#23221f" : "#f7f5f0",
      head: dark ? "#2d2b27" : "#ebe7df",
      accent: css.getPropertyValue("--accent").trim() || "#4f46e5",
      edge: dark ? "#8b8f99" : "#6b7280",
      visited: dark ? "#065f46" : "#bbf7d0",
      visitedInk: dark ? "#6ee7b7" : "#047857",
      frontier: "#f59e0b",
      current: "#e11d48",
      changed: "#f97316",
      pointer: dark ? "#93c5fd" : "#2563eb",
      tree: "#16a34a",
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function arrowHead(ctx, x, y, angle, size = 7) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(angle - 0.42), y - size * Math.sin(angle - 0.42));
    ctx.lineTo(x - size * Math.cos(angle + 0.42), y - size * Math.sin(angle + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  const clip = (s, n = 14) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  /* pair / tuple / Map.Entry values are shown inside their cell as (a, b) instead of as a box. */
  const INLINE_TYPE = /^(pair|tuple)(<|$)|^tuple$|Entry$|^Pair(<|$)/;
  function inlineText(v, heap) {
    if (!isRef(v)) return null;
    const o = heap[v.id];
    if (!o || !INLINE_TYPE.test(o.type || "")) return null;
    const parts = itemsOf(o) || fieldsOf(o).map(([, x]) => x);
    if (parts.length > 4 || parts.some((x) => isRef(x))) return null;
    return "(" + parts.map((x) => primText(x)).join(", ") + ")";
  }

  /* queue<int, deque<int>> → queue<int>; very long template names are clipped. */
  function displayType(type) {
    let t = String(type || "");
    const m = /^(queue|stack|priority_queue)<(.+)>$/.exec(t);
    if (m) {
      let depth = 0, cut = m[2].length;
      for (let i = 0; i < m[2].length; i++) {
        const c = m[2][i];
        if (c === "<") depth++;
        else if (c === ">") depth--;
        else if (c === "," && depth === 0) { cut = i; break; }
      }
      t = `${m[1]}<${m[2].slice(0, cut).trim()}>`;
    }
    return t.length > 34 ? t.slice(0, 33) + "…" : t;
  }

  /* ------------------------------ view ------------------------------ */

  class View {
    constructor(canvas, onPick) {
      this.canvas = canvas;
      this.onPick = onPick;
      this.mode = "structure";
      this.target = null;
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.step = null;
      this.prev = null;
      this.hit = [];
      canvas.addEventListener("pointerdown", (e) => this.down(e));
      canvas.addEventListener("pointermove", (e) => this.move(e));
      canvas.addEventListener("pointerup", () => this.up());
      canvas.addEventListener("pointercancel", () => this.up());
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const p = this.local(e);
        const f = Math.exp(-e.deltaY * 0.0015);
        const next = Math.min(3, Math.max(0.3, this.zoom * f));
        this.pan.x = p.x - (p.x - this.pan.x) * (next / this.zoom);
        this.pan.y = p.y - (p.y - this.pan.y) * (next / this.zoom);
        this.zoom = next;
        this.draw();
      }, { passive: false });
      canvas.addEventListener("dblclick", () => { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.draw(); });
      new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    }

    /* CSS-pixel pointer position → world (pre-zoom) coordinates. */
    local(e) {
      const box = this.canvas.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    }
    fitScale() { return this.mode === "structure" ? this.autoFit || 1 : 1; }
    world(p) { const s = this.zoom * this.fitScale(); return { x: (p.x - this.pan.x) / s, y: (p.y - this.pan.y) / s }; }

    down(e) {
      this.canvas.setPointerCapture(e.pointerId);
      const p = this.local(e);
      const w = this.world(p);
      const node = this.hit.find((h) => h.type === "node" && Math.hypot(h.x - w.x, h.y - w.y) <= h.r + 3);
      if (node && this.positions) {
        this.drag = { node, dx: w.x - node.x, dy: w.y - node.y };
      } else {
        this.drag = { pan: true, x: p.x, y: p.y, px: this.pan.x, py: this.pan.y };
      }
    }
    move(e) {
      const p = this.local(e);
      if (!this.drag) {
        const w = this.world(p);
        const over = this.hit.find((h) => (h.type === "node" ? Math.hypot(h.x - w.x, h.y - w.y) <= h.r + 3 : w.x >= h.x && w.x <= h.x + h.w && w.y >= h.y && w.y <= h.y + h.h));
        this.canvas.style.cursor = over ? (over.type === "node" ? "grab" : "pointer") : "default";
        if ((over?.key || null) !== (this.hover || null)) { this.hover = over?.key || null; this.draw(); }
        return;
      }
      if (this.drag.pan) {
        this.pan.x = this.drag.px + p.x - this.drag.x;
        this.pan.y = this.drag.py + p.y - this.drag.y;
      } else {
        const w = this.world(p);
        const pos = this.positions.get(this.drag.node.id);
        const F = this.fitFrame || { sc: 1, ox: 0, oy: 0 };
        if (pos) { pos.x = (w.x - this.drag.dx - F.ox) / F.sc; pos.y = (w.y - this.drag.dy - F.oy) / F.sc; pos.fixed = true; }
      }
      this.draw();
    }
    up() { this.drag = null; }

    set(step, prev) {
      this.step = normalise(step);
      this.prev = normalise(prev);
      this.draw();
    }

    candidates() { return this.step ? detectAll(this.step) : []; }

    draw() {
      const canvas = this.canvas;
      if (!canvas.isConnected || canvas.offsetParent === null) return;
      const box = canvas.getBoundingClientRect();
      const w = Math.max(1, box.width), h = Math.max(1, box.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      const pal = palette();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);
      this.hit = [];
      this.positions = null;
      if (!this.step) return;
      ctx.save();
      ctx.translate(this.pan.x, this.pan.y);
      const fit = this.fitScale();
      ctx.scale(this.zoom * fit, this.zoom * fit);
      let message = "";
      if (this.mode === "structure") {
        message = this.drawStructure(ctx, pal, w, h);
        // Shrink big structures to fit the canvas (the user can still zoom in with the wheel).
        const ext = this.extent;
        if (ext) {
          const next = Math.max(0.35, Math.min(1, (w - 8) / ext.w, (h - 8) / ext.h));
          if (Math.abs(next - (this.autoFit || 1)) > 0.02) { this.autoFit = next; requestAnimationFrame(() => this.draw()); }
        }
      }
      else {
        const graphs = this.candidates();
        const graph = graphs.find((g) => g.name === this.target) || graphs[0];
        if (!graph) message = "그래프로 볼 수 있는 변수가 없습니다. dict→list 인접 리스트, 리스트의 리스트, 0/1 인접 행렬, (u, v[, w]) 간선 목록, neighbors 필드를 가진 노드 객체를 인식합니다.";
        else this.drawGraph(ctx, pal, w / this.zoom, h / this.zoom, graph);
      }
      ctx.restore();
      if (message) {
        ctx.fillStyle = pal.soft;
        ctx.font = "12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        wrapText(ctx, message, w / 2, h / 2, w - 40, 17);
      }
    }

    /* ---------------- boxes and pointers ---------------- */

    drawStructure(ctx, pal, w, h) {
      const step = this.step;
      const heap = step.heap || {};
      const prevHeap = this.prev?.heap || {};
      const vars = variables(step);
      if (!vars.length) return "표시할 변수가 없습니다.";
      ctx.font = "12px ui-monospace, Menlo, monospace";
      const measure = (s) => ctx.measureText(s).width;
      const prevVars = new Map(variables(this.prev || {}).map((v) => [v.name, v.value]));
      const changedPrim = (name, value) => prevVars.has(name) && primText(prevVars.get(name)) !== primText(value) && !isRef(value);

      // ----- variable column -----
      const rowH = 24, pad = 14;
      const nameW = Math.max(40, ...vars.map((v) => measure(v.name))) + 14;
      const valW = Math.max(46, ...vars.map((v) => (isRef(v.value) ? 22 : Math.min(150, measure(clip(primText(v.value), 18)) + 14))));
      const anchors = []; // [{from:{x,y}, id, changed}]
      let y = pad + 16;
      ctx.fillStyle = pal.soft;
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("변수", pad, pad + 6);
      ctx.font = "12px ui-monospace, Menlo, monospace";
      for (const v of vars) {
        const changed = changedPrim(v.name, v.value) || (isRef(v.value) && prevVars.has(v.name) && prevVars.get(v.name)?.id !== v.value.id);
        ctx.fillStyle = pal.box;
        roundRect(ctx, pad, y, nameW + valW, rowH - 4, 5);
        ctx.fill();
        ctx.strokeStyle = changed ? pal.changed : pal.line;
        ctx.lineWidth = changed ? 1.8 : 1;
        ctx.stroke();
        ctx.fillStyle = pal.text;
        ctx.textBaseline = "middle";
        ctx.fillText(clip(v.name, 16), pad + 7, y + (rowH - 4) / 2);
        ctx.strokeStyle = pal.line;
        ctx.beginPath();
        ctx.moveTo(pad + nameW, y);
        ctx.lineTo(pad + nameW, y + rowH - 4);
        ctx.stroke();
        if (isRef(v.value)) {
          const cx = pad + nameW + valW / 2, cy = y + (rowH - 4) / 2;
          ctx.fillStyle = pal.pointer;
          ctx.beginPath();
          ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
          ctx.fill();
          anchors.push({ x: cx, y: cy, id: v.value.id, changed });
        } else {
          ctx.fillStyle = changed ? pal.changed : pal.text;
          ctx.fillText(clip(primText(v.value), 18), pad + nameW + 7, y + (rowH - 4) / 2);
        }
        y += rowH;
      }

      // ----- heap objects reachable from the variables -----
      const placed = new Map(); // id -> {x, y, w, h, cells: Map(index -> {x,y})}
      let colX = pad + nameW + valW + 60;
      let cursorY = pad + 16;
      const objW = (obj) => this.objectSize(ctx, obj, heap).w;

      const place = (id, x, yTop) => {
        const obj = heap[id];
        if (!obj || placed.has(id)) return null;
        const size = this.objectSize(ctx, obj, heap);
        placed.set(id, { x, y: yTop, ...size, obj });
        return placed.get(id);
      };

      // linked lists: follow next pointers in a row; binary trees: tree layout
      const chainFrom = (id) => {
        const chain = [];
        const seen = new Set();
        let cur = id;
        while (cur && heap[cur] && !seen.has(cur) && chain.length < 30) {
          seen.add(cur);
          chain.push(cur);
          const nxt = field(heap[cur], NEXT_KEYS);
          cur = isRef(nxt) ? nxt.id : null;
        }
        return chain;
      };
      const isTree = (obj) => obj && (field(obj, LEFT_KEYS) !== undefined || field(obj, RIGHT_KEYS) !== undefined) && !itemsOf(obj);
      const treeLayout = (id, x0, y0) => {
        // in-order index gives x, depth gives y
        let order = 0;
        const nodes = [];
        const walk = (nid, depth, seen) => {
          if (!nid || !heap[nid] || seen.has(nid) || nodes.length > 63) return;
          seen.add(nid);
          const obj = heap[nid];
          const l = field(obj, LEFT_KEYS), r = field(obj, RIGHT_KEYS);
          if (isRef(l)) walk(l.id, depth + 1, seen);
          nodes.push({ id: nid, order: order++, depth });
          if (isRef(r)) walk(r.id, depth + 1, seen);
        };
        walk(id, 0, new Set());
        let maxY = y0;
        for (const n of nodes) {
          const obj = heap[n.id];
          const size = { w: 46, h: 34, compact: true };
          const box = { x: x0 + n.order * 52, y: y0 + n.depth * 64, ...size, obj, tree: true };
          if (!placed.has(n.id)) placed.set(n.id, box);
          maxY = Math.max(maxY, box.y + box.h);
        }
        return { h: maxY - y0, w: nodes.length * 52 };
      };

      const roots = anchors.map((a) => a.id);
      for (const id of roots) {
        if (placed.has(id) || !heap[id]) continue;
        const obj = heap[id];
        if (isTree(obj)) {
          const size = treeLayout(id, colX, cursorY);
          cursorY += size.h + 28;
          continue;
        }
        if (field(obj, NEXT_KEYS) !== undefined && !itemsOf(obj)) {
          let x = colX, rowHeight = 0;
          for (const nid of chainFrom(id)) {
            const b = place(nid, x, cursorY);
            if (!b) continue;
            b.chain = true;
            x += b.w + 34;
            rowHeight = Math.max(rowHeight, b.h);
          }
          cursorY += rowHeight + 28;
          continue;
        }
        // generic: breadth-first, children to the right of their parent
        const levels = [[id]];
        const seen = new Set([id]);
        for (let d = 0; d < 6 && levels[d].length; d++) {
          const nextLevel = [];
          for (const oid of levels[d]) {
            for (const child of this.childRefs(heap[oid], heap)) {
              if (!seen.has(child) && !placed.has(child) && heap[child]) { seen.add(child); nextLevel.push(child); }
            }
          }
          levels.push(nextLevel);
        }
        let x = colX, blockH = 0;
        for (const level of levels) {
          if (!level.length) continue;
          let yy = cursorY, levelW = 0;
          for (const oid of level) {
            const b = place(oid, x, yy);
            if (!b) continue;
            yy += b.h + 14;
            levelW = Math.max(levelW, b.w);
          }
          blockH = Math.max(blockH, yy - cursorY);
          x += levelW + 46;
        }
        cursorY += blockH + 16;
      }

      let maxX = pad + nameW + valW, maxY = y;
      for (const b of placed.values()) { maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
      this.extent = { w: maxX + pad, h: maxY + pad };

      // ----- draw objects, then pointers on top -----
      const pointers = [];
      for (const [id, b] of placed) this.drawObject(ctx, pal, b, heap, prevHeap, pointers, id);
      ctx.lineWidth = 1.5;
      for (const a of anchors) this.pointer(ctx, pal, a, placed.get(a.id), a.changed);
      for (const p of pointers) this.pointer(ctx, pal, p, placed.get(p.id), p.changed, p.treeEdge);
      if (!placed.size && !anchors.length) return "";
      void w; void h; void objW;
      return "";
    }

    childRefs(obj, heap) {
      const out = [];
      for (const v of itemsOf(obj) || []) if (isRef(v) && !inlineText(v, heap)) out.push(v.id);
      for (const [, v] of fieldsOf(obj)) if (isRef(v) && !inlineText(v, heap)) out.push(v.id);
      return out;
    }

    objectSize(ctx, obj, heap) {
      ctx.font = "12px ui-monospace, Menlo, monospace";
      const items = itemsOf(obj);
      if (items) {
        const text = (v) => inlineText(v, heap) ?? primText(v);
        const cellW = items.map((v) => (isRef(v) && !inlineText(v, heap) ? 24 : Math.min(130, Math.max(24, ctx.measureText(clip(text(v), 16)).width + 12))));
        const head = ctx.measureText(`${displayType(obj.type)} #${obj.id.replace("obj_", "")}`).width + 16;
        return { w: Math.max(head, cellW.reduce((s, x) => s + x, 0) + (obj.truncated ? 22 : 0)), h: 46, cellW };
      }
      const fields = fieldsOf(obj);
      const keyW = Math.max(24, ...fields.map(([k]) => ctx.measureText(clip(k, 14)).width + 12));
      const valW = Math.max(24, ...fields.map(([, v]) => (isRef(v) && !inlineText(v, heap) ? 24 : Math.min(130, ctx.measureText(clip(inlineText(v, heap) ?? primText(v), 16)).width + 12))));
      const head = ctx.measureText(`${displayType(obj.type)} #${obj.id.replace("obj_", "")}`).width + 16;
      return { w: Math.max(head, keyW + valW), h: 20 + Math.max(1, fields.length) * 20 + (obj.truncated ? 14 : 0), keyW, valW };
    }

    drawObject(ctx, pal, b, heap, prevHeap, pointers, id) {
      const obj = b.obj;
      const prev = prevHeap[id];
      const isNew = Boolean(this.prev) && !prev; // only flag objects created since the previous step
      const hoverKey = "obj:" + id;
      this.hit.push({ type: "obj", key: hoverKey, x: b.x, y: b.y, w: b.w, h: b.h, id });
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      if (b.tree) {
        // compact tree node: value in a circle, children below
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        ctx.fillStyle = pal.box;
        ctx.strokeStyle = isNew ? pal.changed : this.hover === hoverKey ? pal.accent : pal.tree;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = pal.text;
        ctx.textAlign = "center";
        ctx.fillText(clip(valueLabel(obj, heap), 5), cx, cy);
        for (const keys of [LEFT_KEYS, RIGHT_KEYS]) {
          const v = field(obj, keys);
          if (isRef(v)) pointers.push({ x: cx + (keys === LEFT_KEYS ? -8 : 8), y: cy + 12, id: v.id, treeEdge: true });
        }
        return;
      }
      ctx.fillStyle = pal.box;
      roundRect(ctx, b.x, b.y, b.w, b.h, 6);
      ctx.fill();
      ctx.strokeStyle = isNew ? pal.changed : this.hover === hoverKey ? pal.accent : pal.line;
      ctx.lineWidth = isNew || this.hover === hoverKey ? 1.8 : 1;
      ctx.stroke();
      ctx.fillStyle = pal.head;
      roundRect(ctx, b.x, b.y, b.w, 18, 6);
      ctx.fill();
      ctx.fillStyle = pal.soft;
      ctx.font = "600 10.5px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${displayType(obj.type)} #${id.replace("obj_", "")}`, b.x + 7, b.y + 9.5);
      ctx.font = "12px ui-monospace, Menlo, monospace";
      const items = itemsOf(obj);
      if (items) {
        let x = b.x;
        const prevItems = prev ? itemsOf(prev) || [] : [];
        items.forEach((v, i) => {
          const cw = b.cellW[i];
          const changed = prev && primText(prevItems[i]) !== primText(v) && !(isRef(v) && isRef(prevItems[i]) && v.id === prevItems[i].id);
          if (i) {
            ctx.strokeStyle = pal.line;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, b.y + 18);
            ctx.lineTo(x, b.y + b.h);
            ctx.stroke();
          }
          if (changed) {
            ctx.fillStyle = pal.changed + "33";
            ctx.fillRect(x + 1, b.y + 19, cw - 2, b.h - 20);
          }
          ctx.fillStyle = pal.soft;
          ctx.font = "9.5px ui-monospace, Menlo, monospace";
          ctx.textAlign = "center";
          if (!/set/i.test(obj.type)) ctx.fillText(String(i), x + cw / 2, b.y + b.h - 7);
          ctx.font = "12px ui-monospace, Menlo, monospace";
          const inline = inlineText(v, heap);
          if (isRef(v) && !inline) {
            ctx.fillStyle = pal.pointer;
            ctx.beginPath();
            ctx.arc(x + cw / 2, b.y + 28, 3.5, 0, Math.PI * 2);
            ctx.fill();
            pointers.push({ x: x + cw / 2, y: b.y + 28, id: v.id, changed });
          } else {
            const changedInline = inline && prevItems[i] && inlineText(prevItems[i], this.prev?.heap || {}) !== inline;
            ctx.fillStyle = changed && (!inline || changedInline) ? pal.changed : pal.text;
            ctx.fillText(clip(inline ?? primText(v), 16), x + cw / 2, b.y + 29);
          }
          x += cw;
        });
        if (obj.truncated) { ctx.fillStyle = pal.soft; ctx.fillText("…", x + 11, b.y + 29); }
        return;
      }
      const fields = fieldsOf(obj);
      const prevFields = new Map(fieldsOf(prev));
      fields.forEach(([k, v], i) => {
        const ry = b.y + 20 + i * 20;
        const changed = prev && (primText(prevFields.get(k)) !== primText(v)) && !(isRef(v) && prevFields.get(k)?.id === v.id);
        if (changed) { ctx.fillStyle = pal.changed + "33"; ctx.fillRect(b.x + 1, ry, b.w - 2, 20); }
        ctx.fillStyle = pal.soft;
        ctx.textAlign = "left";
        ctx.fillText(clip(k, 14), b.x + 7, ry + 10);
        ctx.strokeStyle = pal.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x + b.keyW, ry + 2);
        ctx.lineTo(b.x + b.keyW, ry + 18);
        ctx.stroke();
        const inline = inlineText(v, heap);
        if (isRef(v) && !inline) {
          ctx.fillStyle = pal.pointer;
          ctx.beginPath();
          ctx.arc(b.x + b.keyW + 12, ry + 10, 3.5, 0, Math.PI * 2);
          ctx.fill();
          pointers.push({ x: b.x + b.keyW + 12, y: ry + 10, id: v.id, changed });
        } else {
          ctx.fillStyle = changed && !inline ? pal.changed : isNullish(v) ? pal.soft : pal.text;
          ctx.fillText(clip(inline ?? primText(v), 16), b.x + b.keyW + 6, ry + 10);
        }
      });
      if (obj.truncated) { ctx.fillStyle = pal.soft; ctx.fillText("…", b.x + 7, b.y + b.h - 8); }
    }

    pointer(ctx, pal, from, box, changed, treeEdge = false) {
      if (!box) return;
      let tx, ty;
      if (box.tree) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        const ang = Math.atan2(cy - from.y, cx - from.x);
        tx = cx - 17 * Math.cos(ang); ty = cy - 17 * Math.sin(ang);
      } else if (box.x > from.x + 8) { tx = box.x; ty = box.y + 9; }
      else if (box.y > from.y) { tx = box.x + Math.min(box.w / 2, 18); ty = box.y; }
      else { tx = box.x + Math.min(box.w / 2, 18); ty = box.y + box.h; }
      ctx.strokeStyle = changed ? pal.changed : treeEdge ? pal.tree : pal.pointer;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = changed ? 2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      let angle;
      if (treeEdge) {
        ctx.lineTo(tx, ty);
        angle = Math.atan2(ty - from.y, tx - from.x);
      } else {
        const mx = (from.x + tx) / 2;
        const c1 = { x: Math.max(from.x + 30, mx), y: from.y }, c2 = { x: tx - 30, y: ty };
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tx, ty);
        angle = Math.atan2(ty - c2.y, tx - c2.x);
      }
      ctx.stroke();
      arrowHead(ctx, tx, ty, angle, 7);
    }

    /* ---------------- graph & network ---------------- */

    drawGraph(ctx, pal, w, h, graph) {
      const network = this.mode === "network";
      const state = traversal(this.step, graph);
      const layout = forceLayout(graph, this.mode, w, h);
      this.positions = layout;
      // Fit the layout into the canvas below the legend; keep the fit fixed while a vertex is dragged.
      const TOP = 74, PAD = 34;
      if (!this.drag || !this.fitFrame) {
        const pts = [...layout.values()];
        const minX = Math.min(...pts.map((q) => q.x)), maxX = Math.max(...pts.map((q) => q.x));
        const minY = Math.min(...pts.map((q) => q.y)), maxY = Math.max(...pts.map((q) => q.y));
        const sc = Math.min(1.4, (w - 2 * PAD) / Math.max(1, maxX - minX), (h - TOP - PAD) / Math.max(1, maxY - minY));
        this.fitFrame = { sc, ox: (w - (maxX - minX) * sc) / 2 - minX * sc, oy: TOP + (h - TOP - PAD - (maxY - minY) * sc) / 2 - minY * sc };
      }
      const F = this.fitFrame;
      const positions = new Map([...layout].map(([id, q]) => [id, { x: F.ox + q.x * F.sc, y: F.oy + q.y * F.sc }]));
      const degree = new Map(graph.nodes.map((n) => [n.id, 0]));
      for (const e of graph.edges) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
      const maxDeg = Math.max(1, ...degree.values());
      const weights = graph.edges.map((e) => e.w).filter(Number.isFinite);
      const wMin = Math.min(...weights, 0), wMax = Math.max(...weights, 1);
      const radius = (id) => (network ? 13 + 9 * (degree.get(id) || 0) / maxDeg : 17);

      // edges
      ctx.font = "11px ui-monospace, Menlo, monospace";
      for (const e of graph.edges) {
        const a = positions.get(e.from), b = positions.get(e.to);
        if (!a || !b) continue;
        const onTree = state.parentEdges.has(e.from + "\u0000" + e.to) || (!graph.directed && state.parentEdges.has(e.to + "\u0000" + e.from));
        const width = network && Number.isFinite(e.w) && wMax > wMin ? 1.2 + 4 * (e.w - wMin) / (wMax - wMin) : onTree ? 3 : 1.6;
        ctx.strokeStyle = onTree ? pal.tree : pal.edge;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = width;
        if (e.from === e.to) {
          ctx.beginPath();
          ctx.arc(a.x, a.y - radius(e.from) - 8, 9, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        // two directed edges between the same pair bend apart
        const twin = graph.directed && graph.edges.some((o) => o.from === e.to && o.to === e.from);
        const bend = twin ? 18 : 0;
        const mx = (a.x + b.x) / 2 - Math.sin(ang) * bend, my = (a.y + b.y) / 2 + Math.cos(ang) * bend;
        const rb = radius(e.to);
        const endAng = Math.atan2(b.y - my, b.x - mx);
        const ex = b.x - Math.cos(endAng) * (rb + 2), ey = b.y - Math.sin(endAng) * (rb + 2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, ex, ey);
        ctx.stroke();
        if (graph.directed) arrowHead(ctx, ex, ey, endAng, 8 + width);
        if (Number.isFinite(e.w) && (graph.weighted || network)) {
          const label = String(+e.w.toPrecision(4));
          const tw = ctx.measureText(label).width + 8;
          const lx = (a.x + 2 * mx + b.x) / 4, ly = (a.y + 2 * my + b.y) / 4;
          ctx.fillStyle = pal.bg;
          roundRect(ctx, lx - tw / 2, ly - 8, tw, 16, 4);
          ctx.fill();
          ctx.strokeStyle = pal.line;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = pal.text;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, lx, ly);
        }
      }

      // vertices
      for (const n of graph.nodes) {
        const p = positions.get(n.id);
        if (!p) continue;
        const r = radius(n.id);
        const visited = state.visited.has(n.id);
        const frontier = state.frontier.get(n.id);
        const current = state.current.get(n.id);
        this.hit.push({ type: "node", key: "node:" + n.id, id: n.id, x: p.x, y: p.y, r });
        ctx.fillStyle = visited ? pal.visited : pal.box;
        ctx.strokeStyle = current ? pal.current : frontier ? pal.frontier : this.hover === "node:" + n.id ? pal.accent : pal.edge;
        ctx.lineWidth = current ? 3.2 : frontier ? 2.6 : 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = visited ? pal.visitedInk : pal.text;
        ctx.font = "600 12px ui-monospace, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(clip(String(n.label), 6), p.x, p.y);
        ctx.font = "10.5px ui-monospace, Menlo, monospace";
        if (current) {
          ctx.fillStyle = pal.current;
          ctx.fillText(current.join(", "), p.x, p.y - r - 9);
        }
        if (frontier) {
          ctx.fillStyle = pal.frontier;
          ctx.fillText(`${frontier.name}[${frontier.order - 1}]`, p.x + r + 4 + ctx.measureText(`${frontier.name}[${frontier.order - 1}]`).width / 2, p.y - r + 2);
        }
        if (state.dist.has(n.id)) {
          const label = `${state.distName}=${clip(state.dist.get(n.id), 8)}`;
          ctx.fillStyle = pal.accent;
          ctx.fillText(label, p.x, p.y + r + 10);
        }
      }

      // legend
      const items = [];
      items.push(`${graph.name} · ${{ adjacency: "인접 리스트(dict)", "weighted-adjacency": "가중치 인접(dict)", edges: "간선 목록", "weighted-edges": "가중치 간선 목록", matrix: "인접 행렬", "weight-matrix": "가중치 행렬", "adjacency-list": "인접 리스트", objects: "노드 객체" }[graph.kind] || graph.kind} · 정점 ${graph.nodes.length} · 간선 ${graph.edges.length}${graph.directed ? " · 방향" : " · 무방향"}`);
      ctx.save();
      ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = pal.soft;
      ctx.fillText(items[0], 10, 8);
      const legend = [];
      if (state.visited.size) legend.push([pal.visited, "방문함", "fill"]);
      if (state.frontier.size) legend.push([pal.frontier, [...new Set([...state.frontier.values()].map((f) => f.name))].join("/") + "에 있음", "ring"]);
      if (state.current.size) legend.push([pal.current, "현재 정점", "ring"]);
      if (state.parentEdges.size) legend.push([pal.tree, "탐색 트리 간선", "line"]);
      let lx = 10;
      for (const [color, text, kind] of legend) {
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        if (kind === "fill") { ctx.beginPath(); ctx.arc(lx + 5, 30, 5, 0, Math.PI * 2); ctx.fill(); }
        else if (kind === "ring") { ctx.beginPath(); ctx.arc(lx + 5, 30, 5, 0, Math.PI * 2); ctx.stroke(); }
        else { ctx.beginPath(); ctx.moveTo(lx, 30); ctx.lineTo(lx + 12, 30); ctx.stroke(); }
        ctx.fillStyle = pal.soft;
        ctx.fillText(text, lx + 15, 24);
        lx += 22 + ctx.measureText(text).width;
      }
      ctx.restore();
    }
  }

  function wrapText(ctx, text, x, y, maxW, lineH) {
    const words = text.split(" ");
    const lines = [];
    let cur = "";
    for (const word of words) {
      const next = cur ? cur + " " + word : word;
      if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    lines.forEach((l, i) => ctx.fillText(l, x, y + (i - (lines.length - 1) / 2) * lineH));
  }

  return { View, detectAll, traversal, variables };
})();
