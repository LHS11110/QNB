"use strict";

/* Weather-reactive IDE theme & ambient sky animations.
 * Settings live in localStorage; "auto" uses ~10 km rounded geolocation + Open-Meteo. */
window.QNBWeather = (() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "qnb_weather";
  const CACHE_KEY = "qnb_weather_cache";
  const WEATHERS = {
    clear: {
      icon: "☀", label: "맑음", mood: "햇살 · 광선",
      desc: "따뜻한 황금빛 햇살과 은은한 빛 입자",
      skyLight: ["#e0f2fe", "#fef9c3", "#fed7aa"],
      skyDark: ["#1e1b4b", "#422006", "#78350f"],
    },
    partly: {
      icon: "⛅", label: "구름 조금", mood: "구름 · 햇빛",
      desc: "구름 사이로 스며드는 맑은 오후 햇살",
      skyLight: ["#bae6fd", "#e0f2fe", "#fef3c7"],
      skyDark: ["#0f172a", "#1e293b", "#334155"],
    },
    cloudy: {
      icon: "☁", label: "흐림", mood: "다층 구름",
      desc: "깊이감 있게 흘러가는 다층 구름 물결",
      skyLight: ["#cbd5e1", "#e2e8f0", "#f1f5f9"],
      skyDark: ["#0f172a", "#1e293b", "#334155"],
    },
    rain: {
      icon: "🌧", label: "비", mood: "빗줄기 · 물방울",
      desc: "대각선으로 내리는 빗줄기와 튀어 오르는 물방울",
      skyLight: ["#bfdbfe", "#93c5fd", "#dbeafe"],
      skyDark: ["#091326", "#172554", "#1e3a8a"],
    },
    snow: {
      icon: "❄", label: "눈", mood: "눈꽃 결정",
      desc: "바람을 타고 회전하며 흩날리는 육각 눈꽃 결정",
      skyLight: ["#e0f2fe", "#f0f9ff", "#ffffff"],
      skyDark: ["#0c192c", "#162d47", "#1e3a5f"],
    },
    thunder: {
      icon: "⛈", label: "뇌우", mood: "번개 · 폭풍우",
      desc: "먹구름을 가르는 가느다란 번개와 장대비",
      skyLight: ["#c7d2fe", "#a5b4fc", "#e0e7ff"],
      skyDark: ["#090919", "#1e1b4b", "#3b0764"],
    },
    fog: {
      icon: "🌫", label: "안개", mood: "물결 안개",
      desc: "화면 위를 천천히 감싸며 흐르는 안개 띠",
      skyLight: ["#e2e8f0", "#f1f5f9", "#cbd5e1"],
      skyDark: ["#111827", "#1f2937", "#374151"],
    },
    night: {
      icon: "🌙", label: "맑은 밤", mood: "달빛 · 별똥별",
      desc: "초승달·오로라·반짝이는 별과 이따금 스치는 별똥별",
      skyLight: ["#312e81", "#4338ca", "#6366f1"],
      skyDark: ["#050816", "#0f172a", "#1e1b4b"],
    },
  };

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const defaults = { enabled: false, mode: "manual", weather: "clear", intensity: 70, motion: !reducedMotion };
  let settings = { ...defaults };
  try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* defaults */ }
  if (!WEATHERS[settings.weather]) settings.weather = "clear";

  let live = null; // { weather, temp, at }
  try { live = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { live = null; }
  let autoTimer = null;
  let hoveredWeather = null;

  const canvas = $("weather-fx");
  const glow = $("weather-glow");
  const ctx = canvas?.getContext("2d");

  const mainState = createSceneState();
  const previewState = createSceneState();
  let frame = null;
  let lastTick = 0;
  let previewFrame = null;
  let previewLastTick = 0;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function save() { localStorage.setItem(KEY, JSON.stringify(settings)); }

  function createSceneState() {
    return {
      weather: null,
      w: 0,
      h: 0,
      intensity: -1,
      drops: [],
      splashes: [],
      clouds: [],
      flakes: [],
      stars: [],
      motes: [],
      ribbons: [],
      shooting: null,
      nextShoot: 0,
      flash: 0,
      nextFlash: 0,
      bolt: null,
    };
  }

  function current() {
    if (!settings.enabled) return null;
    if (settings.mode === "auto") return live?.weather || null;
    return settings.weather;
  }

  /* ---------------- auto weather ---------------- */
  function fromWmo(code, isDay) {
    if ([95, 96, 99].includes(code)) return "thunder";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
    if (code === 45 || code === 48) return "fog";
    if (code === 3) return "cloudy";
    if (code === 2) return "partly";
    return isDay ? "clear" : "night";
  }

  function setAutoStatus(text) {
    const node = $("weather-auto-status");
    if (node) node.textContent = text || "";
  }

  function refreshAuto(force = false) {
    clearTimeout(autoTimer);
    if (!settings.enabled || settings.mode !== "auto") return;
    autoTimer = setTimeout(() => refreshAuto(true), 30 * 60 * 1000);
    if (!force && live && Date.now() - live.at < 30 * 60 * 1000) {
      setAutoStatus(`현재 위치 날씨: ${WEATHERS[live.weather]?.icon || ""} ${WEATHERS[live.weather]?.label || ""} · ${live.temp}°C`);
      apply();
      return;
    }
    if (!navigator.geolocation) {
      setAutoStatus("이 브라우저는 위치 정보를 지원하지 않습니다. 직접 테마 고르기를 사용하세요.");
      return;
    }
    setAutoStatus("현재 위치의 날씨를 확인하는 중…");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude.toFixed(1);
      const lon = pos.coords.longitude.toFixed(1);
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,is_day,temperature_2m&timezone=auto`;
        const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        const c = body.current || {};
        live = { weather: fromWmo(Number(c.weather_code), c.is_day !== 0), temp: Math.round(c.temperature_2m), at: Date.now() };
        localStorage.setItem(CACHE_KEY, JSON.stringify(live));
        setAutoStatus(`현재 위치 날씨: ${WEATHERS[live.weather].icon} ${WEATHERS[live.weather].label} · ${live.temp}°C`);
        apply();
        if ($("weather-dialog")?.open) renderDialog();
      } catch {
        setAutoStatus("날씨 정보를 가져오지 못했습니다. 잠시 후 다시 시도하거나 직접 고르기를 사용하세요.");
      }
    }, () => setAutoStatus("위치 권한이 거부되었습니다. 직접 테마 고르기를 사용하세요."), {
      enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 15000,
    });
  }

  /* ---------------- scene population ---------------- */
  function populateScene(state, weather, w, h, intensity, isPreview = false) {
    state.weather = weather;
    state.w = w;
    state.h = h;
    state.intensity = intensity;
    state.drops = [];
    state.splashes = [];
    state.clouds = [];
    state.flakes = [];
    state.stars = [];
    state.motes = [];
    state.ribbons = [];
    state.shooting = null;
    state.bolt = null;

    if (!weather) return;
    const k = intensity / 100;
    const areaScale = isPreview ? 0.45 : Math.max(0.55, (w * h) / (1280 * 800));
    const count = (base) => Math.max(4, Math.round(base * k * areaScale));

    if (weather === "clear" || weather === "partly") {
      for (let i = 0; i < count(weather === "clear" ? 38 : 18); i++) {
        state.motes.push({
          x: rand(w * 0.2, w), y: rand(0, h * 0.85),
          r: rand(1.4, isPreview ? 3.2 : 4.2),
          speed: rand(0.12, 0.35), phase: rand(0, Math.PI * 2), bokeh: i % 5 === 0,
        });
      }
    }
    if (weather === "partly" || weather === "cloudy" || weather === "rain" || weather === "thunder") {
      const layers = weather === "partly" ? 5 : weather === "cloudy" ? 10 : 6;
      const maxC = isPreview ? Math.ceil(layers * 0.7) : layers;
      for (let i = 0; i < maxC; i++) {
        const depth = i % 3;
        const scale = (0.65 + depth * 0.32) * (isPreview ? 0.42 : 1);
        const puffs = [];
        for (let j = 0; j < 4; j++) {
          puffs.push({ ox: (j - 1.5) * 34 * scale, oy: (j % 2 === 0 ? -8 : 4) * scale, r: rand(26, 42) * scale });
        }
        state.clouds.push({
          x: rand(-180 * scale, w + 80),
          y: rand(isPreview ? 18 : 16, h * (weather === "cloudy" ? 0.48 : 0.28)),
          speed: (0.14 + depth * 0.14) * (weather === "thunder" ? 1.5 : 1),
          scale, depth, puffs,
        });
      }
    }
    if (weather === "rain" || weather === "thunder") {
      const nDrops = count(weather === "thunder" ? 185 : 135);
      for (let i = 0; i < nDrops; i++) {
        const far = i % 3 === 0;
        state.drops.push({
          x: rand(0, w + 140),
          y: rand(0, h),
          len: far ? rand(9, 14) : rand(15, 25),
          speed: far ? rand(8, 11) : rand(13, 19),
          far,
        });
      }
    }
    if (weather === "snow") {
      const nFlakes = count(120);
      for (let i = 0; i < nFlakes; i++) {
        state.flakes.push({
          x: rand(0, w), y: rand(0, h),
          r: rand(1.6, isPreview ? 4.2 : 5.4),
          crystal: i % 4 === 0,
          speed: rand(0.45, 1.45),
          drift: rand(0, Math.PI * 2),
          rot: rand(0, Math.PI * 2),
          vrot: rand(-0.025, 0.025),
        });
      }
    }
    if (weather === "fog") {
      for (let i = 0; i < (isPreview ? 5 : 8); i++) {
        state.ribbons.push({
          y: h * (0.15 + i * 0.11),
          amp: rand(10, isPreview ? 16 : 28),
          freq: rand(0.004, 0.009),
          speed: (i % 2 === 0 ? 1 : -1) * rand(0.008, 0.018),
          phase: rand(0, Math.PI * 2),
          thick: isPreview ? rand(24, 42) : rand(55, 110),
        });
      }
    }
    if (weather === "night") {
      const nStars = count(115);
      for (let i = 0; i < nStars; i++) {
        state.stars.push({
          x: rand(0, w), y: rand(0, h * 0.78),
          r: rand(0.6, isPreview ? 1.8 : 2.1),
          phase: rand(0, Math.PI * 2),
          tint: i % 6 === 0 ? "196, 219, 255" : i % 7 === 0 ? "254, 240, 199" : "255, 255, 255",
        });
      }
    }
  }

  function makeBolt(w, h) {
    const segs = [];
    let x = rand(w * 0.25, w * 0.85);
    let y = 0;
    const targetY = rand(h * 0.42, h * 0.72);
    while (y < targetY) {
      const nx = x + rand(-28, 28);
      const ny = y + rand(22, 46);
      segs.push([x, y, nx, ny, 2.2]);
      if (Math.random() < 0.32) {
        segs.push([nx, ny, nx + rand(-55, 55), ny + rand(25, 65), 1.1]);
      }
      x = nx; y = ny;
    }
    return segs;
  }

  /* ---------------- shared canvas renderer ---------------- */
  function drawScene(c, w, h, weather, k, dark, t, dt, state, isPreview = false) {
    c.clearRect(0, 0, w, h);
    if (!weather) return;

    const step = dt / 16.7;
    if (state.weather !== weather || Math.abs(state.w - w) > 8 || Math.abs(state.h - h) > 8 || Math.abs(state.intensity - Math.round(k * 100)) > 1) {
      populateScene(state, weather, w, h, Math.round(k * 100), isPreview);
    }

    if (isPreview) {
      const wObj = WEATHERS[weather];
      const pal = dark ? wObj.skyDark : wObj.skyLight;
      const bg = c.createLinearGradient(0, 0, w * 0.6, h);
      bg.addColorStop(0, pal[0]);
      bg.addColorStop(0.55, pal[1]);
      bg.addColorStop(1, pal[2]);
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
    }

    // 1. Sun orb & golden rays
    if (weather === "clear" || weather === "partly") {
      const sx = w * 0.88;
      const sy = isPreview ? h * 0.24 : 58;
      const orbR = isPreview ? 38 : 74;
      const halo = c.createRadialGradient(sx, sy, 2, sx, sy, orbR * 3.4);
      const beamAlpha = (weather === "clear" ? 0.26 : 0.16) * k;
      halo.addColorStop(0, `rgba(255, 245, 190, ${Math.min(0.85, beamAlpha * 2.2)})`);
      halo.addColorStop(0.35, `rgba(253, 210, 90, ${beamAlpha})`);
      halo.addColorStop(1, "rgba(253, 186, 60, 0)");
      c.fillStyle = halo;
      c.fillRect(0, 0, w, h);

      // Rotating sunbeams / god-rays
      const rayCount = 6;
      const spin = t * 0.00012;
      c.save();
      c.translate(sx, sy);
      for (let i = 0; i < rayCount; i++) {
        const ang = 2.05 + i * 0.28 + Math.sin(spin + i) * 0.07;
        const beamLen = Math.max(w, h) * 0.85;
        const spread = 0.065 + 0.025 * Math.sin(t * 0.001 + i);
        const grad = c.createLinearGradient(0, 0, Math.cos(ang) * beamLen, Math.sin(ang) * beamLen);
        grad.addColorStop(0, `rgba(254, 240, 138, ${beamAlpha * 0.72})`);
        grad.addColorStop(0.6, `rgba(253, 224, 71, ${beamAlpha * 0.14})`);
        grad.addColorStop(1, "rgba(253, 224, 71, 0)");
        c.fillStyle = grad;
        c.beginPath();
        c.moveTo(0, 0);
        c.lineTo(Math.cos(ang - spread) * beamLen, Math.sin(ang - spread) * beamLen);
        c.lineTo(Math.cos(ang + spread) * beamLen, Math.sin(ang + spread) * beamLen);
        c.closePath();
        c.fill();
      }
      c.restore();

      for (const m of state.motes) {
        const tw = 0.45 + 0.55 * Math.sin(t * 0.002 + m.phase);
        c.fillStyle = `rgba(253, 215, 110, ${(m.bokeh ? 0.16 : 0.42) * k * tw})`;
        c.beginPath();
        c.arc(m.x, m.y, m.bokeh ? m.r * 2.4 : m.r, 0, Math.PI * 2);
        c.fill();
        m.y -= m.speed * step;
        m.x -= m.speed * 0.45 * step;
        if (m.y < -12) { m.y = h * 0.82; m.x = rand(w * 0.25, w); }
      }
    }

    // 2. Parallax multi-puff clouds
    if (state.clouds.length) {
      for (const cl of state.clouds) {
        const storm = weather === "thunder" || weather === "rain";
        const alpha = (weather === "partly" ? 0.22 : storm ? 0.24 : 0.28) * k * (0.65 + cl.depth * 0.18);
        const fill = storm
          ? (dark ? `rgba(30, 41, 59, ${alpha})` : `rgba(100, 116, 139, ${alpha})`)
          : (dark ? `rgba(148, 163, 184, ${alpha * 0.7})` : `rgba(255, 255, 255, ${Math.min(0.65, alpha * 1.6)})`);
        c.fillStyle = fill;
        c.beginPath();
        for (const p of cl.puffs) {
          c.moveTo(cl.x + p.ox + p.r, cl.y + p.oy);
          c.arc(cl.x + p.ox, cl.y + p.oy, p.r, 0, Math.PI * 2);
        }
        c.fill();
        cl.x += cl.speed * step;
        if (cl.x - 160 * cl.scale > w) cl.x = -180 * cl.scale;
      }
    }

    // 3. Rain & splashes & Thunder lightning
    if (weather === "rain" || weather === "thunder") {
      for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass === 0
          ? (dark ? `rgba(147, 197, 253, ${0.22 * k})` : `rgba(59, 130, 246, ${0.18 * k})`)
          : (dark ? `rgba(191, 219, 254, ${0.42 * k})` : `rgba(37, 99, 235, ${0.32 * k})`);
        c.lineWidth = pass === 0 ? 1 : 1.5;
        c.beginPath();
        for (const d of state.drops) {
          if (Boolean(d.far) !== (pass === 0)) continue;
          c.moveTo(d.x, d.y);
          c.lineTo(d.x - d.len * 0.26, d.y + d.len);
          d.y += d.speed * step;
          d.x -= d.speed * 0.26 * step;
          if (d.y > h) {
            if (!d.far && state.splashes.length < (isPreview ? 12 : 28) && Math.random() < 0.35) {
              state.splashes.push({ x: d.x, y: h - 2, vx: rand(-1.4, 1.4), vy: rand(-2.8, -1.2), life: 1 });
            }
            d.y = -d.len;
            d.x = rand(0, w + 160);
          }
        }
        c.stroke();
      }
      // Splashes at viewport floor
      c.strokeStyle = dark ? `rgba(191, 219, 254, ${0.45 * k})` : `rgba(59, 130, 246, ${0.38 * k})`;
      c.lineWidth = 1.2;
      for (let i = state.splashes.length - 1; i >= 0; i--) {
        const s = state.splashes[i];
        c.beginPath();
        c.arc(s.x, s.y, (1 - s.life) * 8 + 1.5, Math.PI, Math.PI * 2);
        c.stroke();
        s.x += s.vx * step;
        s.y += s.vy * step;
        s.vy += 0.22 * step;
        s.life -= 0.07 * step;
        if (s.life <= 0) state.splashes.splice(i, 1);
      }

      if (weather === "thunder") {
        if (t > state.nextFlash) {
          state.flash = 1;
          state.bolt = makeBolt(w, h);
          state.nextFlash = t + rand(isPreview ? 2800 : 7000, isPreview ? 5000 : 14000);
        }
        if (state.flash > 0.02) {
          c.fillStyle = `rgba(224, 231, 255, ${0.12 * k * state.flash})`;
          c.fillRect(0, 0, w, h);
          if (state.bolt && state.flash > 0.25) {
            c.save();
            c.strokeStyle = `rgba(243, 232, 255, ${0.85 * state.flash})`;
            c.shadowColor = "rgba(167, 139, 250, 0.9)";
            c.shadowBlur = 12;
            for (const [x1, y1, x2, y2, lw] of state.bolt) {
              c.lineWidth = lw;
              c.beginPath();
              c.moveTo(x1, y1);
              c.lineTo(x2, y2);
              c.stroke();
            }
            c.restore();
          }
          state.flash *= Math.pow(0.84, step);
        }
      }
    }

    // 4. Snowflakes (soft orbs + rotating 6-point crystal stars)
    if (weather === "snow") {
      c.strokeStyle = dark ? `rgba(240, 249, 255, ${0.72 * k})` : `rgba(96, 165, 250, ${0.58 * k})`;
      c.fillStyle = dark ? `rgba(240, 249, 255, ${0.65 * k})` : `rgba(125, 211, 252, ${0.5 * k})`;
      for (const p of state.flakes) {
        if (p.crystal) {
          c.save();
          c.translate(p.x, p.y);
          c.rotate(p.rot);
          c.lineWidth = 1.1;
          c.beginPath();
          for (let b = 0; b < 3; b++) {
            const a = (b * Math.PI) / 3;
            c.moveTo(-Math.cos(a) * p.r, -Math.sin(a) * p.r);
            c.lineTo(Math.cos(a) * p.r, Math.sin(a) * p.r);
          }
          c.stroke();
          c.restore();
        } else {
          c.beginPath();
          c.arc(p.x, p.y, p.r * 0.65, 0, Math.PI * 2);
          c.fill();
        }
        p.drift += 0.014 * step;
        p.rot += p.vrot * step;
        p.y += p.speed * step;
        p.x += Math.sin(p.drift) * 0.42 * step;
        if (p.y > h + 8) { p.y = -8; p.x = rand(0, w); }
      }
    }

    // 5. Undulating Mist / Fog Ribbons
    if (weather === "fog") {
      const col = dark ? "203, 213, 225" : "248, 250, 252";
      for (const r of state.ribbons) {
        r.phase += r.speed * step;
        c.save();
        c.strokeStyle = `rgba(${col}, ${(isPreview ? 0.34 : 0.16) * k})`;
        c.lineWidth = r.thick;
        c.lineCap = "round";
        c.beginPath();
        for (let x = -40; x <= w + 40; x += 48) {
          const y = r.y + Math.sin(x * r.freq + r.phase) * r.amp;
          if (x === -40) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
        c.restore();
      }
    }

    // 6. Night Crescent Moon + Aurora Ribbon + Twinkling Stars + Shooting Star
    if (weather === "night") {
      // Subtle aurora borealis arc
      const aurGrad = c.createLinearGradient(0, 0, w, h * 0.42);
      aurGrad.addColorStop(0, `rgba(56, 189, 248, ${0.09 * k})`);
      aurGrad.addColorStop(0.5, `rgba(129, 140, 248, ${0.12 * k})`);
      aurGrad.addColorStop(1, `rgba(52, 211, 153, ${0.08 * k})`);
      c.save();
      c.strokeStyle = aurGrad;
      c.lineWidth = isPreview ? 24 : 52;
      c.lineCap = "round";
      c.beginPath();
      for (let x = 0; x <= w; x += 60) {
        const y = (isPreview ? h * 0.25 : 70) + Math.sin(x * 0.0045 + t * 0.0007) * (isPreview ? 10 : 22);
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.restore();

      // Glowing crescent moon
      const mx = w * 0.87;
      const my = isPreview ? h * 0.28 : 66;
      const mr = isPreview ? 15 : 22;
      c.save();
      const mg = c.createRadialGradient(mx, my, 2, mx, my, mr * 2.5);
      mg.addColorStop(0, `rgba(224, 231, 255, ${0.35 * k})`);
      mg.addColorStop(1, "rgba(224, 231, 255, 0)");
      c.fillStyle = mg;
      c.beginPath(); c.arc(mx, my, mr * 2.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = `rgba(254, 249, 195, ${0.88 * Math.max(0.55, k)})`;
      c.beginPath(); c.arc(mx, my, mr, 0, Math.PI * 2); c.fill();
      c.globalCompositeOperation = "destination-out";
      c.beginPath(); c.arc(mx + mr * 0.38, my - mr * 0.22, mr * 0.85, 0, Math.PI * 2); c.fill();
      c.restore();

      for (const s of state.stars) {
        const tw = 0.35 + 0.65 * Math.sin(t * 0.0022 + s.phase);
        c.fillStyle = `rgba(${s.tint}, ${(isPreview ? 0.85 : 0.65) * k * tw})`;
        c.beginPath();
        c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        c.fill();
      }

      if (t > state.nextShoot && !state.shooting) {
        state.shooting = { x: rand(w * 0.25, w * 0.78), y: rand(12, h * 0.26), vx: rand(-9, -6), vy: rand(3.5, 5.5), life: 1 };
        state.nextShoot = t + rand(isPreview ? 3200 : 8000, isPreview ? 6000 : 16000);
      }
      if (state.shooting) {
        const sh = state.shooting;
        c.strokeStyle = `rgba(254, 249, 195, ${0.9 * sh.life})`;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(sh.x, sh.y);
        c.lineTo(sh.x - sh.vx * 5.5, sh.y - sh.vy * 5.5);
        c.stroke();
        sh.x += sh.vx * step;
        sh.y += sh.vy * step;
        sh.life -= 0.045 * step;
        if (sh.life <= 0) state.shooting = null;
      }
    }
  }

  /* ---------------- apply & main loop ---------------- */
  function apply() {
    const weather = current();
    const root = document.documentElement;
    if (weather) root.dataset.weather = weather; else delete root.dataset.weather;
    root.style.setProperty("--wx-intensity", String(settings.intensity / 100));
    const chip = WEATHERS[weather || (settings.mode === "manual" ? settings.weather : "clear")];
    if ($("weather-icon")) $("weather-icon").textContent = settings.enabled ? chip.icon : "☼";
    const description = !settings.enabled ? "날씨 테마 꺼짐" :
      settings.mode === "auto" ? (live ? `현재 날씨 ${WEATHERS[live.weather].label} ${live.temp}°C` : "날씨 확인 중") : `날씨 테마: ${chip.label}`;
    if ($("weather-label")) $("weather-label").textContent = settings.enabled && settings.mode === "auto" && live ? `${live.temp}°` : "";
    if ($("weather-open")) {
      $("weather-open").title = description + " · 클릭해서 설정";
      $("weather-open").setAttribute("aria-label", description);
      $("weather-open").classList.toggle("active", settings.enabled);
    }
    populateScene(mainState, weather, innerWidth, innerHeight, settings.intensity, false);
    ensureLoop();
  }

  function active() {
    return Boolean(current()) && document.body.dataset.view === "ide" && !document.hidden;
  }

  function resize() {
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function loop(t) {
    frame = null;
    if (!active()) { ctx?.clearRect(0, 0, innerWidth, innerHeight); return; }
    const dt = Math.min(80, t - (lastTick || t));
    if (t - lastTick >= 28) {
      const dark = document.documentElement.dataset.ideTheme === "dark";
      drawScene(ctx, innerWidth, innerHeight, current(), settings.intensity / 100, dark, t, dt, mainState, false);
      lastTick = t;
    }
    if (settings.motion && !reducedMotion) frame = requestAnimationFrame(loop);
  }

  function ensureLoop() {
    if (!canvas || !glow) return;
    canvas.hidden = !active();
    glow.hidden = !active();
    if (!active()) { if (frame) cancelAnimationFrame(frame); frame = null; ctx?.clearRect(0, 0, innerWidth, innerHeight); return; }
    if (!(settings.motion && !reducedMotion)) {
      const dark = document.documentElement.dataset.ideTheme === "dark";
      drawScene(ctx, innerWidth, innerHeight, current(), settings.intensity / 100, dark, performance.now(), 0, mainState, false);
      return;
    }
    lastTick = 0;
    if (!frame) frame = requestAnimationFrame(loop);
  }

  /* ---------------- live dialog preview ---------------- */
  function previewTargetWeather() {
    if (hoveredWeather && WEATHERS[hoveredWeather]) return hoveredWeather;
    if (settings.mode === "auto" && live?.weather) return live.weather;
    return settings.weather;
  }

  function previewLoop(t) {
    previewFrame = null;
    const dlg = $("weather-dialog");
    const pCanvas = $("weather-preview-canvas");
    if (!dlg?.open || !pCanvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = pCanvas.clientWidth || 520;
    const h = pCanvas.clientHeight || 146;
    if (pCanvas.width !== Math.round(w * dpr) || pCanvas.height !== Math.round(h * dpr)) {
      pCanvas.width = Math.round(w * dpr);
      pCanvas.height = Math.round(h * dpr);
    }
    const pctx = pCanvas.getContext("2d");
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dt = Math.min(80, t - (previewLastTick || t));
    const dark = document.documentElement.dataset.ideTheme === "dark";
    const wx = previewTargetWeather();
    drawScene(pctx, w, h, wx, Math.max(0.45, settings.intensity / 100), dark, t, dt, previewState, true);
    previewLastTick = t;
    previewFrame = requestAnimationFrame(previewLoop);
  }

  function ensurePreviewLoop() {
    if ($("weather-dialog")?.open) {
      if (!previewFrame) {
        previewLastTick = 0;
        previewFrame = requestAnimationFrame(previewLoop);
      }
    } else if (previewFrame) {
      cancelAnimationFrame(previewFrame);
      previewFrame = null;
    }
  }

  function updatePreviewHeader() {
    const wx = previewTargetWeather();
    const info = WEATHERS[wx] || WEATHERS.clear;
    const badge = $("weather-preview-badge");
    const sub = $("weather-preview-label");
    if (badge) badge.textContent = `${info.icon} ${info.label}`;
    if (sub) sub.textContent = settings.enabled ? info.desc : `${info.desc} (테마가 꺼져 있어 미리보기만 재생 중)`;
  }

  /* ---------------- settings dialog ---------------- */
  function renderDialog() {
    $("weather-enabled").checked = settings.enabled;
    $("weather-options").disabled = !settings.enabled;
    for (const radio of document.querySelectorAll('input[name="weather-mode"]')) {
      radio.checked = radio.value === settings.mode;
      radio.closest(".weather-mode-pill")?.classList.toggle("active", radio.checked);
    }
    $("weather-intensity").value = String(settings.intensity);
    if ($("weather-intensity-val")) $("weather-intensity-val").textContent = `${settings.intensity}%`;
    document.querySelectorAll(".weather-preset-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.intensity) === settings.intensity);
    });
    if ($("weather-refresh-auto")) $("weather-refresh-auto").hidden = !settings.enabled || settings.mode !== "auto";
    $("weather-motion").checked = settings.motion;
    $("weather-motion").disabled = reducedMotion;
    if (reducedMotion) $("weather-motion").parentElement.title = "시스템의 '동작 줄이기' 설정으로 애니메이션이 꺼져 있습니다.";

    const choices = $("weather-choices");
    choices.replaceChildren(...Object.entries(WEATHERS).map(([key, w]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "weather-choice wx-" + key + (settings.weather === key ? " selected" : "");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(settings.weather === key));
      b.disabled = !settings.enabled || settings.mode !== "manual";
      const ic = Object.assign(document.createElement("span"), { textContent: w.icon, className: "weather-choice-icon" });
      const title = Object.assign(document.createElement("strong"), { textContent: w.label, className: "weather-choice-label" });
      const mood = Object.assign(document.createElement("small"), { textContent: w.mood, className: "weather-choice-mood" });
      b.append(ic, title, mood);
      b.onmouseenter = () => { hoveredWeather = key; updatePreviewHeader(); };
      b.onmouseleave = () => { hoveredWeather = null; updatePreviewHeader(); };
      b.onclick = () => {
        settings.weather = key;
        settings.mode = "manual";
        settings.enabled = true;
        save();
        renderDialog();
        apply();
      };
      return b;
    }));
    if (settings.mode !== "auto") setAutoStatus("");
    updatePreviewHeader();
  }

  $("weather-open")?.addEventListener("click", () => {
    renderDialog();
    $("weather-dialog").showModal();
    ensurePreviewLoop();
  });
  $("weather-dialog")?.addEventListener("close", () => {
    hoveredWeather = null;
    ensurePreviewLoop();
  });
  $("weather-enabled")?.addEventListener("change", (e) => { settings.enabled = e.target.checked; save(); renderDialog(); apply(); refreshAuto(); });
  for (const radio of document.querySelectorAll('input[name="weather-mode"]')) {
    radio.addEventListener("change", () => { settings.mode = radio.value; save(); renderDialog(); apply(); refreshAuto(); });
  }
  $("weather-intensity")?.addEventListener("input", (e) => {
    settings.intensity = Number(e.target.value);
    if ($("weather-intensity-val")) $("weather-intensity-val").textContent = `${settings.intensity}%`;
    document.querySelectorAll(".weather-preset-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.intensity) === settings.intensity);
    });
    save();
    apply();
  });
  document.querySelectorAll(".weather-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.intensity = Number(btn.dataset.intensity) || 70;
      save();
      renderDialog();
      apply();
    });
  });
  $("weather-refresh-auto")?.addEventListener("click", () => refreshAuto(true));
  $("weather-motion")?.addEventListener("change", (e) => { settings.motion = e.target.checked; save(); apply(); });

  window.addEventListener("resize", () => { resize(); populateScene(mainState, current(), innerWidth, innerHeight, settings.intensity, false); ensureLoop(); });
  document.addEventListener("visibilitychange", ensureLoop);
  new MutationObserver(ensureLoop).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  new MutationObserver(() => { if (current() && !(settings.motion && !reducedMotion)) ensureLoop(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-ide-theme"] });

  resize();
  apply();
  refreshAuto();
  return { apply, get settings() { return { ...settings }; } };
})();
