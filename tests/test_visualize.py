import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import codegraph, visualize

HAS_FLASK = importlib.util.find_spec("flask") is not None


class LeanParseAndHintsTests(unittest.TestCase):
    def test_parse_lean_goal_extracts_case_hypotheses_and_target(self):
        raw = (
            "case succ\n"
            "k : Nat\n"
            "ih : k + 0 = k\n"
            "  ∧ True\n"
            "⊢ k + 1 + 0 = k + 1"
        )
        parsed = visualize.parse_lean_goal(raw)
        self.assertEqual(parsed["case"], "succ")
        self.assertEqual(parsed["hypotheses"], [
            {"name": "k", "type": "Nat"},
            {"name": "ih", "type": "k + 0 = k ∧ True"},
        ])
        self.assertEqual(parsed["target"], "k + 1 + 0 = k + 1")

    def test_tactic_hints_cover_common_tactics(self):
        self.assertIn("귀납법", visualize.tactic_hint("  induction n with"))
        self.assertIn("등식", visualize.tactic_hint("    rw [ih]"))
        self.assertIn("반사율", visualize.tactic_hint("  rfl"))


class LeanCodeGraphTests(unittest.TestCase):
    def test_lean_files_analyze_imports_namespaces_and_references(self):
        files = {
            "/math/Base.lean": (
                "-- comment should be ignored: theorem fake : True := rfl\n"
                "namespace Math\n"
                "axiom baseAx : Nat\n"
                "def helper (n : Nat) : Nat := n + 1\n"
                "end Math\n"
            ),
            "/math/Main.lean": (
                "import math.Base\n"
                "structure Box where\n"
                "  val : Nat\n"
                "theorem check (n : Nat) : Math.helper n = Math.helper n := by\n"
                "  let _ := Math.baseAx\n"
                "  rfl\n"
            ),
        }
        graph = codegraph.analyze(files)
        self.assertEqual(graph["languages"], {"lean4": 2})
        names = {n["id"]: n["qualname"] for n in graph["nodes"]}
        edges = {(names[e["from"]], e["kind"], names[e["to"]]) for e in graph["edges"]}
        self.assertIn(("/math/Main.lean", "imports", "/math/Base.lean"), edges)
        self.assertIn(("/math/Main.lean", "contains", "Box"), edges)
        self.assertIn(("check", "calls", "Math.helper"), edges)
        self.assertIn(("check", "reads", "Math.baseAx"), edges)
        self.assertFalse(any(q == "fake" for q in names.values()))


class PythonTracerTests(unittest.TestCase):
    def _run_tracer(self, code):
        ns = {}
        exec(visualize.PYTHON_TRACER_CORE, ns, ns)
        buf = io.StringIO()
        src_map = {"/demo.py": code.splitlines()}
        tracer, finalize = ns["_qnb_make_tracer"]("/demo.py", buf, src_map)
        compiled = compile(code, "/workspace/demo.py", "exec")
        exec_ns = {"__name__": "__main__"}
        sys.settrace(tracer)
        try:
            exec(compiled, exec_ns, exec_ns)
        except Exception:
            pass
        finally:
            sys.settrace(None)
        return finalize()

    def test_captures_stack_heap_aliasing_and_call_edges(self):
        code = (
            "def bump(arr):\n"
            "    arr.append(2)\n"
            "    return len(arr)\n"
            "a = [1]\n"
            "b = a\n"
            "res = bump(b)\n"
        )
        viz = self._run_tracer(code)
        self.assertEqual(viz["kind"], "python")
        self.assertGreater(len(viz["steps"]), 4)
        self.assertTrue(any(e["fromFunc"] == "<module>" and e["toFunc"] == "bump" for e in viz["callEdges"]))
        last = viz["steps"][-1]
        top_locals = last["stack"][0]["locals"]
        self.assertEqual(top_locals["a"], top_locals["b"])
        ref_id = top_locals["a"]["id"]
        self.assertEqual(last["heap"][ref_id]["type"], "list")
        self.assertEqual(last["heap"][ref_id]["length"], 2)

    def test_caps_steps_at_max_limit(self):
        code = "total = 0\nfor i in range(500):\n    total += i\n"
        viz = self._run_tracer(code)
        self.assertTrue(viz["truncatedSteps"])
        self.assertEqual(viz["totalSteps"], visualize.MAX_PY_STEPS)

    def test_orbit_sim_fourth_example_compresses_under_64k_and_succeeds(self):
        import subprocess

        vector2d = (
            "class Vec2:\n"
            "    def __init__(self, x, y):\n"
            "        self.x = x\n"
            "        self.y = y\n"
            "    def add(self, other):\n"
            "        return Vec2(self.x + other.x, self.y + other.y)\n"
            "    def scale(self, factor):\n"
            "        return Vec2(self.x * factor, self.y * factor)\n"
        )
        body = (
            "from vector2d import Vec2\n"
            "class Body:\n"
            "    def __init__(self, name, pos, vel):\n"
            "        self.name = name\n"
            "        self.pos = pos\n"
            "        self.vel = vel\n"
            "    def step(self, accel, dt):\n"
            "        self.vel = self.vel.add(accel.scale(dt))\n"
            "        self.pos = self.pos.add(self.vel.scale(dt))\n"
        )
        simulate = (
            "from vector2d import Vec2\n"
            "from body import Body\n"
            "\n"
            "def gravity_accel(pos):\n"
            "    r2 = pos.x * pos.x + pos.y * pos.y + 0.5\n"
            "    inv = -4.0 / r2\n"
            "    return Vec2(pos.x * inv, pos.y * inv)\n"
            "\n"
            "def run_simulation(steps):\n"
            "    probe = Body('Probe', Vec2(2.0, 0.0), Vec2(0.0, 1.4))\n"
            "    history = []\n"
            "    for tick in range(steps):\n"
            "        acc = gravity_accel(probe.pos)\n"
            "        probe.step(acc, 0.25)\n"
            "        history.append((round(probe.pos.x, 3), round(probe.pos.y, 3)))\n"
            "    return history\n"
            "\n"
            "trajectory = run_simulation(4)\n"
            "for step_no, coord in enumerate(trajectory, 1):\n"
            "    print(f'step {step_no}: pos={coord}')\n"
        )
        captured = {}

        def fake_vm(vm_id, payload):
            with tempfile.TemporaryDirectory() as ws:
                sim_dir = Path(ws) / "examples" / "orbit_sim"
                sim_dir.mkdir(parents=True)
                (sim_dir / "vector2d.py").write_text(vector2d)
                (sim_dir / "body.py").write_text(body)
                (sim_dir / "simulate.py").write_text(simulate)
                script = (
                    payload["code"]
                    .replace("/workspace", ws)
                    .replace("fn[10:]", f"fn[{len(ws)}:]")
                )
                proc = subprocess.run([sys.executable, "-u", "-c", script], capture_output=True, text=True)
                captured["stdout"] = proc.stdout
                captured["stderr"] = proc.stderr
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertLess(len(proc.stdout.encode("utf-8")), 65536)
                self.assertTrue(proc.stdout.strip().startswith("QNBZ:"))
                return {"exitCode": proc.returncode, "output": proc.stdout}

        with patch("qnb.runtime.vm", side_effect=fake_vm):
            result = visualize.trace_python_script(1900000000, "/examples/orbit_sim/simulate.py", simulate)
        self.assertEqual(result["exitCode"], 0)
        viz = result["visualization"]
        self.assertTrue(viz["ok"])
        self.assertFalse(viz["truncatedSteps"])
        self.assertIn("step 1:", result["outputs"][0]["text"])
        self.assertIn("step 4:", result["outputs"][0]["text"])
        edges = {(e["fromFunc"], e["toFunc"]) for e in viz["callEdges"]}
        self.assertIn(("run_simulation", "step"), edges)
        self.assertIn(("step", "add"), edges)


@unittest.skipUnless(HAS_FLASK, "Flask is required to test visualize endpoint")
class VisualizeEndpointTests(unittest.TestCase):
    def test_visualize_route_traces_python_and_lean(self):
        from qnb import store
        from qnb.app import app

        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(folder) / "qnb.sqlite3"),
        }):
            store.initialize()
            client = app.test_client()
            self.assertEqual(client.post("/api/signup", json={
                "email": "viz@example.test", "password": "password123",
            }).status_code, 200)
            with store.database() as db:  # skip the email-verification step in these HTTP tests
                db.execute("UPDATE accounts SET email_verified = 1")

            py_payload = json.dumps({
                "exitCode": 0,
                "stdout": "42\n",
                "stderr": "",
                "visualization": {
                    "kind": "python", "primaryFile": "/a.py", "ok": True,
                    "steps": [{"index": 0, "event": "line", "file": "/a.py", "func": "<module>",
                               "line": 1, "code": "print(42)", "explain": "1행 실행",
                               "stack": [], "heap": {}, "stdout": "42\n", "returnValue": None, "error": None}],
                    "callEdges": [], "truncatedSteps": False, "totalSteps": 1,
                },
            })
            with patch("qnb.runtime.configure_disk"), \
                    patch("qnb.runtime.vm", return_value={"exitCode": 0, "output": py_payload}):
                res = client.post("/api/visualize", json={
                    "path": "/a.py", "language": "python", "code": "print(42)",
                })
            self.assertEqual(res.status_code, 200)
            body = res.get_json()
            self.assertEqual(body["visualization"]["kind"], "python")
            self.assertEqual(body["outputs"][0]["text"], "42\n")

            with patch("qnb.runtime.configure_disk"), \
                    patch("qnb.runtime.check_lean", return_value=(0, "", [], [], [], [], {})), \
                    patch("qnb.visualize.probe_lean_lsp", return_value=([], [], {})), \
                    patch("qnb.visualize.collect_lean_visualization", return_value={
                        "kind": "lean4", "path": "/b.lean", "ok": True,
                        "steps": [], "pipeline": [], "declarations": [], "recovered": [], "output": "Lean 검사 통과",
                    }):
                lean_res = client.post("/api/visualize", json={
                    "path": "/b.lean", "language": "lean4", "code": "theorem t : True := True.intro",
                })
            self.assertEqual(lean_res.status_code, 200)
            self.assertEqual(lean_res.get_json()["visualization"]["kind"], "lean4")

            cat_res = client.post("/api/visualize", json={
                "path": "/cat.cat",
                "language": "category",
                "code": "category C\nobject A : C\ntheorem id_eq : id(A) ∘ id(A) = id(A) by\n  id_left\n  rfl\n",
            })
            self.assertEqual(cat_res.status_code, 200)
            cat_body = cat_res.get_json()
            self.assertEqual(cat_body["exitCode"], 0)
            self.assertEqual(cat_body["visualization"]["kind"], "category")
            self.assertTrue(cat_body["visualization"]["theorems"][0]["verified"])

            cell_res = client.post("/api/kernel", json={
                "operation": "run",
                "path": "/nb.ipynb",
                "language": "category",
                "code": "%%category\ncategory C\nobject A : C\ntheorem t1 : id(A) = id(A) by\n  rfl\n",
                "visualize": True,
            })
            self.assertEqual(cell_res.status_code, 200)
            self.assertEqual(cell_res.get_json()["visualization"]["kind"], "category")

    def test_lean_line_span_and_proposition_computation(self):
        line = "    | succ k ih => rw [Nat.add_succ] -- apply succ"
        col_start, col_end, tokens = visualize._lean_line_span(line)
        self.assertEqual(line[col_start:col_end], "rw [Nat.add_succ]")
        self.assertIn("Nat.add_succ", [t["name"] for t in tokens])

        before_g = [visualize.parse_lean_goal("n : Nat\n⊢ 0 + (n + 1) = n + 1")]
        after_g = [visualize.parse_lean_goal("n : Nat\n⊢ (0 + n) + 1 = n + 1")]
        comp = visualize.compute_lean_proposition_trace(
            "  rw [Nat.add_succ]",
            before_g,
            after_g,
            hover_items=[{"name": "Nat.add_succ", "hover": {"contents": {"kind": "markdown", "value": "```lean\nNat.add_succ (n m : Nat) : n + m.succ = (n + m).succ\n```"}}}],
        )
        self.assertIsNotNone(comp)
        self.assertEqual(comp["operation"], "등식 치환 (Rewrite)")
        self.assertIn("0 + (n + 1)", comp["before"])
        self.assertIn("(0 + n) + 1", comp["after"])
        self.assertEqual(comp["rules"][0]["name"], "Nat.add_succ")
        self.assertIn("Nat.add_succ", comp["rules"][0]["signature"])

        solved_comp = visualize.compute_lean_proposition_trace(
            "  rfl",
            after_g,
            [],
        )
        self.assertIn("종결", solved_comp["operation"])
        self.assertEqual(solved_comp["contractum"], "True (Q.E.D. ✓)")


class LeanProbeScriptTests(unittest.TestCase):
    def test_probe_avoids_single_thread_deadlock_and_reaps_workers(self):
        from qnb import visualize
        script = visualize._build_lsp_probe_script("theorem t : True := trivial", [], "/workspace")
        self.assertIn('"--server", "-j2"', script)          # 1 vCPU: the default task pool deadlocks
        self.assertIn("prctl(36, 1", script)                   # child subreaper for the lean worker
        self.assertIn("os.killpg(proc.pid, signal.SIGKILL)", script)
        compile(script, "probe", "exec")


if __name__ == "__main__":
    unittest.main()
