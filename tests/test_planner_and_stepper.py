import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import planner, runtime, stepper, store
from qnb.runtime import RequestError

HAS_GPP = shutil.which("g++") is not None


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


if __name__ == "__main__":
    unittest.main()
