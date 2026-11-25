import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";

const palette = ["#377989", "#4b8051", "#a95e41", "#6d5b9f", "#987331", "#456d9f", "#904d67"];

function layout(data) {
  const nodes = data.nodes.map((node) => ({ ...node, degree: 0 }));
  const index = new Map(nodes.map((node) => [node.id, node]));
  const links = data.edges.flatMap(({ from, to }) => index.has(from) && index.has(to)
    ? [{ source: index.get(from), target: index.get(to) }] : []);
  const children = new Map();
  for (const { source, target } of links) {
    source.degree++;
    target.degree++;
    if (!children.has(source)) children.set(source, []);
    children.get(source).push(target);
  }
  const root = index.get(data.root);
  if (root) {
    root.group = -1;
    (children.get(root) || []).forEach((node, group) => {
      if (node.group === undefined) node.group = group;
    });
  }
  for (const node of nodes) {
    for (const child of children.get(node) || []) {
      if (child.group === undefined) child.group = node.group ?? 0;
    }
    node.radius = Math.min(16, 5 + Math.sqrt(node.degree) * 2.3) + (node === root ? 3 : 0);
    node.color = node === root ? "#6844a4" : node.kind === "axiom" ? "#ac7634" :
      palette[Math.max(0, node.group ?? 0) % palette.length];
  }
  if (nodes.length) {
    forceSimulation(nodes)
      .force("links", forceLink(links).distance(({ target }) => 40 + target.radius * 2).strength(.48))
      .force("charge", forceManyBody().strength(-112))
      .force("center", forceCenter())
      .force("collide", forceCollide((node) => node.radius + 7))
      .stop().tick(150);
  }
  return { nodes, links };
}

export class ProofGraph {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.network = { nodes: [], links: [] };
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
      this.zoom(Math.exp(-event.deltaY * .002), this.pointer(event));
    }, { passive: false });
    new ResizeObserver(() => this.fit()).observe(canvas.parentElement);
  }

  render(data, selected) {
    this.selected = selected;
    if (data !== this.data) {
      this.data = data;
      this.network = layout(data);
      this.hovered = null;
      this.fit();
    } else {
      this.draw();
    }
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
      this.scale = Math.min(1.9, Math.max(.12,
        Math.min((width - 72) / Math.max(1, spanX), (height - 72) / Math.max(1, spanY))));
      this.offset = {
        x: width / 2 - (left + spanX / 2) * this.scale,
        y: height / 2 - (top + spanY / 2) * this.scale,
      };
    }
    this.draw();
  }

  pointer(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  hit(point) {
    const { offset, scale } = this;
    const x = (point.x - offset.x) / scale;
    const y = (point.y - offset.y) / scale;
    return this.network.nodes.findLast((node) => Math.hypot(node.x - x, node.y - y) <= node.radius + 3 / scale);
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
    const next = Math.max(.08, Math.min(8, this.scale * factor));
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
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.scale, this.scale);
    const focus = this.hovered?.id || this.selected;
    const { nodes, links } = this.network;
    for (const { source, target } of links) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const active = source.id === focus || target.id === focus;
      const angle = Math.atan2(dy, dx);
      const x = target.x - Math.cos(angle) * (target.radius + 1);
      const y = target.y - Math.sin(angle) * (target.radius + 1);
      ctx.strokeStyle = active ? source.color : "#657485";
      ctx.globalAlpha = active ? .7 : .22;
      ctx.lineWidth = (active ? 1.8 : 1) / this.scale;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(x, y);
      if (active || this.scale >= 1.25) {
        const tip = 6 / this.scale;
        ctx.moveTo(x - tip * Math.cos(angle - .55), y - tip * Math.sin(angle - .55));
        ctx.lineTo(x, y);
        ctx.lineTo(x - tip * Math.cos(angle + .55), y - tip * Math.sin(angle + .55));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const node of nodes) {
      const active = node.id === focus;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.lineWidth = (active ? 2.5 : 1) / this.scale;
      ctx.strokeStyle = active ? "#201d36" : "#334155";
      ctx.stroke();
    }
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const labels = nodes.filter((node) => [this.data.root, this.selected, this.hovered?.id].includes(node.id));
    ctx.font = "600 12px system-ui, sans-serif";
    for (const node of labels) {
      const name = node.name.length > 42 ? node.name.slice(0, 41) + "…" : node.name;
      const width = ctx.measureText(name).width + 14;
      const x = Math.max(4, Math.min(this.width - width - 4, this.offset.x + this.scale * node.x - width / 2));
      const y = Math.max(4, Math.min(this.height - 22, this.offset.y + this.scale * (node.y + node.radius) + 7));
      ctx.fillStyle = "#ffffffef";
      ctx.strokeStyle = "#c3cdd8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, width, 20, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#26354a";
      ctx.fillText(name, x + 7, y + 14);
    }
  }
}
