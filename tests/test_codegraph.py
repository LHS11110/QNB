import base64
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import codegraph

HAS_FLASK = importlib.util.find_spec("flask") is not None

PYTHON = {
    "/py/pkg/__init__.py": "",
    "/py/pkg/util.py": (
        "LIMIT = 10\n"
        "counter = 0\n"
        "def helper(x):\n"
        "    return x + LIMIT\n"
        "def bump():\n"
        "    global counter\n"
        "    counter += 1\n"
        "class Base:\n"
        "    pass\n"
    ),
    "/py/main.py": (
        "from pkg.util import helper, LIMIT\n"
        "import pkg.util as u\n"
        "class Runner(u.Base):\n"
        "    rate = 2\n"
        "    def __init__(self):\n"
        "        self.total = 0\n"
        "    def run(self, n):\n"
        "        self.total = helper(n) * self.rate\n"
        "        u.bump()\n"
        "        return self.step()\n"
        "    def step(self):\n"
        "        LIMIT = 3\n"
        "        return LIMIT\n"
        "def main():\n"
        "    r = Runner()\n"
        "    r.run(3)\n"
    ),
}

CPP = {
    "/cpp/math.h": (
        "#pragma once\n#include <vector>\n"
        "namespace geo {\n"
        "extern int precision;\n"
        "struct Point { double x, y; double norm() const; };\n"
        "double dist(const Point& a, const Point& b);\n"
        "}\n"
    ),
    "/cpp/math.cpp": (
        "#include \"math.h\"\n#include <cmath>\n"
        "namespace geo {\n"
        "int precision = 3;\n"
        "double Point::norm() const { return std::sqrt(x*x + y*y); }\n"
        "double dist(const Point& a, const Point& b) {\n"
        "  Point d{a.x - b.x, a.y - b.y};\n"
        "  return d.norm();\n"
        "}\n"
        "}\n"
    ),
    "/cpp/main.cpp": (
        "#include \"math.h\"\n"
        "// dist() in a comment is ignored\n"
        "static int calls = 0;\n"
        "int main() {\n"
        "  geo::Point p{1, 2}, q{3, 4};\n"
        "  calls++;\n"
        "  geo::precision = 5;\n"
        "  const char* s = \"helper(\";\n"
        "  return (int)geo::dist(p, q);\n"
        "}\n"
    ),
}

JAVA = {
    "/java/com/ex/Shape.java": "package com.ex;\npublic interface Shape { double area(); }\n",
    "/java/com/ex/Circle.java": (
        "package com.ex;\n"
        "import java.util.List;\n"
        "public class Circle implements Shape {\n"
        "  public static final double PI = 3.14;\n"
        "  private double r;\n"
        "  public Circle(double r) { this.r = r; }\n"
        "  @Override public double area() { return PI * r * r; }\n"
        "}\n"
    ),
    "/java/com/app/App.java": (
        "package com.app;\n"
        "import com.ex.Circle;\n"
        "import com.ex.*;\n"
        "public class App {\n"
        "  static int count;\n"
        "  public static void main(String[] args) {\n"
        "    Shape s = new Circle(2.0);\n"
        "    count = count + 1;\n"
        "    System.out.println(s.area() + Circle.PI);\n"
        "    helper();\n"
        "  }\n"
        "  private static void helper() { for (int i = 0; i < 3; i++) { count += i; } }\n"
        "}\n"
    ),
}


def edges(graph):
    names = {node["id"]: (node["qualname"], node["path"]) for node in graph["nodes"]}
    return {(names[e["from"]][0], e["kind"], names[e["to"]][0]) for e in graph["edges"]}


class PythonGraphTests(unittest.TestCase):
    def setUp(self):
        self.graph = codegraph.analyze(PYTHON)
        self.edges = edges(self.graph)

    def test_nodes_cover_files_functions_classes_and_variables(self):
        kinds = {(node["kind"], node["qualname"]) for node in self.graph["nodes"]}
        for expected in [("file", "/py/main.py"), ("function", "helper"), ("function", "Runner.run"),
                         ("class", "Runner"), ("variable", "LIMIT"), ("variable", "Runner.total"),
                         ("variable", "Runner.rate")]:
            self.assertIn(expected, kinds)

    def test_imports_calls_reads_writes_and_inheritance(self):
        for expected in [
            ("/py/main.py", "imports", "/py/pkg/util.py"),
            ("Runner", "inherits", "Base"),
            ("Runner.run", "calls", "helper"),
            ("Runner.run", "calls", "bump"),
            ("Runner.run", "calls", "Runner.step"),
            ("Runner.run", "writes", "Runner.total"),
            ("Runner.run", "reads", "Runner.rate"),
            ("helper", "reads", "LIMIT"),
            ("bump", "writes", "counter"),
            ("main", "calls", "Runner"),
            ("main", "calls", "Runner.run"),
            ("/py/main.py", "contains", "Runner"),
            ("Runner", "contains", "Runner.run"),
        ]:
            self.assertIn(expected, self.edges)

    def test_local_variables_shadow_globals(self):
        self.assertNotIn(("Runner.step", "reads", "LIMIT"), self.edges)

    def test_syntax_errors_are_reported_without_failing(self):
        graph = codegraph.analyze({"/bad.py": "def broken(:\n", "/ok.py": "x = 1\n"})
        self.assertEqual(graph["errors"][0]["path"], "/bad.py")
        self.assertIn("/ok.py", {node["path"] for node in graph["nodes"]})


class CppGraphTests(unittest.TestCase):
    def setUp(self):
        self.graph = codegraph.analyze(CPP)
        self.edges = edges(self.graph)

    def test_header_declarations_merge_with_definitions(self):
        dist = [node for node in self.graph["nodes"] if node["qualname"] == "geo::dist"]
        self.assertEqual(len(dist), 1)
        self.assertEqual(dist[0]["path"], "/cpp/math.cpp")
        precision = [node for node in self.graph["nodes"] if node["qualname"] == "geo::precision"]
        self.assertEqual(len(precision), 1)
        self.assertIn(("/cpp/math.h", "declares", "geo::dist"), self.edges)

    def test_includes_calls_and_variable_access(self):
        for expected in [
            ("/cpp/main.cpp", "imports", "/cpp/math.h"),
            ("/cpp/math.cpp", "imports", "/cpp/math.h"),
            ("main", "calls", "geo::dist"),
            ("main", "writes", "calls"),
            ("main", "writes", "geo::precision"),
            ("geo::dist", "calls", "geo::Point::norm"),
            ("geo::Point::norm", "reads", "geo::Point::x"),
            ("geo::Point", "contains", "geo::Point::y"),
        ]:
            self.assertIn(expected, self.edges)

    def test_comments_and_strings_are_ignored(self):
        callers = {source for source, kind, target in self.edges if kind == "calls" and target == "geo::dist"}
        self.assertEqual(callers, {"main"})


class JavaGraphTests(unittest.TestCase):
    def setUp(self):
        self.graph = codegraph.analyze(JAVA)
        self.edges = edges(self.graph)

    def test_imports_and_inheritance(self):
        self.assertIn(("/java/com/app/App.java", "imports", "/java/com/ex/Circle.java"), self.edges)
        self.assertIn(("/java/com/app/App.java", "imports", "/java/com/ex/Shape.java"), self.edges)
        self.assertIn(("Circle", "inherits", "Shape"), self.edges)

    def test_methods_fields_and_constructors(self):
        for expected in [
            ("App.main", "calls", "Circle.Circle"),
            ("App.main", "calls", "App.helper"),
            ("App.main", "writes", "App.count"),
            ("App.main", "reads", "Circle.PI"),
            ("App.helper", "writes", "App.count"),
            ("Circle.Circle", "writes", "Circle.r"),
            ("Circle.area", "reads", "Circle.PI"),
        ]:
            self.assertIn(expected, self.edges)

    def test_loop_variables_are_local(self):
        self.assertFalse(any(target == "i" for _, _, target in self.edges))


class CollectTests(unittest.TestCase):
    def test_collect_walks_directories_and_skips_vendor_folders(self):
        tree = {
            "/": [["src", "directory"], ["node_modules", "directory"], ["README.md", "file"], ["a.py", "file"]],
            "/src": [["b.cpp", "file"], ["C.java", "file"], ["notes.txt", "file"]],
        }
        reads = []

        def read(path):
            reads.append(path)
            return "x = 1\n"
        files, skipped, truncated = codegraph.collect(
            lambda path, cursor: {"entries": tree[path], "cursor": None}, read, "/")
        self.assertEqual(set(files), {"/a.py", "/src/b.cpp", "/src/C.java"})
        self.assertEqual(skipped, [])
        self.assertFalse(truncated)

    def test_unreadable_files_are_skipped(self):
        def read(path):
            raise RuntimeError("binary")
        files, skipped, _ = codegraph.collect(
            lambda path, cursor: {"entries": [["a.py", "file"]], "cursor": None}, read, "/")
        self.assertEqual(files, {})
        self.assertEqual(skipped[0]["path"], "/a.py")


@unittest.skipUnless(HAS_FLASK, "Flask is required to test the code graph endpoint")
class CodeGraphEndpointTests(unittest.TestCase):
    def test_endpoint_reads_workspace_sources(self):
        from qnb import store
        from qnb.app import app

        def workspace(vm_id, operation, path, **fields):
            if operation == "list":
                return {"entries": [["main.py", "file"], ["pkg", "directory"]] if path == "/" else
                        [["__init__.py", "file"], ["util.py", "file"]], "cursor": None}
            if operation == "read":
                source = PYTHON["/py" + path]
                return {"content": base64.b64encode(source.encode()).decode(), "etag": "e", "fileId": "f"}
            raise AssertionError(operation)

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            store.initialize()
            client = app.test_client()
            self.assertEqual(client.post("/api/signup", json={
                "email": "coder@example.test", "password": "password123",
            }).status_code, 200)
            with patch("qnb.runtime.workspace", side_effect=workspace), \
                    patch("qnb.runtime.configure_disk", return_value=None):
                response = client.get("/api/code-graph?path=/")
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            data = response.get_json()
            self.assertEqual(data["fileCount"], 3)
            self.assertIn(("Runner.run", "calls", "helper"), edges(data))
            self.assertEqual(client.get("/api/code-graph?path=../etc").status_code, 400)


if __name__ == "__main__":
    unittest.main()
