"use strict";

const $ = (id) => document.getElementById(id);
const tabs = new Map();
let active = null;
let folder = "/";
let cursor = null;
let entries = [];
let graphVisible = false;
let graphPage = 0;
let graphData = { nodes: [], edges: [] };
let selectedTheorem = null;
let graphAreas = [];
let busy = false;
let authMode = "signup";
let fileAction;
let listRequest = 0;
let graphRequest = 0;

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
  if (!response.ok) throw new Error(data.error || "요청에 실패했습니다 (" + response.status + ").");
  return data;
}

const FILE_LIMIT = 131072;
const FILE_CHUNK_SIZE = 98304;
const LARGE_FILE_LIMIT = 8 * 1024 * 1024;

function vmRequest(resource, payload, upload) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/vm/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    let submitted = false;
    let settled = false;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunks = [];
    let uploadOffset = 0;

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimeout);
      socket.close();
      callback(value);
    }

    function disconnected() {
      if (settled) return;
      if (submitted) {
        finish(reject, new Error("결과를 받기 전에 연결이 끊겼습니다. VM에서 작업이 계속될 수 있습니다."));
      } else {
        finish(reject, new Error("VM WebSocket 연결을 열 수 없습니다."));
      }
    }

    const handshakeTimeout = setTimeout(disconnected, 3000);
    socket.onopen = () => {
      if (settled) return;
      clearTimeout(handshakeTimeout);
      try {
        socket.send(JSON.stringify({ ...payload, resource }));
        submitted = true;
      } catch {
        disconnected();
      }
    };
    socket.onmessage = ({ data }) => {
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
          finish(reject, new Error(response?.error || "올바르지 않은 VM 응답입니다."));
        }
      } catch {
        finish(reject, new Error("UTF-8 파일을 읽을 수 없거나 VM 전송 응답이 올바르지 않습니다."));
      }
    };
    socket.onerror = socket.onclose = disconnected;
  });
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", error);
}

function alertIn(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function setAuth(mode) {
  authMode = mode;
  const signingUp = mode === "signup";
  $("auth-title").textContent = signingUp ? "회원가입" : "로그인";
  $("auth-submit").textContent = signingUp ? "가입하고 시작" : "로그인";
  $("auth-toggle").textContent = signingUp ? "이미 계정이 있나요? 로그인" : "처음인가요? 회원가입";
  $("password").autocomplete = signingUp ? "new-password" : "current-password";
  alertIn("auth-error");
}

function openAuth(mode) {
  setAuth(mode);
  if (!$("auth-dialog").open) $("auth-dialog").showModal();
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
    const session = await api("session");
    const inIDE = Boolean(session.email && location.pathname === "/ide");
    $("home").hidden = inIDE;
    $("ide").hidden = !inIDE;
    $("account-label").textContent = session.email || "";
    $("logout").hidden = !session.email;
    $("header-login").hidden = Boolean(session.email);
    $("signup-open").hidden = Boolean(session.email);
    $("login-open").hidden = Boolean(session.email);
    $("ide-link").hidden = !session.email;
    if (inIDE) {
      renderWorkbench();
      await showFolder("/");
    } else if (location.pathname === "/ide") {
      openAuth("login");
    }
  } catch (error) {
    $("home").hidden = false;
    openAuth("login");
    alertIn("auth-error", error.message);
  }
}

$("signup-open").onclick = () => openAuth("signup");
$("login-open").onclick = $("header-login").onclick = () => openAuth("login");
$("auth-toggle").onclick = () => setAuth(authMode === "signup" ? "login" : "signup");
$("auth-close").onclick = () => $("auth-dialog").close();
$("auth-form").onsubmit = async (event) => {
  event.preventDefault();
  $("auth-submit").disabled = true;
  alertIn("auth-error");
  try {
    await api(authMode, { email: $("email").value, password: $("password").value });
    location.assign("/ide");
  } catch (error) {
    alertIn("auth-error", error.message);
    $("auth-submit").disabled = false;
  }
};
$("logout").onclick = async () => {
  if (busy) return;
  if (dirtyTabs() && !confirm("저장하지 않은 편집 내용이 있습니다. 로그아웃할까요?")) return;
  try {
    await api("logout", {});
    tabs.clear();
    location.assign("/");
  } catch (error) { status(error.message, true); }
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
    row.append(element("span", type === "directory" ? "▱" : isNotebook(path) ? "∴" : "·", "file-icon"), element("span", name));
    return row;
  });
  if (!rows.length) rows.push(element("div", "이 폴더가 비어 있습니다.", "notice"));
  $("file-list").replaceChildren(...rows);
}

async function showFolder(path, append = false) {
  const request = ++listRequest;
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
  } catch (error) {
    if (request !== listRequest) return;
    if (!entries.length) $("file-list").replaceChildren(element("div", "파일을 불러올 수 없습니다.", "notice"));
    vmStatus("error", "VM 파일 조회 실패");
    status(error.message, true);
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
  if (tabs.get(path).dirty && !confirm("저장하지 않은 변경 사항을 버릴까요?")) return;
  tabs.delete(path);
  if (active === path) active = [...tabs.keys()].at(-1) || null;
  renderWorkbench();
  renderEntries();
}

function renderTabs() {
  const items = [...tabs.values()].map((tab) => {
    const selected = tab.path === active && !graphVisible;
    const wrapper = element("div", undefined, "tab" + (selected ? " active" : ""));
    const select = button(basename(tab.path) + (tab.dirty ? " ●" : ""), () => selectFile(tab.path));
    select.title = tab.path;
    select.setAttribute("aria-pressed", selected);
    const close = button("×", () => closeFile(tab.path), "", basename(tab.path) + " 닫기");
    close.disabled = busy;
    wrapper.append(select, close);
    return wrapper;
  });
  if (graphVisible) {
    const wrapper = element("div", undefined, "tab active");
    wrapper.append(button("의존 그래프", () => showGraph(graphPage)), button("×", () => selectFile(active), "", "그래프 닫기"));
    items.push(wrapper);
  }
  $("tabs").replaceChildren(...items);
}

function markDirty(tab) {
  if (!tab.dirty) {
    tab.dirty = true;
    renderTabs();
  }
  if (activeTab() === tab && !graphVisible) $("editor-mode").textContent = "저장되지 않음";
}

function numbers() {
  const text = $("file-content");
  $("line-numbers").textContent = Array.from({ length: text.value.split("\n").length }, (_, n) => n + 1).join("\n");
  $("line-numbers").scrollTop = text.scrollTop;
}

function indent(event) {
  if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  const field = event.target;
  field.setRangeText("  ", field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new Event("input"));
}

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
    cells: [newCell("code", "lean4", "theorem identity (n : Nat) : n = n := by\n  rfl")],
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
  $("graph").hidden = !graphVisible;
  $("workspace-welcome").hidden = graphVisible || Boolean(tab);
  $("editor").hidden = graphVisible || !tab;
  $("editor-mode").textContent = "";
  if (!tab || graphVisible) return;
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
    renderNotebook(tab);
  } else {
    const field = $("file-content");
    field.value = tab.text;
    field.readOnly = busy;
    numbers();
  }
}

$("file-content").oninput = (event) => {
  const tab = activeTab();
  tab.text = event.target.value;
  tab.notebook = null;
  markDirty(tab);
  numbers();
};
$("file-content").onscroll = () => { $("line-numbers").scrollTop = $("file-content").scrollTop; };
$("file-content").onkeydown = indent;

async function saveTab(tab) {
  if (!tab.dirty) return;
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
  tab.dirty = false;
  renderTabs();
  if (activeTab() === tab && !graphVisible) $("editor-mode").textContent = "저장됨";
}

function setBusy(value) {
  busy = value;
  $("create-file").disabled = value;
  $("create-folder").disabled = value;
  $("folder-menu").disabled = value || folder === "/";
  $("new-notebook").disabled = value;
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
  $("entry-name").placeholder = action === "file" ? "예: Main.lean 또는 notes.ipynb" : "";
  $("name-label").hidden = action === "delete";
  $("dialog-delete").hidden = action !== "manage";
  $("dialog-submit").textContent = action === "manage" ? "이름 변경" : action === "delete" ? "삭제" : "만들기";
  $("dialog-submit").className = action === "delete" ? "danger" : "primary";
  alertIn("file-error");
  if (!$("file-dialog").open) $("file-dialog").showModal();
  if (action !== "delete") $("entry-name").select();
}

$("create-file").onclick = () => editEntry("file");
$("create-folder").onclick = () => editEntry("folder");
$("new-notebook").onclick = () => editEntry("notebook");
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
    let label = feedback.exitCode === 0 ? "실행 성공" : "실행 실패";
    if (feedback.saved?.length) label += " · 정리 저장 " + feedback.saved.join(", ");
    if (feedback.graphPending) label += " · 그래프 동기화 대기 중";
    if (feedback.error) label += " · " + feedback.error;
    output.append(element("div", label, "output-status" + (feedback.exitCode === 0 ? "" : " failed")));
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

function renderNotebook(tab) {
  const scroll = $("cells").scrollTop;
  let doc;
  try {
    doc = readNotebook(tab);
    alertIn("invalid-notebook");
  } catch (error) {
    alertIn("invalid-notebook", "노트북을 열 수 없습니다. JSON 편집에서 내용을 확인하세요.");
    $("cells").replaceChildren();
  }
  $("edit-json").disabled = busy;
  for (const id of ["add-code", "add-markdown", "prepare-python", "reset-python"]) $(id).disabled = busy || !doc;
  if (!doc) return;
  const cells = doc.cells.map((cell, index) => {
    const code = cell.cell_type === "code";
    const cellView = element("article", undefined, "cell");
    const header = element("div", undefined, "cell-head");
    header.append(element("span", (index + 1) + " · " + (code ? "코드" : cell.cell_type === "markdown" ? "Markdown" : "텍스트")));
    if (code) {
      const chooser = element("select");
      chooser.setAttribute("aria-label", (index + 1) + "번 셀 커널");
      const current = cellLanguage(doc, cell);
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
        renderNotebook(tab);
      };
      const run = button("▶ 실행", () => runCell(tab, cell, index), "primary");
      run.disabled = busy || !current;
      header.append(chooser, run);
    }
    header.append(element("div", undefined, "spacer"));
    for (const [label, title, delta] of [["↑", "셀 위로 이동", -1], ["↓", "셀 아래로 이동", 1]]) {
      const move = button(label, () => {
        const other = index + delta;
        [doc.cells[index], doc.cells[other]] = [doc.cells[other], doc.cells[index]];
        markDirty(tab);
        renderNotebook(tab);
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
    const field = element("textarea", undefined, "cell-input");
    field.setAttribute("aria-label", (index + 1) + "번 셀 소스");
    field.rows = Math.max(2, Math.min(sourceOf(cell).split("\n").length + 1, 12));
    field.spellcheck = false;
    field.readOnly = busy;
    field.value = sourceOf(cell);
    field.oninput = () => { cell.source = field.value; markDirty(tab); };
    field.onkeydown = (event) => {
      if (event.shiftKey && event.key === "Enter" && code && cellLanguage(doc, cell)) {
        event.preventDefault();
        runCell(tab, cell, index);
      } else indent(event);
    };
    cellView.append(header, field);
    if (code && (tab.feedback.has(cell) || cell.outputs?.length)) {
      cellView.append(renderOutput(cell, tab.feedback.get(cell)));
    }
    return cellView;
  });
  $("cells").replaceChildren(...cells);
  $("cells").scrollTop = scroll;
}

function appendCell(type) {
  const tab = activeTab();
  const doc = readNotebook(tab);
  const kernel = cellLanguage(doc, { metadata: {}, source: "" });
  if (doc.nbformat_minor < 5) {
    doc.nbformat_minor = 5;
    for (const cell of doc.cells) cell.id = cellId();
  }
  doc.cells.push(newCell(type, kernel || "python"));
  markDirty(tab);
  renderNotebook(tab);
  $("cells").querySelector(".cell:last-child textarea")?.focus();
}

$("add-code").onclick = () => appendCell("code");
$("add-markdown").onclick = () => appendCell("markdown");

function runCell(tab, cell, index) {
  runTask(async () => {
    await saveTab(tab);
    status("VM에서 셀을 실행하는 중…");
    const result = await vmRequest("kernel", { operation: "run", path: tab.path, etag: tab.etag, index });
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
    status("셀 결과를 받았습니다. 노트북을 저장하는 중…");
    try {
      await saveTab(tab);
    } catch (error) {
      status("셀 실행은 완료됐지만 노트북 저장에 실패했습니다. " + error.message, true);
      return;
    }
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

async function showGraph(page = 0) {
  graphVisible = true;
  graphPage = page;
  selectedTheorem = null;
  graphData = { nodes: [], edges: [] };
  const request = ++graphRequest;
  renderWorkbench();
  renderEntries();
  $("graph-status").textContent = "그래프 DB에서 정리를 불러오는 중…";
  $("graph-status").className = "notice";
  $("theorem-detail").replaceChildren();
  $("theorem-list").replaceChildren();
  $("previous-graph").disabled = $("next-graph").disabled = true;
  $("graph-page").textContent = (page + 1) + " 페이지";
  drawGraph();
  try {
    const data = await api("graph?page=" + page);
    if (request !== graphRequest || !graphVisible) return;
    graphData = data;
    const primary = data.nodes.filter((node) => node.primary);
    $("graph-status").textContent = primary.length
      ? primary.length + "개 정리 · " + data.edges.length + "개 의존 관계"
      : "저장된 정리가 없습니다. Lean 4 셀에서 이름이 있는 정리를 증명하세요.";
    $("previous-graph").disabled = page === 0;
    $("next-graph").disabled = !data.hasMore;
    drawTheoremList();
    drawGraph();
  } catch (error) {
    if (request !== graphRequest || !graphVisible) return;
    $("graph-status").textContent = error.message;
    $("graph-status").classList.add("error");
  }
}

function drawTheoremList() {
  const items = graphData.nodes.filter((node) => node.primary).map((node) => {
    const item = button(node.name, () => selectTheorem(node.id), node.id === selectedTheorem ? "selected" : "");
    item.setAttribute("aria-pressed", node.id === selectedTheorem);
    return item;
  });
  $("theorem-list").replaceChildren(...items);
}

async function selectTheorem(id) {
  const node = graphData.nodes.find((item) => item.id === id);
  if (!node) return;
  selectedTheorem = id;
  drawTheoremList();
  drawGraph();
  const panel = $("theorem-detail");
  const names = new Map(graphData.nodes.map((item) => [item.id, item.name]));
  const references = graphData.edges.filter((edge) => edge.from === id);
  panel.replaceChildren(element("h2", node.name));
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

function drawGraph() {
  const canvas = $("graph-canvas");
  const labels = new Map(graphData.nodes.map((node) => [node.id, node]));
  const primary = graphData.nodes.filter((node) => node.primary);
  const focused = selectedTheorem
    ? new Set([selectedTheorem, ...graphData.edges.filter((edge) => edge.to === selectedTheorem).map((edge) => edge.from)])
    : null;
  const edges = focused ? graphData.edges.filter((edge) => focused.has(edge.from)) : graphData.edges;
  const sources = focused ? primary.filter((node) => focused.has(node.id)) : primary;
  const targetIds = new Set(edges.map((edge) => edge.to));
  if (selectedTheorem && !sources.some((node) => node.id === selectedTheorem)) targetIds.add(selectedTheorem);
  const targets = [...targetIds].map((id) => labels.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const columns = targets.length ? 2 : 1;
  const width = Math.max(1, canvas.parentElement.clientWidth);
  const height = Math.max(352, 62 + Math.max(sources.length, targets.length) * 35);
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  graphAreas = [];
  if (!sources.length && !targets.length) return;
  ctx.fillStyle = "#a3adc1";
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText("정리", 14, 25);
  if (columns === 2) ctx.fillText("참조 대상", Math.floor(width * 0.57), 25);
  const nodeWidth = columns === 2 ? Math.max(42, Math.floor(width * 0.43) - 14) : Math.min(260, width - 28);
  const place = (nodes, x) => new Map(nodes.map((node, index) =>
    [node.id, { node, x, y: 40 + 35 * index, width: nodeWidth, height: 27 }]));
  const left = place(sources, 14);
  const right = place(targets, Math.floor(width * 0.57));
  const outgoing = edges.filter((edge) => left.has(edge.from) && right.has(edge.to));
  for (const edge of outgoing) {
    const source = left.get(edge.from);
    const target = right.get(edge.to);
    const emphatic = selectedTheorem === edge.to || selectedTheorem === edge.from;
    const x1 = source.x + nodeWidth, y1 = source.y + 13.5;
    const x2 = target.x, y2 = target.y + 13.5, middle = (x1 + x2) / 2;
    ctx.strokeStyle = emphatic ? "#bba7ff" : "#6f819c";
    ctx.lineWidth = emphatic ? 1.7 : 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(middle, y1, middle, y2, x2, y2);
    ctx.moveTo(x2 - 6, y2 - 4);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - 6, y2 + 4);
    ctx.stroke();
  }
  for (const area of [...left.values(), ...right.values()]) {
    const { x, y, width: w, height: h, node } = area;
    graphAreas.push(area);
    ctx.fillStyle = node.hash ? "#302646" : "#23344a";
    ctx.strokeStyle = node.id === selectedTheorem ? "#d0c3ff" : node.hash ? "#6e5895" : "#526982";
    ctx.lineWidth = node.id === selectedTheorem ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 5);
    ctx.fill();
    ctx.stroke();
    ctx.font = "13px monospace";
    ctx.fillStyle = "#edf1fc";
    let name = node.name;
    while (name.length > 1 && ctx.measureText(name + "…").width > w - 12) name = name.slice(0, -1);
    ctx.fillText(name === node.name ? name : name + "…", x + 7, y + 18, w - 12);
  }
}

$("graph-canvas").addEventListener("click", (event) => {
  const rect = event.target.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const area = graphAreas.find((item) => x >= item.x && x <= item.x + item.width &&
    y >= item.y && y <= item.y + item.height);
  if (area) {
    selectTheorem(area.node.id);
  } else {
    selectedTheorem = null;
    $("theorem-detail").replaceChildren();
    drawTheoremList();
    drawGraph();
  }
});
new ResizeObserver(() => {
  if (graphVisible) drawGraph();
}).observe($("graph-canvas").parentElement);
$("graph-open").onclick = () => showGraph();
$("refresh-graph").onclick = () => showGraph(graphPage);
$("previous-graph").onclick = () => showGraph(graphPage - 1);
$("next-graph").onclick = () => showGraph(graphPage + 1);

boot();
