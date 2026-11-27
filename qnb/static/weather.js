"use strict";

/* Weather-reactive IDE theme. Settings live in localStorage; "auto" uses the browser's
 * location (rounded to ~10 km) and Open-Meteo's free forecast API. */
window.QNBWeather = (() => {
  const KEY = "qnb_weather";
  const CACHE_KEY = "qnb_weather_cache";
  const WEATHERS = {
    clear: { icon: "☀", label: "맑음" },
    partly: { icon: "⛅", label: "구름 조금" },
    cloudy: { icon: "☁", label: "흐림" },
    rain: { icon: "🌧", label: "비" },
    snow: { icon: "❄", label: "눈" },
    thunder: { icon: "⛈", label: "뇌우" },
    fog: { icon: "🌫", label: "안개" },
    night: { icon: "🌙", label: "맑은 밤" },
  };
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const defaults = { enabled: false, mode: "manual", weather: "clear", intensity: 60, motion: !reducedMotion };
  let settings = { ...defaults };
  try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* keep defaults */ }
  if (!WEATHERS[settings.weather]) settings.weather = "clear";

  let live = null; // { weather, temp, at }
  try { live = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { live = null; }
  let autoTimer = null;

  const canvas = $("weather-fx");
  const glow = $("weather-glow");
  const ctx = canvas.getContext("2d");
  let particles = [];
  let frame = null;
  let lastTick = 0;
  let flash = 0;
  let nextFlash = 0;

  function save() { localStorage.setItem(KEY, JSON.stringify(settings)); }

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

  function setAutoStatus(text) { $("weather-auto-status").textContent = text || ""; }

  function refreshAuto(force = false) {
    clearTimeout(autoTimer);
    if (!settings.enabled || settings.mode !== "auto") return;
    autoTimer = setTimeout(() => refreshAuto(true), 30 * 60 * 1000);
    if (!force && live && Date.now() - live.at < 30 * 60 * 1000) { apply(); return; }
    if (!navigator.geolocation) { setAutoStatus("이 브라우저는 위치 정보를 지원하지 않습니다. 직접 선택을 사용하세요."); return; }
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
        setAutoStatus(`현재 날씨: ${WEATHERS[live.weather].label} · ${live.temp}°C`);
        apply();
      } catch {
        setAutoStatus("날씨 정보를 가져오지 못했습니다. 잠시 후 다시 시도하거나 직접 선택하세요.");
      }
    }, () => setAutoStatus("위치 권한이 거부되었습니다. 직접 선택 모드를 사용하세요."), { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 15000 });
  }

  /* ---------------- rendering ---------------- */
  function apply() {
    const weather = current();
    const root = document.documentElement;
    if (weather) root.dataset.weather = weather; else delete root.dataset.weather;
    root.style.setProperty("--wx-intensity", String(settings.intensity / 100));
    const chip = WEATHERS[weather || (settings.mode === "manual" ? settings.weather : "clear")];
    $("weather-icon").textContent = settings.enabled ? chip.icon : "☼";
    // Compact chip: icon (plus temperature in auto mode); the full description lives in the tooltip.
    const description = !settings.enabled ? "날씨 테마 꺼짐" :
      settings.mode === "auto" ? (live ? `현재 날씨 ${WEATHERS[live.weather].label} ${live.temp}°C` : "날씨 확인 중") : `날씨 테마: ${chip.label}`;
    $("weather-label").textContent = settings.enabled && settings.mode === "auto" && live ? `${live.temp}°` : "";
    $("weather-open").title = description + " · 클릭해서 설정";
    $("weather-open").setAttribute("aria-label", description);
    $("weather-open").classList.toggle("active", settings.enabled);
    resetParticles();
    ensureLoop();
  }

  function active() {
    return Boolean(current()) && document.body.dataset.view === "ide" && !document.hidden;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resetParticles() {
    const weather = current();
    const k = settings.intensity / 100;
    const area = (innerWidth * innerHeight) / (1280 * 800);
    particles = [];
    const n = (base) => Math.round(base * k * Math.max(0.5, area));
    if (weather === "rain" || weather === "thunder") {
      for (let i = 0; i < n(weather === "thunder" ? 170 : 130); i++) particles.push({ x: rand(0, innerWidth), y: rand(0, innerHeight), len: rand(10, 22), speed: rand(9, 15) });
    } else if (weather === "snow") {
      for (let i = 0; i < n(110); i++) particles.push({ x: rand(0, innerWidth), y: rand(0, innerHeight), r: rand(1, 3.2), speed: rand(0.4, 1.3), drift: rand(0, Math.PI * 2) });
    } else if (weather === "partly" || weather === "cloudy" || weather === "fog") {
      const count = weather === "partly" ? 4 : weather === "cloudy" ? 8 : 6;
      for (let i = 0; i < count; i++) particles.push({ x: rand(-200, innerWidth), y: weather === "fog" ? rand(innerHeight * 0.2, innerHeight) : rand(-40, innerHeight * 0.45), w: rand(180, 380), speed: rand(0.08, 0.25) });
    } else if (weather === "night") {
      for (let i = 0; i < n(90); i++) particles.push({ x: rand(0, innerWidth), y: rand(0, innerHeight * 0.7), r: rand(0.5, 1.6), phase: rand(0, Math.PI * 2) });
    } else if (weather === "clear") {
      for (let i = 0; i < n(26); i++) particles.push({ x: rand(innerWidth * 0.4, innerWidth), y: rand(0, innerHeight * 0.6), r: rand(1, 2.4), speed: rand(0.05, 0.2), phase: rand(0, Math.PI * 2) });
    }
  }

  function draw(t, dt) {
    const weather = current();
    const k = settings.intensity / 100;
    const dark = document.documentElement.dataset.ideTheme === "dark";
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!weather) return;
    const step = dt / 16.7;
    if (weather === "rain" || weather === "thunder") {
      ctx.strokeStyle = dark ? `rgba(170, 200, 255, ${0.28 * k})` : `rgba(60, 90, 140, ${0.22 * k})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of particles) {
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.len * 0.25, p.y + p.len);
        p.y += p.speed * step;
        p.x -= p.speed * 0.25 * step;
        if (p.y > innerHeight) { p.y = -p.len; p.x = rand(0, innerWidth + 100); }
      }
      ctx.stroke();
      if (weather === "thunder") {
        // Soft, rare flashes (never faster than every ~7 s) to stay comfortable for photosensitive users.
        if (t > nextFlash) { flash = 1; nextFlash = t + rand(7000, 14000); }
        if (flash > 0.01) {
          ctx.fillStyle = `rgba(235, 230, 255, ${0.10 * k * flash})`;
          ctx.fillRect(0, 0, innerWidth, innerHeight);
          flash *= Math.pow(0.86, step);
        }
      }
    } else if (weather === "snow") {
      ctx.fillStyle = dark ? `rgba(240, 248, 255, ${0.55 * k})` : `rgba(140, 170, 200, ${0.45 * k})`;
      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.drift += 0.01 * step;
        p.y += p.speed * step;
        p.x += Math.sin(p.drift) * 0.35 * step;
        if (p.y > innerHeight + 4) { p.y = -4; p.x = rand(0, innerWidth); }
      }
    } else if (weather === "partly" || weather === "cloudy" || weather === "fog") {
      for (const p of particles) {
        const g = ctx.createRadialGradient(p.x + p.w / 2, p.y + p.w * 0.25, 0, p.x + p.w / 2, p.y + p.w * 0.25, p.w * 0.6);
        const base = weather === "fog" ? (dark ? "200, 205, 215" : "230, 232, 236") : (dark ? "190, 200, 215" : "150, 160, 175");
        const alpha = (weather === "fog" ? 0.16 : weather === "cloudy" ? 0.10 : 0.08) * k;
        g.addColorStop(0, `rgba(${base}, ${alpha})`);
        g.addColorStop(1, `rgba(${base}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(p.x - p.w * 0.1, p.y - p.w * 0.4, p.w * 1.2, p.w * 1.3);
        p.x += p.speed * step;
        if (p.x > innerWidth + 50) p.x = -p.w - rand(0, 200);
      }
    } else if (weather === "night") {
      for (const p of particles) {
        const tw = 0.5 + 0.5 * Math.sin(t / 900 + p.phase);
        ctx.fillStyle = dark ? `rgba(255, 255, 240, ${0.55 * k * tw})` : `rgba(90, 90, 140, ${0.35 * k * tw})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (weather === "clear") {
      for (const p of particles) {
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t / 2400 + p.phase));
        ctx.fillStyle = `rgba(255, 200, 90, ${0.32 * k * tw})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.y -= p.speed * step;
        p.x -= p.speed * 0.5 * step;
        if (p.y < -5) { p.y = innerHeight * 0.6; p.x = rand(innerWidth * 0.4, innerWidth); }
      }
    }
  }

  function loop(t) {
    frame = null;
    if (!active()) { ctx.clearRect(0, 0, innerWidth, innerHeight); return; }
    const dt = Math.min(100, t - (lastTick || t));
    if (t - lastTick >= 32) { // ~30 fps is plenty for ambience
      draw(t, dt);
      lastTick = t;
    }
    if (settings.motion && !reducedMotion) frame = requestAnimationFrame(loop);
  }

  function ensureLoop() {
    canvas.hidden = !active();
    glow.hidden = !active();
    if (!active()) { if (frame) cancelAnimationFrame(frame); frame = null; ctx.clearRect(0, 0, innerWidth, innerHeight); return; }
    if (!(settings.motion && !reducedMotion)) { draw(performance.now(), 0); return; } // static frame
    lastTick = 0;
    if (!frame) frame = requestAnimationFrame(loop);
  }

  /* ---------------- settings dialog ---------------- */
  function renderDialog() {
    $("weather-enabled").checked = settings.enabled;
    $("weather-options").disabled = !settings.enabled;
    for (const radio of document.querySelectorAll('input[name="weather-mode"]')) radio.checked = radio.value === settings.mode;
    $("weather-intensity").value = String(settings.intensity);
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
      b.append(Object.assign(document.createElement("span"), { textContent: w.icon, className: "weather-choice-icon" }), w.label);
      b.onclick = () => { settings.weather = key; save(); renderDialog(); apply(); };
      return b;
    }));
    if (settings.mode !== "auto") setAutoStatus("");
  }

  $("weather-open").onclick = () => { renderDialog(); $("weather-dialog").showModal(); };
  $("weather-enabled").onchange = (e) => { settings.enabled = e.target.checked; save(); renderDialog(); apply(); refreshAuto(); };
  for (const radio of document.querySelectorAll('input[name="weather-mode"]')) {
    radio.onchange = () => { settings.mode = radio.value; save(); renderDialog(); apply(); refreshAuto(); };
  }
  $("weather-intensity").oninput = (e) => { settings.intensity = Number(e.target.value); save(); apply(); };
  $("weather-motion").onchange = (e) => { settings.motion = e.target.checked; save(); apply(); };

  window.addEventListener("resize", () => { resize(); resetParticles(); ensureLoop(); });
  document.addEventListener("visibilitychange", ensureLoop);
  // The IDE view toggles body[data-view]; restart or stop the effect accordingly.
  new MutationObserver(ensureLoop).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  new MutationObserver(() => { if (current() && !(settings.motion && !reducedMotion)) ensureLoop(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-ide-theme"] });

  resize();
  apply();
  refreshAuto();
  return { apply, get settings() { return { ...settings }; } };
})();
