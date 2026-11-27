import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(shutil.which("node"), "Node.js is required to test the .plot language")
class PlotLanguageTests(unittest.TestCase):
    def test_plot_language_checks(self):
        result = subprocess.run(["node", str(ROOT / "tests/js/plotlang.test.cjs")], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("all checks passed", result.stdout)

    def test_structure_detection_on_cpp_java_python_traces(self):
        result = subprocess.run(["node", str(ROOT / "tests/js/structviz.test.cjs")], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("all checks passed", result.stdout)
