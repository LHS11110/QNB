"use strict";

/* Coordinate-system pane for .plot files: a Desmos-like 2D graph (canvas) and a 3D graph
 * (WebGL) drawn from QNBPlotLang.run(). Everything runs in the browser. */
window.QNBPlot = (() => {
  const $ = (id) => document.getElementById(id);
  const PALETTE = ["#2563eb", "#e11d48", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#0d9488"];
  const NAMED = { red: "#e11d48", blue: "#2563eb", green: "#16a34a", purple: "#9333ea", orange: "#ea580c", black: "#111827", gray: "#6b7280", grey: "#6b7280", teal: "#0d9488", pink: "#db2777", yellow: "#ca8a04", cyan: "#0891b2" };
  const { Tuple, Shape } = window.QNBPlotLang;

  const colorOf = (plot) => (plot.color ? NAMED[plot.color.toLowerCase()] || plot.color : PALETTE[plot.colorIndex % PALETTE.length]);
  const safe = (f, ...args) => { try { const v = f(...args); return typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : NaN; } catch { return NaN; } };
  const allowed = (plot, ...args) => !plot.restrictF || Number.isFinite(safe(plot.restrictF, ...args)) && safe(plot.restrictF, ...args) !== 0;
  const coord = (v) => (typeof v === "number" ? v : typeof v === "boolean" ? +v : NaN);

  function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  function theme() {
    const css = getComputedStyle(document.body);
    const bg = css.getPropertyValue("--panel").trim() || "#ffffff";
    const text = css.getPropertyValue("--text").trim() || "#141413";
    const dark = document.documentElement.dataset.ideTheme === "dark";
    return { bg, text, dark, grid: dark ? "rgba(255,255,255,.06)" : "rgba(20,20,19,.06)", major: dark ? "rgba(255,255,255,.14)" : "rgba(20,20,19,.14)", axis: dark ? "rgba(255,255,255,.55)" : "rgba(20,20,19,.6)", label: dark ? "rgba(255,255,255,.65)" : "rgba(20,20,19,.62)" };
  }

  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  function fmtTick(v, step) {
    if (Math.abs(v) < step * 1e-6) return "0";
    const digits = Math.max(0, -Math.floor(Math.log10(step)) + (step / 10 ** Math.floor(Math.log10(step)) === 2.5 ? 1 : 0));
    return Math.abs(v) >= 1e5 || Math.abs(v) < 1e-4 ? v.toExponential(1) : v.toFixed(Math.min(digits, 8));
  }

  /* Marching squares over a grid of values; returns [x1,y1,x2,y2] segments in grid coordinates. */
  function marchingSquares(vals, nx, ny) {
    const segs = [];
    const lerp = (a, b) => a / (a - b);
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = vals[j * nx + i], b = vals[j * nx + i + 1], c = vals[(j + 1) * nx + i + 1], d = vals[(j + 1) * nx + i];
        if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
        const k = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
        if (k === 0 || k === 15) continue;
        const top = [i + lerp(a, b), j], right = [i + 1, j + lerp(b, c)], bottom = [i + lerp(d, c), j + 1], left = [i, j + lerp(a, d)];
        const add = (p, q) => segs.push(p[0], p[1], q[0], q[1]);
        switch (k) {
          case 1: case 14: add(left, top); break;
          case 2: case 13: add(top, right); break;
          case 3: case 12: add(left, right); break;
          case 4: case 11: add(right, bottom); break;
          case 6: case 9: add(top, bottom); break;
          case 7: case 8: add(left, bottom); break;
          case 5: case 10: {
            const centre = (a + b + c + d) / 4;
            if ((centre > 0) === (k === 5)) { add(left, top); add(right, bottom); } else { add(top, right); add(left, bottom); }
            break;
          }
        }
      }
    }
    return segs;
  }

  /* ================================ 2D ================================ */

  class Graph2D {
    constructor(canvas, readout, tip) {
      this.canvas = canvas;
      this.readout = readout;
      this.tip = tip;
      this.view = { cx: 0, cy: 0, scale: 40 };
      this.result = null;
      this.hidden = new Set();
      this.emphasis = null;
      this.quality = 1;
      this.mouse = null;
      canvas.addEventListener("pointerdown", (e) => this.down(e));
      canvas.addEventListener("pointermove", (e) => this.move(e));
      canvas.addEventListener("pointerup", (e) => this.up(e));
      canvas.addEventListener("pointercancel", (e) => this.up(e));
      canvas.addEventListener("pointerleave", () => { this.mouse = null; this.tip.hidden = true; this.readout.textContent = ""; this.schedule(); });
      canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
      canvas.addEventListener("dblclick", () => { this.resetView(); this.draw(); });
    }

    size() {
      const box = this.canvas.getBoundingClientRect();
      return { w: Math.max(1, box.width), h: Math.max(1, box.height), box };
    }

    /* Pointer position in CSS pixels of the canvas, whatever its backing-store size. */
    local(e) {
      const { box } = this.size();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    }

    resetView() {
      const { w, h } = this.size();
      const s = this.result?.settings || {};
      const xr = Array.isArray(s.xrange) ? s.xrange : null;
      const yr = Array.isArray(s.yrange) ? s.yrange : null;
      if (xr && yr) {
        this.view = { cx: (xr[0] + xr[1]) / 2, cy: (yr[0] + yr[1]) / 2, scale: Math.min(w / (xr[1] - xr[0]), h / (yr[1] - yr[0])) };
      } else if (xr) {
        this.view = { cx: (xr[0] + xr[1]) / 2, cy: 0, scale: w / (xr[1] - xr[0]) };
      } else if (yr) {
        this.view = { cx: 0, cy: (yr[0] + yr[1]) / 2, scale: h / (yr[1] - yr[0]) };
      } else {
        this.view = { cx: 0, cy: 0, scale: Math.min(w, h) / 20 };
      }
    }

    toPx(x) { const { w } = this.size(); return w / 2 + (x - this.view.cx) * this.view.scale; }
    toPy(y) { const { h } = this.size(); return h / 2 - (y - this.view.cy) * this.view.scale; }
    fromPx(px) { const { w } = this.size(); return this.view.cx + (px - w / 2) / this.view.scale; }
    fromPy(py) { const { h } = this.size(); return this.view.cy - (py - h / 2) / this.view.scale; }

    down(e) {
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = { ...this.local(e), cx: this.view.cx, cy: this.view.cy };
      this.canvas.style.cursor = "grabbing";
    }
    move(e) {
      const p = this.local(e);
      this.mouse = p;
      if (this.drag) {
        this.view.cx = this.drag.cx - (p.x - this.drag.x) / this.view.scale;
        this.view.cy = this.drag.cy + (p.y - this.drag.y) / this.view.scale;
        this.quality = 0.5;
      }
      this.schedule();
    }
    up() {
      this.drag = null;
      this.canvas.style.cursor = "";
      this.quality = 1;
      this.schedule();
    }
    wheel(e) {
      e.preventDefault();
      const p = this.local(e);
      const wx = this.fromPx(p.x), wy = this.fromPy(p.y);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.view.scale = Math.min(1e7, Math.max(1e-5, this.view.scale * factor));
      this.view.cx = wx - (p.x - this.size().w / 2) / this.view.scale;
      this.view.cy = wy + (p.y - this.size().h / 2) / this.view.scale;
      this.quality = 0.5;
      clearTimeout(this.idle);
      this.idle = setTimeout(() => { this.quality = 1; this.schedule(); }, 160);
      this.schedule();
    }
    zoom(factor) {
      this.view.scale = Math.min(1e7, Math.max(1e-5, this.view.scale * factor));
      this.draw();
    }

    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
    }

    draw() {
      const { canvas } = this;
      if (!canvas.isConnected || canvas.offsetParent === null) return;
      const { w, h } = this.size();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      const th = theme();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = th.bg;
      ctx.fillRect(0, 0, w, h);
      this.drawGrid(ctx, w, h, th);
      const plots = (this.result?.plots || []).filter((p) => !this.hidden.has(p.line));
      const order = { region: 0, implicit: 1, explicit: 1, polar: 1, param: 1, points: 2 };
      for (const plot of plots.slice().sort((a, b) => (order[a.kind] ?? 1) - (order[b.kind] ?? 1))) {
        ctx.save();
        try { this.drawPlot(ctx, plot, w, h); } catch { /* a bad plot never breaks the others */ }
        ctx.restore();
      }
      this.drawHover(ctx, plots, th);
    }

    drawGrid(ctx, w, h, th) {
      const step = niceStep(80 / this.view.scale);
      const minor = step / 5;
      const x0 = this.fromPx(0), x1 = this.fromPx(w), y0 = this.fromPy(h), y1 = this.fromPy(0);
      const lines = (s, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = Math.ceil(x0 / s) * s; x <= x1; x += s) { const px = Math.round(this.toPx(x)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, h); }
        for (let y = Math.ceil(y0 / s) * s; y <= y1; y += s) { const py = Math.round(this.toPy(y)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(w, py); }
        ctx.stroke();
      };
      if (minor * this.view.scale > 6) lines(minor, th.grid);
      lines(step, th.major);
      const ax = Math.min(w - 1, Math.max(0, this.toPx(0)));
      const ay = Math.min(h - 1, Math.max(0, this.toPy(0)));
      ctx.strokeStyle = th.axis;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, ay); ctx.lineTo(w, ay);
      ctx.moveTo(ax, 0); ctx.lineTo(ax, h);
      ctx.stroke();
      ctx.fillStyle = th.label;
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelY = ay > h - 18 ? ay - 16 : ay + 4;
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        if (Math.abs(x) < step / 2) continue;
        ctx.fillText(fmtTick(x, step), this.toPx(x), labelY);
      }
      ctx.textAlign = ax < 30 ? "left" : "right";
      ctx.textBaseline = "middle";
      const labelX = ax < 30 ? ax + 5 : ax - 5;
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        if (Math.abs(y) < step / 2) continue;
        ctx.fillText(fmtTick(y, step), labelX, this.toPy(y));
      }
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      if (ax > 12 && ay < h - 14) ctx.fillText("0", ax - 4, ay + 3);
    }

    strokeStyle(ctx, plot, dashed = false) {
      ctx.strokeStyle = colorOf(plot);
      ctx.lineWidth = this.emphasis === plot.line ? 3.6 : 2.4;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(dashed ? [7, 6] : []);
    }

    drawPlot(ctx, plot, w, h) {
      switch (plot.kind) {
        case "explicit": return this.drawExplicit(ctx, plot, w, h);
        case "polar": return this.drawCurve(ctx, plot, (th) => { const r = safe(plot.f, th); return [r * Math.cos(th), r * Math.sin(th)]; }, this.result.settings["θrange"] || [0, 2 * Math.PI], 2400, (th) => allowed(plot, th));
        case "param": {
          const [fx, fy] = plot.fs;
          return this.drawCurve(ctx, plot, (t) => [safe(fx, t), safe(fy, t)], this.result.settings.trange || [0, 2 * Math.PI], 2400, (t) => allowed(plot, t));
        }
        case "implicit": return this.drawImplicit(ctx, plot, plot.f, w, h, false);
        case "region": return this.drawRegion(ctx, plot, w, h);
        case "points": return this.drawPoints(ctx, plot);
        default: return null;
      }
    }

    drawExplicit(ctx, plot, w, h) {
      this.strokeStyle(ctx, plot);
      const sideways = plot.dep === "x";
      const span = sideways ? h : w;
      const step = this.quality < 1 ? 2 : 0.5;
      ctx.beginPath();
      let prev = null;
      for (let p = -1; p <= span + 1; p += step) {
        const a = sideways ? this.fromPy(p) : this.fromPx(p);
        const b = safe(plot.f, a);
        const ok = Number.isFinite(b) && (sideways ? allowed(plot, b, a) : allowed(plot, a, b));
        if (!ok) { prev = null; continue; }
        const q = sideways ? this.toPx(b) : this.toPy(b);
        const limit = sideways ? w : h;
        // break the path at poles: huge jumps that cross the whole screen
        if (prev !== null && Math.abs(q - prev) > limit * 1.2) { prev = null; }
        const qc = Math.max(-limit * 4, Math.min(limit * 5, q));
        if (prev === null) { if (sideways) ctx.moveTo(qc, p); else ctx.moveTo(p, qc); }
        else if (sideways) ctx.lineTo(qc, p); else ctx.lineTo(p, qc);
        prev = q;
      }
      ctx.stroke();
    }

    drawCurve(ctx, plot, point, range, n, ok) {
      this.strokeStyle(ctx, plot);
      const [a, b] = range;
      const count = this.quality < 1 ? n / 3 : n;
      const { h } = this.size();
      ctx.beginPath();
      let prev = null;
      for (let i = 0; i <= count; i++) {
        const t = a + (b - a) * i / count;
        const [x, y] = point(t);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !ok(t)) { prev = null; continue; }
        const px = this.toPx(x), py = this.toPy(y);
        if (prev && Math.hypot(px - prev[0], py - prev[1]) > h * 1.5) prev = null;
        if (prev) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        prev = [px, py];
      }
      ctx.stroke();
    }

    gridValues(f, w, h, cell, restrict) {
      const nx = Math.ceil(w / cell) + 1, ny = Math.ceil(h / cell) + 1;
      const vals = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        const y = this.fromPy(j * cell);
        for (let i = 0; i < nx; i++) {
          const x = this.fromPx(i * cell);
          vals[j * nx + i] = restrict && !restrict(x, y) ? NaN : safe(f, x, y);
        }
      }
      return { vals, nx, ny };
    }

    drawImplicit(ctx, plot, f, w, h, dashed) {
      const cell = this.quality < 1 ? 8 : 4;
      const { vals, nx, ny } = this.gridValues(f, w, h, cell, plot.restrictF ? (x, y) => allowed(plot, x, y) : null);
      const segs = marchingSquares(vals, nx, ny);
      this.strokeStyle(ctx, plot, dashed);
      ctx.beginPath();
      for (let k = 0; k < segs.length; k += 4) {
        const x1 = segs[k] * cell, y1 = segs[k + 1] * cell, x2 = segs[k + 2] * cell, y2 = segs[k + 3] * cell;
        // Skip false edges at poles (tan, 1/x): the value blows up between the corners.
        const mid = safe(f, this.fromPx((x1 + x2) / 2), this.fromPy((y1 + y2) / 2));
        const ci = Math.floor(Math.min(segs[k], segs[k + 2])), cj = Math.floor(Math.min(segs[k + 1], segs[k + 3]));
        const corner = Math.max(Math.abs(vals[cj * nx + ci] || 0), Math.abs(vals[cj * nx + Math.min(nx - 1, ci + 1)] || 0), Math.abs(vals[Math.min(ny - 1, cj + 1) * nx + ci] || 0));
        if (Number.isFinite(mid) && Math.abs(mid) > corner * 4 + 1e-9) continue;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }

    drawRegion(ctx, plot, w, h) {
      const cell = this.quality < 1 ? 6 : 3;
      const nx = Math.ceil(w / cell), ny = Math.ceil(h / cell);
      const img = new ImageData(nx, ny);
      const [r, g, b] = hexToRgb(colorOf(plot)).map((c) => Math.round(c * 255));
      for (let j = 0; j < ny; j++) {
        const y = this.fromPy((j + 0.5) * cell);
        for (let i = 0; i < nx; i++) {
          const x = this.fromPx((i + 0.5) * cell);
          if (safe(plot.test, x, y) && allowed(plot, x, y)) {
            const o = (j * nx + i) * 4;
            img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 64;
          }
        }
      }
      const off = document.createElement("canvas");
      off.width = nx; off.height = ny;
      off.getContext("2d").putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, nx * cell, ny * cell);
      if (plot.boundary) this.drawImplicit(ctx, plot, plot.boundary, w, h, plot.strict);
    }

    drawPoints(ctx, plot) {
      const color = colorOf(plot);
      const xy = (p) => [this.toPx(coord(p.items[0])), this.toPy(coord(p.items[1]))];
      for (const item of plot.items) {
        if (item instanceof Shape) {
          const pts = item.points.filter((p) => p instanceof Tuple).map(xy);
          if (!pts.length) continue;
          this.strokeStyle(ctx, plot);
          ctx.beginPath();
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          if (item.type === "polygon") {
            ctx.closePath();
            ctx.fillStyle = color + "33";
            ctx.fill();
          }
          ctx.stroke();
          if (item.type === "vector" && pts.length === 2) {
            const [[x1, y1], [x2, y2]] = pts;
            const ang = Math.atan2(y2 - y1, x2 - x1);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - 11 * Math.cos(ang - 0.4), y2 - 11 * Math.sin(ang - 0.4));
            ctx.lineTo(x2 - 11 * Math.cos(ang + 0.4), y2 - 11 * Math.sin(ang + 0.4));
            ctx.fill();
          }
          continue;
        }
        if (!(item instanceof Tuple)) continue;
        const [x, y] = xy(item);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, this.emphasis === plot.line ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (plot.label && plot.items.length === 1 && plot.items[0] instanceof Tuple) {
        const [x, y] = xy(plot.items[0]);
        ctx.fillStyle = color;
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(plot.label, x + 7, y - 5);
      }
    }

    drawHover(ctx, plots, th) {
      if (!this.mouse || this.drag) { if (!this.mouse) this.tip.hidden = true; return; }
      const { x: mx, y: my } = this.mouse;
      const wx = this.fromPx(mx), wy = this.fromPy(my);
      const step = niceStep(80 / this.view.scale) / 100;
      const round = (v) => (Math.abs(v) < step ? "0" : String(+v.toFixed(Math.max(0, Math.min(10, -Math.floor(Math.log10(step)))))));
      this.readout.textContent = `x = ${round(wx)}, y = ${round(wy)}`;
      let best = null;
      for (const plot of plots) {
        if (plot.kind === "points") {
          for (const item of plot.items) {
            if (!(item instanceof Tuple)) continue;
            const px = this.toPx(coord(item.items[0])), py = this.toPy(coord(item.items[1]));
            const d = Math.hypot(px - mx, py - my);
            if (d < 10 && (!best || d < best.d)) best = { d, px, py, x: coord(item.items[0]), y: coord(item.items[1]), plot };
          }
        } else if (plot.kind === "explicit") {
          const sideways = plot.dep === "x";
          const a = sideways ? wy : wx;
          const b = safe(plot.f, a);
          if (!Number.isFinite(b) || !(sideways ? allowed(plot, b, a) : allowed(plot, a, b))) continue;
          const px = sideways ? this.toPx(b) : mx, py = sideways ? my : this.toPy(b);
          const d = Math.hypot(px - mx, py - my);
          if (d < 9 && (!best || d < best.d)) best = { d, px, py, x: sideways ? b : a, y: sideways ? a : b, plot };
        }
      }
      if (!best) { this.tip.hidden = true; return; }
      ctx.fillStyle = th.bg;
      ctx.strokeStyle = colorOf(best.plot);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(best.px, best.py, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      this.tip.hidden = false;
      this.tip.textContent = `(${round(best.x)}, ${round(best.y)})`;
      this.tip.style.left = best.px + 10 + "px";
      this.tip.style.top = best.py - 30 + "px";
    }
  }

  /* ================================ 3D ================================ */

  const mat = {
    perspective(fov, aspect, near, far) {
      const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
      return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
    },
    lookAt(eye, target, up) {
      const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
      return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
    },
    mul(a, b) {
      const o = new Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
        o[i * 4 + j] = s;
      }
      return o;
    },
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  const MESH_VS = `attribute vec3 aPos; attribute vec3 aNormal; attribute vec3 aColor;
uniform mat4 uMVP; varying vec3 vN; varying vec3 vPos; varying vec3 vColor;
void main() { vN = aNormal; vPos = aPos; vColor = aColor; gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const MESH_FS = `precision mediump float; varying vec3 vN; varying vec3 vPos; varying vec3 vColor;
uniform float uAlpha; uniform vec3 uEye;
void main() {
  if (any(greaterThan(abs(vPos), vec3(1.0005)))) discard;
  vec3 n = normalize(vN); vec3 l = normalize(vec3(0.4, 0.3, 1.0)); vec3 v = normalize(uEye - vPos);
  if (dot(n, v) < 0.0) n = -n;
  float diff = max(dot(n, l), 0.0) * 0.6 + max(dot(n, normalize(vec3(-0.6, -0.5, 0.4))), 0.0) * 0.2;
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 28.0) * 0.25;
  gl_FragColor = vec4(vColor * (0.38 + diff) + spec, uAlpha);
}`;
  const LINE_VS = `attribute vec3 aPos; attribute vec3 aColor; uniform mat4 uMVP; uniform float uSize;
varying vec3 vPos; varying vec3 vColor;
void main() { vPos = aPos; vColor = aColor; gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uSize; }`;
  const LINE_FS = `precision mediump float; varying vec3 vPos; varying vec3 vColor; uniform float uAlpha; uniform float uRound; uniform float uClip;
void main() {
  if (uClip > 0.5 && any(greaterThan(abs(vPos), vec3(1.0005)))) discard;
  if (uRound > 0.5 && length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(vColor, uAlpha);
}`;

  // Marching tetrahedra: each grid cube is split into 6 tetrahedra around the 0–6 diagonal.
  const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const TETS = [[0, 6, 1, 2], [0, 6, 2, 3], [0, 6, 3, 7], [0, 6, 7, 4], [0, 6, 4, 5], [0, 6, 5, 1]];

  class Graph3D {
    constructor(canvas, overlay) {
      this.canvas = canvas;
      this.overlay = overlay;
      this.gl = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: false }) || null;
      this.yaw = -0.9; this.pitch = 0.5; this.dist = 4.6;
      this.hidden = new Set();
      this.emphasis = null;
      this.spin = false;
      if (!this.gl) return;
      this.mesh = this.program(MESH_VS, MESH_FS);
      this.line = this.program(LINE_VS, LINE_FS);
      canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; });
      canvas.addEventListener("pointermove", (e) => {
        if (!this.drag) return;
        this.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.008;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.drag.pitch + (e.clientY - this.drag.y) * 0.008));
        this.schedule();
      });
      const end = () => { this.drag = null; };
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
      canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.dist = Math.max(1.8, Math.min(14, this.dist * Math.exp(e.deltaY * 0.0012))); this.schedule(); }, { passive: false });
      canvas.addEventListener("dblclick", () => { this.resetView(); this.schedule(); });
    }

    resetView() { this.yaw = -0.9; this.pitch = 0.5; this.dist = 4.6; }

    program(vs, fs) {
      const gl = this.gl;
      const compileShader = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      const loc = (name) => gl.getUniformLocation(p, name);
      return { p, aPos: gl.getAttribLocation(p, "aPos"), aNormal: gl.getAttribLocation(p, "aNormal"), aColor: gl.getAttribLocation(p, "aColor"), uMVP: loc("uMVP"), uAlpha: loc("uAlpha"), uEye: loc("uEye"), uSize: loc("uSize"), uRound: loc("uRound"), uClip: loc("uClip") };
    }

    ranges() {
      const s = this.result?.settings || {};
      const r = (key) => (Array.isArray(s[key]) && s[key][1] > s[key][0] ? s[key] : [-5, 5]);
      return { x: r("xrange"), y: r("yrange"), z: r("zrange") };
    }

    /* World → normalised cube [-1, 1]^3. */
    normaliser() {
      const { x, y, z } = this.ranges();
      const f = (r) => (v) => ((v - r[0]) / (r[1] - r[0])) * 2 - 1;
      return [f(x), f(y), f(z)];
    }

    setData(result) {
      this.result = result;
      this.build();
    }

    build() {
      this.batches = [];
      if (!this.gl || !this.result) return;
      const [nx, ny, nz] = this.normaliser();
      const R = this.ranges();
      for (const plot of this.result.plots) {
        if (this.hidden.has(plot.line)) continue;
        const rgb = hexToRgb(colorOf(plot));
        try {
          switch (plot.kind) {
            case "surface": this.batches.push(this.surface(plot, rgb, R, nx, ny, nz)); break;
            case "paramSurface": this.batches.push(this.paramSurface(plot, rgb, nx, ny, nz)); break;
            case "implicit3": this.batches.push(this.implicit(plot, plot.f, rgb, R, nx, ny, nz, 1)); break;
            case "region3":
              if (plot.boundary) this.batches.push(this.implicit(plot, plot.boundary, rgb, R, nx, ny, nz, 0.45));
              else this.batches.push(this.voxels(plot, rgb, R, nx, ny, nz));
              break;
            case "param3": case "param": this.batches.push(this.curve(plot, rgb, nx, ny, nz)); break;
            case "explicit": this.batches.push(this.flatExplicit(plot, rgb, R, nx, ny, nz)); break;
            case "points": this.batches.push(this.points(plot, rgb, nx, ny, nz)); break;
            default: break;
          }
        } catch { /* keep drawing the rest */ }
      }
      this.batches = this.batches.filter(Boolean);
      this.frameLines = this.frame();
      this.schedule();
    }

    buffer(data) {
      const gl = this.gl;
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return b;
    }

    meshBatch(plot, pos, nrm, col, alpha = 1) {
      if (!pos.length) return null;
      return { type: "mesh", line: plot.line, count: pos.length / 3, pos: this.buffer(pos), nrm: this.buffer(nrm), col: this.buffer(col), alpha };
    }

    gridMesh(plot, rgb, nu, nv, at, alpha = 1) {
      // at(i, j) → [x, y, z] normalised, or null
      const P = [];
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) P.push(at(i, j));
      const idx = (i, j) => j * (nu + 1) + i;
      const N = P.map((p, k) => {
        if (!p) return null;
        const i = k % (nu + 1), j = Math.floor(k / (nu + 1));
        const a = P[idx(Math.min(nu, i + 1), j)] || p, b = P[idx(Math.max(0, i - 1), j)] || p;
        const c = P[idx(i, Math.min(nv, j + 1))] || p, d = P[idx(i, Math.max(0, j - 1))] || p;
        return norm(cross(sub(a, b), sub(c, d)));
      });
      const pos = [], nrm = [], col = [];
      const push = (k) => {
        const p = P[k];
        pos.push(p[0], p[1], p[2]);
        nrm.push(...N[k]);
        const shade = 0.82 + 0.18 * p[2];
        col.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
      };
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
        if (P[a] && P[b] && P[c]) { push(a); push(b); push(c); }
        if (P[a] && P[c] && P[d]) { push(a); push(c); push(d); }
      }
      return this.meshBatch(plot, pos, nrm, col, alpha);
    }

    surface(plot, rgb, R, nx, ny, nz) {
      const n = 96;
      return this.gridMesh(plot, rgb, n, n, (i, j) => {
        const x = R.x[0] + (R.x[1] - R.x[0]) * i / n, y = R.y[0] + (R.y[1] - R.y[0]) * j / n;
        const z = safe(plot.f, x, y);
        if (!Number.isFinite(z) || !allowed(plot, x, y, z)) return null;
        return [nx(x), ny(y), Math.max(-3, Math.min(3, nz(z)))];
      });
    }

    paramSurface(plot, rgb, nx, ny, nz) {
      const s = this.result.settings;
      const ur = s.urange || [0, 2 * Math.PI], vr = s.vrange || [0, Math.PI];
      const nu = 90, nv = 60;
      const [fx, fy, fz] = plot.fs;
      return this.gridMesh(plot, rgb, nu, nv, (i, j) => {
        const u = ur[0] + (ur[1] - ur[0]) * i / nu, v = vr[0] + (vr[1] - vr[0]) * j / nv;
        const p = [safe(fx, u, v), safe(fy, u, v), safe(fz, u, v)];
        return p.every(Number.isFinite) ? [nx(p[0]), ny(p[1]), nz(p[2])] : null;
      });
    }

    implicit(plot, f, rgb, R, nx, ny, nz, alpha) {
      const n = 44;
      const at = (r, k) => r[0] + (r[1] - r[0]) * k / n;
      const V = new Float64Array((n + 1) ** 3);
      const id = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
      for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const x = at(R.x, i), y = at(R.y, j), z = at(R.z, k);
        V[id(i, j, k)] = plot.restrictF && !allowed(plot, x, y, z) ? NaN : safe(f, x, y, z);
      }
      const grad = (i, j, k) => {
        const g = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a - b : 0);
        return [
          g(V[id(Math.min(n, i + 1), j, k)], V[id(Math.max(0, i - 1), j, k)]),
          g(V[id(i, Math.min(n, j + 1), k)], V[id(i, Math.max(0, j - 1), k)]),
          g(V[id(i, j, Math.min(n, k + 1))], V[id(i, j, Math.max(0, k - 1))]),
        ];
      };
      const pos = [], nrm = [], col = [];
      const vert = (pa, pb, va, vb) => {
        const t = va / (va - vb);
        const p = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
        const ga = grad(...pa), gb = grad(...pb);
        const g = norm([ga[0] + (gb[0] - ga[0]) * t, ga[1] + (gb[1] - ga[1]) * t, ga[2] + (gb[2] - ga[2]) * t]);
        const X = nx(at(R.x, p[0])), Y = ny(at(R.y, p[1])), Z = nz(at(R.z, p[2]));
        pos.push(X, Y, Z);
        nrm.push(g[0], g[1], g[2]);
        const shade = 0.82 + 0.18 * Z;
        col.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
      };
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const cp = CORNERS.map(([a, b, c]) => [i + a, j + b, k + c]);
        const cv = cp.map((p) => V[id(...p)]);
        if (cv.some((v) => !Number.isFinite(v))) continue;
        if (cv.every((v) => v > 0) || cv.every((v) => v <= 0)) continue;
        for (const tet of TETS) {
          const P = tet.map((c) => cp[c]), F = tet.map((c) => cv[c]);
          const inside = [0, 1, 2, 3].filter((q) => F[q] <= 0);
          const outside = [0, 1, 2, 3].filter((q) => F[q] > 0);
          if (inside.length === 0 || inside.length === 4) continue;
          if (inside.length === 1 || inside.length === 3) {
            const lone = inside.length === 1 ? inside[0] : outside[0];
            const others = inside.length === 1 ? outside : inside;
            for (const o of others) vert(P[lone], P[o], F[lone], F[o]);
          } else {
            const [a, b] = inside, [c, d] = outside;
            vert(P[a], P[c], F[a], F[c]); vert(P[a], P[d], F[a], F[d]); vert(P[b], P[d], F[b], F[d]);
            vert(P[a], P[c], F[a], F[c]); vert(P[b], P[d], F[b], F[d]); vert(P[b], P[c], F[b], F[c]);
          }
        }
      }
      return this.meshBatch(plot, pos, nrm, col, alpha);
    }

    voxels(plot, rgb, R, nx, ny, nz) {
      const n = 26, pos = [], col = [];
      for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const x = R.x[0] + (R.x[1] - R.x[0]) * i / n, y = R.y[0] + (R.y[1] - R.y[0]) * j / n, z = R.z[0] + (R.z[1] - R.z[0]) * k / n;
        if (safe(plot.test, x, y, z) && allowed(plot, x, y, z)) { pos.push(nx(x), ny(y), nz(z)); col.push(...rgb); }
      }
      return pos.length ? { type: "points", line: plot.line, count: pos.length / 3, pos: this.buffer(pos), col: this.buffer(col), size: 3, alpha: 0.5 } : null;
    }

    curve(plot, rgb, nx, ny, nz) {
      const range = this.result.settings.trange || [0, 2 * Math.PI];
      const n = 1600, strips = [];
      let cur = [];
      const [fx, fy, fz] = plot.fs;
      for (let i = 0; i <= n; i++) {
        const t = range[0] + (range[1] - range[0]) * i / n;
        const p = [safe(fx, t), safe(fy, t), fz ? safe(fz, t) : 0];
        if (p.every(Number.isFinite) && allowed(plot, t)) cur.push(nx(p[0]), ny(p[1]), nz(p[2]));
        else if (cur.length) { strips.push(cur); cur = []; }
      }
      if (cur.length) strips.push(cur);
      return this.lineBatch(plot, strips, rgb);
    }

    flatExplicit(plot, rgb, R, nx, ny, nz) {
      const n = 800, strips = [];
      let cur = [];
      const r = plot.dep === "x" ? R.y : R.x;
      for (let i = 0; i <= n; i++) {
        const a = r[0] + (r[1] - r[0]) * i / n;
        const b = safe(plot.f, a);
        const [x, y] = plot.dep === "x" ? [b, a] : [a, b];
        if (Number.isFinite(b)) cur.push(nx(x), ny(y), nz(0));
        else if (cur.length) { strips.push(cur); cur = []; }
      }
      if (cur.length) strips.push(cur);
      return this.lineBatch(plot, strips, rgb);
    }

    lineBatch(plot, strips, rgb) {
      const pos = [], col = [];
      for (const s of strips) for (let i = 0; i + 5 < s.length; i += 3) {
        pos.push(s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5]);
        col.push(...rgb, ...rgb);
      }
      return pos.length ? { type: "lines", line: plot.line, count: pos.length / 3, pos: this.buffer(pos), col: this.buffer(col), alpha: 1, clip: true } : null;
    }

    points(plot, rgb, nx, ny, nz) {
      const pos = [], col = [], strips = [];
      for (const item of plot.items) {
        if (item instanceof Tuple) {
          const [x, y, z = 0] = item.items.map(coord);
          if ([x, y, z].every(Number.isFinite)) { pos.push(nx(x), ny(y), nz(z)); col.push(...rgb); }
        } else if (item instanceof Shape) {
          const s = [];
          for (const p of item.points) if (p instanceof Tuple) { const [x, y, z = 0] = p.items.map(coord); s.push(nx(x), ny(y), nz(z)); }
          if (item.type === "polygon" && s.length >= 6) s.push(s[0], s[1], s[2]);
          strips.push(s);
        }
      }
      const out = [];
      if (pos.length) out.push({ type: "points", line: plot.line, count: pos.length / 3, pos: this.buffer(pos), col: this.buffer(col), size: 9, alpha: 1 });
      const lines = strips.length ? this.lineBatch(plot, strips, rgb) : null;
      if (lines) out.push(lines);
      return out.length === 1 ? out[0] : out.length ? { type: "group", items: out } : null;
    }

    frame() {
      const th = theme();
      const c = th.dark ? [0.55, 0.57, 0.62] : [0.55, 0.55, 0.52];
      const g = th.dark ? [0.25, 0.26, 0.3] : [0.86, 0.85, 0.82];
      const pos = [], col = [], gpos = [], gcol = [];
      const seg = (a, b, color, P = pos, C = col) => { P.push(...a, ...b); C.push(...color, ...color); };
      // bounding box
      const v = [-1, 1];
      for (const y of v) for (const z of v) seg([-1, y, z], [1, y, z], c);
      for (const x of v) for (const z of v) seg([x, -1, z], [x, 1, z], c);
      for (const x of v) for (const y of v) seg([x, y, -1], [x, y, 1], c);
      // floor grid
      for (let i = -1; i <= 1.0001; i += 0.2) { seg([i, -1, -1], [i, 1, -1], g, gpos, gcol); seg([-1, i, -1], [1, i, -1], g, gpos, gcol); }
      // axes through the origin (when inside the box)
      const [nx, ny, nz] = this.normaliser();
      const o = [nx(0), ny(0), nz(0)].map((q) => Math.max(-1, Math.min(1, q)));
      const ax = [[0.86, 0.2, 0.2], [0.2, 0.65, 0.3], [0.2, 0.4, 0.9]];
      seg([-1, o[1], o[2]], [1, o[1], o[2]], ax[0]);
      seg([o[0], -1, o[2]], [o[0], 1, o[2]], ax[1]);
      seg([o[0], o[1], -1], [o[0], o[1], 1], ax[2]);
      return [
        { type: "lines", count: gpos.length / 3, pos: this.buffer(gpos), col: this.buffer(gcol), alpha: 1 },
        { type: "lines", count: pos.length / 3, pos: this.buffer(pos), col: this.buffer(col), alpha: 1 },
      ];
    }

    schedule() {
      if (this.frameReq) return;
      this.frameReq = requestAnimationFrame(() => { this.frameReq = null; this.draw(); });
    }

    setSpin(on) {
      this.spin = on;
      const tick = () => {
        if (!this.spin) return;
        this.yaw += 0.006;
        this.draw();
        requestAnimationFrame(tick);
      };
      if (on) requestAnimationFrame(tick);
    }

    draw() {
      const gl = this.gl;
      const canvas = this.canvas;
      if (!gl || !canvas.isConnected || canvas.offsetParent === null) return;
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.max(1, Math.round(box.width * dpr)), H = Math.max(1, Math.round(box.height * dpr));
      for (const c of [canvas, this.overlay]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      gl.viewport(0, 0, W, H);
      const th = theme();
      const bg = hexToRgb(th.bg.startsWith("#") ? th.bg : th.dark ? "#191917" : "#ffffff");
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const eye = [this.dist * Math.cos(this.pitch) * Math.cos(this.yaw), this.dist * Math.cos(this.pitch) * Math.sin(this.yaw), this.dist * Math.sin(this.pitch)];
      const mvp = mat.mul(mat.perspective(0.7, W / H, 0.1, 50), mat.lookAt(eye, [0, 0, 0], [0, 0, 1]));
      this.mvp = mvp;
      const flat = (list) => list.flatMap((b) => (b.type === "group" ? b.items : [b]));
      const batches = flat(this.batches || []);
      for (const b of this.frameLines || []) this.drawLines(b, mvp, false);
      for (const b of batches.filter((x) => x.type !== "mesh" || x.alpha >= 1)) this.drawBatch(b, mvp, eye);
      gl.depthMask(false);
      for (const b of batches.filter((x) => x.type === "mesh" && x.alpha < 1)) this.drawBatch(b, mvp, eye);
      gl.depthMask(true);
      this.drawLabels(W, H, dpr, th);
    }

    attrib(loc, buffer, size) {
      const gl = this.gl;
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }

    drawBatch(b, mvp, eye) {
      const gl = this.gl;
      if (b.type === "mesh") {
        const p = this.mesh;
        gl.useProgram(p.p);
        gl.uniformMatrix4fv(p.uMVP, false, mvp);
        gl.uniform1f(p.uAlpha, b.alpha * (this.emphasis !== null && this.emphasis !== b.line ? 0.85 : 1));
        gl.uniform3fv(p.uEye, eye);
        this.attrib(p.aPos, b.pos, 3);
        this.attrib(p.aNormal, b.nrm, 3);
        this.attrib(p.aColor, b.col, 3);
        gl.drawArrays(gl.TRIANGLES, 0, b.count);
        return;
      }
      if (b.type === "lines") return this.drawLines(b, mvp, true);
      if (b.type === "points") {
        const p = this.line;
        gl.useProgram(p.p);
        gl.uniformMatrix4fv(p.uMVP, false, mvp);
        gl.uniform1f(p.uAlpha, b.alpha);
        gl.uniform1f(p.uSize, b.size * Math.min(window.devicePixelRatio || 1, 2));
        gl.uniform1f(p.uRound, 1);
        gl.uniform1f(p.uClip, 1);
        this.attrib(p.aPos, b.pos, 3);
        this.attrib(p.aColor, b.col, 3);
        gl.drawArrays(gl.POINTS, 0, b.count);
      }
    }

    drawLines(b, mvp, clip) {
      const gl = this.gl;
      const p = this.line;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.uMVP, false, mvp);
      gl.uniform1f(p.uAlpha, b.alpha);
      gl.uniform1f(p.uSize, 1);
      gl.uniform1f(p.uRound, 0);
      gl.uniform1f(p.uClip, clip ? 1 : 0);
      this.attrib(p.aPos, b.pos, 3);
      this.attrib(p.aColor, b.col, 3);
      gl.drawArrays(gl.LINES, 0, b.count);
    }

    project(p, W, H) {
      const m = this.mvp;
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
      const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return [(x / w * 0.5 + 0.5) * W, (1 - (y / w * 0.5 + 0.5)) * H];
    }

    drawLabels(W, H, dpr, th) {
      const ctx = this.overlay.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = th.label;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const R = this.ranges();
      const [nx, ny, nz] = this.normaliser();
      const tick = (r) => { const s = niceStep((r[1] - r[0]) / 4); const out = []; for (let v = Math.ceil(r[0] / s) * s; v <= r[1] + 1e-9; v += s) out.push([v, s]); return out; };
      for (const [v, s] of tick(R.x)) { const [px, py] = this.project([nx(v), -1.12, -1], W, H); ctx.fillText(fmtTick(v, s), px, py); }
      for (const [v, s] of tick(R.y)) { const [px, py] = this.project([1.12, ny(v), -1], W, H); ctx.fillText(fmtTick(v, s), px, py); }
      for (const [v, s] of tick(R.z)) { const [px, py] = this.project([-1.08, -1.08, nz(v)], W, H); ctx.fillText(fmtTick(v, s), px, py); }
      ctx.font = `600 ${13 * dpr}px system-ui, sans-serif`;
      const names = [["x", [1.25, ny(0), nz(0)], "#dc2626"], ["y", [nx(0), 1.25, nz(0)], "#16a34a"], ["z", [nx(0), ny(0), 1.22], "#2563eb"]];
      for (const [name, p, color] of names) {
        const [px, py] = this.project(p.map((q) => Math.max(-1.3, Math.min(1.3, q))), W, H);
        ctx.fillStyle = color;
        ctx.fillText(name, px, py);
      }
    }
  }

  /* ================================ pane ================================ */

  let host = null;
  let g2 = null, g3 = null;
  let current = { path: null, text: "", result: null };
  let overrides = {};
  let modeChoice = "auto";
  const hiddenByPath = new Map();

  const TEMPLATE = `# 좌표계 파일 (.plot) — 줄마다 식을 쓰면 오른쪽에 바로 그려집니다.
# 숫자만 대입한 변수는 슬라이더가 됩니다. (a = 2 in 0..5 로 범위 지정)
a = 1.5
k = 3 in 1..8

# 함수와 곡선
f(x) = a sin(k x) / x
y = f(x)
y = x^2 / 4 - 2 {-3 < x < 3}
x^2 / 9 + y^2 / 4 = 1
r = 1 + a cos(θ)

# 부등식 영역
y < -abs(x) - 3

# 조건부 함수와 매개변수 곡선
g(x) = if x < 0 then -x else x^2
(4 cos(t), 2 sin(2t))

# 배열과 반복문
P = [(n, sqrt(n)) for n in 0..9]
for c in 1..3 { y = c + 0.1 x^2 @#94a3b8 }

xrange = -10..10
yrange = -7..7
`;

  const TEMPLATE_3D = `# 3차원 좌표계 — x, y, z 세 변수의 관계식을 그대로 씁니다.
dim = 3
a = 1 in 0.2..3

# 세 변수의 음함수 곡면 (구, 토러스 등)
x^2 + y^2 + z^2 = 9 @#2563eb
(sqrt(x^2 + y^2) - 3)^2 + z^2 = a^2 @#e11d48

# 곡면 z = f(x, y)
z = a sin(x) cos(y) - 3 @#16a34a

# 공간 곡선과 점
(4 cos(t), 4 sin(t), t / 2 - 3)
trange = 0..4π
[(k, k, k) for k in -3..3]

xrange = -5..5
yrange = -5..5
zrange = -5..5
`;

  function els() {
    return {
      empty: $("viz-plot-empty"), content: $("viz-plot-content"), stage: $("viz-plot-stage"),
      c2: $("viz-plot-canvas"), gl: $("viz-plot-gl"), overlay: $("viz-plot-overlay"),
      readout: $("viz-plot-readout"), tip: $("viz-plot-tip"), list: $("viz-plot-list"), sliders: $("viz-plot-sliders"),
      file: $("viz-plot-file"), spin: $("viz-plot-spin"),
    };
  }

  function mount(callbacks) {
    host = callbacks;
    const e = els();
    if (!e.stage) return;
    g2 = new Graph2D(e.c2, e.readout, e.tip);
    g3 = new Graph3D(e.gl, e.overlay);
    new ResizeObserver(() => redraw()).observe(e.stage);
    for (const mode of ["auto", "2d", "3d"]) {
      $("viz-plot-mode-" + mode).onclick = () => { modeChoice = mode; render(); };
    }
    $("viz-plot-reset").onclick = () => { g2.resetView(); g3.resetView(); redraw(); };
    $("viz-plot-zoom-in").onclick = () => (is3d() ? (g3.dist = Math.max(1.8, g3.dist / 1.25), g3.schedule()) : g2.zoom(1.25));
    $("viz-plot-zoom-out").onclick = () => (is3d() ? (g3.dist = Math.min(14, g3.dist * 1.25), g3.schedule()) : g2.zoom(1 / 1.25));
    e.spin.onclick = () => { g3.setSpin(!g3.spin); e.spin.setAttribute("aria-pressed", String(g3.spin)); };
    $("viz-plot-png").onclick = savePng;
    for (const [id, text, name] of [["viz-plot-new", TEMPLATE, "graph"], ["viz-plot-new-3d", TEMPLATE_3D, "surface"]]) {
      $(id).onclick = () => createFile(text, name);
    }
    new MutationObserver(() => redraw()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-ide-theme"] });
  }

  async function createFile(text, base) {
    if (!host) return;
    const name = prompt("새 좌표계 파일 이름", `/graphs/${base}.plot`);
    if (!name) return;
    const path = (name.startsWith("/") ? name : "/" + name).replace(/(\.plot)?$/, ".plot");
    await host.runTask(async () => {
      await host.ensureDir(path.slice(0, path.lastIndexOf("/")) || "/");
      await host.writeOrUpdateFile(path, text);
      await host.refreshExplorer();
      await host.openFile(path);
    });
  }

  function is3d() {
    if (modeChoice === "2d") return false;
    if (modeChoice === "3d") return true;
    return Boolean(current.result?.is3d);
  }

  /* Called by the IDE whenever a .plot file is opened or edited. */
  function show(text, context = {}) {
    if (!host) return;
    const path = context.path || null;
    if (path !== current.path) {
      overrides = {};
      current.path = path;
      current.viewSet = false;
      g3?.setSpin(false);
    }
    current.text = text;
    render();
  }

  function render() {
    const e = els();
    if (!e.stage) return;
    e.empty.hidden = Boolean(current.path);
    e.content.hidden = !current.path;
    if (!current.path) return;
    e.file.textContent = current.path.split("/").pop();
    const started = performance.now();
    const result = window.QNBPlotLang.run(current.text, overrides);
    current.result = result;
    const hidden = hiddenByPath.get(current.path) || new Set();
    hiddenByPath.set(current.path, hidden);
    const three = is3d();
    for (const mode of ["auto", "2d", "3d"]) $("viz-plot-mode-" + mode).setAttribute("aria-pressed", String(mode === modeChoice));
    $("viz-plot-mode-auto").textContent = `자동 (${result.is3d ? "3D" : "2D"})`;
    e.spin.hidden = !three;
    e.c2.hidden = three;
    e.gl.hidden = !three;
    e.overlay.hidden = !three;
    e.readout.hidden = three;
    if (three && !g3.gl) e.readout.hidden = false, e.readout.textContent = "이 브라우저는 WebGL을 지원하지 않아 3D를 그릴 수 없습니다.";
    const settingsKey = JSON.stringify(result.settings);
    g2.result = result;
    g2.hidden = hidden;
    if (!current.viewSet || current.settingsKey !== settingsKey) {
      requestAnimationFrame(() => { g2.resetView(); g2.draw(); });
      current.viewSet = true;
      current.settingsKey = settingsKey;
    }
    g3.hidden = hidden;
    if (three) g3.setData(result); else g2.schedule();
    renderSliders(result);
    renderList(result, performance.now() - started);
  }

  function redraw() {
    if (!current.result) return;
    if (is3d()) g3.schedule(); else g2.schedule();
  }

  function renderSliders(result) {
    const box = els().sliders;
    box.hidden = !result.sliders.length;
    const rows = result.sliders.map((s) => {
      const row = document.createElement("div");
      row.className = "viz-plot-slider";
      const label = document.createElement("label");
      label.textContent = s.name;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step || "any");
      input.value = String(s.value);
      input.setAttribute("aria-label", `${s.name} 값`);
      const value = document.createElement("output");
      value.textContent = String(+(+s.value).toPrecision(6));
      input.oninput = () => {
        overrides[s.name] = Number(input.value);
        value.textContent = String(+Number(input.value).toPrecision(6));
        cancelAnimationFrame(renderSliders.frame);
        renderSliders.frame = requestAnimationFrame(() => {
          current.result = window.QNBPlotLang.run(current.text, overrides);
          g2.result = current.result;
          if (is3d()) g3.setData(current.result); else g2.draw();
          renderList(current.result);
          syncSliderValues(current.result);
        });
      };
      const play = document.createElement("button");
      play.type = "button";
      play.className = "viz-plot-mini";
      play.textContent = "▶";
      play.title = "값을 움직이며 애니메이션";
      play.onclick = () => {
        if (row.anim) { cancelAnimationFrame(row.anim); row.anim = null; play.textContent = "▶"; return; }
        play.textContent = "⏸";
        let dir = 1;
        const tick = () => {
          if (!row.isConnected) return;
          let v = Number(input.value) + dir * (s.max - s.min) / 240;
          if (v >= s.max || v <= s.min) { dir = -dir; v = Math.max(s.min, Math.min(s.max, v)); }
          input.value = String(v);
          input.oninput();
          row.anim = requestAnimationFrame(tick);
        };
        row.anim = requestAnimationFrame(tick);
      };
      const save = document.createElement("button");
      save.type = "button";
      save.className = "viz-plot-mini";
      save.textContent = "✎";
      save.title = "현재 값을 파일에 저장";
      save.onclick = () => writeBack(s.name, s.line, Number(input.value));
      row.append(label, input, value, play, save);
      row.dataset.name = s.name;
      return row;
    });
    const same = box.children.length === rows.length && [...box.children].every((r, i) => r.dataset.name === rows[i].dataset.name && !r.anim);
    if (same) {
      // keep the live <input> under the pointer while dragging; just refresh bounds
      [...box.children].forEach((r, i) => {
        const fresh = rows[i].querySelector("input"), live = r.querySelector("input");
        live.min = fresh.min; live.max = fresh.max; live.step = fresh.step;
      });
      return;
    }
    box.replaceChildren(...rows);
  }

  function syncSliderValues() { /* values already shown live by each input */ }

  function writeBack(name, line, value) {
    const lines = current.text.split("\n");
    const text = lines[line - 1];
    if (text === undefined) return;
    const rounded = +value.toPrecision(6);
    const next = text.replace(new RegExp(`^(\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*)-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?`), `$1${rounded}`);
    if (next === text) return;
    delete overrides[name];
    host?.replaceLine?.(current.path, line, next);
  }

  function renderList(result, ms) {
    const box = els().list;
    const hidden = hiddenByPath.get(current.path) || new Set();
    const lines = current.text.split("\n");
    const rows = [];
    lines.forEach((raw, i) => {
      const line = i + 1;
      const text = raw.trim();
      if (!text || text.startsWith("#") || text.startsWith("//")) return;
      const info = result.lineInfo.get(line) || {};
      const error = result.errors.find((err) => err.line === line);
      if (!info.plot && !info.output && !error && !info.slider && !info.defined && !info.setting) {
        if (/^[}\s]*$/.test(text)) return;
      }
      const row = document.createElement("div");
      row.className = "viz-plot-row" + (error ? " has-error" : "") + (g2.emphasis === line ? " active" : "");
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "viz-plot-swatch";
      const plotsHere = result.plots.filter((p) => p.line === line);
      if (plotsHere.length) {
        const color = colorOf(plotsHere[0]);
        swatch.style.setProperty("--swatch", color);
        swatch.classList.toggle("off", hidden.has(line));
        swatch.title = hidden.has(line) ? "그래프 보이기" : "그래프 숨기기";
        swatch.onclick = (ev) => {
          ev.stopPropagation();
          if (hidden.has(line)) hidden.delete(line); else hidden.add(line);
          render();
        };
      } else {
        swatch.disabled = true;
        swatch.classList.add("none");
      }
      const num = document.createElement("span");
      num.className = "viz-plot-line";
      num.textContent = String(line);
      const code = document.createElement("code");
      code.textContent = text;
      const meta = document.createElement("span");
      meta.className = "viz-plot-meta";
      if (error) meta.textContent = error.message;
      else if (info.output) meta.textContent = "= " + info.output;
      else if (plotsHere.length) meta.textContent = kindLabel(plotsHere[0].kind) + (plotsHere.length > 1 ? ` ×${plotsHere.length}` : "");
      else if (info.slider) meta.textContent = "슬라이더";
      else if (info.defined) meta.textContent = "함수 정의";
      row.append(swatch, num, code, meta);
      row.onclick = () => host?.openAndJump(current.path, line);
      rows.push(row);
    });
    if (ms !== undefined) {
      const foot = document.createElement("div");
      foot.className = "viz-plot-foot";
      foot.textContent = `그래프 ${result.plots.length}개 · 오류 ${result.errors.length}개 · ${ms.toFixed(0)}ms`;
      rows.push(foot);
    }
    box.replaceChildren(...rows);
  }

  function kindLabel(kind) {
    return { explicit: "곡선", implicit: "음함수 곡선", region: "부등식 영역", polar: "극좌표 곡선", param: "매개변수 곡선", points: "점 · 도형", surface: "곡면 z = f(x, y)", implicit3: "음함수 곡면 (3변수)", region3: "3차원 영역", param3: "공간 곡선", paramSurface: "매개변수 곡면" }[kind] || kind;
  }

  /* Cursor on line N in the editor → emphasise that line's graph. */
  function highlightLine(path, line) {
    if (!current.result || path !== current.path) return;
    const has = current.result.plots.some((p) => p.line === line);
    const next = has ? line : null;
    if (g2.emphasis === next) return;
    g2.emphasis = next;
    g3.emphasis = next;
    redraw();
    for (const row of els().list.querySelectorAll(".viz-plot-row")) {
      row.classList.toggle("active", Number(row.querySelector(".viz-plot-line")?.textContent) === line);
    }
  }

  function savePng() {
    const canvas = is3d() ? (() => {
      g3.draw();
      const out = document.createElement("canvas");
      out.width = g3.canvas.width; out.height = g3.canvas.height;
      const ctx = out.getContext("2d");
      ctx.drawImage(g3.canvas, 0, 0);
      ctx.drawImage(g3.overlay, 0, 0);
      return out;
    })() : g2.canvas;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = (current.path?.split("/").pop() || "graph").replace(/\.plot$/, "") + ".png";
    a.click();
  }

  return { mount, show, highlightLine, redraw, get current() { return current; }, TEMPLATE, TEMPLATE_3D };
})();
