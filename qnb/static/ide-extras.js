"use strict";

/* IDE conveniences: Git decorations, binary previews, and paste / drag-and-drop uploads. */

/* ============================== GIT ============================== */
window.QNBGit = (() => {
  const PRIORITY = { conflict: 7, deleted: 6, modified: 5, staged: 4, renamed: 4, added: 3, untracked: 2, ignored: 1 };
  const LETTER = { conflict: "!", deleted: "D", modified: "M", staged: "M", renamed: "R", added: "A", untracked: "U" };
  const LABEL = {
    conflict: "병합 충돌", deleted: "삭제됨", modified: "수정됨 (스테이징 안 됨)", staged: "수정됨 (스테이징됨)",
    renamed: "이름 변경됨", added: "새로 추가됨 (스테이징됨)", untracked: "추적되지 않음", ignored: ".gitignore로 무시됨",
  };
  let state = null;
  let timer = null;
  let request = 0;

  function aggregate(result) {
    const exact = new Map();
    const nested = new Map();
    const ancestors = [];
    for (const [path, kind, isDir] of result.files || []) {
      exact.set(path, kind);
      if (isDir && (kind === "ignored" || kind === "untracked") && folder.startsWith(path + "/")) ancestors.push(kind);
      if (kind === "ignored") continue;
      let parent = dirname(path);
      while (parent.length > folder.length || parent === folder) {
        if (parent === folder) break;
        if ((PRIORITY[nested.get(parent)] || 0) < PRIORITY[kind]) nested.set(parent, kind);
        parent = dirname(parent);
      }
    }
    const inherited = ancestors.includes("ignored") ? "ignored" : ancestors.includes("untracked") ? "untracked" : null;
    return { ...result, exact, nested, inherited, subrepos: new Set(result.subrepos || []), folder };
  }

  function renderBar() {
    const bar = $("git-bar");
    if (!state || (!state.repo && !state.subrepos.size)) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    bar.hidden = false;
    if (!state.repo) {
      bar.replaceChildren(element("span", `Git 저장소 ${state.subrepos.size}개 · 폴더에 ⎇ 표시`, "git-bar-muted"));
      return;
    }
    const changes = [...state.exact.values()].filter((kind) => kind !== "ignored").length;
    const branch = element("span", "⎇ " + (state.branch || "HEAD"), "git-branch");
    branch.title = `저장소: /workspace${state.repo === "/" ? "" : state.repo}` + (state.upstream ? `\n업스트림: ${state.upstream}` : "");
    const parts = [branch];
    if (state.ahead) parts.push(element("span", `↑${state.ahead}`, "git-sync"));
    if (state.behind) parts.push(element("span", `↓${state.behind}`, "git-sync"));
    const summary = element("span", changes ? `변경 ${changes}${state.truncated ? "+" : ""}` : "작업 트리 깨끗함", changes ? "git-changes" : "git-bar-muted");
    parts.push(summary);
    const refresh = button("↻", () => refresh(0), "git-refresh", "Git 상태 새로 고침");
    parts.push(refresh);
    bar.replaceChildren(...parts);
  }

  function decorate(row, path, type) {
    row.classList.remove(...[...row.classList].filter((name) => name.startsWith("git-")));
    row.querySelector(".git-badge")?.remove();
    if (!state || state.folder !== folder) return;
    const name = basename(path);
    if (type === "directory" && state.subrepos.has(name)) {
      const badge = element("span", "⎇", "git-badge git-repo-badge");
      badge.title = "Git 저장소";
      row.querySelector(".file-name")?.after(badge);
      row.classList.add("git-repo");
      return;
    }
    if (!state.repo) return;
    let kind = state.exact.get(path) || state.inherited;
    let viaChild = false;
    if (!kind && type === "directory" && state.nested.has(path)) { kind = state.nested.get(path); viaChild = true; }
    if (name === ".git" && type === "directory") kind = "ignored";
    if (!kind) {
      row.title = path + "\nGit: 추적 중 · 변경 없음";
      return;
    }
    row.classList.add("git-" + kind);
    row.title = path + "\nGit: " + (viaChild ? "하위 항목 " : "") + LABEL[kind];
    if (kind === "ignored") return;
    const badge = element("span", viaChild ? "●" : LETTER[kind], "git-badge");
    badge.title = LABEL[kind];
    row.querySelector(".file-name")?.after(badge);
  }

  async function load() {
    const current = ++request;
    const target = folder;
    try {
      const result = await vmRequest("git", { operation: "status", path: target });
      if (current !== request || target !== folder) return;
      state = aggregate(result);
    } catch {
      if (current !== request) return;
      state = null;
    }
    renderBar();
    for (const row of document.querySelectorAll("#file-list .file-row")) {
      decorate(row, row.dataset.path, row.dataset.type);
    }
  }

  function refresh(delay = 250) {
    clearTimeout(timer);
    if (state && state.folder !== folder) { state = null; renderBar(); }
    timer = setTimeout(() => { if (!document.hidden) load(); }, delay);
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && ideInitialized) refresh(); });
  return { refresh, decorate, get state() { return state; } };
})();

/* ============================ PREVIEW ============================ */
window.QNBPreview = (() => {
  const KIND_LABEL = { image: "이미지", pdf: "PDF 문서", audio: "오디오", video: "동영상" };

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
    return (bytes / 1024 / 1024).toFixed(2) + " MiB";
  }

  async function fetchBlob(path) {
    const result = await vmRequest("workspace", { operation: "read_binary", path });
    return new Blob([result.bytes], { type: QNBFileIcons.mimeType(path) });
  }

  async function open(path) {
    const kind = QNBFileIcons.previewKind(path);
    status(`${basename(path)} 미리 보기를 불러오는 중…`);
    try {
      const blob = await fetchBlob(path);
      const existing = tabs.get(path);
      if (existing?.preview) URL.revokeObjectURL(existing.preview.url);
      tabs.set(path, {
        path, dirty: false, collaborators: [], feedback: new Map(),
        preview: { kind, url: URL.createObjectURL(blob), size: blob.size, label: `${KIND_LABEL[kind]} · 읽기 전용`, actual: false },
      });
      status("");
      selectFile(path);
    } catch (error) {
      status(error.message, true);
    }
  }

  function render(tab) {
    const { kind, url, size } = tab.preview;
    const body = $("file-preview-body");
    const info = $("file-preview-info");
    const zoom = $("file-preview-zoom");
    const download = $("file-preview-download");
    download.href = url;
    download.download = basename(tab.path);
    info.textContent = `${KIND_LABEL[kind]} · ${formatSize(size)}`;
    zoom.hidden = kind !== "image";
    let node = body.firstElementChild;
    if (!node || node.dataset.url !== url) {
      if (kind === "image") {
        node = document.createElement("img");
        node.alt = basename(tab.path);
        node.onload = () => { info.textContent = `이미지 · ${node.naturalWidth}×${node.naturalHeight}px · ${formatSize(size)}`; };
      } else if (kind === "pdf") {
        node = document.createElement("iframe");
        node.title = basename(tab.path) + " PDF 미리 보기";
      } else {
        node = document.createElement(kind);
        node.controls = true;
      }
      node.src = url;
      node.dataset.url = url;
      body.replaceChildren(node);
    }
    body.className = "file-preview-body preview-" + kind + (tab.preview.actual ? " actual-size" : "");
    zoom.textContent = tab.preview.actual ? "창에 맞추기" : "실제 크기";
  }

  $("file-preview-zoom").onclick = () => {
    const tab = activeTab();
    if (!tab?.preview) return;
    tab.preview.actual = !tab.preview.actual;
    render(tab);
  };
  $("file-preview-reload").onclick = () => {
    const tab = activeTab();
    if (tab?.preview) open(tab.path);
  };

  /* Markdown previews: load relative images (e.g. pasted screenshots) from the VM as blob URLs. */
  const imageCache = new Map(); // workspace path -> { at, promise }
  const IMAGE_TTL = 15000;

  function resolveRelative(baseDir, src) {
    let clean = src.split(/[?#]/)[0];
    try { clean = decodeURIComponent(clean); } catch { /* keep raw */ }
    const parts = clean.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
    for (const piece of clean.split("/")) {
      if (!piece || piece === ".") continue;
      if (piece === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(piece);
    }
    return "/" + parts.join("/");
  }

  function resolveMarkdownImage(image, src, documentPath) {
    const target = resolveRelative(dirname(documentPath), src);
    if (!target || QNBFileIcons.previewKind(target) !== "image") {
      image.alt = image.alt || src;
      return;
    }
    let cached = imageCache.get(target);
    if (!cached || Date.now() - cached.at > IMAGE_TTL) {
      const promise = fetchBlob(target).then((blob) => URL.createObjectURL(blob));
      if (cached) cached.promise.then((old) => setTimeout(() => URL.revokeObjectURL(old), IMAGE_TTL)).catch(() => {});
      cached = { at: Date.now(), promise };
      imageCache.set(target, cached);
      promise.catch(() => imageCache.delete(target));
    }
    image.classList.add("md-loading");
    cached.promise.then((url) => { image.src = url; }).catch(() => {
      image.alt = (image.alt || src) + " (불러올 수 없음)";
    }).finally(() => image.classList.remove("md-loading"));
  }

  /* HTML files: render in a fully sandboxed frame (no scripts, no same-origin access).
   * Local images and stylesheets are inlined because the sandbox cannot reach the VM itself. */
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  let htmlRender = 0;

  async function renderHtml(target, text, documentPath) {
    const ticket = ++htmlRender;
    const doc = new DOMParser().parseFromString(text, "text/html");
    for (const node of doc.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv]")) node.remove();
    for (const node of doc.querySelectorAll("*")) {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) {
          node.removeAttribute(attr.name);
        }
      }
    }
    const base = dirname(documentPath);
    const local = (value) => value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value.trim());
    const jobs = [];
    for (const img of doc.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src");
      if (!local(src)) continue;
      const target2 = resolveRelative(base, src);
      img.removeAttribute("src");
      if (target2 && QNBFileIcons.previewKind(target2) === "image") {
        jobs.push(fetchBlob(target2).then(blobToDataUrl).then((url) => img.setAttribute("src", url)).catch(() => img.setAttribute("alt", src + " (불러올 수 없음)")));
      }
    }
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const href = link.getAttribute("href");
      if (!local(href)) { link.remove(); continue; }
      const target2 = resolveRelative(base, href);
      jobs.push(vmRequest("workspace", { operation: "read", path: target2 }).then((file) => {
        const style = doc.createElement("style");
        style.textContent = file.text;
        link.replaceWith(style);
      }).catch(() => link.remove()));
    }
    await Promise.all(jobs);
    if (ticket !== htmlRender) return;
    let frame = target.querySelector("iframe.html-render");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "html-render";
      frame.setAttribute("sandbox", "");
      frame.title = "HTML 렌더링 미리 보기 (스크립트 비활성화)";
      const note = element("div", "보안을 위해 스크립트는 실행하지 않고 HTML · CSS만 렌더링합니다.", "html-render-note");
      target.replaceChildren(note, frame);
    }
    frame.srcdoc = "<!doctype html>\n" + doc.documentElement.outerHTML;
  }

  return { open, render, resolveMarkdownImage, renderHtml };
})();

/* ===================== UPLOAD STATE (translucent → opaque) ===================== */
window.QNBUploads = (() => {
  const items = new Map(); // workspace path -> { name, size, progress, state }
  const tray = $("upload-tray");

  function paint(path) {
    for (const node of document.querySelectorAll(`[data-upload-path="${CSS.escape(path)}"]`)) paintNode(node, items.get(path));
  }

  function paintNode(node, item) {
    node.classList.toggle("uploading", item?.state === "uploading");
    node.classList.toggle("upload-done", item?.state === "done");
    node.classList.toggle("upload-failed", item?.state === "error");
    const bar = node.querySelector(".upload-progress > i");
    if (bar && item) bar.style.width = Math.round(item.progress * 100) + "%";
    const label = node.querySelector(".upload-state");
    if (label && item) label.textContent = item.state === "done" ? "✓ 완료" : item.state === "error" ? "실패" : `${Math.round(item.progress * 100)}%`;
  }

  function decorate(row, path) {
    const item = items.get(path);
    row.querySelector(".upload-progress")?.remove();
    row.querySelector(".upload-state")?.remove();
    if (!item) { delete row.dataset.uploadPath; return; }
    row.dataset.uploadPath = path;
    const progress = element("span", undefined, "upload-progress");
    progress.append(document.createElement("i"));
    row.querySelector(".file-name")?.after(element("span", "", "upload-state"));
    row.append(progress);
    paintNode(row, item);  // the row may not be attached to the document yet
  }

  function virtualRows(currentFolder, existing) {
    const rows = [];
    for (const [path, item] of items) {
      if (dirname(path) !== currentFolder || existing.has(path) || item.state === "error") continue;
      const row = element("div", undefined, "file-row upload-virtual");
      row.dataset.path = path;
      row.title = `${path} 업로드 중…`;
      row.append(QNBFileIcons.create(path, "file"), element("span", basename(path), "file-name"));
      decorate(row, path);
      rows.push(row);
    }
    return rows;
  }

  function renderTray() {
    const visible = [...items.entries()];
    tray.hidden = !visible.length;
    tray.replaceChildren(...visible.map(([path, item]) => {
      const row = element("div", undefined, "upload-tray-item");
      row.dataset.uploadPath = path;
      row.append(QNBFileIcons.create(path, "file"), element("span", basename(path), "upload-tray-name"), element("span", "", "upload-state"));
      const progress = element("span", undefined, "upload-progress");
      progress.append(document.createElement("i"));
      row.append(progress);
      paintNode(row, items.get(path));
      return row;
    }));
  }

  function start(path, size) {
    items.set(path, { size, progress: 0, state: "uploading" });
    renderTray();
    if (dirname(path) === folder) renderEntries();
  }

  function progress(path, value) {
    const item = items.get(path);
    if (!item) return;
    item.progress = value;
    paint(path);
  }

  function finish(path, ok) {
    const item = items.get(path);
    if (!item) return;
    item.state = ok ? "done" : "error";
    item.progress = ok ? 1 : item.progress;
    paint(path);
    setTimeout(() => {
      items.delete(path);
      renderTray();
      if (dirname(path) === folder) renderEntries();
    }, ok ? 2200 : 4000);
  }

  function cancel(path) {
    items.delete(path);
    renderTray();
    if (dirname(path) === folder) renderEntries();
  }

  return { decorate, virtualRows, start, progress, finish, cancel };
})();

/* ===================== UPLOAD CONFIRMATION ===================== */
window.QNBUploadConfirm = (() => {
  const dialog = $("upload-dialog");
  const KB = 1024;
  const size = (n) => (n < KB ? `${n} B` : n < KB * KB ? `${(n / KB).toFixed(1)} KiB` : `${(n / KB / KB).toFixed(2)} MiB`);

  function ask(files, directory, { linkTarget = null } = {}) {
    const real = files.filter(([, file]) => file);
    const folders = files.filter(([, file]) => !file).length;
    const urls = [];
    const list = $("upload-dialog-list");
    list.replaceChildren(...real.slice(0, 30).map(([rel, file]) => {
      const li = element("li", undefined, "upload-dialog-item");
      if (file.type.startsWith("image/") && file.size < 15 * KB * KB) {
        const img = document.createElement("img");
        const url = URL.createObjectURL(file);
        urls.push(url);
        img.src = url;
        img.alt = "";
        li.append(img);
      } else {
        li.append(QNBFileIcons.create(file.name || "file", "file"));
      }
      const name = (rel ? rel + "/" : "") + (file.name || "클립보드 이미지");
      li.append(element("span", name, "upload-dialog-name"), element("span", size(file.size), "upload-dialog-size"));
      if (file.size > 8 * KB * KB) li.append(element("span", "8 MiB 초과", "upload-dialog-too-big"));
      return li;
    }));
    if (real.length > 30) list.append(element("li", `… 외 ${real.length - 30}개`, "upload-dialog-more"));
    const total = real.reduce((sum, [, file]) => sum + file.size, 0);
    $("upload-dialog-target").textContent = "업로드 위치: /workspace" + (directory === "/" ? "" : directory);
    $("upload-dialog-summary").textContent = `파일 ${real.length}개${folders ? ` · 폴더 ${folders}개` : ""} · 총 ${size(total)}` +
      (linkTarget ? ` · ${basename(linkTarget)}에 링크를 삽입합니다` : "");
    $("upload-dialog-title").textContent = real.length === 1 ? "이 파일을 업로드할까요?" : `${real.length}개 파일을 업로드할까요?`;
    return new Promise((resolve) => {
      dialog.returnValue = "";
      dialog.addEventListener("close", () => {
        for (const url of urls) URL.revokeObjectURL(url);
        resolve(dialog.returnValue === "upload");
      }, { once: true });
      dialog.showModal();
      $("upload-dialog-confirm").focus();
    });
  }

  return { ask };
})();

/* ===================== PASTE / DROP UPLOADS ===================== */
(() => {
  const MAX_SIZE = 8 * 1024 * 1024;
  const MAX_FILES = 200;
  const EXT_BY_MIME = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
    "image/bmp": "bmp", "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv",
    "application/json": "json", "application/zip": "zip",
  };

  function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function cleanName(file, index) {
    let name = (file.name || "").replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
    // Browsers name raw clipboard bitmaps "image.png"; give them a unique, sortable name.
    if (!name || /^image\.(png|jpe?g|gif|webp)$/i.test(name)) {
      const ext = EXT_BY_MIME[file.type] || name.split(".").at(-1) || "bin";
      name = `pasted-${stamp()}${index ? "-" + index : ""}.${ext}`;
    }
    if (name === "." || name === "..") name = "_" + name;
    while (new TextEncoder().encode(name).length > 200) name = name.slice(0, -1);
    return name;
  }

  function withSuffix(name, n) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  }

  async function uploadOne(file, directory, index = 0) {
    if (file.size > MAX_SIZE) throw new Error(`${file.name || "파일"}: 8 MiB를 초과해 업로드할 수 없습니다.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const base = cleanName(file, index);
    const taken = directory === folder ? new Set(entries.map(([n]) => n)) : new Set();
    for (let attempt = 0; attempt < 50; attempt++) {
      const name = attempt ? withSuffix(base, attempt) : base;
      if (taken.has(name)) continue;
      const target = join(directory, name);
      QNBUploads.start(target, bytes.length);
      try {
        await vmRequest("workspace", { operation: "upload_stream", path: target, size: bytes.length }, bytes,
          (value) => QNBUploads.progress(target, Math.min(0.99, value)));
        QNBUploads.finish(target, true);
        return target;
      } catch (error) {
        if (error.status === 409) { QNBUploads.cancel(target); continue; }  // name taken: try the next suffix
        QNBUploads.finish(target, false);
        throw error;
      }
    }
    throw new Error(`${base}: 사용할 수 있는 파일 이름을 찾지 못했습니다.`);
  }

  async function ensureDirectory(path) {
    try {
      await vmRequest("workspace", { operation: "mkdir", path });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  /* Expand dropped folders (FileSystemEntry API) into [relativeDir, File] pairs. */
  async function collect(items) {
    const out = [];
    const readAll = (reader) => new Promise((resolve, reject) => {
      const all = [];
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
      next();
    });
    async function walk(entry, prefix) {
      if (out.length >= MAX_FILES) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        out.push([prefix, file]);
      } else if (entry.isDirectory) {
        const dir = prefix ? prefix + "/" + entry.name : entry.name;
        out.push([dir, null]);
        for (const child of await readAll(entry.createReader())) await walk(child, dir);
      }
    }
    for (const entry of items) await walk(entry, "");
    return out;
  }

  function relativePath(fromDir, target) {
    const from = fromDir.split("/").filter(Boolean);
    const to = target.split("/").filter(Boolean);
    while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
    const rel = [...from.map(() => ".."), ...to].join("/");
    return rel.split("/").map(encodeURIComponent).join("/");
  }

  function focusedEditor() {
    for (const editor of editors.values()) if (editor.view.hasFocus) return editor.view;
    return null;
  }

  function insertLinks(view, tab, uploaded) {
    const markdownCell = view?.dom.closest(".cell")?.classList.contains("cell-markdown");
    const markdownTarget = tab && (fileLanguage(tab.path) === "markdown" || (isNotebook(tab.path) && markdownCell));
    if (!view || !markdownTarget) return false;
    const text = uploaded.map(([file, target]) => {
      const rel = relativePath(dirname(tab.path), target);
      const alt = basename(target).replace(/[[\]]/g, "");
      return file.type.startsWith("image/") ? `![${alt}](${rel})` : `[${alt}](${rel})`;
    }).join("\n");
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
    return true;
  }

  async function upload(files, directory, { view = null, openSingle = true } = {}) {
    if (!files.length) return;
    if (files.length > MAX_FILES) { status(`한 번에 최대 ${MAX_FILES}개 파일까지 업로드할 수 있습니다.`, true); return; }
    const tab = activeTab();
    const selection = view ? view.state.selection.main : null;
    const linkTarget = view && tab && (fileLanguage(tab.path) === "markdown" || isNotebook(tab.path)) ? tab.path : null;
    if (!(await QNBUploadConfirm.ask(files, directory, { linkTarget }))) {
      status("업로드를 취소했습니다.");
      view?.focus();
      return;
    }
    if (view && selection) view.dispatch({ selection: { anchor: selection.anchor, head: selection.head } });
    const uploaded = [];
    const failures = [];
    let index = 0;
    for (const [rel, file] of files) {
      const dir = rel ? join(directory, rel) : directory;
      try {
        if (!file) { await ensureDirectory(dir); continue; }
        status(`업로드 중 (${uploaded.length + 1}/${files.filter(([, f]) => f).length}) · ${file.name || "클립보드"}…`);
        uploaded.push([file, await uploadOne(file, dir, files.length > 1 ? ++index : 0)]);
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (directory === folder || files.some(([rel]) => rel)) await showFolder(folder);
    const linked = uploaded.length && insertLinks(view, tab, uploaded);
    if (failures.length) status(failures[0] + (failures.length > 1 ? ` 외 ${failures.length - 1}건` : ""), true);
    else if (uploaded.length) {
      const where = "/workspace" + (directory === "/" ? "" : directory);
      status(`${uploaded.length}개 파일을 ${where}에 업로드했습니다.` + (linked ? " 링크를 삽입했습니다." : ""));
    }
    if (openSingle && !linked && uploaded.length === 1 && QNBFileIcons.previewKind(uploaded[0][1])) {
      openFile(uploaded[0][1]);
    }
  }

  function workspaceActive() {
    return !$("ide").hidden && ideInitialized && !standaloneProofPage && !busy;
  }

  function editorTargetDir(view) {
    const tab = activeTab();
    return view && tab && !tab.preview ? dirname(tab.path) : folder;
  }

  document.addEventListener("paste", (event) => {
    if (!workspaceActive()) return;
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    const target = event.target;
    const inField = target instanceof HTMLElement && target.closest("input, textarea, dialog, .channels-panel");
    if (inField) return;
    event.preventDefault();
    const view = focusedEditor();
    upload(files.map((file) => ["", file]), editorTargetDir(view), { view });
  });

  /* ---- drag & drop on the explorer and the editor area ---- */
  let dragDepth = 0;
  const sidebar = $("sidebar");
  const workbench = document.querySelector(".workbench");

  function hasFiles(event) {
    return [...(event.dataTransfer?.types || [])].includes("Files");
  }

  function dropFolderFor(event) {
    const row = event.target instanceof Element ? event.target.closest(".file-row") : null;
    return row?.dataset.type === "directory" ? row.dataset.path : folder;
  }

  function highlight(zone, on, event) {
    zone.classList.toggle("drop-active", on);
    for (const row of document.querySelectorAll(".file-row.drop-target")) row.classList.remove("drop-target");
    if (on && zone === sidebar && event) {
      const row = event.target instanceof Element ? event.target.closest(".file-row") : null;
      if (row?.dataset.type === "directory") row.classList.add("drop-target");
    }
  }

  for (const zone of [sidebar, workbench]) {
    zone.addEventListener("dragenter", (event) => {
      if (!hasFiles(event) || !workspaceActive()) return;
      event.preventDefault();
      dragDepth++;
      highlight(zone, true, event);
    });
    zone.addEventListener("dragover", (event) => {
      if (!hasFiles(event) || !workspaceActive()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      highlight(zone, true, event);
    });
    zone.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) highlight(zone, false);
    });
    zone.addEventListener("drop", async (event) => {
      if (!hasFiles(event) || !workspaceActive()) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      highlight(zone, false);
      const entriesList = [...(event.dataTransfer.items || [])]
        .map((item) => item.kind === "file" && item.webkitGetAsEntry?.())
        .filter(Boolean);
      let files;
      try {
        files = entriesList.length ? await collect(entriesList) : [...event.dataTransfer.files].map((f) => ["", f]);
      } catch {
        files = [...event.dataTransfer.files].map((f) => ["", f]);
      }
      if (zone === sidebar) {
        upload(files, dropFolderFor(event), { openSingle: false });
      } else {
        const cm = event.target instanceof Element ? event.target.closest(".cm-editor") : null;
        let view = null;
        if (cm) for (const editor of editors.values()) if (editor.view.dom === cm) view = editor.view;
        if (view) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos !== null) view.dispatch({ selection: { anchor: pos } });
        }
        upload(files, editorTargetDir(view), { view });
      }
    });
  }

  /* Prevent the browser from navigating away when a file is dropped elsewhere. */
  window.addEventListener("dragover", (event) => { if (hasFiles(event) && !$("ide").hidden) event.preventDefault(); });
  window.addEventListener("drop", (event) => { if (hasFiles(event) && !$("ide").hidden) event.preventDefault(); });

  /* An explicit upload button in the explorer header. */
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  document.body.append(input);
  input.onchange = () => {
    const picked = [...input.files].map((f) => ["", f]);
    input.value = "";
    upload(picked, folder, { openSingle: true });
  };
  $("upload-files")?.addEventListener("click", () => { if (workspaceActive()) input.click(); });
})();
