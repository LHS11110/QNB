"use strict";

/* Workspace planner: dashboard · calendar · kanban · projects. Shared per workspace and
 * kept in sync through the channel hub ("planner" broadcasts). */
window.QNBPlanner = (() => {
  const STATUS = { todo: "할 일", doing: "진행 중", review: "검토", done: "완료" };
  const STATUS_ORDER = ["todo", "doing", "review", "done"];
  const PRIORITY = { low: "낮음", medium: "보통", high: "높음", urgent: "긴급" };
  const PROJECT_STATUS = { active: "진행 중", paused: "보류", done: "완료" };
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const DEFAULT_COLORS = ["#4338CA", "#0F766E", "#B45309", "#BE185D", "#2563EB", "#15803D", "#7C3AED", "#C2410C"];

  let data = { projects: [], tasks: [], events: [], members: [], me: null };
  let loaded = false;
  let loading = null;
  let tab = localStorage.getItem("qnb_planner_tab") || "dashboard";
  let filter = "";
  let month = startOfMonth(new Date());
  let editing = null; // { kind, item }
  const body = $("planner-body");

  /* ------------------------------ dates ------------------------------ */
  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parse(s) { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function today() { return iso(new Date()); }
  function dayDiff(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function shortDate(s) { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; }
  function timeOf(s) { return s && s.length > 10 ? s.slice(11, 16) : ""; }

  /* ------------------------------ data ------------------------------ */
  const project = (id) => data.projects.find((p) => p.id === id);
  const member = (id) => data.members.find((m) => m.id === id);
  const visibleTasks = () => data.tasks.filter((t) => !filter || t.projectId === filter);
  const visibleEvents = () => data.events.filter((e) => !filter || e.projectId === filter);
  const overdue = (t) => t.dueDate && t.status !== "done" && t.dueDate < today();

  async function load(force = false) {
    if (loaded && !force) return;
    if (loading) return loading;
    setStatus("불러오는 중…");
    loading = api("planner").then((result) => {
      data = result;
      loaded = true;
      setStatus("");
      render();
    }).catch((error) => setStatus(error.message, true)).finally(() => { loading = null; });
    return loading;
  }

  async function mutate(op, kind, id, payload) {
    try {
      const result = await api("planner", { op, kind, id, data: payload });
      apply({ op: op === "delete" ? "delete" : "upsert", kind, id, item: result });
      return result;
    } catch (error) {
      setStatus(error.message, true);
      throw error;
    }
  }

  function apply(event) {
    const key = { project: "projects", task: "tasks", event: "events" }[event.kind];
    if (!key) return;
    const list = data[key];
    if (event.op === "delete") {
      data[key] = list.filter((x) => x.id !== event.id);
      if (event.kind === "project") {
        for (const t of data.tasks) if (t.projectId === event.id) t.projectId = null;
        for (const e of data.events) if (e.projectId === event.id) e.projectId = null;
        if (filter === event.id) filter = "";
      }
    } else if (event.item) {
      const index = list.findIndex((x) => x.id === event.item.id);
      if (index >= 0) list[index] = event.item; else list.push(event.item);
    }
    if (isVisible()) render();
  }

  window.addEventListener("qnb:planner", ({ detail }) => { if (loaded) apply(detail); });

  function setStatus(message, error = false) {
    const node = $("planner-status");
    node.textContent = message || "";
    node.classList.toggle("error", error);
  }

  const isVisible = () => !$("planner").hidden;

  /* ------------------------------ shell ------------------------------ */
  function show() {
    load();
    render();
  }

  function render() {
    for (const button of document.querySelectorAll(".planner-tab")) {
      const on = button.dataset.plannerTab === tab;
      button.classList.toggle("active", on);
      button.setAttribute("aria-selected", String(on));
    }
    const select = $("planner-project-filter");
    select.replaceChildren(new Option("전체", ""), ...data.projects.map((p) => new Option(p.name, p.id)));
    select.value = filter;
    if (!loaded) { body.replaceChildren(element("div", "플래너를 불러오는 중…", "planner-empty")); return; }
    const views = { dashboard: renderDashboard, calendar: renderCalendar, kanban: renderKanban, projects: renderProjects };
    body.dataset.view = tab;
    body.replaceChildren(...views[tab]());
  }

  for (const button of document.querySelectorAll(".planner-tab")) {
    button.onclick = () => { tab = button.dataset.plannerTab; localStorage.setItem("qnb_planner_tab", tab); render(); };
  }
  $("planner-project-filter").onchange = (e) => { filter = e.target.value; render(); };
  $("planner-new-task").onclick = () => openEditor("task", null, { projectId: filter || null });
  $("planner-new-event").onclick = () => openEditor("event", null, { start: today(), projectId: filter || null });

  /* ------------------------------ shared bits ------------------------------ */
  function projectChip(id) {
    const p = project(id);
    if (!p) return null;
    const chip = element("span", undefined, "planner-chip");
    const dot = element("i", undefined, "planner-dot");
    dot.style.background = p.color;
    chip.append(dot, p.name);
    return chip;
  }

  function avatar(id) {
    const m = member(id);
    if (!m) return null;
    const node = element("span", (m.nickname || "?").slice(0, 1).toUpperCase(), "chat-avatar small");
    node.style.setProperty("--hue", String((m.id * 67) % 360));
    node.title = "담당: " + (m.handle || m.nickname);
    return node;
  }

  function panel(title, ...children) {
    const box = element("section", undefined, "planner-panel");
    box.append(element("h3", title), ...children.filter(Boolean));
    return box;
  }

  function taskLine(task) {
    const row = element("button", undefined, "planner-line" + (overdue(task) ? " overdue" : ""));
    row.type = "button";
    row.onclick = () => openEditor("task", task);
    row.append(element("span", STATUS[task.status], "planner-status-pill status-" + task.status), element("span", task.title, "planner-line-title"));
    const chip = projectChip(task.projectId);
    if (chip) row.append(chip);
    if (task.dueDate) row.append(element("span", (overdue(task) ? "⚠ 기한 지남 · " : "마감 ") + shortDate(task.dueDate), "planner-line-date"));
    return row;
  }

  /* ------------------------------ dashboard ------------------------------ */
  function renderDashboard() {
    const tasks = visibleTasks();
    const now = today();
    const done = tasks.filter((t) => t.status === "done").length;
    const active = tasks.filter((t) => t.status === "doing" || t.status === "review").length;
    const late = tasks.filter(overdue);
    const rate = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

    const tiles = element("div", undefined, "planner-tiles");
    const tile = (label, value, note, cls = "") => {
      const t = element("div", undefined, "planner-tile " + cls);
      t.append(element("span", label, "planner-tile-label"), element("strong", value, "planner-tile-value"), element("span", note, "planner-tile-note"));
      return t;
    };
    tiles.append(
      tile("전체 작업", String(tasks.length), `프로젝트 ${data.projects.length}개`),
      tile("진행 중", String(active), "진행 · 검토 단계"),
      tile("완료율", rate + "%", `${done} / ${tasks.length} 완료`),
      tile("기한 지남", String(late.length), late.length ? "⚠ 확인이 필요합니다" : "✓ 모두 기한 내", late.length ? "critical" : ""),
    );

    const upcoming = [];
    const horizon = iso(addDays(new Date(), 7));
    for (const t of tasks) if (t.dueDate && t.status !== "done" && t.dueDate >= now && t.dueDate <= horizon) upcoming.push({ date: t.dueDate, node: taskLine(t) });
    for (const e of visibleEvents()) {
      const end = (e.end || e.start).slice(0, 10);
      if (end >= now && e.start.slice(0, 10) <= horizon) {
        const row = element("button", undefined, "planner-line");
        row.type = "button";
        row.onclick = () => openEditor("event", e);
        const dot = element("i", undefined, "planner-dot");
        dot.style.background = e.color || project(e.projectId)?.color || "var(--accent)";
        row.append(dot, element("span", e.title, "planner-line-title"), element("span", shortDate(e.start) + (timeOf(e.start) ? " " + timeOf(e.start) : ""), "planner-line-date"));
        upcoming.push({ date: e.start.slice(0, 10), node: row });
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    const mine = tasks.filter((t) => t.assigneeId === data.me && t.status !== "done")
      .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));

    const grid = element("div", undefined, "planner-dashboard");
    grid.append(
      tiles,
      panel("작업 상태 분포", statusBar(tasks)),
      panel("최근 14일 완료 추이", completionChart(tasks)),
      panel("프로젝트 진행률", projectProgress()),
      panel("다가오는 7일", ...(upcoming.length ? upcoming.map((x) => x.node) : [element("p", "예정된 일정이나 마감이 없습니다.", "planner-muted")])),
      panel("기한 지난 작업", ...(late.length ? late.map(taskLine) : [element("p", "기한이 지난 작업이 없습니다.", "planner-muted")])),
      panel("내 작업", ...(mine.length ? mine.slice(0, 8).map(taskLine) : [element("p", "나에게 배정된 진행 중 작업이 없습니다.", "planner-muted")])),
    );
    return [grid];
  }

  /* Stacked status bar: categorical slots 1–4 in fixed order, 2px surface gaps,
   * visible count labels (light-mode contrast relief) and a table view. */
  function statusBar(tasks) {
    const wrap = element("div", undefined, "status-bar-wrap");
    const counts = STATUS_ORDER.map((s) => [s, tasks.filter((t) => t.status === s).length]);
    const total = tasks.length;
    const bar = element("div", undefined, "status-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", "작업 상태 분포: " + counts.map(([s, n]) => `${STATUS[s]} ${n}개`).join(", "));
    if (!total) bar.append(element("span", undefined, "status-seg empty"));
    for (const [s, n] of counts) {
      if (!n) continue;
      const seg = element("span", undefined, "status-seg seg-" + s);
      seg.style.flexGrow = String(n);
      seg.dataset.tip = `${STATUS[s]} · ${n}개 (${Math.round((n / total) * 100)}%)`;
      seg.tabIndex = 0;
      bar.append(seg);
    }
    const legend = element("div", undefined, "status-legend");
    for (const [s, n] of counts) {
      const item = element("span", undefined, "status-legend-item");
      item.append(element("i", undefined, "status-swatch seg-" + s), element("span", STATUS[s]), element("strong", String(n)));
      legend.append(item);
    }
    wrap.append(bar, legend, tableView(["상태", "작업 수"], counts.map(([s, n]) => [STATUS[s], String(n)])));
    attachTooltip(bar);
    return wrap;
  }

  function completionChart(tasks) {
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(iso(addDays(new Date(), -i)));
    const counts = days.map((d) => tasks.filter((t) => t.completedAt && iso(new Date(t.completedAt * 1000)) === d).length);
    const max = Math.max(1, ...counts);
    const W = 420, H = 150, padL = 22, padB = 22, padT = 14;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "trend-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `최근 14일 완료한 작업 수, 최대 ${max}개`);
    const mk = (tag, attrs, text) => {
      const n = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const plotW = W - padL - 4;
    const plotH = H - padB - padT;
    const step = plotW / days.length;
    const barW = Math.min(18, step - 4);
    svg.append(
      mk("line", { x1: padL, x2: W - 4, y1: H - padB, y2: H - padB, class: "trend-axis" }),
      mk("line", { x1: padL, x2: W - 4, y1: padT, y2: padT, class: "trend-grid" }),
      mk("text", { x: padL - 6, y: padT + 4, class: "trend-tick", "text-anchor": "end" }, String(max)),
      mk("text", { x: padL - 6, y: H - padB + 4, class: "trend-tick", "text-anchor": "end" }, "0"),
    );
    counts.forEach((n, i) => {
      const x = padL + i * step + (step - barW) / 2;
      const h = n ? Math.max(3, (n / max) * plotH) : 0;
      const y = H - padB - h;
      if (h) {
        // 4px rounded data-end, square at the baseline
        const r = Math.min(4, barW / 2, h);
        svg.append(mk("path", {
          d: `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${H - padB} Z`,
          class: "trend-bar",
        }));
      }
      if (i % 2 === 1 || i === days.length - 1) {
        const d = parse(days[i]);
        svg.append(mk("text", { x: x + barW / 2, y: H - 6, class: "trend-tick", "text-anchor": "middle" }, `${d.getMonth() + 1}/${d.getDate()}`));
      }
      const hit = mk("rect", { x: padL + i * step, y: padT, width: step, height: plotH, class: "trend-hit", tabindex: "0" });
      hit.dataset.tip = `${shortDate(days[i])} · 완료 ${n}개`;
      svg.append(hit);
    });
    const wrap = element("div", undefined, "trend-wrap");
    wrap.append(svg, tableView(["날짜", "완료"], days.map((d, i) => [shortDate(d), String(counts[i])])));
    attachTooltip(wrap);
    return wrap;
  }

  function tableView(head, rows) {
    const details = element("details", undefined, "planner-table-view");
    details.append(element("summary", "표로 보기"));
    const table = document.createElement("table");
    const tr = document.createElement("tr");
    for (const h of head) tr.append(element("th", h));
    table.append(tr);
    for (const row of rows) {
      const r = document.createElement("tr");
      for (const c of row) r.append(element("td", c));
      table.append(r);
    }
    details.append(table);
    return details;
  }

  let tooltip;
  function attachTooltip(root) {
    if (!tooltip) {
      tooltip = element("div", undefined, "planner-tooltip");
      tooltip.hidden = true;
      document.body.append(tooltip);
    }
    const showTip = (target, x, y) => {
      tooltip.textContent = target.dataset.tip;
      tooltip.hidden = false;
      tooltip.style.left = Math.min(window.innerWidth - tooltip.offsetWidth - 8, x + 12) + "px";
      tooltip.style.top = Math.max(8, y - tooltip.offsetHeight - 10) + "px";
    };
    root.addEventListener("pointermove", (e) => {
      const target = e.target.closest?.("[data-tip]");
      if (target) showTip(target, e.clientX, e.clientY); else tooltip.hidden = true;
    });
    root.addEventListener("pointerleave", () => { tooltip.hidden = true; });
    root.addEventListener("focusin", (e) => {
      const target = e.target.closest?.("[data-tip]");
      if (!target) return;
      const r = target.getBoundingClientRect();
      showTip(target, r.left + r.width / 2, r.top);
    });
    root.addEventListener("focusout", () => { tooltip.hidden = true; });
  }

  function projectProgress() {
    if (!data.projects.length) return element("p", "프로젝트가 없습니다. 프로젝트 탭에서 만들어 보세요.", "planner-muted");
    const list = element("div", undefined, "progress-list");
    for (const p of data.projects) {
      const tasks = data.tasks.filter((t) => t.projectId === p.id);
      const done = tasks.filter((t) => t.status === "done").length;
      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
      const row = element("button", undefined, "progress-row");
      row.type = "button";
      row.onclick = () => { filter = p.id; tab = "kanban"; render(); };
      const name = element("span", undefined, "progress-name");
      const dot = element("i", undefined, "planner-dot");
      dot.style.background = p.color;
      name.append(dot, p.name);
      const track = element("span", undefined, "progress-track");
      const fill = element("i");
      fill.style.width = pct + "%";
      fill.style.background = p.color;
      track.append(fill);
      row.append(name, track, element("span", `${done}/${tasks.length} · ${pct}%`, "progress-value"));
      list.append(row);
    }
    return list;
  }

  /* ------------------------------ calendar ------------------------------ */
  function renderCalendar() {
    const head = element("div", undefined, "calendar-head");
    head.append(
      button("‹", () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); render(); }, "quiet", "이전 달"),
      element("strong", `${month.getFullYear()}년 ${month.getMonth() + 1}월`, "calendar-title"),
      button("›", () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); render(); }, "quiet", "다음 달"),
      button("오늘", () => { month = startOfMonth(new Date()); render(); }, "quiet"),
      element("span", "빈 칸을 클릭하면 일정 추가 · 항목을 끌어 날짜 이동", "planner-muted"),
    );
    const grid = element("div", undefined, "calendar-grid");
    for (const w of WEEKDAYS) grid.append(element("div", w, "calendar-weekday"));
    const first = addDays(month, -month.getDay());
    const now = today();
    const events = visibleEvents();
    const tasks = visibleTasks().filter((t) => t.dueDate);
    for (let i = 0; i < 42; i++) {
      const day = addDays(first, i);
      const key = iso(day);
      const cell = element("div", undefined, "calendar-day" + (day.getMonth() !== month.getMonth() ? " other" : "") + (key === now ? " today" : ""));
      cell.dataset.date = key;
      cell.append(element("span", String(day.getDate()), "calendar-date"));
      const items = [];
      for (const e of events) {
        const start = e.start.slice(0, 10);
        const end = (e.end || e.start).slice(0, 10);
        if (key >= start && key <= end) items.push({ kind: "event", item: e, sort: (e.allDay ? "0" : "1") + timeOf(e.start) });
      }
      for (const t of tasks) if (t.dueDate === key) items.push({ kind: "task", item: t, sort: "2" + t.title });
      items.sort((a, b) => a.sort.localeCompare(b.sort));
      const max = 4;
      for (const { kind, item } of items.slice(0, max)) cell.append(calendarItem(kind, item));
      if (items.length > max) cell.append(element("span", `+${items.length - max}개 더`, "calendar-more"));
      cell.addEventListener("click", (e) => { if (e.target === cell || e.target.classList.contains("calendar-date")) openEditor("event", null, { start: key, projectId: filter || null }); });
      cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("drop"); });
      cell.addEventListener("dragleave", () => cell.classList.remove("drop"));
      cell.addEventListener("drop", (e) => {
        e.preventDefault();
        cell.classList.remove("drop");
        const [kind, id] = (e.dataTransfer.getData("text/x-qnb-planner") || "").split(":");
        moveToDate(kind, id, key);
      });
      grid.append(cell);
    }
    return [head, grid];
  }

  function calendarItem(kind, item) {
    const node = element("button", undefined, "calendar-item " + kind + (kind === "task" && item.status === "done" ? " done" : ""));
    node.type = "button";
    node.draggable = true;
    const color = kind === "event" ? item.color || project(item.projectId)?.color || "#4338CA" : project(item.projectId)?.color || "#6C6960";
    node.style.setProperty("--item", color);
    const time = kind === "event" && !item.allDay ? timeOf(item.start) + " " : "";
    node.textContent = (kind === "task" ? (item.status === "done" ? "☑ " : "☐ ") : "") + time + item.title;
    node.title = kind === "task" ? `작업 · ${STATUS[item.status]} · 우선순위 ${PRIORITY[item.priority]}` : (item.description || item.title);
    node.onclick = (e) => { e.stopPropagation(); openEditor(kind, item); };
    node.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/x-qnb-planner", `${kind}:${item.id}`));
    return node;
  }

  function moveToDate(kind, id, date) {
    if (kind === "task") {
      const t = data.tasks.find((x) => x.id === id);
      if (t && t.dueDate !== date) {
        const startDate = t.startDate && t.startDate > date ? date : t.startDate;
        mutate("update", "task", id, { dueDate: date, startDate }).catch(() => {});
      }
    } else if (kind === "event") {
      const e = data.events.find((x) => x.id === id);
      if (!e) return;
      const delta = dayDiff(e.start.slice(0, 10), date);
      if (!delta) return;
      const shift = (s) => s && iso(addDays(parse(s), delta)) + s.slice(10);
      mutate("update", "event", id, { start: shift(e.start), end: shift(e.end) }).catch(() => {});
    }
  }

  /* ------------------------------ kanban ------------------------------ */
  function renderKanban() {
    const board = element("div", undefined, "kanban");
    const tasks = visibleTasks();
    for (const status of STATUS_ORDER) {
      const column = element("section", undefined, "kanban-col col-" + status);
      column.dataset.status = status;
      const items = tasks.filter((t) => t.status === status).sort((a, b) => a.position - b.position);
      const head = element("header", undefined, "kanban-head");
      head.append(element("i", undefined, "status-swatch seg-" + status), element("strong", STATUS[status]), element("span", String(items.length), "kanban-count"));
      const list = element("div", undefined, "kanban-list");
      for (const t of items) list.append(kanbanCard(t));
      list.addEventListener("dragover", (e) => {
        e.preventDefault();
        column.classList.add("drop");
        const after = cardAfter(list, e.clientY);
        const placeholder = board.querySelector(".kanban-placeholder") || element("div", undefined, "kanban-placeholder");
        if (after) list.insertBefore(placeholder, after); else list.append(placeholder);
      });
      list.addEventListener("dragleave", (e) => { if (!list.contains(e.relatedTarget)) column.classList.remove("drop"); });
      list.addEventListener("drop", (e) => {
        e.preventDefault();
        column.classList.remove("drop");
        const id = (e.dataTransfer.getData("text/x-qnb-planner") || "").split(":")[1];
        const placeholder = board.querySelector(".kanban-placeholder");
        const before = placeholder?.previousElementSibling?.dataset.id;
        const after = placeholder?.nextElementSibling?.dataset.id;
        placeholder?.remove();
        dropTask(id, status, before, after);
      });
      const add = document.createElement("form");
      add.className = "kanban-add";
      const input = document.createElement("input");
      input.placeholder = "＋ 작업 추가 (Enter)";
      input.maxLength = 200;
      add.append(input);
      add.onsubmit = (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        input.value = "";
        const last = items.at(-1);
        mutate("create", "task", null, { title, status, projectId: filter || null, position: (last?.position || 0) + 1024 }).catch(() => {});
      };
      column.append(head, list, add);
      board.append(column);
    }
    board.addEventListener("dragend", () => { board.querySelector(".kanban-placeholder")?.remove(); for (const c of board.querySelectorAll(".drop")) c.classList.remove("drop"); });
    return [board];
  }

  function cardAfter(list, y) {
    for (const card of list.querySelectorAll(".kanban-card:not(.dragging)")) {
      const r = card.getBoundingClientRect();
      if (y < r.top + r.height / 2) return card;
    }
    return null;
  }

  function dropTask(id, status, beforeId, afterId) {
    const t = data.tasks.find((x) => x.id === id);
    if (!t) return;
    const before = data.tasks.find((x) => x.id === beforeId && x.id !== id);
    const after = data.tasks.find((x) => x.id === afterId && x.id !== id);
    let position;
    if (before && after) position = (before.position + after.position) / 2;
    else if (before) position = before.position + 1024;
    else if (after) position = after.position - 1024;
    else position = 0;
    if (t.status === status && t.position === position) return;
    // Optimistic update so the card does not jump back while the request is in flight.
    t.status = status;
    t.position = position;
    render();
    mutate("update", "task", id, { status, position }).catch(() => load(true));
  }

  function kanbanCard(t) {
    const card = element("article", undefined, "kanban-card priority-" + t.priority + (overdue(t) ? " overdue" : ""));
    card.dataset.id = t.id;
    card.draggable = true;
    card.tabIndex = 0;
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-qnb-planner", `task:${t.id}`); card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.onclick = () => openEditor("task", t);
    card.onkeydown = (e) => { if (e.key === "Enter") openEditor("task", t); };
    card.append(element("strong", t.title, "kanban-title"));
    if (t.description) card.append(element("p", t.description.slice(0, 120), "kanban-desc"));
    const meta = element("div", undefined, "kanban-meta");
    const chip = projectChip(t.projectId);
    if (chip) meta.append(chip);
    meta.append(element("span", PRIORITY[t.priority], "priority-badge priority-" + t.priority));
    if (t.dueDate) meta.append(element("span", (overdue(t) ? "⚠ " : "📅 ") + shortDate(t.dueDate), "kanban-due"));
    for (const tag of t.tags || []) meta.append(element("span", "#" + tag, "kanban-tag"));
    const who = avatar(t.assigneeId);
    if (who) meta.append(who);
    card.append(meta);
    return card;
  }

  /* ------------------------------ projects ------------------------------ */
  function renderProjects() {
    const grid = element("div", undefined, "project-grid");
    for (const p of data.projects) {
      const tasks = data.tasks.filter((t) => t.projectId === p.id);
      const done = tasks.filter((t) => t.status === "done").length;
      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
      const card = element("article", undefined, "project-card");
      card.style.setProperty("--project", p.color);
      const head = element("header", undefined, "project-card-head");
      head.append(element("strong", p.name), element("span", PROJECT_STATUS[p.status], "project-state state-" + p.status));
      card.append(head);
      if (p.description) card.append(element("p", p.description, "project-desc"));
      if (p.startDate || p.endDate) card.append(element("p", `${p.startDate ? shortDate(p.startDate) : "?"} → ${p.endDate ? shortDate(p.endDate) : "?"}`, "project-dates"));
      const track = element("div", undefined, "progress-track");
      const fill = element("i");
      fill.style.width = pct + "%";
      fill.style.background = p.color;
      track.append(fill);
      card.append(track, element("p", `${pct}% 완료 · ` + STATUS_ORDER.map((s) => `${STATUS[s]} ${tasks.filter((t) => t.status === s).length}`).join(" · "), "project-counts"));
      const actions = element("div", undefined, "project-actions");
      actions.append(
        button("칸반 보기", () => { filter = p.id; tab = "kanban"; render(); }, "quiet"),
        button("편집", () => openEditor("project", p), "quiet"),
      );
      card.append(actions);
      grid.append(card);
    }
    const add = button("＋ 새 프로젝트", () => openEditor("project", null, { color: DEFAULT_COLORS[data.projects.length % DEFAULT_COLORS.length] }), "project-card project-add");
    grid.append(add);
    return [grid, panel("타임라인", timeline())];
  }

  /* Gantt-lite: projects and dated tasks over a 12-week window starting two weeks back. */
  function timeline() {
    const start = addDays(new Date(), -14 - new Date().getDay());
    const days = 84;
    const end = addDays(start, days);
    const rows = [];
    for (const p of data.projects) {
      const tasks = data.tasks.filter((t) => t.projectId === p.id && (t.startDate || t.dueDate));
      const dates = [p.startDate, p.endDate, ...tasks.flatMap((t) => [t.startDate, t.dueDate])].filter(Boolean).sort();
      if (dates.length) rows.push({ label: p.name, from: p.startDate || dates[0], to: p.endDate || dates.at(-1), color: p.color, project: true, open: () => openEditor("project", p) });
      for (const t of tasks) rows.push({ label: t.title, from: t.startDate || t.dueDate, to: t.dueDate || t.startDate, color: p.color, done: t.status === "done", open: () => openEditor("task", t) });
    }
    for (const t of data.tasks.filter((x) => !x.projectId && (x.startDate || x.dueDate))) {
      rows.push({ label: t.title, from: t.startDate || t.dueDate, to: t.dueDate || t.startDate, color: "#6C6960", done: t.status === "done", open: () => openEditor("task", t) });
    }
    if (!rows.length) return element("p", "시작일 · 마감일이 있는 프로젝트나 작업을 만들면 타임라인에 표시됩니다.", "planner-muted");
    const box = element("div", undefined, "timeline");
    const scale = element("div", undefined, "timeline-scale");
    for (let w = 0; w < days / 7; w++) {
      const d = addDays(start, w * 7);
      scale.append(element("span", `${d.getMonth() + 1}/${d.getDate()}`));
    }
    box.append(element("span", "", "timeline-label"), scale);
    const pctOf = (s) => (Math.max(0, Math.min(days, dayDiff(iso(start), s))) / days) * 100;
    const todayPct = pctOf(today());
    for (const row of rows) {
      if (row.to < iso(start) || row.from > iso(end)) continue;
      const label = element("button", row.label, "timeline-label" + (row.project ? " project" : ""));
      label.type = "button";
      label.onclick = row.open;
      const lane = element("div", undefined, "timeline-lane");
      const bar = element("span", undefined, "timeline-bar" + (row.done ? " done" : "") + (row.project ? " project" : ""));
      const left = pctOf(row.from);
      const right = pctOf(iso(addDays(parse(row.to), 1)));
      bar.style.left = left + "%";
      bar.style.width = Math.max(1.2, right - left) + "%";
      bar.style.background = row.color;
      bar.dataset.tip = `${row.label} · ${shortDate(row.from)} → ${shortDate(row.to)}`;
      const now = element("i", undefined, "timeline-today");
      now.style.left = todayPct + "%";
      lane.append(now, bar);
      box.append(label, lane);
    }
    attachTooltip(box);
    return box;
  }

  /* ------------------------------ editor dialog ------------------------------ */
  function field(label, input, wide = false) {
    const wrap = element("label", undefined, "planner-field" + (wide ? " wide" : ""));
    wrap.append(element("span", label), input);
    return wrap;
  }

  function input(name, value, type = "text", extra = {}) {
    const node = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") node.type = type;
    node.name = name;
    if (type === "checkbox") node.checked = Boolean(value); else node.value = value ?? "";
    Object.assign(node, extra);
    return node;
  }

  function select(name, value, options) {
    const node = document.createElement("select");
    node.name = name;
    for (const [v, label] of options) node.append(new Option(label, v));
    node.value = value ?? "";
    return node;
  }

  const projectOptions = () => [["", "(없음)"], ...data.projects.map((p) => [p.id, p.name])];

  function openEditor(kind, item, defaults = {}) {
    editing = { kind, item };
    const v = { ...defaults, ...(item || {}) };
    const titles = { task: "작업", event: "일정", project: "프로젝트" };
    $("planner-dialog-title").textContent = (item ? "편집 · " : "새 ") + titles[kind];
    $("planner-delete").hidden = !item;
    $("planner-form-error").hidden = true;
    const fields = [];
    if (kind === "task") {
      fields.push(
        field("제목", input("title", v.title, "text", { required: true, maxLength: 200 }), true),
        field("설명", input("description", v.description, "textarea", { rows: 3, maxLength: 4000 }), true),
        field("프로젝트", select("projectId", v.projectId, projectOptions())),
        field("상태", select("status", v.status || "todo", Object.entries(STATUS))),
        field("우선순위", select("priority", v.priority || "medium", Object.entries(PRIORITY))),
        field("담당자", select("assigneeId", v.assigneeId ?? "", [["", "(미지정)"], ...data.members.map((m) => [String(m.id), m.handle || m.nickname])])),
        field("시작일", input("startDate", v.startDate, "date")),
        field("마감일", input("dueDate", v.dueDate, "date")),
        field("태그 (쉼표로 구분)", input("tags", (v.tags || []).join(", "), "text", { maxLength: 260 }), true),
      );
    } else if (kind === "event") {
      const allDay = v.allDay !== false && !(v.start || "").includes("T");
      const type = allDay ? "date" : "datetime-local";
      const startInput = input("start", allDay ? (v.start || today()).slice(0, 10) : v.start, type, { required: true });
      const endInput = input("end", v.end ? (allDay ? v.end.slice(0, 10) : v.end) : "", type);
      const allDayInput = input("allDay", allDay, "checkbox");
      allDayInput.onchange = () => {
        const t = allDayInput.checked ? "date" : "datetime-local";
        for (const node of [startInput, endInput]) {
          const value = node.value;
          node.type = t;
          node.value = !value ? "" : t === "date" ? value.slice(0, 10) : value.length === 10 ? value + "T09:00" : value;
        }
      };
      fields.push(
        field("제목", input("title", v.title, "text", { required: true, maxLength: 200 }), true),
        field("종일", allDayInput),
        field("프로젝트", select("projectId", v.projectId, projectOptions())),
        field("시작", startInput),
        field("종료", endInput),
        field("색상", input("color", v.color || project(v.projectId)?.color || "#4338CA", "color")),
        field("설명", input("description", v.description, "textarea", { rows: 3, maxLength: 2000 }), true),
      );
    } else {
      fields.push(
        field("이름", input("name", v.name, "text", { required: true, maxLength: 80 }), true),
        field("색상", input("color", v.color || "#4338CA", "color")),
        field("상태", select("status", v.status || "active", Object.entries(PROJECT_STATUS))),
        field("시작일", input("startDate", v.startDate, "date")),
        field("종료일", input("endDate", v.endDate, "date")),
        field("설명", input("description", v.description, "textarea", { rows: 3, maxLength: 2000 }), true),
      );
    }
    $("planner-form-fields").replaceChildren(...fields);
    $("planner-dialog").returnValue = "";
    $("planner-dialog").showModal();
    $("planner-form-fields").querySelector("input, textarea")?.focus();
  }

  function formPayload(kind) {
    const form = $("planner-form");
    const get = (name) => form.elements[name];
    const val = (name) => get(name)?.value.trim() ?? "";
    if (kind === "task") {
      return {
        title: val("title"), description: val("description"), projectId: val("projectId") || null,
        status: val("status"), priority: val("priority"), assigneeId: val("assigneeId") ? Number(val("assigneeId")) : null,
        startDate: val("startDate") || null, dueDate: val("dueDate") || null,
        tags: val("tags").split(",").map((x) => x.trim()).filter(Boolean),
      };
    }
    if (kind === "event") {
      return {
        title: val("title"), description: val("description"), projectId: val("projectId") || null,
        allDay: get("allDay").checked, start: val("start"), end: val("end") || null, color: val("color") || null,
      };
    }
    return {
      name: val("name"), color: val("color"), status: val("status"), description: val("description"),
      startDate: val("startDate") || null, endDate: val("endDate") || null,
    };
  }

  $("planner-form").addEventListener("submit", async (event) => {
    const action = event.submitter?.value;
    if (action === "cancel" || !editing) return;
    event.preventDefault();
    const { kind, item } = editing;
    try {
      if (action === "delete") {
        const name = item.title || item.name;
        const extra = kind === "project" ? "\n프로젝트의 작업과 일정은 삭제되지 않고 프로젝트 연결만 해제됩니다." : "";
        if (!confirm(`'${name}'을(를) 삭제할까요?${extra}`)) return;
        await mutate("delete", kind, item.id);
      } else {
        const payload = formPayload(kind);
        if (kind === "task" && !item) {
          const lane = data.tasks.filter((t) => t.status === payload.status);
          payload.position = (Math.max(0, ...lane.map((t) => t.position)) || 0) + 1024;
        }
        await mutate(item ? "update" : "create", kind, item?.id, payload);
      }
      $("planner-dialog").close();
      editing = null;
    } catch (error) {
      $("planner-form-error").textContent = error.message;
      $("planner-form-error").hidden = false;
    }
  });

  // Data belongs to the current workspace: drop it when the workspace changes.
  function reset() { loaded = false; data = { projects: [], tasks: [], events: [], members: [], me: null }; filter = ""; if (isVisible()) show(); }

  return { show, reset, reload: () => load(true) };
})();
