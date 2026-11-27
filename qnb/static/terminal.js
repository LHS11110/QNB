"use strict";

/* Multi-session VM terminal: every tab owns its own xterm instance and WebSocket. */
(() => {
  const MAX_TERMINALS = 6;
  const panel = $("terminal-panel");
  const screen = $("terminal-screen");
  const tabStrip = $("terminal-tabs");
  const statusNode = $("terminal-status");
  const openButton = $("terminal-open");
  const sessions = [];
  let activeSession = null;
  let sequence = 0;
  let syncTimer;

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

  function end(session, message) {
    if (session.exited) return;
    session.exited = true;
    session.term.options.disableStdin = true;
    setStatus(session, message);
  }

  function fit(session) {
    if (!session || panel.hidden || session.host.hidden) return;
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

  function activate(session) {
    activeSession = session;
    for (const item of sessions) item.host.hidden = item !== session;
    statusNode.textContent = session.status || "";
    renderTabs();
    requestAnimationFrame(() => { fit(session); session.term.focus(); });
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
    session.host.remove();
    if (activeSession === session) {
      activeSession = null;
      const next = sessions[Math.min(index, sessions.length - 1)];
      if (next) activate(next);
    }
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
    const host = document.createElement("div");
    host.className = "terminal-host";
    screen.append(host);
    const fitAddon = new FitAddon.FitAddon();
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, disableStdin: true,
      theme: { background: "#141413", foreground: "#e3e8f4" },
    });
    const socket = new WebSocket(vmSocketURL("terminal"));
    const session = {
      id: crypto.randomUUID(), title: `셸 ${++sequence}`, term, fit: fitAddon, socket, host,
      ready: false, exited: false, status: "VM 터미널 연결 중…",
      openedCols: term.cols, openedRows: term.rows,
    };
    sessions.push(session);
    term.loadAddon(fitAddon);
    term.open(host);
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
      fit(activeSession);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });
  resizer.addEventListener("dblclick", () => {
    panel.style.flexBasis = "";
    try { localStorage.removeItem(TERM_HEIGHT_KEY); } catch { /* ignore */ }
    fit(activeSession);
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
  new ResizeObserver(() => fit(activeSession)).observe(screen);
  window.addEventListener("pagehide", closeAll);

  window.QNBTerminals = { create, closeAll, toggle, get count() { return sessions.length; } };
})();
