"use strict";

const terminalPanel = $("terminal-panel");
const terminalScreen = $("terminal-screen");
let terminalSession = null;
let terminalSync;

function sendTerminal(session, operation, data = "") {
  if (session.socket.readyState !== WebSocket.OPEN) return;
  session.socket.send(JSON.stringify({
    operation, data, cols: session.term.cols, rows: session.term.rows,
  }));
}

function endTerminal(session, message) {
  if (terminalSession !== session || session.exited) return;
  session.exited = true;
  session.term.options.disableStdin = true;
  $("terminal-status").textContent = message;
}

function resizeTerminal(session) {
  const size = session.fit.proposeDimensions();
  if (size) session.term.resize(Math.min(size.cols, 300), Math.min(size.rows, 150));
}

function closeTerminal() {
  const session = terminalSession;
  if (session) {
    terminalSession = null;
    if (session.ready && !session.exited) sendTerminal(session, "close");
    session.socket.close();
    session.term.dispose();
  }
  clearTimeout(terminalSync);
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
    cursorBlink: true, fontSize: 13, scrollback: 3000, disableStdin: true,
    theme: { background: "#111827", foreground: "#e3e8f4" },
  });
  const socket = new WebSocket(vmSocketURL("terminal"));
  const session = { term, fit, socket };
  terminalSession = session;
  $("terminal-status").textContent = "VM 터미널 연결 중…";
  term.loadAddon(fit);
  term.open(terminalScreen);
  resizeTerminal(session);

  socket.onopen = () => socket.send(JSON.stringify({
    operation: "open", terminal: crypto.randomUUID(), offset: 0,
    cols: term.cols, rows: term.rows,
  }));
  socket.onmessage = ({ data }) => {
    if (terminalSession !== session || session.exited) return;
    try {
      const frame = JSON.parse(data);
      if (frame.error) {
        endTerminal(session, "VM 터미널 연결 실패 · " + frame.error);
        socket.close();
        return;
      }
      if (frame.type === "ready") {
        session.ready = true;
        term.options.disableStdin = false;
        $("terminal-status").textContent = "";
        sendTerminal(session, "resize");
      }
      if (frame.truncated) term.writeln("\r\n[일부 출력이 생략되었습니다.]");
      if (frame.data) {
        term.write(Uint8Array.from(atob(frame.data), (byte) => byte.charCodeAt(0)));
        clearTimeout(terminalSync);
        terminalSync = setTimeout(syncWorkspace, 100);
      }
      if (frame.exited) endTerminal(session, "셸 종료 · 종료 코드 " + frame.exitCode);
    } catch {
      endTerminal(session, "VM 터미널 응답이 올바르지 않습니다.");
      socket.close();
    }
  };
  socket.onerror = socket.onclose = () => endTerminal(session, "VM 터미널 연결이 끊겼습니다.");
  term.onResize(() => {
    if (session.ready) sendTerminal(session, "resize");
  });
  term.onData((data) => {
    if (!session.ready || session.exited) return;
    const characters = Array.from(data);
    for (let start = 0; start < characters.length; start += 1024) {
      sendTerminal(session, "input", characters.slice(start, start + 1024).join(""));
    }
  });
  term.focus();
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
