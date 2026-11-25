import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb.runtime import RequestError, check_lean, digest, lean_cell_source, missing_names, proof_records
from qnb.runtime import lean_ready_until
from qnb import store
from qnb.store import archive_entry

HAS_FLASK = importlib.util.find_spec("flask") is not None

LEAN = os.environ.get("QNB_TEST_LEAN")
INSPECTOR = Path(__file__).resolve().parents[1] / "qnb" / "Inspect.lean"


class ProofRecordsTests(unittest.TestCase):
    def test_recently_ready_vm_skips_probe_until_readiness_expires(self):
        readiness = {"ok": True, "diagnostics": [], "declarations": [], "definitions": [],
                     "recovered": [], "rejected": []}

        def report(marker):
            return {"exitCode": 0, "output": f"\n{marker}\n" + json.dumps(readiness)}

        with patch.dict(lean_ready_until, clear=True), patch("qnb.runtime.vm", side_effect=[
            report("first-ready"), report("first"), report("second"),
            report("expired-ready"), report("expired"),
        ]) as vm:
            for marker in ("first", "second"):
                self.assertEqual(check_lean(1, "/proof.ipynb", "", 0, marker, lambda _: None)[0], 0)
            self.assertEqual(vm.call_count, 3)
            lean_ready_until[1] = 0
            self.assertEqual(check_lean(1, "/proof.ipynb", "", 0, "expired", lambda _: None)[0], 0)
            self.assertEqual(vm.call_count, 5)

    def test_vm_warmup_has_separate_retries_from_a_started_lean_cell(self):
        warmup_timeout = {"exitCode": 1, "timedOut": True, "output": "run-ready-started\n"}
        ready = {"exitCode": 0, "output": 'run-ready-started\n\nrun-ready\n{"ok":true,"diagnostics":[]}'}
        proof_timeout = {"exitCode": 1, "timedOut": True, "output": "run-started\n"}
        code = "theorem userProof : True := True.intro"
        with patch("qnb.runtime.vm", side_effect=[warmup_timeout, ready, proof_timeout]) as vm:
            result = check_lean(1, "/test.ipynb", code, 0, "run", lambda _: None)
        self.assertEqual(result[:2], (1, "Lean 검사 시간 제한을 초과했습니다."))
        self.assertEqual(vm.call_count, 3)
        probe, retry, execution = [call.args[1]["code"] for call in vm.call_args_list]
        self.assertEqual(probe, retry)
        self.assertNotEqual(probe, execution)

        with patch("qnb.runtime.vm", return_value=warmup_timeout) as vm:
            with self.assertRaisesRegex(RequestError, "실행 환경 준비 시간이 초과"):
                check_lean(1, "/test.ipynb", code, 0, "run", lambda _: None)
        self.assertEqual(vm.call_count, 3)

    def test_only_the_selected_cell_is_used_and_magic_keeps_its_line(self):
        def cell(code, lang=None):
            return {"cell_type": "code", "source": code,
                    "metadata": {"qnb_language": lang} if lang else {}}

        doc = {"cells": [cell("%%lean4 intro\ndef n := 1"), cell(["n = 3"], "python"),
                         cell("theorem t : n = n := rfl", "lean4"), cell("unfinished", "lean4")]}
        self.assertEqual(lean_cell_source(doc["cells"][2]), "theorem t : n = n := rfl")
        self.assertEqual(lean_cell_source(doc["cells"][0]), "\ndef n := 1")

    def test_hash_uses_exact_declaration_and_edge_tracks_dependency_revision(self):
        source = "  theorem α : True := True.intro\ntheorem β : True := α\n"
        rows = [
            {"name": "β", "startLine": 2, "startColumn": 0, "endLine": 2,
             "endColumn": len(source.splitlines()[1]), "dependencies": ["α"]},
            {"name": "α", "startLine": 1, "startColumn": 2, "endLine": 1,
             "endColumn": len(source.splitlines()[0]), "dependencies": []},
        ]
        first, second = proof_records(source, rows)
        self.assertEqual(first["hash"], digest("theorem α : True := True.intro"))
        self.assertEqual(second["dependencies"], [{"name": "α", "id": first["id"]}])
        revised, downstream = proof_records(source.replace("True.intro", "by trivial"), rows)
        self.assertNotEqual(first["hash"], revised["hash"])
        self.assertEqual(second["hash"], downstream["hash"])
        self.assertNotEqual(second["id"], downstream["id"])

    def test_missing_name_requires_an_error_from_lean(self):
        pos = {"line": 3, "column": 4}
        diagnostics = [
            {"severity": "error", "data": "unknown identifier 'Stored.actual'", "pos": pos},
            {"severity": "error", "data": "function expected at\n  helper\nterm has type\n  ?m.9", "pos": pos},
            {"severity": "error", "data": "invalid field 'value', the environment does not contain 'Widget.value'\n  widget",
             "pos": pos},
            {"severity": "warning", "data": "unknown identifier 'ignored'", "pos": pos},
        ]
        self.assertEqual(missing_names(diagnostics), {"Stored.actual": 3, "helper": 3, "Widget.value": 3})

    def inspect(self, source, archives=()):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            input_file, output, stored = (folder / name for name in ("Notebook.lean", "report.json", "saved.json"))
            input_file.write_text(source, encoding="utf-8")
            stored.write_text(json.dumps(archives), encoding="utf-8")
            subprocess.run([LEAN, "--run", str(INSPECTOR), str(input_file), str(output), str(stored)],
                           capture_output=True, check=True, timeout=20)
            return json.loads(output.read_text())

    @unittest.skipUnless(LEAN, "set QNB_TEST_LEAN to the Lean 4.10 guest binary")
    def test_recovery_loads_proof_and_reuses_local_dependencies(self):
        saved = """namespace Stored
def next (n : Nat) := n + 1
theorem zero : next 0 = 1 := rfl
end Stored
"""
        current = """namespace Stored
def next (n : Nat) := n + 1
end Stored
theorem recovered : Stored.next 0 = 1 := Stored.zero
"""
        entry = archive_entry("Stored.zero", saved, [])
        entry["entry"]["line"] = 4
        first = self.inspect(current)
        self.assertEqual(missing_names(first["diagnostics"]), {"Stored.zero": 4})
        report = self.inspect(current, [entry])
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["recovered"], [{"root": "Stored.zero", "names": ["Stored.zero"]}])
        records = proof_records(current, report["declarations"], {"Stored.zero": "saved-id"})
        self.assertEqual(records[0]["dependencies"], [{"name": "Stored.zero", "id": "saved-id"}])
        self.assertEqual([row["name"] for row in report["definitions"]], ["Stored.next"])

    @unittest.skipUnless(LEAN, "set QNB_TEST_LEAN to the Lean 4.10 guest binary")
    def test_restored_proof_keeps_proof_only_section_binders(self):
        source = """section
variable (h : False)
theorem stored : False := h
end
"""
        entry = archive_entry("stored", source, [])
        result = self.inspect("theorem valid (h : False) : False := stored h\n#print axioms valid", [entry])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["declarations"][0]["dependencies"], ["stored"])
        self.assertIn("does not depend on any axioms", result["diagnostics"][0]["data"])
        self.assertFalse(self.inspect("theorem invalid : False := stored", [entry])["ok"])
        malicious = self.inspect("axiom fake : False\ntheorem fakeProof : False := fake")
        self.assertEqual(malicious["rejected"], ["fakeProof"])

    @unittest.skipUnless(LEAN, "set QNB_TEST_LEAN to the Lean 4.10 guest binary")
    def test_database_replays_legacy_nested_proofs_and_missing_names_are_lean_errors(self):
        premise = "def cellDouble (n : Nat) := n + n\ntheorem cellProven (n : Nat) : cellDouble n = n + n := rfl"
        conclusion = ("theorem cellResult (n : Nat) : cellDouble n = n + n ∧ True := "
                      "⟨cellProven n, True.intro⟩")
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(folder) / "qnb.sqlite3"),
        }):
            store.initialize()
            with store.database() as db:
                db.execute("INSERT INTO accounts VALUES (1, 'test@example.com', 'hash', 1)")
            initial = self.inspect(premise)
            proofs = proof_records(premise, initial["declarations"])
            definitions = proof_records(premise, initial["definitions"])
            store.save_declarations(1, "/one.ipynb", proofs, definitions, premise, [], {})
            entries = [store.lookup_declaration(1, name)[0] for name in ("cellDouble", "cellProven")]
            self.assertEqual(set(missing_names(self.inspect(conclusion)["diagnostics"])), {"cellDouble", "cellProven"})
            report = self.inspect(conclusion, entries)
            self.assertTrue(report["ok"], report)
            legacy = archive_entry("cellProven", premise, [])
            typed = [{"span": row["span"], "statement": row["statement"]} for row in proofs]
            legacy["entry"]["source"] = store.masked_archive_source(premise, typed)
            legacy["entry"]["statements"] = [item["statement"] for item in typed]
            store.save_declarations(1, "/two.ipynb", proof_records(conclusion, report["declarations"]),
                                    [], conclusion, [legacy], {})
            recovered, _ = store.lookup_declaration(1, "cellResult")
            self.assertIn(":= rfl", recovered["entry"]["prerequisites"][0]["entry"]["source"])
            final = self.inspect("#print axioms cellResult", [recovered])
            self.assertTrue(final["ok"], final)
            self.assertIn("does not depend on any axioms", final["diagnostics"][0]["data"])
            unknown = self.inspect("theorem typo : qnbUnknownName := by trivial")
            self.assertFalse(unknown["ok"])
            self.assertIn("qnbUnknownName", missing_names(unknown["diagnostics"]))

    @unittest.skipUnless(LEAN, "set QNB_TEST_LEAN to the Lean 4.10 guest binary")
    def test_storage_deduplicates_notation_and_binder_names_and_preserves_aliases(self):
        source = """universe u v
theorem original {α : Type u} (x : α) : x = x := rfl
theorem alternate {β : Type v} (y : β) : Eq y y := rfl
theorem other (n : Nat) : n = n ∧ True := ⟨alternate n, True.intro⟩
"""
        report = self.inspect(source)
        rows = proof_records(source, report["declarations"])
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(folder) / "qnb.sqlite3"),
        }):
            store.initialize()
            with store.database() as db:
                db.execute("INSERT INTO accounts VALUES (1, 'test@example.com', 'hash', 1)")
            original, other = store.save_declarations(1, "/one.ipynb", rows, [], source, [], {})
            self.assertEqual(original["name"], "original")
            self.assertEqual(other["name"], "other")
            self.assertEqual(other["dependencies"], [{"id": original["id"], "name": "original"}])
            entry, bindings = store.lookup_declaration(1, "alternate")
            self.assertEqual(bindings["alternate"], original["id"])
            self.assertTrue(self.inspect(
                "theorem reuse (n : Nat) : n = n := alternate n", [entry]
            )["ok"])
            with store.database() as db:
                db.execute("DROP TABLE theorem_statements")
            store.initialize()
            second_source = """universe w
theorem quantified : ∀ {T : Type w} (t : T), t = t := fun _ => rfl
"""
            second = proof_records(second_source, self.inspect(second_source)["declarations"])
            self.assertEqual(store.save_declarations(1, "/two.ipynb", second, [], second_source, [], {}), [])
            self.assertEqual(store.lookup_declaration(1, "quantified")[1]["quantified"], original["id"])
            with store.database() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM theorems").fetchone()[0], 2)

    @unittest.skipUnless(LEAN, "set QNB_TEST_LEAN to the Lean 4.10 guest binary")
    def test_lean_environment_excludes_admitted_and_untrusted_proofs(self):
        code = """theorem first : 2 = 2 := by rfl
theorem δεύτερο : 2 = 2 := first
theorem equivalentTrue (p : Prop) (h : p ↔ True) : p = True := propext h
theorem equivalentTrueAgain (p : Prop) (h : p ↔ True) : p = True := equivalentTrue p h
theorem admitted : False := by sorry
theorem indirect : False := admitted
axiom unchecked : False
theorem assumed : False := unchecked
"""
        report = self.inspect(code)
        accepted = {row["name"]: row for row in proof_records(code, report["declarations"])}
        self.assertEqual(set(accepted), {"first", "δεύτερο", "equivalentTrue", "equivalentTrueAgain"})
        self.assertEqual(accepted["δεύτερο"]["dependencies"][0]["id"], accepted["first"]["id"])
        axiom = {"id": "axiom:" + digest("propext"), "name": "propext", "kind": "axiom"}
        self.assertEqual(accepted["equivalentTrue"]["dependencies"], [axiom])
        self.assertEqual(accepted["equivalentTrueAgain"]["dependencies"], [
            {"id": accepted["equivalentTrue"]["id"], "name": "equivalentTrue"}, axiom,
        ])
        self.assertEqual(set(report["rejected"]), {"admitted", "indirect", "assumed"})

    @unittest.skipUnless(HAS_FLASK, "Flask is required to test kernel_operation")
    def test_inline_kernel_run_skips_notebook_read_and_preserves_db_lookup_and_save(self):
        from flask import g
        from qnb.app import app, kernel_operation

        rows = [{"name": "derived", "source": "theorem derived : True := base", "hash": "h1",
                 "line": 1, "dependencies": [{"id": "base-id", "name": "base"}], "statement": None}]
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(folder) / "qnb.sqlite3"),
        }):
            store.initialize()
            with app.test_request_context("/api/kernel", method="POST"):
                g.account = {"id": 7, "vm_id": 1900000001}
                g.workspace = {"owner_id": 7, "owner_email": "owner@example.test", "vm_id": 1900000001, "shared": False}
                with patch("qnb.runtime.configure_disk") as cfg, \
                        patch("qnb.runtime.notebook", side_effect=AssertionError("should not reread notebook")), \
                        patch("qnb.runtime.check_lean", return_value=(0, "", rows, ["derived"], [], [], {})) as check, \
                        patch("qnb.store.lookup_declaration", return_value=None) as lookup, \
                        patch("qnb.store.save_declarations", return_value=[{"name": "derived"}]) as save:
                    result = kernel_operation({
                        "operation": "run",
                        "path": "/fast.ipynb",
                        "language": "lean4",
                        "code": "theorem derived : True := base",
                    })
                    check_lookup = check.call_args.args[5]
                    check_lookup("base")
            cfg.assert_called_once_with(1900000001)
            lookup.assert_called_once_with(7, "base")
            save.assert_called_once()
            self.assertEqual(result["exitCode"], 0)
            self.assertEqual(result["saved"], ["derived"])
            self.assertTrue(result["graphPending"])


if __name__ == "__main__":
    unittest.main()
