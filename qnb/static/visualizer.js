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

  let catViz = null;
  let catStepIdx = 0;
  let catTimer = null;
  let catContext = { path: null, cell: null };
  let catMode = "quiver";
  let catZoom = 1;
  let catPanX = 0;
  let catPanY = 0;

  let projectGraph = null;
  let projectData = null;
  let projectNodes = new Map();
  let selectedProjNode = null;
  let flowSteps = [];
  let flowIdx = -1;
  let flowTimer = null;
  let runtimeCallEdges = [];

  let activeExampleFilter = "all";
  let lastCodeCursorKey = null;

  const EXAMPLES = [
    {
      id: "lean-induction",
      langGroup: "lean4",
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
      id: "category-naturality",
      langGroup: "category",
      badge: "Category · .cat 도식 증명",
      title: "자연변환(Naturality)과 함자 보존 법칙",
      description: "두 함자 F, G 사이의 자연변환 α가 만드는 가환 사각형과 함자 보존 법칙을 Quiver/String 다이어그램으로 보며 증명합니다.",
      entryPath: "/examples/naturality_square.cat",
      runMode: "plain",
      files: {
        "/examples/naturality_square.cat": [
          "category C, D",
          "object A, B, X : C",
          "morphism f : A -> B",
          "morphism g : B -> X",
          "functor F : C -> D",
          "functor G : C -> D",
          "nat alpha : F => G",
          "",
          "theorem naturality_comp : G(g ∘ f) ∘ alpha(A) = alpha(X) ∘ F(g) ∘ F(f) by",
          "  functor_comp",
          "  naturality alpha",
          "  assoc",
          "  naturality alpha",
          "  rfl",
          "",
        ].join("\n"),
      },
    },
    {
      id: "category-adjunction-product",
      langGroup: "category",
      badge: "Category · 노트북 (수반함자 & 곱)",
      title: "수반 함자(F ⊣ G) 삼각 항등식 & 곱 보편성",
      description: "단위 η와 쌍대단위 ε의 zig-zag 삼각 항등식, 그리고 곱 대상 A × B의 β/η 보편성을 병렬 노트북 셀에서 확인합니다.",
      entryPath: "/examples/category_adjunction_tour.ipynb",
      runMode: "notebook-first-code",
      files: {
        "/examples/category_adjunction_tour.ipynb": JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: { kernelspec: { name: "category", display_name: "Category Theory", language: "category" } },
          cells: [
            {
              id: "ex-cat-md-1",
              cell_type: "markdown",
              metadata: {},
              source: "# 범주론 증명 스튜디오\n\n`⇉ 병렬 전체 실행`을 누르면 아래 **수반 함자 셀**, **곱 보편성 셀**, **Lean 4 셀**을 동시에 검증할 수 있습니다.",
            },
            {
              id: "ex-cat-code-1",
              cell_type: "code",
              metadata: { qnb_language: "category" },
              execution_count: null,
              outputs: [],
              source: [
                "category C, D\n",
                "object A : C\n",
                "object B : D\n",
                "adjunction F -| G : C <-> D\n",
                "\n",
                "theorem triangle_zig_zag : eps(F(A)) ∘ F(eta(A)) ∘ id(F(A)) = id(F(A)) by\n",
                "  id_right\n",
                "  zig\n",
                "  rfl",
              ].join(""),
            },
            {
              id: "ex-cat-code-2",
              cell_type: "code",
              metadata: { qnb_language: "category" },
              execution_count: null,
              outputs: [],
              source: [
                "category C\n",
                "object X, A, B : C\n",
                "product P of A, B\n",
                "morphism u : X -> A\n",
                "morphism v : X -> B\n",
                "morphism h : X -> P\n",
                "\n",
                "theorem prod_beta_pair : fst ∘ <u, v> = u by\n",
                "  product_beta\n",
                "  rfl\n",
                "\n",
                "theorem prod_eta_uniq : <fst ∘ h, snd ∘ h> = h by\n",
                "  product_eta\n",
                "  rfl",
              ].join(""),
            },
          ],
        }, null, 1) + "\n",
      },
    },
    {
      id: "lean-logic",
      langGroup: "lean4",
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
      langGroup: "python",
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
      langGroup: "python",
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
    {
      id: "cpp-pointers-list",
      langGroup: "cpp",
      badge: "C++17 · 포인터 & 힙 연결 리스트",
      title: "포인터 연결과 단일 연결 리스트 뒤집기",
      description: "new로 생성한 Node 힙 객체와 포인터 변수(head, prev, curr)의 주소가 한 줄씩 어떻게 이어지고 뒤집히는지 GDB 추적으로 봅니다.",
      entryPath: "/examples/cpp_pointers_list/main.cpp",
      runMode: "plain",
      projectPath: "/examples/cpp_pointers_list",
      files: {
        "/examples/cpp_pointers_list/main.cpp": [
          "#include <iostream>",
          "",
          "struct Node {",
          "    int val;",
          "    Node* next;",
          "    Node(int v, Node* n) : val(v), next(n) {}",
          "};",
          "",
          "Node* pushFront(Node* head, int v) {",
          "    return new Node(v, head);",
          "}",
          "",
          "Node* reverseList(Node* head) {",
          "    Node* prev = nullptr;",
          "    Node* curr = head;",
          "    while (curr != nullptr) {",
          "        Node* next = curr->next;",
          "        curr->next = prev;",
          "        prev = curr;",
          "        curr = next;",
          "    }",
          "    return prev;",
          "}",
          "",
          "int main() {",
          "    Node* head = nullptr;",
          "    for (int v : {10, 20, 30}) {",
          "        head = pushFront(head, v);",
          "    }",
          "    head = reverseList(head);",
          "    int sum = 0;",
          "    for (Node* p = head; p != nullptr; p = p->next) {",
          "        sum += p->val;",
          "        std::cout << p->val << \" \";",
          "    }",
          "    std::cout << \"(sum=\" << sum << \")\" << std::endl;",
          "    return 0;",
          "}",
          "",
        ].join("\n"),
      },
    },
    {
      id: "cpp-stl-project",
      langGroup: "cpp",
      badge: "C++17 · 멀티파일 프로젝트 & STL",
      title: "가중치 그래프 최단 거리 탐색 (헤더/소스 분리)",
      description: "graph.hpp, graph.cpp, main.cpp 세 파일이 서로 호출되며 std::vector와 std::map 상태가 바뀌는 과정을 단계 실행과 호출 그래프로 동시에 봅니다.",
      entryPath: "/examples/cpp_stl_project/main.cpp",
      runMode: "plain-and-project",
      projectPath: "/examples/cpp_stl_project",
      files: {
        "/examples/cpp_stl_project/graph.hpp": [
          "#pragma once",
          "#include <map>",
          "#include <string>",
          "#include <vector>",
          "",
          "struct Edge { int to; int weight; };",
          "",
          "struct WeightedGraph {",
          "    std::vector<std::vector<Edge>> adj;",
          "    explicit WeightedGraph(int n);",
          "    void addEdge(int u, int v, int w);",
          "};",
          "",
          "std::map<std::string, int> shortestDistances(const WeightedGraph& g, int start);",
          "",
        ].join("\n"),
        "/examples/cpp_stl_project/graph.cpp": [
          "#include \"graph.hpp\"",
          "#include <utility>",
          "",
          "WeightedGraph::WeightedGraph(int n) : adj(n) {}",
          "",
          "void WeightedGraph::addEdge(int u, int v, int w) {",
          "    adj[u].push_back(Edge{v, w});",
          "}",
          "",
          "std::map<std::string, int> shortestDistances(const WeightedGraph& g, int start) {",
          "    const int INF = 1000000;",
          "    std::vector<int> dist(g.adj.size(), INF);",
          "    std::vector<bool> used(g.adj.size(), false);",
          "    dist[start] = 0;",
          "    for (size_t step = 0; step < g.adj.size(); ++step) {",
          "        int u = -1;",
          "        for (size_t i = 0; i < g.adj.size(); ++i) {",
          "            if (!used[i] && (u == -1 || dist[i] < dist[u])) u = static_cast<int>(i);",
          "        }",
          "        if (u == -1 || dist[u] == INF) break;",
          "        used[u] = true;",
          "        for (const auto& e : g.adj[u]) {",
          "            if (dist[u] + e.weight < dist[e.to]) {",
          "                dist[e.to] = dist[u] + e.weight;",
          "            }",
          "        }",
          "    }",
          "    std::map<std::string, int> summary;",
          "    for (size_t i = 0; i < dist.size(); ++i) summary[\"node_\" + std::to_string(i)] = dist[i];",
          "    return summary;",
          "}",
          "",
        ].join("\n"),
        "/examples/cpp_stl_project/main.cpp": [
          "#include \"graph.hpp\"",
          "#include <iostream>",
          "",
          "int main() {",
          "    WeightedGraph g(4);",
          "    g.addEdge(0, 1, 2);",
          "    g.addEdge(0, 2, 5);",
          "    g.addEdge(1, 2, 1);",
          "    g.addEdge(1, 3, 6);",
          "    g.addEdge(2, 3, 2);",
          "    auto res = shortestDistances(g, 0);",
          "    std::cout << \"dist(0->3)=\" << res[\"node_3\"] << std::endl;",
          "    return 0;",
          "}",
          "",
        ].join("\n"),
      },
    },
    {
      id: "java-recursion-bst",
      langGroup: "java",
      badge: "Java 17 · 재귀 & 이진 탐색 트리",
      title: "BST 삽입과 재귀 구간 합 (반환값 추적)",
      description: "TreeNode 객체 참조가 트리로 연결되고 재귀 호출(rangeSum)이 깊어졌다가 반환값(returnValue)을 되돌려 합산하는 과정을 JDI로 봅니다.",
      entryPath: "/examples/java_recursion_bst/Main.java",
      runMode: "plain",
      projectPath: "/examples/java_recursion_bst",
      files: {
        "/examples/java_recursion_bst/Main.java": [
          "public class Main {",
          "    static class TreeNode {",
          "        int key;",
          "        TreeNode left, right;",
          "        TreeNode(int k) { key = k; }",
          "    }",
          "",
          "    static TreeNode insert(TreeNode root, int key) {",
          "        if (root == null) return new TreeNode(key);",
          "        if (key < root.key) root.left = insert(root.left, key);",
          "        else root.right = insert(root.right, key);",
          "        return root;",
          "    }",
          "",
          "    static int rangeSum(TreeNode node, int low, int high) {",
          "        if (node == null) return 0;",
          "        int sum = (node.key >= low && node.key <= high) ? node.key : 0;",
          "        if (node.key > low) sum += rangeSum(node.left, low, high);",
          "        if (node.key < high) sum += rangeSum(node.right, low, high);",
          "        return sum;",
          "    }",
          "",
          "    public static void main(String[] args) {",
          "        TreeNode root = null;",
          "        for (int k : new int[]{10, 5, 15, 3, 7}) {",
          "            root = insert(root, k);",
          "        }",
          "        int total = rangeSum(root, 5, 12);",
          "        System.out.println(\"rangeSum(5..12)=\" + total);",
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    },
    {
      id: "java-oop-project",
      langGroup: "java",
      badge: "Java 17 · 멀티파일 OOP & 컬렉션",
      title: "작업 스케줄러 객체 협력 (3개 클래스)",
      description: "Task, Scheduler, Main 클래스가 메서드를 호출하며 this 필드, ArrayList, HashMap 상태가 어떻게 변화하는지 JDI 추적으로 봅니다.",
      entryPath: "/examples/java_oop_project/Main.java",
      runMode: "plain-and-project",
      projectPath: "/examples/java_oop_project",
      files: {
        "/examples/java_oop_project/Task.java": [
          "public class Task {",
          "    String title;",
          "    int minutes;",
          "    boolean done;",
          "",
          "    public Task(String title, int minutes) {",
          "        this.title = title;",
          "        this.minutes = minutes;",
          "        this.done = false;",
          "    }",
          "",
          "    public int complete() {",
          "        this.done = true;",
          "        return this.minutes;",
          "    }",
          "}",
          "",
        ].join("\n"),
        "/examples/java_oop_project/Scheduler.java": [
          "import java.util.*;",
          "",
          "public class Scheduler {",
          "    List<Task> queue = new ArrayList<>();",
          "    Map<String, Integer> stats = new LinkedHashMap<>();",
          "",
          "    public void addTask(String name, int minutes) {",
          "        Task t = new Task(name, minutes);",
          "        queue.add(t);",
          "    }",
          "",
          "    public int runNext() {",
          "        if (queue.isEmpty()) return 0;",
          "        Task t = queue.remove(0);",
          "        int mins = t.complete();",
          "        stats.put(t.title, mins);",
          "        return mins;",
          "    }",
          "}",
          "",
        ].join("\n"),
        "/examples/java_oop_project/Main.java": [
          "public class Main {",
          "    public static void main(String[] args) {",
          "        Scheduler scheduler = new Scheduler();",
          "        scheduler.addTask(\"parse\", 4);",
          "        scheduler.addTask(\"compile\", 8);",
          "        int total = 0;",
          "        total += scheduler.runNext();",
          "        total += scheduler.runNext();",
          "        System.out.println(\"elapsed=\" + total);",
          "    }",
          "}",
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
    for (const key of ["lean", "python", "category", "project"]) {
      $("viz-tab-" + key)?.classList.toggle("active", key === pane);
      $("viz-tab-" + key)?.setAttribute("aria-selected", String(key === pane));
      const box = $("viz-pane-" + key);
      if (box) box.hidden = key !== pane;
    }
    if (pane === "category" && catViz) {
      setTimeout(() => drawCategoryCanvas(), 20);
    }
    if (pane === "project") {
      if (!projectData) analyzeProject();
      else setTimeout(() => projectGraph?.fit(), 20);
    }
  }

  function stopCatPlay() {
    if (catTimer) {
      clearInterval(catTimer);
      catTimer = null;
    }
    const btn = $("viz-cat-play");
    if (btn) btn.textContent = "▶ 자동재생";
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

  function renderPropCalcCard(box, comp) {
    if (!box) return;
    if (!comp) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    const head = el("div", undefined, "viz-calc-head");
    head.append(
      el("span", "🧮 명제 계산 · 변환", "viz-calc-title"),
      el("span", comp.operation || "변환", "viz-calc-op"),
    );

    const diffWrap = el("div", undefined, "viz-calc-diff");
    const makeRow = (tag, cls, prefix, highlight, suffix, fallback) => {
      const row = el("div", undefined, "viz-calc-row " + cls);
      row.append(el("span", tag, "viz-calc-row-tag"));
      const expr = el("code", undefined, "viz-calc-expr");
      if (highlight) {
        if (prefix) expr.append(document.createTextNode(prefix));
        const mark = el(cls === "is-before" ? "del" : "ins", highlight, cls === "is-before" ? "viz-calc-redex" : "viz-calc-contract");
        expr.append(mark);
        if (suffix) expr.append(document.createTextNode(suffix));
      } else {
        expr.textContent = fallback || "—";
      }
      row.append(expr);
      return row;
    };
    if (comp.before || comp.after) {
      diffWrap.append(
        makeRow("전", "is-before", comp.prefix, comp.redex, comp.suffix, comp.before),
        makeRow("후", "is-after", comp.prefix, comp.contractum, comp.suffix, comp.after),
      );
    }

    const children = [head];
    if (comp.before || comp.after) children.push(diffWrap);

    if (Array.isArray(comp.rules) && comp.rules.length) {
      const rulesBox = el("div", undefined, "viz-calc-rules");
      for (const r of comp.rules) {
        const chip = el("div", undefined, "viz-calc-rule");
        chip.append(el("span", r.name, "viz-calc-rule-name"));
        if (r.signature) chip.append(el("code", r.signature, "viz-calc-rule-sig"));
        rulesBox.append(chip);
      }
      children.push(rulesBox);
    }
    if (comp.summary) {
      children.push(el("p", comp.summary, "viz-calc-summary"));
    }
    box.replaceChildren(...children);
  }

  function renderLeanStep(idx, options = {}) {
    if (!leanViz || !leanViz.steps?.length) return;
    const { scroll = true } = options;
    leanStepIdx = Math.max(0, Math.min(leanViz.steps.length - 1, idx));
    const step = leanViz.steps[leanStepIdx];
    $("viz-lean-slider").value = String(leanStepIdx);
    $("viz-lean-counter").textContent = `${leanStepIdx + 1} / ${leanViz.steps.length}`;
    $("viz-lean-first").disabled = leanStepIdx === 0;
    $("viz-lean-prev").disabled = leanStepIdx === 0;
    $("viz-lean-next").disabled = leanStepIdx === leanViz.steps.length - 1;
    $("viz-lean-last").disabled = leanStepIdx === leanViz.steps.length - 1;

    const kind = step.status === "solved" ? "solved" : leanViz.ok ? "lean" : "error";
    host?.highlightLine(leanContext.path, leanContext.cell, step.line, kind, scroll);

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

    renderPropCalcCard($("viz-lean-calc"), step.computation);

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
      const prefix = val.ptr ? "ptr → " : "";
      const badge = el("button", `${prefix}${obj ? obj.type : "obj"} #${val.id.replace("obj_", "")}`, "viz-ref-badge" + (val.ptr ? " is-ptr" : ""));
      badge.type = "button";
      badge.title = "클릭하여 힙 객체 카드 강조";
      badge.onclick = () => focusHeapObject(val.id);
      return badge;
    }
    if (val.kind === "prim") {
      const txt = val.type === "str" ? JSON.stringify(val.value) : String(val.value);
      return el("code", txt, "viz-val-prim type-" + val.type);
    }
    return el("code", val.text || "", "viz-val-prim");
  }

  function focusHeapObject(objId) {
    const card = $("viz-py-heap")?.querySelector(`[data-obj-id="${objId}"]`);
    if (!card) return;
    card.classList.remove("flash-target");
    void card.offsetWidth;
    card.classList.add("flash-target");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderCodePipeline(viz) {
    const langBar = $("viz-py-lang-bar");
    const pipeBox = $("viz-py-pipeline");
    const kind = viz?.kind || "python";
    const meta = {
      cpp: { badge: "C++17 · GDB 한 줄 추적", info: "g++ -g -O0" },
      java: { badge: "Java 17 · JDI 한 줄 추적", info: "javac -g" },
      python: { badge: "Python 3.12 · sys.settrace", info: "실시간 추적" },
    }[kind] || { badge: kind, info: "" };
    if (langBar) {
      langBar.replaceChildren(
        el("span", meta.badge, "viz-lang-badge lang-" + kind),
        el("span", `${viz.primaryFile || ""} · ${viz.totalSteps ?? (viz.steps?.length || 0)}단계`, "viz-lang-meta"),
      );
    }
    if (pipeBox) {
      const stages = Array.isArray(viz?.pipeline) ? viz.pipeline : [];
      pipeBox.replaceChildren(...stages.map((stage) => {
        const card = el("div", undefined, "viz-pipe-stage status-" + stage.status);
        const icon = stage.status === "ok" ? "✓" : stage.status === "error" ? "✕" : "·";
        card.append(
          el("span", icon + " " + stage.label, "viz-pipe-title"),
          el("small", stage.detail || "", "viz-pipe-detail"),
        );
        return card;
      }));
    }
    const errBox = $("viz-py-compile-errors");
    if (errBox) {
      const errs = Array.isArray(viz?.compileErrors) ? viz.compileErrors : [];
      errBox.hidden = errs.length === 0;
      errBox.replaceChildren(...errs.map((err) => {
        const btn = el("button", undefined, "viz-compile-err-btn");
        btn.type = "button";
        const loc = `${err.file}:${err.line}${err.column ? ":" + err.column : ""}`;
        btn.append(el("strong", loc), el("span", err.message));
        btn.onclick = () => host?.openAndJump(err.file, err.line);
        return btn;
      }));
    }
  }

  function renderLineVisits(step) {
    const bar = $("viz-py-line-bar");
    if (!bar) return;
    if (!pyViz?.steps?.length || !step?.line) {
      bar.hidden = true;
      return;
    }
    const norm = (p) => (p || "").startsWith("/") ? p : "/" + (p || "");
    const targetFile = norm(step.file || pyContext.path || pyViz.primaryFile);
    const visits = [];
    pyViz.steps.forEach((s, i) => {
      if (s.line === step.line && norm(s.file || pyViz.primaryFile) === targetFile) visits.push(i);
    });
    if (visits.length <= 1) {
      bar.hidden = true;
      return;
    }
    const pos = visits.indexOf(step.index);
    bar.hidden = false;
    const prevBtn = el("button", "◀ 이전 회차", "quiet");
    prevBtn.type = "button";
    prevBtn.disabled = pos <= 0;
    prevBtn.onclick = () => { stopPyPlay(); if (pos > 0) renderPyStep(visits[pos - 1]); };
    const nextBtn = el("button", "다음 회차 ▶", "quiet");
    nextBtn.type = "button";
    nextBtn.disabled = pos < 0 || pos >= visits.length - 1;
    nextBtn.onclick = () => { stopPyPlay(); if (pos >= 0 && pos < visits.length - 1) renderPyStep(visits[pos + 1]); };
    bar.replaceChildren(
      el("span", `${step.line}행 실행 회차 (${pos + 1} / ${visits.length}회)`, "viz-line-visits-label"),
      prevBtn,
      nextBtn,
    );
  }

  function renderPyStep(idx, options = {}) {
    if (!pyViz || !pyViz.steps?.length) return;
    const { scroll = true } = options;
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
    host?.highlightLine(step.file || pyContext.path, pyContext.cell, step.line, kind, scroll);
    renderLineVisits(step);

    const explainBox = $("viz-py-explain");
    const top = el("div", undefined, "viz-explain-top");
    top.append(
      el("span", `${step.file} : ${step.line}행 · ${step.func}`, "viz-step-pill"),
      el("span", step.event.toUpperCase(), "viz-step-state event-" + step.event),
    );
    if (step.returnValue !== null && step.returnValue !== undefined && step.returnValue !== "") {
      top.append(el("span", `반환값: ${step.returnValue}`, "viz-return-pill"));
    }
    const explainChildren = [top];
    if (step.code) explainChildren.push(el("pre", step.code, "viz-step-code"));
    explainChildren.push(el("p", step.explain, "viz-step-hint" + (step.error ? " error" : "")));
    if (Array.isArray(step.changes) && step.changes.length) {
      const chips = el("div", undefined, "viz-delta-chips");
      for (const ch of step.changes) {
        chips.append(el("span", ch.label, "viz-delta-chip kind-" + (ch.kind || "update")));
      }
      explainChildren.push(chips);
    }
    if (pyViz.truncatedSteps && pyStepIdx === pyViz.steps.length - 1) {
      explainChildren.push(el("small", `※ ${pyViz.maxSteps || 300}단계를 초과해 이후 추적은 생략되었습니다.`, "viz-muted-note"));
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
      heapBox.replaceChildren(el("p", "현재 참조 중인 컨테이너·배열·객체가 없습니다.", "viz-muted-note"));
    } else {
      heapBox.replaceChildren(...heapEntries.map((obj) => {
        const card = el("div", undefined, "viz-heap-card");
        card.dataset.objId = obj.id;
        const hhead = el("div", undefined, "viz-heap-head");
        hhead.append(
          el("span", "#" + obj.id.replace("obj_", ""), "viz-ref-badge"),
          el("strong", `${obj.type} (${obj.length})`),
        );
        if (obj.addr) hhead.append(el("span", obj.addr, "viz-heap-addr"));
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
    lastCodeCursorKey = null;
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

    renderCodePipeline(viz);
    const slider = $("viz-py-slider");
    slider.max = String(Math.max(0, (viz.steps?.length || 1) - 1));
    slider.disabled = !hasSteps;

    if (hasSteps) {
      renderPyStep(0);
    } else {
      $("viz-py-counter").textContent = "0 / 0";
      $("viz-py-line-bar").hidden = true;
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
    const byGlobal = new Map();
    for (const node of projectData.nodes) {
      if (node.kind === "file") continue;
      const filePath = node.path.startsWith("/") ? node.path : "/" + node.path;
      const qn = node.qualname || node.name;
      const dotted = qn.replace(/::/g, ".");
      byFunc.set(`${filePath}:${qn}`, node.id);
      byFunc.set(`${filePath}:${node.name}`, node.id);
      byFunc.set(`${filePath}:${dotted}`, node.id);
      byGlobal.set(qn, node.id);
      byGlobal.set(dotted, node.id);
    }
    const resolveNode = (filePath, funcName) => {
      if (!funcName) return null;
      if (funcName === "<module>") return "file:" + filePath;
      const clean = funcName.replace(/\.<init>$/, "");
      const dotted = funcName.replace(/::/g, ".");
      return byFunc.get(`${filePath}:${funcName}`)
        || byFunc.get(`${filePath}:${dotted}`)
        || byFunc.get(`${filePath}:${clean}`)
        || byGlobal.get(funcName)
        || byGlobal.get(dotted)
        || null;
    };
    for (const edge of runtimeCallEdges) {
      const fromNorm = edge.fromFile.startsWith("/") ? edge.fromFile : "/" + edge.fromFile;
      const toNorm = edge.toFile.startsWith("/") ? edge.toFile : "/" + edge.toFile;
      const fromId = resolveNode(fromNorm, edge.fromFunc);
      const toId = resolveNode(toNorm, edge.toFunc);
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
      const preferred = candidates.find((n) => ["main", "main.cpp", "Main.java", "Main.main", "simulate.py"].includes(n.name)) || candidates[0];
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
    const filters = [
      ["all", "전체"],
      ["lean4", "Lean 4"],
      ["category", "범주론"],
      ["python", "Python"],
      ["cpp", "C++"],
      ["java", "Java"],
    ];
    const renderFilters = (bar) => {
      if (!bar) return;
      bar.replaceChildren(...filters.map(([key, label]) => {
        const btn = el("button", label, "examples-filter-btn" + (activeExampleFilter === key ? " active" : ""));
        btn.type = "button";
        btn.onclick = () => {
          activeExampleFilter = key;
          renderExamplesGallery();
        };
        return btn;
      }));
    };
    const visibleExamples = activeExampleFilter === "all"
      ? EXAMPLES
      : EXAMPLES.filter((ex) => ex.langGroup === activeExampleFilter);
    const makeCards = (target) => {
      if (!target) return;
      target.replaceChildren(...visibleExamples.map((ex) => {
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
    renderFilters($("examples-filter-bar"));
    renderFilters($("welcome-examples-filter"));
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
    $("viz-tab-category").onclick = () => switchPane("category");
    $("viz-tab-project").onclick = () => switchPane("project");
    $("viz-close").onclick = () => setStudioVisible(false);
    $("viz-toggle").onclick = () => setStudioVisible(!studioOpen);

    $("viz-cat-first").onclick = () => { stopCatPlay(); renderCatStep(0); };
    $("viz-cat-prev").onclick = () => { stopCatPlay(); renderCatStep(catStepIdx - 1); };
    $("viz-cat-next").onclick = () => { stopCatPlay(); renderCatStep(catStepIdx + 1); };
    $("viz-cat-last").onclick = () => { stopCatPlay(); renderCatStep((catViz?.steps?.length || 1) - 1); };
    $("viz-cat-slider").oninput = (e) => { stopCatPlay(); renderCatStep(Number(e.target.value)); };
    $("viz-cat-play").onclick = () => {
      if (catTimer) return stopCatPlay();
      if (!catViz?.steps?.length) return;
      if (catStepIdx >= catViz.steps.length - 1) renderCatStep(0);
      $("viz-cat-play").textContent = "⏸ 일시정지";
      catTimer = setInterval(() => {
        if (catStepIdx >= catViz.steps.length - 1) return stopCatPlay();
        renderCatStep(catStepIdx + 1);
      }, 950);
    };
    $("viz-cat-mode-quiver").onclick = () => {
      catMode = "quiver";
      $("viz-cat-mode-quiver").classList.add("active");
      $("viz-cat-mode-string").classList.remove("active");
      drawCategoryCanvas();
    };
    $("viz-cat-mode-string").onclick = () => {
      catMode = "string";
      $("viz-cat-mode-string").classList.add("active");
      $("viz-cat-mode-quiver").classList.remove("active");
      drawCategoryCanvas();
    };
    $("viz-cat-zoom-in").onclick = () => { catZoom = Math.min(2.4, catZoom * 1.18); drawCategoryCanvas(); };
    $("viz-cat-zoom-out").onclick = () => { catZoom = Math.max(0.55, catZoom / 1.18); drawCategoryCanvas(); };
    $("viz-cat-fit").onclick = () => { catZoom = 1; catPanX = 0; catPanY = 0; drawCategoryCanvas(); };
    const catCanvas = $("viz-cat-canvas");
    if (catCanvas) {
      let dragging = false, sx = 0, sy = 0;
      catCanvas.addEventListener("pointerdown", (e) => { dragging = true; sx = e.clientX; sy = e.clientY; catCanvas.setPointerCapture(e.pointerId); });
      catCanvas.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        catPanX += e.clientX - sx; catPanY += e.clientY - sy;
        sx = e.clientX; sy = e.clientY;
        drawCategoryCanvas();
      });
      catCanvas.addEventListener("pointerup", () => { dragging = false; });
      catCanvas.addEventListener("pointercancel", () => { dragging = false; });
    }

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

  function drawCategoryCanvas() {
    const canvas = $("viz-cat-canvas");
    if (!canvas || !catViz?.diagram) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(300, rect.width || 480);
    const h = Math.max(240, rect.height || 300);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    const dark = document.documentElement.dataset.ideTheme === "dark" || document.documentElement.dataset.theme === "dark";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const step = catViz.steps?.[catStepIdx];
    const highlights = new Set(step?.highlightEdges || []);
    const baseScale = Math.min(w / 1000, h / 600);
    ctx.save();
    ctx.translate(w / 2 + catPanX, h / 2 + catPanY);
    ctx.scale(baseScale * catZoom, baseScale * catZoom);
    ctx.translate(-500, -300);

    const diagram = catViz.diagram;
    if (catMode === "string") {
      // String Diagram dual: vertical colored wires = objects, horizontal boxes = morphisms/functors
      const wires = diagram.stringWires || [];
      const objs = diagram.nodes || [];
      const rowH = Math.max(70, 440 / Math.max(1, wires.length + 1));
      const wireCols = ["#38bdf8", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#fb7185"];
      const objX = new Map();
      const spanW = 820 / Math.max(1, objs.length);
      objs.forEach((n, idx) => {
        const x = 90 + spanW * idx + spanW / 2;
        objX.set(n.id, x);
        const col = wireCols[idx % wireCols.length];
        ctx.strokeStyle = col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, 65);
        ctx.lineTo(x, 540);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.font = "600 18px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(n.label, x, 44);
      });
      wires.forEach((m, idx) => {
        const y = 100 + idx * Math.min(82, rowH);
        const x1 = objX.get(m.dom) ?? 250;
        const x2 = objX.get(m.cod) ?? 650;
        const bx = (x1 + x2) / 2;
        const bw = Math.max(110, Math.abs(x2 - x1) + 46);
        const active = highlights.has(m.name);
        ctx.save();
        if (active) {
          ctx.shadowColor = "rgba(245, 158, 11, 0.55)";
          ctx.shadowBlur = 16;
        }
        ctx.fillStyle = active ? (dark ? "#78350f" : "#fef3c7") : (dark ? "#1e293b" : "#f8fafc");
        ctx.strokeStyle = active ? "#f59e0b" : (dark ? "#475569" : "#94a3b8");
        ctx.lineWidth = active ? 3 : 2;
        ctx.beginPath();
        ctx.roundRect(bx - bw / 2, y - 22, bw, 44, 12);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = active ? (dark ? "#fef08a" : "#92400e") : (dark ? "#e2e8f0" : "#0f172a");
        ctx.font = "700 17px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${m.name} (${m.dom}→${m.cod})`, bx, y);
      });
      ctx.restore();
      return;
    }

    // Quiver Mode: category cluster bands
    const cats = diagram.categories || [];
    const bandW = 880 / Math.max(1, cats.length);
    cats.forEach((cname, cIdx) => {
      const x = 100 + bandW * cIdx;
      ctx.save();
      ctx.fillStyle = dark ? "rgba(30, 41, 59, 0.42)" : "rgba(241, 245, 249, 0.72)";
      ctx.strokeStyle = dark ? "rgba(148, 163, 184, 0.25)" : "rgba(100, 116, 139, 0.24)";
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x + 14, 34, bandW - 28, 532, 22);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = dark ? "#93c5fd" : "#1d4ed8";
      ctx.font = "700 20px serif";
      ctx.textAlign = "left";
      ctx.fillText(`Cat ${cname}`, x + 34, 66);
    });

    // Draw functors as dashed bridge arcs between category bands if >= 2 categories
    if (cats.length >= 2 && catViz.functors?.length) {
      catViz.functors.forEach((f, idx) => {
        const sIdx = cats.indexOf(f.src);
        const dIdx = cats.indexOf(f.dst);
        if (sIdx < 0 || dIdx < 0 || sIdx === dIdx) return;
        const sx = 100 + bandW * sIdx + bandW * 0.5;
        const dx = 100 + bandW * dIdx + bandW * 0.5;
        const y = 78 + idx * 34;
        const active = highlights.has(f.name);
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = active ? "#f59e0b" : (dark ? "#818cf8" : "#6366f1");
        ctx.lineWidth = active ? 3.2 : 2;
        ctx.beginPath();
        ctx.moveTo(sx, y);
        ctx.quadraticCurveTo((sx + dx) / 2, y - 34, dx, y);
        ctx.stroke();
        ctx.fillStyle = active ? "#f59e0b" : (dark ? "#c7d2fe" : "#4338ca");
        ctx.font = "700 17px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`Functor ${f.name}`, (sx + dx) / 2, y - 16);
        ctx.restore();
      });
    }

    const posMap = new Map((diagram.nodes || []).map((n) => [n.id, n]));
    // Draw morphisms
    for (const edge of diagram.edges || []) {
      const a = posMap.get(edge.source);
      const b = posMap.get(edge.target);
      if (!a || !b) continue;
      const active = highlights.has(edge.name);
      const color = active ? "#f59e0b" : edge.kind === "iso" ? "#10b981" : (dark ? "#94a3b8" : "#475569");
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = active ? 3.8 : 2.1;
      if (active) {
        ctx.shadowColor = "rgba(245, 158, 11, 0.55)";
        ctx.shadowBlur = 10;
      }
      let lx, ly, tx, ty, angle;
      if (a.id === b.id) {
        const r = 34 + edge.curveIndex * 16;
        ctx.beginPath();
        ctx.arc(a.x, a.y - r - 12, r, 0.25 * Math.PI, 2.15 * Math.PI);
        ctx.stroke();
        lx = a.x; ly = a.y - r * 2 - 22;
        tx = a.x + r * 0.7; ty = a.y - r;
        angle = 0.7;
      } else {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const bend = (edge.curveIndex % 2 === 0 ? 1 : -1) * (Math.floor((edge.curveIndex + 1) / 2) * 44 + 14);
        const mx = (a.x + b.x) / 2 + nx * bend;
        const my = (a.y + b.y) / 2 + ny * bend;
        const sr = 28;
        const sx = a.x + (dx / len) * sr;
        const sy = a.y + (dy / len) * sr;
        tx = b.x - (dx / len) * (sr + 4);
        ty = b.y - (dy / len) * (sr + 4);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(mx, my, tx, ty);
        ctx.stroke();
        angle = Math.atan2(ty - my, tx - mx);
        lx = 0.25 * sx + 0.5 * mx + 0.25 * tx + nx * 12;
        ly = 0.25 * sy + 0.5 * my + 0.25 * ty + ny * 12;
      }
      // Arrowhead
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 12 * Math.cos(angle - 0.35), ty - 12 * Math.sin(angle - 0.35));
      ctx.lineTo(tx - 12 * Math.cos(angle + 0.35), ty - 12 * Math.sin(angle + 0.35));
      ctx.closePath();
      ctx.fill();
      ctx.font = (active ? "700 18px" : "600 16px") + " monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = active ? (dark ? "#fde68a" : "#b45309") : (dark ? "#e2e8f0" : "#1e293b");
      ctx.fillText(edge.kind === "iso" ? `${edge.name} ≅` : edge.name, lx, ly);
      ctx.restore();
    }

    // Draw object nodes
    for (const node of diagram.nodes || []) {
      const r = node.special === "derived" ? 26 : 29;
      ctx.save();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = dark ? "#0f172a" : "#ffffff";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = node.special === "terminal" ? "#f59e0b"
        : node.special === "initial" ? "#10b981"
          : node.special === "derived" ? "#8b5cf6" : "#3b82f6";
      ctx.stroke();
      ctx.fillStyle = dark ? "#f8fafc" : "#0f172a";
      ctx.font = (node.label.length > 5 ? "700 14px" : "700 18px") + " monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(node.label, node.x, node.y);
      ctx.restore();
    }
    ctx.restore();
  }

  function renderCatStep(idx, options = {}) {
    if (!catViz || !catViz.steps?.length) return;
    const { scroll = true } = options;
    catStepIdx = Math.max(0, Math.min(catViz.steps.length - 1, idx));
    const step = catViz.steps[catStepIdx];
    $("viz-cat-slider").value = String(catStepIdx);
    $("viz-cat-counter").textContent = `${catStepIdx + 1} / ${catViz.steps.length}`;
    $("viz-cat-first").disabled = catStepIdx === 0;
    $("viz-cat-prev").disabled = catStepIdx === 0;
    $("viz-cat-next").disabled = catStepIdx === catViz.steps.length - 1;
    $("viz-cat-last").disabled = catStepIdx === catViz.steps.length - 1;

    const kind = step.status === "error" ? "error" : step.status === "solved" ? "solved" : "lean";
    host?.highlightLine(catContext.path, catContext.cell, step.line, kind, scroll);
    drawCategoryCanvas();

    const stepBox = $("viz-cat-step-box");
    const statusLabel = step.status === "solved" ? "✓ 가환 증명 완료" : step.status === "error" ? "✕ 타입/증명 오류" : step.status === "open" ? "등식 변형 중" : "범주 선언";
    const children = [
      (() => {
        const top = el("div", undefined, "viz-explain-top");
        top.append(
          el("span", `${step.line}행 · ${step.tactic || "선언"}`, "viz-step-pill"),
          el("span", statusLabel, "viz-step-state status-" + step.status),
        );
        return top;
      })(),
      el("pre", (step.code || "").trim(), "viz-step-code"),
      el("p", step.hint || "", "viz-step-hint" + (step.status === "error" ? " error" : "")),
    ];
    if (step.goal) {
      const gCard = el("div", undefined, "viz-goal-card");
      const targetRow = el("div", undefined, "viz-goal-target");
      targetRow.append(
        el("span", `${step.goal.dom} → ${step.goal.cod}`, "viz-case-pill"),
        el("code", step.status === "solved" ? "Q.E.D. ✓" : `${step.goal.lhs}  =  ${step.goal.rhs}`),
      );
      gCard.append(targetRow);
      children.push(gCard);
    }
    stepBox.replaceChildren(...children);
    renderPropCalcCard($("viz-cat-calc"), step.computation);
  }

  function renderCategoryViz(viz, context = {}) {
    stopCatPlay();
    catViz = viz;
    catContext = context;
    switchPane("category");

    $("viz-cat-empty").hidden = Boolean(viz);
    $("viz-cat-content").hidden = !viz;
    if (!viz) return;

    const pipeBox = $("viz-cat-pipeline");
    if (pipeBox) {
      pipeBox.replaceChildren(...(viz.pipeline || []).map((stage) => {
        const card = el("div", undefined, "viz-pipe-stage status-" + stage.status);
        const badge = stage.status === "ok" ? "✓" : stage.status === "error" ? "✕" : "·";
        card.append(el("span", badge + " " + stage.label, "viz-pipe-title"), el("small", stage.detail || "", "viz-pipe-detail"));
        return card;
      }));
    }

    const hasSteps = Boolean(viz.steps?.length);
    const slider = $("viz-cat-slider");
    slider.max = String(Math.max(0, (viz.steps?.length || 1) - 1));
    slider.disabled = !hasSteps;
    if (hasSteps) {
      const firstProof = viz.steps.findIndex((s) => s.status !== "decl");
      renderCatStep(firstProof >= 0 ? firstProof : 0);
    } else {
      $("viz-cat-counter").textContent = "0 / 0";
      drawCategoryCanvas();
    }

    const summaryBox = $("viz-cat-summary");
    if (summaryBox) {
      const items = [];
      for (const thm of viz.theorems || []) {
        const card = el("div", undefined, "viz-decl-card");
        const row = el("div", undefined, "viz-decl-head");
        row.append(
          el("span", thm.verified ? "✓ 증명됨" : "미완", "viz-decl-kind " + (thm.verified ? "kind-theorem" : "kind-error")),
          el("strong", thm.name),
          el("span", `${thm.line}행`, "viz-decl-line"),
        );
        card.append(row, el("div", `${thm.statement}  (: ${thm.dom} → ${thm.cod} in ${thm.cat})`, "viz-decl-deps"));
        card.onclick = () => {
          const si = catViz.steps.findIndex((s) => s.line >= thm.line);
          if (si >= 0) renderCatStep(si);
        };
        items.push(card);
      }
      summaryBox.replaceChildren(...(items.length ? [el("h4", "범주론 정리 검증 목록"), ...items] : []));
    }
  }

  function showExecutionResult(viz, context = {}) {
    if (!viz) return;
    if (viz.kind === "lean4") renderLeanViz(viz, context);
    else if (viz.kind === "category") renderCategoryViz(viz, context);
    else if (viz.kind === "python" || viz.kind === "cpp" || viz.kind === "java") renderPythonViz(viz, context);
  }

  function _findMatchingStepIndex(steps, line) {
    let idx = steps.findIndex((s) => s.line === line);
    if (idx >= 0) return idx;
    idx = steps.findIndex((s) => s.line <= line && line <= (s.endLine || s.line));
    if (idx >= 0) return idx;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].line <= line) return i;
    }
    return -1;
  }

  function syncLeanCursor(path, cell, line, _col = null, force = false) {
    if (!leanViz || leanTimer || !leanViz.steps?.length) return;
    if (leanContext.path !== path || leanContext.cell !== cell) return;
    const idx = _findMatchingStepIndex(leanViz.steps, line);
    if (idx >= 0 && (force || idx !== leanStepIdx)) {
      renderLeanStep(idx, { scroll: false });
    }
  }

  function syncCategoryCursor(path, cell, line, _col = null, force = false) {
    if (!catViz || catTimer || !catViz.steps?.length) return;
    if (catContext.path !== path || catContext.cell !== cell) return;
    const idx = _findMatchingStepIndex(catViz.steps, line);
    if (idx >= 0 && (force || idx !== catStepIdx)) {
      renderCatStep(idx, { scroll: false });
    }
  }

  function syncCodeCursor(path, cell, line, _col = null, force = false) {
    if (!pyViz || pyTimer || !pyViz.steps?.length) return;
    if (pyContext.cell && pyContext.cell !== cell) return;
    if (!pyContext.cell && cell) return;
    const norm = (p) => (p || "").startsWith("/") ? p : "/" + (p || "");
    const targetFile = norm(path || pyContext.path || pyViz.primaryFile);
    const cursorKey = `${targetFile}:${cell ? "cell" : "file"}:${line}`;
    if (!force && cursorKey === lastCodeCursorKey) return;
    lastCodeCursorKey = cursorKey;
    const visits = [];
    pyViz.steps.forEach((s, i) => {
      if (s.line === line && norm(s.file || pyViz.primaryFile) === targetFile) visits.push(i);
    });
    if (!visits.length) return;
    if (visits.includes(pyStepIdx) && !force) {
      renderLineVisits(pyViz.steps[pyStepIdx]);
      return;
    }
    const nextIdx = visits.find((i) => i >= pyStepIdx) ?? visits[0];
    renderPyStep(nextIdx, { scroll: false });
  }

  function setParallelJobs(jobs = []) {
    const badge = $("viz-parallel-badge");
    if (!badge) return;
    const count = Array.isArray(jobs) ? jobs.length : 0;
    badge.hidden = count === 0;
    if (count > 0) {
      badge.textContent = `⚡ 병렬 ${count}건`;
      badge.title = jobs.join(" · ");
    }
  }

  return {
    init,
    showExecutionResult,
    syncLeanCursor,
    syncCategoryCursor,
    syncCodeCursor,
    setParallelJobs,
    switchPane,
    setStudioVisible,
    analyzeProject,
  };
})();
