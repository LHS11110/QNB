"use strict";

(function () {
  const MAX_DPR = 2;
  const LINK_DISTANCE = 158;
  const HOVER_RADIUS = 170;

  let canvas = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let running = false;
  let rafId = 0;
  let nodes = [];
  let edges = [];
  let pulses = [];
  let pointer = { x: -9999, y: -9999, active: false };
  let listenersBound = false;

  const reducedMotion = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function pickKind(index, total) {
    if (index % 11 === 0) return "axiom";
    if (index % 7 === 0 && index < total * 0.7) return "hub";
    return index % 3 === 0 ? "cyan" : "violet";
  }

  function buildConstellation() {
    const area = width * height;
    const count = Math.max(32, Math.min(78, Math.round(area / 22000)));
    nodes = [];
    for (let i = 0; i < count; i++) {
      const kind = pickKind(i, count);
      const radius = kind === "hub" ? 3.8 : kind === "axiom" ? 3.1 : 2.1 + (i % 3) * 0.35;
      const speed = kind === "hub" ? 0.16 : 0.24 + (i % 4) * 0.04;
      const angle = (i * 2.399963) % (Math.PI * 2);
      nodes.push({
        id: i,
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius,
        kind,
        phase: Math.random() * Math.PI * 2,
      });
    }
    rebuildStaticEdges();
  }

  function rebuildStaticEdges() {
    edges = [];
    pulses = [];
    for (let i = 0; i < nodes.length; i++) {
      let connections = 0;
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.hypot(dx, dy);
        if (dist < LINK_DISTANCE && connections < 3) {
          edges.push({ a: i, b: j });
          connections++;
        }
      }
    }
    const pulseCount = Math.min(18, Math.max(6, Math.floor(nodes.length / 4)));
    for (let i = 0; i < pulseCount; i++) {
      pulses.push({
        edgeIndex: Math.floor(Math.random() * Math.max(1, edges.length)),
        t: Math.random(),
        speed: 0.004 + Math.random() * 0.005,
      });
    }
  }

  function resize() {
    if (!canvas) return;
    const nextWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
    const nextHeight = window.innerHeight || document.documentElement.clientHeight || 720;
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (!nodes.length) {
      buildConstellation();
    } else {
      for (const node of nodes) {
        if (node.x > width) node.x = Math.random() * width;
        if (node.y > height) node.y = Math.random() * height;
      }
    }
    if (reducedMotion()) drawFrame(0);
  }

  function nodeColor(kind, alpha) {
    if (kind === "axiom") return `rgba(251, 191, 36, ${alpha})`;
    if (kind === "cyan") return `rgba(56, 189, 248, ${alpha})`;
    if (kind === "hub") return `rgba(196, 181, 253, ${alpha})`;
    return `rgba(167, 139, 250, ${alpha})`;
  }

  function drawFrame(time) {
    if (!ctx || !width || !height) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const highlighted = new Set();
    if (pointer.active) {
      for (let i = 0; i < nodes.length; i++) {
        const dist = Math.hypot(nodes[i].x - pointer.x, nodes[i].y - pointer.y);
        if (dist <= HOVER_RADIUS) highlighted.add(i);
      }
    }

    const activeEdges = [];
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > LINK_DISTANCE) continue;

        const isNearPointer = highlighted.has(i) || highlighted.has(j);
        const fade = 1 - dist / LINK_DISTANCE;
        const alpha = isNearPointer ? Math.min(0.65, fade * 0.7 + 0.15) : fade * 0.2;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = isNearPointer
          ? `rgba(167, 139, 250, ${alpha.toFixed(3)})`
          : `rgba(148, 163, 184, ${alpha.toFixed(3)})`;
        ctx.lineWidth = isNearPointer ? 1.25 : 0.75;
        ctx.stroke();

        if (activeEdges.length < 180) activeEdges.push({ a, b, isNearPointer });
      }
    }

    // DB verified theorem reuse pulses traveling along proof edges
    if (activeEdges.length && !reducedMotion()) {
      for (const pulse of pulses) {
        const edge = activeEdges[pulse.edgeIndex % activeEdges.length];
        if (!edge) continue;
        const px = edge.a.x + (edge.b.x - edge.a.x) * pulse.t;
        const py = edge.a.y + (edge.b.y - edge.a.y) * pulse.t;

        ctx.beginPath();
        ctx.arc(px, py, edge.isNearPointer ? 2.2 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = edge.isNearPointer ? "rgba(115, 219, 178, 0.92)" : "rgba(56, 189, 248, 0.72)";
        ctx.fill();

        pulse.t += pulse.speed;
        if (pulse.t >= 1) {
          pulse.t = 0;
          pulse.edgeIndex = Math.floor(Math.random() * activeEdges.length);
        }
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const near = highlighted.has(i);
      const pulseFactor = 0.85 + 0.15 * Math.sin(time * 0.0018 + node.phase);
      const radius = node.radius * (near ? 1.38 : 1);

      if (node.kind === "hub" || near) {
        const glowRadius = radius * (near ? 4.2 : 3.4);
        const grad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowRadius);
        grad.addColorStop(0, nodeColor(node.kind, near ? 0.34 : 0.2));
        grad.addColorStop(1, nodeColor(node.kind, 0));
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(node.kind, (near ? 0.98 : 0.78) * pulseFactor);
      ctx.fill();
    }
  }

  function step(time) {
    if (!running || document.hidden) return;
    for (const node of nodes) {
      node.x += node.vx;
      node.y += node.vy;
      if (node.x < -12) node.x = width + 12;
      else if (node.x > width + 12) node.x = -12;
      if (node.y < -12) node.y = height + 12;
      else if (node.y > height + 12) node.y = -12;

      if (pointer.active) {
        const dx = pointer.x - node.x;
        const dy = pointer.y - node.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 28 && dist < HOVER_RADIUS) {
          node.x += (dx / dist) * 0.14;
          node.y += (dy / dist) * 0.14;
        }
      }
    }
    drawFrame(time);
    rafId = window.requestAnimationFrame(step);
  }

  function onPointerMove(event) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    if (reducedMotion() && running) drawFrame(0);
  }

  function onPointerLeave() {
    pointer.active = false;
    if (reducedMotion() && running) drawFrame(0);
  }

  function onVisibilityChange() {
    if (!running) return;
    if (document.hidden) {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    } else if (!reducedMotion() && !rafId) {
      rafId = window.requestAnimationFrame(step);
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function start() {
    canvas = document.getElementById("particle-canvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    if (!ctx) return;
    bindListeners();
    resize();
    if (running) return;
    running = true;
    if (reducedMotion()) {
      drawFrame(0);
    } else if (!document.hidden) {
      rafId = window.requestAnimationFrame(step);
    }
  }

  function stop() {
    running = false;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  window.QNBParticles = { start, stop };
})();
