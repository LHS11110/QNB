"use strict";

/* A small companion ("큐비") that wanders along the IDE status bar and plays with the mouse.
 *  - notices a nearby cursor ("!"), watches it or runs after it
 *  - jumps up, grabs the cursor and hangs from it, swinging as the mouse moves
 *    (shake the mouse, click, type or wait a few seconds and it lets go)
 *  - rub the cursor back and forth over it to pet it (hearts), rest the cursor on it to tickle it
 *  - a cursor whipping past makes it hop away in surprise
 *  - click: jump and talk; drag: pick up and throw
 * Visibility is stored in localStorage; the #mascot-toggle tool button switches it. */
window.QNBMascot = (() => {
  const KEY = "qnb_mascot";
  const SIZE = 44;
  const ANCHOR_X = 22;     // where its raised hands meet, in svg/root coordinates
  const ANCHOR_Y = 1;
  const ARM = 23;          // anchor → body centre, the pendulum length
  const WALK_SPEED = 38;   // px / s
  const RUN_SPEED = 105;   // px / s while chasing the cursor
  const GRAVITY = 1800;    // px / s²
  const NOTICE_RADIUS = 240;
  const REACH_HEIGHT = 250; // highest cursor (above its head) it will jump for
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const LINES = {
    click: ["안녕하세요!", "증명은 잘 되어가나요?", "오늘도 화이팅!", "저 여기 있어요~", "QED!", "커피 한 잔 어때요?", "버그는 제가 지켜볼게요 👀"],
    sleep: ["Zzz…"],
    wake: ["앗, 깼어요!", "다시 출발~"],
    wakeByHover: ["음냐… 누구세요?", "으응… 5분만 더…"],
    save: ["저장 완료!", "잘 저장했어요 ✨"],
    drop: ["와아아—", "어지러워요…", "착지 성공!"],
    hello: ["안녕! 저는 큐비예요.", "같이 코딩해요!"],
    chase: ["거기 서!", "잡으러 간다~", "마우스다!"],
    grab: ["잡았다! 🖱️", "놓치지 않을 거예요!", "같이 가요~"],
    swing: ["위이이~", "더 빨리!", "신난다!"],
    tired: ["팔 아파요…", "이제 내려갈게요", "휴, 재밌었다!"],
    shaken: ["으아악!", "살살 해요!", "날아간다~"],
    released: ["앗, 놓을게요!", "알겠어요~"],
    miss: ["아깝다!", "조금만 더…", "다시 한 번!"],
    giveUp: ["흥, 다음엔 꼭!", "너무 빨라요…"],
    tooHigh: ["너무 높아요!", "내려와요~"],
    pet: ["헤헤, 좋아요~", "기분 좋아요 💜", "더 쓰다듬어 주세요!"],
    tickle: ["간지러워요!", "히히히", "거기 간지러워요~"],
    dodge: ["깜짝이야!", "휴, 피했다!", "으앗!"],
  };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let enabled = localStorage.getItem(KEY) !== "off";
  let root = null;
  let svg = null;
  let pupils = null;
  let bubble = null;
  let emote = null;
  let bubbleTimer = null;
  let emoteTimer = null;
  let frame = null;
  let last = 0;
  let ide = null;

  // Character state.
  const s = {
    x: 120, y: 0, vx: 0, vy: 0, dir: 1,
    mode: "fall",          // walk | idle | sleep | watch | chase | crouch | reach | hang | jump | fall | drag
    until: 0,              // when the current phase ends
    idleSince: 0,
    // dragging the character itself
    pressed: false, pressAt: null, dragDX: 0, dragDY: 0, dragMoved: false, lastPointer: null,
    // cursor play
    noticeAt: 0, grabAt: 0, dodgeAt: 0, attempts: 0, tooHighSaid: false,
    hangSince: 0, hangFor: 0, theta: 0, omega: 0, swingSaidAt: 0,
    hoverSince: 0, tickled: false, petTurns: [], happyUntil: 0, heartAt: 0,
  };

  // Pointer state, tracked globally (mouse only for the playful behaviours).
  const ptr = {
    x: -1e4, y: -1e4, inside: false, mouse: true, buttons: 0, movedAt: 0,
    vx: 0, vy: 0,              // event-smoothed velocity (px/s)
    fx: null, fy: null, fvx: 0, fvy: 0, ax: 0, ay: 0, // per-frame tracking for the pendulum
    lastDirX: 0,
    trail: [],                 // [time, distance] of recent moves, for shake detection
  };
  let typedAt = 0;

  const SVG = `
    <svg viewBox="0 0 44 44" width="${SIZE}" height="${SIZE}" aria-hidden="true">
      <g class="qm-body">
        <path class="qm-antenna" d="M22 9 Q22 4 25 2"/>
        <circle class="qm-antenna-dot" cx="25.5" cy="2.5" r="2.2"/>
        <g class="qm-arms-up">
          <path class="qm-arm" d="M9.5 18 Q11 6 19.4 1.6"/><path class="qm-arm" d="M34.5 18 Q33 6 24.6 1.6"/>
          <circle class="qm-hand" cx="19.6" cy="1.6" r="2.6"/><circle class="qm-hand" cx="24.4" cy="1.6" r="2.6"/>
        </g>
        <g class="qm-arms-down">
          <path class="qm-arm" d="M6.5 25 Q2.5 28 3.2 32.5"/><path class="qm-arm" d="M37.5 25 Q41.5 28 40.8 32.5"/>
        </g>
        <g class="qm-feet"><ellipse class="qm-foot qm-foot-l" cx="15.5" cy="40.5" rx="4.2" ry="2.6"/><ellipse class="qm-foot qm-foot-r" cx="28.5" cy="40.5" rx="4.2" ry="2.6"/></g>
        <rect class="qm-shell" x="5" y="8" width="34" height="32" rx="15"/>
        <ellipse class="qm-belly" cx="22" cy="30" rx="9" ry="6"/>
        <g class="qm-eyes">
          <ellipse class="qm-eye" cx="16" cy="21" rx="3.4" ry="4"/><ellipse class="qm-eye" cx="28" cy="21" rx="3.4" ry="4"/>
          <g class="qm-pupils"><circle class="qm-pupil" cx="16.6" cy="21.6" r="1.9"/><circle class="qm-pupil" cx="28.6" cy="21.6" r="1.9"/></g>
          <path class="qm-lid" d="M12.2 21.5h7.6M24.2 21.5h7.6"/>
          <path class="qm-happy" d="M12.6 22.4q3.4-4.4 6.8 0M24.6 22.4q3.4-4.4 6.8 0"/>
        </g>
        <ellipse class="qm-cheek" cx="11" cy="27" rx="2.4" ry="1.4"/><ellipse class="qm-cheek" cx="33" cy="27" rx="2.4" ry="1.4"/>
        <path class="qm-mouth" d="M19.5 27.2q2.5 2.2 5 0"/>
      </g>
      <text class="qm-z" x="34" y="8">z</text>
    </svg>`;

  const CSS = `
    .qnb-mascot { position: fixed; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px; z-index: 40; cursor: grab;
      touch-action: none; user-select: none; -webkit-user-select: none; will-change: transform;
      transform-origin: ${ANCHOR_X}px ${ANCHOR_Y}px; }
    .qnb-mascot.dragging { cursor: grabbing; }
    .qnb-mascot.hang { pointer-events: none; }
    .qnb-mascot svg { display: block; overflow: visible; transform-origin: 50% 100%; }
    .qnb-mascot .qm-shell { fill: var(--accent, #4338CA); }
    .qnb-mascot .qm-belly { fill: #fff; opacity: .22; }
    .qnb-mascot .qm-foot, .qnb-mascot .qm-hand { fill: color-mix(in srgb, var(--accent, #4338CA) 70%, #000); }
    .qnb-mascot .qm-arm { fill: none; stroke: color-mix(in srgb, var(--accent, #4338CA) 70%, #000); stroke-width: 3; stroke-linecap: round; }
    .qnb-mascot .qm-arms-up { opacity: 0; }
    .qnb-mascot .qm-antenna { fill: none; stroke: color-mix(in srgb, var(--accent, #4338CA) 70%, #000); stroke-width: 1.8; stroke-linecap: round; }
    .qnb-mascot .qm-antenna-dot { fill: #F59E0B; }
    .qnb-mascot .qm-eye { fill: #fff; }
    .qnb-mascot .qm-pupil { fill: #1F2937; }
    .qnb-mascot .qm-pupils { transition: transform .12s ease-out; }
    .qnb-mascot .qm-lid, .qnb-mascot .qm-happy { fill: none; stroke: #1F2937; stroke-width: 1.6; stroke-linecap: round; opacity: 0; }
    .qnb-mascot .qm-cheek { fill: #F472B6; opacity: .55; transition: opacity .2s ease; }
    .qnb-mascot .qm-mouth { fill: none; stroke: #1F2937; stroke-width: 1.4; stroke-linecap: round; }
    .qnb-mascot .qm-z { font: 700 9px var(--mono, monospace); fill: var(--muted, #6B7280); opacity: 0; }
    .qnb-mascot .qm-eyes { animation: qm-blink 4.2s infinite; transform-origin: 22px 21px; }
    .qnb-mascot.walk .qm-foot-l, .qnb-mascot.chase .qm-foot-l { animation: qm-step .42s infinite ease-in-out; }
    .qnb-mascot.walk .qm-foot-r, .qnb-mascot.chase .qm-foot-r { animation: qm-step .42s infinite ease-in-out reverse; }
    .qnb-mascot.chase .qm-foot { animation-duration: .2s !important; }
    .qnb-mascot.walk .qm-body { animation: qm-bob .21s infinite alternate ease-in-out; }
    .qnb-mascot.chase .qm-body { animation: qm-bob .1s infinite alternate ease-in-out; }
    .qnb-mascot.idle .qm-body, .qnb-mascot.watch .qm-body { animation: qm-breathe 2.4s infinite ease-in-out; transform-origin: 22px 40px; }
    .qnb-mascot.sleep .qm-eyes { animation: none; }
    .qnb-mascot.sleep .qm-eye, .qnb-mascot.sleep .qm-pupils { opacity: 0; }
    .qnb-mascot.sleep .qm-lid { opacity: 1; }
    .qnb-mascot.sleep .qm-body { animation: qm-breathe 3.6s infinite ease-in-out; transform-origin: 22px 40px; }
    .qnb-mascot.sleep .qm-z { animation: qm-z 2.4s infinite ease-out; }
    .qnb-mascot.air .qm-mouth, .qnb-mascot.dragging .qm-mouth, .qnb-mascot.reach .qm-mouth, .qnb-mascot.hang .qm-mouth,
    .qnb-mascot.chase .qm-mouth { d: path("M19.8 26.6q2.2 3.4 4.4 0z"); fill: #1F2937; }
    .qnb-mascot.dragging .qm-feet, .qnb-mascot.hang .qm-feet { animation: qm-dangle .5s infinite alternate ease-in-out; transform-origin: 22px 38px; }
    .qnb-mascot.hang .qm-feet { animation-duration: .32s; }
    .qnb-mascot.reach .qm-arms-up, .qnb-mascot.hang .qm-arms-up, .qnb-mascot.wave .qm-arms-up { opacity: 1; }
    .qnb-mascot.reach .qm-arms-down, .qnb-mascot.hang .qm-arms-down, .qnb-mascot.wave .qm-arms-down { opacity: 0; }
    .qnb-mascot.reach .qm-antenna, .qnb-mascot.reach .qm-antenna-dot,
    .qnb-mascot.hang .qm-antenna, .qnb-mascot.hang .qm-antenna-dot { opacity: 0; }
    .qnb-mascot.wave .qm-arms-up { animation: qm-wave .3s infinite alternate ease-in-out; transform-origin: 22px 18px; }
    .qnb-mascot.crouch svg { transform: scale(1.14, .82); transition: transform .14s ease-out; }
    .qnb-mascot.happy .qm-eye, .qnb-mascot.happy .qm-pupils { opacity: 0; }
    .qnb-mascot.happy .qm-happy { opacity: 1; }
    .qnb-mascot.happy .qm-eyes { animation: none; }
    .qnb-mascot.happy .qm-cheek { opacity: .95; }
    .qnb-mascot.happy .qm-mouth { d: path("M18.8 26.6q3.2 3.6 6.4 0"); }
    .qnb-mascot.tickle svg { animation: qm-tickle .12s infinite alternate; }
    .qnb-mascot.squash svg { animation: qm-squash .28s ease-out; }
    .qnb-mascot:hover .qm-antenna-dot { fill: #FBBF24; }
    .qnb-mascot-bubble { position: fixed; left: 0; top: 0; z-index: 41; max-width: 14rem; padding: .32rem .6rem; border-radius: .7rem;
      background: var(--panel, #fff); color: var(--text, #111); border: 1px solid var(--line, #ddd);
      box-shadow: 0 4px 14px rgba(0,0,0,.12); font-size: .76rem; line-height: 1.35; white-space: nowrap; pointer-events: none;
      opacity: 0; transform: translateY(4px); transition: opacity .18s ease, transform .18s ease; }
    .qnb-mascot-bubble.show { opacity: 1; transform: translateY(0); }
    .qnb-mascot-bubble::after { content: ""; position: absolute; left: var(--tail, 50%); bottom: -5px; width: 8px; height: 8px; margin-left: -4px;
      background: inherit; border-right: 1px solid var(--line, #ddd); border-bottom: 1px solid var(--line, #ddd); transform: rotate(45deg); }
    .qnb-mascot-emote { position: fixed; left: 0; top: 0; z-index: 41; pointer-events: none; font: 800 15px/1 var(--font, sans-serif);
      color: #F59E0B; text-shadow: 0 1px 0 rgba(0,0,0,.25); opacity: 0; }
    .qnb-mascot-emote.show { animation: qm-pop .9s ease-out forwards; }
    .qnb-mascot-heart { position: fixed; z-index: 41; pointer-events: none; color: #EC4899; font-size: 13px; line-height: 1;
      animation: qm-heart 1.1s ease-out forwards; }
    @keyframes qm-blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.1); } }
    @keyframes qm-step { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
    @keyframes qm-bob { from { transform: translateY(0); } to { transform: translateY(-1.5px); } }
    @keyframes qm-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.03, .97); } }
    @keyframes qm-z { 0% { opacity: 0; transform: translate(0, 0); } 30% { opacity: 1; } 100% { opacity: 0; transform: translate(6px, -10px); } }
    @keyframes qm-dangle { from { transform: rotate(-8deg); } to { transform: rotate(8deg); } }
    @keyframes qm-wave { from { transform: rotate(-7deg); } to { transform: rotate(7deg); } }
    @keyframes qm-tickle { from { transform: rotate(-6deg) scale(1.03, .97); } to { transform: rotate(6deg) scale(.97, 1.03); } }
    @keyframes qm-squash { 0% { transform: scale(1.25, .75); } 60% { transform: scale(.92, 1.08); } 100% { transform: scale(1, 1); } }
    @keyframes qm-pop { 0% { opacity: 0; transform: translateY(6px) scale(.4); } 25% { opacity: 1; transform: translateY(0) scale(1.25); }
      45% { transform: scale(1); } 80% { opacity: 1; } 100% { opacity: 0; transform: translateY(-4px); } }
    @keyframes qm-heart { 0% { opacity: 0; transform: translate(0, 0) scale(.5); } 20% { opacity: 1; transform: translate(var(--hx), -6px) scale(1); }
      100% { opacity: 0; transform: translate(calc(var(--hx) * 2), -34px) scale(.8); } }
    @media (prefers-reduced-motion: reduce) { .qnb-mascot *, .qnb-mascot-heart { animation: none !important; } }
  `;

  // ---------- environment ----------

  function ideVisible() {
    return ide && !ide.hidden && !document.body.classList.contains("proof-page");
  }

  /** The y coordinate the character stands on: top of the status bar, or the viewport bottom. */
  function floorY() {
    const bar = ide?.querySelector(".statusbar");
    const rect = bar?.getBoundingClientRect();
    const bottom = rect && rect.height ? rect.top : window.innerHeight;
    return Math.max(SIZE, Math.min(bottom, window.innerHeight)) - SIZE + 1;
  }

  const maxX = () => Math.max(0, window.innerWidth - SIZE);
  const centreX = () => s.x + SIZE / 2;
  const centreY = () => s.y + SIZE / 2;
  const grounded = () => ["walk", "idle", "watch", "chase", "crouch", "sleep"].includes(s.mode);
  const busyUser = (now) => now - typedAt < 2500 || ptr.buttons !== 0 || s.pressed;
  const cursorFresh = (now, ms = 900) => ptr.inside && ptr.mouse && now - ptr.movedAt < ms;
  const cursorOver = () => ptr.inside && ptr.x >= s.x + 3 && ptr.x <= s.x + SIZE - 3 && ptr.y >= s.y + 6 && ptr.y <= s.y + SIZE;

  // ---------- rendering ----------

  function build() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    root = document.createElement("div");
    root.className = "qnb-mascot idle";
    root.title = "큐비 — 클릭: 점프 · 드래그: 던지기 · 마우스를 가까이 대 보세요";
    root.innerHTML = SVG;
    svg = root.querySelector("svg");
    pupils = root.querySelector(".qm-pupils");
    bubble = document.createElement("div");
    bubble.className = "qnb-mascot-bubble";
    bubble.setAttribute("role", "status");
    emote = document.createElement("div");
    emote.className = "qnb-mascot-emote";
    emote.setAttribute("aria-hidden", "true");
    document.body.append(root, bubble, emote);
    root.addEventListener("pointerdown", onPointerDown);
  }

  const MODE_CLASSES = ["walk", "idle", "sleep", "watch", "chase", "crouch", "reach", "hang", "dragging", "air"];
  function setMode(mode) {
    s.mode = mode;
    if (!root) return;
    const cls = mode === "drag" ? "dragging" : (mode === "jump" || mode === "fall") ? "air" : mode;
    for (const name of MODE_CLASSES) root.classList.toggle(name, name === cls);
    if (mode !== "watch") root.classList.remove("wave");
  }

  function draw() {
    if (s.mode === "hang") {
      // Hands on the cursor tip, body swinging below it.
      // One transform string: rotate about the hands (transform-origin), then move them onto the cursor.
      root.style.transform = `translate(${(ptr.x - ANCHOR_X).toFixed(1)}px, ${(ptr.y - ANCHOR_Y).toFixed(1)}px) rotate(${s.theta.toFixed(3)}rad)`;
    } else {
      root.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
    }
    svg.style.scale = `${s.dir} 1`;
    root.classList.toggle("happy", performance.now() < s.happyUntil);
    if (bubble.classList.contains("show")) placeBubble();
    if (emote.classList.contains("show")) placeEmote();
  }

  /** Top-left of the character's box on screen (accounts for hanging from the cursor). */
  function headPoint() {
    if (s.mode === "hang") {
      const cx = ptr.x - ARM * Math.sin(s.theta);
      const cy = ptr.y + ARM * Math.cos(s.theta);
      return { x: cx - SIZE / 2, y: Math.min(ptr.y, cy - SIZE / 2) - 6 };
    }
    return { x: s.x, y: s.y };
  }

  function placeBubble() {
    const head = headPoint();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const centre = head.x + SIZE / 2;
    const left = clamp(centre - w / 2, 6, window.innerWidth - w - 6);
    let top = head.y - h - 8;
    // Hanging near the top of the screen: put the bubble below instead.
    if (top < 4) top = head.y + SIZE + 14;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.setProperty("--tail", `${clamp(centre - left, 10, w - 10)}px`);
  }

  function placeEmote() {
    const head = headPoint();
    emote.style.left = `${head.x + SIZE / 2 + 10 * s.dir - 4}px`;
    emote.style.top = `${head.y - 14}px`;
  }

  function say(text, ms = 2200) {
    if (!bubble || !enabled) return;
    bubble.textContent = text;
    bubble.classList.add("show");
    placeBubble();
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove("show"), ms);
  }

  function showEmote(text) {
    if (!emote) return;
    emote.textContent = text;
    emote.classList.remove("show"); void emote.offsetWidth; emote.classList.add("show");
    placeEmote();
    clearTimeout(emoteTimer);
    emoteTimer = setTimeout(() => emote.classList.remove("show"), 950);
  }

  function heart() {
    const el = document.createElement("span");
    el.className = "qnb-mascot-heart";
    el.textContent = Math.random() < 0.8 ? "♥" : "✦";
    const head = headPoint();
    el.style.left = `${head.x + 10 + Math.random() * 24}px`;
    el.style.top = `${head.y + 2}px`;
    el.style.setProperty("--hx", `${(Math.random() - 0.5) * 14}px`);
    el.addEventListener("animationend", () => el.remove());
    document.body.append(el);
    setTimeout(() => el.remove(), 1500);
  }

  function squash() {
    root.classList.remove("squash"); void root.offsetWidth; root.classList.add("squash");
  }

  /** Pupils follow the cursor a little. */
  function look(px, py) {
    if (!pupils || s.mode === "sleep") return;
    const dx = px - centreX();
    const dy = py - centreY();
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1.6, d / 60);
    // The svg is mirrored when facing left, so mirror the x offset too.
    pupils.style.transform = `translate(${((dx / d) * k * s.dir).toFixed(2)}px, ${((dy / d) * k).toFixed(2)}px)`;
  }

  function face(px) {
    if (Math.abs(px - centreX()) > 4) s.dir = px > centreX() ? 1 : -1;
  }

  // ---------- wandering ----------

  function choose(now) {
    if (reducedMotion) { setMode("idle"); s.until = Infinity; return; }
    if (s.mode === "idle" && now - s.idleSince > 45000 && Math.random() < 0.5) {
      setMode("sleep"); say(pick(LINES.sleep), 1800); s.until = now + 20000 + Math.random() * 20000; return;
    }
    if (Math.random() < 0.62) {
      if (Math.random() < 0.35) s.dir = -s.dir;
      setMode("walk"); s.until = now + 2500 + Math.random() * 5000;
    } else {
      if (s.mode !== "idle") s.idleSince = now;
      setMode("idle"); s.until = now + 1500 + Math.random() * 4000;
    }
  }

  function jump(power = 520) {
    if (s.mode === "drag") return;
    s.vy = -power;
    s.vx = s.dir * (60 + Math.random() * 60);
    setMode("jump");
  }

  function land(now) {
    const wasReach = s.mode === "reach";
    s.y = floorY();
    s.vy = 0; s.vx = 0;
    squash();
    s.idleSince = now;
    if (wasReach) {
      // Missed the cursor: try again while it is still close, otherwise sulk.
      s.attempts += 1;
      const near = cursorFresh(now, 2500) && Math.abs(ptr.x - centreX()) < NOTICE_RADIUS;
      if (near && s.attempts < 3 && !busyUser(now)) {
        if (Math.random() < 0.6) say(pick(LINES.miss), 1300);
        setMode("chase"); s.until = now + 6000; s.grabAt = now + 450;
        return;
      }
      say(pick(LINES.giveUp), 1700);
      s.attempts = 0; s.grabAt = now + 6000;
    }
    setMode("idle");
    s.until = now + 700 + Math.random() * 900;
  }

  // ---------- playing with the cursor ----------

  /** Grounded and the cursor is near: decide whether to notice, dodge, chase or keep wandering. */
  function reactToCursor(now) {
    if (reducedMotion || !ptr.inside || !ptr.mouse) return false;
    const dx = ptr.x - centreX();
    const dy = ptr.y - centreY();
    const dist = Math.hypot(dx, dy);
    const speed = Math.hypot(ptr.vx, ptr.vy);

    // A cursor whipping right past: hop away.
    if (dist < 80 && speed > 2300 && now > s.dodgeAt && (s.mode === "walk" || s.mode === "idle" || s.mode === "watch")) {
      s.dodgeAt = now + 4000;
      face(ptr.x);
      showEmote("!");
      s.vx = -Math.sign(dx || 1) * 230; s.vy = -400;
      setMode("jump");
      if (Math.random() < 0.6) setTimeout(() => say(pick(LINES.dodge), 1300), 200);
      return true;
    }

    if ((s.mode === "walk" || s.mode === "idle") && dist < NOTICE_RADIUS && cursorFresh(now, 600) && now > s.noticeAt && !busyUser(now)) {
      s.noticeAt = now + 9000;
      face(ptr.x);
      showEmote(Math.random() < 0.85 ? "!" : "?");
      setMode("watch");
      s.until = now + 700;          // a short beat before deciding what to do
      s.tooHighSaid = false;
      s.decided = false;
      return true;
    }
    return false;
  }

  function startReach(now) {
    // Ballistic jump whose apex puts its hands at the cursor.
    const anchorY = s.y + ANCHOR_Y;
    const h = clamp(anchorY - ptr.y, 10, REACH_HEIGHT) + 14;
    const vy = Math.sqrt(2 * GRAVITY * h);
    const tPeak = vy / GRAVITY;
    s.vy = -vy;
    s.vx = clamp((ptr.x - centreX()) / tPeak, -420, 420);
    face(ptr.x);
    setMode("reach");
    s.until = now + 2000;
  }

  function startHang(now) {
    setMode("hang");
    s.hangSince = now;
    s.hangFor = 5000 + Math.random() * 4500;
    // Keep the swing it arrived with.
    s.theta = clamp(-s.vx / 900, -0.6, 0.6);
    s.omega = 0;
    s.attempts = 0;
    ptr.fx = ptr.x; ptr.fy = ptr.y; ptr.fvx = 0; ptr.fvy = 0; ptr.ax = 0; ptr.ay = 0;
    squash();
    showEmote("♥");
    say(pick(LINES.grab), 1800);
  }

  /** Let go of the cursor, keeping the momentum of the swing. */
  function release(now, line, fling = false) {
    if (s.mode !== "hang") return;
    const cx = ptr.x - ARM * Math.sin(s.theta);
    const cy = ptr.y + ARM * Math.cos(s.theta);
    s.x = clamp(cx - SIZE / 2, 0, maxX());
    s.y = Math.min(cy - SIZE / 2, floorY());
    // Tangential velocity of the swing plus (when flung) the cursor's own velocity.
    s.vx = -ARM * s.omega * Math.cos(s.theta) + (fling ? clamp(ptr.fvx * 0.45, -700, 700) : 0);
    s.vy = -ARM * s.omega * Math.sin(s.theta) + (fling ? clamp(ptr.fvy * 0.45, -700, 500) : 0);
    s.theta = 0; s.omega = 0;
    s.grabAt = now + 15000 + Math.random() * 10000;
    s.noticeAt = now + 6000;
    setMode("fall");
    if (line) say(pick(line), 1700);
  }

  function updateHang(now, dt) {
    if (!ptr.inside) { release(now, LINES.released); return; }
    if (dt <= 0) return;
    // Cursor velocity/acceleration measured per frame, lightly smoothed.
    const vx = (ptr.x - ptr.fx) / dt;
    const vy = (ptr.y - ptr.fy) / dt;
    const nvx = ptr.fvx + (vx - ptr.fvx) * 0.5;
    const nvy = ptr.fvy + (vy - ptr.fvy) * 0.5;
    ptr.ax = clamp((nvx - ptr.fvx) / dt, -25000, 25000);
    ptr.ay = clamp((nvy - ptr.fvy) / dt, -25000, 25000);
    ptr.fvx = nvx; ptr.fvy = nvy; ptr.fx = ptr.x; ptr.fy = ptr.y;

    // Pendulum hanging from an accelerating pivot.
    const g = Math.max(250, GRAVITY + ptr.ay);
    const alpha = (-g * Math.sin(s.theta) + ptr.ax * Math.cos(s.theta)) / (ARM * 3) - 1.8 * s.omega;
    s.omega += alpha * dt;
    s.theta = clamp(s.theta + s.omega * dt, -2.4, 2.4);
    if (Math.abs(ptr.fvx) > 40) s.dir = ptr.fvx > 0 ? 1 : -1;
    look(ptr.x + s.dir * 30, ptr.y + 60);

    // Shaken off: the cursor travelled a long way in a short time.
    ptr.trail = ptr.trail.filter(([t]) => now - t < 350);
    const travelled = ptr.trail.reduce((sum, [, d]) => sum + d, 0);
    if (travelled > 1000 && now - s.hangSince > 250) { release(now, LINES.shaken, true); return; }
    if (Math.abs(s.omega) > 7 && now - s.swingSaidAt > 5000 && Math.random() < 0.02) {
      s.swingSaidAt = now; say(pick(LINES.swing), 1200);
    }
    if (now - s.hangSince > s.hangFor) release(now, LINES.tired);
  }

  /** Petting (rubbing back and forth) and tickling (resting the cursor on it). */
  function updateTouch(now) {
    if (s.pressed || s.mode === "hang" || s.mode === "drag") { s.hoverSince = 0; root.classList.remove("tickle"); return; }
    const over = cursorOver();
    if (!over) {
      s.hoverSince = 0; s.tickled = false; root.classList.remove("tickle");
      return;
    }
    if (!s.hoverSince) s.hoverSince = now;
    if (s.mode === "sleep") {
      if (now - s.hoverSince > 900) {
        say(pick(LINES.wakeByHover), 1800); showEmote("?");
        setMode("idle"); s.idleSince = now; s.until = now + 2200; s.noticeAt = now + 3000;
      }
      return;
    }
    // Petting: count direction changes of the cursor while over the character.
    s.petTurns = s.petTurns.filter((t) => now - t < 1200);
    if (s.petTurns.length >= 3) {
      if (now >= s.happyUntil) say(pick(LINES.pet), 1600);
      s.happyUntil = now + 1400;
      s.petTurns = [];
      if (s.mode === "walk" || s.mode === "chase") { setMode("idle"); s.until = now + 1600; }
    }
    if (now < s.happyUntil && now - s.heartAt > 220) { s.heartAt = now; heart(); }
    // Tickle: cursor resting on it.
    const resting = now - ptr.movedAt > 450;
    const tickle = resting && now - s.hoverSince > 700 && now >= s.happyUntil;
    root.classList.toggle("tickle", tickle && !reducedMotion && grounded());
    if (tickle && !s.tickled) { s.tickled = true; say(pick(LINES.tickle), 1400); }
  }

  // ---------- main loop ----------

  function step(now) {
    frame = null;
    if (!enabled || !ideVisible() || document.hidden) { last = 0; syncVisibility(); return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    const floor = floorY();

    // Event velocity decays when the mouse stops sending events.
    if (now - ptr.movedAt > 80) { ptr.vx *= 0.8; ptr.vy *= 0.8; }

    switch (s.mode) {
      case "walk":
        s.x += s.dir * WALK_SPEED * dt;
        if (s.x <= 0) { s.x = 0; s.dir = 1; }
        if (s.x >= maxX()) { s.x = maxX(); s.dir = -1; }
        s.y = floor;
        if (reactToCursor(now)) break;
        if (now >= s.until) choose(now);
        else if (Math.random() < dt * 0.06) jump(380);  // the occasional hop
        break;
      case "idle":
        s.y = floor;
        if (reactToCursor(now)) break;
        if (now >= s.until) choose(now);
        break;
      case "sleep":
        s.y = floor;
        if (now >= s.until) { say(pick(LINES.wake)); setMode("idle"); s.idleSince = now; s.until = now + 1200; }
        break;
      case "watch": {
        s.y = floor;
        face(ptr.x);
        if (reactToCursor(now)) break;
        const above = s.y + ANCHOR_Y - ptr.y;
        const tooHigh = above > REACH_HEIGHT;
        root.classList.toggle("wave", tooHigh && ptr.inside);
        if (tooHigh && !s.tooHighSaid) { s.tooHighSaid = true; say(pick(LINES.tooHigh), 1500); }
        if (now < s.until) break;
        const dist = Math.hypot(ptr.x - centreX(), ptr.y - centreY());
        if (!ptr.inside || dist > NOTICE_RADIUS * 1.6 || now - ptr.movedAt > 4000) { choose(now); break; }
        if (!s.decided) {
          s.decided = true;
          // Curious or shy?  Most of the time it goes for it.
          if (Math.random() < 0.7 && now > s.grabAt && !busyUser(now)) {
            if (Math.random() < 0.5) say(pick(LINES.chase), 1300);
            setMode("chase"); s.until = now + 7000; s.attempts = 0;
          } else {
            s.until = now + 2500 + Math.random() * 2500;
          }
        } else {
          choose(now);
        }
        break;
      }
      case "chase": {
        s.y = floor;
        const dx = ptr.x - centreX();
        face(ptr.x);
        if (!ptr.inside || now > s.until || busyUser(now) || Math.abs(dx) > NOTICE_RADIUS * 2) {
          if (now > s.until && ptr.inside) say(pick(LINES.giveUp), 1500);
          s.attempts = 0; choose(now); break;
        }
        if (Math.abs(dx) > 12) s.x = clamp(s.x + Math.sign(dx) * Math.min(RUN_SPEED * dt, Math.abs(dx)), 0, maxX());
        const above = s.y + ANCHOR_Y - ptr.y;
        if (Math.abs(dx) < 60 && above > -10 && above < REACH_HEIGHT && now > s.grabAt) {
          setMode("crouch"); s.until = now + 220;
        }
        root.classList.toggle("wave", above >= REACH_HEIGHT);
        break;
      }
      case "crouch":
        s.y = floor;
        face(ptr.x);
        if (now >= s.until) {
          const above = s.y + ANCHOR_Y - ptr.y;
          if (ptr.inside && above > -10 && above < REACH_HEIGHT && !busyUser(now)) startReach(now);
          else { setMode("chase"); s.until = now + 3000; }
        }
        break;
      case "reach":
      case "jump":
      case "fall":
        s.vy += GRAVITY * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.x <= 0) { s.x = 0; s.vx = Math.abs(s.vx) * 0.5; s.dir = 1; }
        if (s.x >= maxX()) { s.x = maxX(); s.vx = -Math.abs(s.vx) * 0.5; s.dir = -1; }
        if (s.y < 0) { s.y = 0; s.vy = Math.abs(s.vy) * 0.4; }  // bump the top of the window
        if (s.mode === "reach" && ptr.inside) {
          const hx = s.x + ANCHOR_X;
          const hy = s.y + ANCHOR_Y;
          look(ptr.x, ptr.y);
          if (Math.hypot(ptr.x - hx, ptr.y - hy) < 30) { startHang(now); break; }
        }
        if (s.vy > 0 && s.y >= floor) {
          if (s.vy > 900 && s.mode !== "reach") { s.vy = -s.vy * 0.32; s.y = floor; s.vx *= 0.6; }  // a little bounce after a long drop
          else land(now);
        }
        break;
      case "hang":
        updateHang(now, dt);
        break;
      case "drag":
        break;
    }
    if (s.mode !== "hang") s.x = clamp(s.x, 0, maxX());
    updateTouch(now);
    draw();
    frame = requestAnimationFrame(step);
  }

  function kick() {
    if (frame == null && enabled && ideVisible() && !document.hidden) frame = requestAnimationFrame(step);
  }

  // ---------- pointer ----------

  function onPointerDown(event) {
    if (event.button !== 0 || s.mode === "hang") return;
    event.preventDefault();
    event.stopPropagation();
    root.setPointerCapture?.(event.pointerId);
    s.dragDX = event.clientX - s.x;
    s.dragDY = event.clientY - s.y;
    s.dragMoved = false;
    s.lastPointer = { x: event.clientX, y: event.clientY, t: performance.now(), vx: 0, vy: 0 };
    s.pressAt = { x: event.clientX, y: event.clientY };
    s.pressed = true;
  }

  function trackPointer(event) {
    const now = performance.now();
    const dt = Math.max(4, now - (ptr.movedAt || now - 16)) / 1000;
    const vx = (event.clientX - ptr.x) / dt;
    const vy = (event.clientY - ptr.y) / dt;
    if (ptr.inside && now - ptr.movedAt < 200) {
      ptr.vx += (vx - ptr.vx) * 0.4;
      ptr.vy += (vy - ptr.vy) * 0.4;
    } else {
      ptr.vx = 0; ptr.vy = 0;
    }
    // Direction reversals while over the character count as petting strokes.
    const dirX = Math.abs(event.clientX - ptr.x) >= 2 ? Math.sign(event.clientX - ptr.x) : 0;
    if (dirX && ptr.lastDirX && dirX !== ptr.lastDirX && root && cursorOver()) s.petTurns.push(now);
    if (dirX) ptr.lastDirX = dirX;
    if (ptr.inside) {
      ptr.trail.push([now, Math.hypot(event.clientX - ptr.x, event.clientY - ptr.y)]);
      if (ptr.trail.length > 64) ptr.trail.shift();
    }
    ptr.x = event.clientX; ptr.y = event.clientY;
    ptr.inside = true;
    ptr.mouse = event.pointerType === "mouse" || event.pointerType === "pen" || !event.pointerType;
    ptr.buttons = event.buttons;
    ptr.movedAt = now;
  }

  function onPointerMove(event) {
    if (!root || !enabled) return;
    trackPointer(event);
    if (s.mode !== "hang" && s.mode !== "reach") look(event.clientX, event.clientY);
    if (!s.pressed) return;
    if (!s.dragMoved && Math.hypot(event.clientX - s.pressAt.x, event.clientY - s.pressAt.y) < 5) return;
    if (!s.dragMoved) { s.dragMoved = true; setMode("drag"); bubble.classList.remove("show"); }
    const now = performance.now();
    const lp = s.lastPointer;
    const dt = Math.max(1, now - lp.t) / 1000;
    s.lastPointer = { x: event.clientX, y: event.clientY, t: now, vx: (event.clientX - lp.x) / dt, vy: (event.clientY - lp.y) / dt };
    s.x = clamp(event.clientX - s.dragDX, 0, maxX());
    s.y = clamp(event.clientY - s.dragDY, 0, floorY());
    if (Math.abs(s.lastPointer.vx) > 30) s.dir = s.lastPointer.vx > 0 ? 1 : -1;
    draw();
  }

  function onPointerUp(event) {
    ptr.buttons = event.buttons ?? 0;
    if (!s.pressed) return;
    s.pressed = false;
    const now = performance.now();
    if (s.dragMoved) {
      // Throw with the pointer's last velocity (capped), then gravity takes over.
      s.vx = clamp(s.lastPointer.vx * 0.6, -600, 600);
      s.vy = clamp(s.lastPointer.vy * 0.6, -900, 600);
      setMode("fall");
      s.noticeAt = now + 5000;
      if (floorY() - s.y > 120) say(pick(LINES.drop), 1600);
    } else if (s.mode === "sleep") {
      say(pick(LINES.wake)); setMode("idle"); s.idleSince = now; s.until = now + 1500;
    } else {
      say(pick(LINES.click));
      s.noticeAt = now + 4000;
      if (!reducedMotion) jump();
    }
    kick();
  }

  /** Any click elsewhere while it hangs on the cursor: it lets go (the click itself goes through). */
  function onAnyPointerDown(event) {
    ptr.buttons = event.buttons;
    if (s.mode === "hang") release(performance.now(), LINES.released);
    if (s.mode === "reach" || s.mode === "chase" || s.mode === "crouch") s.grabAt = performance.now() + 5000;
  }

  // ---------- visibility ----------

  function syncVisibility() {
    const show = enabled && ideVisible();
    if (show && !root) {
      build();
      s.x = Math.min(maxX(), 80 + Math.random() * Math.max(0, window.innerWidth * 0.4));
      s.y = reducedMotion ? floorY() : -SIZE;
      setMode(reducedMotion ? "idle" : "fall");
      s.until = performance.now() + 2000;
      s.noticeAt = performance.now() + 3000;
      setTimeout(() => say(pick(LINES.hello)), reducedMotion ? 200 : 900);
    }
    if (root) {
      if (!show && s.mode === "hang") release(performance.now(), null);
      root.hidden = !show;
      if (!show) { bubble.classList.remove("show"); emote.classList.remove("show"); }
    }
    const toggle = document.getElementById("mascot-toggle");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(enabled));
      toggle.title = enabled ? "캐릭터 숨기기" : "캐릭터 보이기";
    }
    if (show) { draw(); kick(); }
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    localStorage.setItem(KEY, enabled ? "on" : "off");
    if (enabled && root) { s.y = Math.min(s.y, floorY()); if (!reducedMotion) setMode("fall"); }
    syncVisibility();
  }

  function init() {
    ide = document.getElementById("ide");
    if (!ide) return;
    new MutationObserver(syncVisibility).observe(ide, { attributes: true, attributeFilter: ["hidden"] });
    document.getElementById("mascot-toggle")?.addEventListener("click", () => setEnabled(!enabled));
    document.addEventListener("visibilitychange", () => { last = 0; kick(); });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onAnyPointerDown, { capture: true, passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("pointerout", (event) => { if (!event.relatedTarget) ptr.inside = false; });
    window.addEventListener("blur", () => { ptr.inside = false; });
    window.addEventListener("resize", () => {
      if (!root) return;
      s.x = Math.min(s.x, maxX());
      if (grounded()) s.y = floorY();
      draw();
    });
    document.addEventListener("keydown", (event) => {
      typedAt = performance.now();
      if (s.mode === "hang") release(typedAt, null);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && Math.random() < 0.5) {
        setTimeout(() => say(pick(LINES.save), 1600), 250);
      }
    });
    syncVisibility();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  return { show: () => setEnabled(true), hide: () => setEnabled(false), say };
})();
