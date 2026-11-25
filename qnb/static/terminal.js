"use strict";

const terminalPanel = $("terminal-panel");
const terminalScreen = $("terminal-screen");
let terminalSession = null;

function terminalRequest(session, operation, data = "") {
  return vmRequest("terminal", {
    terminal: session.id, operation, data, offset: session.offset,
    cols: session.term.cols, rows: session.term.rows,
  });
}

async function updateTerminal(session) {
  if (session.running || session.closed || session.exited) return;
  clearTimeout(session.timer);
  session.running = true;
  const opening = !session.ready;
  const data = opening ? "" : session.input.shift() || "";
  const operation = opening ? "open" : data ? "input" : session.resize ? "resize" : "poll";
  if (operation === "resize") session.resize = false;

  try {
    const result = await terminalRequest(session, operation, data);
    if (session.closed) return;
    if (result.expired) throw new Error("VM 터미널 세션이 만료되었습니다.");
    if (opening) $("terminal-status").textContent = "";
    session.ready = true;
    session.offset = result.offset;
    if (result.truncated) session.term.writeln("\r\n[일부 출력이 생략되었습니다.]");
    if (result.data) session.term.write(Uint8Array.from(atob(result.data), (byte) => byte.charCodeAt(0)));
    if (result.exited) {
      session.exited = true;
      $("terminal-status").textContent = "셸 종료 · 종료 코드 " + result.exitCode;
      session.term.options.disableStdin = true;
    }
  } catch (error) {
    if (!session.closed) {
      session.exited = true;
      session.term.options.disableStdin = true;
      $("terminal-status").textContent = error.message;
    }
  } finally {
    session.running = false;
    if (session.closed) {
      releaseTerminal(session);
    } else if (!session.exited) {
      const delay = session.input.length || session.resize ? 0 : data || opening ? 120 : 300;
      session.timer = setTimeout(() => updateTerminal(session), delay);
    }
  }
}

function releaseTerminal(session) {
  terminalRequest(session, "close").catch(() => {
    // The guest reaps terminal sessions after inactivity if the connection has closed.
  });
}

function resizeTerminal(session) {
  const size = session.fit.proposeDimensions();
  if (size) session.term.resize(Math.min(size.cols, 300), Math.min(size.rows, 150));
}

function closeTerminal() {
  const session = terminalSession;
  if (session) {
    terminalSession = null;
    session.closed = true;
    clearTimeout(session.timer);
    if (!session.running) releaseTerminal(session);
    session.term.dispose();
  }
  terminalPanel.hidden = true;
  $("terminal-open").setAttribute("aria-expanded", "false");
}

function openTerminal() {
  if (terminalSession && !terminalSession.exited) {
    terminalSession.term.focus();
    return;
  }
  closeTerminal();
  terminalPanel.hidden = false;
  $("terminal-open").setAttribute("aria-expanded", "true");
  if (!window.Terminal || !window.FitAddon) {
    $("terminal-status").textContent = "터미널 화면을 불러오지 못했습니다.";
    return;
  }
  const fit = new FitAddon.FitAddon();
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 3000,
    theme: { background: "#111827", foreground: "#e3e8f4" },
  });
  const session = { id: crypto.randomUUID(), term, fit, offset: 0, input: [] };
  terminalSession = session;
  $("terminal-status").textContent = "VM 터미널 연결 중…";
  term.loadAddon(fit);
  term.open(terminalScreen);
  resizeTerminal(session);
  term.onResize(() => {
    session.resize = true;
    updateTerminal(session);
  });
  term.onData((data) => {
    const characters = Array.from(data);
    for (let start = 0; start < characters.length; start += 1024) {
      session.input.push(characters.slice(start, start + 1024).join(""));
    }
    updateTerminal(session);
  });
  term.focus();
  updateTerminal(session);
}

$("terminal-open").onclick = openTerminal;
$("terminal-close").onclick = () => {
  closeTerminal();
  $("terminal-open").focus();
};
new ResizeObserver(() => {
  if (terminalSession) resizeTerminal(terminalSession);
}).observe(terminalScreen);
window.addEventListener("pagehide", closeTerminal);
