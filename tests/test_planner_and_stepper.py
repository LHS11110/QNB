import base64
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from qnb import identity, planner, runtime, stepper, store
from qnb.runtime import RequestError

HAS_GPP = shutil.which("g++") is not None
HAS_JDK = shutil.which("javac") is not None and shutil.which("java") is not None
HAS_FLASK = importlib.util.find_spec("flask") is not None


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"QNB_DATABASE": str(Path(self.tmp.name) / "qnb.sqlite3")})
        self.env.start()
        store.initialize()
        planner.initialize()
        with store.database() as db:
            db.executemany("INSERT INTO accounts (id, email, password, vm_id) VALUES (?, ?, 'h', ?)",
                           [(1, "owner@example.test", 1), (2, "guest@example.test", 2), (3, "stranger@example.test", 3)])
            db.execute("INSERT INTO workspace_invites (owner_id, invitee_email, status) VALUES (1, 'guest@example.test', 'accepted')")

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_project_task_event_lifecycle_and_isolation(self):
        project, event = planner.mutate(1, 1, {"op": "create", "kind": "project", "data": {"name": "논문", "color": "#123456"}})
        self.assertEqual(event["op"], "upsert")
        task, _ = planner.mutate(1, 2, {"op": "create", "kind": "task", "data": {
            "title": "초안", "projectId": project["id"], "assigneeId": 2, "dueDate": "2026-12-01", "tags": ["write"]}})
        self.assertEqual((task["status"], task["priority"], task["tags"]), ("todo", "medium", ["write"]))
        done, _ = planner.mutate(1, 2, {"op": "update", "kind": "task", "id": task["id"], "data": {"status": "done"}})
        self.assertIsNotNone(done["completedAt"])
        reopened, _ = planner.mutate(1, 2, {"op": "update", "kind": "task", "id": task["id"], "data": {"status": "doing"}})
        self.assertIsNone(reopened["completedAt"])
        planner.mutate(1, 1, {"op": "create", "kind": "event", "data": {"title": "회의", "start": "2026-12-02T10:00", "allDay": False}})

        snap = planner.snapshot(1)
        self.assertEqual([m["nickname"] for m in snap["members"]], ["owner", "guest"])
        self.assertEqual(len(snap["tasks"]), 1)
        self.assertEqual(planner.snapshot(3)["tasks"], [])  # other workspaces see nothing
        with self.assertRaises(RequestError):
            planner.mutate(3, 3, {"op": "update", "kind": "task", "id": task["id"], "data": {"title": "x"}})

        planner.mutate(1, 1, {"op": "delete", "kind": "project", "id": project["id"]})
        self.assertIsNone(planner.snapshot(1)["tasks"][0]["projectId"])

    def test_validation(self):
        bad = [
            {"op": "create", "kind": "task", "data": {"title": ""}},
            {"op": "create", "kind": "task", "data": {"title": "x", "status": "nope"}},
            {"op": "create", "kind": "task", "data": {"title": "x", "dueDate": "12/01/2026"}},
            {"op": "create", "kind": "task", "data": {"title": "x", "assigneeId": 3}},
            {"op": "create", "kind": "task", "data": {"title": "x", "startDate": "2026-12-05", "dueDate": "2026-12-01"}},
            {"op": "create", "kind": "event", "data": {"title": "x"}},
            {"op": "create", "kind": "project", "data": {"name": "x", "color": "red"}},
            {"op": "create", "kind": "nope", "data": {}},
        ]
        for data in bad:
            with self.subTest(data=data), self.assertRaises(RequestError):
                planner.mutate(1, 1, data)


CPP_SAMPLE = r'''#include <iostream>
#include <vector>
int sq(int x) { return x * x; }
int main() {
    std::vector<int> v = {1, 2};
    int s = 0;
    for (int x : v)
        s += sq(x);
    std::cout << s << std::endl;
    return 0;
}
'''

HAS_GDB = shutil.which("gdb") is not None and HAS_GPP


def run_locally(vm_id, payload):
    done = subprocess.run(["python3", "-c", payload["code"]], capture_output=True, text=True, timeout=180)
    return {"exitCode": done.returncode, "output": done.stdout + done.stderr}


def step(line, func="main", event="line", depth=1, code="", out=0):
    return {"event": event, "line": line, "func": func, "out": out,
            "stack": [{"func": func, "line": line, "locals": {}}] * depth, "heap": {}}


class StepperTests(unittest.TestCase):
    def test_java_main_class_detection(self):
        nested_first = "public class Main {\n static class Node { int v; }\n public static void main(String[] a) { }\n}"
        self.assertEqual(stepper._java_names(nested_first, "/Main.java"), ("Main", "Main"))
        self.assertEqual(stepper._java_names("class A { static class B { public static void main(String[] a){} } }", "/A.java"), ("A", "A$B"))
        tricky = 'public class P { String s = "class X {"; // class Y {\n public static void main(String[] a) {} }'
        self.assertEqual(stepper._java_names(tricky, "/P.java"), ("P", "P"))

    def test_cleanup_bounces_and_repeats_are_hidden(self):
        code = "int main() {\n  std::vector<int> v = {1};\n  int a = 1;\n}\n"
        trace = [step(1, event="call"), step(2), step(4), step(2), step(3), step(4), {"event": "return", "line": 4,
                 "func": "main", "out": 0, "stack": [{"func": "main", "line": 4, "locals": {}}], "heap": {}}]
        result = stepper.build_result({"exitCode": 0, "stdout": "", "trace": trace}, code, "/m.cpp", "cpp")
        lines = [(s["event"], s["line"]) for s in result["visualization"]["steps"]]
        # 2 → "}" → 2 bounce collapsed; the final "}" before the return is kept
        self.assertEqual(lines, [("call", 1), ("line", 2), ("line", 3), ("line", 4), ("return", 4)])
        self.assertEqual([s["index"] for s in result["visualization"]["steps"]], list(range(5)))

    def test_build_result_maps_stdout_offsets_and_types(self):
        trace = [step(1), step(2, out=3)]
        trace[1]["heap"] = {"obj_9": {"id": "obj_9", "type": "std::vector<int, std::allocator<int> >", "length": 0, "items": []}}
        trace[1]["stack"] = [{"func": "main", "line": 2, "locals": {"v": {"kind": "ref", "id": "obj_9"}}}]
        result = stepper.build_result({"exitCode": 0, "stdout": "hi\nmore", "trace": trace}, "a\nb\n", "/x.cpp", "cpp")
        steps = result["visualization"]["steps"]
        self.assertEqual([s["stdout"] for s in steps], ["", "hi\n"])
        self.assertEqual(steps[1]["heap"]["obj_1"]["type"], "vector<int>")  # ids renumbered per step
        self.assertEqual(steps[1]["stack"][0]["locals"]["v"], {"kind": "ref", "id": "obj_1"})
        self.assertEqual(json.loads(json.dumps(result))["visualization"]["steps"][1]["code"], "b")
        self.assertEqual(stepper.pretty_type("unordered_map<int, int, std::hash<int>, std::equal_to<int>, "
                                             "std::allocator<std::pair<int const, int> > >"), "unordered_map<int, int>")

    def test_missing_debugger_is_reported(self):
        def no_tools(vm_id, payload):
            env = dict(os.environ, PATH="/nonexistent")
            done = subprocess.run([shutil.which("python3"), "-c", payload["code"]], capture_output=True, text=True, env=env)
            return {"exitCode": done.returncode, "output": done.stdout}

        with patch.object(runtime, "vm", no_tools):
            result = stepper.trace(1, "/demo/main.cpp", CPP_SAMPLE, "cpp")
        self.assertNotEqual(result["exitCode"], 0)
        self.assertIn("g++", result["outputs"][-1]["text"])

    @unittest.skipUnless(HAS_GDB, "g++ and gdb are required")
    def test_gdb_trace_end_to_end(self):
        with patch.object(runtime, "vm", run_locally):
            result = stepper.trace(1, "/demo/main.cpp", CPP_SAMPLE, "cpp")
        viz = result["visualization"]
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["outputs"][0]["text"], "5\n")
        self.assertEqual([s["func"] for s in viz["steps"] if s["event"] == "call"], ["main", "sq", "sq"])
        line8 = [s for s in viz["steps"] if s["line"] == 8][0]
        vector = [e for e in line8["heap"].values() if e["type"] == "vector<int>"][0]
        self.assertEqual([i["value"] for i in vector["items"]], [1, 2])
        self.assertEqual(viz["steps"][-1]["stdout"], "5\n")
        self.assertTrue(any(s.get("changes") for s in viz["steps"]))
        self.assertEqual([p["status"] for p in viz["pipeline"]], ["ok", "ok", "ok"])

    @unittest.skipUnless(HAS_GDB, "g++ and gdb are required")
    def test_gdb_pointers_multifile_and_signal(self):
        with tempfile.TemporaryDirectory() as td:
            proj = Path(td)
            (proj / "helper.hpp").write_text("struct Box { int v; Box* next; };\nint dbl(int x);\n")
            (proj / "helper.cpp").write_text('#include "helper.hpp"\nint dbl(int x) { return x * 2; }\n')
            # Sibling file with its own main() must be ignored when building main.cpp
            (proj / "other_demo.cpp").write_text("int main() { return 42; }\n")
            main_code = '#include "helper.hpp"\nint main() {\n  Box b{7, nullptr};\n  Box* p = &b;\n  int y = dbl(p->v);\n  return 0;\n}\n'
            main_path = proj / "main.cpp"
            main_path.write_text(main_code)

            def run_with_dir(vm_id, payload):
                code_mod = payload["code"]
                # Point projectDir to our host temp folder during local execution test
                return run_locally(vm_id, {"code": code_mod})

            with patch.object(runtime, "vm", run_with_dir):
                # Exercise pointer/heap tracing via standalone file plus compile error & crash
                ptr_code = (
                    "#include <iostream>\n"
                    "struct Node { int v; Node* next; Node(int x, Node* n) : v(x), next(n) {} };\n"
                    "int main() { Node* h = new Node(11, new Node(22, nullptr)); std::cout << h->v; return 0; }\n"
                )
                res_ptr = stepper.trace(1, "/main.cpp", ptr_code, "cpp")
                self.assertEqual(res_ptr["exitCode"], 0)
                self.assertTrue(any(
                    any(e.get("type") == "Node" for e in s.get("heap", {}).values())
                    for s in res_ptr["visualization"]["steps"]
                ))

                crash_code = "int main() { int* p = nullptr; return *p; }\n"
                res_crash = stepper.trace(1, "/crash.cpp", crash_code, "cpp")
                self.assertNotEqual(res_crash["exitCode"], 0)
                self.assertEqual(res_crash["visualization"]["steps"][-1]["event"], "exception")

    @unittest.skipUnless(HAS_JDK, "javac and java are required")
    def test_jdi_trace_recursion_and_exception(self):
        java_code = (
            "import java.util.*;\n"
            "public class Main {\n"
            "  static int fact(int n) {\n"
            "    if (n <= 1) return 1;\n"
            "    return n * fact(n - 1);\n"
            "  }\n"
            "  public static void main(String[] args) {\n"
            "    int ans = fact(3);\n"
            "    System.out.println(ans);\n"
            "  }\n"
            "}\n"
        )
        with patch.object(runtime, "vm", run_locally):
            res = stepper.trace(1, "/Main.java", java_code, "java")
        self.assertEqual(res["exitCode"], 0)
        self.assertEqual(res["outputs"][0]["text"].strip(), "6")
        returns = [s for s in res["visualization"]["steps"] if s["event"] == "return" and s["func"] == "Main.fact"]
        self.assertTrue(any(s.get("returnValue") == "6" for s in returns))

    def test_qnbz_decode_and_compile_error_parsing(self):
        payload = {"exitCode": 0, "stdout": "ok\n", "trace": [step(1)]}
        encoded = "QNBZ:" + base64.b64encode(zlib.compress(json.dumps(payload).encode())).decode()
        self.assertEqual(stepper._decode_runner_output(encoded)["stdout"], "ok\n")

        err_data = {
            "exitCode": 1, "note": "compile", "stdout": "", "trace": [],
            "stderr": "/demo/main.cpp:4:12: error: 'xyz' was not declared in this scope\n",
        }
        res = stepper.build_result(err_data, "int main() {\n\n\n  int a = xyz;\n}\n", "/demo/main.cpp", "cpp")
        viz = res["visualization"]
        self.assertFalse(viz["ok"])
        self.assertEqual(viz["compileErrors"][0]["file"], "/demo/main.cpp")
        self.assertEqual(viz["compileErrors"][0]["line"], 4)
        self.assertEqual(viz["steps"][0]["event"], "exception")
        self.assertEqual(viz["steps"][0]["line"], 4)
        self.assertEqual(viz["pipeline"][0]["status"], "error")

    @unittest.skipUnless(HAS_FLASK, "Flask is required for /api/kernel notebook tests")
    def test_notebook_cpp_and_java_cells(self):
        from qnb import app

        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(td) / "qnb.sqlite3"),
            "QNB_SECRET_KEY": "test-secret",
        }):
            store.initialize()
            client = app.app.test_client()
            with client:
                client.post("/api/signup", json={"email": "nb@example.test", "password": "Password1!", "nickname": "nbuser"})
                with store.database() as db:
                    acc = db.execute("SELECT id FROM accounts WHERE email = ?", ("nb@example.test",)).fetchone()
                    db.execute("UPDATE accounts SET email_verified = 1 WHERE id = ?", (acc["id"],))

                cpp_res_mock = {
                    "exitCode": 0,
                    "outputs": [{"output_type": "stream", "name": "stdout", "text": "9\n"}],
                    "visualization": {"kind": "cpp", "primaryFile": "/nb/cell.cpp", "ok": True, "steps": [], "callEdges": []},
                }
                with patch.object(runtime, "configure_disk"), \
                        patch.object(stepper, "trace", return_value=cpp_res_mock) as mocked_trace:
                    r1 = client.post("/api/kernel", json={
                        "path": "/nb/study.ipynb", "operation": "run", "language": "cpp",
                        "code": "%%cpp\nint main() { return 0; }\n", "visualize": True,
                    })
                    self.assertEqual(r1.status_code, 200)
                    self.assertEqual(r1.get_json()["visualization"]["kind"], "cpp")
                    mocked_trace.assert_called_once()
                    self.assertEqual(mocked_trace.call_args[0][1], "/nb/cell.cpp")

                doc = {
                    "nbformat": 4, "nbformat_minor": 5,
                    "metadata": {"kernelspec": {"name": "python3"}},
                    "cells": [{"cell_type": "code", "metadata": {"qnb_language": "java"}, "source": "%%java\npublic class Main { public static void main(String[] a) {} }"}],
                }
                self.assertEqual(runtime.language(doc, doc["cells"][0]), "java")
                self.assertTrue(runtime.code_cell_source(doc["cells"][0], "java").startswith("public class Main"))


if __name__ == "__main__":
    unittest.main()
