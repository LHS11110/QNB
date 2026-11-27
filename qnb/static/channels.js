"use strict";

/* Workspace chat + voice channels. Everything goes through the server hub
 * (/api/channels/ws): text is persisted and broadcast, voice frames are relayed. */
window.QNBChannels = (() => {
  const panel = $("channels-panel");
  const openButton = $("channels-open");
  const unreadBadge = $("channels-unread");
  const VAD_THRESHOLD = 0.012;
  const VAD_HANGOVER_MS = 350;

  let socket = null;
  let connecting = null;
  let reconnectTimer = null;
  let wanted = false;
  let seq = 0;
  const pending = new Map();
  let selfSessionId = null;
  let channels = [];
  let categories = [];
  let members = [];
  let activeText = null;
  const histories = new Map(); // channel id -> messages[]
  const unread = new Map();
  const loadedHistory = new Set();

  const stats = { captured: 0, sent: 0, received: 0 };
  const voice = {
    channel: null, slot: 0, muted: false, deafened: false, ctx: null, stream: null,
    capture: null, playback: null, output: null, lastVoiceAt: 0, levels: {}, selfLevel: 0, rejoin: null,
  };

  /* ------------------------------ socket ------------------------------ */

  function url() {
    const u = new URL("/api/channels/ws", location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u;
  }

  function connect() {
    wanted = true;
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(url());
      ws.binaryType = "arraybuffer";
      const timeout = setTimeout(() => { ws.close(); reject(new Error("채널 서버 연결 시간이 초과되었습니다.")); }, 6000);
      ws.onopen = () => { clearTimeout(timeout); socket = ws; connecting = null; resolve(ws); };
      ws.onmessage = ({ data }) => {
        if (data instanceof ArrayBuffer) { receiveVoice(data); return; }
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        handle(msg);
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        connecting = null;
        if (socket === ws) socket = null;
        for (const [, p] of pending) p.reject(new Error("채널 연결이 끊겼습니다."));
        pending.clear();
        if (voice.channel) {
          voice.rejoin = voice.channel;
          voice.channel = null;
          voice.playback?.port.postMessage({ reset: true });
        }
        render();
        if (wanted && !reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wanted) connect().catch(() => {}); }, 2000);
        }
      };
      ws.onerror = () => {};
    });
    return connecting;
  }

  function disconnect() {
    wanted = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopVoice();
    voice.rejoin = null;
    if (socket) { try { socket.close(); } catch { /* ignore */ } }
    socket = null;
    connecting = null;
    channels = [];
    categories = [];
    members = [];
    histories.clear();
    messageNodes.clear();
    loadedHistory.clear();
    unread.clear();
    rowCache.clear();
    activeText = null;
    render();
  }

  async function request(type, payload = {}) {
    const ws = await connect();
    const reqId = "r" + (++seq);
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      try { ws.send(JSON.stringify({ reqId, type, ...payload })); }
      catch (error) { pending.delete(reqId); reject(error); }
    });
  }

  function handle(msg) {
    if (msg.replyTo) {
      const entry = pending.get(msg.replyTo);
      if (!entry) return;
      pending.delete(msg.replyTo);
      if (msg.error) { const e = new Error(msg.error); e.status = msg.status; entry.reject(e); }
      else entry.resolve(msg.result);
      return;
    }
    if (msg.error && msg.status === 401) { wanted = false; return; }
    switch (msg.type) {
      case "init":
        selfSessionId = msg.selfSessionId;
        channels = msg.channels || [];
        categories = msg.categories || [];
        members = msg.members || [];
        if (!channels.some((c) => c.id === activeText)) activeText = channels.find((c) => c.kind === "text")?.id || null;
        loadedHistory.clear();
        if (activeText && !panel.hidden) loadHistory(activeText);
        if (voice.rejoin) { const target = voice.rejoin; voice.rejoin = null; joinVoice(target, true); }
        render();
        break;
      case "channels":
        channels = msg.channels || [];
        categories = msg.categories || [];
        if (!channels.some((c) => c.id === activeText)) activeText = channels.find((c) => c.kind === "text")?.id || null;
        if (voice.channel && !channels.some((c) => c.id === voice.channel)) stopVoice();
        render();
        break;
      case "presence":
        members = msg.members || [];
        if (voice.channel && !members.some((m) => m.sessionId === selfSessionId && m.voiceChannel === voice.channel)) {
          stopVoice();
        }
        renderChannelList();
        renderVoiceBar();
        break;
      case "message":
        receiveMessage(msg.message);
        break;
      case "invite":
        currentSession.pendingInvites = Number(currentSession.pendingInvites || 0) + 1;
        renderWorkspaceBadge();
        status(`${msg.from} 님이 워크스페이스에 초대했습니다. 오른쪽 위 워크스페이스 버튼에서 수락할 수 있습니다.`);
        break;
      case "planner":
        window.dispatchEvent(new CustomEvent("qnb:planner", { detail: msg }));
        break;
      case "workspace_revoked":
        disconnect();
        break;
      default:
        break;
    }
  }

  /* ------------------------------ chat ------------------------------ */

  async function loadHistory(channelId) {
    if (loadedHistory.has(channelId)) return;
    loadedHistory.add(channelId);
    try {
      const result = await request("history", { channel: channelId });
      const live = histories.get(channelId) || [];
      const known = new Set(result.messages.map((m) => m.id));
      histories.set(channelId, [...result.messages, ...live.filter((m) => !known.has(m.id))]);
      if (channelId === activeText) renderMessages(true);
    } catch (error) {
      loadedHistory.delete(channelId);
      setNotice(error.message);
    }
  }

  function receiveMessage(message) {
    const list = histories.get(message.channel) || [];
    if (!list.some((m) => m.id === message.id)) list.push(message);
    if (list.length > 500) list.splice(0, list.length - 500);
    histories.set(message.channel, list);
    const mine = members.find((m) => m.sessionId === selfSessionId)?.accountId === message.accountId;
    if (!mine && (panel.hidden || message.channel !== activeText || document.hidden)) {
      unread.set(message.channel, (unread.get(message.channel) || 0) + 1);
    }
    if (message.channel === activeText && !panel.hidden) renderMessages();
    renderChannelList();
    renderBadge();
  }

  async function sendMessage() {
    const input = $("channels-input");
    const text = input.value.trim();
    if ((!text && !outgoing.length) || !activeText) return;
    input.disabled = true;
    $("channels-send").disabled = true;
    try {
      const uploads = outgoing.slice();
      await Promise.all(uploads.map((item) => item.done));
      const failed = uploads.find((item) => item.error);
      if (failed) throw new Error(`'${failed.file.name}' 업로드 실패 · ${failed.error}`);
      await request("send", { channel: activeText, text, attachments: uploads.map((item) => item.id) });
      input.value = "";
      for (const item of uploads) removeOutgoing(item, false);
      renderOutgoing();
      autoGrow();
    } catch (error) {
      setNotice(error.message);
    } finally {
      input.disabled = false;
      $("channels-send").disabled = false;
      input.focus();
    }
  }

  /* ------------------------------ attachments ------------------------------ */

  const MAX_ATTACHMENTS = 10;
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  let outgoing = []; // { file, id, progress, error, done, preview }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function chunkBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
      reader.onerror = () => reject(reader.error || new Error("파일을 읽지 못했습니다."));
      reader.readAsDataURL(blob);
    });
  }

  async function upload(item) {
    const { file } = item;
    const started = await api("channels/files", { operation: "start", name: file.name || "붙여넣은 파일", size: file.size, mime: file.type });
    item.id = started.id;
    for (let offset = 0; offset < file.size; offset += started.chunkSize) {
      if (item.cancelled) throw new Error("취소됨");
      const data = await chunkBase64(file.slice(offset, offset + started.chunkSize));
      await api("channels/files", { operation: "chunk", id: started.id, offset, data });
      item.progress = Math.min(1, (offset + started.chunkSize) / file.size);
      renderOutgoing();
    }
    item.meta = await api("channels/files", { operation: "finish", id: started.id });
    item.progress = 1;
    renderOutgoing();
  }

  function addFiles(files) {
    if (!activeText) { setNotice("파일을 보낼 텍스트 채널을 먼저 선택하세요."); return; }
    for (const file of files) {
      if (outgoing.length >= MAX_ATTACHMENTS) { setNotice(`첨부 파일은 한 번에 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`); break; }
      if (!file.size) { setNotice(`'${file.name}'은(는) 빈 파일입니다.`); continue; }
      if (file.size > MAX_FILE_BYTES) { setNotice(`'${file.name}'이(가) 50MB를 넘습니다.`); continue; }
      const item = { file, id: null, progress: 0, error: "", preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : "" };
      item.done = upload(item).catch((error) => { item.error = error.message || "업로드 실패"; renderOutgoing(); });
      outgoing.push(item);
    }
    renderOutgoing();
  }

  function removeOutgoing(item, render = true) {
    item.cancelled = true;
    if (item.preview) URL.revokeObjectURL(item.preview);
    outgoing = outgoing.filter((other) => other !== item);
    if (render) renderOutgoing();
  }

  function renderOutgoing() {
    const tray = $("channels-attachments");
    tray.hidden = !outgoing.length;
    tray.replaceChildren(...outgoing.map((item) => {
      const chip = element("div", undefined, "attach-chip" + (item.error ? " failed" : item.progress >= 1 ? " ready" : ""));
      if (item.preview) {
        const img = document.createElement("img");
        img.src = item.preview;
        img.alt = "";
        chip.append(img);
      } else {
        chip.append(element("span", fileIcon(kindOf(item.file.type)), "attach-chip-icon"));
      }
      const copy = element("span", undefined, "attach-chip-copy");
      copy.append(element("strong", item.file.name || "붙여넣은 파일"),
        element("small", item.error || (item.progress >= 1 ? formatBytes(item.file.size) : `업로드 ${Math.round(item.progress * 100)}%`)));
      chip.append(copy);
      chip.style.setProperty("--progress", String(item.progress));
      chip.append(button("✕", () => removeOutgoing(item), "attach-chip-remove", "첨부 취소"));
      return chip;
    }));
  }

  function kindOf(mime) {
    if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return "image";
    if (/^video\//.test(mime)) return "video";
    if (/^audio\//.test(mime)) return "audio";
    if (mime === "application/pdf") return "pdf";
    return "file";
  }

  function fileIcon(kind) {
    return { image: "🖼", video: "🎬", audio: "🎵", pdf: "📄" }[kind] || "📦";
  }

  function fileURL(file, download = false) {
    return `/api/channels/files/${encodeURIComponent(file.id)}` + (download ? "?download=1" : "");
  }

  function attachmentNode(file) {
    const url = fileURL(file);
    if (file.kind === "image") {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "chat-media chat-image";
      const img = document.createElement("img");
      img.src = url;
      img.alt = file.name;
      img.loading = "lazy";
      link.append(img);
      return link;
    }
    if (file.kind === "video" || file.kind === "audio") {
      const media = document.createElement(file.kind);
      media.controls = true;
      media.preload = "metadata";
      media.src = url;
      media.className = "chat-media chat-" + file.kind;
      const wrap = element("div", undefined, "chat-media-wrap");
      wrap.append(media, fileCard(file, false));
      return wrap;
    }
    const card = fileCard(file, true);
    if (file.kind === "pdf") {
      const frameWrap = element("div", undefined, "chat-pdf");
      const toggleButton = button("미리보기", () => {
        let frame = frameWrap.querySelector("iframe");
        if (frame) { frame.remove(); toggleButton.textContent = "미리보기"; return; }
        frame = document.createElement("iframe");
        frame.src = url;
        frame.title = file.name;
        frameWrap.append(frame);
        toggleButton.textContent = "미리보기 닫기";
      }, "chat-file-action");
      card.querySelector(".chat-file-actions").prepend(toggleButton);
      frameWrap.prepend(card);
      return frameWrap;
    }
    return card;
  }

  function fileCard(file, withOpen) {
    const card = element("div", undefined, "chat-file");
    card.append(element("span", fileIcon(file.kind), "chat-file-icon"));
    const copy = element("span", undefined, "chat-file-copy");
    copy.append(element("strong", file.name), element("small", formatBytes(file.size)));
    card.append(copy);
    const actions = element("span", undefined, "chat-file-actions");
    if (withOpen && file.kind !== "file") {
      const open = document.createElement("a");
      open.href = fileURL(file);
      open.target = "_blank";
      open.rel = "noopener";
      open.textContent = "열기";
      open.className = "chat-file-action";
      actions.append(open);
    }
    const save = document.createElement("a");
    save.href = fileURL(file, true);
    save.textContent = "다운로드";
    save.className = "chat-file-action";
    actions.append(save);
    card.append(actions);
    return card;
  }

  /* ------------------------------ link embeds ------------------------------ */

  function youtubeId(href) {
    try {
      const u = new URL(href);
      const host = u.hostname.replace(/^(www|m|music)\./, "");
      let id = "";
      if (host === "youtu.be") id = u.pathname.slice(1);
      else if (host === "youtube.com" || host === "youtube-nocookie.com") {
        if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
        else id = (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/) || [])[1] || "";
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
    } catch { return ""; }
  }

  function youtubeStart(href) {
    try {
      const t = new URL(href).searchParams.get("t") || new URL(href).searchParams.get("start") || "";
      const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
      return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
    } catch { return 0; }
  }

  function youtubeNode(id, start) {
    const box = element("div", undefined, "chat-youtube");
    const play = document.createElement("button");
    play.type = "button";
    play.className = "chat-youtube-play";
    play.setAttribute("aria-label", "YouTube 동영상 재생");
    const thumb = document.createElement("img");
    thumb.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    thumb.alt = "";
    thumb.loading = "lazy";
    play.append(thumb, element("span", "▶", "chat-youtube-icon"));
    // The player (and YouTube's cookies) only load after an explicit click.
    play.onclick = () => {
      const frame = document.createElement("iframe");
      frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0` + (start ? `&start=${start}` : "");
      frame.title = "YouTube 동영상";
      frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      play.replaceWith(frame);
    };
    box.append(play);
    return box;
  }

  function linkCard(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "chat-link-card";
    const icon = element("span", u.hostname.replace(/^www\./, "").slice(0, 1).toUpperCase(), "chat-link-icon");
    icon.style.setProperty("--hue", String([...u.hostname].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)));
    const copy = element("span", undefined, "chat-link-copy");
    const path = decodeURI(u.pathname + u.search).replace(/\/$/, "");
    copy.append(element("strong", u.hostname.replace(/^www\./, "")), element("small", path || "/"));
    a.append(icon, copy, element("span", "↗", "chat-link-arrow"));
    return a;
  }

  function embedsFor(text) {
    const nodes = [];
    const seen = new Set();
    for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const href = match[0];
      if (seen.has(href) || nodes.length >= 3) continue;
      seen.add(href);
      const id = youtubeId(href);
      const node = id ? youtubeNode(id, youtubeStart(href)) : linkCard(href);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  function formatTime(seconds) {
    const d = new Date(seconds * 1000);
    const today = new Date();
    const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === today.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  }

  function linkify(node, text) {
    const pattern = /https?:\/\/[^\s<>"')\]]+/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) node.append(text.slice(last, match.index));
      const a = document.createElement("a");
      a.href = match[0];
      a.textContent = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      node.append(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) node.append(text.slice(last));
  }

  // Message nodes are reused so playing videos, open PDFs and YouTube players survive re-renders.
  const messageNodes = new Map(); // `${channel}:${id}` -> { key, node }

  function messageNode(message, grouped, mine) {
    const cacheKey = `${message.channel}:${message.id}`;
    const key = `${grouped}|${mine}`;
    const cached = messageNodes.get(cacheKey);
    if (cached?.key === key) return cached.node;
    const item = element("div", undefined, "chat-message" + (grouped ? " grouped" : "") + (mine ? " mine" : ""));
    if (!grouped) {
      const head = element("div", undefined, "chat-head");
      const avatar = element("span", (message.nickname || "?").slice(0, 1).toUpperCase(), "chat-avatar");
      avatar.style.setProperty("--hue", String((message.accountId * 67) % 360));
      const who = element("strong", message.nickname || "알 수 없음");
      if (message.tag) who.append(element("span", "#" + message.tag, "handle-tag"));
      head.append(avatar, who, element("time", formatTime(message.createdAt)));
      item.append(head);
    }
    if (message.text) {
      const body = element("div", undefined, "chat-text");
      linkify(body, message.text);
      body.title = new Date(message.createdAt * 1000).toLocaleString("ko-KR");
      item.append(body);
    }
    const extras = [...(message.attachments || []).map(attachmentNode), ...embedsFor(message.text || "")];
    if (extras.length) {
      const box = element("div", undefined, "chat-attachments");
      box.append(...extras);
      item.append(box);
    }
    if (cached) cached.node.replaceWith(item);
    messageNodes.set(cacheKey, { key, node: item });
    return item;
  }

  /* Insert/remove only what changed. Moving a node that is already in place would reload
   * iframes and pause videos, so appends and history prepends never touch existing nodes. */
  function reconcile(container, nodes) {
    const wanted = new Set(nodes);
    for (const child of [...container.children]) if (!wanted.has(child)) child.remove();
    nodes.forEach((node, i) => {
      const at = container.children[i];
      if (at !== node) container.insertBefore(node, at || null);
    });
  }

  function renderMessages(forceBottom = false) {
    const box = $("channels-messages");
    const nearBottom = forceBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const list = histories.get(activeText) || [];
    const myAccount = members.find((m) => m.sessionId === selfSessionId)?.accountId;
    const nodes = [];
    let previous = null;
    for (const message of list) {
      const grouped = Boolean(previous && previous.accountId === message.accountId && message.createdAt - previous.createdAt < 300);
      nodes.push(messageNode(message, grouped, message.accountId === myAccount));
      previous = message;
    }
    if (!nodes.length) nodes.push(element("div", loadedHistory.has(activeText) ? "아직 메시지가 없습니다. 첫 메시지를 보내 보세요." : "메시지를 불러오는 중…", "chat-empty"));
    reconcile(box, nodes);
    if (nearBottom) {
      box.scrollTop = box.scrollHeight;
      // Images and players change height after loading; keep the view pinned to the bottom.
      for (const media of box.querySelectorAll("img:not([data-pinned]), video:not([data-pinned])")) {
        media.dataset.pinned = "1";
        media.addEventListener(media.tagName === "IMG" ? "load" : "loadedmetadata", () => {
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight;
        }, { once: true });
      }
    }
  }

  /* ------------------------------ voice ------------------------------ */

  async function joinVoice(channelId, silent = false) {
    if (voice.channel === channelId || voice.joining) return;
    voice.joining = true;
    try { await joinVoiceOnce(channelId, silent); } finally { voice.joining = false; }
  }

  async function joinVoiceOnce(channelId, silent) {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      setNotice("이 브라우저(또는 HTTP 연결)에서는 마이크를 사용할 수 없습니다. HTTPS로 접속하세요.");
      return;
    }
    if (voice.channel) await leaveVoice();
    try {
      if (!voice.ctx) {
        voice.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        voice.ctx = new AudioContext({ latencyHint: "interactive" });
        await voice.ctx.audioWorklet.addModule("/static/voice-worklet.js");
        const source = voice.ctx.createMediaStreamSource(voice.stream);
        voice.capture = new AudioWorkletNode(voice.ctx, "qnb-capture", { numberOfOutputs: 1, outputChannelCount: [1] });
        const sink = voice.ctx.createGain();
        sink.gain.value = 0;
        source.connect(voice.capture).connect(sink).connect(voice.ctx.destination);
        voice.playback = new AudioWorkletNode(voice.ctx, "qnb-playback", { numberOfInputs: 0, outputChannelCount: [1] });
        voice.output = voice.ctx.createGain();
        voice.playback.connect(voice.output).connect(voice.ctx.destination);
        voice.capture.port.onmessage = ({ data }) => sendVoice(data);
        voice.playback.port.onmessage = ({ data }) => { if (data.levels) { voice.levels = data.levels; paintSpeaking(); } };
      }
      await voice.ctx.resume();
      const result = await request("voice_join", { channel: channelId });
      voice.channel = channelId;
      voice.slot = result.slot;
      if (voice.muted) request("voice_mute", { muted: true }).catch(() => {});
      voice.output.gain.value = voice.deafened ? 0 : 1;
      if (!silent) setNotice("");
    } catch (error) {
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      setNotice(denied ? "마이크 권한이 거부되었습니다. 브라우저 주소창에서 권한을 허용하세요." : error.message || "음성 채널에 참여하지 못했습니다.");
      if (!voice.channel) teardownAudio();
    }
    render();
  }

  function sendVoice({ frame, level }) {
    stats.captured++;
    voice.selfLevel = level;
    const now = performance.now();
    if (level > VAD_THRESHOLD) voice.lastVoiceAt = now;
    paintSelfSpeaking(now - voice.lastVoiceAt < VAD_HANGOVER_MS && !voice.muted);
    if (!voice.channel || voice.muted || now - voice.lastVoiceAt > VAD_HANGOVER_MS) return;
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) return;
    socket.send(frame);
    stats.sent++;
  }

  function receiveVoice(buffer) {
    if (!voice.playback || !voice.channel || buffer.byteLength < 3) return;
    stats.received++;
    const slot = new DataView(buffer).getUint16(0);
    const data = new Uint8Array(buffer, 2);
    voice.playback.port.postMessage({ slot, data }, []);
  }

  function teardownAudio() {
    for (const track of voice.stream?.getTracks() || []) track.stop();
    voice.ctx?.close().catch(() => {});
    Object.assign(voice, { ctx: null, stream: null, capture: null, playback: null, output: null, levels: {} });
  }

  function stopVoice() {
    voice.channel = null;
    voice.slot = 0;
    teardownAudio();
    render();
  }

  async function leaveVoice() {
    const was = voice.channel;
    stopVoice();
    if (was && socket?.readyState === WebSocket.OPEN) await request("voice_leave").catch(() => {});
  }

  async function toggleMute() {
    voice.muted = !voice.muted;
    if (voice.channel) await request("voice_mute", { muted: voice.muted }).catch(() => {});
    renderVoiceBar();
  }

  function toggleDeafen() {
    voice.deafened = !voice.deafened;
    if (voice.output) voice.output.gain.value = voice.deafened ? 0 : 1;
    renderVoiceBar();
  }

  /* ------------------------------ rendering ------------------------------ */

  function setNotice(message) {
    const node = $("channels-notice");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function renderBadge() {
    const total = [...unread.values()].reduce((a, b) => a + b, 0);
    unreadBadge.textContent = total > 99 ? "99+" : String(total);
    unreadBadge.hidden = total === 0;
    openButton.classList.toggle("in-voice", Boolean(voice.channel));
  }

  /* Channel rows are kept and patched in place: presence updates arrive often and must not
   * replace a button between mousedown and mouseup (that would swallow the click). */
  const rowCache = new Map(); // channel id -> { wrap, row, label, unread, remove, list, sig }

  function memberNodes(channel) {
    return members.filter((m) => m.voiceChannel === channel.id).map((person) => {
      const node = element("div", undefined, "voice-member" + (person.muted ? " muted" : ""));
      node.dataset.slot = String(person.slot);
      node.dataset.self = String(person.sessionId === selfSessionId);
      const avatar = element("span", (person.nickname || "?").slice(0, 1).toUpperCase(), "chat-avatar small");
      avatar.style.setProperty("--hue", String((person.accountId * 67) % 360));
      const name = element("span", person.nickname, "voice-name");
      if (person.tag) name.append(element("span", "#" + person.tag, "handle-tag"));
      if (person.sessionId === selfSessionId) name.append(" (나)");
      node.append(avatar, name);
      if (person.muted) node.append(element("span", "🔇", "voice-flag"));
      return node;
    });
  }

  function channelRow(channel) {
    const isVoice = channel.kind === "voice";
    let entry = rowCache.get(channel.id);
    if (!entry) {
      const wrap = element("div", undefined, "channel-item");
      wrap.draggable = true;
      wrap.dataset.channel = channel.id;
      const row = element("div", undefined, "channel-row");
      // A span, not a <button>: Firefox never starts a drag from inside a button.
      const label = element("span", "", "channel-name");
      label.setAttribute("role", "button");
      label.tabIndex = 0;
      const activateRow = () => {
        const current = rowCache.get(channel.id)?.channel || channel;
        if (current.kind === "voice") joinVoice(current.id); else selectText(current.id);
      };
      label.onclick = activateRow;
      label.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateRow(); } };
      label.ondblclick = (event) => { event.preventDefault(); renameChannel(rowCache.get(channel.id)?.channel || channel); };
      const unreadNode = element("span", "", "channel-unread");
      const remove = button("✕", (e) => { e.stopPropagation(); removeChannel(rowCache.get(channel.id)?.channel || channel); }, "channel-delete", "채널 삭제");
      const list = element("div", undefined, "voice-members");
      row.append(label, unreadNode, remove);
      wrap.append(row, list);
      wrap.addEventListener("dragstart", (event) => startDrag(event, "channel", channel.id, wrap));
      wrap.addEventListener("dragend", endDrag);
      entry = { wrap, row, label, unread: unreadNode, remove, list, sig: "" };
      rowCache.set(channel.id, entry);
    }
    entry.channel = channel;
    entry.row.className = "channel-row" + (channel.id === activeText ? " active" : "") + (channel.id === voice.channel ? " connected" : "");
    const text = (isVoice ? "🔊 " : "# ") + channel.name;
    if (entry.label.textContent !== text) entry.label.textContent = text;
    entry.label.title = (isVoice ? (channel.id === voice.channel ? "참여 중" : "클릭해서 음성 채널 참여") : channel.name) + " · 더블클릭으로 이름 변경";
    const count = unread.get(channel.id) || 0;
    entry.unread.textContent = String(count);
    entry.unread.hidden = !count;
    entry.remove.hidden = !isOwner();
    if (isVoice) {
      const people = members.filter((m) => m.voiceChannel === channel.id);
      const sig = JSON.stringify(people.map((m) => [m.sessionId, m.slot, m.muted, m.nickname]));
      if (sig !== entry.sig) {
        entry.sig = sig;
        entry.list.replaceChildren(...memberNodes(channel));
        paintSpeaking();
      }
    }
    entry.list.hidden = !isVoice || !entry.list.childElementCount;
    return entry.wrap;
  }

  function syncChildren(container, nodes) {
    const current = [...container.children];
    if (current.length === nodes.length && current.every((node, i) => node === nodes[i])) return;
    container.replaceChildren(...nodes);
  }

  function isOwner() {
    const owner = currentSession.workspace?.ownerId ?? null;
    const me = members.find((m) => m.sessionId === selfSessionId)?.accountId;
    return owner !== null && me === owner;
  }

  /* ----------------------- categories & drag and drop ----------------------- */

  const COLLAPSED_KEY = "qnb:channels:collapsed";
  const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"); } catch { return []; } })());
  const categoryCache = new Map(); // category id -> { section, head, caret, label, add, remove, list }
  const UNCATEGORISED = "";
  let dragging = null; // { type, id }

  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* ignore */ }
  }

  function categorySection(category) {
    let entry = categoryCache.get(category.id);
    if (!entry) {
      const section = element("section", undefined, "channel-category");
      section.dataset.category = category.id;
      const head = element("div", undefined, "channel-category-head");
      head.draggable = true;
      const caret = element("span", "▾", "channel-category-caret");
      const label = element("span", "", "channel-category-name");
      head.setAttribute("role", "button");
      head.tabIndex = 0;
      const toggleCollapse = () => {
        if (collapsed.has(category.id)) collapsed.delete(category.id); else collapsed.add(category.id);
        saveCollapsed();
        renderChannelList();
      };
      head.onclick = (event) => { if (!event.target.closest("button")) toggleCollapse(); };
      head.onkeydown = (event) => { if ((event.key === "Enter" || event.key === " ") && event.target === head) { event.preventDefault(); toggleCollapse(); } };
      label.ondblclick = (event) => { event.stopPropagation(); renameCategory(categoryCache.get(category.id)?.category || category); };
      const add = button("＋", () => pickKindAndAdd(category.id, add), "channel-category-add", "이 카테고리에 채널 추가");
      const remove = button("✕", () => removeCategory(categoryCache.get(category.id)?.category || category), "channel-category-delete", "카테고리 삭제 (채널은 유지)");
      head.append(caret, label, add, remove);
      const list = element("div", undefined, "channel-category-list");
      list.dataset.category = category.id;
      section.append(head, list);
      head.addEventListener("dragstart", (event) => startDrag(event, "category", category.id, section));
      head.addEventListener("dragend", endDrag);
      entry = { section, head, caret, label, add, remove, list };
      categoryCache.set(category.id, entry);
    }
    entry.category = category;
    if (entry.label.textContent !== category.name) entry.label.textContent = category.name;
    entry.label.title = category.name + " · 더블클릭으로 이름 변경 · 끌어서 순서 변경";
    const isCollapsed = collapsed.has(category.id);
    entry.section.classList.toggle("collapsed", isCollapsed);
    entry.head.setAttribute("aria-expanded", String(!isCollapsed));
    entry.remove.hidden = !isOwner();
    const inside = channels.filter((c) => (c.category || UNCATEGORISED) === category.id);
    // Collapsed categories still show the channel you are reading or talking in.
    const visible = isCollapsed ? inside.filter((c) => c.id === activeText || c.id === voice.channel || unread.get(c.id)) : inside;
    syncChildren(entry.list, visible.map(channelRow));
    entry.list.classList.toggle("empty", !inside.length);
    return entry.section;
  }

  function renderChannelList() {
    for (const id of [...rowCache.keys()]) if (!channels.some((c) => c.id === id)) rowCache.delete(id);
    for (const id of [...categoryCache.keys()]) if (!categories.some((c) => c.id === id)) categoryCache.delete(id);
    const loose = channels.filter((c) => !c.category);
    const looseList = $("channels-tree").querySelector(".channel-category-list.loose") || (() => {
      const node = element("div", undefined, "channel-category-list loose");
      node.dataset.category = UNCATEGORISED;
      return node;
    })();
    syncChildren(looseList, loose.map(channelRow));
    looseList.classList.toggle("empty", !loose.length);
    syncChildren($("channels-tree"), [looseList, ...categories.map(categorySection)]);
    const online = new Map();
    for (const m of members) online.set(m.accountId, m.tag ? `${m.nickname}#${m.tag}` : m.nickname);
    $("channels-online").textContent = `온라인 ${online.size}명`;
    $("channels-online").title = [...online.values()].join(", ");
    renderBadge();
  }

  function startDrag(event, type, id, node) {
    event.stopPropagation();
    dragging = { type, id };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-qnb-" + type, id);
    event.dataTransfer.setData("text/plain", "");
    requestAnimationFrame(() => { if (dragging?.id === id) node.classList.add("dragging"); });
    $("channels-tree").classList.add("drag-" + type);
  }

  function endDrag() {
    dragging = null;
    clearDropMarks();
    for (const node of document.querySelectorAll("#channels-tree .dragging")) node.classList.remove("dragging");
    $("channels-tree").classList.remove("drag-channel", "drag-category");
  }

  function clearDropMarks() {
    for (const node of document.querySelectorAll("#channels-tree .drop-before, #channels-tree .drop-after, #channels-tree .drop-into")) {
      node.classList.remove("drop-before", "drop-after", "drop-into");
    }
  }

  /* Where would the current drag land? Returns { mark, side, apply } or null. */
  function dropTarget(event) {
    if (!dragging) return null;
    const half = (node) => (event.clientY - node.getBoundingClientRect().top < node.getBoundingClientRect().height / 2 ? "before" : "after");
    if (dragging.type === "channel") {
      const item = event.target.closest(".channel-item");
      if (item && item.dataset.channel !== dragging.id) {
        const target = channels.find((c) => c.id === item.dataset.channel);
        if (!target) return null;
        const side = half(item);
        return { mark: item, side, apply: () => moveChannel(dragging.id, target.category, target.id, side) };
      }
      const zone = event.target.closest(".channel-category-head, .channel-category-list");
      if (zone && !item) {
        const categoryId = zone.dataset.category ?? zone.parentElement.dataset.category;
        return { mark: zone, side: "into", apply: () => moveChannel(dragging.id, categoryId || null, null, "end") };
      }
      return null;
    }
    const section = event.target.closest(".channel-category");
    if (!section || section.dataset.category === dragging.id) return null;
    const side = half(section);
    return { mark: section, side, apply: () => moveCategory(dragging.id, section.dataset.category, side) };
  }

  function moveChannel(channelId, categoryId, targetId, side) {
    const siblings = channels.filter((c) => (c.category || null) === (categoryId || null) && c.id !== channelId);
    let index = siblings.length;
    if (targetId) index = siblings.findIndex((c) => c.id === targetId) + (side === "after" ? 1 : 0);
    // Optimistic: reorder locally, the server broadcast confirms it a moment later.
    const moved = channels.find((c) => c.id === channelId);
    if (!moved) return;
    siblings.splice(index, 0, { ...moved, category: categoryId || null });
    siblings.forEach((c, i) => { c.position = i; });
    channels = [...channels.filter((c) => (c.category || null) !== (categoryId || null) && c.id !== channelId), ...siblings]
      .sort((a, b) => a.position - b.position);
    renderChannelList();
    request("move_channel", { channel: channelId, category: categoryId || null, index }).catch((error) => setNotice(error.message));
  }

  function moveCategory(categoryId, targetId, side) {
    const order = categories.filter((c) => c.id !== categoryId);
    const index = order.findIndex((c) => c.id === targetId) + (side === "after" ? 1 : 0);
    const moved = categories.find((c) => c.id === categoryId);
    if (!moved) return;
    order.splice(index, 0, moved);
    categories = order;
    renderChannelList();
    request("move_category", { category: categoryId, index }).catch((error) => setNotice(error.message));
  }

  const tree = $("channels-tree");
  tree.addEventListener("dragover", (event) => {
    const target = dropTarget(event);
    clearDropMarks();
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    target.mark.classList.add("drop-" + target.side);
  });
  tree.addEventListener("dragleave", (event) => { if (!tree.contains(event.relatedTarget)) clearDropMarks(); });
  tree.addEventListener("drop", (event) => {
    const target = dropTarget(event);
    if (!target) return;
    event.preventDefault();
    target.apply();
    endDrag();
  });

  function pickKindAndAdd(categoryId, anchor) {
    document.querySelector(".channel-kind-menu")?.remove();
    const menu = element("div", undefined, "channel-kind-menu");
    menu.setAttribute("role", "menu");
    const close = () => { menu.remove(); document.removeEventListener("pointerdown", outside, true); };
    const outside = (event) => { if (!menu.contains(event.target)) close(); };
    menu.append(
      button("# 텍스트 채널", () => { close(); addChannel("text", categoryId); }, "channel-kind-option"),
      button("🔊 음성 채널", () => { close(); addChannel("voice", categoryId); }, "channel-kind-option"),
    );
    const box = anchor.getBoundingClientRect();
    const host = panel.getBoundingClientRect();
    menu.style.left = Math.max(4, box.right - host.left - 150) + "px";
    menu.style.top = (box.bottom - host.top + 4) + "px";
    panel.append(menu);
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    menu.querySelector("button").focus();
  }

  function renderVoiceBar() {
    const bar = $("voice-bar");
    bar.hidden = !voice.channel;
    renderBadge();
    if (!voice.channel) return;
    const channel = channels.find((c) => c.id === voice.channel);
    $("voice-bar-channel").textContent = channel ? channel.name : "음성 채널";
    $("voice-mute").textContent = voice.muted ? "🎙̸ 음소거 해제" : "🎙 음소거";
    $("voice-mute").setAttribute("aria-pressed", String(voice.muted));
    $("voice-deafen").textContent = voice.deafened ? "🔈 듣기 켜기" : "🎧 듣기 끄기";
    $("voice-deafen").setAttribute("aria-pressed", String(voice.deafened));
  }

  function paintSpeaking() {
    for (const node of document.querySelectorAll(".voice-member[data-self='false']")) {
      node.classList.toggle("speaking", (voice.levels[node.dataset.slot] || 0) > 0.01);
    }
  }

  function paintSelfSpeaking(on) {
    for (const node of document.querySelectorAll(".voice-member[data-self='true']")) node.classList.toggle("speaking", on);
    $("voice-level").style.setProperty("--level", String(Math.min(1, voice.selfLevel * 8)));
  }

  function render() {
    renderChannelList();
    renderVoiceBar();
    const channel = channels.find((c) => c.id === activeText);
    $("channels-title").textContent = channel ? "# " + channel.name : "채팅";
    $("channels-input").disabled = !channel || socket?.readyState !== WebSocket.OPEN;
    $("channels-input").placeholder = channel ? `#${channel.name}에 메시지 보내기 (Enter 전송 · Shift+Enter 줄바꿈)` : "채널을 선택하세요";
    $("channels-status").textContent = socket?.readyState === WebSocket.OPEN ? "" : wanted ? "재연결 중…" : "연결 안 됨";
    if (!panel.hidden) renderMessages();
  }

  function selectText(channelId) {
    activeText = channelId;
    unread.delete(channelId);
    loadHistory(channelId);
    render();
    renderMessages(true);
    $("channels-input").focus();
  }

  async function addChannel(kind, categoryId = null) {
    const name = prompt(kind === "voice" ? "새 음성 채널 이름" : "새 텍스트 채널 이름");
    if (!name || !name.trim()) return;
    try {
      const created = await request("create_channel", { name: name.trim(), kind, category: categoryId });
      if (categoryId && collapsed.delete(categoryId)) saveCollapsed();
      if (kind === "text") selectText(created.id);
    } catch (error) { setNotice(error.message); }
  }

  async function renameChannel(channel) {
    const name = prompt("채널 이름", channel.name);
    if (!name || !name.trim() || name.trim() === channel.name) return;
    try { await request("rename_channel", { channel: channel.id, name: name.trim() }); }
    catch (error) { setNotice(error.message); }
  }

  async function removeChannel(channel) {
    if (!confirm(`'${channel.name}' 채널을 삭제할까요? 메시지 기록과 첨부 파일도 함께 삭제됩니다.`)) return;
    try { await request("delete_channel", { channel: channel.id }); }
    catch (error) { setNotice(error.message); }
  }

  async function addCategory() {
    const name = prompt("새 카테고리 이름");
    if (!name || !name.trim()) return;
    try { await request("create_category", { name: name.trim() }); }
    catch (error) { setNotice(error.message); }
  }

  async function renameCategory(category) {
    const name = prompt("카테고리 이름", category.name);
    if (!name || !name.trim() || name.trim() === category.name) return;
    try { await request("rename_category", { category: category.id, name: name.trim() }); }
    catch (error) { setNotice(error.message); }
  }

  async function removeCategory(category) {
    if (!confirm(`'${category.name}' 카테고리를 삭제할까요? 안의 채널은 삭제되지 않고 카테고리 밖으로 옮겨집니다.`)) return;
    try { await request("delete_category", { category: category.id }); }
    catch (error) { setNotice(error.message); }
  }

  function autoGrow() {
    const input = $("channels-input");
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
  }

  function toggle(force) {
    const show = force ?? panel.hidden;
    panel.hidden = !show;
    openButton.setAttribute("aria-expanded", String(show));
    if (show) {
      connect().catch((error) => setNotice(error.message));
      if (activeText) { unread.delete(activeText); loadHistory(activeText); }
      render();
      renderMessages(true);
      $("channels-input").focus();
    }
    renderBadge();
  }

  openButton.onclick = () => toggle();
  $("channels-close").onclick = () => toggle(false);
  $("channels-add-text").onclick = () => addChannel("text");
  $("channels-add-voice").onclick = () => addChannel("voice");
  $("channels-add-category").onclick = addCategory;
  $("channels-attach").onclick = () => $("channels-file").click();
  $("channels-file").onchange = (event) => { addFiles([...event.target.files]); event.target.value = ""; };
  $("channels-input").addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  {
    const chat = panel.querySelector(".channels-chat");
    const overlay = $("channels-drop");
    let depth = 0;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
    chat.addEventListener("dragenter", (event) => { if (!hasFiles(event)) return; depth++; overlay.hidden = false; });
    chat.addEventListener("dragleave", (event) => { if (!hasFiles(event)) return; if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
    chat.addEventListener("dragover", (event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
    chat.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      overlay.hidden = true;
      addFiles([...event.dataTransfer.files]);
    });
  }
  $("voice-mute").onclick = toggleMute;
  $("voice-deafen").onclick = toggleDeafen;
  $("voice-leave").onclick = () => leaveVoice();
  $("channels-send").onclick = sendMessage;
  $("channels-input").addEventListener("input", autoGrow);
  $("channels-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("channels-messages").addEventListener("scroll", async (event) => {
    const box = event.target;
    if (box.scrollTop > 20 || !activeText) return;
    const list = histories.get(activeText) || [];
    if (!list.length || box.dataset.loading === "1" || box.dataset.exhausted === activeText) return;
    box.dataset.loading = "1";
    try {
      const result = await request("history", { channel: activeText, before: list[0].id });
      if (!result.messages.length) box.dataset.exhausted = activeText;
      const height = box.scrollHeight;
      histories.set(activeText, [...result.messages, ...list]);
      renderMessages();
      box.scrollTop = box.scrollHeight - height;
    } catch { /* ignore */ }
    box.dataset.loading = "0";
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !panel.hidden && activeText) { unread.delete(activeText); renderBadge(); renderChannelList(); }
  });
  window.addEventListener("pagehide", () => { wanted = false; stopVoice(); socket?.close(); });

  // app.js may have opened the IDE before this script loaded.
  if (typeof ideInitialized !== "undefined" && ideInitialized && !standaloneProofPage) connect().catch(() => {});

  return { connect: () => connect().catch(() => {}), disconnect, toggle, stats, get levels() { return { ...voice.levels, self: voice.selfLevel }; },
    get debug() { return { channel: voice.channel, socket: socket?.readyState ?? -1, audio: voice.ctx?.state || "none", rate: voice.ctx?.sampleRate || 0 }; } };
})();
