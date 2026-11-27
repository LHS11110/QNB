"use strict";

/* Multi-session VM terminal: every tab owns its own xterm instance and WebSocket.
 * Sessions show either one at a time (tabs) or all at once in a grid; panes and tabs
 * are reordered or swapped by drag and drop. */
(() => {
  const MAX_TERMINALS = 6;
  const LAYOUT_KEY = "qnb:terminal:layout";
  const panel = $("terminal-panel");
  const screen = $("terminal-screen");
  const tabStrip = $("terminal-tabs");
  const statusNode = $("terminal-status");
  const openButton = $("terminal-open");
  const sessions = [];
  let activeSession = null;
  let sequence = 0;
  let syncTimer;
  const layout = { mode: "tabs", cols: 0 }; // cols 0 = automatic
  try { Object.assign(layout, JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}")); } catch { /* ignore */ }
  if (!["tabs", "grid"].includes(layout.mode)) layout.mode = "tabs";
  if (![0, 1, 2, 3].includes(layout.cols)) layout.cols = 0;

  const gridMode = () => layout.mode === "grid" && sessions.length > 1;
  const visible = (session) => !panel.hidden && !session.pane.hidden;

  function send(session, operation, data = "") {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(JSON.stringify({
      operation, data, cols: session.term.cols, rows: session.term.rows,
    }));
  }

  function setStatus(session, message) {
    session.status = message;
    if (session === activeSession) statusNode.textContent = message;
    renderTabs();
  }

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
  }

  function gridColumns() {
    const n = sessions.length;
    if (layout.cols) return Math.min(layout.cols, n);
    return n <= 3 ? n : n === 4 ? 2 : 3;
  }

  /* Show every pane in a rows × columns grid, or only the active one as a tab. */
  function applyLayout() {
    const grid = gridMode();
    screen.classList.toggle("grid", grid);
    const cols = grid ? gridColumns() : 1;
    screen.style.setProperty("--term-cols", String(cols));
    screen.style.setProperty("--term-rows", String(grid ? Math.ceil(sessions.length / cols) : 1));
    for (const session of sessions) {
      session.pane.hidden = !grid && session !== activeSession;
      session.pane.classList.toggle("active", session === activeSession);
      if (session.pane.parentNode !== screen) screen.append(session.pane);
    }
    // Keep DOM order = session order (grid placement), moving only out-of-place panes.
    sessions.forEach((session, i) => {
      if (screen.children[i] !== session.pane) screen.insertBefore(session.pane, screen.children[i] || null);
    });
    $("terminal-layout-tabs").setAttribute("aria-pressed", String(layout.mode === "tabs"));
    $("terminal-layout-grid").setAttribute("aria-pressed", String(layout.mode === "grid"));
    const colsSelect = $("terminal-grid-cols");
    colsSelect.hidden = layout.mode !== "grid";
    colsSelect.value = String(layout.cols);
    requestAnimationFrame(fitAll);
  }

  function fitAll() {
    for (const session of sessions) fit(session);
  }

  function setLayout(mode, cols = layout.cols) {
    layout.mode = mode;
    layout.cols = cols;
    saveLayout();
    applyLayout();
    activeSession?.term.focus();
  }

  /* ----------------------------- drag and drop ----------------------------- */

  let dragged = null;

  function draggable(node, session) {
    node.draggable = true;
    node.addEventListener("dragstart", (event) => {
      dragged = session;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-qnb-terminal", session.id);
      event.dataTransfer.setData("text/plain", session.title);
      panel.classList.add("terminal-dragging");
      requestAnimationFrame(() => { if (dragged === session) session.pane.classList.add("dragging"); });
    });
    node.addEventListener("dragend", () => {
      dragged = null;
      panel.classList.remove("terminal-dragging");
      session.pane.classList.remove("dragging");
      clearDrop();
    });
  }

  function clearDrop() {
    for (const node of panel.querySelectorAll("[data-drop]")) delete node.dataset.drop;
  }

  /* Edges insert before/after, the middle of a pane swaps the two terminals. */
  function dropZone(event, node) {
    const box = node.getBoundingClientRect();
    if (node.classList.contains("terminal-tab")) return (event.clientX - box.left) / box.width < .5 ? "before" : "after";
    const tx = (event.clientX - box.left) / box.width;
    const ty = (event.clientY - box.top) / box.height;
    if (tx > .25 && tx < .75 && ty > .25 && ty < .75) return "swap";
    const distances = { before: Math.min(tx, ty), after: Math.min(1 - tx, 1 - ty) };
    return distances.before <= distances.after ? "before" : "after";
  }

  function dropTargetFor(event) {
    if (!dragged) return null;
    const node = event.target.closest(".terminal-tab, .terminal-pane");
    if (!node) return null;
    const target = sessions.find((s) => s.id === node.dataset.session);
    if (!target || target === dragged) return null;
    return { node, target, zone: dropZone(event, node) };
  }

  function moveSession(session, target, zone) {
    const from = sessions.indexOf(session);
    const to = sessions.indexOf(target);
    if (zone === "swap") {
      [sessions[from], sessions[to]] = [sessions[to], sessions[from]];
    } else {
      sessions.splice(from, 1);
      sessions.splice(sessions.indexOf(target) + (zone === "after" ? 1 : 0), 0, session);
    }
    renderTabs();
    applyLayout();
  }

  for (const zone of [screen, tabStrip]) {
    zone.addEventListener("dragover", (event) => {
      const found = dropTargetFor(event);
      clearDrop();
      if (!found) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      found.node.dataset.drop = found.zone;
    });
    zone.addEventListener("dragleave", (event) => { if (!zone.contains(event.relatedTarget)) clearDrop(); });
    zone.addEventListener("drop", (event) => {
      const found = dropTargetFor(event);
      clearDrop();
      if (!found) return;
      event.preventDefault();
      // Dropping a tab onto a pane while in tab mode turns the view into a grid.
      if (layout.mode === "tabs" && found.node.classList.contains("terminal-pane")) layout.mode = "grid";
      moveSession(dragged, found.target, found.zone);
    });
  }

  function end(session, message) {
    if (session.exited) return;
    session.exited = true;
    session.term.options.disableStdin = true;
    setStatus(session, message);
  }

  function fit(session) {
    if (!session || !visible(session)) return;
    const size = session.fit.proposeDimensions();
    if (size && size.cols > 1 && size.rows > 1) {
      session.term.resize(Math.min(size.cols, 300), Math.min(size.rows, 150));
    }
  }

  function renderTabs() {
    const items = sessions.map((session) => {
      const tab = document.createElement("div");
      tab.className = "terminal-tab" + (session === activeSession ? " active" : "") + (session.exited ? " exited" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(session === activeSession));
      tab.dataset.session = session.id;
      draggable(tab, session);
      const label = document.createElement("button");
      label.type = "button";
      label.className = "terminal-tab-label";
      label.textContent = session.title;
      label.title = session.status || session.title;
      label.onclick = () => activate(session);
      label.ondblclick = () => rename(session);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "terminal-tab-close";
      close.textContent = "×";
      close.title = session.title + " 종료";
      close.setAttribute("aria-label", session.title + " 종료");
      close.onclick = (event) => { event.stopPropagation(); dispose(session); };
      tab.append(label, close);
      return tab;
    });
    tabStrip.replaceChildren(...items);
    for (const session of sessions) {
      session.paneTitle.textContent = session.title;
      session.paneTitle.title = session.status || session.title + " · 끌어서 배치 · 더블클릭으로 이름 변경";
      session.paneStatus.textContent = session.status || "";
      session.pane.classList.toggle("exited", session.exited);
    }
    $("terminal-new").disabled = sessions.length >= MAX_TERMINALS;
    const count = $("terminal-count");
    count.textContent = String(sessions.length);
    count.hidden = sessions.length < 2;
    openButton.title = `아래 터미널 패널 (Ctrl+\`)` + (sessions.length ? ` · 열린 터미널 ${sessions.length}개` : "");
  }

  function rename(session) {
    const name = prompt("터미널 이름", session.title);
    if (name && name.trim()) {
      session.title = name.trim().slice(0, 32);
      renderTabs();
    }
  }

  function activate(session, focus = true) {
    activeSession = session;
    statusNode.textContent = session.status || "";
    renderTabs();
    applyLayout();
    if (focus) requestAnimationFrame(() => { fit(session); session.term.focus(); });
  }

  function showPanel() {
    panel.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
  }

  function hidePanel() {
    panel.hidden = true;
    openButton.setAttribute("aria-expanded", "false");
  }

  function dispose(session) {
    const index = sessions.indexOf(session);
    if (index === -1) return;
    sessions.splice(index, 1);
    if (session.ready && !session.exited) send(session, "close");
    session.exited = true;
    try { session.socket.close(); } catch { /* already closed */ }
    session.term.dispose();
    session.pane.remove();
    if (activeSession === session) {
      activeSession = null;
      const next = sessions[Math.min(index, sessions.length - 1)];
      if (next) activate(next);
    }
    applyLayout();
    if (!sessions.length) {
      hidePanel();
      statusNode.textContent = "";
      openButton.focus();
    }
    renderTabs();
  }

  function create() {
    showPanel();
    if (!window.Terminal || !window.FitAddon) {
      statusNode.textContent = "터미널 화면을 불러오지 못했습니다.";
      return null;
    }
    if (sessions.length >= MAX_TERMINALS) {
      statusNode.textContent = `터미널은 최대 ${MAX_TERMINALS}개까지 열 수 있습니다.`;
      return null;
    }
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const head = document.createElement("div");
    head.className = "terminal-pane-head";
    const paneTitle = document.createElement("span");
    paneTitle.className = "terminal-pane-title";
    const paneStatus = document.createElement("span");
    paneStatus.className = "terminal-pane-status";
    const paneClose = document.createElement("button");
    paneClose.type = "button";
    paneClose.className = "terminal-pane-close";
    paneClose.textContent = "×";
    paneClose.setAttribute("aria-label", "터미널 종료");
    head.append(paneTitle, paneStatus, paneClose);
    const host = document.createElement("div");
    host.className = "terminal-host";
    pane.append(head, host);
    screen.append(pane);
    const fitAddon = new FitAddon.FitAddon();
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, disableStdin: true,
      theme: { background: "#141413", foreground: "#e3e8f4" },
    });
    const socket = new WebSocket(vmSocketURL("terminal"));
    const session = {
      id: crypto.randomUUID?.() ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, title: `셸 ${++sequence}`, term, fit: fitAddon, socket, host, pane, paneTitle, paneStatus,
      ready: false, exited: false, status: "VM 터미널 연결 중…",
      openedCols: term.cols, openedRows: term.rows,
    };
    sessions.push(session);
    pane.dataset.session = session.id;
    draggable(head, session);
    head.ondblclick = (event) => { if (!event.target.closest("button")) rename(session); };
    paneClose.onclick = () => dispose(session);
    pane.addEventListener("pointerdown", () => { if (activeSession !== session) activate(session, false); });
    term.loadAddon(fitAddon);
    term.open(host);
    term.textarea?.addEventListener("focus", () => { if (activeSession !== session) activate(session, false); });
    activate(session);
    fit(session);
    session.openedCols = term.cols;
    session.openedRows = term.rows;

    socket.onopen = () => {
      session.openedCols = term.cols;
      session.openedRows = term.rows;
      socket.send(JSON.stringify({
        operation: "open", terminal: session.id, offset: 0, cols: term.cols, rows: term.rows,
      }));
    };
    socket.onmessage = ({ data }) => {
      if (session.exited) return;
      try {
        const frame = JSON.parse(data);
        if (frame.error) {
          end(session, "VM 터미널 연결 실패 · " + frame.error);
          socket.close();
          return;
        }
        if (frame.type === "ready") {
          session.ready = true;
          term.options.disableStdin = false;
          setStatus(session, "");
          if (session.openedCols !== term.cols || session.openedRows !== term.rows) {
            send(session, "resize");
          }
        }
        if (frame.truncated) term.writeln("\r\n[일부 출력이 생략되었습니다.]");
        if (frame.data) {
          term.write(Uint8Array.from(atob(frame.data), (byte) => byte.charCodeAt(0)));
          clearTimeout(syncTimer);
          syncTimer = setTimeout(() => { syncWorkspace(); window.QNBGit?.refresh(); }, 400);
        }
        if (frame.exited) end(session, "셸 종료 · 종료 코드 " + frame.exitCode);
      } catch {
        end(session, "VM 터미널 응답이 올바르지 않습니다.");
        socket.close();
      }
    };
    socket.onerror = socket.onclose = () => end(session, "VM 터미널 연결이 끊겼습니다.");
    term.onResize(() => { if (session.ready) send(session, "resize"); });
    term.onData((data) => {
      if (!session.ready || session.exited) return;
      const characters = Array.from(data);
      for (let start = 0; start < characters.length; start += 1024) {
        send(session, "input", characters.slice(start, start + 1024).join(""));
      }
    });
    return session;
  }

  function closeAll() {
    for (const session of [...sessions]) dispose(session);
    hidePanel();
  }

  function toggle() {
    if (!panel.hidden) {
      hidePanel();
      return;
    }
    showPanel();
    if (!sessions.length) create();
    else if (activeSession) activate(activeSession);
  }

  /* Drag the top edge of the panel to resize it, with persisted height and dblclick reset. */
  const resizer = $("terminal-resizer");
  const TERM_HEIGHT_KEY = "qnb:panel:terminalHeight";
  try {
    const savedHeight = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    if (savedHeight >= 120) panel.style.flexBasis = savedHeight + "px";
  } catch { /* ignore storage errors */ }
  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    let latestHeight = startHeight;
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-row");
    const move = (e) => {
      latestHeight = Math.round(Math.max(120, Math.min(window.innerHeight * 0.8, startHeight + startY - e.clientY)));
      panel.style.flexBasis = latestHeight + "px";
    };
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing-row");
      try { localStorage.setItem(TERM_HEIGHT_KEY, String(latestHeight)); } catch { /* ignore */ }
      fitAll();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });
  resizer.addEventListener("dblclick", () => {
    panel.style.flexBasis = "";
    try { localStorage.removeItem(TERM_HEIGHT_KEY); } catch { /* ignore */ }
    fitAll();
  });

  openButton.onclick = toggle;
  $("terminal-new").onclick = () => create();
  $("terminal-hide").onclick = () => { hidePanel(); openButton.focus(); };
  $("terminal-close").onclick = () => { closeAll(); openButton.focus(); };
  document.addEventListener("keydown", (event) => {
    if (document.getElementById("ide")?.hidden) return;
    if (event.ctrlKey && event.shiftKey && (event.key === "`" || event.key === "~" || event.code === "Backquote")) {
      event.preventDefault();
      create();
    } else if (event.ctrlKey && !event.shiftKey && event.code === "Backquote") {
      event.preventDefault();
      toggle();
    }
  });
  new ResizeObserver(fitAll).observe(screen);
  $("terminal-layout-tabs").onclick = () => setLayout("tabs");
  $("terminal-layout-grid").onclick = () => {
    if (sessions.length < 2) { while (sessions.length < 2 && create()); }
    setLayout("grid");
  };
  $("terminal-grid-cols").onchange = (event) => setLayout("grid", Number(event.target.value));
  window.addEventListener("pagehide", closeAll);

  window.QNBTerminals = { create, closeAll, toggle, setLayout, get count() { return sessions.length; }, get layout() { return { ...layout }; } };
})();
