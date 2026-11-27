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
    members = [];
    histories.clear();
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
        members = msg.members || [];
        if (!channels.some((c) => c.id === activeText)) activeText = channels.find((c) => c.kind === "text")?.id || null;
        loadedHistory.clear();
        if (activeText && !panel.hidden) loadHistory(activeText);
        if (voice.rejoin) { const target = voice.rejoin; voice.rejoin = null; joinVoice(target, true); }
        render();
        break;
      case "channels":
        channels = msg.channels || [];
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
    if (!text || !activeText) return;
    input.disabled = true;
    try {
      await request("send", { channel: activeText, text });
      input.value = "";
      autoGrow();
    } catch (error) {
      setNotice(error.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
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

  function renderMessages(forceBottom = false) {
    const box = $("channels-messages");
    const nearBottom = forceBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const list = histories.get(activeText) || [];
    const myAccount = members.find((m) => m.sessionId === selfSessionId)?.accountId;
    const nodes = [];
    let previous = null;
    for (const message of list) {
      const grouped = previous && previous.accountId === message.accountId && message.createdAt - previous.createdAt < 300;
      const item = element("div", undefined, "chat-message" + (grouped ? " grouped" : "") + (message.accountId === myAccount ? " mine" : ""));
      if (!grouped) {
        const head = element("div", undefined, "chat-head");
        const avatar = element("span", (message.nickname || "?").slice(0, 1).toUpperCase(), "chat-avatar");
        avatar.style.setProperty("--hue", String((message.accountId * 67) % 360));
        head.append(avatar, element("strong", message.nickname || "알 수 없음"), element("time", formatTime(message.createdAt)));
        item.append(head);
      }
      const body = element("div", undefined, "chat-text");
      linkify(body, message.text);
      body.title = new Date(message.createdAt * 1000).toLocaleString("ko-KR");
      item.append(body);
      nodes.push(item);
      previous = message;
    }
    if (!nodes.length) nodes.push(element("div", loadedHistory.has(activeText) ? "아직 메시지가 없습니다. 첫 메시지를 보내 보세요." : "메시지를 불러오는 중…", "chat-empty"));
    box.replaceChildren(...nodes);
    if (nearBottom) box.scrollTop = box.scrollHeight;
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
      node.append(avatar, element("span", person.nickname + (person.sessionId === selfSessionId ? " (나)" : ""), "voice-name"));
      if (person.muted) node.append(element("span", "🔇", "voice-flag"));
      return node;
    });
  }

  function channelRow(channel) {
    const isVoice = channel.kind === "voice";
    let entry = rowCache.get(channel.id);
    if (!entry) {
      const wrap = element("div", undefined, "channel-item");
      const row = element("div", undefined, "channel-row");
      const label = button("", () => (channel.kind === "voice" ? joinVoice(channel.id) : selectText(channel.id)), "channel-name");
      const unreadNode = element("span", "", "channel-unread");
      const remove = button("✕", (e) => { e.stopPropagation(); removeChannel(rowCache.get(channel.id)?.channel || channel); }, "channel-delete", "채널 삭제");
      const list = element("div", undefined, "voice-members");
      row.append(label, unreadNode, remove);
      wrap.append(row, list);
      entry = { wrap, row, label, unread: unreadNode, remove, list, sig: "" };
      rowCache.set(channel.id, entry);
    }
    entry.channel = channel;
    entry.row.className = "channel-row" + (channel.id === activeText ? " active" : "") + (channel.id === voice.channel ? " connected" : "");
    const text = (isVoice ? "🔊 " : "# ") + channel.name;
    if (entry.label.textContent !== text) entry.label.textContent = text;
    entry.label.title = isVoice ? (channel.id === voice.channel ? "참여 중" : "클릭해서 음성 채널 참여") : channel.name;
    const count = unread.get(channel.id) || 0;
    entry.unread.textContent = String(count);
    entry.unread.hidden = !count;
    const owner = currentSession.workspace?.ownerId ?? null;
    const me = members.find((m) => m.sessionId === selfSessionId)?.accountId;
    entry.remove.hidden = !(owner !== null && me === owner);
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

  function renderChannelList() {
    for (const id of [...rowCache.keys()]) if (!channels.some((c) => c.id === id)) rowCache.delete(id);
    syncChildren($("channels-text-list"), channels.filter((c) => c.kind === "text").map(channelRow));
    syncChildren($("channels-voice-list"), channels.filter((c) => c.kind === "voice").map(channelRow));
    const online = new Map();
    for (const m of members) online.set(m.accountId, m.nickname);
    $("channels-online").textContent = `온라인 ${online.size}명`;
    $("channels-online").title = [...online.values()].join(", ");
    renderBadge();
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

  async function addChannel(kind) {
    const name = prompt(kind === "voice" ? "새 음성 채널 이름" : "새 텍스트 채널 이름");
    if (!name || !name.trim()) return;
    try {
      const created = await request("create_channel", { name: name.trim(), kind });
      if (kind === "text") selectText(created.id);
    } catch (error) { setNotice(error.message); }
  }

  async function removeChannel(channel) {
    if (!confirm(`'${channel.name}' 채널을 삭제할까요? 메시지 기록도 함께 삭제됩니다.`)) return;
    try { await request("delete_channel", { channel: channel.id }); }
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
