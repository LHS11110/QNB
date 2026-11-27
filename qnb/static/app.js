"use strict";

const $ = (id) => document.getElementById(id);
const tabs = new Map();
let active = null;
let folder = "/";
let cursor = null;
let entries = [];
let graphVisible = false;
let graphMode = "proof";
let graphPage = 0;
let graphData = { theorems: [], nodes: [], edges: [] };
let selectedTheorem = null;
let busy = false;
let authMode = "signup";
let authNextPath = "/ide";
let currentSession = { email: null };
let ideInitialized = false;
let fileAction;
let listRequest = 0;
let listing = false;
let graphRequest = 0;
const standaloneProofPage = location.pathname === "/proofs";
document.body.classList.toggle("proof-page", standaloneProofPage);

const THEME_KEY = "qnb_ide_theme";

function currentTheme() {
  return document.documentElement.dataset.ideTheme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.ideTheme = normalized;
  try {
    localStorage.setItem(THEME_KEY, normalized);
  } catch {
    // Ignore storage errors in restricted contexts.
  }
  for (const id of ["theme-toggle", "home-theme-toggle"]) {
    const toggle = $(id);
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(normalized === "dark"));
      toggle.title = normalized === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환";
      toggle.setAttribute("aria-label", toggle.title);
    }
  }
  if (ideInitialized && !standaloneProofPage) {
    renderWorkbench();
  }
  if (graphVisible && graphMode === "proof") {
    proofGraph?.draw();
  }
  window.QNBParticles?.refreshTheme?.();
}

applyTheme((() => {
  try {
    return localStorage.getItem(THEME_KEY) || "light";
  } catch {
    return "light";
  }
})());

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className, title) {
  const node = element("button", text, className);
  node.type = "button";
  if (title) {
    node.title = title;
    node.setAttribute("aria-label", title);
  }
  node.addEventListener("click", action);
  return node;
}

async function api(route, payload) {
  const options = payload === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
  const response = await fetch("/api/" + route, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "요청에 실패했습니다 (" + response.status + ").");
    error.status = response.status;
    throw error;
  }
  return data;
}

const FILE_LIMIT = 131072;
const FILE_CHUNK_SIZE = 98304;
const LARGE_FILE_LIMIT = 8 * 1024 * 1024;

let vmSocket;
let vmQueue = Promise.resolve();

function vmSocketURL(stream) {
  const url = new URL("/api/vm/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (stream) url.searchParams.set("stream", stream);
  return url;
}

// A fresh wss handshake (TCP + TLS) can take several seconds on mobile networks, and the
// server closes idle VM sockets after 12 s, so most requests reconnect: allow time and retry once.
const VM_CONNECT_TIMEOUT = 10000;

async function connectVM() {
  if (vmSocket?.readyState === WebSocket.OPEN) return vmSocket;
  try {
    return await openVMSocket();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return openVMSocket();
  }
}

function openVMSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(vmSocketURL());
    const timeout = setTimeout(unavailable, VM_CONNECT_TIMEOUT);
    function unavailable() {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("VM WebSocket 연결을 열 수 없습니다."));
    }
    socket.addEventListener("error", unavailable, { once: true });
    socket.addEventListener("close", unavailable, { once: true });
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.removeEventListener("error", unavailable);
      socket.removeEventListener("close", unavailable);
      vmSocket = socket;
      resolve(socket);
    }, { once: true });
  });
}

function vmRequest(resource, payload, upload, onProgress) {
  const task = vmQueue.then(() => sendVMRequest(resource, payload, upload, onProgress));
  vmQueue = task.catch(() => {});
  return task;
}

async function sendVMRequest(resource, payload, upload, onProgress) {
  const socket = await connectVM();
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunks = [];
    const binaryChunks = [];
    let uploadOffset = 0;

    function finish(callback, value) {
      socket.removeEventListener("message", receive);
      socket.removeEventListener("close", disconnected);
      socket.removeEventListener("error", disconnected);
      callback(value);
    }

    function disconnected() {
      socket.close();
      finish(reject, new Error("결과를 받기 전에 연결이 끊겼습니다. VM에서 작업이 계속될 수 있습니다."));
    }

    function receive({ data }) {
      try {
        const response = JSON.parse(data);
        if (typeof response?.binaryChunk === "string") {
          binaryChunks.push(Uint8Array.from(atob(response.binaryChunk), (byte) => byte.charCodeAt(0)));
          return;
        }
        if (typeof response?.chunk === "string") {
          const bytes = Uint8Array.from(atob(response.chunk), (byte) => byte.charCodeAt(0));
          chunks.push(decoder.decode(bytes, { stream: true }));
          return;
        }
        if (Number.isInteger(response?.uploadOffset)) {
          if (!upload || response.uploadOffset !== uploadOffset) throw new Error();
          const chunk = upload.subarray(uploadOffset, uploadOffset + FILE_CHUNK_SIZE);
          socket.send(chunk);
          uploadOffset += chunk.length;
          onProgress?.(uploadOffset / Math.max(1, upload.length));
          return;
        }
        if (response?.result) {
          if (chunks.length) {
            chunks.push(decoder.decode());
            response.result.text = chunks.join("");
          }
          if (response.result.binary) {
            const parts = typeof response.result.content === "string"
              ? [Uint8Array.from(atob(response.result.content), (byte) => byte.charCodeAt(0))]
              : binaryChunks;
            const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
            let at = 0;
            for (const part of parts) { bytes.set(part, at); at += part.length; }
            response.result.bytes = bytes;
            delete response.result.content;
          }
          finish(resolve, response.result);
        } else {
          const error = new Error(response?.error || "올바르지 않은 VM 응답입니다.");
          error.status = response?.status;
          finish(reject, error);
        }
      } catch {
        socket.close();
        finish(reject, new Error("UTF-8 파일을 읽을 수 없거나 VM 전송 응답이 올바르지 않습니다."));
      }
    }

    socket.addEventListener("message", receive);
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
    try {
      socket.send(JSON.stringify({ ...payload, resource }));
    } catch {
      disconnected();
    }
  });
}

/* ================= REAL-TIME AUTOMERGE STAGING & COLLAB WS ================= */
let collabSocket = null;
let collabConnectPromise = null;
let collabReconnectTimer = null;
let collabSelfSessionId = null;
let collabPending = new Map();
let collabReqSeq = 0;
let workspaceClients = [];
const stagedFilesState = new Map(); // path -> { dirty, collaborators, activeCount }

function collabSocketURL() {
  const url = new URL("/api/collab/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function setCollabStatusUI(online, labelText) {
  const pill = $("collab-presence");
  const label = $("collab-label");
  if (!pill || !label) return;
  pill.classList.toggle("online", online);
  pill.classList.toggle("offline", !online);
  label.textContent = labelText;
}

function updatePresenceHeader() {
  if (!collabSocket || collabSocket.readyState !== WebSocket.OPEN) {
    setCollabStatusUI(false, "동기화 재연결 중…");
    return;
  }
  const uniqueNames = new Set();
  for (const c of workspaceClients) {
    uniqueNames.add(c.handle || c.nickname || c.email || c.sessionId);
  }
  const stagedCnt = stagedFilesState.size;
  const suffix = stagedCnt > 0 ? ` · 스테이징 ${stagedCnt}파일` : "";
  setCollabStatusUI(true, `실시간 동기화 · ${Math.max(1, uniqueNames.size)}명${suffix}`);
}

function renderActiveCollabBanner(tab) {
  const meta = $("file-collab-meta");
  if (!meta) return;
  if (!tab || graphVisible) {
    meta.hidden = true;
    return;
  }
  const collaborators = tab.collaborators || [];
  const names = collaborators.map((c) => {
    const tag = c.kind === "mcp" ? "[MCP] " : "";
    return tag + (c.handle || c.nickname || c.email?.split("@")[0] || "사용자");
  });
  const hasMcp = collaborators.some((c) => c.kind === "mcp");
  meta.hidden = false;
  const spans = [
    element("span", `스테이징 ${collaborators.length}명`),
  ];
  if (names.length) {
    spans.push(element("span", "· " + names.slice(0, 4).join(", ") + (names.length > 4 ? ` 외 ${names.length - 4}명` : "")));
  }
  if (hasMcp) spans.push(element("span", "MCP 공동편집", "mcp-tag"));
  meta.replaceChildren(...spans);
}

function applyRemoteStagePatch(msg) {
  const path = msg.path;
  stagedFilesState.set(path, {
    dirty: Boolean(msg.dirty),
    collaborators: msg.collaborators || [],
    activeCount: msg.activeCount ?? (msg.collaborators?.length || 0),
  });
  renderEntries();

  const tab = tabs.get(path);
  if (!tab) return;
  tab.collaborators = msg.collaborators || [];
  tab.dirty = Boolean(msg.dirty);

  if (msg.originSessionId !== collabSelfSessionId) {
    let nextText = msg.text;
    if (tab.collabSession) {
      nextText = tab.collabSession.applyRemotePatch(msg);
    }
    if (typeof nextText === "string" && tab.text !== nextText) {
      tab.text = nextText;
      if (isNotebook(path) && !tab.jsonMode) {
        try {
          const parsed = JSON.parse(nextText);
          if (parsed && Array.isArray(parsed.cells)) {
            tab.notebook = parsed;
          }
        } catch {
          tab.notebook = null;
        }
      }
      if (activeTab() === tab && !graphVisible) {
        if (isNotebook(tab.path) && !tab.jsonMode) {
          renderNotebook(tab);
        } else {
          renderPlainFile(tab, true);
        }
      }
    }
    const who = msg.actor?.handle || msg.actor?.nickname || msg.actor?.email || "협업자";
    const kindLabel = msg.actor?.kind === "mcp" ? "[MCP 에이전트] " : "";
    if (activeTab() === tab) status(`${kindLabel}${who}의 편집이 실시간 반영되었습니다.`);
  }
  renderTabs();
  if (activeTab() === tab && !graphVisible) {
    $("editor-mode").textContent = tab.dirty ? "미저장 (스테이징)" : "저장됨";
    renderActiveCollabBanner(tab);
  }
}

function handleCollabEvent(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.replyTo) {
    const entry = collabPending.get(msg.replyTo);
    if (entry) {
      collabPending.delete(msg.replyTo);
      if (msg.error) {
        const err = new Error(msg.error);
        err.status = msg.status;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }
    return;
  }

  if (msg.type === "workspace_init") {
    collabSelfSessionId = msg.selfSessionId || null;
    workspaceClients = msg.collaborators || [];
    stagedFilesState.clear();
    for (const item of msg.stagedFiles || []) {
      stagedFilesState.set(item.path, item);
      const t = tabs.get(item.path);
      if (t) {
        t.dirty = Boolean(item.dirty);
        t.collaborators = item.collaborators || [];
      }
    }
    updatePresenceHeader();
    renderEntries();
    renderTabs();
    renderActiveCollabBanner(activeTab());
    return;
  }

  if (msg.type === "stage_patch") {
    applyRemoteStagePatch(msg);
    return;
  }

  if (msg.type === "stage_presence") {
    stagedFilesState.set(msg.path, {
      dirty: stagedFilesState.get(msg.path)?.dirty ?? false,
      collaborators: msg.collaborators || [],
      activeCount: msg.activeCount ?? (msg.collaborators?.length || 0),
    });
    const tab = tabs.get(msg.path);
    if (tab) {
      tab.collaborators = msg.collaborators || [];
      if (activeTab() === tab && !graphVisible) renderActiveCollabBanner(tab);
    }
    return;
  }

  if (msg.type === "file_saved") {
    const info = stagedFilesState.get(msg.path);
    if (info && msg.staged) info.dirty = false;
    else stagedFilesState.delete(msg.path);
    const tab = tabs.get(msg.path);
    if (tab) {
      tab.dirty = false;
      tab.etag = msg.etag || tab.etag;
      tab.fileId = msg.fileId || tab.fileId;
      tab.resourceId = msg.resourceId || tab.resourceId;
      tab.remoteChange = null;
      renderTabs();
      if (activeTab() === tab && !graphVisible) {
        $("editor-mode").textContent = "저장됨";
        showFileSyncNotice(tab);
      }
    }
    renderEntries();
    updatePresenceHeader();
    return;
  }

  if (msg.type === "file_unstaged") {
    stagedFilesState.delete(msg.path);
    renderEntries();
    updatePresenceHeader();
    return;
  }

  if (msg.type === "fs_event") {
    const targetPath = msg.path;
    if (msg.action === "delete") {
      stagedFilesState.delete(targetPath);
      const prefix = targetPath.replace(/\/$/, "") + "/";
      for (const [opened] of [...tabs]) {
        if (opened === targetPath || opened.startsWith(prefix)) {
          clearTimeout(tabs.get(opened)?.editDebounce);
          tabs.delete(opened);
          if (active === opened) active = [...tabs.keys()].at(-1) || null;
        }
      }
      if (folder === targetPath || folder.startsWith(prefix)) {
        showFolder(dirname(targetPath));
      } else if (dirname(targetPath) === folder) {
        showFolder(folder);
      }
      renderWorkbench();
      return;
    }

    if (msg.action === "rename") {
      const target = msg.target;
      const prefix = targetPath.replace(/\/$/, "") + "/";
      for (const [opened, tab] of [...tabs]) {
        if (opened === targetPath || opened.startsWith(prefix)) {
          tabs.delete(opened);
          tab.path = target + opened.slice(targetPath.length);
          tabs.set(tab.path, tab);
          if (active === opened) active = tab.path;
        }
      }
      if (folder === targetPath || folder.startsWith(prefix)) {
        folder = target + folder.slice(targetPath.length);
        showFolder(folder);
      } else if (dirname(targetPath) === folder || dirname(target) === folder) {
        showFolder(folder);
      }
      renderWorkbench();
      return;
    }

    if (msg.action === "mkdir" || msg.action === "create") {
      if (dirname(targetPath) === folder) {
        showFolder(folder);
      }
      return;
    }
  }

  if (msg.type === "workspace_revoked") {
    recoverRevokedWorkspace();
  }
}

function connectCollab() {
  if (collabSocket?.readyState === WebSocket.OPEN) return Promise.resolve(collabSocket);
  if (collabConnectPromise) return collabConnectPromise;

  collabConnectPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(collabSocketURL());
    const timeout = setTimeout(() => {
      socket.close();
      collabConnectPromise = null;
      reject(new Error("실시간 협업 WebSocket 연결 시간이 초과되었습니다."));
    }, 5000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      collabSocket = socket;
      collabConnectPromise = null;
      updatePresenceHeader();
      resolve(socket);
    }, { once: true });

    socket.addEventListener("message", ({ data }) => {
      try {
        handleCollabEvent(JSON.parse(data));
      } catch {
        // Ignore invalid JSON frames
      }
    });

    const onClose = () => {
      clearTimeout(timeout);
      if (collabSocket === socket) collabSocket = null;
      collabConnectPromise = null;
      setCollabStatusUI(false, "동기화 재연결 중…");
      for (const [, p] of collabPending) p.reject(new Error("실시간 협업 연결이 끊겼습니다."));
      collabPending.clear();
      if (ideInitialized && !standaloneProofPage && currentSession.email && !collabReconnectTimer) {
        collabReconnectTimer = setTimeout(() => {
          collabReconnectTimer = null;
          connectCollab().catch(() => {});
        }, 1500);
      }
    };

    socket.addEventListener("close", onClose);
    socket.addEventListener("error", () => {});
  });
  return collabConnectPromise;
}

async function collabRequest(type, payload = {}) {
  const socket = await connectCollab();
  const reqId = "c" + (++collabReqSeq);
  return new Promise((resolve, reject) => {
    collabPending.set(reqId, { resolve, reject });
    try {
      socket.send(JSON.stringify({ reqId, type, ...payload }));
    } catch (err) {
      collabPending.delete(reqId);
      reject(err);
    }
  });
}

function disconnectCollab() {
  clearTimeout(collabReconnectTimer);
  collabReconnectTimer = null;
  collabConnectPromise = null;
  if (collabSocket) {
    try {
      collabSocket.close();
    } catch {
      // ignore
    }
    collabSocket = null;
  }
  stagedFilesState.clear();
  workspaceClients = [];
  window.QNBChannels?.disconnect();
  window.QNBPlanner?.reset();
}

window.addEventListener("pagehide", () => {
  vmSocket?.close();
  disconnectCollab();
});

function status(message, error = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", error);
}

function alertIn(id, message = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

let pendingMfaToken = null;
let qrPollTimer = null;

function setAuth(mode, notice = "") {
  authMode = mode;
  pendingMfaToken = null;
  stopQrPolling();
  const signingUp = mode === "signup";
  $("auth-form").hidden = false;
  $("mfa-form").hidden = true;
  $("nickname-field").hidden = !signingUp;
  $("alt-auth-box").hidden = signingUp;
  $("qr-login-panel").hidden = true;
  $("auth-title").textContent = signingUp ? "워크스페이스 생성" : "다시 오신 것을 환영합니다";
  $("auth-subtitle").textContent = signingUp
    ? "개인 VM 워크스페이스와 실시간 협업 스테이징 공간을 즉시 배정받으세요."
    : "계정에 연결된 노트북과 증명 트리를 이어서 탐색합니다.";
  $("auth-submit").textContent = signingUp ? "가입하고 시작하기" : "로그인";
  $("auth-toggle").textContent = signingUp ? "이미 계정이 있나요? 로그인" : "처음인가요? 무료 회원가입";
  $("auth-tab-login").setAttribute("aria-selected", String(!signingUp));
  $("auth-tab-signup").setAttribute("aria-selected", String(signingUp));
  $("auth-tab-login").classList.toggle("active", !signingUp);
  $("auth-tab-signup").classList.toggle("active", signingUp);
  $("password").autocomplete = signingUp ? "new-password" : "current-password";
  alertIn("auth-context-notice", notice);
  alertIn("auth-error");
  alertIn("mfa-error");
}

function showView(view) {
  document.body.dataset.view = view;
  const isHome = view === "home";
  const isAuth = view === "auth";
  const isQrApprove = view === "qr-approve";
  const isVerify = view === "verify";
  $("verify-page").hidden = !isVerify;
  const isIDE = view === "ide";
  $("home").hidden = !isHome;
  $("auth-page").hidden = !isAuth;
  $("qr-approve-page").hidden = !isQrApprove;
  $("ide").hidden = !isIDE;
  $("home-nav").hidden = !isHome;
  $("ide-header-controls").hidden = !isIDE || standaloneProofPage;
  if (!isIDE || standaloneProofPage) $("channels-panel").hidden = true;
  $("theme-toggle").hidden = false;
  $("layout-controls").hidden = !isIDE || standaloneProofPage;
  $("ide-tools").hidden = false;
  if ($("mascot-toggle")) $("mascot-toggle").hidden = !isIDE || standaloneProofPage;

  const loggedIn = Boolean(currentSession.email);
  const label = $("account-label");
  if (currentSession.nickname) {
    const tag = currentSession.tag ? element("span", "#" + currentSession.tag, "handle-tag") : "";
    label.replaceChildren(currentSession.nickname, tag);
  } else {
    label.textContent = currentSession.email || "";
  }
  $("account-open").title = currentSession.email ? `${currentSession.handle || currentSession.nickname || ""} · ${currentSession.email}\n프로필 · 보안 · MCP CLI 토큰 설정` : "";
  $("account-open").hidden = !loggedIn;
  renderWorkspaceBadge();
  $("logout").hidden = !loggedIn;
  $("header-login").hidden = loggedIn || isAuth;
  $("header-signup").hidden = loggedIn || isAuth;
  $("header-ide-link").hidden = !loggedIn || isIDE;
  $("home-nav-login")?.toggleAttribute("hidden", loggedIn);
  $("home-nav-signup")?.toggleAttribute("hidden", loggedIn);
  $("home-nav-ide")?.toggleAttribute("hidden", !loggedIn);
  $("signup-open").hidden = loggedIn;
  $("login-open").hidden = loggedIn;
  $("ide-link").hidden = !loggedIn;
  $("bottom-signup").hidden = loggedIn;
  $("bottom-ide").hidden = !loggedIn;
  $("proofs-link").hidden = !loggedIn || !isIDE || standaloneProofPage;
  $("proofs-editor-link").hidden = !loggedIn || !standaloneProofPage;

  if (isHome) {
    window.QNBParticles?.start();
  } else {
    window.QNBParticles?.stop();
  }
  if (!isAuth) stopQrPolling();
}

/* ---------------- email verification ---------------- */
function showVerifyPage(message = "") {
  $("verify-title").textContent = "메일함을 확인해 주세요";
  $("verify-description").textContent = `${currentSession.email}(으)로 보낸 6자리 인증 코드를 입력하면 워크스페이스를 사용할 수 있습니다. 코드는 30분 동안 유효합니다.`;
  $("verify-form").hidden = false;
  $("verify-mail-hint").hidden = currentSession.mailConfigured !== false;
  alertIn("verify-status", message);
  showView("verify");
  setTimeout(() => $("verify-code").focus(), 0);
}

async function handleVerifyLink() {
  const token = new URLSearchParams(location.search).get("token") || "";
  showView("verify");
  $("verify-form").hidden = true;
  $("verify-mail-hint").hidden = true;
  $("verify-title").textContent = "이메일을 인증하는 중…";
  $("verify-description").textContent = "";
  try {
    const result = await api("email/verify-link", { token });
    $("verify-title").textContent = "이메일 인증이 완료되었습니다 ✓";
    $("verify-description").textContent = `${result.email} 계정을 이제 사용할 수 있습니다.`;
    history.replaceState(null, "", "/verify-email");
    setTimeout(() => location.assign(currentSession.email ? "/ide" : "/login"), 1500);
  } catch (error) {
    $("verify-title").textContent = "인증 링크를 사용할 수 없습니다";
    $("verify-description").textContent = error.message + (currentSession.email ? " 아래에서 코드를 다시 받을 수 있습니다." : " 로그인한 뒤 새 인증 메일을 받으세요.");
    $("verify-form").hidden = !currentSession.email || currentSession.emailVerified !== false;
  }
}

$("verify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("verify-submit").disabled = true;
  try {
    await api("email/verify", { code: $("verify-code").value.trim() });
    alertIn("verify-status", "인증되었습니다. 워크스페이스로 이동합니다…");
    location.assign(authNextPath && authNextPath !== "/verify-email" ? authNextPath : "/ide");
  } catch (error) {
    alertIn("verify-status", error.message);
    $("verify-code").select();
  } finally {
    $("verify-submit").disabled = false;
  }
});

let verifyCooldown = null;
$("verify-resend").onclick = async () => {
  const buttonNode = $("verify-resend");
  buttonNode.disabled = true;
  try {
    const result = await api("email/resend", {});
    if (result.verified) { location.assign("/ide"); return; }
    alertIn("verify-status", result.delivered ? "새 인증 코드를 보냈습니다. 메일함(스팸함 포함)을 확인하세요." : "새 인증 코드를 만들었습니다. 메일 서버가 설정되지 않아 서버 로그에 기록되었습니다.");
    let left = 60;
    clearInterval(verifyCooldown);
    verifyCooldown = setInterval(() => {
      buttonNode.textContent = `다시 보내기 (${--left}초)`;
      if (left <= 0) { clearInterval(verifyCooldown); buttonNode.textContent = "인증 메일 다시 보내기"; buttonNode.disabled = false; }
    }, 1000);
  } catch (error) {
    alertIn("verify-status", error.message);
    buttonNode.disabled = false;
  }
};

$("verify-logout").onclick = async () => {
  try { await api("logout", {}); } catch { /* already logged out */ }
  location.assign("/login");
};

function routePath() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

async function applyRoute() {
  const path = routePath();
  const loggedIn = Boolean(currentSession.email);
  const workspaceRoute = path === "/ide" || path === "/proofs";

  if (path === "/verify-email") {
    await handleVerifyLink();
    return;
  }
  if (loggedIn && currentSession.emailVerified === false && (workspaceRoute || path === "/qr-approve")) {
    showVerifyPage();
    return;
  }

  if ((path === "/login" || path === "/signup") && loggedIn) {
    location.assign("/ide");
    return;
  }

  if (path === "/qr-approve") {
    const code = new URLSearchParams(location.search).get("code") || "";
    if (!loggedIn) {
      authNextPath = location.pathname + location.search;
      setAuth("login", "QR 로그인을 승인하려면 먼저 휴대폰에서 로그인하세요.");
      showView("auth");
      return;
    }
    const label = currentSession.nickname
      ? currentSession.nickname + " (" + currentSession.email + ")"
      : currentSession.email;
    $("qr-approve-account").textContent = "현재 로그인된 계정: " + label;
    $("qr-approve-btn").disabled = !code;
    alertIn("qr-approve-status", code ? "" : "QR 코드 파라미터가 없습니다.");
    showView("qr-approve");
    return;
  }

  if (workspaceRoute && !loggedIn) {
    authNextPath = path;
    setAuth("login", "워크스페이스에 접근하려면 먼저 로그인하세요.");
    showView("auth");
    return;
  }

  if (path === "/login" || path === "/signup") {
    authNextPath = "/ide";
    setAuth(path === "/signup" ? "signup" : "login");
    showView("auth");
    return;
  }

  if (workspaceRoute && loggedIn) {
    showView("ide");
    if (!ideInitialized) {
      ideInitialized = true;
      if (standaloneProofPage) {
        await showGraph();
      } else {
        renderWorkbench();
        connectCollab().catch(() => {}); window.QNBChannels?.connect();
        await showFolder("/");
      }
    }
    return;
  }

  showView("home");
}

function navigateSpa(path, mode = null) {
  if (routePath() !== path) {
    history.pushState(null, "", path);
  }
  if (mode) setAuth(mode);
  applyRoute();
}

function dirtyTabs() {
  return [...tabs.values()].some((tab) => tab.dirty);
}

window.addEventListener("beforeunload", (event) => {
  if (busy || (dirtyTabs() && collabSocket?.readyState !== WebSocket.OPEN)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function boot() {
  try {
    currentSession = await api("session");
    await applyRoute();
  } catch (error) {
    currentSession = { email: null };
    setAuth("login");
    showView("auth");
    alertIn("auth-error", error.message);
  }
}

window.addEventListener("popstate", () => applyRoute());

for (const [id, path, mode] of [
  ["header-login", "/login", "login"],
  ["header-signup", "/signup", "signup"],
  ["home-nav-login", "/login", "login"],
  ["home-nav-signup", "/signup", "signup"],
  ["login-open", "/login", "login"],
  ["signup-open", "/signup", "signup"],
  ["bottom-signup", "/signup", "signup"],
  ["auth-home-link", "/", null],
]) {
  $(id)?.addEventListener("click", (event) => {
    event.preventDefault();
    navigateSpa(path, mode);
  });
}

$("brand-link")?.addEventListener("click", (event) => {
  if (document.body.dataset.view === "ide") return;
  event.preventDefault();
  navigateSpa("/");
});

$("auth-tab-login").onclick = () => {
  if (routePath() === "/signup") history.replaceState(null, "", "/login");
  setAuth("login", $("auth-context-notice").textContent);
};
$("auth-tab-signup").onclick = () => {
  if (routePath() === "/login") history.replaceState(null, "", "/signup");
  setAuth("signup", $("auth-context-notice").textContent);
};
$("auth-toggle").onclick = () => {
  const nextMode = authMode === "signup" ? "login" : "signup";
  if (routePath() === "/login" || routePath() === "/signup") history.replaceState(null, "", "/" + nextMode);
  setAuth(nextMode, $("auth-context-notice").textContent);
};

$("password-toggle").onclick = () => {
  const input = $("password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("password-toggle").textContent = show ? "숨김" : "표시";
};

function b64urlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
function bytesToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function stopQrPolling() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}
function enterMfaStep(token) {
  pendingMfaToken = token;
  $("auth-form").hidden = true;
  $("alt-auth-box").hidden = true;
  $("mfa-form").hidden = false;
  $("mfa-code").value = "";
  alertIn("mfa-error");
  $("mfa-code").focus();
}

$("auth-form").onsubmit = async (event) => {
  event.preventDefault();
  $("auth-submit").disabled = true;
  alertIn("auth-error");
  try {
    const body = { email: $("email").value, password: $("password").value };
    if (authMode === "signup" && $("nickname").value.trim()) body.nickname = $("nickname").value.trim();
    const result = await api(authMode, body);
    if (result.mfaRequired) {
      enterMfaStep(result.mfaToken);
      $("auth-submit").disabled = false;
      return;
    }
    location.assign(authNextPath || "/ide");
  } catch (error) {
    alertIn("auth-error", error.message);
    $("auth-submit").disabled = false;
  }
};

$("mfa-cancel").onclick = () => setAuth("login");
$("mfa-form").onsubmit = async (event) => {
  event.preventDefault();
  $("mfa-submit").disabled = true;
  alertIn("mfa-error");
  try {
    await api("login/mfa", { mfaToken: pendingMfaToken, code: $("mfa-code").value });
    location.assign(authNextPath || "/ide");
  } catch (error) {
    alertIn("mfa-error", error.message);
    $("mfa-submit").disabled = false;
  }
};

$("passkey-login-btn").onclick = async () => {
  alertIn("auth-error");
  if (!window.PublicKeyCredential) return alertIn("auth-error", "이 브라우저는 패스키(WebAuthn)를 지원하지 않습니다.");
  try {
    const options = await api("passkeys/login/options", { email: $("email").value.trim() });
    const pk = options.publicKey;
    pk.challenge = b64urlToBytes(pk.challenge);
    pk.allowCredentials = (pk.allowCredentials || []).map((item) => ({ ...item, id: b64urlToBytes(item.id) }));
    const assertion = await navigator.credentials.get({ publicKey: pk });
    const result = await api("passkeys/login/verify", {
      challengeToken: options.challengeToken,
      credential: {
        id: assertion.id,
        rawId: bytesToB64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: bytesToB64url(assertion.response.clientDataJSON),
          authenticatorData: bytesToB64url(assertion.response.authenticatorData),
          signature: bytesToB64url(assertion.response.signature),
        },
      },
    });
    if (result.mfaRequired) return enterMfaStep(result.mfaToken);
    location.assign(authNextPath || "/ide");
  } catch (error) {
    if (error?.name !== "NotAllowedError") alertIn("auth-error", error.message || "패스키 로그인에 실패했습니다.");
  }
};

$("qr-login-btn").onclick = async () => {
  alertIn("auth-error");
  stopQrPolling();
  try {
    const data = await api("qr-login/start", {});
    $("qr-login-img").src = data.qrDataUrl || "";
    $("qr-login-img").hidden = !data.qrDataUrl;
    $("qr-login-status").textContent = "이미 로그인된 휴대폰으로 QR 코드를 스캔해 승인하세요.";
    $("qr-login-panel").hidden = false;
    qrPollTimer = setInterval(async () => {
      try {
        const res = await api("qr-login/poll", { code: data.code, pollSecret: data.pollSecret });
        if (res.email) { stopQrPolling(); location.assign(authNextPath || "/ide"); }
      } catch (error) {
        stopQrPolling();
        $("qr-login-status").textContent = error.message;
      }
    }, 2000);
  } catch (error) {
    alertIn("auth-error", error.message);
  }
};
$("qr-login-cancel").onclick = () => { stopQrPolling(); $("qr-login-panel").hidden = true; };

$("qr-approve-btn").onclick = async () => {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  $("qr-approve-btn").disabled = true;
  try {
    await api("qr-login/approve", { code });
    alertIn("qr-approve-status", "PC 로그인을 승인했습니다. PC 화면이 자동으로 워크스페이스로 이동합니다.");
  } catch (error) {
    alertIn("qr-approve-status", error.message);
    $("qr-approve-btn").disabled = false;
  }
};

$("logout").onclick = async () => {
  if (busy) return;
  try {
    for (const [p] of [...tabs]) await closeFile(p, true);
    disconnectCollab();
    await api("logout", {});
    tabs.clear();
    location.assign("/");
  } catch (error) { status(error.message, true); }
};

$("theme-toggle").onclick = () => applyTheme(currentTheme() === "dark" ? "light" : "dark");
$("home-theme-toggle")?.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"));

document.addEventListener("keydown", (event) => {
  if (document.body.dataset.view !== "ide" || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "b") return;
  event.preventDefault();
  (event.altKey ? $("viz-toggle") : $("sidebar-toggle")).click();
});

$("sidebar-toggle").onclick = () => {
  const collapsed = $("ide").classList.toggle("sidebar-collapsed");
  $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  if (graphVisible) setTimeout(() => (graphMode === "code" ? codeGraph : proofGraph).fit(), 60);
};

$("view-editor").onclick = () => { graphVisible = false; renderWorkbench(); renderEntries(); };
$("view-graph").onclick = () => showGraph(graphPage, graphData.root);
$("view-code").onclick = () => showCodeGraph();
$("view-planner").onclick = () => showPlanner();

function renderWorkspaceBadge() {
  const ws = currentSession.workspace;
  const pill = $("workspace-open");
  const label = $("workspace-label");
  const badge = $("invite-badge");
  if (!pill || !label || !badge) return;
  if (ws && ws.shared) {
    label.textContent = "공유 · " + ws.ownerEmail;
    pill.classList.add("shared");
  } else {
    label.textContent = "내 워크스페이스";
    pill.classList.remove("shared");
  }
  const pending = Number(currentSession.pendingInvites || 0);
  badge.textContent = String(pending);
  badge.hidden = pending <= 0;
}

async function recoverRevokedWorkspace() {
  tabs.clear();
  active = null;
  graphVisible = false;
  window.QNBTerminals?.closeAll();
  vmSocket?.close(); vmSocket = null;
  disconnectCollab();
  currentSession = await api("session");
  renderWorkspaceBadge();
  renderWorkbench();
  connectCollab().catch(() => {}); window.QNBChannels?.connect();
  await showFolder("/");
}

async function switchWorkspace(ownerId) {
  if (busy) return;
  if (currentSession.workspace?.ownerId === ownerId) { $("workspace-dialog").close(); return; }
  for (const [p] of [...tabs]) await closeFile(p, true);
  window.QNBTerminals?.closeAll();
  vmSocket?.close(); vmSocket = null;
  disconnectCollab();
  try {
    const selected = await api("workspaces/select", { ownerId });
    currentSession.workspace = selected;
    tabs.clear();
    active = null;
    graphVisible = false;
    renderWorkspaceBadge();
    $("workspace-dialog").close();
    renderWorkbench();
    connectCollab().catch(() => {}); window.QNBChannels?.connect();
    await showFolder("/");
    status(selected.shared ? selected.ownerEmail + " 워크스페이스로 전환했습니다." : "내 워크스페이스로 전환했습니다.");
  } catch (error) {
    alertIn("invite-error", error.message);
  }
}

async function refreshWorkspaceDialog() {
  alertIn("invite-error");
  const data = await api("workspaces");
  currentSession.workspace = data.current;
  currentSession.pendingInvites = data.incoming.length;
  renderWorkspaceBadge();

  $("incoming-invites-section").hidden = data.incoming.length === 0;
  $("incoming-invites-list").replaceChildren(...data.incoming.map((invite) => {
    const row = element("div", undefined, "ws-row");
    const info = element("div", undefined, "ws-row-info");
    info.append(element("strong", invite.ownerHandle || invite.ownerEmail), element("span", `${invite.ownerEmail} · 워크스페이스 초대 대기 중`, "ws-meta"));
    const actions = element("div", undefined, "ws-row-actions");
    actions.append(
      button("수락 후 열기", async () => {
        try {
          await api("workspaces/respond", { ownerId: invite.ownerId, decision: "accept", switch: true });
          await switchWorkspace(invite.ownerId);
        } catch (error) { alertIn("invite-error", error.message); }
      }, "primary"),
      button("수락", async () => {
        try { await api("workspaces/respond", { ownerId: invite.ownerId, decision: "accept" }); await refreshWorkspaceDialog(); }
        catch (error) { alertIn("invite-error", error.message); }
      }),
      button("거절", async () => {
        try { await api("workspaces/respond", { ownerId: invite.ownerId, decision: "decline" }); await refreshWorkspaceDialog(); }
        catch (error) { alertIn("invite-error", error.message); }
      }, "quiet"),
    );
    row.append(info, actions);
    return row;
  }));

  $("workspace-list").replaceChildren(...data.workspaces.map((ws) => {
    const isCurrent = ws.ownerId === data.current.ownerId;
    const row = element("div", undefined, "ws-row" + (isCurrent ? " current" : ""));
    const info = element("div", undefined, "ws-row-info");
    info.append(
      element("strong", ws.shared ? (ws.ownerHandle ? `${ws.ownerHandle} 님의 워크스페이스` : ws.ownerEmail) : "내 워크스페이스 (" + (currentSession.handle || ws.ownerEmail) + ")"),
      element("span", ws.shared ? "공유 VM · 실시간 스테이징 공동 사용" : "개인 전용 VM", "ws-meta"),
    );
    const actions = element("div", undefined, "ws-row-actions");
    actions.append(isCurrent ? element("span", "사용 중", "ws-status active") : button("전환", () => switchWorkspace(ws.ownerId), "primary"));
    if (ws.shared) {
      actions.append(button("나가기", async () => {
        if (!confirm(ws.ownerEmail + " 워크스페이스에서 나갈까요?")) return;
        try {
          await api("workspaces/remove", { ownerId: ws.ownerId });
          if (isCurrent) { await recoverRevokedWorkspace(); $("workspace-dialog").close(); }
          else await refreshWorkspaceDialog();
        } catch (error) { alertIn("invite-error", error.message); }
      }, "quiet danger"));
    }
    row.append(info, actions);
    return row;
  }));

  const membersList = $("workspace-members-list");
  if (!data.members.length) {
    membersList.replaceChildren(element("p", "아직 초대한 사용자가 없습니다.", "ws-empty"));
  } else {
    membersList.replaceChildren(...data.members.map((member) => {
      const row = element("div", undefined, "ws-row");
      const info = element("div", undefined, "ws-row-info");
      const stateText = member.status === "accepted" ? "참여 중" : member.registered ? "수락 대기 중" : "미가입";
      info.append(element("strong", member.handle || member.email), element("span", member.handle ? `${member.email} · ${stateText}` : stateText, "ws-meta"));
      const actions = element("div", undefined, "ws-row-actions");
      actions.append(button(member.status === "accepted" ? "내보내기" : "초대 취소", async () => {
        try { await api("workspaces/remove", { email: member.email }); await refreshWorkspaceDialog(); }
        catch (error) { alertIn("invite-error", error.message); }
      }, "quiet danger"));
      row.append(info, actions);
      return row;
    }));
  }
}

$("workspace-open").onclick = async () => {
  try { await refreshWorkspaceDialog(); if (!$("workspace-dialog").open) $("workspace-dialog").showModal(); }
  catch (error) { status(error.message, true); }
};
$("workspace-dialog-close").onclick = () => $("workspace-dialog").close();
$("invite-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("invite-error");
  $("invite-submit").disabled = true;
  try {
    const target = $("invite-email").value.trim();
    await api("workspaces/invite", { target });
    $("invite-email").value = "";
    await refreshWorkspaceDialog();
    alertIn("invite-error", `${target} 님에게 초대를 보냈습니다. 상대방이 접속 중이면 바로 알림이 표시됩니다.`);
  }
  catch (error) { alertIn("invite-error", error.message); }
  finally { $("invite-submit").disabled = false; }
};

async function refreshAccountDialog() {
  alertIn("mfa-settings-error");
  alertIn("passkey-error");
  alertIn("mcp-token-error");
  $("profile-status").textContent = "";
  $("profile-nickname").value = currentSession.nickname || "";
  $("profile-handle").textContent = currentSession.handle || currentSession.nickname || "";
  $("mfa-setup-box").hidden = true;
  $("mfa-recovery-box").hidden = true;

  const [sec, mcpData, mcpHealth] = await Promise.all([
    api("security"),
    api("mcp-tokens"),
    api("mcp/health").catch(() => null),
  ]);
  const mcpBadge = $("mcp-state-badge");
  if (mcpBadge) {
    if (mcpHealth?.ok) {
      const cnt = Number(mcpHealth.activeSessions || 0);
      mcpBadge.textContent = cnt > 0 ? `상시 대기 중 · 활성 세션 ${cnt}` : "상시 대기 중";
      mcpBadge.classList.add("active");
    } else {
      mcpBadge.textContent = "상태 확인 불가";
      mcpBadge.classList.remove("active");
    }
  }
  if ($("mcp-live-url")) $("mcp-live-url").textContent = mcpHealth?.endpoints?.streamableHttp || `${location.origin}/mcp`;
  if ($("mcp-sse-url")) $("mcp-sse-url").textContent = mcpHealth?.endpoints?.sse || `${location.origin}/mcp/sse`;
  const enabled = Boolean(sec.mfaEnabled);
  $("mfa-state-badge").textContent = enabled ? "활성화됨" : "비활성화";
  $("mfa-state-badge").classList.toggle("active", enabled);
  $("mfa-off-controls").hidden = enabled;
  $("mfa-disable-form").hidden = !enabled;

  const mcpList = $("mcp-tokens-list");
  if (!mcpData.tokens?.length) {
    mcpList.replaceChildren(element("p", "발급된 MCP CLI 토큰이 없습니다.", "ws-empty"));
  } else {
    mcpList.replaceChildren(...mcpData.tokens.map((tok) => {
      const row = element("div", undefined, "ws-row");
      const info = element("div", undefined, "ws-row-info");
      info.append(element("strong", tok.label), element("span", tok.prefix + "…", "ws-meta"));
      const actions = element("div", undefined, "ws-row-actions");
      actions.append(button("폐기", async () => {
        try { await api("mcp-tokens/delete", { id: tok.id }); await refreshAccountDialog(); }
        catch (error) { alertIn("mcp-token-error", error.message); }
      }, "quiet danger"));
      row.append(info, actions);
      return row;
    }));
  }

  const list = $("passkeys-list");
  if (!sec.passkeys.length) {
    list.replaceChildren(element("p", "등록된 패스키가 없습니다.", "ws-empty"));
  } else {
    list.replaceChildren(...sec.passkeys.map((key) => {
      const row = element("div", undefined, "ws-row");
      const info = element("div", undefined, "ws-row-info");
      info.append(element("strong", key.label), element("span", "등록된 FIDO2 패스키", "ws-meta"));
      const actions = element("div", undefined, "ws-row-actions");
      actions.append(button("삭제", async () => {
        try { await api("passkeys/delete", { credentialId: key.id }); await refreshAccountDialog(); }
        catch (error) { alertIn("passkey-error", error.message); }
      }, "quiet danger"));
      row.append(info, actions);
      return row;
    }));
  }
}

$("account-open").onclick = async () => {
  try {
    $("mcp-token-created").hidden = true;
    await refreshAccountDialog();
    if (!$("account-dialog").open) $("account-dialog").showModal();
  } catch (error) { status(error.message, true); }
};
$("account-dialog-close").onclick = () => $("account-dialog").close();

$("mcp-token-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  alertIn("mcp-token-error");
  try {
    const res = await api("mcp-tokens", { label: $("mcp-token-label").value.trim() || "CLI Agent" });
    $("mcp-token-label").value = "";
    $("mcp-token-secret").textContent = res.token;
    const httpUrl = `${location.origin}/mcp`;
    const sseUrl = `${location.origin}/mcp/sse?token=${res.token}`;
    const snippetObj = {
      mcpServers: {
        qnb: {
          type: "http",
          url: httpUrl,
          headers: {
            Authorization: `Bearer ${res.token}`,
          },
        },
      },
    };
    $("mcp-config-snippet").textContent =
      `${JSON.stringify(snippetObj, null, 2)}\n\n# Claude Code CLI 원격 바로 등록 (백엔드 상시 대기 서버):\nclaude mcp add --transport http qnb ${httpUrl} --header "Authorization: Bearer ${res.token}"\n\n# 레거시 HTTP+SSE URL:\n${sseUrl}`;
    $("mcp-token-created").hidden = false;
    await refreshAccountDialog();
  } catch (error) {
    alertIn("mcp-token-error", error.message);
  }
});

$("mcp-token-copy")?.addEventListener("click", () => {
  navigator.clipboard?.writeText($("mcp-token-secret").textContent || "");
  $("mcp-token-copy").textContent = "복사됨!";
  setTimeout(() => { $("mcp-token-copy").textContent = "복사"; }, 1400);
});

$("profile-copy").onclick = () => {
  navigator.clipboard?.writeText($("profile-handle").textContent || "");
  $("profile-status").textContent = "사용자명을 복사했습니다.";
};

$("profile-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const res = await api("profile", { nickname: $("profile-nickname").value });
    Object.assign(currentSession, { nickname: res.nickname, tag: res.tag, handle: res.handle });
    $("account-label").replaceChildren(res.nickname, element("span", "#" + res.tag, "handle-tag"));
    $("profile-handle").textContent = res.handle;
    $("profile-status").textContent = `저장되었습니다. 다른 사용자는 ${res.handle}(으)로 나를 초대할 수 있습니다. 터미널 계정 이름은 새로 여는 터미널부터 적용됩니다.`;
  } catch (error) { $("profile-status").textContent = error.message; }
};

$("mfa-setup-btn").onclick = async () => {
  alertIn("mfa-settings-error");
  try {
    const data = await api("mfa/setup", {});
    $("mfa-qr-img").src = data.qrDataUrl || "";
    $("mfa-qr-img").hidden = !data.qrDataUrl;
    $("mfa-secret-text").textContent = "수동 키: " + data.secret;
    $("mfa-setup-box").hidden = false;
  } catch (error) { alertIn("mfa-settings-error", error.message); }
};
$("mfa-verify-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("mfa-settings-error");
  try {
    const data = await api("mfa/enable", { code: $("mfa-verify-code").value });
    $("mfa-verify-code").value = "";
    await refreshAccountDialog();
    $("mfa-recovery-codes").textContent = data.recoveryCodes.join("\n");
    $("mfa-recovery-box").hidden = false;
  } catch (error) { alertIn("mfa-settings-error", error.message); }
};
$("mfa-disable-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("mfa-settings-error");
  try {
    await api("mfa/disable", { code: $("mfa-disable-code").value });
    $("mfa-disable-code").value = "";
    await refreshAccountDialog();
  } catch (error) { alertIn("mfa-settings-error", error.message); }
};
$("passkey-register-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("passkey-error");
  if (!window.PublicKeyCredential) return alertIn("passkey-error", "이 브라우저는 패스키 등록을 지원하지 않습니다.");
  $("passkey-register-btn").disabled = true;
  try {
    const options = await api("passkeys/register/options", {});
    const pk = options.publicKey;
    pk.challenge = b64urlToBytes(pk.challenge);
    pk.user.id = b64urlToBytes(pk.user.id);
    pk.excludeCredentials = (pk.excludeCredentials || []).map((item) => ({ ...item, id: b64urlToBytes(item.id) }));
    const cred = await navigator.credentials.create({ publicKey: pk });
    await api("passkeys/register/verify", {
      challengeToken: options.challengeToken,
      label: $("passkey-label").value.trim() || "내 패스키",
      credential: {
        id: cred.id, rawId: bytesToB64url(cred.rawId), type: cred.type,
        response: { clientDataJSON: bytesToB64url(cred.response.clientDataJSON), attestationObject: bytesToB64url(cred.response.attestationObject) },
      },
    });
    $("passkey-label").value = "";
    await refreshAccountDialog();
  } catch (error) {
    if (error?.name !== "NotAllowedError") alertIn("passkey-error", error.message || "패스키 등록에 실패했습니다.");
  } finally { $("passkey-register-btn").disabled = false; }
};

async function refreshAxiomDialog() {
  alertIn("axiom-error");
  const data = await api("axioms");
  $("axiom-form").hidden = !data.canManage;
  $("axiom-role-notice").textContent = data.canManage
    ? "VM 소유자 권한으로 공리를 등록할 수 있습니다. 여기에 등록된 공리만 셀과 협업자가 참조할 수 있습니다."
    : "초대받은 협업자 모드(조회 전용)입니다. VM 소유자가 등록한 공리를 모든 코드 셀에서 참조할 수 있습니다.";
  const list = $("axioms-list");
  if (!data.axioms.length) {
    list.replaceChildren(element("p", "등록된 워크스페이스 공리가 없습니다.", "ws-empty"));
  } else {
    list.replaceChildren(...data.axioms.map((ax) => {
      const card = element("div", undefined, "ws-row axiom-card");
      const info = element("div", undefined, "ws-row-info");
      info.append(element("strong", ax.name), element("span", "SHA-256: " + ax.hash.slice(0, 16) + "…", "ws-meta"), element("pre", ax.source, "axiom-src"));
      card.append(info);
      if (data.canManage) {
        const actions = element("div", undefined, "ws-row-actions");
        actions.append(button("삭제", async () => {
          if (!confirm(ax.name + " 공리를 삭제할까요?")) return;
          try { await api("axioms/delete", { name: ax.name }); await refreshAxiomDialog(); }
          catch (error) { alertIn("axiom-error", error.message); }
        }, "quiet danger"));
        card.append(actions);
      }
      return card;
    }));
  }
}

$("axioms-open").onclick = async () => {
  try { await refreshAxiomDialog(); if (!$("axiom-dialog").open) $("axiom-dialog").showModal(); }
  catch (error) { status(error.message, true); }
};
$("axiom-dialog-close").onclick = () => $("axiom-dialog").close();
$("axiom-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("axiom-error");
  $("axiom-submit").disabled = true;
  try { await api("axioms", { source: $("axiom-source").value }); $("axiom-source").value = ""; await refreshAxiomDialog(); }
  catch (error) { alertIn("axiom-error", error.message); }
  finally { $("axiom-submit").disabled = false; }
};

/* ================= EXPLORER ICONS, HOVER ACTIONS & CONTEXT MENU ================= */
const basename = (path) => path.split("/").at(-1);
const dirname = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const join = (directory, name) => (directory === "/" ? "" : directory) + "/" + name;
const isNotebook = (path) => path.endsWith(".ipynb");
const activeTab = () => tabs.get(active);

function vmStatus(kind, message) {
  const node = $("vm-state");
  node.className = kind;
  node.replaceChildren(element("i", undefined, "dot"), document.createTextNode(message));
}

function createFileSvgIcon(path, type) {
  return QNBFileIcons.create(path, type);
}

function hideContextMenu() {
  const menu = $("explorer-context-menu");
  if (menu) {
    menu.hidden = true;
    menu.replaceChildren();
  }
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });

function openContextMenu(event, targetPath, type) {
  event.preventDefault();
  event.stopPropagation();
  const menu = $("explorer-context-menu");
  if (!menu) return;
  const items = [];
  if (type === "directory") {
    items.push(button("폴더 열기", () => { hideContextMenu(); showFolder(targetPath); }));
    items.push(button("여기에 새 파일", () => { hideContextMenu(); editEntry("file", targetPath); }));
    items.push(button("여기에 새 노트북", () => { hideContextMenu(); editEntry("notebook", targetPath); }));
    items.push(button("여기에 새 폴더", () => { hideContextMenu(); editEntry("folder", targetPath); }));
  } else {
    items.push(button("파일 열기", () => { hideContextMenu(); openFile(targetPath); }));
  }
  if (targetPath !== "/") {
    items.push(document.createElement("hr"));
    items.push(button("이름 변경", () => { hideContextMenu(); editEntry("manage", targetPath); }));
    items.push(button("삭제", () => { hideContextMenu(); editEntry("delete", targetPath); }, "danger"));
  }
  menu.replaceChildren(...items);
  menu.hidden = false;
  const x = Math.min(window.innerWidth - 200, event.clientX);
  const y = Math.min(window.innerHeight - 240, event.clientY);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

function renderEntries() {
  $("folder-path").textContent = "/workspace" + (folder === "/" ? "" : folder);
  $("folder-path").title = $("folder-path").textContent;
  $("parent").disabled = folder === "/";
  $("folder-menu").disabled = folder === "/" || busy;
  $("more-files").hidden = cursor === null;

  const sorted = [...entries].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] === "directory" ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });

  const rows = sorted.map(([name, type]) => {
    const path = join(folder, name);
    const row = element("div", undefined, "file-row" + (active === path && !graphVisible ? " active" : ""));
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.title = path;

    const openAction = () => (type === "directory" ? showFolder(path) : openFile(path));
    row.addEventListener("click", openAction);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAction(); }
    });
    row.addEventListener("contextmenu", (e) => openContextMenu(e, path, type));

    const actions = element("span", undefined, "file-row-actions");
    if (type === "directory") {
      const addBtn = button("+", (e) => { e.stopPropagation(); editEntry("file", path); }, "file-row-btn", "폴더 안에 새 파일");
      actions.append(addBtn);
    }
    const renBtn = button("✎", (e) => { e.stopPropagation(); editEntry("manage", path); }, "file-row-btn", "이름 변경");
    const delBtn = button("✕", (e) => { e.stopPropagation(); editEntry("delete", path); }, "file-row-btn danger-btn", "삭제");
    actions.append(renBtn, delBtn);

    row.append(
      createFileSvgIcon(path, type),
      element("span", name, "file-name"),
    );
    row.dataset.path = path;
    row.dataset.type = type;
    window.QNBGit?.decorate(row, path, type);
    window.QNBUploads?.decorate(row, path);
    if (stagedFilesState.has(path)) {
      const dot = element("span", undefined, "file-stage-dot");
      dot.title = stagedFilesState.get(path).dirty ? "스테이징됨 (미저장 변경 있음)" : "스테이징됨 (실시간 협업 중)";
      row.append(dot);
    }
    row.append(actions);
    return row;
  });

  rows.push(...(window.QNBUploads?.virtualRows(folder, new Set(sorted.map(([n]) => join(folder, n)))) || []));
  if (!rows.length) rows.push(element("div", "이 폴더가 비어 있습니다.", "notice"));
  $("file-list").replaceChildren(...rows);
}

async function showFolder(path, append = false) {
  const request = ++listRequest;
  listing = true;
  status(append ? "파일을 불러오는 중…" : "VM에서 폴더를 읽는 중…");
  try {
    const result = await vmRequest("workspace", { operation: "list", path, cursor: append ? cursor : 0 });
    if (request !== listRequest) return;
    folder = path;
    entries = append ? entries.concat(result.entries) : result.entries;
    cursor = result.cursor;
    vmStatus("ready", "VM 연결됨");
    renderEntries();
    status("");
    window.QNBGit?.refresh();
  } catch (error) {
    if (request !== listRequest) return;
    if (error.status === 403 && currentSession.workspace?.shared) {
      status(error.message + " 내 워크스페이스로 복귀합니다.", true);
      recoverRevokedWorkspace();
      return;
    }
    if (!entries.length) $("file-list").replaceChildren(element("div", "파일을 불러올 수 없습니다.", "notice"));
    vmStatus("error", "VM 파일 조회 실패");
    status(error.message, true);
  } finally {
    if (request === listRequest) listing = false;
  }
}

// Preserved for terminal.js post-command explorer refresh
async function syncWorkspace() {
  if (document.hidden || busy || listing) return;
  await showFolder(folder);
}

function showFileSyncNotice(tab) {
  const message = tab?.remoteChange;
  $("file-sync-notice").hidden = !message;
  $("file-sync-message").textContent = message || "";
  $("reload-file").disabled = busy;
}

async function openFile(path) {
  if (!tabs.has(path) && window.QNBFileIcons?.previewKind(path)) {
    await window.QNBPreview.open(path);
    return;
  }
  if (!tabs.has(path)) {
    status("스테이징 영역에서 파일을 여는 중…");
    try {
      const data = await collabRequest("stage_open", { path });
      if (!tabs.has(path)) {
        const collabSession = data.docBase64
          ? QNBEditing.CollabSession.fromBase64(data.docBase64)
          : QNBEditing.CollabSession.create(data.fileId || path, data.text || "");
        tabs.set(path, {
          path,
          text: data.text,
          fileId: data.fileId,
          etag: data.etag,
          resourceId: data.resourceId,
          chunked: data.chunked === true,
          dirty: Boolean(data.dirty),
          collaborators: data.collaborators || [],
          collabSession,
          jsonMode: false,
          feedback: new Map(),
        });
      }
      status("");
    } catch (error) {
      status(error.message, true);
      return;
    }
  }
  selectFile(path);
}

function selectFile(path) {
  graphVisible = false;
  active = path;
  renderWorkbench();
  renderEntries();
}

async function closeFile(path, force = false) {
  if (busy && !force) return;
  const tab = tabs.get(path);
  if (!tab) return;
  if (tab.preview) {
    URL.revokeObjectURL(tab.preview.url);
    tabs.delete(path);
    if (active === path) active = [...tabs.keys()].at(-1) || null;
    renderWorkbench();
    renderEntries();
    return;
  }
  clearTimeout(tab.editDebounce);
  tab.editDebounce = null;
  await flushLocalEdit(tab).catch(() => {});
  tabs.delete(path);
  if (active === path) active = [...tabs.keys()].at(-1) || null;
  renderWorkbench();
  renderEntries();
  collabRequest("stage_close", { path }).then((res) => {
    if (res?.autoSaved && !force) {
      status(`${basename(path)}: 작업자 0명 → 자동 저장 및 스테이징 정리됨.`);
    }
  }).catch(() => {});
}

function renderTabs() {
  const items = [...tabs.values()].map((tab) => {
    const selected = tab.path === active && !graphVisible;
    const wrapper = element("div", undefined, "tab" + (selected ? " active" : ""));
    const collabCnt = (tab.collaborators || []).length;
    const badge = collabCnt > 1 ? ` (${collabCnt})` : "";
    const select = button(basename(tab.path) + (tab.dirty ? " ●" : "") + badge, () => selectFile(tab.path));
    select.title = tab.path;
    select.setAttribute("aria-pressed", selected);
    const close = button("×", () => closeFile(tab.path), "", basename(tab.path) + " 닫기");
    close.disabled = busy;
    wrapper.append(select, close);
    return wrapper;
  });
  if (graphVisible) {
    const wrapper = element("div", undefined, "tab active");
    const label = graphMode === "code" ? "코드 의존성" : graphMode === "planner" ? "일정 · 프로젝트" : "증명 트리 DAG";
    wrapper.append(
      button(label, () => graphMode === "code" ? showCodeGraph() : graphMode === "planner" ? showPlanner() : showGraph(graphPage)),
      button("×", () => selectFile(active), "", label + " 닫기"),
    );
    items.push(wrapper);
  }
  $("tabs").replaceChildren(...items);
}

async function flushLocalEdit(tab) {
  if (!tab || !tab.collabSession) return;
  const text = serialize(tab);
  const delta = tab.collabSession.applyLocalText(text);
  if (!delta.changed) return;
  const res = await collabRequest("stage_edit", {
    path: tab.path,
    changesBase64: delta.changesBase64,
    docBase64: delta.docBase64,
  });
  if (typeof res?.text === "string" && res.text !== tab.text) {
    tab.text = res.text;
  }
  if (typeof res?.dirty === "boolean") {
    tab.dirty = res.dirty;
    renderTabs();
  }
}

function scheduleEditSync(tab) {
  if (!tab) return;
  clearTimeout(tab.editDebounce);
  tab.editDebounce = setTimeout(() => {
    tab.editDebounce = null;
    flushLocalEdit(tab).catch((err) => {
      if (activeTab() === tab) status("실시간 동기화 오류: " + err.message, true);
    });
  }, 60);
}

function markDirty(tab) {
  tab.editVersion = (tab.editVersion || 0) + 1;
  if (!tab.dirty) {
    tab.dirty = true;
    renderTabs();
  }
  if (activeTab() === tab && !graphVisible) {
    $("editor-mode").textContent = "미저장 (스테이징)";
  }
  scheduleEditSync(tab);
}

const editors = new Map();
const editingMarkdown = new WeakSet();

function mountEditor(key, host, options) {
  const fullOptions = { ...options, theme: currentTheme() };
  let editor = editors.get(key);
  if (editor) editor.update(fullOptions);
  else {
    editor = new QNBEditing.CodeEditor(fullOptions);
    editors.set(key, editor);
  }
  if (editor.view.dom.parentNode !== host) host.replaceChildren(editor.view.dom);
  return editor.view;
}

function retainEditors(keys) {
  for (const [key, editor] of editors) {
    if (keys.has(key)) continue;
    editor.view.destroy();
    editor.view.dom.remove();
    editors.delete(key);
  }
}

function fileLanguage(path) {
  return {
    lean: "lean4", cat: "category", py: "python", md: "markdown", markdown: "markdown", json: "json",
    ipynb: "json", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    cpp: "cpp", cc: "cpp", cxx: "cpp", "c++": "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", h: "cpp", c: "cpp",
    java: "java", html: "html", htm: "html", tex: "latex", ltx: "latex", plot: "plot",
  }[path.split(".").at(-1).toLowerCase()] || "";
}

/* Language used by "실행 · 시각화": C/C++ headers and plain C files are not runnable programs. */
function runLanguage(path) {
  const ext = path.split(".").at(-1).toLowerCase();
  if (["cpp", "cc", "cxx", "c++"].includes(ext)) return "cpp";
  const language = fileLanguage(path);
  return ["lean4", "python", "java", "category", "plot"].includes(language) ? language : "";
}

const RENDERABLE = { markdown: "Markdown", html: "HTML", latex: "LaTeX" };

function renderFilePreview(tab, target, text) {
  const language = fileLanguage(tab.path);
  if (language === "markdown") QNBEditing.renderMarkdown(target, text, markdownOptions(tab.path));
  else if (language === "latex") QNBEditing.renderLatexDocument(target, text);
  else if (language === "html") window.QNBPreview?.renderHtml(target, text, tab.path);
}

function markdownOptions(path) {
  return { resolveImage: (image, src) => window.QNBPreview?.resolveMarkdownImage(image, src, path) };
}

function renderPlainFile(tab, minimalDiff = false) {
  retainEditors(new Set([tab]));
  const language = fileLanguage(tab.path);
  const preview = $("file-markdown");
  const previewButton = $("markdown-file-preview");
  const runButton = $("run-file-viz");
  const canRun = Boolean(runLanguage(tab.path));
  const markdownFile = Boolean(RENDERABLE[language]);
  if (runButton) {
    const fileRunning = runningFiles.has(tab.path);
    runButton.hidden = !canRun;
    runButton.disabled = busy || fileRunning;
    runButton.textContent = fileRunning ? "⏳ 실행 중…" : "▶ 실행 · 시각화";
  }
  previewButton.hidden = !markdownFile;
  previewButton.setAttribute("aria-pressed", markdownFile && tab.markdownPreview !== false);
  preview.hidden = !markdownFile || tab.markdownPreview === false;
  if ($("preview-resizer")) $("preview-resizer").hidden = preview.hidden;
  preview.dataset.kind = language;
  previewButton.textContent = markdownFile ? `${RENDERABLE[language]} 미리 보기` : "미리 보기";
  if (!preview.hidden) renderFilePreview(tab, preview, tab.text);
  renderPlainOutput(tab);
  // .plot files draw live in the 좌표계 pane; opening one brings the pane forward.
  if (language === "plot") window.QNBVisualizer?.showPlot(tab.text, { path: tab.path }, { focus: !minimalDiff });
  mountEditor(tab, $("file-content"), {
    text: tab.text, language, label: "파일 내용", readOnly: busy, minimalDiff,
    onChange(text) {
      tab.text = text;
      tab.notebook = null;
      markDirty(tab);
      if (!preview.hidden) {
        clearTimeout(tab.previewTimer);
        tab.previewTimer = setTimeout(() => renderFilePreview(tab, preview, tab.text), language === "markdown" ? 0 : 250);
      }
      if (language === "plot") {
        clearTimeout(tab.plotTimer);
        tab.plotTimer = setTimeout(() => window.QNBVisualizer?.showPlot(tab.text, { path: tab.path }, { focus: false }), 120);
      }
    },
    onRun() {
      if (!canRun || busy || runningFiles.has(tab.path)) return false;
      runPlainFile(tab.path);
      return true;
    },
    onCursorLine(line, col, isUserClick) {
      if (language === "lean4") window.QNBVisualizer?.syncLeanCursor(tab.path, null, line, col, isUserClick);
      else if (language === "category") window.QNBVisualizer?.syncCategoryCursor(tab.path, null, line, col, isUserClick);
      else if (["python", "cpp", "java"].includes(language)) window.QNBVisualizer?.syncCodeCursor(tab.path, null, line, col, isUserClick);
      else if (language === "plot") window.QNBVisualizer?.syncPlotCursor(tab.path, line);
      collabRequest("cursor", { path: tab.path, cursorLine: line }).catch(() => {});
    },
  });
}

function renderPlainOutput(tab) {
  const panel = $("plain-output");
  if (!panel) return;
  const result = tab?.plainResult;
  if (!result) { panel.hidden = true; return; }
  panel.hidden = false;
  const statusEl = $("plain-output-status");
  const ok = result.exitCode === 0;
  statusEl.textContent = ok ? "✓ 실행 · 시각화 완료" : "✕ 실행 실패";
  statusEl.classList.toggle("failed", !ok);
  const text = (result.outputs || []).map((item) => item.text ?? item.evalue ?? "").filter(Boolean).join("\n").trim();
  $("plain-output-body").textContent = text || (ok ? "(출력 없음)" : "오류가 발생했습니다.");
}

$("plain-output-close")?.addEventListener("click", () => {
  const tab = activeTab();
  if (tab) tab.plainResult = null;
  $("plain-output").hidden = true;
});

const runningFiles = new Set();
const runningCells = new WeakSet();
const activeParallelJobs = new Map();
let nextParallelJobId = 1;

function beginParallelJob(label) {
  const id = nextParallelJobId++;
  activeParallelJobs.set(id, label);
  window.QNBVisualizer?.setParallelJobs([...activeParallelJobs.values()]);
  return id;
}

function endParallelJob(id) {
  activeParallelJobs.delete(id);
  window.QNBVisualizer?.setParallelJobs([...activeParallelJobs.values()]);
}

function updateRunButtonState() {
  const tab = activeTab();
  const runButton = $("run-file-viz");
  if (!tab || !runButton) return;
  const fileRunning = runningFiles.has(tab.path);
  runButton.disabled = busy || fileRunning;
  runButton.textContent = fileRunning ? "⏳ 실행 중…" : "▶ 실행 · 시각화";
}

async function runPlainFile(targetPath = active) {
  const tab = tabs.get(targetPath);
  if (!tab) return;
  const language = runLanguage(tab.path);
  if (!language || runningFiles.has(tab.path)) return;
  if (language === "plot") {
    // Plots are evaluated in the browser; "run" just redraws and shows the pane.
    window.QNBVisualizer?.showPlot(tab.text, { path: tab.path });
    status("좌표계를 다시 그렸습니다.");
    return;
  }
  runningFiles.add(tab.path);
  updateRunButtonState();
  const jobId = beginParallelJob(`${tab.path.split("/").pop()} (${language})`);
  try {
    status(`${tab.path.split("/").pop()} 병렬 실행 및 시각화 중…`);
    const result = await api("visualize", { path: tab.path, language, code: tab.text });
    tab.plainResult = result;
    if (activeTab() === tab && !graphVisible) renderPlainOutput(tab);
    if (result.visualization) {
      window.QNBVisualizer?.showExecutionResult(result.visualization, { path: tab.path, cell: null });
    }
    status(result.exitCode === 0 ? "실행과 시각화를 완료했습니다." : "실행 중 오류가 발생했습니다.", result.exitCode !== 0);
  } catch (error) {
    status(error.message, true);
  } finally {
    runningFiles.delete(tab.path);
    endParallelJob(jobId);
    updateRunButtonState();
  }
}

$("run-file-viz")?.addEventListener("click", () => active && runPlainFile(active));
$("markdown-file-preview").onclick = () => {
  const tab = activeTab();
  if (!tab) return;
  tab.markdownPreview = tab.markdownPreview === false;
  renderPlainFile(tab);
};

function readNotebook(tab) {
  if (tab.notebook) return tab.notebook;
  const doc = JSON.parse(tab.text);
  if (!doc || doc.nbformat !== 4 || !Array.isArray(doc.cells) ||
      doc.cells.some((cell) => !cell || typeof cell !== "object" || Array.isArray(cell))) {
    throw new Error("nbformat 4 노트북을 열 수 없습니다.");
  }
  tab.notebook = doc;
  return doc;
}
function serialize(tab) {
  if (tab.notebook && !tab.jsonMode) tab.text = JSON.stringify(tab.notebook, null, 1) + "\n";
  return tab.text;
}
function cellId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
}
function newCell(type, language, source = "") {
  const cell = { id: cellId(), cell_type: type, metadata: {}, source };
  if (type === "code") { cell.metadata.qnb_language = language; cell.execution_count = null; cell.outputs = []; }
  return cell;
}
function newNotebook() {
  return {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { name: "lean4", display_name: "Lean 4", language: "lean4" } },
    cells: [
      newCell("markdown", null, "# 병렬 증명 노트북\n\n각 **Lean 4 셀**은 독립적으로 실행되며 검증된 정리만 DB에 저장됩니다. 저장(`Ctrl+S`)은 명시적으로 수행됩니다."),
      newCell("code", "lean4", "theorem base_refl (n : Nat) : n = n := by\n  rfl"),
      newCell("code", "lean4", "theorem derived_pair (n : Nat) : n = n ∧ True :=\n  ⟨base_refl n, True.intro⟩"),
    ],
  };
}
function sourceOf(cell) {
  if (Array.isArray(cell.source)) return cell.source.join("");
  return typeof cell.source === "string" ? cell.source : "";
}
function cellLanguage(doc, cell) {
  const explicit = cell.metadata?.qnb_language;
  if (["lean4", "python", "cpp", "java", "category"].includes(explicit)) return explicit;
  const firstLine = sourceOf(cell).split("\n", 1)[0].trim();
  if (/^%%lean4(?:\s|$)/.test(firstLine)) return "lean4";
  if (/^%%(?:category|cat)(?:\s|$)/.test(firstLine)) return "category";
  if (firstLine === "%%cpp" || firstLine === "%%c++") return "cpp";
  if (firstLine === "%%java") return "java";
  const kernel = String(doc.metadata?.kernelspec?.name || "python3").toLowerCase();
  if (["lean", "lean4"].includes(kernel)) return "lean4";
  if (["category", "cat"].includes(kernel)) return "category";
  if (["cpp", "c++"].includes(kernel)) return "cpp";
  if (kernel === "java") return "java";
  return kernel.startsWith("python") ? "python" : "";
}

function renderWorkbench() {
  const tab = activeTab();
  renderTabs();
  const proofVisible = graphVisible && graphMode === "proof";
  const codeVisible = graphVisible && graphMode === "code";
  const plannerVisible = graphVisible && graphMode === "planner";
  $("view-planner")?.classList.toggle("active", plannerVisible);
  if ($("planner")) $("planner").hidden = !plannerVisible;
  $("view-editor")?.classList.toggle("active", !graphVisible);
  $("view-graph")?.classList.toggle("active", proofVisible);
  $("view-code")?.classList.toggle("active", codeVisible);
  $("graph-open")?.classList.toggle("active", proofVisible);
  $("code-graph-open")?.classList.toggle("active", codeVisible);
  $("graph").hidden = !proofVisible;
  $("codegraph").hidden = !codeVisible;
  if ($("workbench-split")) $("workbench-split").hidden = graphVisible;
  $("workspace-welcome").hidden = graphVisible || Boolean(tab);
  $("editor").hidden = graphVisible || !tab;
  $("editor-mode").textContent = "";
  showFileSyncNotice(tab);
  renderActiveCollabBanner(tab);
  if (!tab || graphVisible) {
    if (!tab) retainEditors(new Set());
    return;
  }
  $("file-path").textContent = tab.path;
  $("file-path").title = tab.path;
  $("save").disabled = busy;
  $("file-menu").disabled = busy;
  $("file-preview").hidden = !tab.preview;
  $("save").hidden = Boolean(tab.preview);
  if (tab.preview) {
    retainEditors(new Set());
    $("plain-editor").hidden = true;
    $("notebook").hidden = true;
    $("json-return").hidden = true;
    $("plain-output").hidden = true;
    $("markdown-file-preview").hidden = true;
    $("run-file-viz").hidden = true;
    $("editor-mode").textContent = tab.preview.label;
    window.QNBPreview.render(tab);
    return;
  }
  const notebookVisible = isNotebook(tab.path) && !tab.jsonMode;
  $("plain-editor").hidden = notebookVisible;
  $("notebook").hidden = !notebookVisible;
  $("json-return").hidden = !(isNotebook(tab.path) && tab.jsonMode);
  $("editor-mode").textContent = tab.dirty ? "미저장 (스테이징)" : notebookVisible ? "Jupyter Notebook" : "UTF-8 · 저장됨";
  if (notebookVisible) {
    $("markdown-file-preview").hidden = true;
    renderNotebook(tab);
  } else {
    renderPlainFile(tab);
  }
}

async function saveTab(tab) {
  if (tab.savingPromise) await tab.savingPromise.catch(() => {});
  const run = (async () => {
    clearTimeout(tab.editDebounce);
    tab.editDebounce = null;
    await flushLocalEdit(tab);
    const result = await collabRequest("stage_save", { path: tab.path });
    tab.etag = result.etag || tab.etag;
    tab.fileId = result.fileId || tab.fileId;
    tab.resourceId = result.resourceId || tab.resourceId;
    tab.chunked = result.chunked === true;
    tab.dirty = false;
    tab.remoteChange = null;
    renderTabs();
    renderEntries();
    if (activeTab() === tab && !graphVisible) {
      $("editor-mode").textContent = "저장됨";
      showFileSyncNotice(tab);
    }
  })();
  tab.savingPromise = run;
  try { await run; }
  finally { if (tab.savingPromise === run) tab.savingPromise = null; }
}

function setBusy(value) {
  busy = value;
  $("create-file").disabled = value;
  $("create-folder").disabled = value;
  $("sidebar-new-notebook").disabled = value;
  $("folder-menu").disabled = value || folder === "/";
  $("new-notebook").disabled = value;
  $("welcome-new-file").disabled = value;
  $("logout").disabled = value;
  renderWorkbench();
}

async function runTask(task) {
  if (busy) return;
  setBusy(true);
  try { await task(); }
  catch (error) { status(error.message, true); }
  finally { setBusy(false); }
}

function saveActive() {
  if (!activeTab() || graphVisible || activeTab().preview) return;
  const tab = activeTab();
  runTask(async () => {
    await saveTab(tab);
    status("VM 파일시스템에 저장했습니다.");
  });
}

$("save").onclick = saveActive;
$("reload-file").onclick = () => {
  const tab = activeTab();
  if (!tab) return;
  runTask(async () => {
    const data = await collabRequest("stage_open", { path: tab.path });
    tab.text = data.text;
    tab.etag = data.etag;
    tab.fileId = data.fileId;
    tab.resourceId = data.resourceId;
    tab.dirty = Boolean(data.dirty);
    tab.notebook = null;
    tab.remoteChange = null;
    if (data.docBase64) tab.collabSession = QNBEditing.CollabSession.fromBase64(data.docBase64);
    renderWorkbench();
  });
};

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && activeTab() &&
      !graphVisible && !$("file-dialog").open) {
    event.preventDefault();
    saveActive();
  }
});
$("refresh-files").onclick = () => showFolder(folder);
$("parent").onclick = () => showFolder(dirname(folder));
$("more-files").onclick = () => showFolder(folder, true);

function editEntry(action, path = folder) {
  fileAction = { action, path };
  const labels = { file: "새 파일", folder: "새 폴더", notebook: "새 노트북", manage: "이름 변경 또는 삭제", delete: "삭제 확인" };
  $("dialog-title").textContent = labels[action];
  $("dialog-description").textContent = "/workspace" + (path === "/" ? "" : path);
  if (action === "delete") $("dialog-description").textContent += " 항목(하위 폴더/파일 포함)을 삭제합니다.";
  $("entry-name").value = action === "manage" ? basename(path) : action === "notebook" ? "proofs.ipynb" : "";
  $("entry-name").placeholder = action === "file" ? "예: Main.lean 또는 notes.md" : "";
  $("name-label").hidden = action === "delete";
  $("dialog-delete").hidden = action !== "manage";
  $("dialog-submit").textContent = action === "manage" ? "이름 변경" : action === "delete" ? "삭제" : "만들기";
  $("dialog-submit").className = action === "delete" ? "danger" : "primary";
  alertIn("file-error");
  if (!$("file-dialog").open) $("file-dialog").showModal();
  if (action !== "delete") $("entry-name").select();
}

$("create-file").onclick = () => editEntry("file");
$("welcome-new-file").onclick = () => editEntry("file");
$("create-folder").onclick = () => editEntry("folder");
$("new-notebook").onclick = () => editEntry("notebook");
$("sidebar-new-notebook").onclick = () => editEntry("notebook");
$("file-menu").onclick = () => active && editEntry("manage", active);
$("folder-menu").onclick = () => editEntry("manage", folder);
$("dialog-close").onclick = () => $("file-dialog").close();
$("dialog-delete").onclick = () => editEntry("delete", fileAction.path);

$("file-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const { action, path } = fileAction;
  const name = $("entry-name").value.trim();
  if (action !== "delete" && (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..")) {
    alertIn("file-error", "올바른 파일 또는 폴더 이름을 입력하세요.");
    return;
  }
  setBusy(true);
  $("dialog-submit").disabled = true;
  alertIn("file-error");
  try {
    if (action === "manage" || action === "delete") {
      const target = join(dirname(path), name);
      if (action === "delete" || target !== path) {
        const operation = action === "delete" ? "delete" : "rename";
        await collabRequest("fs_mutate", { operation, path, target, recursive: true });
        for (const [opened, tab] of [...tabs]) {
          if (opened !== path && !opened.startsWith(path + "/")) continue;
          tabs.delete(opened);
          if (operation === "rename") {
            tab.path = target + opened.slice(path.length);
            tabs.set(tab.path, tab);
          }
          if (active === opened) active = operation === "rename" ? tab.path : null;
        }
        if (folder === path || folder.startsWith(path + "/")) {
          folder = operation === "rename" ? target + folder.slice(path.length) : dirname(path);
        }
      }
      await showFolder(folder);
    } else {
      const filename = action === "notebook" && !isNotebook(name) ? name + ".ipynb" : name;
      const newPath = join(path, filename);
      if (action === "folder") {
        await collabRequest("fs_mutate", { operation: "mkdir", path: newPath });
      } else {
        const text = isNotebook(newPath) ? JSON.stringify(newNotebook(), null, 1) + "\n" : "";
        await collabRequest("fs_mutate", { operation: "write", path: newPath, text, create: true });
      }
      await showFolder(path === folder ? path : folder);
      if (action !== "folder") await openFile(newPath);
    }
    $("file-dialog").close();
  } catch (error) {
    alertIn("file-error", error.message);
  } finally {
    setBusy(false);
    $("dialog-submit").disabled = false;
  }
};

const jsonReturn = button("셀 보기", () => {
  const tab = activeTab();
  tab.jsonMode = false;
  renderWorkbench();
}, "quiet");
jsonReturn.id = "json-return";
jsonReturn.hidden = true;
$("file-menu").before(jsonReturn);
$("edit-json").onclick = () => {
  const tab = activeTab();
  serialize(tab);
  tab.jsonMode = true;
  renderWorkbench();
};

function imageOutputSource(data) {
  for (const mime of ["image/png", "image/jpeg", "image/svg+xml"]) {
    const value = data[mime];
    const text = Array.isArray(value) && value.every((line) => typeof line === "string") ? value.join("") : value;
    if (typeof text !== "string" || !text.trim()) continue;
    if (mime === "image/svg+xml") {
      const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      if (svg.localName === "svg" && svg.namespaceURI === "http://www.w3.org/2000/svg") {
        return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
      }
      continue;
    }
    const encoded = text.replace(/\s/g, "");
    if (/^[a-z0-9+/]+={0,2}$/i.test(encoded) && encoded.length % 4 === 0) {
      return "data:" + mime + ";base64," + encoded;
    }
  }
  return null;
}

function renderOutput(cell, feedback) {
  const output = element("div", undefined, "output");
  if (feedback) {
    const statusRow = element("div", undefined, "output-status-row");
    let label = feedback.exitCode === 0 ? "✓ 실행 성공" : "✕ 실행 실패";
    if (feedback.error) label += " · " + feedback.error;
    statusRow.append(element("span", label, "output-status" + (feedback.exitCode === 0 ? "" : " failed")));
    if (feedback.saved?.length) {
      const savedGroup = element("div", undefined, "saved-theorems");
      savedGroup.append(element("span", "DB 저장", "saved-label"));
      for (const name of feedback.saved) {
        savedGroup.append(button(name, () => showGraph(0, null, name), "saved-chip", name + " 증명 트리 보기"));
      }
      savedGroup.append(button("증명 트리 →", () => showGraph(0, null, feedback.saved[0]), "quiet saved-tree-link"));
      statusRow.append(savedGroup);
    }
    if (feedback.visualization) {
      statusRow.append(button("🔍 시각화 보기", () => {
        window.QNBVisualizer?.showExecutionResult(feedback.visualization, { path: active, cell });
      }, "quiet saved-tree-link"));
    }
    output.append(statusRow);
  }
  if (feedback?.truncated) output.append(element("div", "셀 출력이 크기 제한을 초과해 일부 생략됐습니다.", "notice"));
  const items = feedback?.outputs || cell.outputs;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const data = item.data || {};
      const image = imageOutputSource(data);
      if (image) {
        const preview = element("img"); preview.alt = "셀 실행 결과"; preview.src = image; output.append(preview);
        continue;
      }
      const raw = item.text ?? data["text/plain"] ?? item.traceback?.join?.("\n") ?? item.evalue;
      if (raw != null) {
        const text = (Array.isArray(raw) ? raw.join("") : String(raw)).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
        output.append(element("pre", text));
      }
    }
  }
  return output;
}

function renderNotebook(tab, focusCell) {
  const container = $("cells");
  const scroll = container.scrollTop;
  const focused = [...editors].find(([, editor]) => editor.view.hasFocus)?.[0];
  const used = new Set();
  let doc;
  try {
    doc = readNotebook(tab);
    alertIn("invalid-notebook");
  } catch {
    alertIn("invalid-notebook", "노트북을 열 수 없습니다. JSON 편집에서 내용을 확인하세요.");
    container.replaceChildren();
    retainEditors(used);
  }
  $("edit-json").disabled = busy;
  for (const id of ["add-code", "add-markdown", "prepare-python", "reset-python"]) $(id).disabled = busy || !doc;
  if (!doc) return;
  const cells = doc.cells.map((cell, index) => {
    const code = cell.cell_type === "code";
    const markdown = cell.cell_type === "markdown";
    const kernelLang = code ? cellLanguage(doc, cell) : "";
    const cellTypeClass = code ? " cell-code" + (kernelLang ? " kernel-" + kernelLang : "") : markdown ? " cell-markdown" : " cell-raw";
    const cellView = element("article", undefined, "cell" + cellTypeClass + (cell === tab.selectedCell ? " selected" : ""));
    const header = element("div", undefined, "cell-head");
    const activate = () => {
      if (!cellView.isConnected) return;
      tab.selectedCell = cell;
      container.querySelector(".cell.selected")?.classList.remove("selected");
      cellView.classList.add("selected");
    };
    cellView.addEventListener("focusin", activate);
    cellView.addEventListener("click", activate);
    header.append(element("span", code ? "[" + (cell.execution_count ?? " ") + "]" : markdown ? "MD" : String(index + 1), "cell-prompt"));
    const kind = element("select");
    kind.setAttribute("aria-label", (index + 1) + "번 셀 유형");
    for (const [value, text] of [["code", "코드"], ["markdown", "Markdown"], ["raw", "텍스트"]]) kind.add(new Option(text, value));
    kind.value = code || markdown ? cell.cell_type : "raw";
    kind.disabled = busy;
    kind.onchange = () => {
      cell.cell_type = kind.value;
      if (kind.value === "code") { cell.outputs = []; cell.execution_count = null; }
      else { delete cell.outputs; delete cell.execution_count; }
      if (kind.value === "markdown") editingMarkdown.add(cell);
      tab.feedback.delete(cell);
      markDirty(tab);
      renderNotebook(tab, cell);
    };
    header.append(kind);
    if (code) {
      const chooser = element("select");
      chooser.setAttribute("aria-label", (index + 1) + "번 셀 커널");
      const current = kernelLang;
      for (const [value, label] of [["", "커널 선택"], ["lean4", "Lean 4"], ["category", "Category Theory"], ["python", "Python"], ["cpp", "C++"], ["java", "Java"]]) {
        if (!value && current) continue;
        const opt = element("option", label); opt.value = value; chooser.append(opt);
      }
      chooser.value = current;
      chooser.disabled = busy;
      chooser.onchange = () => {
        const prior = sourceOf(cell);
        if (/^%%(?:lean4|cpp|c\+\+|java|python|category|cat)(?:[ \t][^\n]*)?(?:\n|$)/.test(prior)) {
          cell.source = prior.replace(/^%%(?:lean4|cpp|c\+\+|java|python|category|cat)(?:[ \t][^\n]*)?(?:\n|$)/, "");
        }
        cell.metadata = { ...(cell.metadata || {}), qnb_language: chooser.value };
        cell.outputs = []; cell.execution_count = null;
        tab.feedback.delete(cell);
        markDirty(tab);
        renderNotebook(tab, cell);
      };
      const cellRunning = runningCells.has(cell);
      const run = button(cellRunning ? "⏳ 실행 중…" : "▶ 실행", () => runCell(tab, cell, index), "primary cell-run-btn");
      run.disabled = busy || !current || cellRunning;
      header.append(chooser, run);
      if (current === "lean4") header.append(element("span", "독립 검증 · DB 저장", "cell-kernel-tag"));
      else if (current === "category") header.append(element("span", "범주 도식 · 등식 증명", "cell-kernel-tag"));
      else if (current === "cpp" || current === "java") header.append(element("span", "한 줄 디버거 시각화", "cell-kernel-tag"));
    }
    if (markdown) {
      const toggle = button(editingMarkdown.has(cell) ? "문서 보기" : "편집", () => {
        if (editingMarkdown.has(cell)) editingMarkdown.delete(cell);
        else editingMarkdown.add(cell);
        renderNotebook(tab, cell);
      }, "quiet");
      toggle.disabled = busy;
      header.append(toggle);
    }
    header.append(element("div", undefined, "spacer"));
    for (const [label, title, delta] of [["↑", "셀 위로 이동", -1], ["↓", "셀 아래로 이동", 1]]) {
      const move = button(label, () => {
        const other = index + delta;
        [doc.cells[index], doc.cells[other]] = [doc.cells[other], doc.cells[index]];
        markDirty(tab);
        renderNotebook(tab, cell);
      }, "quiet", title);
      move.disabled = busy || index + delta < 0 || index + delta >= doc.cells.length;
      header.append(move);
    }
    const remove = button("×", () => {
      if (sourceOf(cell).trim() && !confirm("이 셀을 삭제할까요?")) return;
      doc.cells.splice(index, 1);
      tab.feedback.delete(cell);
      markDirty(tab);
      renderNotebook(tab);
    }, "quiet", "셀 삭제");
    remove.disabled = busy;
    header.append(remove);
    cellView.append(header);
    const body = element("div", undefined, "cell-body");
    cellView.append(body);
    const preview = markdown ? element("div", undefined, "markdown-body") : null;
    const renderPreview = () => {
      QNBEditing.renderMarkdown(preview, sourceOf(cell), markdownOptions(tab.path));
      if (!sourceOf(cell).trim()) preview.append(element("p", "Markdown을 입력하세요. (더블클릭하여 편집)", "markdown-placeholder"));
    };
    if (markdown && !editingMarkdown.has(cell)) {
      renderPreview();
      preview.ondblclick = () => {
        if (busy || window.getSelection()?.toString()) return;
        editingMarkdown.add(cell);
        renderNotebook(tab, cell);
      };
      body.append(preview);
    } else {
      const host = element("div", undefined, "cell-editor");
      body.append(host);
      used.add(cell);
      if (markdown) { body.classList.add("markdown-split"); renderPreview(); body.append(preview); }
      mountEditor(cell, host, {
        text: sourceOf(cell),
        language: code ? kernelLang : markdown ? "markdown" : "",
        label: (index + 1) + "번 셀 소스", readOnly: busy, minimalDiff: true,
        onChange(text) {
          cell.source = text;
          markDirty(tab);
          if (preview) renderPreview();
        },
        onRun() {
          if (busy) return false;
          if (markdown) { editingMarkdown.delete(cell); renderNotebook(tab, cell); return true; }
          if (!code || !cellLanguage(doc, cell)) return false;
          runCell(tab, cell, index);
          return true;
        },
        onCursorLine(line, col, isUserClick) {
          if (code && kernelLang === "lean4") window.QNBVisualizer?.syncLeanCursor(tab.path, cell, line, col, isUserClick);
          else if (code && kernelLang === "category") window.QNBVisualizer?.syncCategoryCursor(tab.path, cell, line, col, isUserClick);
          else if (code && ["python", "cpp", "java"].includes(kernelLang)) window.QNBVisualizer?.syncCodeCursor(tab.path, cell, line, col, isUserClick);
        },
      });
    }
    if (code && (tab.feedback.has(cell) || cell.outputs?.length)) {
      cellView.append(renderOutput(cell, tab.feedback.get(cell)));
    }
    return cellView;
  });
  retainEditors(used);
  container.replaceChildren(...cells);
  container.scrollTop = scroll;
  const target = focusCell || focused;
  if (target && !busy && doc.cells.includes(target)) {
    const view = editors.get(target)?.view;
    if (view) view.focus();
    else if (focusCell) cells[doc.cells.indexOf(target)].querySelector("button")?.focus();
  }
}

function appendCell(type) {
  const tab = activeTab();
  const doc = readNotebook(tab);
  const kernel = cellLanguage(doc, { metadata: {}, source: "" });
  if (doc.nbformat_minor < 5) {
    doc.nbformat_minor = 5;
    for (const cell of doc.cells) cell.id = cellId();
  }
  const selected = doc.cells.indexOf(tab.selectedCell);
  const cell = newCell(type, kernel || "python");
  doc.cells.splice(selected < 0 ? doc.cells.length : selected + 1, 0, cell);
  tab.selectedCell = cell;
  if (type === "markdown") editingMarkdown.add(cell);
  markDirty(tab);
  renderNotebook(tab, cell);
}
$("add-code").onclick = () => appendCell("code");
$("add-markdown").onclick = () => appendCell("markdown");

async function runCell(tab, cell, index = null) {
  const doc = readNotebook(tab);
  const lang = cellLanguage(doc, cell);
  const code = sourceOf(cell);
  if (!lang || runningCells.has(cell)) return;
  const idx = index ?? doc.cells.indexOf(cell);
  runningCells.add(cell);
  const jobId = beginParallelJob(`${idx >= 0 ? (idx + 1) + "번 셀" : "셀"} (${lang})`);
  if (activeTab() === tab && !graphVisible) renderNotebook(tab);
  try {
    status("VM에서 셀을 병렬 실행하고 시각화하는 중…");
    const result = await api("kernel", {
      operation: "run", path: tab.path, language: lang, code, visualize: true,
    });
    tab.feedback.set(cell, result);
    const outputs = Array.isArray(result.outputs) ? result.outputs.filter((item) =>
      ["stream", "display_data", "execute_result", "error"].includes(item?.output_type)) : [];
    cell.outputs = outputs;
    cell.execution_count = Number.isInteger(result.executionCount) ? result.executionCount : null;
    if (new TextEncoder().encode(JSON.stringify(tab.notebook, null, 1) + "\n").length > LARGE_FILE_LIMIT) cell.outputs = [];
    markDirty(tab);
    if (result.visualization) window.QNBVisualizer?.showExecutionResult(result.visualization, { path: tab.path, cell });
    status(result.exitCode === 0 ? "셀 실행과 시각화를 완료했습니다." : result.error || "셀 실행이 실패했습니다.", result.exitCode !== 0);
  } catch (error) {
    status(error.message, true);
  } finally {
    runningCells.delete(cell);
    endParallelJob(jobId);
    if (activeTab() === tab && !graphVisible) renderNotebook(tab);
  }
}

$("run-all-cells")?.addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab || !tab.path.endsWith(".ipynb")) return;
  const doc = readNotebook(tab);
  const runnable = doc.cells
    .map((cell, index) => ({ cell, index, lang: cell.cell_type === "code" ? cellLanguage(doc, cell) : "" }))
    .filter((entry) => Boolean(entry.lang));
  if (!runnable.length) return;
  status(`코드 셀 ${runnable.length}개 병렬 실행 중…`);
  await Promise.allSettled(runnable.map((entry) => runCell(tab, entry.cell, entry.index)));
});

function pythonAction(operation) {
  const tab = activeTab();
  runTask(async () => {
    status(operation === "prepare" ? "VM의 Python 환경을 준비하는 중…" : "Python 커널을 재시작하는 중…");
    const result = await vmRequest("kernel", { path: tab.path, operation });
    if (result.exitCode === 1) throw new Error(result.error || result.output || "Python 환경 설정이 실패했습니다.");
    status(operation === "prepare" ? "Python 환경 준비가 완료되었습니다." : "Python 커널을 재시작했습니다.");
  });
}
$("prepare-python").onclick = () => pythonAction("prepare");
$("reset-python").onclick = () => pythonAction("reset");

/* ================= UPGRADED PROOF DEPENDENCY DAG ================= */
async function showGraph(page = 0, root = null, focusName = null) {
  graphVisible = true;
  graphMode = "proof";
  graphPage = page;
  selectedTheorem = null;
  graphData = { theorems: [], nodes: [], edges: [] };
  const request = ++graphRequest;
  renderWorkbench();
  renderEntries();
  $("graph-status").textContent = "저장된 증명 의존 관계를 불러오는 중…";
  $("graph-status").className = "graph-status-pill";
  $("theorem-detail").replaceChildren();
  $("theorem-list").replaceChildren();
  $("previous-graph").disabled = $("next-graph").disabled = true;
  $("graph-page").textContent = (page + 1) + " 페이지";
  drawGraph();
  try {
    const params = new URLSearchParams({ page, limit: $("graph-limit").value, depth: $("graph-depth").value });
    if (root) params.set("root", root);
    const data = await api("proof-tree?" + params);
    if (request !== graphRequest || !graphVisible || graphMode !== "proof") return;
    if (focusName && !root) {
      const target = data.theorems.find((node) => node.name === focusName);
      if (target && target.id !== data.root) return showGraph(page, target.id);
    }
    graphData = data;
    const limits = data.limitedBy.map((key) => key === "nodes" ? "노드 수" : "깊이");
    $("graph-status").textContent = data.root
      ? `${data.nodes.length}개 노드 · ${data.edges.length}개 간선` + (limits.length ? ` · ${limits.join(", ")} 제한` : "")
      : "저장된 정리가 없습니다. Lean 4 셀에서 정리를 증명하세요.";
    $("previous-graph").disabled = page === 0;
    $("next-graph").disabled = !data.hasMore;
    drawTheoremList();
    $("graph-canvas").parentElement.scrollTo(0, 0);
    if (data.root) selectTheorem(data.root);
    else drawGraph();
  } catch (error) {
    if (request !== graphRequest || !graphVisible || graphMode !== "proof") return;
    $("graph-status").textContent = error.message;
    $("graph-status").classList.add("error");
  }
}

function drawTheoremList() {
  const q = ($("theorem-search")?.value || "").trim().toLowerCase();
  const kindFilter = $("theorem-kind-filter")?.value || "all";
  let sourceList = graphData.theorems || [];
  if (kindFilter === "axiom") {
    sourceList = (graphData.nodes || []).filter((n) => n.kind === "axiom" || String(n.id).startsWith("axiom:"));
  }
  const filtered = q ? sourceList.filter((n) => n.name.toLowerCase().includes(q)) : sourceList;
  const items = filtered.map((node) => {
    const isRoot = node.id === graphData.root;
    const item = button(node.name, () => {
      if (node.kind === "axiom" || String(node.id).startsWith("axiom:")) selectTheorem(node.id);
      else showGraph(graphPage, node.id);
    }, isRoot ? "selected" : "");
    item.setAttribute("aria-pressed", isRoot);
    return item;
  });
  if (!items.length) items.push(element("p", "일치하는 정리 또는 공리가 없습니다.", "ws-empty"));
  $("theorem-list").replaceChildren(...items);
}

function collectAxiomFootprint(startId) {
  const nodeMap = new Map((graphData.nodes || []).map((n) => [n.id, n]));
  const adj = new Map();
  for (const e of graphData.edges || []) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const seen = new Set([startId]);
  const queue = [startId];
  const axioms = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of adj.get(cur) || []) {
      const n = nodeMap.get(nxt);
      if (n && (n.kind === "axiom" || String(n.id).startsWith("axiom:"))) {
        if (!axioms.some((a) => a.id === n.id)) axioms.push(n);
      }
      if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
    }
  }
  return axioms;
}

async function selectTheorem(id) {
  const node = graphData.nodes.find((item) => item.id === id);
  if (!node) return;
  selectedTheorem = id;
  drawGraph();
  const panel = $("theorem-detail");
  const names = new Map(graphData.nodes.map((item) => [item.id, item.name]));
  const outgoing = graphData.edges.filter((edge) => edge.from === id);
  const incoming = graphData.edges.filter((edge) => edge.to === id);
  const axioms = collectAxiomFootprint(id);

  const children = [element("h2", node.name)];
  if (node.hash && id !== graphData.root) {
    children.push(button("이 정리를 루트로 확장", () => showGraph(graphPage, id), "primary"));
  }
  children.push(element("p", "공리 발자국 (Axiom Footprint)"));
  const axBox = element("div", undefined, "axiom-footprint");
  if (axioms.length) {
    for (const ax of axioms) axBox.append(element("span", ax.name, "axiom-chip"));
  } else {
    axBox.append(element("span", "추가 공리 없음 (완전 구성적)", "axiom-chip clean"));
  }
  children.push(axBox);

  if (outgoing.length) {
    children.push(element("p", `의존하는 보조정리 · 공리 (${outgoing.length})`));
    const list = element("ul");
    for (const { to } of outgoing) {
      const item = element("li");
      item.append(button(names.get(to) || to, () => { selectTheorem(to); proofGraph.centerOn(to); }, "quiet"));
      list.append(item);
    }
    children.push(list);
  }
  if (incoming.length) {
    children.push(element("p", `이 항목을 참조하는 상위 정리 (${incoming.length})`));
    const list = element("ul");
    for (const { from } of incoming) {
      const item = element("li");
      item.append(button(names.get(from) || from, () => { selectTheorem(from); proofGraph.centerOn(from); }, "quiet"));
      list.append(item);
    }
    children.push(list);
  }
  if (!node.hash) {
    children.push(element("p", node.kind === "axiom" ? "Lean 표준 공리입니다." : "외부 또는 참조된 정리입니다."));
    panel.replaceChildren(...children);
    return;
  }
  const info = element("div");
  children.push(info);
  panel.replaceChildren(...children);
  const request = graphRequest;
  try {
    const thm = await api("theorem/" + id);
    if (selectedTheorem !== id || request !== graphRequest) return;
    const nodes = [element("p", "원본 경로: " + thm.path)];
    if (thm.path && thm.path.startsWith("/") && !standaloneProofPage) {
      nodes.push(button("편집기에서 파일 열기 →", () => openFile(thm.path), "quiet"));
    }
    nodes.push(element("p", "SHA-256"), element("code", thm.hash), element("pre", thm.source));
    info.replaceChildren(...nodes);
  } catch (error) {
    if (selectedTheorem === id && request === graphRequest) info.replaceChildren(element("p", error.message, "error"));
  }
}

const proofGraph = new QNBGraph.ProofGraph($("graph-canvas"), selectTheorem);
function drawGraph() { proofGraph.render(graphData, selectedTheorem); }

$("graph-layout-dag")?.addEventListener("click", () => {
  $("graph-layout-dag").classList.add("active");
  $("graph-layout-force")?.classList.remove("active");
  proofGraph.setLayoutMode("dag");
});
$("graph-layout-force")?.addEventListener("click", () => {
  $("graph-layout-force").classList.add("active");
  $("graph-layout-dag")?.classList.remove("active");
  proofGraph.setLayoutMode("force");
});
$("theorem-search")?.addEventListener("input", drawTheoremList);
$("theorem-kind-filter")?.addEventListener("change", drawTheoremList);

$("graph-zoom-in").onclick = () => proofGraph.zoom(1.25);
$("graph-zoom-out").onclick = () => proofGraph.zoom(0.8);
$("graph-fit").onclick = () => proofGraph.fit();
$("graph-open").onclick = () => showGraph();
$("welcome-graph").onclick = () => showGraph();
$("welcome-terminal").onclick = () => $("terminal-open").click();
$("refresh-graph").onclick = () => showGraph(graphPage, graphData.root);
$("graph-limits").addEventListener("submit", (event) => { event.preventDefault(); showGraph(graphPage, graphData.root); });
$("previous-graph").onclick = () => showGraph(graphPage - 1);
$("next-graph").onclick = () => showGraph(graphPage + 1);

/* ================= CODE DEPENDENCY GRAPH ================= */
const CODE_KIND_LABELS = { file: "파일", class: "클래스", function: "함수", variable: "변수" };
const CODE_LANGUAGE_LABELS = { python: "Python", lean4: "Lean 4", cpp: "C++", java: "Java" };
const CODE_EDGE_LABELS = {
  imports: ["가져오는 파일", "가져가는 파일"], calls: ["호출하는 대상", "호출하는 곳"],
  reads: ["읽는 대상", "읽는 곳"], writes: ["쓰는 대상", "쓰는 곳"],
  inherits: ["상속하는 타입", "상속받는 타입"], contains: ["포함 항목", "포함하는 곳"],
  declares: ["선언 항목", "선언 위치"],
};
let codeGraphData = null;
let codeGraphView = { nodes: [], edges: [] };
let codeGraphNodes = new Map();
let selectedCode = null;
let codeGraphRequest = 0;
let codeGraphLoading = false;
const codeGraph = new QNBGraph.CodeGraph($("code-graph-canvas"), (id) => selectCodeNode(id));

function codeFilters() {
  const checked = (name) => new Set([...document.querySelectorAll(`.code-graph-filters input[name="${name}"]:checked`)].map((input) => input.value));
  const edges = checked("edge");
  if (edges.has("contains")) edges.add("declares");
  return {
    languages: checked("language"), kinds: checked("kind"), edges,
    neighborhood: $("code-graph-neighborhood").checked,
    depth: Math.max(1, Math.min(6, Number($("code-graph-depth").value) || 2)),
  };
}

function rebuildCodeView() {
  if (!codeGraphData) { codeGraphView = { nodes: [], edges: [] }; return; }
  const filters = codeFilters();
  let nodes = codeGraphData.nodes.filter((node) => filters.kinds.has(node.kind) && filters.languages.has(node.language));
  let ids = new Set(nodes.map((node) => node.id));
  let edges = codeGraphData.edges.filter((edge) => filters.edges.has(edge.kind) && ids.has(edge.from) && ids.has(edge.to));
  if (filters.neighborhood && selectedCode && ids.has(selectedCode)) {
    const adjacent = new Map();
    for (const edge of edges) {
      if (!adjacent.has(edge.from)) adjacent.set(edge.from, []);
      if (!adjacent.has(edge.to)) adjacent.set(edge.to, []);
      adjacent.get(edge.from).push(edge.to); adjacent.get(edge.to).push(edge.from);
    }
    const keep = new Set([selectedCode]);
    let frontier = [selectedCode];
    for (let level = 0; level < filters.depth && frontier.length; level++) {
      const next = [];
      for (const id of frontier) {
        for (const other of adjacent.get(id) || []) {
          if (!keep.has(other)) { keep.add(other); next.push(other); }
        }
      }
      frontier = next;
    }
    nodes = nodes.filter((node) => keep.has(node.id));
    ids = keep;
    edges = edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  }
  codeGraphView = { nodes, edges, neighborhood: filters.neighborhood ? selectedCode : null };
}

function codeStatusText() {
  if (!codeGraphData) return "";
  const { summary = {}, fileCount, elapsed, truncated } = codeGraphData;
  const parts = [`파일 ${fileCount}`, `클래스 ${summary.class || 0}`, `함수 ${summary.function || 0}`, `변수 ${summary.variable || 0}`, `표시 ${codeGraphView.nodes.length}노드 · ${codeGraphView.edges.length}간선`];
  if (truncated) parts.push("일부 생략");
  return parts.join(" · ") + ` · ${elapsed}s`;
}
function drawCodeGraph() { codeGraph.render(codeGraphView, selectedCode); $("code-graph-status").textContent = codeStatusText(); drawCodeNodeList(); }
function refreshCodeView() { rebuildCodeView(); drawCodeGraph(); if (selectedCode) drawCodeNodeDetail(); }
function showPlanner() {
  graphVisible = true; graphMode = "planner"; renderWorkbench(); renderEntries();
  window.QNBPlanner?.show();
}

function showCodeGraph(refresh = false) {
  graphVisible = true; graphMode = "code"; renderWorkbench(); renderEntries();
  if (!codeGraphData && !codeGraphLoading) { $("code-graph-path").value = folder; analyzeCode(); }
  else if (refresh) analyzeCode();
  else { drawCodeGraph(); setTimeout(() => codeGraph.fit(), 0); }
}

async function analyzeCode() {
  let path = $("code-graph-path").value.trim() || "/";
  if (path.startsWith("/workspace")) path = path.slice("/workspace".length) || "/";
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  $("code-graph-path").value = path;
  const request = ++codeGraphRequest;
  codeGraphLoading = true;
  $("code-graph-status").textContent = "소스를 읽고 의존성을 분석하는 중…";
  $("code-graph-status").className = "graph-status-pill";
  try {
    const data = await api("code-graph?" + new URLSearchParams({ path }));
    if (request !== codeGraphRequest) return;
    codeGraphData = data;
    codeGraphNodes = new Map(data.nodes.map((node) => [node.id, node]));
    if (!codeGraphNodes.has(selectedCode)) selectedCode = null;
    rebuildCodeView();
    drawCodeGraph();
    if (!data.nodes.length) $("code-graph-status").textContent = "분석할 소스 파일이 없습니다.";
    if (selectedCode) drawCodeNodeDetail();
    else drawCodeSummary();
  } catch (error) {
    if (request !== codeGraphRequest) return;
    $("code-graph-status").textContent = error.message;
    $("code-graph-status").classList.add("error");
  } finally { if (request === codeGraphRequest) codeGraphLoading = false; }
}

function codeNodeButton(node, action, className = "") {
  const item = button("", action, "code-node " + className);
  item.title = node.path + (node.line ? ":" + node.line : "");
  item.append(element("span", CODE_KIND_LABELS[node.kind]?.[0] || "?", "code-kind kind-" + node.kind), element("span", node.kind === "file" ? node.path : node.qualname, "code-node-name"));
  return item;
}
function drawCodeNodeList() {
  const query = $("code-graph-search").value.trim().toLowerCase();
  const visible = new Set(codeGraphView.nodes.map((node) => node.id));
  if (!query) { $("code-node-list").replaceChildren(); $("code-node-list").hidden = true; return; }
  const matches = (codeGraphData?.nodes || []).filter((node) => (node.qualname + " " + node.path).toLowerCase().includes(query)).slice(0, 80);
  const items = matches.map((node) => codeNodeButton(node, () => selectCodeNode(node.id, true), (node.id === selectedCode ? "selected " : "") + (visible.has(node.id) ? "" : "filtered")));
  if (!items.length) items.push(element("p", "일치하는 노드가 없습니다.", "notice"));
  $("code-node-list").hidden = false;
  $("code-node-list").replaceChildren(...items);
}
function drawCodeSummary() {
  const panel = $("code-node-detail");
  if (!codeGraphData) return panel.replaceChildren();
  const languages = Object.entries(codeGraphData.languages).map(([l, c]) => `${CODE_LANGUAGE_LABELS[l] || l} ${c}개`).join(" · ");
  panel.replaceChildren(element("h2", "분석 요약"), element("p", `${codeGraphData.root} · ${languages || "지원 언어 파일 없음"}`), element("p", "노드를 클릭해 의존 관계를 확인하세요."));
}
function selectCodeNode(id, center = false) {
  if (!codeGraphNodes.has(id)) return;
  selectedCode = selectedCode === id && !center ? null : id;
  if ($("code-graph-neighborhood").checked) rebuildCodeView();
  drawCodeGraph();
  if (center && selectedCode) codeGraph.centerOn(selectedCode);
  if (selectedCode) drawCodeNodeDetail();
  else drawCodeSummary();
}
function drawCodeNodeDetail() {
  const node = codeGraphNodes.get(selectedCode);
  const panel = $("code-node-detail");
  if (!node) return drawCodeSummary();
  const header = element("div", undefined, "code-detail-head");
  header.append(element("span", CODE_KIND_LABELS[node.kind], "code-kind-pill kind-" + node.kind), element("span", CODE_LANGUAGE_LABELS[node.language] || "", "code-language"));
  const location = node.path + (node.line && node.kind !== "file" ? ":" + node.line : "");
  const actions = element("div", undefined, "code-detail-actions");
  actions.append(button("파일 열기", () => openCodeLocation(node.path, node.kind === "file" ? null : node.line)), button("주변만 보기", () => { $("code-graph-neighborhood").checked = true; refreshCodeView(); codeGraph.fit(); }, "quiet"), button("선택 해제", () => selectCodeNode(node.id), "quiet"));
  const children = [header, element("h2", node.kind === "file" ? node.name : node.qualname), element("p", location, "code-location"), actions];
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of codeGraphData.edges) {
    if (edge.from === node.id) { if (!outgoing.has(edge.kind)) outgoing.set(edge.kind, []); outgoing.get(edge.kind).push(edge); }
    else if (edge.to === node.id) { if (!incoming.has(edge.kind)) incoming.set(edge.kind, []); incoming.get(edge.kind).push(edge); }
  }
  const section = (map, direction) => {
    for (const kind of ["imports", "inherits", "calls", "reads", "writes", "contains", "declares"]) {
      const list = map.get(kind);
      if (!list?.length) continue;
      const items = element("ul");
      for (const edge of list.slice(0, 200)) {
        const other = codeGraphNodes.get(direction === 0 ? edge.to : edge.from);
        if (!other) continue;
        const item = element("li");
        item.append(codeNodeButton(other, () => selectCodeNode(other.id, true)));
        if (edge.count > 1) item.append(element("small", "×" + edge.count, "code-edge-count"));
        items.append(item);
      }
      children.push(element("p", CODE_EDGE_LABELS[kind][direction] + " " + list.length, "code-edge-title edge-" + kind), items);
    }
  };
  section(outgoing, 0); section(incoming, 1);
  panel.replaceChildren(...children);
}
async function openCodeLocation(path, line) {
  await openFile(path);
  const tab = tabs.get(path);
  const editor = tab && editors.get(tab);
  if (!editor || !line) return;
  const { doc } = editor.view.state;
  const position = doc.line(Math.max(1, Math.min(doc.lines, line))).from;
  editor.view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  editor.view.focus();
}

$("code-graph-form").addEventListener("submit", (event) => { event.preventDefault(); analyzeCode(); });
document.querySelector(".code-graph-filters").addEventListener("change", () => refreshCodeView());
$("code-graph-search").addEventListener("input", () => drawCodeNodeList());
$("code-graph-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("code-node-list").querySelector("button")?.click(); } });
$("code-graph-zoom-in").onclick = () => codeGraph.zoom(1.25);
$("code-graph-zoom-out").onclick = () => codeGraph.zoom(0.8);
$("code-graph-fit").onclick = () => codeGraph.fit();
$("code-graph-open").onclick = () => showCodeGraph();

window.QNBVisualizer?.init({
  api,
  runTask,
  openFile,
  openProofTree: (name) => showGraph(0, null, name || null),
  refreshExplorer: () => showFolder(folder),
  async ensureDir(dirPath) {
    const parts = dirPath.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      try { await vmRequest("workspace", { operation: "stat", path: cur }); }
      catch (err) {
        if (err.status === 404) await collabRequest("fs_mutate", { operation: "mkdir", path: cur });
        else throw err;
      }
    }
  },
  async writeOrUpdateFile(filePath, text) {
    let exists = false;
    try { await vmRequest("workspace", { operation: "stat", path: filePath }); exists = true; }
    catch (err) { if (err.status !== 404) throw err; }
    if (!exists) {
      await collabRequest("fs_mutate", { operation: "write", path: filePath, text, create: true });
    } else {
      await collabRequest("fs_mutate", { operation: "write", path: filePath, text });
    }
  },
  async openAndJump(filePath, line) {
    const norm = filePath.startsWith("/") ? filePath : "/" + filePath;
    if (graphVisible) { graphVisible = false; renderWorkbench(); renderEntries(); }
    await openCodeLocation(norm, line);
  },
  async highlightLine(filePath, cell, line, kind, scroll = false) {
    if (cell) { editors.get(cell)?.setHighlightLine(line, kind, scroll); return; }
    if (!filePath) return;
    const norm = filePath.startsWith("/") ? filePath : "/" + filePath;
    if (active !== norm || graphVisible) await openFile(norm);
    const tab = tabs.get(norm);
    if (tab) editors.get(tab)?.setHighlightLine(line, kind, scroll);
  },
  runPlainFile,
  /* Replace one line of an open file (used by the 좌표계 sliders' "save value"). */
  replaceLine(filePath, line, text) {
    const norm = filePath.startsWith("/") ? filePath : "/" + filePath;
    const tab = tabs.get(norm);
    const view = tab && editors.get(tab)?.view;
    if (!view) return false;
    const doc = view.state.doc;
    if (line < 1 || line > doc.lines) return false;
    const target = doc.line(line);
    view.dispatch({ changes: { from: target.from, to: target.to, insert: text } });
    return true;
  },
  async runFirstCodeCell(nbPath) {
    const tab = tabs.get(nbPath);
    if (!tab) return;
    const doc = readNotebook(tab);
    const idx = doc.cells.findIndex((c) => c.cell_type === "code");
    if (idx >= 0) await runCell(tab, doc.cells[idx], idx);
  },
});

function initPanelResizers() {
  const readSize = (key) => {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch { return null; }
  };
  const writeSize = (key, value) => {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(Math.round(value)));
    } catch { /* ignore storage errors */ }
  };

  function bindSplit({ handle, targetEl, cssVar, storageKey, bodyClass, compute, keyStep, onResize, invertKey }) {
    if (!handle || !targetEl) return;
    const saved = readSize(storageKey);
    if (saved != null) targetEl.style.setProperty(cssVar, `${saved}px`);

    let dragging = false;
    let latest = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("active");
      document.body.classList.add(bodyClass);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      latest = Math.round(compute(event));
      targetEl.style.setProperty(cssVar, `${latest}px`);
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("active");
      document.body.classList.remove(bodyClass);
      if (latest != null) writeSize(storageKey, latest);
      onResize?.();
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => {
      latest = null;
      targetEl.style.removeProperty(cssVar);
      writeSize(storageKey, null);
      onResize?.();
    });
    if (keyStep) {
      handle.addEventListener("keydown", (event) => {
        const isVert = bodyClass === "resizing-col";
        const dec = isVert ? (invertKey ? "ArrowRight" : "ArrowLeft") : (invertKey ? "ArrowDown" : "ArrowUp");
        const inc = isVert ? (invertKey ? "ArrowLeft" : "ArrowRight") : (invertKey ? "ArrowUp" : "ArrowDown");
        if (event.key !== dec && event.key !== inc) return;
        event.preventDefault();
        const rect = targetEl.getBoundingClientRect();
        const cur = readSize(storageKey) || keyStep.fallback(rect);
        const delta = (event.key === inc ? 1 : -1) * 24;
        const next = Math.round(keyStep.clamp(cur + delta));
        targetEl.style.setProperty(cssVar, `${next}px`);
        writeSize(storageKey, next);
        onResize?.();
      });
    }
  }

  // 1) Left Explorer Sidebar
  const ideEl = $("ide");
  bindSplit({
    handle: $("sidebar-resizer"),
    targetEl: ideEl,
    cssVar: "--sidebar-width",
    storageKey: "qnb:panel:sidebarWidth",
    bodyClass: "resizing-col",
    compute: (e) => {
      const left = ideEl.getBoundingClientRect().left;
      return Math.max(150, Math.min(Math.min(640, window.innerWidth * 0.58), e.clientX - left));
    },
    keyStep: {
      fallback: () => $("sidebar")?.getBoundingClientRect().width || 260,
      clamp: (v) => Math.max(150, Math.min(Math.min(640, window.innerWidth * 0.58), v)),
    },
    onResize: () => { if (graphVisible) setTimeout(() => (graphMode === "code" ? codeGraph : proofGraph).fit(), 40); },
  });

  // 2) Plain Editor <-> Markdown/HTML/LaTeX Preview
  const plainEditor = $("plain-editor");
  bindSplit({
    handle: $("preview-resizer"),
    targetEl: plainEditor,
    cssVar: "--preview-width",
    storageKey: "qnb:panel:previewWidth",
    bodyClass: "resizing-col",
    invertKey: true,
    compute: (e) => {
      const rect = plainEditor.getBoundingClientRect();
      return Math.max(200, Math.min(rect.width - 200, rect.right - e.clientX));
    },
    keyStep: {
      fallback: (r) => $("file-markdown")?.getBoundingClientRect().width || r.width * 0.5,
      clamp: (v) => Math.max(200, Math.min((plainEditor?.getBoundingClientRect().width || 800) - 200, v)),
    },
  });

  // 3) Plain Execution Output Panel
  const plainOutput = $("plain-output");
  bindSplit({
    handle: $("plain-output-resizer"),
    targetEl: plainOutput,
    cssVar: "--plain-output-height",
    storageKey: "qnb:panel:plainOutputHeight",
    bodyClass: "resizing-row",
    invertKey: false,
    compute: (e) => {
      const parentRect = $("editor")?.getBoundingClientRect();
      const maxH = parentRect ? parentRect.height * 0.75 : window.innerHeight * 0.6;
      const outRect = plainOutput.getBoundingClientRect();
      return Math.max(72, Math.min(maxH, outRect.bottom - e.clientY));
    },
    keyStep: {
      fallback: (r) => r.height || 192,
      clamp: (v) => Math.max(72, Math.min(($("editor")?.getBoundingClientRect().height || 600) * 0.75, v)),
    },
  });

  // 4) Code Graph & Proof Tree Inspector Split + Overall Height
  document.querySelectorAll(".graph-inspector-resizer").forEach((handle) => {
    const layout = handle.closest(".graph-layout");
    const section = handle.closest("#codegraph, #graph");
    if (!layout || !section) return;
    bindSplit({
      handle,
      targetEl: layout,
      cssVar: "--inspector-width",
      storageKey: `qnb:panel:inspector:${section.id}`,
      bodyClass: "resizing-col",
      invertKey: true,
      compute: (e) => {
        const rect = layout.getBoundingClientRect();
        return Math.max(190, Math.min(rect.width - 240, rect.right - e.clientX));
      },
      keyStep: {
        fallback: () => layout.querySelector(".graph-inspector")?.getBoundingClientRect().width || 320,
        clamp: (v) => Math.max(190, Math.min(layout.getBoundingClientRect().width - 240, v)),
      },
      onResize: () => (section.id === "codegraph" ? codeGraph : proofGraph).fit(),
    });
  });

  document.querySelectorAll(".graph-height-resizer").forEach((handle) => {
    const section = handle.closest("#codegraph, #graph");
    const layout = section?.querySelector(".graph-layout");
    if (!layout || !section) return;
    bindSplit({
      handle,
      targetEl: layout,
      cssVar: "--graph-height",
      storageKey: `qnb:panel:graphHeight:${section.id}`,
      bodyClass: "resizing-row",
      compute: (e) => {
        const top = layout.getBoundingClientRect().top;
        return Math.max(240, Math.min(window.innerHeight * 0.85, e.clientY - top));
      },
      keyStep: {
        fallback: (r) => r.height || 480,
        clamp: (v) => Math.max(240, Math.min(window.innerHeight * 0.85, v)),
      },
      onResize: () => (section.id === "codegraph" ? codeGraph : proofGraph).fit(),
    });
  });

  // 5) Channels Panel (left edge, bottom edge, bottom-left corner & inner list split)
  const channelsPanel = $("channels-panel");
  const channelsBody = channelsPanel?.querySelector(".channels-body");
  bindSplit({
    handle: $("channels-split-resizer"),
    targetEl: channelsBody,
    cssVar: "--channels-list-width",
    storageKey: "qnb:panel:channelsListWidth",
    bodyClass: "resizing-col",
    compute: (e) => {
      const rect = channelsBody.getBoundingClientRect();
      return Math.max(136, Math.min(rect.width - 200, e.clientX - rect.left));
    },
    keyStep: {
      fallback: () => channelsBody?.querySelector(".channels-list")?.getBoundingClientRect().width || 200,
      clamp: (v) => Math.max(136, Math.min((channelsBody?.getBoundingClientRect().width || 600) - 200, v)),
    },
  });
  bindSplit({
    handle: $("channels-resizer-w"),
    targetEl: channelsPanel,
    cssVar: "--channels-width",
    storageKey: "qnb:panel:channelsWidth",
    bodyClass: "resizing-col",
    compute: (e) => {
      const rect = channelsPanel.getBoundingClientRect();
      return Math.max(336, Math.min(window.innerWidth - 24, rect.right - e.clientX));
    },
  });
  bindSplit({
    handle: $("channels-resizer-s"),
    targetEl: channelsPanel,
    cssVar: "--channels-height",
    storageKey: "qnb:panel:channelsHeight",
    bodyClass: "resizing-row",
    compute: (e) => {
      const rect = channelsPanel.getBoundingClientRect();
      return Math.max(256, Math.min(window.innerHeight - rect.top - 16, e.clientY - rect.top));
    },
  });
  const corner = $("channels-resizer-sw");
  if (corner && channelsPanel) {
    let dragging = false;
    let lastW = null;
    let lastH = null;
    corner.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      corner.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-nwse");
    });
    corner.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const rect = channelsPanel.getBoundingClientRect();
      lastW = Math.round(Math.max(336, Math.min(window.innerWidth - 24, rect.right - event.clientX)));
      lastH = Math.round(Math.max(256, Math.min(window.innerHeight - rect.top - 16, event.clientY - rect.top)));
      channelsPanel.style.setProperty("--channels-width", `${lastW}px`);
      channelsPanel.style.setProperty("--channels-height", `${lastH}px`);
    });
    const finishCorner = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing-nwse");
      if (lastW != null) writeSize("qnb:panel:channelsWidth", lastW);
      if (lastH != null) writeSize("qnb:panel:channelsHeight", lastH);
    };
    corner.addEventListener("pointerup", finishCorner);
    corner.addEventListener("pointercancel", finishCorner);
    corner.addEventListener("dblclick", () => {
      channelsPanel.style.removeProperty("--channels-width");
      channelsPanel.style.removeProperty("--channels-height");
      writeSize("qnb:panel:channelsWidth", null);
      writeSize("qnb:panel:channelsHeight", null);
    });
  }
}

initPanelResizers();
boot();
