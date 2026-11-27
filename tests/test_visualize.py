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
                    patch("qnb.visualize.collect_lean_visualization", return_value={
                        "kind": "lean4", "path": "/b.lean", "ok": True,
                        "steps": [], "pipeline": [], "declarations": [], "recovered": [], "output": "Lean 검사 통과",
                    }):
                lean_res = client.post("/api/visualize", json={
                    "path": "/b.lean", "language": "lean4", "code": "theorem t : True := True.intro",
                })
            self.assertEqual(lean_res.status_code, 200)
            self.assertEqual(lean_res.get_json()["visualization"]["kind"], "lean4")


if __name__ == "__main__":
    unittest.main()
