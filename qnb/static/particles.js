"use strict";

window.QNBParticles = (() => {
  let canvas = null;
  let ctx = null;
  let scrollTrackEl = null;
  let washEl = null;
  let chapterPanels = [];
  let hudChapterBtns = [];

  const LIGHT_INK_TONES = [
    { r: 20, g: 20, b: 19 },
    { r: 46, g: 45, b: 42 },
    { r: 94, g: 92, b: 86 },
    { r: 150, g: 146, b: 136 },
  ];
  const DARK_INK_TONES = [
    { r: 245, g: 243, b: 238 },
    { r: 214, g: 210, b: 200 },
    { r: 164, g: 160, b: 150 },
    { r: 118, g: 114, b: 106 },
  ];
  const WEATHER_ACCENTS = {
    clear: { r: 245, g: 158, b: 11 },
    partly: { r: 56, g: 189, b: 248 },
    cloudy: { r: 148, g: 163, b: 184 },
    rain: { r: 59, g: 130, b: 246 },
    snow: { r: 125, g: 211, b: 252 },
    thunder: { r: 139, g: 92, b: 246 },
    fog: { r: 148, g: 163, b: 184 },
    night: { r: 129, g: 140, b: 248 },
  };
  const isDarkTheme = () => document.documentElement.dataset.ideTheme === "dark";

  const CHAPTER_META = [
    { cxRatio: 0.72, textSide: "left" },
    { cxRatio: 0.28, textSide: "right" },
    { cxRatio: 0.72, textSide: "left" },
    { cxRatio: 0.28, textSide: "right" },
    { cxRatio: 0.72, textSide: "left" },
    { cxRatio: 0.28, textSide: "right" },
  ];

  const TOTAL_UNITS = 5.8;
  let vw = 1024;
  let vh = 768;
  let dpr = 1;
  let sandParticles = [];
  let dustSpecks = [];
  let shapes = [];
  let shapeAnchors = [];
  let labField = [];
  let customShape = null;
  let geoGraphNodes = [];
  let geoRadar = null;

  let targetP = 0;
  let smoothedP = 0;
  let customBlendTarget = 0;
  let customBlend = 0;
  let customText = null;
  let focusView = false;

  let lastScrollY = 0;
  let scrollVel = 0;
  let smoothDir = 1;
  let scatterGust = 0;
  let scatterDirX = 1;

  let running = false;
  let rafId = 0;
  let bound = false;
  let resizeTimer = null;

  const pointer = { x: -9999, y: -9999, active: false, radius: 118 };

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function getParticleCount(width) {
    return width >= 900 ? 2200 : 1050;
  }

  function pickInkTone(rng, darkBias, weatherAccent = false) {
    const wx = document.documentElement.dataset.weather;
    if (weatherAccent && wx && WEATHER_ACCENTS[wx] && rng() < 0.42) {
      return WEATHER_ACCENTS[wx];
    }
    const tones = isDarkTheme() ? DARK_INK_TONES : LIGHT_INK_TONES;
    const roll = rng();
    if (roll < darkBias) return tones[0];
    if (roll < darkBias + 0.34) return tones[1];
    if (roll < darkBias + 0.72) return tones[2];
    return tones[3];
  }

  function getAnchorForChapter(idx) {
    const cfg = CHAPTER_META[idx] || CHAPTER_META[0];
    if (vw >= 900) {
      return { cx: vw * cfg.cxRatio, cy: vh * 0.52, scale: Math.min(vw * 0.4, vh * 0.58, 440) };
    }
    return { cx: vw * 0.5, cy: vh * 0.31, scale: Math.min(vw * 0.78, vh * 0.32, 260) };
  }

  function sortCohesively(points, anchor, seed) {
    const rng = mulberry32(seed);
    const invS = 1 / Math.max(1, anchor.scale);
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const nx = (pt.x - anchor.cx) * invS;
      const ny = (pt.y - anchor.cy) * invS;
      const ang = Math.atan2(ny, nx);
      pt._sortKey = ny * 2.0 + nx * 0.45 + ang * 0.16 + (rng() - 0.5) * 0.12;
    }
    points.sort((a, b) => a._sortKey - b._sortKey);
    return points;
  }

  function sampleTextShape(text, count, anchor, ringMode, seed, useSerif) {
    const rng = mulberry32(seed);
    const { cx, cy, scale } = anchor;
    const pts = [];
    try {
      const off = document.createElement("canvas");
      const octx = off.getContext("2d");
      const boxW = Math.max(240, Math.floor(scale * 1.46));
      const boxH = Math.max(120, Math.floor(scale * 0.64));
      off.width = boxW;
      off.height = boxH;
      const len = Math.max(1, text.length);
      let fontSize = Math.min(Math.floor(boxW / (len * 0.62)), Math.floor(boxH * 0.78), 156);
      fontSize = Math.max(fontSize, 26);
      const makeFont = (sz) =>
        useSerif
          ? `700 ${sz}px "Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Nanum Myeongjo", Georgia, serif`
          : `800 ${sz}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif`;
      octx.clearRect(0, 0, boxW, boxH);
      octx.fillStyle = "#141413";
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.font = makeFont(fontSize);
      while (octx.measureText(text).width > boxW * 0.86 && fontSize > 18) {
        fontSize -= 3;
        octx.font = makeFont(fontSize);
      }
      octx.fillText(text, boxW / 2, boxH / 2);
      const img = octx.getImageData(0, 0, boxW, boxH).data;
      const step = 3;
      for (let y = 0; y < boxH; y += step) {
        for (let x = 0; x < boxW; x += step) {
          if (img[(y * boxW + x) * 4 + 3] > 110) {
            pts.push({
              x: cx - boxW / 2 + x + (rng() - 0.5) * 1.15,
              y: cy - boxH / 2 + y + (rng() - 0.5) * 1.15,
            });
          }
        }
      }
    } catch {
      for (let i = 0; i < 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        pts.push({ x: cx + Math.cos(a) * scale * 0.34, y: cy + Math.sin(a) * scale * 0.34 });
      }
    }
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }

    const targets = [];
    const auxRatio = ringMode === "vortex" ? 0.36 : ringMode === "orbitNodes" ? 0.32 : 0.14;
    const auxCount = Math.floor(count * auxRatio);
    const mainCount = count - auxCount;

    for (let i = 0; i < mainCount; i++) {
      const p = pts.length > 0 ? pts[i % pts.length] : { x: cx, y: cy };
      const tone = pickInkTone(rng, 0.62);
      targets.push({ x: p.x, y: p.y, size: 1.0 + rng() * 1.15, r: tone.r, g: tone.g, b: tone.b, alpha: 0.88, role: "text" });
    }

    for (let i = 0; i < auxCount; i++) {
      if (ringMode === "orbitNodes") {
        const dotBudget = Math.floor(auxCount * 0.24);
        const rx = scale * 0.6;
        const ry = scale * 0.3;
        const tilt = -0.22;
        if (i < dotBudget) {
          const nodeIdx = i % 5;
          const baseAngle = (nodeIdx / 5) * Math.PI * 2;
          const jx = (rng() - 0.5) * 10;
          const jy = (rng() - 0.5) * 10;
          const ox = Math.cos(baseAngle) * rx + jx;
          const oy = Math.sin(baseAngle) * ry + jy;
          const tone = pickInkTone(rng, 0.9, true);
          targets.push({
            x: cx + ox * Math.cos(tilt) - oy * Math.sin(tilt),
            y: cy + ox * Math.sin(tilt) + oy * Math.cos(tilt),
            size: 1.35 + rng() * 0.8,
            r: tone.r, g: tone.g, b: tone.b, alpha: 0.92,
            role: "orbitDot", cx, cy, angle: baseAngle, rx, ry, tilt, jx, jy,
          });
        } else {
          const a = ((i - dotBudget) / Math.max(1, auxCount - dotBudget)) * Math.PI * 2 + rng() * 0.06;
          const tier = i % 2;
          const rrx = scale * (0.6 + tier * 0.11);
          const rry = scale * (0.3 + tier * 0.07);
          const tTilt = tier === 0 ? -0.22 : 0.2;
          const ox = Math.cos(a) * rrx;
          const oy = Math.sin(a) * rry;
          const tone = pickInkTone(rng, tier === 0 ? 0.35 : 0.14, true);
          targets.push({
            x: cx + ox * Math.cos(tTilt) - oy * Math.sin(tTilt),
            y: cy + ox * Math.sin(tTilt) + oy * Math.cos(tTilt),
            size: 0.8 + rng() * 0.85,
            r: tone.r, g: tone.g, b: tone.b, alpha: tier === 0 ? 0.62 : 0.4,
            role: "orbit", cx, cy, angle: a, rx: rrx, ry: rry, tilt: tTilt, tier,
          });
        }
      } else if (ringMode === "vortex") {
        const tier = i % 3;
        const a = (i / auxCount) * Math.PI * 2 * 3 + rng() * 0.08;
        const rad = scale * (0.45 + tier * 0.115) + (rng() - 0.5) * 7;
        const tone = pickInkTone(rng, tier === 0 ? 0.5 : 0.18, true);
        targets.push({
          x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad * 0.88,
          size: 0.85 + rng() * 0.95, r: tone.r, g: tone.g, b: tone.b, alpha: 0.72 - tier * 0.14,
          role: "vortex", cx, cy, angle: a, rx: rad, ry: rad * 0.88, tier,
        });
      } else {
        const a = rng() * Math.PI * 2;
        const rad = scale * (0.5 + rng() * 0.34);
        const tone = pickInkTone(rng, 0.12, true);
        targets.push({
          x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad * 0.72,
          size: 0.75 + rng() * 0.7, r: tone.r, g: tone.g, b: tone.b, alpha: 0.32, role: "ambient",
        });
      }
    }
    return sortCohesively(targets, anchor, seed + 17);
  }

  function samplePentagonGraphShape(count, anchor, seed) {
    const rng = mulberry32(seed);
    const { cx, cy, scale } = anchor;
    const labels = ["LINE", "STACK", "HEAP", "GRAPH", "FLOW"];
    const ringR = scale * 0.38;
    const nodeR = Math.max(14, Math.min(24, scale * 0.064));
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / 5;
      nodes.push({ x: cx + Math.cos(ang) * ringR, y: cy - scale * 0.04 + Math.sin(ang) * ringR * 0.86, r: nodeR, label: labels[i] });
    }
    geoGraphNodes = nodes;

    const targets = [];
    const perNode = Math.floor((count * 0.48) / 5);
    const edgeCount = Math.floor(count * 0.26);
    const feedbackCount = Math.floor(count * 0.18);

    for (let n = 0; n < 5; n++) {
      const nd = nodes[n];
      for (let i = 0; i < perNode; i++) {
        const a = (i / perNode) * Math.PI * 2 + rng() * 0.1;
        const isCore = i % 5 === 0;
        const rr = isCore ? rng() * nd.r * 0.42 : nd.r * (0.86 + rng() * 0.2);
        const tone = pickInkTone(rng, isCore ? 0.85 : 0.48);
        targets.push({ x: nd.x + Math.cos(a) * rr, y: nd.y + Math.sin(a) * rr, size: isCore ? 1.45 : 0.95 + rng() * 0.8, r: tone.r, g: tone.g, b: tone.b, alpha: 0.88, role: "shape" });
      }
    }
    for (let i = 0; i < edgeCount; i++) {
      const seg = i % 5;
      const a = nodes[seg];
      const b = nodes[(seg + 1) % 5];
      const fT = (Math.floor(i / 5) / Math.max(1, edgeCount / 5)) % 1;
      const tone = pickInkTone(rng, 0.58);
      targets.push({ x: lerp(a.x, b.x, fT), y: lerp(a.y, b.y, fT), size: 1.0 + rng() * 0.7, r: tone.r, g: tone.g, b: tone.b, alpha: 0.76, role: "edgeFlow", seg, flowT: fT });
    }
    for (let i = 0; i < feedbackCount; i++) {
      const outer = i % 2 === 0;
      const sN = outer ? nodes[3] : nodes[2];
      const eN = outer ? nodes[4] : nodes[1];
      const p0 = { x: sN.x, y: sN.y + nodeR * 0.8 };
      const p1 = { x: cx, y: cy + scale * (outer ? 0.58 : 0.42) };
      const p2 = { x: eN.x, y: eN.y + nodeR * 0.8 };
      const fT = i / feedbackCount;
      const inv = 1 - fT;
      const tone = pickInkTone(rng, outer ? 0.45 : 0.2, true);
      targets.push({
        x: inv * inv * p0.x + 2 * inv * fT * p1.x + fT * fT * p2.x,
        y: inv * inv * p0.y + 2 * inv * fT * p1.y + fT * fT * p2.y,
        size: 0.9 + rng() * 0.75, r: tone.r, g: tone.g, b: tone.b, alpha: outer ? 0.74 : 0.56, role: "arcFlow", flowT: fT, p0, p1, p2,
      });
    }
    while (targets.length < count) {
      const tone = pickInkTone(rng, 0.1, true);
      targets.push({ x: cx + (rng() - 0.5) * scale * 1.15, y: cy + (rng() - 0.5) * scale * 0.92, size: 0.75 + rng() * 0.65, r: tone.r, g: tone.g, b: tone.b, alpha: 0.28, role: "ambient" });
    }
    return sortCohesively(targets, anchor, seed + 17);
  }

  function sampleRdbCylinderShape(count, anchor, seed) {
    const rng = mulberry32(seed);
    const { cx, cy, scale } = anchor;
    const targets = [];
    const dbCx = cx - scale * 0.14;
    const dbCy = cy - scale * 0.02;
    const rx = scale * 0.29;
    const ry = rx * 0.34;
    const cylH = scale * 0.54;
    const topY = dbCy - cylH / 2;
    const platterCount = Math.floor(count * 0.46);
    const rowRibCount = Math.floor(count * 0.24);
    const badgeCount = Math.floor(count * 0.22);

    for (let i = 0; i < platterCount; i++) {
      const tier = i % 4;
      let x, y, tone;
      if (tier === 0) {
        const a = rng() * Math.PI * 2;
        const isRim = i % 3 !== 0;
        const rf = isRim ? 0.95 + rng() * 0.06 : Math.sqrt(rng()) * 0.86;
        x = dbCx + Math.cos(a) * rx * rf;
        y = topY + Math.sin(a) * ry * rf;
        tone = pickInkTone(rng, isRim ? 0.76 : 0.28);
      } else {
        const frac = tier / 3;
        const a = rng() * Math.PI;
        x = dbCx + Math.cos(a) * rx;
        y = topY + cylH * frac + Math.sin(a) * ry;
        tone = pickInkTone(rng, 0.58);
      }
      targets.push({ x, y, size: 0.95 + rng() * 0.95, r: tone.r, g: tone.g, b: tone.b, alpha: 0.86, role: "shape" });
    }
    const ribPos = [-1.0, -0.5, 0.0, 0.5, 1.0];
    for (let i = 0; i < rowRibCount; i++) {
      const rp = ribPos[i % ribPos.length];
      const isOuter = Math.abs(rp) === 1.0;
      const x = dbCx + rp * rx + (rng() - 0.5) * 1.5;
      const yOff = Math.sqrt(Math.max(0, 1 - rp * rp)) * ry;
      const y = topY + yOff + rng() * cylH;
      const tone = pickInkTone(rng, isOuter ? 0.9 : 0.2);
      targets.push({ x, y, size: isOuter ? 1.2 : 0.85, r: tone.r, g: tone.g, b: tone.b, alpha: isOuter ? 0.86 : 0.52, role: "shape" });
    }
    const bx = cx + scale * 0.27;
    const by = cy + scale * 0.14;
    const br = scale * 0.17;
    for (let i = 0; i < badgeCount; i++) {
      const m = i % 5;
      let x, y;
      if (m < 3) {
        const a = (i / badgeCount) * Math.PI * 2 * 3;
        const rr = br * (0.94 + rng() * 0.08);
        x = bx + Math.cos(a) * rr;
        y = by + Math.sin(a) * rr;
      } else if (m === 3) {
        const f = rng();
        x = bx - br * 0.38 + f * br * 0.28;
        y = by + br * 0.02 + f * br * 0.28;
      } else {
        const f = rng();
        x = bx - br * 0.1 + f * br * 0.54;
        y = by + br * 0.3 - f * br * 0.58;
      }
      const tone = pickInkTone(rng, 0.95, true);
      targets.push({ x, y, size: 1.1 + rng() * 0.75, r: tone.r, g: tone.g, b: tone.b, alpha: 0.9, role: "shape" });
    }
    while (targets.length < count) {
      const tone = pickInkTone(rng, 0.1, true);
      targets.push({ x: cx + (rng() - 0.5) * scale * 1.18, y: cy + (rng() - 0.5) * scale * 0.84, size: 0.75 + rng() * 0.65, r: tone.r, g: tone.g, b: tone.b, alpha: 0.28, role: "ambient" });
    }
    return sortCohesively(targets, anchor, seed + 17);
  }

  function sampleAstShieldShape(count, anchor, seed) {
    const rng = mulberry32(seed);
    const { cx, cy, scale } = anchor;
    const targets = [];
    const rawText = sampleTextShape("DAG", Math.floor(count * 0.34), { cx, cy: cy - scale * 0.14, scale: scale * 0.52 }, "none", seed + 3, true);
    for (const pt of rawText) if (pt.role === "text") targets.push(pt);

    const hexR = scale * 0.49;
    const verts = [];
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 3;
      verts.push({ x: cx + Math.cos(a) * hexR, y: cy + Math.sin(a) * hexR });
    }
    const hexCount = Math.floor(count * 0.34);
    for (let i = 0; i < hexCount; i++) {
      const seg = i % 6;
      const a = verts[seg];
      const b = verts[(seg + 1) % 6];
      const f = rng();
      const inner = i % 4 === 0 ? 0.88 : 1.0;
      const tone = pickInkTone(rng, inner === 1.0 ? 0.7 : 0.2);
      targets.push({
        x: cx + (lerp(a.x, b.x, f) - cx) * inner,
        y: cy + (lerp(a.y, b.y, f) - cy) * inner,
        size: inner === 1.0 ? 1.15 : 0.8, r: tone.r, g: tone.g, b: tone.b, alpha: inner === 1.0 ? 0.86 : 0.48, role: "shape",
      });
    }
    const root = { x: cx, y: cy + scale * 0.04 };
    const mids = [{ x: cx - scale * 0.18, y: cy + scale * 0.18 }, { x: cx + scale * 0.18, y: cy + scale * 0.18 }];
    const leaves = [
      { x: cx - scale * 0.28, y: cy + scale * 0.32 }, { x: cx - scale * 0.08, y: cy + scale * 0.32 },
      { x: cx + scale * 0.08, y: cy + scale * 0.32 }, { x: cx + scale * 0.28, y: cy + scale * 0.32 },
    ];
    const edges = [[root, mids[0]], [root, mids[1]], [mids[0], leaves[0]], [mids[0], leaves[1]], [mids[1], leaves[2]], [mids[1], leaves[3]]];
    const allNodes = [root, ...mids, ...leaves];
    const treeCount = Math.floor(count * 0.26);
    for (let i = 0; i < treeCount; i++) {
      if (i % 3 === 0) {
        const nd = allNodes[i % allNodes.length];
        const a = rng() * Math.PI * 2;
        const r = rng() * 8.5;
        const tone = pickInkTone(rng, 0.9, true);
        targets.push({ x: nd.x + Math.cos(a) * r, y: nd.y + Math.sin(a) * r, size: 1.3, r: tone.r, g: tone.g, b: tone.b, alpha: 0.9, role: "shape" });
      } else {
        const br = edges[i % edges.length];
        const f = rng();
        const tone = pickInkTone(rng, 0.45);
        targets.push({ x: lerp(br[0].x, br[1].x, f), y: lerp(br[0].y, br[1].y, f), size: 0.95, r: tone.r, g: tone.g, b: tone.b, alpha: 0.76, role: "shape" });
      }
    }
    while (targets.length < count) {
      const v = verts[targets.length % 6];
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 24;
      const tone = pickInkTone(rng, 0.1, true);
      targets.push({ x: v.x + Math.cos(a) * r, y: v.y + Math.sin(a) * r, size: 0.75, r: tone.r, g: tone.g, b: tone.b, alpha: 0.28, role: "ambient" });
    }
    return sortCohesively(targets, anchor, seed + 17);
  }

  function sampleDocsRadarShape(count, anchor, seed) {
    const rng = mulberry32(seed);
    const { cx, cy, scale } = anchor;
    const targets = [];
    const rawText = sampleTextShape("MCP", Math.floor(count * 0.36), { cx, cy, scale: scale * 0.54 }, "none", seed + 5, true);
    for (const pt of rawText) if (pt.role === "text") targets.push(pt);
    const outerR = scale * 0.5;
    geoRadar = { cx, cy, r: outerR };
    const ringCount = Math.floor(count * 0.44);
    for (let i = 0; i < ringCount; i++) {
      const tier = i % 3;
      const a = (i / ringCount) * Math.PI * 2 * 3;
      const rad = outerR * (0.6 + tier * 0.2);
      const tone = pickInkTone(rng, tier === 2 ? 0.56 : 0.24, true);
      targets.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, size: 0.85 + rng() * 0.85, r: tone.r, g: tone.g, b: tone.b, alpha: 0.74 - (2 - tier) * 0.14, role: "radarRing", cx, cy, angle: a, rx: rad, ry: rad, tier });
    }
    const tickCount = Math.floor(count * 0.14);
    for (let i = 0; i < tickCount; i++) {
      const ang = ((i % 4) * Math.PI) / 2;
      const rad = outerR * (0.92 + rng() * 0.24);
      const tone = pickInkTone(rng, 0.9);
      targets.push({ x: cx + Math.cos(ang) * rad + (rng() - 0.5) * 2.0, y: cy + Math.sin(ang) * rad + (rng() - 0.5) * 2.0, size: 1.05, r: tone.r, g: tone.g, b: tone.b, alpha: 0.82, role: "shape" });
    }
    while (targets.length < count) {
      const a = rng() * Math.PI * 2;
      const rad = outerR * (1.06 + rng() * 0.28);
      const tone = pickInkTone(rng, 0.1, true);
      targets.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, size: 0.75, r: tone.r, g: tone.g, b: tone.b, alpha: 0.26, role: "ambient" });
    }
    return sortCohesively(targets, anchor, seed + 17);
  }

  function sampleCalmDustField(count, seed) {
    const rng = mulberry32(seed);
    const pts = [];
    for (let i = 0; i < count; i++) {
      const tone = pickInkTone(rng, 0.18);
      pts.push({ x: rng() * vw, y: rng() * vh, size: 0.75 + rng() * 1.0, r: tone.r, g: tone.g, b: tone.b, alpha: 0.34, role: "ambient" });
    }
    return sortCohesively(pts, { cx: vw * 0.5, cy: vh * 0.5, scale: Math.max(vw, vh) }, seed + 19);
  }

  function precomputeAllShapes() {
    const count = sandParticles.length;
    shapeAnchors = CHAPTER_META.map((_, i) => getAnchorForChapter(i));
    shapes = [
      sampleTextShape("QNB", count, shapeAnchors[0], "orbitNodes", 101, true),
      sampleTextShape("LEAN4", count, shapeAnchors[1], "vortex", 202, true),
      samplePentagonGraphShape(count, shapeAnchors[2], 303),
      sampleRdbCylinderShape(count, shapeAnchors[3], 404),
      sampleAstShieldShape(count, shapeAnchors[4], 505),
      sampleDocsRadarShape(count, shapeAnchors[5], 606),
    ];
    labField = sampleCalmDustField(count, 707);
    if (customText) {
      const nearest = clamp(Math.round(smoothedP), 0, 5);
      const anchor = smoothedP > 5.2 ? { cx: vw * 0.5, cy: vh * 0.48, scale: Math.min(vw * 0.48, vh * 0.52, 420) } : shapeAnchors[nearest];
      customShape = sampleTextShape(customText, count, anchor, "orbitNodes", 909, true);
    }
  }

  function initParticles() {
    const count = getParticleCount(vw);
    const rng = mulberry32(2026);
    sandParticles = [];
    for (let i = 0; i < count; i++) {
      sandParticles.push({
        x: vw * 0.72, y: vh * 0.52, px: vw * 0.72, py: vh * 0.52, vx: 0, vy: 0,
        r: 20, g: 20, b: 19, alpha: 0.85, size: 1.0,
        phase: rng() * 0.38, arcHeight: (rng() * 2 - 1) * 118, windAmp: 48 + rng() * 96,
        noiseSeed: rng() * Math.PI * 20, shimmerPhase: rng() * Math.PI * 2,
      });
    }
    dustSpecks = [];
    for (let i = 0; i < 120; i++) {
      dustSpecks.push({
        x: rng() * vw, y: rng() * vh, vx: 0.12 + rng() * 0.28, vy: (rng() - 0.5) * 0.16,
        size: 0.6 + rng() * 0.9, alpha: 0.08 + rng() * 0.18, phase: rng() * Math.PI * 2,
      });
    }
    precomputeAllShapes();
    const s0 = shapes[0];
    for (let i = 0; i < sandParticles.length; i++) {
      const p = sandParticles[i];
      const t = s0[i];
      p.x = t.x; p.y = t.y; p.px = t.x; p.py = t.y;
      p.r = t.r; p.g = t.g; p.b = t.b; p.size = t.size; p.alpha = t.alpha;
    }
  }

  function getMorphSpan() {
    const trackH = scrollTrackEl ? scrollTrackEl.offsetHeight : vh * 9.2;
    return Math.max(1, trackH - vh);
  }

  function readScrollProgress() {
    if (!running || !scrollTrackEl) return;
    const y = window.scrollY || 0;
    const trackTop = scrollTrackEl.offsetTop || 0;
    const morphSpan = getMorphSpan();
    const relY = y - trackTop;
    const maxDoc = Math.max(1, document.documentElement.scrollHeight - vh);
    const docPct = clamp((y / maxDoc) * 100, 0, 100);
    const navFill = document.getElementById("nav-progress-fill");
    if (navFill) navFill.style.width = `${docPct.toFixed(2)}%`;
    targetP = clamp((relY / morphSpan) * TOTAL_UNITS, 0, TOTAL_UNITS);
  }

  function resizeCanvasSafely() {
    if (!canvas || !ctx) return;
    vw = Math.max(300, window.innerWidth || 1024);
    vh = Math.max(300, window.innerHeight || 768);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sandParticles.length !== getParticleCount(vw)) initParticles();
    else precomputeAllShapes();
    readScrollProgress();
  }

  function evalTargetPoint(pt, tSec) {
    let x = pt.x;
    let y = pt.y;
    if (pt.role === "orbit") {
      const dir = pt.tier === 0 ? 1 : -1;
      const a = pt.angle + tSec * 0.24 * dir;
      const ox = Math.cos(a) * pt.rx;
      const oy = Math.sin(a) * pt.ry;
      x = pt.cx + ox * Math.cos(pt.tilt) - oy * Math.sin(pt.tilt);
      y = pt.cy + ox * Math.sin(pt.tilt) + oy * Math.cos(pt.tilt);
    } else if (pt.role === "orbitDot") {
      const a = pt.angle + tSec * 0.24;
      const ox = Math.cos(a) * pt.rx + pt.jx;
      const oy = Math.sin(a) * pt.ry + pt.jy;
      x = pt.cx + ox * Math.cos(pt.tilt) - oy * Math.sin(pt.tilt);
      y = pt.cy + ox * Math.sin(pt.tilt) + oy * Math.cos(pt.tilt);
    } else if (pt.role === "vortex") {
      const pulse = 1 + Math.sin(tSec * 2.0 - pt.tier) * 0.055;
      const a = pt.angle + tSec * (pt.tier % 2 === 0 ? 0.26 : -0.2);
      x = pt.cx + Math.cos(a) * pt.rx * pulse;
      y = pt.cy + Math.sin(a) * pt.ry * pulse;
    } else if (pt.role === "edgeFlow" && geoGraphNodes.length === 5) {
      const fT = (pt.flowT + tSec * 0.2) % 1;
      const a = geoGraphNodes[pt.seg];
      const b = geoGraphNodes[(pt.seg + 1) % 5];
      x = lerp(a.x, b.x, fT);
      y = lerp(a.y, b.y, fT);
    } else if (pt.role === "arcFlow" && pt.p0) {
      const fT = (pt.flowT + tSec * 0.16) % 1;
      const inv = 1 - fT;
      x = inv * inv * pt.p0.x + 2 * inv * fT * pt.p1.x + fT * fT * pt.p2.x;
      y = inv * inv * pt.p0.y + 2 * inv * fT * pt.p1.y + fT * fT * pt.p2.y;
    } else if (pt.role === "radarRing") {
      const pulse = 1 + Math.sin(tSec * 1.8 - pt.tier * 0.9) * 0.03;
      const a = pt.angle + tSec * (0.15 - pt.tier * 0.035);
      x = pt.cx + Math.cos(a) * pt.rx * pulse;
      y = pt.cy + Math.sin(a) * pt.ry * pulse;
    }
    return { x, y };
  }

  function updateEditorialChrome(idxA, idxB, morphT, labBlend) {
    const chapterVisMult = 1 - smoothstep(0.02, 0.45, labBlend);
    const isInBelow = labBlend > 0.35;
    document.body.classList.toggle("in-below", isInBelow);

    for (let i = 0; i < chapterPanels.length; i++) {
      const panel = chapterPanels[i];
      const delta = smoothedP - i;
      const dist = Math.abs(delta);
      if (dist > 0.48 || chapterVisMult <= 0.01) {
        panel.style.opacity = "0";
        panel.style.visibility = "hidden";
        panel.style.pointerEvents = "none";
        const yOff = delta > 0 ? -24 : 24;
        panel.style.transform = vw >= 900 ? `translate3d(0, calc(-50% + ${yOff}px), 0)` : `translate3d(0, ${yOff}px, 0)`;
      } else {
        const vis = (1 - smoothstep(0.1, 0.48, dist)) * chapterVisMult;
        const yOff = clamp(-delta * 52, -24, 24);
        panel.style.opacity = vis.toFixed(3);
        panel.style.visibility = "visible";
        panel.style.pointerEvents = vis > 0.55 && !focusView ? "auto" : "none";
        panel.style.transform = vw >= 900
          ? `translate3d(0, calc(-50% + ${yOff.toFixed(1)}px), 0)`
          : `translate3d(0, ${(yOff * 0.5).toFixed(1)}px, 0)`;
      }
    }

    if (washEl) {
      if (vw >= 900 && !focusView) {
        const wRgb = isDarkTheme() ? "20,20,19" : "250,249,246";
        const cosV = Math.cos(clamp(smoothedP, 0, 5) * Math.PI);
        const leftW = Math.max(0, cosV) * chapterVisMult;
        const rightW = Math.max(0, -cosV) * chapterVisMult;
        if (leftW > 0.02) {
          washEl.style.background = `linear-gradient(90deg, rgba(${wRgb},${(0.92 * leftW).toFixed(2)}) 0%, rgba(${wRgb},${(0.56 * leftW).toFixed(2)}) 40%, rgba(${wRgb},0) 62%)`;
        } else if (rightW > 0.02) {
          washEl.style.background = `linear-gradient(270deg, rgba(${wRgb},${(0.92 * rightW).toFixed(2)}) 0%, rgba(${wRgb},${(0.56 * rightW).toFixed(2)}) 40%, rgba(${wRgb},0) 62%)`;
        } else {
          washEl.style.background = "none";
        }
      } else {
        washEl.style.background = "none";
      }
    }

    const pad2 = (n) => String(n).padStart(2, "0");
    const nearest = clamp(Math.round(smoothedP), 0, 5);
    const chPct = clamp((smoothedP / 5) * 100, 0, 100);
    const navPill = document.getElementById("nav-morph-pill");
    if (navPill) {
      if (customBlend > 0.25 && customText) navPill.textContent = `CUSTOM · "${customText}"`;
      else if (isInBelow) navPill.textContent = "LAB · AMBIENT";
      else if (morphT > 0.02 && morphT < 0.98) {
        const pct = Math.round(morphT * 100);
        navPill.textContent = smoothDir < -0.12
          ? `${pad2(idxB + 1)} → ${pad2(idxA + 1)} · ${100 - pct}%`
          : `${pad2(idxA + 1)} → ${pad2(idxB + 1)} · ${pct}%`;
      } else {
        navPill.textContent = `${pad2((morphT >= 0.98 ? idxB : idxA) + 1)} / 06 · LOCKED`;
      }
    }
    const hudFill = document.getElementById("hud-ch-fill");
    if (hudFill) hudFill.style.width = `${chPct.toFixed(1)}%`;
    hudChapterBtns.forEach((btn) => btn.classList.toggle("active", !isInBelow && Number(btn.dataset.jump) === nearest));
  }

  function animate(now) {
    if (!running || !ctx) return;
    rafId = window.requestAnimationFrame(animate);
    const tSec = now * 0.001;
    const currY = window.scrollY || 0;
    const deltaY = clamp(currY - lastScrollY, -75, 75);
    lastScrollY = currY;
    scrollVel = scrollVel * 0.8 + deltaY * 0.26;

    const pDiff = targetP - smoothedP;
    smoothedP += pDiff * 0.075;
    if (Math.abs(pDiff) > 0.0006) smoothDir = lerp(smoothDir, clamp(pDiff * 24, -1, 1), 0.14);

    customBlend += (customBlendTarget - customBlend) * 0.075;
    scatterGust *= 0.93;
    if (scatterGust < 0.004) scatterGust = 0;

    const clampedChapterP = clamp(smoothedP, 0, 4.9999);
    const idxA = Math.floor(clampedChapterP);
    const idxB = Math.min(idxA + 1, 5);
    const t = smoothstep(0.12, 0.88, clampedChapterP - idxA);
    const labBlend = smoothstep(5.04, 5.76, smoothedP);
    const dirSign = (idxA % 2 === 0 ? -1 : 1) * (smoothDir >= 0 ? 1 : -1);

    updateEditorialChrome(idxA, idxB, t, labBlend);
    ctx.clearRect(0, 0, vw, vh);

    for (const d of dustSpecks) {
      d.x = (d.x + d.vx + dirSign * Math.abs(pDiff) * 24 + scatterDirX * scatterGust * 3.2 + vw) % vw;
      d.y = (d.y + d.vy - scrollVel * 0.13 + Math.sin(tSec + d.phase) * 0.18 + vh) % vh;
      ctx.fillStyle = isDarkTheme() ? `rgba(210, 206, 196, ${d.alpha})` : `rgba(92, 90, 84, ${d.alpha})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
      ctx.fill();
    }

    if (customBlend < 0.25) {
      const fgRgb = isDarkTheme() ? "245, 243, 238" : "20, 20, 19";
      const cFade = 1 - customBlend * 4;
      const chFade = 1 - smoothstep(0.02, 0.45, labBlend);
      const graphVis = clamp(1 - Math.abs(smoothedP - 2) * 2.4, 0, 1) * chFade * cFade;
      if (graphVis > 0.02 && geoGraphNodes.length === 5) {
        ctx.save();
        ctx.strokeStyle = `rgba(${fgRgb}, ${(0.14 * graphVis).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        for (let i = 0; i < 5; i++) {
          const a = geoGraphNodes[i];
          const b = geoGraphNodes[(i + 1) % 5];
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = "600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(${fgRgb}, ${(0.72 * graphVis).toFixed(3)})`;
        for (const nd of geoGraphNodes) ctx.fillText(nd.label, nd.x, nd.y - nd.r - 9);
        ctx.restore();
      }
      const radarVis = clamp(1 - Math.abs(smoothedP - 5) * 2.4, 0, 1) * chFade * cFade;
      if (radarVis > 0.02 && geoRadar) {
        ctx.save();
        const sweep = tSec * 1.15;
        const g = ctx.createRadialGradient(geoRadar.cx, geoRadar.cy, 8, geoRadar.cx, geoRadar.cy, geoRadar.r);
        g.addColorStop(0, `rgba(${fgRgb}, 0)`);
        g.addColorStop(1, `rgba(${fgRgb}, ${(0.11 * radarVis).toFixed(3)})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(geoRadar.cx, geoRadar.cy);
        ctx.arc(geoRadar.cx, geoRadar.cy, geoRadar.r, sweep, sweep + 0.56);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    const shapeA = shapes[idxA];
    const shapeB = shapes[idxB];
    if (!shapeA || !shapeB) return;

    const repR = pointer.radius;
    const repR2 = repR * repR;
    ctx.save();
    ctx.lineCap = "round";

    for (let k = 0; k < sandParticles.length; k++) {
      const p = sandParticles[k];
      const ptA = shapeA[k];
      const ptB = shapeB[k];
      const u = clamp((t - p.phase) / (1 - 0.38), 0, 1);
      const e = u * u * (3 - 2 * u);
      const flight = Math.sin(e * Math.PI);
      const posA = evalTargetPoint(ptA, tSec);
      const posB = evalTargetPoint(ptB, tSec);

      let bx = lerp(posA.x, posB.x, e);
      let by = lerp(posA.y, posB.y, e);
      let tr = lerp(ptA.r, ptB.r, e);
      let tg = lerp(ptA.g, ptB.g, e);
      let tb = lerp(ptA.b, ptB.b, e);
      const tSize = lerp(ptA.size, ptB.size, e);
      let tAlpha = lerp(ptA.alpha, ptB.alpha, e);
      let swirlX = flight * (Math.cos(p.noiseSeed + tSec * 1.35) * p.windAmp * 0.55 + dirSign * p.windAmp * 0.45);
      let swirlY = flight * (p.arcHeight + Math.sin(p.noiseSeed * 1.5 + tSec * 1.75) * 44) - scrollVel * flight * 1.35;
      let totalFlight = flight;

      if (labBlend > 0.002 && labField[k]) {
        const lu = clamp((labBlend - p.phase * 0.62) / 0.76, 0, 1);
        const le = lu * lu * (3 - 2 * lu);
        const lf = Math.sin(le * Math.PI);
        const lp = labField[k];
        bx = lerp(bx, lp.x + Math.sin(tSec * 0.42 + p.noiseSeed) * 18, le);
        by = lerp(by, lp.y + Math.cos(tSec * 0.35 + p.shimmerPhase) * 14, le);
        swirlX += lf * Math.cos(p.noiseSeed + tSec * 1.3) * 64;
        swirlY += lf * p.arcHeight * 0.65;
        tr = lerp(tr, lp.r, le); tg = lerp(tg, lp.g, le); tb = lerp(tb, lp.b, le);
        tAlpha = lerp(tAlpha, lp.alpha, le);
        totalFlight = Math.max(totalFlight, lf);
      }

      if (customBlend > 0.002 && customShape && customShape[k]) {
        const cu = clamp((customBlend - p.phase * 0.5) / 0.81, 0, 1);
        const ce = cu * cu * (3 - 2 * cu);
        const cf = Math.sin(ce * Math.PI);
        const cp = evalTargetPoint(customShape[k], tSec);
        bx = lerp(bx, cp.x, ce); by = lerp(by, cp.y, ce);
        swirlX += cf * Math.cos(p.noiseSeed + tSec * 1.4) * 66;
        swirlY += cf * p.arcHeight * 0.68;
        tr = lerp(tr, customShape[k].r, ce); tg = lerp(tg, customShape[k].g, ce); tb = lerp(tb, customShape[k].b, ce);
        tAlpha = lerp(tAlpha, customShape[k].alpha, ce);
        totalFlight = Math.max(totalFlight, cf);
      }

      const idleAmp = (1 - totalFlight) * 0.95;
      const tx = bx + swirlX + Math.sin(tSec * 1.25 + p.shimmerPhase) * idleAmp;
      const ty = by + swirlY + Math.cos(tSec * 1.05 + p.shimmerPhase) * idleAmp;
      p.px = p.x; p.py = p.y;
      const stiffness = lerp(0.064, 0.038, totalFlight) * Math.max(0.28, 1 - scatterGust * 0.55);
      p.vx += (tx - p.x) * stiffness;
      p.vy += (ty - p.y) * stiffness;

      if (pointer.active) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < repR2 && d2 > 0.01) {
          const dist = Math.sqrt(d2);
          const f = ((repR - dist) / repR) * 3.6;
          p.vx += ((dx / dist) * 0.88 - (dy / dist) * 0.28) * f;
          p.vy += ((dy / dist) * 0.88 + (dx / dist) * 0.28) * f;
        }
      }

      p.vx *= 0.835; p.vy *= 0.835;
      p.x += p.vx; p.y += p.vy;
      p.r += (tr - p.r) * 0.14; p.g += (tg - p.g) * 0.14; p.b += (tb - p.b) * 0.14;
      p.size += (tSize - p.size) * 0.14; p.alpha += (tAlpha - p.alpha) * 0.14;

      const speed = Math.hypot(p.x - p.px, p.y - p.py);
      if (speed > 1.85) {
        const stretch = Math.min(3.3, 1.3 + speed * 0.12);
        ctx.strokeStyle = `rgba(${p.r | 0}, ${p.g | 0}, ${p.b | 0}, ${Math.min(0.88, p.alpha * 0.9)})`;
        ctx.lineWidth = Math.max(0.75, p.size * 0.84);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.x - p.px) * stretch, p.y - (p.y - p.py) * stretch);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${p.r | 0}, ${p.g | 0}, ${p.b | 0}, ${p.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function triggerWindScatter() {
    scatterDirX = scatterDirX >= 0 ? -1 : 1;
    scatterGust = 1.5;
    for (const p of sandParticles) {
      const f = 11 + (p.windAmp / 145) * 15;
      p.vx += scatterDirX * f;
      p.vy += Math.sin(p.y * 0.014 + p.noiseSeed) * 7.5 - 2.0;
    }
  }

  function jumpToChapter(chIdx) {
    if (!scrollTrackEl) return;
    const idx = clamp(chIdx, 0, 5);
    const destY = scrollTrackEl.offsetTop + (idx / TOTAL_UNITS) * getMorphSpan();
    exitCustomText();
    window.scrollTo({ top: destY, behavior: "smooth" });
  }

  function exitCustomText() {
    customText = null;
    customBlendTarget = 0;
    const inp = document.getElementById("hud-morph-input");
    const restoreBtn = document.getElementById("hud-restore-btn");
    if (inp) inp.value = "";
    if (restoreBtn) restoreBtn.classList.add("hidden");
  }

  function setFocusView(enabled) {
    focusView = enabled;
    document.body.classList.toggle("focus-view", focusView);
    const btn = document.getElementById("hud-focus-btn");
    if (btn) {
      btn.textContent = focusView ? "● 집중 ON" : "입자 집중";
      btn.classList.toggle("active", focusView);
    }
  }

  function bindInteractiveSectionsOnce() {
    if (bound) return;
    bound = true;

    window.addEventListener("scroll", readScrollProgress, { passive: true });
    window.addEventListener("mousemove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true; }, { passive: true });
    window.addEventListener("mouseout", (e) => { if (!e.relatedTarget) pointer.active = false; });
    window.addEventListener("touchstart", (e) => { if (e.touches.length) { pointer.x = e.touches[0].clientX; pointer.y = e.touches[0].clientY; pointer.active = true; } }, { passive: true });
    window.addEventListener("touchmove", (e) => { if (e.touches.length) { pointer.x = e.touches[0].clientX; pointer.y = e.touches[0].clientY; pointer.active = true; } }, { passive: true });
    window.addEventListener("touchend", () => { pointer.active = false; }, { passive: true });
    window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resizeCanvasSafely, 120); });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape" && focusView) setFocusView(false); });

    document.querySelectorAll("[data-jump]").forEach((btn) => btn.addEventListener("click", () => jumpToChapter(Number(btn.dataset.jump))));
    document.getElementById("brand-top-link")?.addEventListener("click", (e) => { e.preventDefault(); jumpToChapter(0); });
    document.getElementById("nav-how-link")?.addEventListener("click", (e) => { e.preventDefault(); jumpToChapter(0); });
    document.getElementById("btn-back-top")?.addEventListener("click", () => jumpToChapter(0));

    document.getElementById("hud-morph-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = (document.getElementById("hud-morph-input")?.value || "").trim().slice(0, 8);
      if (!val) return;
      customText = val;
      const nearest = clamp(Math.round(smoothedP), 0, 5);
      const anchor = smoothedP > 5.2 ? { cx: vw * 0.5, cy: vh * 0.48, scale: Math.min(vw * 0.48, vh * 0.52, 420) } : shapeAnchors[nearest];
      customShape = sampleTextShape(val, sandParticles.length, anchor, "orbitNodes", 909 + val.length * 19, true);
      customBlendTarget = 1;
      document.getElementById("hud-restore-btn")?.classList.remove("hidden");
    });
    document.getElementById("hud-restore-btn")?.addEventListener("click", exitCustomText);
    document.getElementById("hud-scatter-btn")?.addEventListener("click", triggerWindScatter);
    document.getElementById("hud-focus-btn")?.addEventListener("click", () => setFocusView(!focusView));
    document.getElementById("focus-exit-pill")?.addEventListener("click", () => setFocusView(false));

    // Before vs After Interactive Toggle
    const cleanState = { file: true, log: true, symbol: true, clear: true };
    const weights = { file: 26, log: 28, symbol: 22, clear: 20 };
    const cleanBtns = Array.from(document.querySelectorAll(".clean-toggle"));
    const noiseChunks = Array.from(document.querySelectorAll(".noise-chunk"));
    function renderCompare() {
      let saved = 0;
      Object.keys(weights).forEach((k) => { if (cleanState[k]) saved += weights[k]; });
      const rem = 100 - saved;
      noiseChunks.forEach((c) => c.classList.toggle("cleaned", Boolean(cleanState[c.dataset.cleanGroup])));
      const badge = document.getElementById("compare-after-badge");
      if (badge) badge.textContent = `✓ 마찰 -${saved}% · ${cleanState.log ? "실시간 CRDT" : "4초 풀링"}`;
      const mText = document.getElementById("compare-meter-text");
      if (mText) mText.textContent = `${rem.toFixed(1)}% 잔여 마찰`;
      const mFill = document.getElementById("compare-meter-fill");
      if (mFill) mFill.style.width = `${Math.max(4, rem).toFixed(1)}%`;
      const pre = document.getElementById("compare-distilled-json");
      if (pre) {
        pre.textContent = JSON.stringify({
          qnb_studio_mode: "visual_staging_crdt",
          visualization: cleanState.file ? "Left Code ↔ Right Goal/Trace Studio" : "stdout only",
          collaboration: cleanState.log ? "Automerge CRDT Backend Staging (0-user auto-flush)" : "4s overwrite polling",
          theorem_db: cleanState.symbol ? "SHA-256 verified archive + Proof DAG" : "Full monolith rebuild",
          mcp_cli_bridge: cleanState.clear ? "Live co-editing in Staging Area via /api/mcp" : "Disconnected disk edits",
        }, null, 2);
      }
    }
    cleanBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.clean;
        cleanState[key] = !cleanState[key];
        btn.classList.toggle("active", cleanState[key]);
        btn.textContent = (cleanState[key] ? "✓ " : "○ ") + btn.textContent.replace(/^[✓○]\s*/, "");
        renderCompare();
      });
    });
    renderCompare();

    // 4-Tab Lab
    const tabBtns = Array.from(document.querySelectorAll(".lab-tab-btn"));
    const tabPanels = Array.from(document.querySelectorAll(".lab-panel"));
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;
        tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
        tabPanels.forEach((p) => p.classList.toggle("active", p.id === target));
      });
    });

    // Tab 1: Staging & Zero-User Matrix
    const STAGES = ["STAGED_ACTIVE", "DIRTY_0_USERS", "FLUSHED_DISK"];
    let fileRows = [];
    let clientRows = [];
    let diskRows = [];
    function resetSpec() {
      fileRows = [
        { id: "/proofs.lean", text: "theorem base + induction", users: "2명", depArc: "SES-A", depSch: "DSK-1", status: "STAGED_ACTIVE" },
        { id: "/orbit.py", text: "2D 중력 궤도 추적 스크립트", users: "0명", depArc: "SES-MCP", depSch: "DSK-2", status: "DIRTY_0_USERS" },
      ];
      clientRows = [
        { id: "SES-A", role: "브라우저 사용자 (alice · bob) 실시간 편집 중", status: "STAGED_ACTIVE" },
        { id: "SES-MCP", role: "CLI MCP 에이전트 단발성 편집 완료 (퇴장)", status: "FLUSHED_DISK" },
      ];
      diskRows = [
        { id: "DSK-1", role: "/workspace/proofs.lean (저장 대기 · 스테이징 보존)", status: "STAGED_ACTIVE" },
        { id: "DSK-2", role: "/workspace/orbit.py (0명 도달로 자동 저장 대상)", status: "DIRTY_0_USERS" },
      ];
    }
    const clsFor = (st) => (st === "FLUSHED_DISK" ? "badge badge-pass" : st === "DIRTY_0_USERS" ? "badge badge-warn" : "badge badge-neutral");
    const lblFor = (st) => (st === "FLUSHED_DISK" ? "✓ FLUSHED_DISK" : st === "DIRTY_0_USERS" ? "▲ 0명_미저장" : "● STAGED_ACTIVE");
    function renderSpec() {
      const ts = document.getElementById("tbody-srs");
      const ta = document.getElementById("tbody-arc");
      const tc = document.getElementById("tbody-sch");
      if (!ts || !ta || !tc) return;
      ts.innerHTML = fileRows.map((r, i) => `<tr><td class="mono" style="font-weight:700;">${r.id}</td><td>${r.text}</td><td class="mono">${r.users}</td><td style="text-align:right;"><button type="button" data-cycle="f:${i}" class="${clsFor(r.status)}">${lblFor(r.status)}</button></td></tr>`).join("");
      ta.innerHTML = clientRows.map((c, i) => `<tr><td class="mono" style="font-weight:700;">${c.id}</td><td>${c.role}</td><td style="text-align:right;"><button type="button" data-cycle="c:${i}" class="${clsFor(c.status)}">${lblFor(c.status)}</button></td></tr>`).join("");
      tc.innerHTML = diskRows.map((d, i) => `<tr><td class="mono" style="font-weight:700;">${d.id}</td><td>${d.role}</td><td style="text-align:right;"><button type="button" data-cycle="d:${i}" class="${clsFor(d.status)}">${lblFor(d.status)}</button></td></tr>`).join("");
      document.querySelectorAll("[data-cycle]").forEach((b) => b.addEventListener("click", () => {
        const [k, ix] = b.dataset.cycle.split(":");
        const list = k === "f" ? fileRows : k === "c" ? clientRows : diskRows;
        list[ix].status = STAGES[(STAGES.indexOf(list[ix].status) + 1) % STAGES.length];
        if (k === "f") fileRows[ix].users = list[ix].status === "STAGED_ACTIVE" ? "2명" : "0명";
        renderSpec();
        evalSpec();
      }));
    }
    function evalSpec() {
      const zeroDirty = fileRows.filter((r) => r.status === "DIRTY_0_USERS");
      const liveEl = document.getElementById("spec-sql-live");
      const gBadge = document.getElementById("spec-gate-badge");
      if (liveEl) liveEl.innerHTML = `<strong>SELECT</strong> path <strong>FROM</strong> staged_files <strong>WHERE</strong> active_users = 0 AND dirty = 1; → [${zeroDirty.map((x) => x.id).join(", ") || "없음"}]`;
      if (gBadge) {
        gBadge.className = zeroDirty.length ? "badge badge-warn" : "badge badge-pass";
        gBadge.textContent = zeroDirty.length ? `▲ 0명 자동저장 대기 ${zeroDirty.length}건` : "✓ 모든 스테이징 정합성 완료";
      }
      const b1 = document.getElementById("badge-stage1");
      const bd1 = document.getElementById("body-stage1");
      const b2 = document.getElementById("badge-stage2");
      const bd2 = document.getElementById("body-stage2");
      if (b1 && bd1) {
        b1.className = "badge badge-pass";
        b1.textContent = `✓ 스테이징 활성 ${fileRows.filter((r) => r.status === "STAGED_ACTIVE").length}건`;
        bd1.textContent = "편집 중인 파일은 Automerge binary 문서로 백엔드에 머물며, 명시적 Ctrl+S 전까지 디스크를 덮어쓰지 않습니다.";
      }
      if (b2 && bd2) {
        b2.className = zeroDirty.length ? "badge badge-warn" : "badge badge-pass";
        b2.textContent = zeroDirty.length ? `▲ 자동 플러시 필요 (${zeroDirty.length}건)` : "✓ 언스테이징 클린";
        bd2.textContent = zeroDirty.length
          ? `${zeroDirty.map((z) => z.id).join(", ")}의 작업자가 0명이 되어 즉시 VM 파일시스템에 저장 후 스테이징에서 내립니다.`
          : "작업자가 0명인 미저장 스테이징 파일이 없습니다.";
      }
    }
    document.getElementById("btn-sql-check")?.addEventListener("click", evalSpec);
    document.getElementById("btn-llm-check")?.addEventListener("click", evalSpec);
    document.getElementById("btn-auto-resolve")?.addEventListener("click", () => {
      [fileRows, clientRows, diskRows].forEach((arr) => arr.forEach((x) => { x.status = "FLUSHED_DISK"; if ("users" in x) x.users = "0명"; }));
      renderSpec();
      evalSpec();
    });
    document.getElementById("btn-spec-reset")?.addEventListener("click", () => { resetSpec(); renderSpec(); evalSpec(); });
    resetSpec(); renderSpec(); evalSpec();

    // Tab 2: Lean 4 Goal Preview
    let astBug = false;
    function renderAst() {
      const v = document.getElementById("ast-code-view");
      const hl = document.getElementById("ast-hash-line");
      if (!v || !hl) return;
      if (!astBug) {
        hl.textContent = "sha256: 9f4a2c → b82e19 [VERIFIED]";
        v.innerHTML = `theorem zero_add_tour (n : Nat) : 0 + n = n := by\n  induction n with\n  | zero => rfl\n  | succ k ih =>\n<span class="code-line-ok">    rw [Nat.add_succ]\n    rw [ih]</span>`;
      } else {
        hl.textContent = "sha256: 9f4a2c → unsolved [OPEN GOAL]";
        v.innerHTML = `theorem zero_add_tour (n : Nat) : 0 + n = n := by\n  induction n with\n  | zero => rfl\n  | succ k ih =>\n<span class="code-line-bug">    rw [Nat.add_succ]\n    -- ih 적용 누락</span>`;
      }
      const vb = document.getElementById("ast-verdict-badge");
      const vn = document.getElementById("ast-verdict-note");
      const jv = document.getElementById("ast-json-view");
      if (vb && vn && jv) {
        vb.className = astBug ? "badge badge-warn" : "badge badge-pass";
        vb.textContent = astBug ? "▲ UNSOLVED GOAL" : "✓ QED · DB 저장됨";
        vn.textContent = astBug ? "succ 사례 목표 k.succ = k + 1 미해결" : "모든 전술 목표 완료 · 정리 DB 저장 완료";
        jv.innerHTML = astBug
          ? `<div class="alert-striped" style="padding:12px;"><strong>case succ</strong><br>k : Nat<br>ih : 0 + k = k<br>⊢ 0 + (k + 1) = k + 1</div><div class="sub-surface" style="padding:10px 12px;"><strong>🧮 명제 계산 (미적용)</strong><br>전술 <code>rw [Nat.add_succ]</code> 적용 전 — <code>0 + (k + 1)</code> 축약 대기</div>`
          : `<div class="sub-surface" style="padding:12px;background:var(--surface-paper);"><strong>✓ no goals</strong> — 모든 하위 목표가 <code>rw [ih]</code>로 닫혔습니다.</div><div class="sub-surface" style="padding:10px 12px;background:var(--surface-paper);"><strong>🧮 명제 계산 (Nat.add_succ)</strong><br><code>0 + (k + 1)</code> → <code>(0 + k).succ</code> → <code>ih</code> 치환 → <code>k + 1 = k + 1</code> (Q.E.D.)</div>`;
      }
    }
    document.getElementById("sem-btn-ok")?.addEventListener("click", () => { astBug = false; document.getElementById("sem-btn-ok").classList.add("active"); document.getElementById("sem-btn-bug")?.classList.remove("active"); renderAst(); });
    document.getElementById("sem-btn-bug")?.addEventListener("click", () => { astBug = true; document.getElementById("sem-btn-bug").classList.add("active"); document.getElementById("sem-btn-ok")?.classList.remove("active"); renderAst(); });
    document.getElementById("btn-run-ast")?.addEventListener("click", renderAst);
    renderAst();

    // Tab 3: Collab Simulator
    let simMode = "full";
    let simTimers = [];
    const SIM_NODES = Array.from(document.querySelectorAll(".sim-node"));
    const FULL_FLOW = [
      { idx: 0, delay: 100, pct: 20, users: 1, msg: "[CLIENT_OPEN] Alice가 main.lean 열기 → 백엔드 스테이징 적재" },
      { idx: 1, delay: 550, pct: 35, users: 2, msg: "[LOAD_STAGING] Bob 합류 → 동일한 Automerge 문서 공유 (디스크 미수정)" },
      { idx: 2, delay: 1050, pct: 55, users: 2, msg: "[AUTOMERGE_SYNC] Alice + Bob 동시 편집 병합 → 실시간 브로드캐스트" },
      { idx: 3, delay: 1550, pct: 75, users: 3, msg: "[MCP_COEDIT] CLI 에이전트가 qnb_edit_staged_file로 보조정리 삽입 → 화면 즉시 반영" },
      { idx: 4, delay: 2050, pct: 88, users: 2, msg: "[EXPLICIT_SAVE] Alice가 Ctrl+S 실행 → VM 파일시스템 반영 및 dirty=false" },
      { idx: 5, delay: 2550, pct: 100, users: 0, pause: true, msg: "[0_USER_UNSTAGE] 모든 사용자 탭 종료 → 미저장 변경 자동 플러시 후 스테이징 해제!" },
    ];
    const FAST_FLOW = [
      { idx: 0, delay: 100, pct: 25, users: 1, msg: "[CLIENT_OPEN] 단일 사용자 파일 열기 → 스테이징 적재" },
      { idx: 2, delay: 700, pct: 60, users: 1, msg: "[AUTOMERGE_SYNC] 편집 내용은 스테이징 영역에만 실시간 기록" },
      { idx: 5, delay: 1300, pct: 100, users: 0, msg: "[0_USER_UNSTAGE] 파일 닫기 → 작업자 0명 감지로 자동 저장 후 언스테이징 완료!" },
    ];
    function resetSim() {
      simTimers.forEach(clearTimeout);
      simTimers = [];
      SIM_NODES.forEach((n) => { n.className = "sim-node"; });
      document.getElementById("sim-hitl-card")?.classList.add("hidden");
      const bf = document.getElementById("sim-budget-fill"); if (bf) bf.style.width = "0%";
      const bt = document.getElementById("sim-budget-text"); if (bt) bt.textContent = "0 / 6 단계";
      const rc = document.getElementById("sim-reset-count"); if (rc) rc.textContent = "활성 세션: 0명";
      const log = document.getElementById("sim-log");
      if (log) log.innerHTML = `<div style="color: var(--ash);">$ 시뮬레이션 모드를 선택하고 "동기화 흐름 재생" 버튼을 눌러 주세요.</div>`;
    }
    document.getElementById("sim-mode-fast")?.addEventListener("click", () => { simMode = "fast"; document.getElementById("sim-mode-fast").classList.add("active"); document.getElementById("sim-mode-full")?.classList.remove("active"); resetSim(); });
    document.getElementById("sim-mode-full")?.addEventListener("click", () => { simMode = "full"; document.getElementById("sim-mode-full").classList.add("active"); document.getElementById("sim-mode-fast")?.classList.remove("active"); resetSim(); });
    document.getElementById("btn-sim-run")?.addEventListener("click", () => {
      resetSim();
      const log = document.getElementById("sim-log");
      if (log) log.innerHTML = "";
      const list = simMode === "full" ? FULL_FLOW : FAST_FLOW;
      list.forEach((st, i) => {
        simTimers.push(setTimeout(() => {
          if (i > 0 && SIM_NODES[list[i - 1].idx]) SIM_NODES[list[i - 1].idx].className = "sim-node done";
          if (SIM_NODES[st.idx]) SIM_NODES[st.idx].className = st.pause ? "sim-node paused" : "sim-node running";
          const bf = document.getElementById("sim-budget-fill"); if (bf) bf.style.width = `${st.pct}%`;
          const bt = document.getElementById("sim-budget-text"); if (bt) bt.textContent = `${i + 1} / ${list.length} 단계`;
          const rc = document.getElementById("sim-reset-count"); if (rc) rc.textContent = `활성 세션: ${st.users}명`;
          const row = document.createElement("div"); row.textContent = st.msg; log?.appendChild(row);
          if (st.pause) document.getElementById("sim-hitl-card")?.classList.remove("hidden");
        }, st.delay));
      });
    });
    document.getElementById("btn-sim-approve")?.addEventListener("click", () => {
      document.getElementById("sim-hitl-card")?.classList.add("hidden");
      if (SIM_NODES[5]) SIM_NODES[5].className = "sim-node done";
      const fb = document.getElementById("sim-fallback-badge");
      if (fb) { fb.className = "badge badge-pass"; fb.textContent = "✓ 저장 · 언스테이징 완료"; }
    });
    document.getElementById("btn-sim-reset")?.addEventListener("click", resetSim);

    // Tab 4: MCP sequence + Proof card customizer
    document.getElementById("btn-run-research")?.addEventListener("click", () => {
      const b1 = document.getElementById("res-b1"); const b2 = document.getElementById("res-b2"); const b3 = document.getElementById("res-b3");
      if (b1) { b1.className = "badge badge-pass"; b1.textContent = "✓ 토큰 인증됨"; }
      setTimeout(() => { if (b2) { b2.className = "badge badge-pass"; b2.textContent = "✓ Automerge 병합"; } }, 350);
      setTimeout(() => { if (b3) { b3.className = "badge badge-pass"; b3.textContent = "✓ 0명 시 자동저장"; } }, 700);
    });
    const ux = { padding: 20, radius: 16, scale: 1.0, contrast: 22, locked: true };
    const slP = document.getElementById("sl-padding");
    const slR = document.getElementById("sl-radius");
    const slT = document.getElementById("sl-type");
    const slC = document.getElementById("sl-contrast");
    const chk = document.getElementById("chk-ux-lock");
    function renderUx() {
      const card = document.getElementById("ux-live-card");
      if (!card) return;
      card.style.padding = `${ux.padding}px`;
      card.style.borderRadius = `${ux.radius}px`;
      card.style.borderColor = `rgba(20,20,19,${(0.08 + ux.contrast * 0.012).toFixed(2)})`;
      document.getElementById("val-padding").textContent = `${ux.padding}px`;
      document.getElementById("val-radius").textContent = `${ux.radius}px`;
      document.getElementById("val-type").textContent = `${ux.scale.toFixed(2)}x`;
      document.getElementById("val-contrast").textContent = `${ux.contrast}%`;
      document.getElementById("ux-live-title").style.fontSize = `${(19 * ux.scale).toFixed(1)}px`;
      document.getElementById("ux-live-desc").style.fontSize = `${(12.5 * ux.scale).toFixed(1)}px`;
      const pre = document.getElementById("ux-json-preview");
      if (pre) pre.textContent = JSON.stringify(ux, null, 2);
    }
    slP?.addEventListener("input", (e) => { ux.padding = Number(e.target.value); renderUx(); });
    slR?.addEventListener("input", (e) => { ux.radius = Number(e.target.value); renderUx(); });
    slT?.addEventListener("input", (e) => { ux.scale = Number(e.target.value) / 100; renderUx(); });
    slC?.addEventListener("input", (e) => { ux.contrast = Number(e.target.value); renderUx(); });
    chk?.addEventListener("change", (e) => { ux.locked = e.target.checked; renderUx(); });
    document.getElementById("btn-ux-overwrite")?.addEventListener("click", () => {
      const msg = document.getElementById("ux-audit-msg");
      if (!msg) return;
      msg.classList.remove("hidden");
      msg.textContent = ux.locked ? "✓ locked_by_user=true — 스타일이 안전하게 유지됩니다." : "▲ 잠금 해제됨 — 기본 스타일로 재설정 가능합니다.";
    });
    renderUx();

    // Tab 5: Category Theory + Polyglot Stepper Interactive Demos
    let catDemoMode = "nat";
    function renderCatDemo() {
      const diag = document.getElementById("cat-demo-diagram");
      const code = document.getElementById("cat-demo-code");
      const calc = document.getElementById("cat-demo-calc");
      if (!diag || !code || !calc) return;
      if (catDemoMode === "nat") {
        diag.innerHTML = `<svg class="demo-quiver-svg" viewBox="0 0 360 120" aria-label="Naturality square diagram">
          <defs><marker id="qarr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor"/></marker></defs>
          <circle cx="65" cy="28" r="16" class="dq-node"/><text x="65" y="32">F(A)</text>
          <circle cx="295" cy="28" r="16" class="dq-node"/><text x="295" y="32">G(A)</text>
          <circle cx="65" cy="92" r="16" class="dq-node"/><text x="65" y="96">F(B)</text>
          <circle cx="295" cy="92" r="16" class="dq-node"/><text x="295" y="96">G(B)</text>
          <line x1="83" y1="28" x2="275" y2="28" class="dq-edge active" marker-end="url(#qarr)"/>
          <line x1="65" y1="46" x2="65" y2="73" class="dq-edge" marker-end="url(#qarr)"/>
          <line x1="295" y1="46" x2="295" y2="73" class="dq-edge active" marker-end="url(#qarr)"/>
          <line x1="83" y1="92" x2="275" y2="92" class="dq-edge" marker-end="url(#qarr)"/>
          <text x="180" y="18" class="dq-lbl active">α(A)</text>
          <text x="41" y="62" class="dq-lbl">F(f)</text>
          <text x="319" y="62" class="dq-lbl active">G(f)</text>
          <text x="180" y="108" class="dq-lbl">α(B)</text>
        </svg>`;
        code.textContent = "category C, D\nobject A, B : C\nmorphism f : A -> B\nfunctor F, G : C -> D\nnat alpha : F => G\ntheorem nat_sq : G(f) ∘ alpha(A) = alpha(B) ∘ F(f) by\n  naturality alpha\n  rfl";
        calc.innerHTML = `<span class="badge badge-pass">✓ 가환 증명 완료</span><code>G(f) ∘ α(A) → α(B) ∘ F(f) (Naturality Square)</code>`;
      } else {
        diag.innerHTML = `<svg class="demo-quiver-svg" viewBox="0 0 360 120" aria-label="Adjunction zig-zag triangle diagram">
          <defs><marker id="qarr2" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor"/></marker></defs>
          <circle cx="58" cy="30" r="17" class="dq-node"/><text x="58" y="34">F(A)</text>
          <circle cx="180" cy="88" r="22" class="dq-node"/><text x="180" y="92">FGF(A)</text>
          <circle cx="302" cy="30" r="17" class="dq-node"/><text x="302" y="34">F(A)</text>
          <line x1="75" y1="30" x2="280" y2="30" class="dq-edge" marker-end="url(#qarr2)"/>
          <line x1="72" y1="42" x2="159" y2="79" class="dq-edge active" marker-end="url(#qarr2)"/>
          <line x1="201" y1="79" x2="288" y2="42" class="dq-edge active" marker-end="url(#qarr2)"/>
          <text x="180" y="20" class="dq-lbl">id(F(A))</text>
          <text x="95" y="74" class="dq-lbl active">F(η(A))</text>
          <text x="266" y="74" class="dq-lbl active">ε(F(A))</text>
        </svg>`;
        code.textContent = "category C, D\nobject A : C\nadjunction F -| G : C <-> D\ntheorem zig_law : eps(F(A)) ∘ F(eta(A)) = id(F(A)) by\n  zig\n  rfl";
        calc.innerHTML = `<span class="badge badge-pass">✓ 삼각 항등식 완료</span><code>ε(F(A)) ∘ F(η(A)) → id(F(A)) (F ⊣ G Adjunction)</code>`;
      }
    }
    document.getElementById("cat-demo-nat")?.addEventListener("click", () => {
      catDemoMode = "nat";
      document.getElementById("cat-demo-nat")?.classList.add("active");
      document.getElementById("cat-demo-adj")?.classList.remove("active");
      renderCatDemo();
    });
    document.getElementById("cat-demo-adj")?.addEventListener("click", () => {
      catDemoMode = "adj";
      document.getElementById("cat-demo-adj")?.classList.add("active");
      document.getElementById("cat-demo-nat")?.classList.remove("active");
      renderCatDemo();
    });
    renderCatDemo();

    let dbgDemoMode = "py";
    function renderDbgDemo() {
      const code = document.getElementById("dbg-demo-code");
      const st = document.getElementById("dbg-demo-state");
      if (!code || !st) return;
      if (dbgDemoMode === "py") {
        code.innerHTML = `def step_orbit(x, y, vx, vy, dt):\n    r2 = x*x + y*y\n<span class="code-line-ok">    ax = -x / (r2 ** 1.5)   # 3행 실행 중</span>\n    return x + vx*dt, y + vy*dt`;
        st.innerHTML = `<div class="demo-dbg-row"><strong>스택</strong><code>step_orbit() · 3행 (sys.settrace)</code></div><div class="demo-dbg-row"><strong>변수 델타</strong><span class="badge badge-pass">Δ ax = -0.354</span> <span class="badge badge-neutral">r2 = 2.0</span></div><div class="demo-dbg-row"><strong>자료구조 힙</strong><code>trail : list#1 (len 12) → [(1.0, 0.0), …]</code></div>`;
      } else if (dbgDemoMode === "cpp") {
        code.innerHTML = `auto dijkstra(WeightedGraph&amp; g, int s) {\n  std::vector&lt;int&gt; dist(g.n, INF);\n<span class="code-line-ok">  dist[s] = 0; pq.push({0, s});  // GDB step</span>\n  return dist;\n}`;
        st.innerHTML = `<div class="demo-dbg-row"><strong>디버거</strong><code>g++ -g -O0 · GDB MI (4행 멈춤)</code></div><div class="demo-dbg-row"><strong>포인터 · 델타</strong><span class="badge badge-pass">ptr → g#1</span> <span class="badge badge-neutral">dist[0] = 0</span></div><div class="demo-dbg-row"><strong>힙/컨테이너</strong><code>std::vector&lt;int&gt; [0, INF, INF, INF] · map{node_3: 5}</code></div>`;
      } else {
        code.innerHTML = `static TreeNode insert(TreeNode root, int k) {\n  if (root == null) return new TreeNode(k);\n<span class="code-line-ok">  if (k &lt; root.key) root.left = insert(root.left, k);</span>\n  return root;\n}`;
        st.innerHTML = `<div class="demo-dbg-row"><strong>디버거</strong><code>javac -g · JDI StepEvent (3행 재귀)</code></div><div class="demo-dbg-row"><strong>객체 참조</strong><span class="badge badge-pass">root = TreeNode#4</span> <span class="badge badge-neutral">key = 5 → left</span></div><div class="demo-dbg-row"><strong>힙 트리</strong><code>TreeNode#2 {key:10, left:TreeNode#4, right:TreeNode#6}</code></div>`;
      }
    }
    [["dbg-demo-py", "py"], ["dbg-demo-cpp", "cpp"], ["dbg-demo-java", "java"]].forEach(([id, mode]) => {
      document.getElementById(id)?.addEventListener("click", () => {
        dbgDemoMode = mode;
        ["dbg-demo-py", "dbg-demo-cpp", "dbg-demo-java"].forEach((k) => {
          document.getElementById(k)?.classList.toggle("active", k === id);
        });
        renderDbgDemo();
      });
    });
    renderDbgDemo();
  }

  function refreshTheme() {
    if (sandParticles.length) precomputeAllShapes();
  }

  new MutationObserver(() => refreshTheme())
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-ide-theme", "data-weather"] });

  function start() {
    canvas = document.getElementById("sand-canvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    scrollTrackEl = document.getElementById("scroll-track");
    washEl = document.getElementById("stage-wash");
    chapterPanels = Array.from(document.querySelectorAll(".chapter-panel"));
    hudChapterBtns = Array.from(document.querySelectorAll(".hud-ch-btn"));
    if (!ctx) return;

    bindInteractiveSectionsOnce();
    running = true;
    resizeCanvasSafely();
    smoothedP = targetP;
    if (!rafId) rafId = window.requestAnimationFrame(animate);
  }

  function stop() {
    running = false;
    setFocusView(false);
    document.body.classList.remove("in-below");
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  return { start, stop, refreshTheme };
})();
