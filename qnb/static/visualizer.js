"use strict";

window.QNBVisualizer = (() => {
  const $ = (id) => document.getElementById(id);

  let host = null;
  let activePane = "lean";
  let studioOpen = true;

  let leanViz = null;
  let leanStepIdx = 0;
  let leanTimer = null;
  let leanContext = { path: null, cell: null };

  let pyViz = null;
  let pyStepIdx = 0;
  let pyTimer = null;
  let pyContext = { path: null, cell: null };

  let projectGraph = null;
  let projectData = null;
  let projectNodes = new Map();
  let selectedProjNode = null;
  let flowSteps = [];
  let flowIdx = -1;
  let flowTimer = null;
  let runtimeCallEdges = [];

  const EXAMPLES = [
    {
      id: "lean-induction",
      badge: "Lean 4 · 노트북",
      title: "수학적 귀납법과 증명 상태 변화",
      description: "0 + n = n을 귀납법으로 증명하면서 기저/귀납 사례의 가정(Context)과 목표(⊢)가 한 줄씩 바뀌는 과정을 봅니다.",
      entryPath: "/examples/lean_induction_tour.ipynb",
      runMode: "notebook-first-code",
      files: {
        "/examples/lean_induction_tour.ipynb": JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: { kernelspec: { name: "lean4", display_name: "Lean 4", language: "lean4" } },
          cells: [
            {
              id: "ex-lean-md-1",
              cell_type: "markdown",
              metadata: {},
              source: "# 귀납법으로 눈으로 보는 Lean 4 증명\n\n아래 셀을 실행(`Shift+Enter`)한 뒤 오른쪽 **⊢ Lean 4 증명** 패널에서 각 전술(`induction`, `rw`)을 눌러 가정과 목표가 어떻게 변하는지 확인해 보세요.",
            },
            {
              id: "ex-lean-code-1",
              cell_type: "code",
              metadata: { qnb_language: "lean4" },
              execution_count: null,
              outputs: [],
              source: [
                "theorem zero_add_tour (n : Nat) : 0 + n = n := by\n",
                "  induction n with\n",
                "  | zero =>\n",
                "    rfl\n",
                "  | succ k ih =>\n",
                "    rw [Nat.add_succ]\n",
                "    rw [ih]",
              ].join(""),
            },
            {
              id: "ex-lean-code-2",
              cell_type: "code",
              metadata: { qnb_language: "lean4" },
              execution_count: null,
              outputs: [],
              source: [
                "-- 앞 셀이 DB에 저장한 zero_add_tour를 자동으로 복원해 이어서 증명합니다.\n",
                "theorem zero_add_double (n : Nat) : (0 + n) + 0 = n := by\n",
                "  rw [zero_add_tour]\n",
                "  rfl",
              ].join(""),
            },
          ],
        }, null, 1) + "\n",
      },
    },
    {
      id: "lean-logic",
      badge: "Lean 4 · 파일",
      title: "명제 논리 퍼즐 · 가설 분해와 목표 구성",
      description: "intro, cases, constructor, left/right 전술이 논리곱(∧)·논리합(∨) 가정을 어떻게 분해하고 목표를 닫는지 단계별로 봅니다.",
      entryPath: "/examples/lean_logic_puzzle.lean",
      runMode: "plain",
      files: {
        "/examples/lean_logic_puzzle.lean": [
          "-- 각 줄에 커서를 두거나 ▶ 실행 · 시각화를 누르면 오른쪽에서 증명 상태가 변화합니다.",
          "theorem and_comm_puzzle (P Q : Prop) : P ∧ Q → Q ∧ P := by",
          "  intro h",
          "  rcases h with ⟨hp, hq⟩",
          "  constructor",
          "  · exact hq",
          "  · exact hp",
          "",
          "theorem or_dist_puzzle (P Q R : Prop) : P ∧ (Q ∨ R) → (P ∧ Q) ∨ (P ∧ R) := by",
          "  intro h",
          "  rcases h with ⟨hp, hqr⟩",
          "  cases hqr with",
          "  | inl hq =>",
          "    left",
          "    exact ⟨hp, hq⟩",
          "  | inr hr =>",
          "    right",
          "    exact ⟨hp, hr⟩",
          "",
        ].join("\n"),
      },
    },
    {
      id: "python-mergesort",
      badge: "Python · 알고리즘",
      title: "재귀 호출 스택과 병합 정렬 과정",
      description: "분할 정복 재귀 호출이 스택에 쌓이고 풀리며 작은 배열 조각이 정렬되어 합쳐지는 과정을 한 줄씩 되감아 봅니다.",
      entryPath: "/examples/python_divide_conquer.py",
      runMode: "plain",
      files: {
        "/examples/python_divide_conquer.py": [
          "def merge(left, right):",
          "    merged = []",
          "    i = 0",
          "    j = 0",
          "    while i < len(left) and j < len(right):",
          "        if left[i] <= right[j]:",
          "            merged.append(left[i])",
          "            i += 1",
          "        else:",
          "            merged.append(right[j])",
          "            j += 1",
          "    merged.extend(left[i:])",
          "    merged.extend(right[j:])",
          "    return merged",
          "",
          "def merge_sort(arr):",
          "    if len(arr) <= 1:",
          "        return arr",
          "    mid = len(arr) // 2",
          "    left_sorted = merge_sort(arr[:mid])",
          "    right_sorted = merge_sort(arr[mid:])",
          "    return merge(left_sorted, right_sorted)",
          "",
          "numbers = [38, 27, 43, 3, 9]",
          "sorted_numbers = merge_sort(numbers)",
          "print('원본:', numbers)",
          "print('정렬:', sorted_numbers)",
          "",
        ].join("\n"),
      },
    },
    {
      id: "python-orbit-project",
      badge: "Python · 멀티파일 프로젝트",
      title: "2D 중력 궤도 시뮬레이터 (3개 파일 연동)",
      description: "vector2d.py, body.py, simulate.py가 서로 import·호출하며 객체를 갱신하는 흐름을 실행 추적과 프로젝트 그래프로 동시에 봅니다.",
      entryPath: "/examples/orbit_sim/simulate.py",
      runMode: "plain-and-project",
      projectPath: "/examples/orbit_sim",
      files: {
        "/examples/orbit_sim/vector2d.py": [
          "class Vec2:",
          "    def __init__(self, x, y):",
          "        self.x = x",
          "        self.y = y",
          "",
          "    def add(self, other):",
          "        return Vec2(self.x + other.x, self.y + other.y)",
          "",
          "    def scale(self, factor):",
          "        return Vec2(self.x * factor, self.y * factor)",
          "",
        ].join("\n"),
        "/examples/orbit_sim/body.py": [
          "from vector2d import Vec2",
          "",
          "class Body:",
          "    def __init__(self, name, pos, vel):",
          "        self.name = name",
          "        self.pos = pos",
          "        self.vel = vel",
          "",
          "    def step(self, accel, dt):",
          "        self.vel = self.vel.add(accel.scale(dt))",
          "        self.pos = self.pos.add(self.vel.scale(dt))",
          "",
        ].join("\n"),
        "/examples/orbit_sim/simulate.py": [
          "from vector2d import Vec2",
          "from body import Body",
          "",
          "def gravity_accel(pos):",
          "    r2 = pos.x * pos.x + pos.y * pos.y + 0.5",
          "    inv = -4.0 / r2",
          "    return Vec2(pos.x * inv, pos.y * inv)",
          "",
          "def run_simulation(steps):",
          "    probe = Body('Probe', Vec2(2.0, 0.0), Vec2(0.0, 1.4))",
          "    history = []",
          "    for tick in range(steps):",
          "        acc = gravity_accel(probe.pos)",
          "        probe.step(acc, 0.25)",
          "        history.append((round(probe.pos.x, 3), round(probe.pos.y, 3)))",
          "    return history",
          "",
          "trajectory = run_simulation(4)",
          "for step_no, coord in enumerate(trajectory, 1):",
          "    print(f'step {step_no}: pos={coord}')",
          "",
        ].join("\n"),
      },
    },
  ];

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function setStudioVisible(visible) {
    studioOpen = Boolean(visible);
    const split = $("workbench-split");
    if (split) split.classList.toggle("viz-collapsed", !studioOpen);
    const toggle = $("viz-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", String(studioOpen));
    if (studioOpen && activePane === "project") {
      setTimeout(() => projectGraph?.fit(), 30);
    }
  }

  function switchPane(pane) {
    activePane = pane;
    if (!studioOpen) setStudioVisible(true);
    for (const key of ["lean", "python", "project"]) {
      $("viz-tab-" + key)?.classList.toggle("active", key === pane);
      $("viz-tab-" + key)?.setAttribute("aria-selected", String(key === pane));
      const box = $("viz-pane-" + key);
      if (box) box.hidden = key !== pane;
    }
    if (pane === "project") {
      if (!projectData) analyzeProject();
      else setTimeout(() => projectGraph?.fit(), 20);
    }
  }

  function stopLeanPlay() {
    if (leanTimer) {
      clearInterval(leanTimer);
      leanTimer = null;
    }
    const btn = $("viz-lean-play");
    if (btn) btn.textContent = "▶ 자동재생";
  }

  function stopPyPlay() {
    if (pyTimer) {
      clearInterval(pyTimer);
      pyTimer = null;
    }
    const btn = $("viz-py-play");
    if (btn) btn.textContent = "▶ 자동재생";
  }

  function stopFlowPlay() {
    if (flowTimer) {
      clearInterval(flowTimer);
      flowTimer = null;
    }
    const btn = $("viz-proj-play");
    if (btn) btn.textContent = "▶ 흐름 재생";
  }

  function renderLeanPipeline(pipeline) {
    const box = $("viz-lean-pipeline");
    box.replaceChildren(...(pipeline || []).map((stage) => {
      const card = el("div", undefined, "viz-pipe-stage status-" + stage.status);
      const badge = stage.status === "ok" ? "✓" : stage.status === "error" ? "✕" : "·";
      card.append(
        el("span", badge + " " + stage.label, "viz-pipe-title"),
        el("small", stage.detail || "", "viz-pipe-detail"),
      );
      return card;
    }));
  }

  function renderGoalCard(goal, prevGoal, badgeText, badgeKind) {
    const card = el("div", undefined, "viz-goal-card");
    const head = el("div", undefined, "viz-goal-head");
    head.append(el("span", badgeText, "viz-goal-badge " + badgeKind));
    if (goal.case) head.append(el("span", "case " + goal.case, "viz-case-pill"));
    card.append(head);

    const prevNames = new Set((prevGoal?.hypotheses || []).map((h) => h.name).filter(Boolean));
    if (goal.hypotheses?.length) {
      const hyps = el("div", undefined, "viz-hyps");
      for (const hyp of goal.hypotheses) {
        const isNew = hyp.name && !prevNames.has(hyp.name);
        const row = el("div", undefined, "viz-hyp-row" + (isNew ? " added" : ""));
        row.append(
          el("span", hyp.name || "_", "viz-hyp-name"),
          el("span", ":", "viz-hyp-sep"),
          el("code", hyp.type, "viz-hyp-type"),
        );
        if (isNew) row.append(el("span", "NEW", "viz-new-tag"));
        hyps.append(row);
      }
      card.append(hyps);
    }

    const target = el("div", undefined, "viz-goal-target");
    target.append(el("span", "⊢", "viz-turnstile"), el("code", goal.target || "—"));
    card.append(target);
    return card;
  }

  function renderLeanStep(idx) {
    if (!leanViz || !leanViz.steps?.length) return;
    leanStepIdx = Math.max(0, Math.min(leanViz.steps.length - 1, idx));
    const step = leanViz.steps[leanStepIdx];
    $("viz-lean-slider").value = String(leanStepIdx);
    $("viz-lean-counter").textContent = `${leanStepIdx + 1} / ${leanViz.steps.length}`;
    $("viz-lean-first").disabled = leanStepIdx === 0;
    $("viz-lean-prev").disabled = leanStepIdx === 0;
    $("viz-lean-next").disabled = leanStepIdx === leanViz.steps.length - 1;
    $("viz-lean-last").disabled = leanStepIdx === leanViz.steps.length - 1;

    const kind = step.status === "solved" ? "solved" : leanViz.ok ? "lean" : "error";
    host?.highlightLine(leanContext.path, leanContext.cell, step.line, kind);

    const stepBox = $("viz-lean-step-box");
    const statusLabel = step.status === "solved"
      ? "✓ 목표 해결"
      : step.status === "open"
        ? `남은 목표 ${step.goalsAfter.length}개`
        : "선언 / 정의";
    stepBox.replaceChildren(
      (() => {
        const top = el("div", undefined, "viz-explain-top");
        top.append(
          el("span", `${step.line}행 · ${step.tactic || "선언"}`, "viz-step-pill"),
          el("span", statusLabel, "viz-step-state status-" + step.status),
        );
        return top;
      })(),
      el("pre", step.code.trim() || step.code, "viz-step-code"),
      el("p", step.hint, "viz-step-hint"),
    );

    const goalsBox = $("viz-lean-goals");
    const nodes = [];
    if (step.goalsBefore?.length) {
      nodes.push(el("h4", "적용 전 상태 (Before)", "viz-subhead"));
      nodes.push(renderGoalCard(step.goalsBefore[0], null, "이전 목표", "before"));
    }
    if (step.status === "solved") {
      const done = el("div", undefined, "viz-solved-banner");
      done.append(el("strong", "✓ 목표 증명 완료 (no goals)"), el("span", "이 줄의 전술이 현재 하위 목표를 완전히 닫았습니다."));
      nodes.push(done);
    } else if (step.goalsAfter?.length) {
      nodes.push(el("h4", `적용 후 상태 (After · ${step.goalsAfter.length}개 목표)`, "viz-subhead"));
      step.goalsAfter.forEach((goal, gIdx) => {
        nodes.push(renderGoalCard(
          goal,
          gIdx === 0 ? step.goalsBefore?.[0] : null,
          gIdx === 0 ? "현재 목표" : `하위 목표 ${gIdx + 1}`,
          "after",
        ));
      });
    } else if (!step.goalsBefore?.length) {
      nodes.push(el("p", "선언 헤더 또는 정의 줄입니다. 전술 줄을 선택하면 가정과 목표 변화를 볼 수 있습니다.", "viz-muted-note"));
    }
    goalsBox.replaceChildren(...nodes);
  }

  function renderLeanViz(viz, context = {}) {
    stopLeanPlay();
    leanViz = viz;
    leanContext = context;
    switchPane("lean");

    const hasSteps = Boolean(viz?.steps?.length);
    $("viz-lean-empty").hidden = Boolean(viz);
    $("viz-lean-content").hidden = !viz;
    if (!viz) return;

    renderLeanPipeline(viz.pipeline);
    const slider = $("viz-lean-slider");
    slider.max = String(Math.max(0, (viz.steps?.length || 1) - 1));
    slider.disabled = !hasSteps;

    if (hasSteps) {
      const firstTactic = viz.steps.findIndex((s) => s.status !== "decl");
      renderLeanStep(firstTactic >= 0 ? firstTactic : 0);
    } else {
      $("viz-lean-counter").textContent = "0 / 0";
      $("viz-lean-step-box").replaceChildren(el("p", viz.output || "표시할 증명 단계가 없습니다.", "viz-step-hint"));
      $("viz-lean-goals").replaceChildren();
    }

    const declsBox = $("viz-lean-decls");
    if (viz.declarations?.length) {
      const headBar = el("div", undefined, "viz-mini-dag-bar");
      headBar.append(el("h4", "검증된 선언 & 정리 의존성"));
      if (host?.openProofTree) {
        const treeBtn = el("button", "증명 트리 DAG에서 탐색 →", "quiet");
        treeBtn.type = "button";
        treeBtn.onclick = () => host.openProofTree(viz.declarations[0]?.name);
        headBar.append(treeBtn);
      }
      const list = el("div", undefined, "viz-decl-list");
      for (const decl of viz.declarations) {
        const card = el("div", undefined, "viz-decl-card");
        const row = el("div", undefined, "viz-decl-head");
        row.append(
          el("span", decl.kind, "viz-decl-kind kind-" + decl.kind),
          el("strong", decl.name),
          el("span", `${decl.line}행`, "viz-decl-line"),
        );
        card.append(row);
        if (decl.dependencies?.length || decl.axioms?.length) {
          const deps = [
            ...decl.dependencies.map((d) => `→ ${d}`),
            ...decl.axioms.map((a) => `공리: ${a}`),
          ];
          card.append(el("div", deps.join(" · "), "viz-decl-deps"));
        }
        card.onclick = () => {
          const stepIndex = leanViz.steps.findIndex((s) => s.line >= decl.line);
          if (stepIndex >= 0) renderLeanStep(stepIndex);
        };
        list.append(card);
      }

      // Build inline mini dependency DAG from current Lean snippet declarations
      const declNames = new Set(viz.declarations.map((d) => d.name));
      const miniNodes = [];
      const seenNodes = new Set();
      const miniEdges = [];
      for (const d of viz.declarations) {
        if (!seenNodes.has(d.name)) {
          seenNodes.add(d.name);
          miniNodes.push({ id: d.name, name: d.name, kind: d.kind, depth: 0 });
        }
        for (const dep of d.dependencies || []) {
          if (!seenNodes.has(dep)) {
            seenNodes.add(dep);
            miniNodes.push({ id: dep, name: dep, kind: declNames.has(dep) ? "theorem" : "external", depth: 1 });
          }
          miniEdges.push({ from: d.name, to: dep });
        }
        for (const ax of d.axioms || []) {
          const axId = "axiom:" + ax;
          if (!seenNodes.has(axId)) {
            seenNodes.add(axId);
            miniNodes.push({ id: axId, name: ax, kind: "axiom", depth: 2 });
          }
          miniEdges.push({ from: d.name, to: axId });
        }
      }

      const nodes = [headBar, list];
      if (miniNodes.length > 0) {
        const wrap = el("div", undefined, "viz-mini-dag-wrap");
        const miniCanvas = document.createElement("canvas");
        miniCanvas.setAttribute("aria-label", "선언 의존성 미니 그래프");
        wrap.append(miniCanvas);
        nodes.push(wrap);
        setTimeout(() => {
          if (!wrap.isConnected) return;
          const mg = new QNBGraph.ProofGraph(miniCanvas, (id) => {
            const match = viz.declarations.find((d) => d.name === id);
            if (match) {
              const stepIndex = leanViz.steps.findIndex((s) => s.line >= match.line);
              if (stepIndex >= 0) renderLeanStep(stepIndex);
            }
          });
          mg.render({ root: viz.declarations[viz.declarations.length - 1].name, nodes: miniNodes, edges: miniEdges }, null);
        }, 20);
      }
      declsBox.replaceChildren(...nodes);
    } else {
      declsBox.replaceChildren();
    }
  }

  function formatValueSummary(val, heap) {
    if (!val) return "None";
    if (val.kind === "prim") return val.type === "str" ? JSON.stringify(val.value) : String(val.value);
    if (val.kind === "repr") return val.text;
    if (val.kind === "ref") {
      const obj = heap?.[val.id];
      return obj ? `${obj.type}#${val.id.replace("obj_", "")} (${obj.length})` : `#${val.id}`;
    }
    return String(val);
  }

  function renderValuePill(val, heap) {
    if (!val) return el("code", "None", "viz-val-prim");
    if (val.kind === "ref") {
      const obj = heap?.[val.id];
      const badge = el("span", `${obj ? obj.type : "obj"} #${val.id.replace("obj_", "")}`, "viz-ref-badge");
      return badge;
    }
    if (val.kind === "prim") {
      const txt = val.type === "str" ? JSON.stringify(val.value) : String(val.value);
      return el("code", txt, "viz-val-prim type-" + val.type);
    }
    return el("code", val.text || "", "viz-val-prim");
  }

  function renderPyStep(idx) {
    if (!pyViz || !pyViz.steps?.length) return;
    pyStepIdx = Math.max(0, Math.min(pyViz.steps.length - 1, idx));
    const step = pyViz.steps[pyStepIdx];
    const prevStep = pyStepIdx > 0 ? pyViz.steps[pyStepIdx - 1] : null;

    $("viz-py-slider").value = String(pyStepIdx);
    $("viz-py-counter").textContent = `${pyStepIdx + 1} / ${pyViz.steps.length}`;
    $("viz-py-first").disabled = pyStepIdx === 0;
    $("viz-py-prev").disabled = pyStepIdx === 0;
    $("viz-py-next").disabled = pyStepIdx === pyViz.steps.length - 1;
    $("viz-py-last").disabled = pyStepIdx === pyViz.steps.length - 1;

    const kind = step.error ? "error" : step.event === "return" ? "solved" : "active";
    host?.highlightLine(step.file || pyContext.path, pyContext.cell, step.line, kind);

    const explainBox = $("viz-py-explain");
    const top = el("div", undefined, "viz-explain-top");
    top.append(
      el("span", `${step.file} : ${step.line}행 · ${step.func}`, "viz-step-pill"),
      el("span", step.event.toUpperCase(), "viz-step-state event-" + step.event),
    );
    const explainChildren = [top];
    if (step.code) explainChildren.push(el("pre", step.code, "viz-step-code"));
    explainChildren.push(el("p", step.explain, "viz-step-hint" + (step.error ? " error" : "")));
    if (pyViz.truncatedSteps && pyStepIdx === pyViz.steps.length - 1) {
      explainChildren.push(el("small", `※ ${pyViz.maxSteps || 220}단계를 초과해 이후 추적은 생략되었습니다.`, "viz-muted-note"));
    }
    explainBox.replaceChildren(...explainChildren);

    const prevFrameMap = new Map();
    if (prevStep?.stack) {
      for (const f of prevStep.stack) {
        prevFrameMap.set(`${f.file}:${f.func}`, f.locals || {});
      }
    }

    const stackBox = $("viz-py-stack");
    const frames = [...(step.stack || [])].reverse();
    if (!frames.length) {
      stackBox.replaceChildren(el("p", "활성 스택 프레임이 없습니다.", "viz-muted-note"));
    } else {
      stackBox.replaceChildren(...frames.map((frame, i) => {
        const card = el("div", undefined, "viz-frame-card" + (i === 0 ? " top-frame" : ""));
        const fhead = el("div", undefined, "viz-frame-head");
        fhead.append(
          el("strong", frame.func === "<module>" ? "전역 (module)" : frame.func + "()"),
          el("span", `${frame.file}:${frame.line}`, "viz-frame-loc"),
        );
        card.append(fhead);

        const prevLocals = prevFrameMap.get(`${frame.file}:${frame.func}`) || {};
        const entries = Object.entries(frame.locals || {});
        if (!entries.length) {
          card.append(el("p", "지역 변수 없음", "viz-muted-note"));
        } else {
          const table = el("div", undefined, "viz-vars");
          for (const [k, v] of entries) {
            const prevVal = prevLocals[k];
            const prevTxt = prevVal ? formatValueSummary(prevVal, prevStep?.heap) : null;
            const curTxt = formatValueSummary(v, step.heap);
            const changed = prevTxt !== curTxt;
            const row = el("div", undefined, "viz-var-row" + (changed ? " changed" : ""));
            row.append(el("span", k, "viz-var-name"));
            const valWrap = el("div", undefined, "viz-var-val");
            valWrap.append(renderValuePill(v, step.heap));
            if (changed && prevTxt !== null) {
              valWrap.append(el("span", `← ${prevTxt}`, "viz-var-diff"));
            }
            row.append(valWrap);
            table.append(row);
          }
          card.append(table);
        }
        return card;
      }));
    }

    const heapBox = $("viz-py-heap");
    const heapEntries = Object.values(step.heap || {});
    if (!heapEntries.length) {
      heapBox.replaceChildren(el("p", "현재 참조 중인 리스트·딕셔너리·객체가 없습니다.", "viz-muted-note"));
    } else {
      heapBox.replaceChildren(...heapEntries.map((obj) => {
        const card = el("div", undefined, "viz-heap-card");
        const hhead = el("div", undefined, "viz-heap-head");
        hhead.append(
          el("span", "#" + obj.id.replace("obj_", ""), "viz-ref-badge"),
          el("strong", `${obj.type} (${obj.length})`),
        );
        card.append(hhead);

        if (Array.isArray(obj.items)) {
          const row = el("div", undefined, "viz-array-boxes");
          obj.items.forEach((item, idx) => {
            const cell = el("div", undefined, "viz-array-cell");
            if (obj.type !== "set") cell.append(el("span", String(idx), "viz-array-idx"));
            cell.append(renderValuePill(item, step.heap));
            row.append(cell);
          });
          if (obj.truncated) row.append(el("span", "…", "viz-muted-note"));
          card.append(row);
        } else if (Array.isArray(obj.fields)) {
          const grid = el("div", undefined, "viz-kv-grid");
          for (const [fk, fv] of obj.fields) {
            const row = el("div", undefined, "viz-kv-row");
            row.append(el("span", fk, "viz-kv-key"), renderValuePill(fv, step.heap));
            grid.append(row);
          }
          if (obj.truncated) grid.append(el("span", "…", "viz-muted-note"));
          card.append(grid);
        }
        return card;
      }));
    }

    $("viz-py-stdout").textContent = step.stdout || "(아직 출력 없음)";
  }

  function renderPythonViz(viz, context = {}) {
    stopPyPlay();
    pyViz = viz;
    pyContext = context;
    if (viz?.callEdges?.length) {
      runtimeCallEdges = viz.callEdges;
      applyProjectFlow();
    }
    switchPane("python");

    const hasSteps = Boolean(viz?.steps?.length);
    $("viz-py-empty").hidden = Boolean(viz);
    $("viz-py-content").hidden = !viz;
    if (!viz) return;

    const slider = $("viz-py-slider");
    slider.max = String(Math.max(0, (viz.steps?.length || 1) - 1));
    slider.disabled = !hasSteps;

    if (hasSteps) {
      renderPyStep(0);
    } else {
      $("viz-py-counter").textContent = "0 / 0";
      $("viz-py-explain").replaceChildren(el("p", "실행 단계가 기록되지 않았습니다.", "viz-step-hint"));
      $("viz-py-stack").replaceChildren();
      $("viz-py-heap").replaceChildren();
      $("viz-py-stdout").textContent = "";
    }
  }

  function buildRuntimeTraceCounts() {
    const counts = new Map();
    if (!projectData || !runtimeCallEdges.length) return counts;
    const byFunc = new Map();
    for (const node of projectData.nodes) {
      if (node.kind === "file") continue;
      const filePath = node.path.startsWith("/") ? node.path : "/" + node.path;
      byFunc.set(`${filePath}:${node.qualname}`, node.id);
      byFunc.set(`${filePath}:${node.name}`, node.id);
    }
    for (const edge of runtimeCallEdges) {
      const fromNorm = edge.fromFile.startsWith("/") ? edge.fromFile : "/" + edge.fromFile;
      const toNorm = edge.toFile.startsWith("/") ? edge.toFile : "/" + edge.toFile;
      const fromId = edge.fromFunc === "<module>"
        ? "file:" + fromNorm
        : byFunc.get(`${fromNorm}:${edge.fromFunc}`);
      const toId = byFunc.get(`${toNorm}:${edge.toFunc}`);
      if (fromId && toId) {
        const key = `${fromId}->${toId}`;
        counts.set(key, (counts.get(key) || 0) + edge.count);
      }
    }
    return counts;
  }

  function buildFlowSequence(entryId) {
    if (!projectData || !entryId) return [];
    const outgoing = new Map();
    const weight = { imports: 1, contains: 2, inherits: 3, calls: 4, reads: 5, writes: 6 };
    for (const edge of projectData.edges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge);
    }
    for (const list of outgoing.values()) {
      list.sort((a, b) => (weight[a.kind] || 9) - (weight[b.kind] || 9));
    }

    const visited = new Set([entryId]);
    const steps = [{ nodeId: entryId, edge: null }];
    const queue = [entryId];
    while (queue.length && steps.length < 40) {
      const cur = queue.shift();
      for (const edge of outgoing.get(cur) || []) {
        steps.push({ nodeId: edge.to, edge });
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push(edge.to);
        }
        if (steps.length >= 40) break;
      }
    }
    return steps;
  }

  function applyProjectFlow() {
    if (!projectGraph) return;
    const traceCounts = buildRuntimeTraceCounts();
    if (!flowSteps.length || flowIdx < 0) {
      if (traceCounts.size) {
        const activeEdges = new Set(traceCounts.keys());
        const activeNodes = new Set();
        for (const k of activeEdges) {
          const [a, b] = k.split("->");
          activeNodes.add(a);
          activeNodes.add(b);
        }
        projectGraph.setFlowState({ activeNodes, activeEdges, currentId: null, stepOrder: new Map(), traceCounts });
      } else {
        projectGraph.setFlowState(null);
      }
      return;
    }

    const activeNodes = new Set();
    const activeEdges = new Set();
    const stepOrder = new Map();
    const slice = flowSteps.slice(0, flowIdx + 1);
    slice.forEach((item, i) => {
      activeNodes.add(item.nodeId);
      if (!stepOrder.has(item.nodeId)) stepOrder.set(item.nodeId, i + 1);
      if (item.edge) activeEdges.add(`${item.edge.from}->${item.edge.to}`);
    });
    const current = flowSteps[flowIdx];
    projectGraph.setFlowState({
      activeNodes,
      activeEdges,
      currentId: current.nodeId,
      stepOrder,
      traceCounts,
    });
    const node = projectNodes.get(current.nodeId);
    if (node) {
      const edgeDesc = current.edge ? ` (${current.edge.kind})` : " (시작)";
      $("viz-proj-flow-note").textContent =
        `흐름 ${flowIdx + 1}/${flowSteps.length}: ${node.kind === "file" ? node.path : node.qualname}${edgeDesc}`;
      host?.openAndJump(node.path, node.kind === "file" ? 1 : node.line);
      renderProjectNodeDetail(node);
    }
  }

  function renderProjectNodeDetail(node) {
    const detail = $("viz-proj-detail");
    if (!node) {
      detail.replaceChildren(el("p", "노드를 클릭하거나 위에서 흐름 시작 지점을 선택해 재생해 보세요.", "viz-muted-note"));
      return;
    }
    const out = projectData.edges.filter((e) => e.from === node.id);
    const inc = projectData.edges.filter((e) => e.to === node.id);
    const head = el("div", undefined, "viz-proj-detail-head");
    head.append(
      el("span", node.kind, "viz-decl-kind kind-" + node.kind),
      el("strong", node.kind === "file" ? node.path : node.qualname),
      el("span", `${node.path}${node.line ? ":" + node.line : ""}`, "viz-decl-line"),
    );
    const openBtn = el("button", "편집기에서 보기", "quiet");
    openBtn.type = "button";
    openBtn.onclick = () => host?.openAndJump(node.path, node.kind === "file" ? 1 : node.line);
    const flowBtn = el("button", "여기서 흐름 시작", "quiet");
    flowBtn.type = "button";
    flowBtn.onclick = () => {
      $("viz-proj-entry").value = node.id;
      flowSteps = buildFlowSequence(node.id);
      flowIdx = 0;
      applyProjectFlow();
    };
    const actions = el("div", undefined, "viz-proj-detail-actions");
    actions.append(openBtn, flowBtn);

    const relSummary = el("p", `나가는 관계 ${out.length}개 · 들어오는 관계 ${inc.length}개`, "viz-muted-note");
    detail.replaceChildren(head, actions, relSummary);
  }

  async function analyzeProject(pathOverride = null) {
    if (!host) return;
    stopFlowPlay();
    const input = $("viz-proj-path");
    let path = (pathOverride ?? input.value ?? "/").trim() || "/";
    if (path.startsWith("/workspace")) path = path.slice("/workspace".length) || "/";
    if (!path.startsWith("/")) path = "/" + path;
    if (path.length > 1) path = path.replace(/\/+$/, "");
    input.value = path;
    $("viz-proj-status").textContent = "분석 중…";
    try {
      const data = await host.api("code-graph?" + new URLSearchParams({ path }));
      projectData = data;
      projectNodes = new Map(data.nodes.map((n) => [n.id, n]));
      flowSteps = [];
      flowIdx = -1;

      const entrySelect = $("viz-proj-entry");
      const candidates = data.nodes.filter((n) => n.kind === "file" || n.kind === "function");
      entrySelect.replaceChildren(
        (() => {
          const opt = el("option", "흐름 시작 노드 선택…");
          opt.value = "";
          return opt;
        })(),
        ...candidates.slice(0, 80).map((n) => {
          const opt = el("option", n.kind === "file" ? `📄 ${n.path}` : `ƒ ${n.qualname} (${n.path})`);
          opt.value = n.id;
          return opt;
        }),
      );
      const preferred = candidates.find((n) => n.name === "main" || n.name === "simulate.py") || candidates[0];
      if (preferred) {
        entrySelect.value = preferred.id;
        flowSteps = buildFlowSequence(preferred.id);
      }

      $("viz-proj-status").textContent =
        `파일 ${data.fileCount} · 노드 ${data.nodes.length} · 간선 ${data.edges.length}`;
      projectGraph.render({ nodes: data.nodes, edges: data.edges }, selectedProjNode);
      applyProjectFlow();
      renderProjectNodeDetail(selectedProjNode ? projectNodes.get(selectedProjNode) : null);
    } catch (err) {
      $("viz-proj-status").textContent = err.message;
    }
  }

  async function launchExample(example) {
    if (!host) return;
    $("examples-dialog")?.close();
    setStudioVisible(true);
    let ready = false;
    await host.runTask(async () => {
      await host.ensureDir("/examples");
      if (example.projectPath) await host.ensureDir(example.projectPath);
      for (const [path, content] of Object.entries(example.files)) {
        await host.writeOrUpdateFile(path, content);
      }
      await host.refreshExplorer();
      await host.openFile(example.entryPath);
      ready = true;
    });
    if (!ready) return;
    if (example.runMode === "notebook-first-code") {
      await host.runFirstCodeCell(example.entryPath);
    } else {
      await host.runPlainFile(example.entryPath);
      if (example.runMode === "plain-and-project") {
        $("viz-proj-path").value = example.projectPath;
        await analyzeProject(example.projectPath);
      }
    }
  }

  function renderExamplesGallery() {
    const makeCards = (target) => {
      if (!target) return;
      target.replaceChildren(...EXAMPLES.map((ex) => {
        const card = el("article", undefined, "example-card");
        card.append(
          el("span", ex.badge, "example-badge"),
          el("h3", ex.title),
          el("p", ex.description),
          (() => {
            const btn = el("button", "열고 시각화 실행 →", "primary");
            btn.type = "button";
            btn.onclick = () => launchExample(ex);
            return btn;
          })(),
        );
        return card;
      }));
    };
    makeCards($("examples-list"));
    makeCards($("welcome-examples-grid"));
  }

  function initResizer() {
    const resizer = $("split-resizer");
    const split = $("workbench-split");
    const studio = $("viz-studio");
    if (!resizer || !split || !studio) return;

    const STORAGE_KEY = "qnb:panel:vizWidth";
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (saved >= 240) studio.style.flexBasis = `${saved}px`;
    } catch { /* ignore storage errors */ }

    let dragging = false;
    let latestWidth = null;
    resizer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-split");
    });
    resizer.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const rect = split.getBoundingClientRect();
      latestWidth = Math.round(Math.max(240, Math.min(rect.width - 240, rect.right - event.clientX)));
      studio.style.flexBasis = `${latestWidth}px`;
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("resizing-split");
      if (latestWidth) {
        try { localStorage.setItem(STORAGE_KEY, String(latestWidth)); } catch { /* ignore */ }
      }
      if (activePane === "project") projectGraph?.fit();
    };
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
    resizer.addEventListener("dblclick", () => {
      studio.style.flexBasis = "";
      latestWidth = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      if (activePane === "project") projectGraph?.fit();
    });
  }

  function init(callbacks) {
    host = callbacks;
    renderExamplesGallery();
    initResizer();

    projectGraph = new QNBGraph.CodeGraph($("viz-project-canvas"), (id) => {
      selectedProjNode = id;
      const node = projectNodes.get(id);
      projectGraph.render({ nodes: projectData.nodes, edges: projectData.edges }, id);
      if (node) {
        renderProjectNodeDetail(node);
        host?.openAndJump(node.path, node.kind === "file" ? 1 : node.line);
      }
    });

    $("viz-tab-lean").onclick = () => switchPane("lean");
    $("viz-tab-python").onclick = () => switchPane("python");
    $("viz-tab-project").onclick = () => switchPane("project");
    $("viz-close").onclick = () => setStudioVisible(false);
    $("viz-toggle").onclick = () => setStudioVisible(!studioOpen);

    const openExamples = () => {
      const dlg = $("examples-dialog");
      if (dlg && !dlg.open) dlg.showModal();
    };
    $("examples-open").onclick = openExamples;
    $("viz-examples-shortcut").onclick = openExamples;
    $("examples-dialog-close").onclick = () => $("examples-dialog").close();
    document.querySelectorAll(".viz-open-examples").forEach((btn) => {
      btn.onclick = openExamples;
    });

    $("viz-lean-first").onclick = () => { stopLeanPlay(); renderLeanStep(0); };
    $("viz-lean-prev").onclick = () => { stopLeanPlay(); renderLeanStep(leanStepIdx - 1); };
    $("viz-lean-next").onclick = () => { stopLeanPlay(); renderLeanStep(leanStepIdx + 1); };
    $("viz-lean-last").onclick = () => { stopLeanPlay(); renderLeanStep((leanViz?.steps?.length || 1) - 1); };
    $("viz-lean-slider").oninput = (e) => { stopLeanPlay(); renderLeanStep(Number(e.target.value)); };
    $("viz-lean-play").onclick = () => {
      if (leanTimer) return stopLeanPlay();
      if (!leanViz?.steps?.length) return;
      if (leanStepIdx >= leanViz.steps.length - 1) renderLeanStep(0);
      $("viz-lean-play").textContent = "⏸ 일시정지";
      leanTimer = setInterval(() => {
        if (leanStepIdx >= leanViz.steps.length - 1) return stopLeanPlay();
        renderLeanStep(leanStepIdx + 1);
      }, 950);
    };

    $("viz-py-first").onclick = () => { stopPyPlay(); renderPyStep(0); };
    $("viz-py-prev").onclick = () => { stopPyPlay(); renderPyStep(pyStepIdx - 1); };
    $("viz-py-next").onclick = () => { stopPyPlay(); renderPyStep(pyStepIdx + 1); };
    $("viz-py-last").onclick = () => { stopPyPlay(); renderPyStep((pyViz?.steps?.length || 1) - 1); };
    $("viz-py-slider").oninput = (e) => { stopPyPlay(); renderPyStep(Number(e.target.value)); };
    $("viz-py-play").onclick = () => {
      if (pyTimer) return stopPyPlay();
      if (!pyViz?.steps?.length) return;
      if (pyStepIdx >= pyViz.steps.length - 1) renderPyStep(0);
      const speed = Number($("viz-py-speed").value) || 520;
      $("viz-py-play").textContent = "⏸ 일시정지";
      pyTimer = setInterval(() => {
        if (pyStepIdx >= pyViz.steps.length - 1) return stopPyPlay();
        renderPyStep(pyStepIdx + 1);
      }, speed);
    };

    $("viz-proj-analyze").onclick = () => analyzeProject();
    $("viz-proj-path").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        analyzeProject();
      }
    });
    $("viz-proj-entry").onchange = (e) => {
      stopFlowPlay();
      flowSteps = buildFlowSequence(e.target.value);
      flowIdx = flowSteps.length ? 0 : -1;
      applyProjectFlow();
    };
    $("viz-proj-prev").onclick = () => {
      stopFlowPlay();
      if (!flowSteps.length) return;
      flowIdx = Math.max(0, flowIdx - 1);
      applyProjectFlow();
    };
    $("viz-proj-next").onclick = () => {
      stopFlowPlay();
      if (!flowSteps.length) return;
      flowIdx = Math.min(flowSteps.length - 1, flowIdx + 1);
      applyProjectFlow();
    };
    $("viz-proj-reset").onclick = () => {
      stopFlowPlay();
      flowIdx = -1;
      $("viz-proj-flow-note").textContent = "노드를 클릭하면 왼쪽 편집기에서 해당 코드 위치로 바로 이동합니다.";
      applyProjectFlow();
    };
    $("viz-proj-play").onclick = () => {
      if (flowTimer) return stopFlowPlay();
      const entryId = $("viz-proj-entry").value;
      if (!flowSteps.length && entryId) flowSteps = buildFlowSequence(entryId);
      if (!flowSteps.length) return;
      if (flowIdx < 0 || flowIdx >= flowSteps.length - 1) flowIdx = 0;
      applyProjectFlow();
      $("viz-proj-play").textContent = "⏸ 일시정지";
      flowTimer = setInterval(() => {
        if (flowIdx >= flowSteps.length - 1) return stopFlowPlay();
        flowIdx += 1;
        applyProjectFlow();
      }, 900);
    };
    $("viz-proj-zoom-in").onclick = () => projectGraph?.zoom(1.25);
    $("viz-proj-zoom-out").onclick = () => projectGraph?.zoom(0.8);
    $("viz-proj-fit").onclick = () => projectGraph?.fit();
  }

  function showExecutionResult(viz, context = {}) {
    if (!viz) return;
    if (viz.kind === "lean4") renderLeanViz(viz, context);
    else if (viz.kind === "python" || viz.kind === "cpp" || viz.kind === "java") renderPythonViz(viz, context);
  }

  function syncLeanCursor(path, cell, line) {
    if (!leanViz || leanTimer) return;
    if (leanContext.path !== path || leanContext.cell !== cell) return;
    const idx = leanViz.steps.findIndex((s) => s.line === line);
    if (idx >= 0 && idx !== leanStepIdx) {
      renderLeanStep(idx);
    }
  }

  return {
    init,
    showExecutionResult,
    syncLeanCursor,
    switchPane,
    setStudioVisible,
    analyzeProject,
  };
})();
