import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";

const palette = ["#2E4C6D", "#3B6E5C", "#8E5238", "#5B4A8A", "#8A6D2F", "#386882", "#7C455C"];

function isDarkTheme() {
  return document.documentElement.dataset.ideTheme === "dark";
}

function classifyProofNode(node, rootId) {
  if (node.id === rootId) return "root";
  if (node.kind === "axiom" || String(node.id).startsWith("axiom:")) return "axiom";
  if (String(node.id).startsWith("external:")) return "external";
  return "theorem";
}

function buildAdjacency(nodes, links) {
  const outgoing = new Map(nodes.map((n) => [n.id, new Set()]));
  const incoming = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const { source, target } of links) {
    outgoing.get(source.id)?.add(target.id);
    incoming.get(target.id)?.add(source.id);
  }
  return { outgoing, incoming };
}

function computeChain(focusId, outgoing, incoming) {
  const activeNodes = new Set();
  const activeEdges = new Set();
  if (!focusId) return { activeNodes, activeEdges };
  activeNodes.add(focusId);

  const downQueue = [focusId];
  while (downQueue.length) {
    const cur = downQueue.shift();
    for (const dep of outgoing.get(cur) || []) {
      activeEdges.add(`${cur}->${dep}`);
      if (!activeNodes.has(dep)) {
        activeNodes.add(dep);
        downQueue.push(dep);
      }
    }
  }

  const upQueue = [focusId];
  while (upQueue.length) {
    const cur = upQueue.shift();
    for (const parent of incoming.get(cur) || []) {
      activeEdges.add(`${parent}->${cur}`);
      if (!activeNodes.has(parent)) {
        activeNodes.add(parent);
        upQueue.push(parent);
      }
    }
  }
  return { activeNodes, activeEdges };
}

function prepareProofNodes(data) {
  const nodes = (data.nodes || []).map((node) => ({ ...node, degree: 0 }));
  const index = new Map(nodes.map((node) => [node.id, node]));
  const links = (data.edges || []).flatMap(({ from, to }) =>
    index.has(from) && index.has(to) ? [{ source: index.get(from), target: index.get(to) }] : []
  );
  const { outgoing, incoming } = buildAdjacency(nodes, links);

  for (const { source, target } of links) {
    source.degree++;
    target.degree++;
  }

  const root = index.get(data.root);
  if (root) {
    root.group = -1;
    let g = 0;
    for (const depId of outgoing.get(root.id) || []) {
      const child = index.get(depId);
      if (child && child.group === undefined) child.group = g++;
    }
  }

  for (const node of nodes) {
    node.role = classifyProofNode(node, data.root);
    node.inDeg = (incoming.get(node.id) || new Set()).size;
    node.outDeg = (outgoing.get(node.id) || new Set()).size;
    const labelLen = Math.min(24, Math.max(10, (node.name || "").length));
    node.cardW = Math.round(Math.max(148, Math.min(228, 72 + labelLen * 6.4)));
    node.cardH = 46;
    node.radius = Math.max(node.cardW / 2, node.cardH / 2) * 0.52;
    node.color =
      node.role === "root"
        ? "#141413"
        : node.role === "axiom"
          ? "#9A6724"
          : node.role === "external"
            ? "#6B6860"
            : palette[Math.max(0, node.group ?? 0) % palette.length];
  }

  return { nodes, links, index, outgoing, incoming };
}

function dagLayout(data) {
  const { nodes, links, index, outgoing, incoming } = prepareProofNodes(data);
  if (!nodes.length) return { nodes, links, outgoing, incoming };

  const levelMap = new Map();
  const rootId = data.root && index.has(data.root) ? data.root : nodes[0].id;
  levelMap.set(rootId, 0);

  // Longest-path DAG layering from root, keeping axioms at the foundation tier
  for (let pass = 0; pass < nodes.length + 2; pass++) {
    let changed = false;
    for (const { source, target } of links) {
      const sl = levelMap.get(source.id);
      if (sl !== undefined) {
        const nextL = sl + 1;
        if (levelMap.get(target.id) === undefined || nextL > levelMap.get(target.id)) {
          levelMap.set(target.id, nextL);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  let maxTheoremLevel = 0;
  for (const node of nodes) {
    const lvl = levelMap.get(node.id) ?? node.depth ?? 1;
    levelMap.set(node.id, lvl);
    if (node.role !== "axiom" && lvl > maxTheoremLevel) {
      maxTheoremLevel = lvl;
    }
  }
  for (const node of nodes) {
    if (node.role === "axiom") {
      levelMap.set(node.id, Math.max(levelMap.get(node.id) || 1, maxTheoremLevel + 1));
    }
  }

  const layers = new Map();
  for (const node of nodes) {
    const lvl = levelMap.get(node.id) || 0;
    node.layer = lvl;
    if (!layers.has(lvl)) layers.set(lvl, []);
    layers.get(lvl).push(node);
  }

  const sortedLevels = [...layers.keys()].sort((a, b) => a - b);
  const gapX = 34;
  const gapY = 104;

  // Initial x assignment
  for (const lvl of sortedLevels) {
    const list = layers.get(lvl);
    list.sort((a, b) => (b.degree - a.degree) || String(a.name).localeCompare(String(b.name)));
    const totalW = list.reduce((acc, n) => acc + n.cardW, 0) + gapX * Math.max(0, list.length - 1);
    let cursor = -totalW / 2;
    for (const n of list) {
      n.x = cursor + n.cardW / 2;
      n.y = lvl * gapY;
      cursor += n.cardW + gapX;
    }
  }

  // Barycenter ordering sweep to minimize crossings
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const lvl of sortedLevels.slice(1)) {
      const list = layers.get(lvl);
      list.sort((a, b) => {
        const avgX = (n) => {
          const parents = [...(incoming.get(n.id) || [])].map((id) => index.get(id)).filter(Boolean);
          if (!parents.length) return n.x;
          return parents.reduce((s, p) => s + p.x, 0) / parents.length;
        };
        return avgX(a) - avgX(b);
      });
      const totalW = list.reduce((acc, n) => acc + n.cardW, 0) + gapX * Math.max(0, list.length - 1);
      let cursor = -totalW / 2;
      for (const n of list) {
        n.x = cursor + n.cardW / 2;
        cursor += n.cardW + gapX;
      }
    }
  }

  return { nodes, links, outgoing, incoming };
}

function forceLayout(data) {
  const { nodes, links, outgoing, incoming } = prepareProofNodes(data);
  if (nodes.length) {
    forceSimulation(nodes)
      .force("links", forceLink(links).distance(125).strength(0.55))
      .force("charge", forceManyBody().strength(-460))
      .force("center", forceCenter())
      .force("collide", forceCollide((node) => node.cardW * 0.56))
      .stop()
      .tick(180);
  }
  return { nodes, links, outgoing, incoming };
}

export class ProofGraph {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.layoutMode = "dag";
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.network = { nodes: [], links: [], outgoing: new Map(), incoming: new Map() };
    canvas.addEventListener("pointerdown", (event) => this.startPointer(event));
    canvas.addEventListener("pointermove", (event) => this.movePointer(event));
    canvas.addEventListener("pointerup", (event) => this.endPointer(event));
    canvas.addEventListener("pointercancel", () => { this.drag = null; });
    canvas.addEventListener("pointerleave", () => {
      this.hovered = null;
      if (!this.drag) this.draw();
    });
    canvas.addEventListener("wheel", (event) => {
      if (!this.network.nodes.length) return;
      event.preventDefault();
      this.zoom(Math.exp(-event.deltaY * 0.002), this.pointer(event));
    }, { passive: false });
    new ResizeObserver(() => this.fit()).observe(canvas.parentElement);
  }

  setLayoutMode(mode) {
    const next = mode === "force" ? "force" : "dag";
    if (this.layoutMode === next) return;
    this.layoutMode = next;
    if (this.data) {
      this.network = this.buildNetwork(this.data);
      this.fit();
    }
  }

  render(data, selected) {
    this.selected = selected;
    if (data !== this.data) {
      this.data = data;
      this.network = this.buildNetwork(data);
      this.hovered = null;
      this.fit();
    } else {
      this.draw();
    }
  }

  buildNetwork(data) {
    return this.layoutMode === "force" ? forceLayout(data) : dagLayout(data);
  }

  fit() {
    const { clientWidth: width, clientHeight: height } = this.canvas.parentElement;
    if (!width || !height) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.ratio = scale;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    const { nodes } = this.network;
    if (nodes.length) {
      const left = Math.min(...nodes.map((n) => n.x - (n.cardW || 140) / 2));
      const right = Math.max(...nodes.map((n) => n.x + (n.cardW || 140) / 2));
      const top = Math.min(...nodes.map((n) => n.y - (n.cardH || 44) / 2));
      const bottom = Math.max(...nodes.map((n) => n.y + (n.cardH || 44) / 2));
      const spanX = Math.max(1, right - left);
      const spanY = Math.max(1, bottom - top);
      this.scale = Math.min(1.45, Math.max(0.18,
        Math.min((width - 64) / spanX, (height - 64) / spanY)));
      this.offset = {
        x: width / 2 - (left + spanX / 2) * this.scale,
        y: height / 2 - (top + spanY / 2) * this.scale,
      };
    }
    this.draw();
  }

  centerOn(id) {
    const node = this.network.nodes.find((item) => item.id === id);
    if (!node || !this.width) return;
    this.scale = Math.max(this.scale, 1.0);
    this.offset = {
      x: this.width / 2 - node.x * this.scale,
      y: this.height / 2 - node.y * this.scale,
    };
    this.draw();
  }

  /* Pointer position in the graph's layout pixels. The canvas may be displayed at a different
   * size than the one it was laid out for (no CSS size on the canvas, CSS transforms, or a
   * resize that has not been observed yet), so scale by the rendered box instead of assuming
   * 1 CSS px = 1 layout px. */
  pointer(event) {
    const bounds = this.canvas.getBoundingClientRect();
    const sx = bounds.width ? (this.width || bounds.width) / bounds.width : 1;
    const sy = bounds.height ? (this.height || bounds.height) / bounds.height : 1;
    return { x: (event.clientX - bounds.left) * sx, y: (event.clientY - bounds.top) * sy };
  }

  hit(point) {
    const { offset, scale } = this;
    const x = (point.x - offset.x) / scale;
    const y = (point.y - offset.y) / scale;
    return this.network.nodes.findLast((node) => {
      if (node.cardW && node.cardH) {
        const hw = node.cardW / 2 + 4 / scale;
        const hh = node.cardH / 2 + 4 / scale;
        return Math.abs(node.x - x) <= hw && Math.abs(node.y - y) <= hh;
      }
      return Math.hypot(node.x - x, node.y - y) <= node.radius + 3 / scale;
    });
  }

  startPointer(event) {
    if (event.button !== 0 || !this.network.nodes.length) return;
    const point = this.pointer(event);
    this.drag = { start: point, offset: this.offset, moved: false, id: event.pointerId };
    this.canvas.setPointerCapture(event.pointerId);
  }

  movePointer(event) {
    const point = this.pointer(event);
    if (this.drag) {
      if (event.pointerId !== this.drag.id) return;
      const dx = point.x - this.drag.start.x;
      const dy = point.y - this.drag.start.y;
      if (this.drag.moved || Math.hypot(dx, dy) > 4) {
        this.drag.moved = true;
        this.offset = { x: this.drag.offset.x + dx, y: this.drag.offset.y + dy };
        this.draw();
      }
      return;
    }
    const hit = this.hit(point);
    this.canvas.style.cursor = hit ? "pointer" : "grab";
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.draw();
    }
  }

  endPointer(event) {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    const hit = !this.drag.moved && this.hit(this.pointer(event));
    this.drag = null;
    if (hit) this.onSelect(hit.id);
  }

  zoom(factor, point = { x: this.width / 2, y: this.height / 2 }) {
    if (!this.network.nodes.length) return;
    const next = Math.max(0.12, Math.min(4.5, this.scale * factor));
    const ratio = next / this.scale;
    this.offset = {
      x: point.x - (point.x - this.offset.x) * ratio,
      y: point.y - (point.y - this.offset.y) * ratio,
    };
    this.scale = next;
    this.draw();
  }

  draw() {
    if (!this.width || !this.data) return;
    const dark = isDarkTheme();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.scale, this.scale);

    const focus = this.hovered?.id || this.selected;
    const { nodes, links, outgoing, incoming } = this.network;
    const { activeNodes, activeEdges } = computeChain(focus, outgoing, incoming);
    const hasFocus = Boolean(focus && activeNodes.size);

    // Subtle horizontal tier guides in DAG mode
    if (this.layoutMode === "dag" && nodes.length > 1) {
      const ys = [...new Set(nodes.map((n) => n.y))].sort((a, b) => a - b);
      const minX = Math.min(...nodes.map((n) => n.x - n.cardW / 2)) - 40;
      const maxX = Math.max(...nodes.map((n) => n.x + n.cardW / 2)) + 40;
      ctx.save();
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.05)" : "rgba(20,20,19,0.06)";
      ctx.lineWidth = 1 / this.scale;
      ctx.setLineDash([4 / this.scale, 6 / this.scale]);
      for (const y of ys) {
        ctx.beginPath();
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Directed Bezier dependency edges
    for (const { source, target } of links) {
      const edgeKey = `${source.id}->${target.id}`;
      const isLit = !hasFocus || activeEdges.has(edgeKey);
      const isDirect = source.id === focus || target.id === focus;
      const sx = source.x;
      const sy = source.y + (this.layoutMode === "dag" ? source.cardH / 2 : 0);
      const tx = target.x;
      const ty = target.y - (this.layoutMode === "dag" ? target.cardH / 2 + 2 : target.cardH / 2);

      const midY = (sy + ty) / 2;
      ctx.save();
      ctx.strokeStyle = isDirect
        ? (dark ? "#e4e4e7" : "#141413")
        : isLit
          ? (source.color || "#5c5a54")
          : (dark ? "#475569" : "#b8b4aa");
      ctx.globalAlpha = isDirect ? 0.92 : isLit ? 0.65 : 0.16;
      ctx.lineWidth = (isDirect ? 2.2 : isLit ? 1.5 : 1.0) / this.scale;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      if (this.layoutMode === "dag") {
        ctx.bezierCurveTo(sx, midY, tx, midY, tx, ty);
      } else {
        ctx.lineTo(target.x, target.y);
      }
      ctx.stroke();

      // Arrowhead at target top
      const angle = this.layoutMode === "dag"
        ? Math.atan2(ty - midY, tx - tx) || Math.PI / 2
        : Math.atan2(target.y - sy, target.x - sx);
      const ax = this.layoutMode === "dag" ? tx : target.x - Math.cos(angle) * (target.cardH * 0.55);
      const ay = this.layoutMode === "dag" ? ty : target.y - Math.sin(angle) * (target.cardH * 0.55);
      const tip = 6.5 / this.scale;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - tip * Math.cos(angle - 0.48), ay - tip * Math.sin(angle - 0.48));
      ctx.lineTo(ax - tip * Math.cos(angle + 0.48), ay - tip * Math.sin(angle + 0.48));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      ctx.restore();
    }

    // Theorem / Lemma / Axiom Cards
    for (const node of nodes) {
      const lit = !hasFocus || activeNodes.has(node.id);
      const isSelected = node.id === this.selected;
      const isHovered = node.id === this.hovered?.id;
      const x = node.x - node.cardW / 2;
      const y = node.y - node.cardH / 2;
      const roleLabels = { root: "ROOT", theorem: "LEMMA", axiom: "AXIOM", external: "EXT" };
      const tag = roleLabels[node.role] || "LEMMA";

      ctx.save();
      ctx.globalAlpha = lit ? 1 : 0.24;

      // Soft elevation shadow
      if (isSelected || isHovered || node.role === "root") {
        ctx.shadowColor = dark ? "rgba(0,0,0,0.5)" : "rgba(20,20,19,0.12)";
        ctx.shadowBlur = 14 / this.scale;
        ctx.shadowOffsetY = 4 / this.scale;
      }

      // Card fill
      if (node.role === "root") {
        ctx.fillStyle = dark ? "#f5f5f4" : "#141413";
      } else if (node.role === "axiom") {
        ctx.fillStyle = dark ? "#2a2115" : "#fdf7ec";
      } else {
        ctx.fillStyle = dark ? "#1c1c1a" : "#ffffff";
      }
      ctx.beginPath();
      ctx.roundRect(x, y, node.cardW, node.cardH, 9);
      ctx.fill();

      ctx.shadowColor = "transparent";
      ctx.lineWidth = (isSelected || isHovered ? 2.2 : 1.1) / this.scale;
      ctx.strokeStyle =
        isSelected || isHovered
          ? (dark ? "#ffffff" : "#141413")
          : node.role === "axiom"
            ? (dark ? "#b47b34" : "rgba(154,103,36,0.48)")
            : node.role === "root"
              ? (dark ? "#ffffff" : "#141413")
              : (dark ? "rgba(255,255,255,0.18)" : "rgba(20,20,19,0.18)");
      if (node.role === "external") ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Left accent stripe
      ctx.fillStyle = node.role === "root" ? (dark ? "#141413" : "#faf9f6") : node.color;
      ctx.beginPath();
      ctx.roundRect(x + 7, y + 9, 4, node.cardH - 18, 2);
      ctx.fill();

      // Badge & Title
      const textPrimary = node.role === "root" ? (dark ? "#141413" : "#faf9f6") : (dark ? "#f5f5f4" : "#141413");
      const textMuted = node.role === "root" ? (dark ? "#5c5a54" : "#b8b4aa") : (dark ? "#a1a1aa" : "#6c6960");

      ctx.font = "700 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = node.role === "axiom" ? "#b47b34" : textMuted;
      ctx.fillText(tag, x + 17, y + 16);

      const meta = node.hash ? `#${node.hash.slice(0, 6)}` : `deps ${node.outDeg}`;
      const metaW = ctx.measureText(meta).width;
      ctx.fillText(meta, x + node.cardW - metaW - 10, y + 16);

      const maxChars = Math.max(10, Math.floor((node.cardW - 26) / 7.1));
      const rawName = node.name || "(unnamed)";
      const label = rawName.length > maxChars ? rawName.slice(0, maxChars - 1) + "…" : rawName;
      ctx.font = "600 11.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = textPrimary;
      ctx.fillText(label, x + 17, y + 34);

      ctx.restore();
    }
  }
}

const kindStyle = {
  file: { color: "#456d9f", radius: 8.5 },
  class: { color: "#6d5b9f", radius: 7.5 },
  function: { color: "#377989", radius: 5.5 },
  variable: { color: "#b0653f", radius: 4.2 },
};
export const edgeColors = {
  imports: "#456d9f",
  calls: "#6844a4",
  reads: "#3f8a57",
  writes: "#c0492f",
  inherits: "#a2761f",
  contains: "#8e9aab",
  declares: "#8e9aab",
};

function codeLayout(data) {
  const nodes = data.nodes.map((node) => ({ ...node, degree: 0 }));
  const index = new Map(nodes.map((node) => [node.id, node]));
  const links = data.edges.flatMap((edge) => index.has(edge.from) && index.has(edge.to)
    ? [{ ...edge, source: index.get(edge.from), target: index.get(edge.to) }] : []);
  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const link of links) {
    link.source.degree++;
    link.target.degree++;
    neighbors.get(link.source.id).add(link.target.id);
    neighbors.get(link.target.id).add(link.source.id);
  }
  for (const node of nodes) {
    const style = kindStyle[node.kind] || kindStyle.function;
    node.color = style.color;
    node.radius = style.radius + Math.min(6, Math.sqrt(node.degree) * 0.9);
  }
  if (nodes.length) {
    const structural = (link) => link.kind === "contains" || link.kind === "declares";
    forceSimulation(nodes)
      .force("links", forceLink(links)
        .distance((link) => structural(link) ? 18 + link.target.radius * 2 : 70)
        .strength((link) => structural(link) ? 0.9 : link.kind === "imports" ? 0.12 : 0.05))
      .force("charge", forceManyBody().strength((node) => node.kind === "file" ? -220 : -60).distanceMax(420))
      .force("center", forceCenter())
      .force("collide", forceCollide((node) => node.radius + 3))
      .stop().tick(nodes.length > 1200 ? 70 : nodes.length > 500 ? 110 : 160);
  }
  return { nodes, links, neighbors };
}

function nodeShape(ctx, node) {
  const r = node.radius;
  ctx.beginPath();
  if (node.kind === "file") {
    ctx.roundRect(node.x - r, node.y - r * 0.8, r * 2, r * 1.6, r * 0.35);
  } else if (node.kind === "class") {
    ctx.moveTo(node.x, node.y - r * 1.15);
    ctx.lineTo(node.x + r * 1.15, node.y);
    ctx.lineTo(node.x, node.y + r * 1.15);
    ctx.lineTo(node.x - r * 1.15, node.y);
    ctx.closePath();
  } else {
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
  }
}

export class CodeGraph extends ProofGraph {
  buildNetwork(data) {
    return codeLayout(data);
  }

  setFlowState(flow) {
    this.flow = flow || null;
    this.draw();
  }

  centerOn(id) {
    const node = this.network.nodes.find((item) => item.id === id);
    if (!node || !this.width) return;
    this.scale = Math.max(this.scale, 1.2);
    this.offset = { x: this.width / 2 - node.x * this.scale, y: this.height / 2 - node.y * this.scale };
    this.draw();
  }

  fit() {
    const { clientWidth: width, clientHeight: height } = this.canvas.parentElement;
    if (!width || !height) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.ratio = scale;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    const { nodes } = this.network;
    if (nodes.length) {
      const xs = nodes.map((node) => node.x);
      const ys = nodes.map((node) => node.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const spanX = Math.max(...xs) - left;
      const spanY = Math.max(...ys) - top;
      this.scale = Math.min(1.9, Math.max(0.12,
        Math.min((width - 72) / Math.max(1, spanX), (height - 72) / Math.max(1, spanY))));
      this.offset = {
        x: width / 2 - (left + spanX / 2) * this.scale,
        y: height / 2 - (top + spanY / 2) * this.scale,
      };
    }
    this.draw();
  }

  hit(point) {
    const { offset, scale } = this;
    const x = (point.x - offset.x) / scale;
    const y = (point.y - offset.y) / scale;
    return this.network.nodes.findLast((node) => Math.hypot(node.x - x, node.y - y) <= node.radius + 3 / scale);
  }

  draw() {
    if (!this.width || !this.data) return;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.scale, this.scale);
    const focus = this.hovered?.id || this.selected;
    const flow = this.flow;
    const { nodes, links, neighbors } = this.network;
    const near = focus && neighbors?.get(focus);
    const lit = (id) => {
      if (flow?.activeNodes?.size) return flow.activeNodes.has(id) || id === focus;
      return !focus || id === focus || near?.has(id);
    };
    const edgeLabels = [];
    for (const link of links) {
      const { source, target, kind } = link;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const edgeKey = `${source.id}->${target.id}`;
      const flowActive = Boolean(flow?.activeEdges?.has(edgeKey));
      const traceCount = flow?.traceCounts?.get(edgeKey);
      const active = flowActive || source.id === focus || target.id === focus;
      const structural = kind === "contains" || kind === "declares";
      if (focus && !active && structural && !flowActive) continue;
      const angle = Math.atan2(dy, dx);
      const x = target.x - Math.cos(angle) * (target.radius + 1.5);
      const y = target.y - Math.sin(angle) * (target.radius + 1.5);
      ctx.strokeStyle = flowActive ? "#141413" : (edgeColors[kind] || "#657485");
      ctx.globalAlpha = flowActive ? 0.96 : active ? 0.85 : flow ? 0.12 : focus ? 0.06 : structural ? 0.18 : 0.3;
      ctx.lineWidth = (flowActive ? 2.6 : active ? 1.7 : 1) / this.scale;
      ctx.setLineDash(structural && !flowActive ? [3 / this.scale, 3 / this.scale] : []);
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(x, y);
      if ((!structural || flowActive) && (active || this.scale >= 1.4)) {
        const tip = (flowActive ? 8 : 6) / this.scale;
        ctx.moveTo(x - tip * Math.cos(angle - 0.5), y - tip * Math.sin(angle - 0.5));
        ctx.lineTo(x, y);
        ctx.lineTo(x - tip * Math.cos(angle + 0.5), y - tip * Math.sin(angle + 0.5));
      }
      ctx.stroke();
      if (traceCount) {
        edgeLabels.push({ x: (source.x + target.x) / 2, y: (source.y + target.y) / 2, text: `×${traceCount}` });
      }
    }
    ctx.setLineDash([]);
    for (const node of nodes) {
      const isCurrent = flow?.currentId === node.id;
      const active = isCurrent || node.id === focus;
      ctx.globalAlpha = lit(node.id) ? 1 : 0.2;
      if (isCurrent) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 5 / this.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(20, 20, 19, 0.18)";
        ctx.fill();
      }
      nodeShape(ctx, node);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = (isCurrent ? 3 : active ? 2.6 : 0.9) / this.scale;
      ctx.strokeStyle = isCurrent ? "#141413" : active ? "#1b1a33" : "#ffffffcc";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    if (edgeLabels.length) {
      ctx.font = "700 10px system-ui, sans-serif";
      for (const item of edgeLabels.slice(0, 40)) {
        const sx = this.offset.x + this.scale * item.x;
        const sy = this.offset.y + this.scale * item.y;
        const w = ctx.measureText(item.text).width + 8;
        ctx.fillStyle = "#141413";
        ctx.beginPath();
        ctx.roundRect(sx - w / 2, sy - 8, w, 16, 8);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(item.text, sx - w / 2 + 4, sy + 3.5);
      }
    }
    const screen = (node) => ({
      x: this.offset.x + this.scale * node.x,
      y: this.offset.y + this.scale * (node.y + node.radius) + 6,
    });
    let labelled = [];
    if (flow?.activeNodes?.size) {
      labelled = nodes.filter((node) => flow.activeNodes.has(node.id) || node.id === focus).slice(0, 60);
    } else if (focus) {
      labelled = nodes.filter((node) => node.id === focus || near?.has(node.id)).slice(0, 60);
    } else if (this.scale >= 1.1 || nodes.length <= 40) {
      labelled = nodes.filter((node) => {
        const point = screen(node);
        return point.x > -40 && point.x < this.width + 40 && point.y > -20 && point.y < this.height + 20 &&
          (this.scale >= 1.8 || node.kind === "file" || node.kind === "class" || nodes.length <= 40);
      }).slice(0, 160);
    } else {
      labelled = nodes.filter((node) => node.kind === "file").slice(0, 40);
    }
    ctx.font = "600 11px system-ui, sans-serif";
    for (const node of labelled) {
      const order = flow?.stepOrder?.get(node.id);
      const rawName = node.kind === "file" ? node.name : node.qualname || node.name;
      const prefixed = order ? `${order}. ${rawName}` : rawName;
      const name = prefixed.length > 42 ? prefixed.slice(0, 41) + "…" : prefixed;
      const width = ctx.measureText(name).width + 12;
      const point = screen(node);
      const x = Math.max(4, Math.min(this.width - width - 4, point.x - width / 2));
      const y = Math.max(4, Math.min(this.height - 20, point.y));
      const strong = node.id === focus || node.id === flow?.currentId;
      ctx.fillStyle = node.id === flow?.currentId ? "#141413" : strong ? "#2e2d2a" : "#ffffffef";
      ctx.strokeStyle = strong ? "#141413" : "rgba(20, 20, 19, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, width, 18, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = strong ? "#ffffff" : "#141413";
      ctx.fillText(name, x + 6, y + 12.5);
    }
  }
}
