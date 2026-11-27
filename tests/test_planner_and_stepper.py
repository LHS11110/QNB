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
#include <map>
using namespace std;
int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
int main() {
    vector<int> v = {3, 1};
    map<string, int> m{{"a", 1}};
    int total = 0;
    for (int x : v)
        total += x;
    switch (total) { case 4: { int z = 1; cout << z; break; } default: break; }
    if (total > 3) cout << "big\n"; else cout << "small\n";
    cout << fact(3) << endl;
    return 0;
}
'''

JAVA_SAMPLE = r'''import java.util.*;
public class Main {
    Main(int a) { this(a, 0); }
    Main(int a, int b) { int c = a + b; }
    static int twice(int n) { return n * 2; }
    public static void main(String[] args) throws Exception {
        int[] arr = {1, 2};
        int total;
        total = 0;
        for (int x : arr) total += twice(x);
        List<Integer> xs = new ArrayList<>();
        xs.forEach(v -> System.out.println(v));
        switch (total) { case 6: String s = "six"; System.out.println(s); break; default: break; }
        try { int q = arr[3]; } catch (Exception e) { System.out.println("e"); } finally { total++; }
    }
}
'''


class StepperTests(unittest.TestCase):
    def test_cpp_instrumentation_keeps_lines_and_scopes(self):
        out, inst = stepper.instrument(CPP_SAMPLE, "cpp")
        self.assertEqual(out.count("\n"), CPP_SAMPLE.count("\n"))
        self.assertEqual(inst.functions, 2)
        lines = out.splitlines()
        # braceless loop body is wrapped and sees the range-for variable
        self.assertIn("{ __QNB_STEP(14, __QNB_V(v), __QNB_V(m), __QNB_V(total), __QNB_V(x)); total += x; }", lines[13])
        # declarations after a case label are not visible in the next label
        self.assertIn("default: __QNB_STEP(15, __QNB_V(v), __QNB_V(m), __QNB_V(total)); break;", lines[14])
        self.assertIn('__qnb::Frame __qnb_frame("fact", 5);', lines[4])

    def test_java_instrumentation_respects_definite_assignment(self):
        out, inst = stepper.instrument(JAVA_SAMPLE, "java")
        self.assertEqual(out.count("\n"), JAVA_SAMPLE.count("\n"))
        lines = out.splitlines()
        self.assertIn("{ this(a, 0); __QnbT.enter(\"Main.Main\", 3); try {", lines[2])
        self.assertNotIn('"total", total', lines[8])  # declared without initializer
        self.assertIn('__QnbT.step(12, "args", args, "arr", arr, "xs", xs); xs.forEach(v -> System.out.println(v));', lines[11])
        self.assertIn('"e", e', lines[13])
        self.assertIn("} finally { __QnbT.exit(); } }", lines[14])

    @unittest.skipUnless(HAS_GPP, "g++ is required")
    def test_cpp_trace_end_to_end(self):
        def fake_vm(vm_id, payload):
            done = subprocess.run(["python3", "-c", payload["code"]], capture_output=True, text=True, timeout=120)
            return {"exitCode": done.returncode, "output": done.stdout + done.stderr}

        with patch.object(runtime, "vm", fake_vm):
            result = stepper.trace(1, "/demo/main.cpp", CPP_SAMPLE, "cpp")
        viz = result["visualization"]
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["outputs"][0]["text"], "1big\n6\n")
        self.assertEqual(viz["kind"], "cpp")
        calls = [s["func"] for s in viz["steps"] if s["event"] == "call"]
        self.assertEqual(calls, ["main", "fact", "fact", "fact"])
        deepest = max(viz["steps"], key=lambda s: len(s["stack"]))
        self.assertEqual([f["func"] for f in deepest["stack"]], ["main", "fact", "fact", "fact"])
        line14 = next(s for s in viz["steps"] if s["line"] == 14)
        vectors = [e for e in line14["heap"].values() if e.get("items") is not None and e["length"] == 2]
        maps = [e for e in line14["heap"].values() if e.get("fields") == [["a", {"kind": "prim", "type": "int", "value": 1}]]]
        self.assertTrue(vectors and maps, line14["heap"])
        self.assertEqual(line14["stack"][-1]["locals"]["total"], {"kind": "prim", "type": "int", "value": 0})
        last = viz["steps"][-1]
        self.assertEqual(last["stdout"], "1big\n6\n")

        with patch.object(runtime, "vm", fake_vm):
            broken = stepper.trace(1, "/demo/main.cpp", "int main() { return x; }\n", "cpp")
        self.assertNotEqual(broken["exitCode"], 0)
        self.assertIn("main.cpp", broken["outputs"][-1]["text"])
        self.assertRegex(broken["outputs"][-1]["text"], r"main\.cpp:1:\d+: error: .x. was not declared")

    def test_build_result_maps_stdout_offsets(self):
        trace = [{"event": "line", "line": 1, "func": "main", "stack": [{"func": "main", "line": 1, "locals": {}}], "heap": {}, "out": 0},
                 {"event": "line", "line": 2, "func": "main", "stack": [{"func": "main", "line": 2, "locals": {}}], "heap": {}, "out": 3}]
        result = stepper.build_result({"exitCode": 0, "stdout": "hi\nmore", "trace": trace}, "a\nb\n", "/x.cpp", "cpp")
        self.assertEqual([s["stdout"] for s in result["visualization"]["steps"]], ["", "hi\n"])
        self.assertEqual(json.loads(json.dumps(result))["visualization"]["steps"][1]["code"], "b")


if __name__ == "__main__":
    unittest.main()
