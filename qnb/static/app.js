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
let folderVersion = null;
let workspaceSyncRunning = false;
let graphRequest = 0;
const standaloneProofPage = location.pathname === "/proofs";
document.body.classList.toggle("proof-page", standaloneProofPage);

const THEME_KEY = "qnb_ide_theme";

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.ideTheme = normalized;
  try {
    localStorage.setItem(THEME_KEY, normalized);
  } catch {
    // Ignore storage errors in restricted contexts.
  }
  const toggle = $("theme-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(normalized === "dark"));
    toggle.title = normalized === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환";
  }
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

function connectVM() {
  if (vmSocket?.readyState === WebSocket.OPEN) return Promise.resolve(vmSocket);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(vmSocketURL());
    const timeout = setTimeout(unavailable, 3000);
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

function vmRequest(resource, payload, upload) {
  const task = vmQueue.then(() => sendVMRequest(resource, payload, upload));
  vmQueue = task.catch(() => {});
  return task;
}

async function sendVMRequest(resource, payload, upload) {
  const socket = await connectVM();
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunks = [];
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
          return;
        }
        if (response?.result) {
          if (chunks.length) {
            chunks.push(decoder.decode());
            response.result.text = chunks.join("");
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

window.addEventListener("pagehide", () => vmSocket?.close());

function status(message, error = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", error);
}

function alertIn(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
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
    ? "개인 VM 워크스페이스와 검증 정리 데이터베이스를 즉시 배정받으세요."
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
  const isIDE = view === "ide";
  $("home").hidden = !isHome;
  $("auth-page").hidden = !isAuth;
  $("qr-approve-page").hidden = !isQrApprove;
  $("ide").hidden = !isIDE;
  $("home-nav").hidden = !isHome;
  $("ide-header-controls").hidden = !isIDE || standaloneProofPage;
  $("theme-toggle").hidden = !isIDE;

  const loggedIn = Boolean(currentSession.email);
  const displayName = currentSession.nickname
    ? currentSession.nickname + " (" + currentSession.email + ")"
    : (currentSession.email || "");
  $("account-label").textContent = displayName;
  $("account-open").hidden = !loggedIn;
  renderWorkspaceBadge();
  $("logout").hidden = !loggedIn;
  $("header-login").hidden = loggedIn || isAuth;
  $("header-signup").hidden = loggedIn || isAuth;
  $("header-ide-link").hidden = !loggedIn || isIDE;
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

function routePath() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

async function applyRoute() {
  const path = routePath();
  const loggedIn = Boolean(currentSession.email);
  const workspaceRoute = path === "/ide" || path === "/proofs";

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
        await showFolder("/");
        setInterval(syncWorkspace, 4000);
        document.addEventListener("visibilitychange", syncWorkspace);
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
  if (dirtyTabs() || busy) {
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

window.addEventListener("popstate", () => {
  applyRoute();
});

for (const [id, path, mode] of [
  ["header-login", "/login", "login"],
  ["header-signup", "/signup", "signup"],
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
  if (routePath() === "/login" || routePath() === "/signup") {
    history.replaceState(null, "", "/" + nextMode);
  }
  setAuth(nextMode, $("auth-context-notice").textContent);
};

$("password-toggle").onclick = () => {
  const input = $("password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("password-toggle").textContent = show ? "숨김" : "표시";
  $("password-toggle").setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 표시");
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
    if (authMode === "signup" && $("nickname").value.trim()) {
      body.nickname = $("nickname").value.trim();
    }
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
  if (!window.PublicKeyCredential) {
    alertIn("auth-error", "이 브라우저는 패스키(WebAuthn)를 지원하지 않습니다.");
    return;
  }
  try {
    const options = await api("passkeys/login/options", { email: $("email").value.trim() });
    const pk = options.publicKey;
    pk.challenge = b64urlToBytes(pk.challenge);
    pk.allowCredentials = (pk.allowCredentials || []).map((item) => ({ ...item, id: b64urlToBytes(item.id) }));
    const assertion = await navigator.credentials.get({ publicKey: pk });
    const payload = {
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
    };
    const result = await api("passkeys/login/verify", payload);
    if (result.mfaRequired) {
      enterMfaStep(result.mfaToken);
      return;
    }
    location.assign(authNextPath || "/ide");
  } catch (error) {
    if (error?.name === "NotAllowedError") return;
    alertIn("auth-error", error.message || "패스키 로그인에 실패했습니다.");
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
        if (res.email) {
          stopQrPolling();
          location.assign(authNextPath || "/ide");
        }
      } catch (error) {
        stopQrPolling();
        $("qr-login-status").textContent = error.message;
      }
    }, 2000);
  } catch (error) {
    alertIn("auth-error", error.message);
  }
};

$("qr-login-cancel").onclick = () => {
  stopQrPolling();
  $("qr-login-panel").hidden = true;
};

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
  if (dirtyTabs() && !confirm("저장하지 않은 편집 내용이 있습니다. 로그아웃할까요?")) return;
  for (const tab of tabs.values()) cancelAutoSave(tab);
  try {
    await api("logout", {});
    tabs.clear();
    location.assign("/");
  } catch (error) { status(error.message, true); }
};

$("theme-toggle").onclick = () => {
  const current = document.documentElement.dataset.ideTheme === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
};

$("sidebar-toggle").onclick = () => {
  const collapsed = $("ide").classList.toggle("sidebar-collapsed");
  $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  if (graphVisible) {
    setTimeout(() => (graphMode === "code" ? codeGraph : proofGraph).fit(), 60);
  }
};

$("view-editor").onclick = () => {
  graphVisible = false;
  renderWorkbench();
  renderEntries();
};
$("view-graph").onclick = () => showGraph(graphPage, graphData.root);
$("view-code").onclick = () => showCodeGraph();

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
  for (const tab of tabs.values()) cancelAutoSave(tab);
  tabs.clear();
  active = null;
  graphVisible = false;
  if (!$("terminal-panel").hidden) $("terminal-close").click();
  vmSocket?.close();
  vmSocket = null;
  currentSession = await api("session");
  renderWorkspaceBadge();
  renderWorkbench();
  await showFolder("/");
}

async function switchWorkspace(ownerId) {
  if (busy) return;
  if (currentSession.workspace?.ownerId === ownerId) {
    $("workspace-dialog").close();
    return;
  }
  if (dirtyTabs() && !confirm("저장하지 않은 편집 내용이 있습니다. 워크스페이스를 전환할까요?")) return;
  for (const tab of tabs.values()) cancelAutoSave(tab);
  if (!$("terminal-panel").hidden) $("terminal-close").click();
  vmSocket?.close();
  vmSocket = null;
  try {
    const selected = await api("workspaces/select", { ownerId });
    currentSession.workspace = selected;
    tabs.clear();
    active = null;
    graphVisible = false;
    renderWorkspaceBadge();
    $("workspace-dialog").close();
    renderWorkbench();
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

  const incomingSection = $("incoming-invites-section");
  const incomingList = $("incoming-invites-list");
  incomingSection.hidden = data.incoming.length === 0;
  incomingList.replaceChildren(...data.incoming.map((invite) => {
    const row = element("div", undefined, "ws-row");
    const info = element("div", undefined, "ws-row-info");
    info.append(element("strong", invite.ownerEmail), element("span", "워크스페이스 초대 대기 중", "ws-meta"));
    const actions = element("div", undefined, "ws-row-actions");
    actions.append(
      button("수락 후 열기", async () => {
        try {
          await api("workspaces/respond", { ownerId: invite.ownerId, decision: "accept", switch: true });
          await switchWorkspace(invite.ownerId);
        } catch (error) {
          alertIn("invite-error", error.message);
        }
      }, "primary"),
      button("수락", async () => {
        try {
          await api("workspaces/respond", { ownerId: invite.ownerId, decision: "accept" });
          await refreshWorkspaceDialog();
        } catch (error) {
          alertIn("invite-error", error.message);
        }
      }),
      button("거절", async () => {
        try {
          await api("workspaces/respond", { ownerId: invite.ownerId, decision: "decline" });
          await refreshWorkspaceDialog();
        } catch (error) {
          alertIn("invite-error", error.message);
        }
      }, "quiet"),
    );
    row.append(info, actions);
    return row;
  }));

  const wsList = $("workspace-list");
  wsList.replaceChildren(...data.workspaces.map((ws) => {
    const isCurrent = ws.ownerId === data.current.ownerId;
    const row = element("div", undefined, "ws-row" + (isCurrent ? " current" : ""));
    const info = element("div", undefined, "ws-row-info");
    info.append(
      element("strong", ws.shared ? ws.ownerEmail : "내 워크스페이스 (" + ws.ownerEmail + ")"),
      element("span", ws.shared ? "공유 VM · /workspace 공동 사용" : "개인 전용 VM", "ws-meta"),
    );
    const actions = element("div", undefined, "ws-row-actions");
    if (isCurrent) {
      actions.append(element("span", "사용 중", "ws-status active"));
    } else {
      actions.append(button("전환", () => switchWorkspace(ws.ownerId), "primary"));
    }
    if (ws.shared) {
      actions.append(button("나가기", async () => {
        if (!confirm(ws.ownerEmail + " 워크스페이스에서 나갈까요?")) return;
        try {
          await api("workspaces/remove", { ownerId: ws.ownerId });
          if (isCurrent) {
            await recoverRevokedWorkspace();
            $("workspace-dialog").close();
          } else {
            await refreshWorkspaceDialog();
          }
        } catch (error) {
          alertIn("invite-error", error.message);
        }
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
      const stateText = member.status === "accepted"
        ? "참여 중 (개별 계정)"
        : member.registered ? "수락 대기 중" : "미가입 (가입 후 수락 가능)";
      info.append(element("strong", member.email), element("span", stateText, "ws-meta"));
      const actions = element("div", undefined, "ws-row-actions");
      actions.append(button(member.status === "accepted" ? "내보내기" : "초대 취소", async () => {
        try {
          await api("workspaces/remove", { email: member.email });
          await refreshWorkspaceDialog();
        } catch (error) {
          alertIn("invite-error", error.message);
        }
      }, "quiet danger"));
      row.append(info, actions);
      return row;
    }));
  }
}

$("workspace-open").onclick = async () => {
  try {
    await refreshWorkspaceDialog();
    if (!$("workspace-dialog").open) $("workspace-dialog").showModal();
  } catch (error) {
    status(error.message, true);
  }
};
$("workspace-dialog-close").onclick = () => $("workspace-dialog").close();
$("invite-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("invite-error");
  $("invite-submit").disabled = true;
  try {
    await api("workspaces/invite", { email: $("invite-email").value });
    $("invite-email").value = "";
    await refreshWorkspaceDialog();
  } catch (error) {
    alertIn("invite-error", error.message);
  } finally {
    $("invite-submit").disabled = false;
  }
};

async function refreshAccountDialog() {
  alertIn("mfa-settings-error");
  alertIn("passkey-error");
  $("profile-status").textContent = "";
  $("profile-nickname").value = currentSession.nickname || "";
  $("mfa-setup-box").hidden = true;
  $("mfa-recovery-box").hidden = true;
  const sec = await api("security");
  const enabled = Boolean(sec.mfaEnabled);
  $("mfa-state-badge").textContent = enabled ? "활성화됨" : "비활성화";
  $("mfa-state-badge").classList.toggle("active", enabled);
  $("mfa-off-controls").hidden = enabled;
  $("mfa-disable-form").hidden = !enabled;

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
        try {
          await api("passkeys/delete", { credentialId: key.id });
          await refreshAccountDialog();
        } catch (error) {
          alertIn("passkey-error", error.message);
        }
      }, "quiet danger"));
      row.append(info, actions);
      return row;
    }));
  }
}

$("account-open").onclick = async () => {
  try {
    await refreshAccountDialog();
    if (!$("account-dialog").open) $("account-dialog").showModal();
  } catch (error) {
    status(error.message, true);
  }
};
$("account-dialog-close").onclick = () => $("account-dialog").close();

$("profile-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const res = await api("profile", { nickname: $("profile-nickname").value });
    currentSession.nickname = res.nickname;
    $("account-label").textContent = res.nickname + " (" + currentSession.email + ")";
    $("profile-status").textContent = "닉네임이 저장되었습니다. 새 터미널을 열면 프롬프트(" + res.nickname + "@qnb)에 반영됩니다.";
  } catch (error) {
    $("profile-status").textContent = error.message;
  }
};

$("mfa-setup-btn").onclick = async () => {
  alertIn("mfa-settings-error");
  try {
    const data = await api("mfa/setup", {});
    $("mfa-qr-img").src = data.qrDataUrl || "";
    $("mfa-qr-img").hidden = !data.qrDataUrl;
    $("mfa-secret-text").textContent = "수동 키: " + data.secret;
    $("mfa-setup-box").hidden = false;
  } catch (error) {
    alertIn("mfa-settings-error", error.message);
  }
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
  } catch (error) {
    alertIn("mfa-settings-error", error.message);
  }
};

$("mfa-disable-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("mfa-settings-error");
  try {
    await api("mfa/disable", { code: $("mfa-disable-code").value });
    $("mfa-disable-code").value = "";
    await refreshAccountDialog();
  } catch (error) {
    alertIn("mfa-settings-error", error.message);
  }
};

$("passkey-register-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("passkey-error");
  if (!window.PublicKeyCredential) {
    alertIn("passkey-error", "이 브라우저는 패스키 등록을 지원하지 않습니다.");
    return;
  }
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
        id: cred.id,
        rawId: bytesToB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bytesToB64url(cred.response.clientDataJSON),
          attestationObject: bytesToB64url(cred.response.attestationObject),
        },
      },
    });
    $("passkey-label").value = "";
    await refreshAccountDialog();
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      alertIn("passkey-error", error.message || "패스키 등록에 실패했습니다.");
    }
  } finally {
    $("passkey-register-btn").disabled = false;
  }
};

async function refreshAxiomDialog() {
  alertIn("axiom-error");
  const data = await api("axioms");
  $("axiom-form").hidden = !data.canManage;
  $("axiom-role-notice").textContent = data.canManage
    ? "VM 소유자 권한으로 공리를 등록할 수 있습니다. 일반 코드 셀에서 작성한 axiom은 DB에 저장되지 않으며, 여기에 등록된 공리만 셀과 협업자가 참조할 수 있습니다."
    : "초대받은 협업자 모드(조회 전용)입니다. VM 소유자가 등록한 공리를 모든 코드 셀에서 이름으로 참조할 수 있습니다.";
  const list = $("axioms-list");
  if (!data.axioms.length) {
    list.replaceChildren(element("p", "등록된 워크스페이스 공리가 없습니다.", "ws-empty"));
  } else {
    list.replaceChildren(...data.axioms.map((ax) => {
      const card = element("div", undefined, "ws-row axiom-card");
      const info = element("div", undefined, "ws-row-info");
      info.append(
        element("strong", ax.name),
        element("span", "SHA-256: " + ax.hash.slice(0, 16) + "…", "ws-meta"),
        element("pre", ax.source, "axiom-src"),
      );
      card.append(info);
      if (data.canManage) {
        const actions = element("div", undefined, "ws-row-actions");
        actions.append(button("삭제", async () => {
          if (!confirm(ax.name + " 공리를 삭제할까요?")) return;
          try {
            await api("axioms/delete", { name: ax.name });
            await refreshAxiomDialog();
          } catch (error) {
            alertIn("axiom-error", error.message);
          }
        }, "quiet danger"));
        card.append(actions);
      }
      return card;
    }));
  }
}

$("axioms-open").onclick = async () => {
  try {
    await refreshAxiomDialog();
    if (!$("axiom-dialog").open) $("axiom-dialog").showModal();
  } catch (error) {
    status(error.message, true);
  }
};
$("axiom-dialog-close").onclick = () => $("axiom-dialog").close();
$("axiom-form").onsubmit = async (event) => {
  event.preventDefault();
  alertIn("axiom-error");
  $("axiom-submit").disabled = true;
  try {
    await api("axioms", { source: $("axiom-source").value });
    $("axiom-source").value = "";
    await refreshAxiomDialog();
  } catch (error) {
    alertIn("axiom-error", error.message);
  } finally {
    $("axiom-submit").disabled = false;
  }
};

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

function fileBadgeFor(path, type) {
  if (type === "directory") return ["dir", "▱"];
  const ext = path.split(".").at(-1).toLowerCase();
  if (ext === "ipynb") return ["nb", "∴"];
  if (ext === "lean") return ["lean", "λ"];
  if (ext === "md" || ext === "markdown") return ["md", "M"];
  if (ext === "py") return ["py", "Py"];
  if (["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx"].includes(ext)) return ["cpp", "C+"];
  if (ext === "java") return ["java", "J"];
  return ["file", "·"];
}

function renderEntries() {
  $("folder-path").textContent = "/workspace" + (folder === "/" ? "" : folder);
  $("folder-path").title = $("folder-path").textContent;
  $("parent").disabled = folder === "/";
  $("folder-menu").disabled = folder === "/" || busy;
  $("more-files").hidden = cursor === null;
  const rows = entries.map(([name, type]) => {
    const path = join(folder, name);
    const row = button("", () => type === "directory" ? showFolder(path) : openFile(path),
      "file-row" + (active === path && !graphVisible ? " active" : ""));
    row.title = name;
    const [badgeKind, glyph] = fileBadgeFor(path, type);
    row.append(
      element("span", glyph, "file-icon badge-" + badgeKind),
      element("span", name),
    );
    return row;
  });
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
    if (!append) folderVersion = null;
    folder = path;
    entries = append ? entries.concat(result.entries) : result.entries;
    cursor = result.cursor;
    vmStatus("ready", "VM 연결됨");
    renderEntries();
    status("");
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

async function syncFolder() {
  const path = folder;
  const request = listRequest;
  const current = () => !busy && !listing && request === listRequest && folder === path;
  try {
    const info = await vmRequest("workspace", { operation: "stat", path });
    if (!current() || info.resourceId === folderVersion) return;
    let fresh = [];
    let next = 0;
    do {
      const result = await vmRequest("workspace", { operation: "list", path, cursor: next });
      if (!current()) return;
      fresh = fresh.concat(result.entries);
      next = result.cursor;
    } while (next !== null && fresh.length < entries.length);
    folderVersion = info.resourceId;
    if (next !== cursor || JSON.stringify(entries) !== JSON.stringify(fresh)) {
      entries = fresh;
      cursor = next;
      renderEntries();
    }
  } catch (error) {
    if (error.status === 404 && current() && path !== "/") await showFolder(dirname(path));
  }
}

function showFileSyncNotice(tab) {
  const message = tab?.remoteChange;
  $("file-sync-notice").hidden = !message;
  $("file-sync-message").textContent = message || "";
  $("reload-file").disabled = busy;
}

function updateRemoteChange(tab, message) {
  if (tab.remoteChange === message) return;
  tab.remoteChange = message;
  renderTabs();
  if (activeTab() === tab && !graphVisible) showFileSyncNotice(tab);
}

function replaceTabFromVM(tab, data) {
  cancelAutoSave(tab);
  Object.assign(tab, {
    text: data.text, fileId: data.fileId, etag: data.etag, resourceId: data.resourceId,
    chunked: data.chunked === true, notebook: null, dirty: false, remoteChange: null,
    feedback: new Map(),
  });
  if (activeTab() === tab && !graphVisible) {
    renderWorkbench();
  } else {
    renderTabs();
  }
}

async function syncTab(tab) {
  const { path, resourceId } = tab;
  const current = () => !busy && !tab.savingPromise && tabs.get(path) === tab && tab.resourceId === resourceId;
  try {
    const info = await vmRequest("workspace", { operation: "stat", path });
    if (!current()) return;
    if (info.type !== "file") {
      updateRemoteChange(tab, "VM에서 이 경로가 파일이 아닌 항목으로 바뀌었습니다.");
    } else if (info.resourceId === resourceId) {
      updateRemoteChange(tab, null);
    } else if (tab.dirty) {
      updateRemoteChange(tab, "VM에서 파일이 변경되었습니다. 저장하지 않은 편집 내용은 유지됩니다.");
    } else {
      const data = await vmRequest("workspace", { operation: "read", path });
      if (!current()) return;
      if (tab.dirty || tab.savingPromise) updateRemoteChange(tab, "VM에서 파일이 변경되었습니다. 저장하지 않은 편집 내용은 유지됩니다.");
      else replaceTabFromVM(tab, data);
    }
  } catch (error) {
    if (!current()) return;
    if (error.status === 404) updateRemoteChange(tab, "VM에서 파일이 삭제되었거나 이름이 바뀌었습니다.");
    else if (error.status === 413 || error.status === 415) updateRemoteChange(tab, error.message);
  }
}

async function syncWorkspace() {
  if (document.hidden || busy || autoSaving || listing || workspaceSyncRunning) return;
  workspaceSyncRunning = true;
  try {
    await syncFolder();
    for (const tab of [...tabs.values()]) {
      if (busy || autoSaving || document.hidden) break;
      await syncTab(tab);
    }
  } finally {
    workspaceSyncRunning = false;
  }
}

async function openFile(path) {
  if (!tabs.has(path)) {
    status("VM에서 파일을 여는 중…");
    try {
      const data = await vmRequest("workspace", { operation: "read", path });
      if (!tabs.has(path)) {
        tabs.set(path, { path, ...data, dirty: false, jsonMode: false, feedback: new Map() });
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

function closeFile(path) {
  if (busy) return;
  const tab = tabs.get(path);
  if (tab.dirty && !confirm("저장하지 않은 변경 사항을 버릴까요?")) return;
  cancelAutoSave(tab);
  tabs.delete(path);
  if (active === path) active = [...tabs.keys()].at(-1) || null;
  renderWorkbench();
  renderEntries();
}

function renderTabs() {
  const items = [...tabs.values()].map((tab) => {
    const selected = tab.path === active && !graphVisible;
    const wrapper = element("div", undefined, "tab" + (selected ? " active" : ""));
    const select = button(basename(tab.path) + (tab.dirty ? " ●" : "") + (tab.remoteChange ? " !" : ""),
      () => selectFile(tab.path));
    select.title = tab.remoteChange ? tab.path + " · " + tab.remoteChange : tab.path;
    select.setAttribute("aria-pressed", selected);
    const close = button("×", () => closeFile(tab.path), "", basename(tab.path) + " 닫기");
    close.disabled = busy;
    wrapper.append(select, close);
    return wrapper;
  });
  if (graphVisible) {
    const wrapper = element("div", undefined, "tab active");
    const label = graphMode === "code" ? "코드 의존성" : "증명 트리";
    wrapper.append(button(label, () => graphMode === "code" ? showCodeGraph() : showGraph(graphPage)),
      button("×", () => selectFile(active), "", label + " 닫기"));
    items.push(wrapper);
  }
  $("tabs").replaceChildren(...items);
}

function markDirty(tab) {
  tab.editVersion = (tab.editVersion || 0) + 1;
  if (!tab.dirty) {
    tab.dirty = true;
    renderTabs();
  }
  if (activeTab() === tab && !graphVisible) $("editor-mode").textContent = "저장되지 않음";
}

const editors = new Map();
const editingMarkdown = new WeakSet();

function mountEditor(key, host, options) {
  let editor = editors.get(key);
  if (editor) editor.update(options);
  else {
    editor = new QNBEditing.CodeEditor(options);
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
    lean: "lean4", py: "python", md: "markdown", markdown: "markdown", json: "json",
    ipynb: "json", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  }[path.split(".").at(-1).toLowerCase()] || "";
}

function renderPlainFile(tab) {
  retainEditors(new Set([tab]));
  const language = fileLanguage(tab.path);
  const preview = $("file-markdown");
  const previewButton = $("markdown-file-preview");
  const markdownFile = language === "markdown";
  previewButton.hidden = !markdownFile;
  previewButton.setAttribute("aria-pressed", markdownFile && tab.markdownPreview !== false);
  preview.hidden = !markdownFile || tab.markdownPreview === false;
  if (!preview.hidden) QNBEditing.renderMarkdown(preview, tab.text);
  mountEditor(tab, $("file-content"), {
    text: tab.text, language, label: "파일 내용", readOnly: busy,
    onChange(text) {
      tab.text = text;
      tab.notebook = null;
      markDirty(tab);
      if (!preview.hidden) QNBEditing.renderMarkdown(preview, text);
    },
  });
}

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
  if (tab.notebook && !tab.jsonMode) {
    tab.text = JSON.stringify(tab.notebook, null, 1) + "\n";
  }
  return tab.text;
}

function cellId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function newCell(type, language, source = "") {
  const cell = { id: cellId(), cell_type: type, metadata: {}, source };
  if (type === "code") {
    cell.metadata.qnb_language = language;
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

function newNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "lean4", display_name: "Lean 4", language: "lean4" } },
    cells: [
      newCell(
        "markdown",
        null,
        "# 병렬 증명 노트북\n\n" +
          "각 **Lean 4 셀**은 독립적으로 실행되며, `sorry` 없이 검증을 통과한 정리와 정의만 데이터베이스에 저장됩니다.\n" +
          "첫 번째 셀에서 보조정리를 검증해 DB에 저장한 뒤, 두 번째 셀에서 바로 불러와 이어서 증명해 보세요.",
      ),
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
  if (["lean4", "python"].includes(explicit)) return explicit;
  if (/^%%lean4(?:\s|$)/.test(sourceOf(cell))) return "lean4";
  const kernel = String(doc.metadata?.kernelspec?.name || "python3").toLowerCase();
  if (["lean", "lean4"].includes(kernel)) return "lean4";
  return kernel.startsWith("python") ? "python" : "";
}

function renderWorkbench() {
  const tab = activeTab();
  renderTabs();
  const proofVisible = graphVisible && graphMode === "proof";
  const codeVisible = graphVisible && graphMode === "code";
  $("view-editor")?.classList.toggle("active", !graphVisible);
  $("view-graph")?.classList.toggle("active", proofVisible);
  $("view-code")?.classList.toggle("active", codeVisible);
  $("graph-open")?.classList.toggle("active", proofVisible);
  $("code-graph-open")?.classList.toggle("active", codeVisible);
  $("graph").hidden = !proofVisible;
  $("codegraph").hidden = !codeVisible;
  $("workspace-welcome").hidden = graphVisible || Boolean(tab);
  $("editor").hidden = graphVisible || !tab;
  $("editor-mode").textContent = "";
  showFileSyncNotice(tab);
  if (!tab || graphVisible) {
    if (!tab) retainEditors(new Set());
    return;
  }
  $("file-path").textContent = tab.path;
  $("file-path").title = tab.path;
  $("save").disabled = busy;
  $("file-menu").disabled = busy;
  const notebookVisible = isNotebook(tab.path) && !tab.jsonMode;
  $("plain-editor").hidden = notebookVisible;
  $("notebook").hidden = !notebookVisible;
  $("json-return").hidden = !(isNotebook(tab.path) && tab.jsonMode);
  $("editor-mode").textContent = tab.dirty ? "저장되지 않음" : notebookVisible ? "Jupyter Notebook" : "UTF-8";
  if (notebookVisible) {
    $("markdown-file-preview").hidden = true;
    renderNotebook(tab);
  } else {
    renderPlainFile(tab);
  }
}

let autoSaving = false;

function cancelAutoSave(tab) {
  if (tab?.autoSaveTimer) {
    clearTimeout(tab.autoSaveTimer);
    tab.autoSaveTimer = null;
  }
}

function scheduleAutoSave(tab) {
  if (!tab || !tab.dirty) return;
  cancelAutoSave(tab);
  tab.autoSaveTimer = setTimeout(async () => {
    tab.autoSaveTimer = null;
    if (!tabs.has(tab.path) || tabs.get(tab.path) !== tab || !tab.dirty) return;
    if (busy || autoSaving) {
      scheduleAutoSave(tab);
      return;
    }
    autoSaving = true;
    try {
      await saveTab(tab);
      if (activeTab() === tab && !graphVisible && !busy) {
        status("VM에 자동 저장했습니다.");
      }
    } catch (error) {
      status("자동 저장에 실패했습니다. 직접 저장하세요 · " + error.message, true);
    } finally {
      autoSaving = false;
    }
  }, 1200);
}

async function saveTab(tab) {
  if (tab.savingPromise) {
    await tab.savingPromise.catch(() => {});
  }
  if (!tab.dirty) return;
  cancelAutoSave(tab);
  const run = (async () => {
    const savingVersion = tab.editVersion || 0;
    const text = serialize(tab);
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > LARGE_FILE_LIMIT) throw new Error("파일 크기는 8 MiB까지 지원합니다.");
    const result = tab.chunked || bytes.length > FILE_LIMIT
      ? await vmRequest("workspace", {
        operation: "write_stream", path: tab.path, size: bytes.length, resourceId: tab.resourceId,
      }, bytes)
      : await vmRequest("workspace", {
        operation: "write", path: tab.path, text, fileId: tab.fileId, etag: tab.etag,
      });
    tab.etag = result.etag;
    tab.fileId = result.fileId;
    tab.resourceId = result.resourceId;
    tab.chunked = result.chunked === true;
    tab.dirty = (tab.editVersion || 0) !== savingVersion;
    tab.remoteChange = null;
    renderTabs();
    if (activeTab() === tab && !graphVisible) {
      $("editor-mode").textContent = tab.dirty ? "저장되지 않음" : "저장됨";
      showFileSyncNotice(tab);
    }
  })();
  tab.savingPromise = run;
  try {
    await run;
  } finally {
    if (tab.savingPromise === run) tab.savingPromise = null;
  }
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
  try {
    await task();
  } catch (error) {
    status(error.message, true);
  } finally {
    setBusy(false);
  }
}

function saveActive() {
  if (!activeTab() || graphVisible) return;
  const tab = activeTab();
  runTask(async () => {
    await saveTab(tab);
    status("VM에 저장했습니다.");
  });
}

$("save").onclick = saveActive;
$("reload-file").onclick = () => {
  const tab = activeTab();
  if (!tab || (tab.dirty && !confirm("저장하지 않은 편집을 버리고 VM에서 파일을 다시 열까요?"))) return;
  runTask(async () => {
    const data = await vmRequest("workspace", { operation: "read", path: tab.path });
    replaceTabFromVM(tab, data);
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
  if (action === "delete") $("dialog-description").textContent += " 파일 또는 폴더를 삭제합니다.";
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
      const info = await vmRequest("workspace", { operation: "stat", path });
      if (action === "delete" && tabs.get(path)?.dirty) throw new Error("삭제하기 전에 파일을 저장하거나 닫으세요.");
      const target = join(dirname(path), name);
      if (action === "delete" || target !== path) {
        const operation = action === "delete" ? "delete" : "rename";
        await vmRequest("workspace", { operation, path, target, resourceId: info.resourceId });
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
        await vmRequest("workspace", { operation: "mkdir", path: newPath });
      } else {
        const text = isNotebook(newPath) ? JSON.stringify(newNotebook(), null, 1) + "\n" : "";
        await vmRequest("workspace", { operation: "write", path: newPath, text, create: true });
      }
      await showFolder(path);
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
    output.append(statusRow);
  }
  if (feedback?.truncated) {
    output.append(element("div", "셀 출력이 크기 제한을 초과해 일부 생략됐습니다.", "notice"));
  }
  const items = feedback?.outputs || cell.outputs;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const data = item.data || {};
      const image = imageOutputSource(data);
      if (image) {
        const preview = element("img");
        preview.alt = "셀 실행 결과";
        preview.src = image;
        output.append(preview);
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
  } catch (error) {
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
    for (const [value, text] of [["code", "코드"], ["markdown", "Markdown"], ["raw", "텍스트"]]) {
      kind.add(new Option(text, value));
    }
    kind.value = code || markdown ? cell.cell_type : "raw";
    kind.disabled = busy;
    kind.onchange = () => {
      cell.cell_type = kind.value;
      if (kind.value === "code") {
        cell.outputs = [];
        cell.execution_count = null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
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
      for (const [value, label] of [["", "커널 선택"], ["lean4", "Lean 4"], ["python", "Python"]]) {
        if (!value && current) continue;
        const opt = element("option", label);
        opt.value = value;
        chooser.append(opt);
      }
      chooser.value = current;
      chooser.disabled = busy;
      chooser.onchange = () => {
        const prior = sourceOf(cell);
        if (/^%%lean4(?:[ \t][^\n]*)?(?:\n|$)/.test(prior)) cell.source = prior.replace(/^%%lean4(?:[ \t][^\n]*)?(?:\n|$)/, "");
        cell.metadata = { ...(cell.metadata || {}), qnb_language: chooser.value };
        cell.outputs = [];
        cell.execution_count = null;
        tab.feedback.delete(cell);
        markDirty(tab);
        renderNotebook(tab, cell);
      };
      const run = button("▶ 실행", () => runCell(tab, cell, index), "primary cell-run-btn");
      run.disabled = busy || !current;
      header.append(chooser, run);
      if (current === "lean4") {
        header.append(element("span", "독립 검증 · DB 저장", "cell-kernel-tag"));
      }
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
      QNBEditing.renderMarkdown(preview, sourceOf(cell));
      if (!sourceOf(cell).trim()) {
        preview.append(element("p", "Markdown을 입력하세요. (더블클릭하여 편집)", "markdown-placeholder"));
      }
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
      if (markdown) {
        body.classList.add("markdown-split");
        renderPreview();
        body.append(preview);
      }
      mountEditor(cell, host, {
        text: sourceOf(cell),
        language: code ? kernelLang : markdown ? "markdown" : "",
        label: (index + 1) + "번 셀 소스", readOnly: busy,
        onChange(text) {
          cell.source = text;
          markDirty(tab);
          if (preview) renderPreview();
        },
        onRun() {
          if (busy) return false;
          if (markdown) {
            editingMarkdown.delete(cell);
            renderNotebook(tab, cell);
            return true;
          }
          if (!code || !cellLanguage(doc, cell)) return false;
          runCell(tab, cell, index);
          return true;
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

function runCell(tab, cell, index) {
  const doc = readNotebook(tab);
  const lang = cellLanguage(doc, cell);
  const code = sourceOf(cell);
  runTask(async () => {
    cancelAutoSave(tab);
    status("VM에서 셀을 실행하는 중…");
    const result = await vmRequest("kernel", { operation: "run", path: tab.path, language: lang, code });
    tab.feedback.set(cell, result);
    const outputs = Array.isArray(result.outputs) ? result.outputs.filter((item) =>
      ["stream", "display_data", "execute_result", "error"].includes(item?.output_type)) : [];
    cell.outputs = outputs;
    cell.execution_count = Number.isInteger(result.executionCount) ? result.executionCount : null;
    if (new TextEncoder().encode(JSON.stringify(tab.notebook, null, 1) + "\n").length > LARGE_FILE_LIMIT) {
      cell.outputs = [];
    }
    markDirty(tab);
    if (activeTab() === tab && !graphVisible) renderNotebook(tab);
    scheduleAutoSave(tab);
    status(result.exitCode === 0 ? "셀 실행을 완료했습니다." : result.error || "셀 실행이 실패했습니다.", result.exitCode !== 0);
  });
}

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
    const params = new URLSearchParams({
      page, limit: $("graph-limit").value, depth: $("graph-depth").value,
    });
    if (root) params.set("root", root);
    const data = await api("proof-tree?" + params);
    if (request !== graphRequest || !graphVisible || graphMode !== "proof") return;
    if (focusName && !root) {
      const target = data.theorems.find((node) => node.name === focusName);
      if (target && target.id !== data.root) {
        return showGraph(page, target.id);
      }
    }
    graphData = data;
    const limits = data.limitedBy.map((key) => key === "nodes" ? "노드 수" : "깊이");
    $("graph-status").textContent = data.root
      ? data.nodes.length + "개 노드 · " + data.edges.length + "개 간선" +
        (limits.length ? " · " + limits.join(", ") + " 제한으로 일부 생략" : "")
      : "저장된 정리가 없습니다. Lean 4 셀에서 이름이 있는 정리를 증명하세요.";
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
  const items = graphData.theorems.map((node) => {
    const isRoot = node.id === graphData.root;
    const item = button(node.name, () => showGraph(graphPage, node.id), isRoot ? "selected" : "");
    item.setAttribute("aria-pressed", isRoot);
    return item;
  });
  $("theorem-list").replaceChildren(...items);
}

async function selectTheorem(id) {
  const node = graphData.nodes.find((item) => item.id === id);
  if (!node) return;
  selectedTheorem = id;
  drawGraph();
  const panel = $("theorem-detail");
  const names = new Map(graphData.nodes.map((item) => [item.id, item.name]));
  const references = graphData.edges.filter((edge) => edge.from === id);
  panel.replaceChildren(element("h2", node.name));
  if (node.hash && id !== graphData.root) {
    panel.append(button("이 정리에서 탐색", () => showGraph(graphPage, id)));
  }
  if (references.length) {
    panel.append(element("p", "의존 관계"));
    const list = element("ul");
    for (const { to } of references) {
      const item = element("li");
      item.append(button(names.get(to), () => selectTheorem(to), "quiet"));
      list.append(item);
    }
    panel.append(list);
  }
  if (!node.hash) {
    panel.append(element("p", node.kind === "axiom" ? "Lean 표준 공리입니다." : "참조된 정리입니다."));
    return;
  }
  const info = element("div");
  panel.append(info);
  const request = graphRequest;
  try {
    const theorem = await api("theorem/" + id);
    if (selectedTheorem !== id || request !== graphRequest) return;
    info.replaceChildren(element("p", theorem.path), element("p", "SHA-256"), element("code", theorem.hash),
      element("pre", theorem.source));
  } catch (error) {
    if (selectedTheorem === id && request === graphRequest) info.replaceChildren(element("p", error.message, "error"));
  }
}

const proofGraph = new QNBGraph.ProofGraph($("graph-canvas"), selectTheorem);

function drawGraph() {
  proofGraph.render(graphData, selectedTheorem);
}

$("graph-zoom-in").onclick = () => proofGraph.zoom(1.25);
$("graph-zoom-out").onclick = () => proofGraph.zoom(.8);
$("graph-fit").onclick = () => proofGraph.fit();
$("graph-open").onclick = () => showGraph();
$("welcome-graph").onclick = () => showGraph();
$("welcome-terminal").onclick = () => $("terminal-open").click();
$("refresh-graph").onclick = () => showGraph(graphPage, graphData.root);
$("graph-limits").addEventListener("submit", (event) => {
  event.preventDefault();
  showGraph(graphPage, graphData.root);
});
$("previous-graph").onclick = () => showGraph(graphPage - 1);
$("next-graph").onclick = () => showGraph(graphPage + 1);

// ---------------------------------------------------------------- 코드 의존성 그래프

const CODE_KIND_LABELS = { file: "파일", class: "클래스", function: "함수", variable: "변수" };
const CODE_LANGUAGE_LABELS = { python: "Python", cpp: "C++", java: "Java" };
const CODE_EDGE_LABELS = {
  imports: ["가져오는 파일", "가져가는 파일"],
  calls: ["호출하는 대상", "호출하는 곳"],
  reads: ["읽는 대상", "읽는 곳"],
  writes: ["쓰는 대상", "쓰는 곳"],
  inherits: ["상속하는 타입", "상속받는 타입"],
  contains: ["포함 항목", "포함하는 곳"],
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
  const checked = (name) => new Set([...document.querySelectorAll(`.code-graph-filters input[name="${name}"]:checked`)]
    .map((input) => input.value));
  const edges = checked("edge");
  if (edges.has("contains")) edges.add("declares");
  return {
    languages: checked("language"), kinds: checked("kind"), edges,
    neighborhood: $("code-graph-neighborhood").checked,
    depth: Math.max(1, Math.min(6, Number($("code-graph-depth").value) || 2)),
  };
}

function rebuildCodeView() {
  if (!codeGraphData) {
    codeGraphView = { nodes: [], edges: [] };
    return;
  }
  const filters = codeFilters();
  let nodes = codeGraphData.nodes.filter((node) =>
    filters.kinds.has(node.kind) && filters.languages.has(node.language));
  let ids = new Set(nodes.map((node) => node.id));
  let edges = codeGraphData.edges.filter((edge) =>
    filters.edges.has(edge.kind) && ids.has(edge.from) && ids.has(edge.to));
  if (filters.neighborhood && selectedCode && ids.has(selectedCode)) {
    const adjacent = new Map();
    for (const edge of edges) {
      if (!adjacent.has(edge.from)) adjacent.set(edge.from, []);
      if (!adjacent.has(edge.to)) adjacent.set(edge.to, []);
      adjacent.get(edge.from).push(edge.to);
      adjacent.get(edge.to).push(edge.from);
    }
    const keep = new Set([selectedCode]);
    let frontier = [selectedCode];
    for (let level = 0; level < filters.depth && frontier.length; level++) {
      const next = [];
      for (const id of frontier) {
        for (const other of adjacent.get(id) || []) {
          if (!keep.has(other)) {
            keep.add(other);
            next.push(other);
          }
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
  const parts = [
    `파일 ${fileCount}`, `클래스 ${summary.class || 0}`, `함수 ${summary.function || 0}`, `변수 ${summary.variable || 0}`,
    `표시 ${codeGraphView.nodes.length}노드 · ${codeGraphView.edges.length}간선`,
  ];
  if (truncated) parts.push("크기 제한으로 일부 생략");
  if (codeGraphData.errors.length || codeGraphData.skipped.length) {
    parts.push(`경고 ${codeGraphData.errors.length + codeGraphData.skipped.length}`);
  }
  return parts.join(" · ") + ` · ${elapsed}s`;
}

function drawCodeGraph() {
  codeGraph.render(codeGraphView, selectedCode);
  $("code-graph-status").textContent = codeStatusText();
  drawCodeNodeList();
}

function refreshCodeView() {
  rebuildCodeView();
  drawCodeGraph();
  if (selectedCode) drawCodeNodeDetail();
}

function showCodeGraph(refresh = false) {
  graphVisible = true;
  graphMode = "code";
  renderWorkbench();
  renderEntries();
  if (!codeGraphData && !codeGraphLoading) {
    $("code-graph-path").value = folder;
    analyzeCode();
  } else if (refresh) {
    analyzeCode();
  } else {
    drawCodeGraph();
    setTimeout(() => codeGraph.fit(), 0);
  }
}

async function analyzeCode() {
  let path = $("code-graph-path").value.trim() || "/";
  if (path.startsWith("/workspace")) path = path.slice("/workspace".length) || "/";
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  $("code-graph-path").value = path;
  const request = ++codeGraphRequest;
  codeGraphLoading = true;
  $("code-graph-status").textContent = "VM에서 소스를 읽고 의존성을 분석하는 중…";
  $("code-graph-status").className = "graph-status-pill";
  try {
    const data = await api("code-graph?" + new URLSearchParams({ path }));
    if (request !== codeGraphRequest) return;
    codeGraphData = data;
    codeGraphNodes = new Map(data.nodes.map((node) => [node.id, node]));
    if (!codeGraphNodes.has(selectedCode)) selectedCode = null;
    rebuildCodeView();
    drawCodeGraph();
    if (!data.nodes.length) {
      $("code-graph-status").textContent = "분석할 Python, C++, Java 파일이 없습니다.";
    }
    if (selectedCode) drawCodeNodeDetail();
    else drawCodeSummary();
  } catch (error) {
    if (request !== codeGraphRequest) return;
    $("code-graph-status").textContent = error.message;
    $("code-graph-status").classList.add("error");
  } finally {
    if (request === codeGraphRequest) codeGraphLoading = false;
  }
}

function codeNodeButton(node, action, className = "") {
  const item = button("", action, "code-node " + className);
  item.title = node.path + (node.line ? ":" + node.line : "");
  item.append(element("span", CODE_KIND_LABELS[node.kind]?.[0] || "?", "code-kind kind-" + node.kind),
    element("span", node.kind === "file" ? node.path : node.qualname, "code-node-name"));
  return item;
}

function drawCodeNodeList() {
  const query = $("code-graph-search").value.trim().toLowerCase();
  const visible = new Set(codeGraphView.nodes.map((node) => node.id));
  if (!query) {
    $("code-node-list").replaceChildren();
    $("code-node-list").hidden = true;
    return;
  }
  const matches = (codeGraphData?.nodes || []).filter((node) =>
    (node.qualname + " " + node.path).toLowerCase().includes(query)).slice(0, 80);
  const items = matches.map((node) => {
    const item = codeNodeButton(node, () => selectCodeNode(node.id, true),
      (node.id === selectedCode ? "selected " : "") + (visible.has(node.id) ? "" : "filtered"));
    return item;
  });
  if (!items.length) items.push(element("p", "일치하는 노드가 없습니다.", "notice"));
  $("code-node-list").hidden = false;
  $("code-node-list").replaceChildren(...items);
}

function drawCodeSummary() {
  const panel = $("code-node-detail");
  if (!codeGraphData) return panel.replaceChildren();
  const languages = Object.entries(codeGraphData.languages)
    .map(([language, count]) => `${CODE_LANGUAGE_LABELS[language] || language} ${count}개`).join(" · ");
  const children = [element("h2", "분석 요약"),
    element("p", `${codeGraphData.root} · ${languages || "지원 언어 파일 없음"}`),
    element("p", "노드를 클릭하거나 검색해 의존 관계를 확인하세요. 파일은 사각형, 클래스는 마름모, 함수는 원, 변수는 작은 원으로 표시됩니다.")];
  const warnings = [...codeGraphData.errors, ...codeGraphData.skipped];
  if (warnings.length) {
    children.push(element("p", "분석 경고"));
    const list = element("ul");
    for (const warning of warnings.slice(0, 30)) {
      const item = element("li");
      item.append(button(warning.path + (warning.line ? ":" + warning.line : ""),
        () => openCodeLocation(warning.path, warning.line), "quiet"), element("small", " " + warning.message));
      list.append(item);
    }
    children.push(list);
  }
  panel.replaceChildren(...children);
}

function selectCodeNode(id, center = false) {
  if (!codeGraphNodes.has(id)) return;
  selectedCode = selectedCode === id && !center ? null : id;
  if (codeGraphView.neighborhood !== undefined && $("code-graph-neighborhood").checked) {
    rebuildCodeView();
  }
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
  header.append(element("span", CODE_KIND_LABELS[node.kind], "code-kind-pill kind-" + node.kind),
    element("span", CODE_LANGUAGE_LABELS[node.language] || "", "code-language"));
  const location = node.path + (node.line && node.kind !== "file" ? ":" + node.line : "");
  const actions = element("div", undefined, "code-detail-actions");
  actions.append(button("파일 열기", () => openCodeLocation(node.path, node.kind === "file" ? null : node.line)),
    button("주변만 보기", () => {
      $("code-graph-neighborhood").checked = true;
      refreshCodeView();
      codeGraph.fit();
    }, "quiet"), button("선택 해제", () => selectCodeNode(node.id), "quiet"));
  const children = [header, element("h2", node.kind === "file" ? node.name : node.qualname),
    element("p", location, "code-location"), actions];
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of codeGraphData.edges) {
    if (edge.from === node.id) {
      if (!outgoing.has(edge.kind)) outgoing.set(edge.kind, []);
      outgoing.get(edge.kind).push(edge);
    } else if (edge.to === node.id) {
      if (!incoming.has(edge.kind)) incoming.set(edge.kind, []);
      incoming.get(edge.kind).push(edge);
    }
  }
  const section = (map, direction) => {
    for (const kind of ["imports", "inherits", "calls", "reads", "writes", "contains", "declares"]) {
      const list = map.get(kind);
      if (!list?.length) continue;
      const title = element("p", CODE_EDGE_LABELS[kind][direction] + " " + list.length, "code-edge-title edge-" + kind);
      const items = element("ul");
      for (const edge of list.slice(0, 200)) {
        const other = codeGraphNodes.get(direction === 0 ? edge.to : edge.from);
        if (!other) continue;
        const item = element("li");
        item.append(codeNodeButton(other, () => selectCodeNode(other.id, true)));
        if (edge.count > 1) item.append(element("small", "×" + edge.count, "code-edge-count"));
        items.append(item);
      }
      children.push(title, items);
    }
  };
  section(outgoing, 0);
  section(incoming, 1);
  if (!outgoing.size && !incoming.size) children.push(element("p", "추적된 의존 관계가 없습니다."));
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

$("code-graph-form").addEventListener("submit", (event) => {
  event.preventDefault();
  analyzeCode();
});
document.querySelector(".code-graph-filters").addEventListener("change", () => refreshCodeView());
$("code-graph-search").addEventListener("input", () => drawCodeNodeList());
$("code-graph-search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $("code-node-list").querySelector("button")?.click();
});
$("code-graph-zoom-in").onclick = () => codeGraph.zoom(1.25);
$("code-graph-zoom-out").onclick = () => codeGraph.zoom(.8);
$("code-graph-fit").onclick = () => codeGraph.fit();
$("code-graph-open").onclick = () => showCodeGraph();

boot();
