import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import store
from qnb.runtime import RequestError


class ProofTreeTests(unittest.TestCase):
    def test_bounded_traversal_keeps_shared_nodes_and_scopes_reads_by_account(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            store.initialize()
            with store.database() as db:
                db.executemany("INSERT INTO accounts (id, email, password, vm_id) VALUES (?, ?, 'hash', ?)", [
                    (1, "one@example.test", 10), (2, "two@example.test", 20),
                ])
                records = [
                    (1, "root", [{"id": "external:helper", "name": "Imported.helper"},
                                 {"id": "left", "name": "left"}, {"id": "right", "name": "right"}]),
                    (1, "left", [{"id": "shared", "name": "shared"}]),
                    (1, "right", [{"id": "shared", "name": "shared"}]),
                    (1, "shared", [{"id": "axiom:choice", "name": "Classical.choice", "kind": "axiom"}]),
                    (2, "private", []),
                ]
                db.executemany("""
                    INSERT INTO theorems (account_id, node_id, name, content_hash, source, path, dependencies)
                    VALUES (?, ?, ?, 'hash', 'source', '/proof.ipynb', ?)
                """, [(owner, key, key, json.dumps(deps)) for owner, key, deps in records])

            shallow = store.proof_tree(1, 0, "root", 100, 1)
            self.assertEqual([node["depth"] for node in shallow["nodes"]], [0, 1, 1, 1])
            self.assertEqual(shallow["limitedBy"], ["depth"])
            capped = store.proof_tree(1, 0, "root", 3, 1)
            self.assertEqual([node["id"] for node in capped["nodes"]], ["root", "left", "right"])
            self.assertEqual(capped["limitedBy"], ["depth", "nodes"])

            narrow = store.proof_tree(1, 0, "root", 1, 12)
            self.assertEqual([node["id"] for node in narrow["nodes"]], ["root"])
            self.assertEqual(narrow["edges"], [])
            self.assertEqual(narrow["limitedBy"], ["nodes"])

            full = store.proof_tree(1, 0, "root", 6, 3)
            self.assertEqual(len(full["nodes"]), 6)
            self.assertEqual(full["nodes"][-1]["kind"], "axiom")
            self.assertEqual([edge["from"] for edge in full["edges"] if edge["to"] == "shared"], ["left", "right"])
            self.assertEqual(full["limitedBy"], [])
            self.assertNotIn("private", {node["id"] for node in full["theorems"]})
            with self.assertRaises(RequestError) as error:
                store.proof_tree(1, 0, "private", 100, 12)
            self.assertEqual(error.exception.status, 404)
