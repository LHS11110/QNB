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
  let catMode = "commute";
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

  let structView = null;
  let structMode = "structure";

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
      description: "두 함자 F, G 사이의 자연변환 α가 만드는 가환 사각형과 함자 보존 법칙을 단계마다 가환 도식(사각형 · 삼각형)으로 보며 증명합니다.",
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
    {
      id: "plot-2d",
      langGroup: "plot",
      badge: "좌표계 · 2D",
      title: "Desmos처럼 식을 바로 그리는 2차원 좌표계",
      description: "함수·음함수·부등식·극좌표·매개변수 곡선, 배열과 반복문, 조건부 함수를 .plot 파일에 쓰고 슬라이더로 값을 바꿔 보며 그래프가 변하는 모습을 관찰합니다.",
      entryPath: "/examples/graphs/tour_2d.plot",
      runMode: "plain",
      files: { "/examples/graphs/tour_2d.plot": window.QNBPlot?.TEMPLATE || "y = x^2\n" },
    },
    {
      id: "plot-3d",
      langGroup: "plot",
      badge: "좌표계 · 3D",
      title: "세 변수 관계식이 만드는 3차원 곡면",
      description: "x² + y² + z² = 9 같은 3변수 음함수, z = f(x, y) 곡면, 공간 곡선을 3차원 좌표계에 그리고 마우스로 돌려 봅니다.",
      entryPath: "/examples/graphs/tour_3d.plot",
      runMode: "plain",
      files: { "/examples/graphs/tour_3d.plot": window.QNBPlot?.TEMPLATE_3D || "z = x y\n" },
    },
    {
      id: "py-bfs-graph",
      langGroup: "python",
      badge: "Python · 그래프",
      title: "너비 우선 탐색(BFS)을 그래프 위에서",
      description: "인접 리스트 그래프에서 visited·queue·현재 정점(node)이 바뀌며 탐색 트리가 자라는 과정을 '그래프' 보기로 한 단계씩 봅니다.",
      entryPath: "/examples/python_bfs_graph.py",
      runMode: "plain",
      files: { "/examples/python_bfs_graph.py": [
          "from collections import deque",
          "",
          "# 무방향 그래프 (인접 리스트) — 오른쪽 '구조 시각화'의 그래프 보기에서 탐색 과정을 봅니다.",
          "graph = {",
          "    \"A\": [\"B\", \"C\"],",
          "    \"B\": [\"A\", \"D\", \"E\"],",
          "    \"C\": [\"A\", \"F\"],",
          "    \"D\": [\"B\"],",
          "    \"E\": [\"B\", \"F\"],",
          "    \"F\": [\"C\", \"E\"],",
          "}",
          "",
          "def bfs(start):",
          "    visited = {start}",
          "    queue = deque([start])",
          "    parent = {start: None}",
          "    order = []",
          "    while queue:",
          "        node = queue.popleft()",
          "        order.append(node)",
          "        for nb in graph[node]:",
          "            if nb not in visited:",
          "                visited.add(nb)",
          "                parent[nb] = node",
          "                queue.append(nb)",
          "    return order",
          "",
          "print(bfs(\"A\"))",
          "",
        ].join("\n") },
    },
    {
      id: "py-dijkstra-network",
      langGroup: "python",
      badge: "Python · 네트워크",
      title: "다익스트라 최단 경로와 가중치 네트워크",
      description: "도시 간 거리 네트워크에서 dist 값이 줄어들고 prev 간선이 최단 경로 트리를 이루는 과정을 '네트워크' 보기로 봅니다.",
      entryPath: "/examples/python_dijkstra_network.py",
      runMode: "plain",
      files: { "/examples/python_dijkstra_network.py": [
          "import heapq",
          "",
          "# 가중치 네트워크 (dict of dict) — '네트워크' 보기에서 간선 굵기 = 가중치, dist 값이 정점 아래에 표시됩니다.",
          "net = {",
          "    \"서울\": {\"대전\": 2, \"강릉\": 3},",
          "    \"대전\": {\"서울\": 2, \"대구\": 2, \"광주\": 3},",
          "    \"강릉\": {\"서울\": 3, \"대구\": 4},",
          "    \"대구\": {\"대전\": 2, \"강릉\": 4, \"부산\": 1},",
          "    \"광주\": {\"대전\": 3, \"부산\": 4},",
          "    \"부산\": {\"대구\": 1, \"광주\": 4},",
          "}",
          "",
          "def dijkstra(src):",
          "    dist = {v: float(\"inf\") for v in net}",
          "    dist[src] = 0",
          "    prev = {}",
          "    pq = [(0, src)]",
          "    done = set()",
          "    while pq:",
          "        d, u = heapq.heappop(pq)",
          "        if u in done:",
          "            continue",
          "        done.add(u)",
          "        for v, w in net[u].items():",
          "            if d + w < dist[v]:",
          "                dist[v] = d + w",
          "                prev[v] = u",
          "                heapq.heappush(pq, (dist[v], v))",
          "    return dist",
          "",
          "print(dijkstra(\"서울\"))",
          "",
        ].join("\n") },
    },
    {
      id: "py-linked-tree",
      langGroup: "python",
      badge: "Python · 자료구조",
      title: "연결 리스트와 이진 탐색 트리의 포인터",
      description: "노드가 만들어지고 next·left·right 포인터가 이어지는 모습을 '자료구조' 보기의 상자와 화살표로 봅니다.",
      entryPath: "/examples/python_linked_tree.py",
      runMode: "plain",
      files: { "/examples/python_linked_tree.py": [
          "# 연결 리스트와 이진 탐색 트리 — '자료구조' 보기에서 포인터가 이어지는 모습을 봅니다.",
          "class ListNode:",
          "    def __init__(self, val, next=None):",
          "        self.val = val",
          "        self.next = next",
          "",
          "class TreeNode:",
          "    def __init__(self, val):",
          "        self.val = val",
          "        self.left = None",
          "        self.right = None",
          "",
          "def insert(root, val):",
          "    if root is None:",
          "        return TreeNode(val)",
          "    if val < root.val:",
          "        root.left = insert(root.left, val)",
          "    else:",
          "        root.right = insert(root.right, val)",
          "    return root",
          "",
          "head = None",
          "for v in [4, 3, 2, 1]:",
          "    head = ListNode(v, head)",
          "",
          "root = None",
          "for v in [8, 3, 10, 1, 6, 14, 4]:",
          "    root = insert(root, v)",
          "",
          "grid = [[0, 1, 0], [1, 0, 1], [0, 1, 0]]",
          "print(head.val, root.val)",
          "",
        ].join("\n") },
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
    for (const key of ["lean", "python", "category", "project", "plot"]) {
      $("viz-tab-" + key)?.classList.toggle("active", key === pane);
      $("viz-tab-" + key)?.setAttribute("aria-selected", String(key === pane));
      const box = $("viz-pane-" + key);
      if (box) box.hidden = key !== pane;
    }
    if (pane === "category" && catViz) {
      setTimeout(() => drawCategoryCanvas(), 20);
    }
    if (pane === "plot") setTimeout(() => window.QNBPlot?.redraw(), 20);
    if (pane === "python") setTimeout(() => structView?.draw(), 20);
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
    renderStruct();
  }

  /* Data structure / graph / network view of the current execution step. */
  function renderStruct() {
    if (!structView) return;
    const step = pyViz?.steps?.[pyStepIdx] || null;
    const prev = pyStepIdx > 0 ? pyViz.steps[pyStepIdx - 1] : null;
    const graphs = step ? QNBStructViz.detectAll(step) : [];
    // A graph-shaped variable switches the default view to 그래프 the first time it appears.
    const clearlyGraph = graphs.find((g) => /adjacency|objects/.test(g.kind) || /^(g|graph|adj|net|network)$/i.test(g.name));
    if (clearlyGraph && !renderStruct.autoSwitched && structMode === "structure") {
      renderStruct.autoSwitched = true;
      structMode = clearlyGraph.weighted ? "network" : "graph";
    }
    for (const mode of ["structure", "graph", "network"]) {
      $("viz-struct-mode-" + mode).setAttribute("aria-pressed", String(mode === structMode));
    }
    const select = $("viz-struct-target");
    select.hidden = structMode === "structure" || graphs.length < 2;
    const names = graphs.map((g) => g.name);
    if (select.dataset.names !== names.join("\u0000")) {
      select.dataset.names = names.join("\u0000");
      select.replaceChildren(...graphs.map((g) => new Option(`${g.name} (정점 ${g.nodes.length})`, g.name)));
    }
    if (!names.includes(structView.target)) structView.target = names[0] || null;
    select.value = structView.target || "";
    structView.mode = structMode;
    structView.set(step, prev);
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

    renderStruct.autoSwitched = false;
    structMode = "structure";
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

  /* Examples are grouped by what they teach, not by language. */
  const EXAMPLE_CATEGORIES = [
    { key: "proof", icon: "⊢", label: "증명 · 논리", hint: "Lean 4 전술이 가정과 목표를 한 줄씩 바꾸는 과정", ids: ["lean-induction", "lean-logic"] },
    { key: "category", icon: "𝒞", label: "범주론", hint: "가환 도식과 함자·자연변환·수반으로 보는 등식 증명", ids: ["category-naturality", "category-adjunction-product"] },
    { key: "algorithm", icon: "↻", label: "알고리즘 · 재귀", hint: "호출 스택이 쌓이고 풀리며 값이 돌아오는 흐름", ids: ["python-mergesort", "java-recursion-bst"] },
    { key: "structure", icon: "▤", label: "자료구조 · 포인터", hint: "노드와 포인터가 이어지는 모습을 상자와 화살표로", ids: ["cpp-pointers-list", "py-linked-tree"] },
    { key: "graph", icon: "◉", label: "그래프 · 네트워크", hint: "탐색 상태(방문·큐·거리)와 가중치 네트워크", ids: ["py-bfs-graph", "py-dijkstra-network", "cpp-stl-project"] },
    { key: "project", icon: "⇄", label: "멀티파일 프로젝트", hint: "여러 파일이 import·호출로 협력하는 구조", ids: ["python-orbit-project", "java-oop-project"] },
    { key: "plot", icon: "📐", label: "좌표계", hint: "식·부등식·배열·반복문을 2D · 3D 그래프로", ids: ["plot-2d", "plot-3d"] },
  ];
  const LANG_LABEL = { lean4: "Lean 4", category: ".cat", python: "Python", cpp: "C++", java: "Java", plot: ".plot" };

  function exampleCategories() {
    const placed = new Set(EXAMPLE_CATEGORIES.flatMap((c) => c.ids));
    const groups = EXAMPLE_CATEGORIES.map((c) => ({ ...c, examples: c.ids.map((id) => EXAMPLES.find((ex) => ex.id === id)).filter(Boolean) }));
    // anything added later without a category still shows up
    const rest = EXAMPLES.filter((ex) => !placed.has(ex.id));
    if (rest.length) groups.push({ key: "etc", icon: "✦", label: "기타", hint: "", examples: rest });
    return groups.filter((g) => g.examples.length);
  }

  function renderExamplesGallery() {
    const groups = exampleCategories();
    if (activeExampleFilter !== "all" && !groups.some((g) => g.key === activeExampleFilter)) activeExampleFilter = "all";
    const renderFilters = (bar) => {
      if (!bar) return;
      bar.setAttribute("aria-label", "예제 카테고리");
      const options = [{ key: "all", label: "전체", icon: "", count: EXAMPLES.length }, ...groups.map((g) => ({ ...g, count: g.examples.length }))];
      bar.replaceChildren(...options.map((opt) => {
        const btn = el("button", undefined, "examples-filter-btn" + (activeExampleFilter === opt.key ? " active" : ""));
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(activeExampleFilter === opt.key));
        btn.append((opt.icon ? opt.icon + " " : "") + opt.label, el("span", String(opt.count), "examples-filter-count"));
        btn.onclick = () => {
          activeExampleFilter = opt.key;
          renderExamplesGallery();
        };
        return btn;
      }));
    };
    const card = (ex) => {
      const node = el("article", undefined, "example-card");
      const top = el("div", undefined, "example-card-top");
      top.append(el("span", ex.badge, "example-badge"), el("span", LANG_LABEL[ex.langGroup] || ex.langGroup, "example-lang lang-" + ex.langGroup));
      node.append(
        top,
        el("h3", ex.title),
        el("p", ex.description),
        (() => {
          const btn = el("button", "열고 시각화 실행 →", "primary");
          btn.type = "button";
          btn.onclick = () => launchExample(ex);
          return btn;
        })(),
      );
      return node;
    };
    const render = (target) => {
      if (!target) return;
      const shown = activeExampleFilter === "all" ? groups : groups.filter((g) => g.key === activeExampleFilter);
      target.replaceChildren(...shown.map((g) => {
        const section = el("section", undefined, "example-group");
        section.dataset.category = g.key;
        const head = el("header", undefined, "example-group-head");
        head.append(el("span", g.icon, "example-group-icon"), el("h4", g.label), el("span", `${g.examples.length}개`, "example-group-count"));
        if (g.hint) head.append(el("small", g.hint, "example-group-hint"));
        const grid = el("div", undefined, "example-group-grid");
        grid.append(...g.examples.map(card));
        section.append(head, grid);
        return section;
      }));
    };
    renderFilters($("examples-filter-bar"));
    renderFilters($("welcome-examples-filter"));
    render($("examples-list"));
    render($("welcome-examples-grid"));
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
    $("viz-tab-plot").onclick = () => switchPane("plot");
    window.QNBPlot?.mount(host);
    if (window.QNBStructViz && $("viz-struct-canvas")) {
      structView = new QNBStructViz.View($("viz-struct-canvas"));
      for (const mode of ["structure", "graph", "network"]) {
        $("viz-struct-mode-" + mode).onclick = () => { structMode = mode; renderStruct.autoSwitched = true; renderStruct(); };
      }
      $("viz-struct-target").onchange = (event) => { structView.target = event.target.value; structView.draw(); };
    }
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
    const setCatMode = (mode) => {
      catMode = mode;
      $("viz-cat-mode-commute").classList.toggle("active", mode === "commute");
      $("viz-cat-mode-context").classList.toggle("active", mode === "context");
      drawCategoryCanvas();
    };
    $("viz-cat-mode-commute").onclick = () => setCatMode("commute");
    $("viz-cat-mode-context").onclick = () => setCatMode("context");
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

  // ---------- category diagrams (tikz-cd style) ----------
  // Two views:
  //  · "commute": the current goal lhs = rhs drawn as a commutative diagram — two paths of arrows
  //    from dom to cod, shared ends pasted (square / triangle / parallel pair / polygon).
  //  · "context": the declarations as a 2-category picture — categories as frames holding their
  //    quivers, functors as arrows between frames, natural transformations as ⇓ 2-cells, F ⊣ G.
  // Labels use light TeX markup from the server: `_{…}` subscript, `^{…}` superscript.

  const CAT_FONT = '"STIX Two Math", "Cambria Math", "Latin Modern Math", "Times New Roman", serif';

  function catPalette(dark) {
    return {
      ink: dark ? "#e5e7eb" : "#111827",
      muted: dark ? "#94a3b8" : "#64748b",
      line: dark ? "#cbd5e1" : "#1f2937",
      frame: dark ? "rgba(148, 163, 184, 0.35)" : "rgba(71, 85, 105, 0.32)",
      frameFill: dark ? "rgba(30, 41, 59, 0.35)" : "rgba(248, 250, 252, 0.9)",
      bg: dark ? "#0f172a" : "#ffffff",
      changed: "#d97706",
      ok: dark ? "#34d399" : "#059669",
      open: dark ? "#fbbf24" : "#b45309",
      twocell: dark ? "#a5b4fc" : "#4338ca",
    };
  }

  /** Parse `_{…}` / `^{…}` markup into runs with a nesting level (0 base, ±1 sub/sup, …). */
  function mathRuns(text, level = 0, out = []) {
    let i = 0;
    let buf = "";
    const flush = () => { if (buf) { out.push({ text: buf, level }); buf = ""; } };
    while (i < text.length) {
      const ch = text[i];
      if ((ch === "_" || ch === "^") && text[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
        flush();
        mathRuns(text.slice(i + 2, j - 1), ch === "_" ? Math.min(level, 0) - 1 : Math.max(level, 0) + 1, out);
        i = j;
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  }

  function mathFont(size, level, weight = "") {
    const s = level === 0 ? size : size * (Math.abs(level) === 1 ? 0.7 : 0.58);
    return `${weight ? weight + " " : ""}italic ${s.toFixed(1)}px ${CAT_FONT}`;
  }

  function measureMath(ctx, text, size, weight) {
    let w = 0;
    for (const run of mathRuns(text)) { ctx.font = mathFont(size, run.level, weight); w += ctx.measureText(run.text).width; }
    return w;
  }

  function drawMath(ctx, text, x, y, size, color, align = "center", weight = "") {
    const width = measureMath(ctx, text, size, weight);
    let cx = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
    ctx.save();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const run of mathRuns(text)) {
      ctx.font = mathFont(size, run.level, weight);
      const dy = run.level < 0 ? size * 0.28 : run.level > 0 ? -size * 0.36 : 0;
      ctx.fillText(run.text, cx, y + dy);
      cx += ctx.measureText(run.text).width;
    }
    ctx.restore();
    return width;
  }

  /** A diagram object: a label with a (clip) box arrows stop at. */
  function catNode(ctx, label, x, y, size = 24) {
    const w = measureMath(ctx, label, size) + 12;
    return { label, x, y, w, h: size + 10, size };
  }

  /** Point where the ray from the box centre towards (tx, ty) leaves the box. */
  function boxExit(node, tx, ty, pad = 3) {
    const dx = tx - node.x;
    const dy = ty - node.y;
    if (!dx && !dy) return { x: node.x, y: node.y };
    const hw = node.w / 2 + pad;
    const hh = node.h / 2 + pad;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return { x: node.x + dx * t, y: node.y + dy * t };
  }

  /**
   * Draw an arrow between two nodes.  `bend` bows the arrow (px, + = to the left of travel);
   * `away` is a point the label should be placed away from (the inside of a diagram cell).
   */
  function catArrow(ctx, a, b, opts = {}) {
    const { bend = 0, label = "", kind = "morphism", color, labelColor, away = null, width = 1.5, labelSize = 19 } = opts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const cx = (a.x + b.x) / 2 + nx * bend;
    const cy = (a.y + b.y) / 2 + ny * bend;
    const s = boxExit(a, cx, cy);
    const e = boxExit(b, cx, cy, 5);
    const qx = 2 * cx - (s.x + e.x) / 2;   // control point so the curve passes through (cx, cy)
    const qy = 2 * cy - (s.y + e.y) / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    if (kind === "universal") ctx.setLineDash([7, 5]);
    if (kind === "identity") {
      // An identity is drawn as an equality: a double line, no head.
      for (const off of [-2.2, 2.2]) {
        ctx.beginPath();
        ctx.moveTo(s.x + nx * off, s.y + ny * off);
        ctx.quadraticCurveTo(qx + nx * off, qy + ny * off, e.x + nx * off, e.y + ny * off);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(qx, qy, e.x, e.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // tikz-cd "to" head: two short curved strokes.
      const ang = Math.atan2(e.y - qy, e.x - qx);
      const hl = 9 + width;
      for (const sgn of [-1, 1]) {
        const ha = ang + sgn * 0.42;
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.quadraticCurveTo(e.x - hl * 0.55 * Math.cos(ang), e.y - hl * 0.55 * Math.sin(ang),
          e.x - hl * Math.cos(ha), e.y - hl * Math.sin(ha));
        ctx.stroke();
      }
      if (kind === "iso") {   // ≅ written over the middle of the arrow
        drawMath(ctx, "≅", cx - nx * 12, cy - ny * 12, 15, color);
      }
    }
    ctx.restore();
    if (label && kind !== "identity") {
      const lw = measureMath(ctx, label, labelSize);
      let side = 1;
      if (away) {
        const vx = cx - away.x;
        const vy = cy - away.y;
        side = vx * nx + vy * ny >= 0 ? 1 : -1;
      } else if (bend) side = Math.sign(bend);
      const off = Math.abs(nx) * (lw / 2) + Math.abs(ny) * (labelSize * 0.55) + 7;
      drawMath(ctx, label, cx + nx * side * off, cy + ny * side * off, labelSize, labelColor || color);
    }
    return { cx, cy };
  }

  function catLoop(ctx, a, opts = {}) {
    const { label = "", color, labelColor, up = true, r = 22, labelSize = 19 } = opts;
    const dir = up ? -1 : 1;
    const cy = a.y + dir * (a.h / 2 + r);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(a.x, cy, r * 0.9, r, 0, up ? 0.68 * Math.PI : -0.32 * Math.PI, up ? 2.32 * Math.PI : 1.32 * Math.PI);
    ctx.stroke();
    const tipA = up ? 2.32 * Math.PI : 1.32 * Math.PI;
    const tx = a.x + r * 0.9 * Math.cos(tipA);
    const ty = cy + r * Math.sin(tipA);
    for (const sgn of [-1, 1]) {
      const ha = (up ? 1.55 : -1.55) + sgn * 0.45;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 9 * Math.cos(ha), ty - 9 * Math.sin(ha));
      ctx.stroke();
    }
    ctx.restore();
    if (label) drawMath(ctx, label, a.x, cy + dir * (r + 13), labelSize, labelColor || color);
  }

  /** Lay out a path diagram (see category.py path_diagram) in unit-free world coordinates. */
  function layoutPathDiagram(ctx, d) {
    const U = 190;
    const V = 150;
    const nodes = [];
    const arrows = [];
    const add = (label, x, y) => { const n = catNode(ctx, label, x, y); nodes.push(n); return n; };
    const p = d.top.length;
    const q = d.bottom.length;

    // Region (split S → merge M) first, at the origin; prefix/suffix chains hang off it.
    let S;
    let M;
    let regionCentre = null;
    const placeChain = (from, list, pts, lastNode) => {
      let prev = from;
      list.forEach((arrow, i) => {
        const next = i === list.length - 1 && lastNode ? lastNode : add(arrow.dstMath, pts[i].x, pts[i].y);
        arrows.push({ from: prev, to: next, arrow, bend: pts[i].bend || 0 });
        prev = next;
      });
    };
    const startMath = d.prefix.length ? d.prefix[d.prefix.length - 1].dstMath : d.domMath;
    if (p === 0 && q === 0) {
      S = M = add(startMath, 0, 0);
    } else if (p === 0 || q === 0) {
      // One side is the identity on S: the other path is a loop back to S.
      S = M = add(startMath, 0, 0);
      const loop = p ? d.top : d.bottom;
      if (loop.length === 1) {
        arrows.push({ from: S, to: S, arrow: loop[0], loop: true });
      } else {
        // Nodes on a circle standing on S (S at its bottom), walked anticlockwise on screen.
        const k = loop.length;
        const R = k === 2 ? V * 0.6 : V * 0.75;
        const bend = k === 2 ? 46 : 0;   // two arrows between the same pair bow apart (a lens)
        const pts = [];
        for (let i = 1; i < k; i++) {
          const ang = Math.PI / 2 - (Math.PI * 2 * i) / k;
          pts.push({ x: Math.cos(ang) * R * 1.25, y: -R + Math.sin(ang) * R, bend });
        }
        pts.push({ x: 0, y: 0, bend });
        placeChain(S, loop, pts, S);
        regionCentre = { x: 0, y: -R };
      }
    } else if (p === 1 && q === 1) {
      S = add(startMath, 0, 0);
      M = add(d.top[0].dstMath, U * 1.25, 0);
      arrows.push({ from: S, to: M, arrow: d.top[0], bend: 34 });
      arrows.push({ from: S, to: M, arrow: d.bottom[0], bend: -34 });
      regionCentre = { x: U * 0.62, y: 0 };
    } else if (p === 2 && q === 2) {
      // The commutative square.
      S = add(startMath, 0, 0);
      M = add(d.top[1].dstMath, U, V);
      placeChain(S, d.top, [{ x: U, y: 0 }, { x: U, y: V }], M);
      placeChain(S, d.bottom, [{ x: 0, y: V }, { x: U, y: V }], M);
      regionCentre = { x: U / 2, y: V / 2 };
    } else if ((p === 2 && q === 1) || (p === 1 && q === 2)) {
      // The commutative triangle; the longer side goes round the corner.
      const two = p === 2 ? d.top : d.bottom;
      const one = p === 2 ? d.bottom : d.top;
      S = add(startMath, 0, 0);
      M = add(two[1].dstMath, U, V);
      placeChain(S, two, [{ x: U, y: 0 }, { x: U, y: V }], M);
      arrows.push({ from: S, to: M, arrow: one[0] });
      regionCentre = { x: U * 0.68, y: V * 0.32 };
    } else {
      const span = Math.max(p, q) * U * 0.82;
      S = add(startMath, 0, 0);
      M = add((d.top[p - 1] || d.bottom[q - 1]).dstMath, span, 0);
      const side = (n, dir) => {
        const pts = [];
        for (let i = 1; i < n; i++) {
          const t = i / n;
          pts.push({ x: span * t, y: dir * V * 0.85 * Math.sin(Math.PI * t) ** 0.6 });
        }
        pts.push({ x: span, y: 0 });
        return pts;
      };
      placeChain(S, d.top, side(p, -1), M);
      placeChain(S, d.bottom, side(q, 1), M);
      regionCentre = { x: span / 2, y: 0 };
    }

    // Prefix: chain into S from the left, along S's row.
    let prev = null;
    if (d.prefix.length) {
      const k = d.prefix.length;
      prev = add(d.domMath, S.x - U * k, S.y);
      d.prefix.forEach((arrow, i) => {
        const next = i === k - 1 ? S : add(arrow.dstMath, S.x - U * (k - 1 - i), S.y);
        arrows.push({ from: prev, to: next, arrow, chain: true });
        prev = next;
      });
    }
    // Suffix: chain out of M to the right, along M's row.
    prev = M;
    d.suffix.forEach((arrow, i) => {
      const next = add(arrow.dstMath, M.x + U * (i + 1), M.y);
      arrows.push({ from: prev, to: next, arrow, chain: true });
      prev = next;
    });
    return { nodes, arrows, regionCentre, S, M };
  }

  function previousDiagram(stepIdx) {
    const step = catViz.steps[stepIdx];
    for (let i = stepIdx - 1; i >= 0; i--) {
      const s = catViz.steps[i];
      if (s.theorem && s.theorem === step.theorem && s.diagram) return s.diagram;
      if (s.tactic === "theorem") break;
    }
    return null;
  }

  function fitWorld(ctx, items, box) {
    // items: [{x, y, w, h}] in layout coords → transform into `box` (world coords), never upscaled past 1.15.
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const it of items) {
      x0 = Math.min(x0, it.x - it.w / 2); x1 = Math.max(x1, it.x + it.w / 2);
      y0 = Math.min(y0, it.y - it.h / 2); y1 = Math.max(y1, it.y + it.h / 2);
    }
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    const k = Math.min(1.15, box.w / bw, box.h / bh);
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.scale(k, k);
    ctx.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    return k;
  }

  function drawCommuteDiagram(ctx, step, pal) {
    const d = step.diagram;
    const solved = d.commutes;
    const prevD = solved ? null : previousDiagram(catStepIdx);  // a solved step shows the original statement
    const prevLabels = prevD ? new Set([...prevD.prefix, ...prevD.top, ...prevD.bottom, ...prevD.suffix].map((a) => a.label)) : null;
    const layout = layoutPathDiagram(ctx, d);

    // Title and the equation as text.
    const title = step.theorem ? `${step.theorem}` : (step.tactic === "axiom" ? "공리" : "");
    ctx.save();
    ctx.font = `600 17px ${CAT_FONT}`;
    ctx.fillStyle = pal.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${title}${title ? " · " : ""}범주 ${d.category}`, 40, 40);
    ctx.restore();
    drawMath(ctx, `${d.lhsMath}  =  ${d.rhsMath}`, 500, 560, 21, solved ? pal.ok : pal.ink);
    ctx.save();
    ctx.font = `500 14px sans-serif`;
    ctx.fillStyle = solved ? pal.ok : pal.open;
    ctx.textAlign = "center";
    ctx.fillText(solved ? "✓ 도식이 가환함 (commutes)" : "? 가환성을 증명할 도식", 500, 530);
    ctx.restore();

    ctx.save();
    const items = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w + 140, h: n.h + 90 }));
    fitWorld(ctx, items, { x: 60, y: 70, w: 880, h: 430 });
    const away = layout.regionCentre;
    for (const a of layout.arrows) {
      const changed = prevLabels && !prevLabels.has(a.arrow.label);
      const color = changed ? pal.changed : pal.line;
      const labelColor = changed ? pal.changed : pal.ink;
      if (a.loop) {
        catLoop(ctx, a.from, { label: a.arrow.math, color, labelColor });
      } else {
        catArrow(ctx, a.from, a.to, {
          bend: a.bend || 0, label: a.arrow.math, kind: a.arrow.kind, color, labelColor,
          away: a.chain ? { x: a.from.x, y: a.from.y + 100 } : away, width: changed ? 2.4 : 1.5,
        });
      }
    }
    for (const n of layout.nodes) {
      drawMath(ctx, n.label, n.x, n.y, n.size, pal.ink);
    }
    if (away && (d.top.length || d.bottom.length)) {
      // Cell marker: the equation this region asserts.
      drawMath(ctx, solved ? "=" : "?", away.x, away.y, 26, solved ? pal.ok : pal.open);
    }
    ctx.restore();
  }

  /** Simple layered layout of one category's quiver (longest-path ranks). */
  function layoutQuiver(ctx, nodeIds, edges) {
    const succ = new Map(nodeIds.map((id) => [id, []]));
    for (const e of edges) if (e.source !== e.target && succ.has(e.source) && succ.has(e.target)) succ.get(e.source).push(e.target);
    const rank = new Map();
    const visiting = new Set();
    const depth = (id) => {
      if (rank.has(id)) return rank.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let r = 0;
      for (const [src, outs] of succ) if (outs.includes(id)) r = Math.max(r, depth(src) + 1);
      visiting.delete(id);
      rank.set(id, r);
      return r;
    };
    nodeIds.forEach(depth);
    const cols = new Map();
    for (const id of nodeIds) { const r = rank.get(id); if (!cols.has(r)) cols.set(r, []); cols.get(r).push(id); }
    const pos = new Map();
    for (const [r, ids] of cols) {
      ids.forEach((id, i) => pos.set(id, { x: r * 150, y: (i - (ids.length - 1) / 2) * 110 }));
    }
    return pos;
  }

  function drawContextDiagram(ctx, step, pal) {
    const diagram = catViz.diagram || {};
    const math = catViz.math || {};
    const cats = diagram.categories?.length ? diagram.categories : ["C"];
    // Highlight what the current line declares (proof steps keep the picture neutral).
    const highlights = new Set(step?.status === "decl" ? step.highlightEdges || [] : []);
    const mname = (kind, name) => (math[kind] && math[kind][name]) || name;

    // Frames: one per category, side by side with room between for functor arrows.
    const gap = 150;
    const frameW = Math.min(340, (900 - gap * (cats.length - 1)) / cats.length);
    const frameH = 300;
    const total = frameW * cats.length + gap * (cats.length - 1);
    const left = 500 - total / 2;
    const frames = new Map();
    cats.forEach((c, i) => frames.set(c, { x: left + i * (frameW + gap), y: 150, w: frameW, h: frameH }));

    for (const [c, f] of frames) {
      ctx.save();
      ctx.fillStyle = pal.frameFill;
      ctx.strokeStyle = pal.frame;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(f.x, f.y, f.w, f.h, 16);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      drawMath(ctx, c, f.x + 16, f.y - 18, 24, pal.ink, "left", "600");
    }

    // Objects and morphisms inside each frame.
    const placed = new Map();
    for (const [c, f] of frames) {
      const ids = (diagram.nodes || []).filter((n) => n.category === c).map((n) => n.id);
      const edges = (diagram.edges || []).filter((e) => e.category === c);
      const pos = layoutQuiver(ctx, ids, edges);
      const pts = [...pos.values()];
      if (!pts.length) {
        drawMath(ctx, "(대상 없음)", f.x + f.w / 2, f.y + f.h / 2, 15, pal.muted);
        continue;
      }
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      const k = Math.min(1, (f.w - 90) / Math.max(1, bw), (f.h - 90) / Math.max(1, bh));
      const ox = f.x + f.w / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * k;
      const oy = f.y + f.h / 2 + 10 - ((Math.max(...ys) + Math.min(...ys)) / 2) * k;
      for (const id of ids) {
        const p = pos.get(id);
        const node = (diagram.nodes || []).find((n) => n.id === id);
        const label = node?.special === "derived" ? id : mname("objects", id);
        placed.set(id, catNode(ctx, label, ox + p.x * k, oy + p.y * k, 21));
      }
      const pairCount = new Map();
      for (const e of edges) {
        const a = placed.get(e.source);
        const b = placed.get(e.target);
        if (!a || !b) continue;
        const hot = highlights.has(e.name);
        const color = hot ? pal.changed : pal.line;
        const label = mname("morphisms", e.name);
        if (a === b) {
          catLoop(ctx, a, { label, color, labelColor: hot ? pal.changed : pal.ink, labelSize: 16 });
          continue;
        }
        const key = [e.source, e.target].sort().join("\u0000");
        const n = pairCount.get(key) || 0;
        pairCount.set(key, n + 1);
        const bend = n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 26;
        catArrow(ctx, a, b, {
          bend, label, kind: e.kind === "iso" ? "iso" : "morphism",
          color, labelColor: hot ? pal.changed : pal.ink, width: hot ? 2.2 : 1.4, labelSize: 16,
        });
      }
      for (const id of ids) {
        const node = placed.get(id);
        if (node) drawMath(ctx, node.label, node.x, node.y, node.size, pal.ink);
      }
    }

    // Functors between frames (and endofunctors as loops above a frame).
    const frameNode = (c) => { const f = frames.get(c); return { x: f.x + f.w / 2, y: f.y + f.h / 2, w: f.w, h: f.h }; };
    const functors = catViz.functors || [];
    const adjPairs = new Map();
    for (const adj of catViz.adjunctions || []) adjPairs.set(adj.left, adj);
    const pairSeen = new Map();
    const functorMid = new Map();
    for (const fn of functors) {
      if (!frames.has(fn.src) || !frames.has(fn.dst)) continue;
      const hot = highlights.has(fn.name);
      const color = hot ? pal.changed : pal.twocell;
      const label = mname("functors", fn.name);
      if (fn.src === fn.dst) {
        const f = frames.get(fn.src);
        const n = pairSeen.get(fn.src + "↻") || 0;
        pairSeen.set(fn.src + "↻", n + 1);
        catLoop(ctx, { x: f.x + f.w / 2 + n * 60, y: f.y, w: 10, h: 0 }, { label, color, up: true, r: 24 });
        continue;
      }
      const key = [fn.src, fn.dst].sort().join("→");
      const n = pairSeen.get(key) || 0;
      pairSeen.set(key, n + 1);
      // Parallel functors fan out: first above the axis, then below, …
      const forward = cats.indexOf(fn.src) < cats.indexOf(fn.dst);
      const bendBase = (n % 2 === 0 ? 1 : -1) * (Math.floor(n / 2) * 30 + 34);
      const bend = forward ? -bendBase : bendBase;   // first functor above the axis (F over G, α ⇓)
      const a = frameNode(fn.src);
      const b = frameNode(fn.dst);
      const mid = catArrow(ctx, a, b, { bend, label, color, labelColor: color, width: hot ? 2.6 : 1.8, labelSize: 21 });
      functorMid.set(fn.name, mid);
    }
    // Adjunctions: ⊣ between the two functors.
    for (const adj of catViz.adjunctions || []) {
      const m1 = functorMid.get(adj.left);
      const m2 = functorMid.get(adj.right);
      if (!m1 || !m2) continue;
      drawMath(ctx, "⊥", (m1.cx + m2.cx) / 2, (m1.cy + m2.cy) / 2, 24, pal.twocell);
    }
    // Natural transformations: a ⇓ 2-cell between the two parallel functors.
    for (const nat of catViz.naturalTransformations || []) {
      const m1 = functorMid.get(nat.src_f);
      const m2 = functorMid.get(nat.dst_f);
      if (!m1 || !m2) continue;
      const hot = highlights.has(nat.name);
      const color = hot ? pal.changed : pal.twocell;
      const sx = m1.cx; const sy = m1.cy; const ex = m2.cx; const ey = m2.cy;
      const len = Math.hypot(ex - sx, ey - sy) || 1;
      const ux = (ex - sx) / len; const uy = (ey - sy) / len;
      const a0 = { x: sx + ux * 16, y: sy + uy * 16 };
      const a1 = { x: ex - ux * 18, y: ey - uy * 18 };
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      for (const off of [-2.4, 2.4]) {
        ctx.beginPath();
        ctx.moveTo(a0.x - uy * off, a0.y + ux * off);
        ctx.lineTo(a1.x - uy * off - ux * 4, a1.y + ux * off - uy * 4);
        ctx.stroke();
      }
      const ang = Math.atan2(uy, ux);
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(a1.x, a1.y);
        ctx.lineTo(a1.x - 10 * Math.cos(ang + sgn * 0.6), a1.y - 10 * Math.sin(ang + sgn * 0.6));
        ctx.stroke();
      }
      ctx.restore();
      drawMath(ctx, mname("nats", nat.name), (a0.x + a1.x) / 2 + 16, (a0.y + a1.y) / 2, 20, color, "left");
    }
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
    const pal = catPalette(dark);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const step = catViz.steps?.[catStepIdx];
    const baseScale = Math.min(w / 1000, h / 600);
    ctx.save();
    ctx.translate(w / 2 + catPanX, h / 2 + catPanY);
    ctx.scale(baseScale * catZoom, baseScale * catZoom);
    ctx.translate(-500, -300);
    if (catMode === "commute" && step?.diagram) drawCommuteDiagram(ctx, step, pal);
    else drawContextDiagram(ctx, step, pal);
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

  /* .plot files: coordinate systems drawn entirely in the browser. */
  function showPlot(text, context = {}, { focus = true } = {}) {
    window.QNBPlot?.show(text, context);
    if (focus && activePane !== "plot") switchPane("plot");
  }

  function syncPlotCursor(path, line) {
    window.QNBPlot?.highlightLine(path, line);
  }

  return {
    init,
    showPlot,
    syncPlotCursor,
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
