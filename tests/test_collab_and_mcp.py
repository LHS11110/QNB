import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import collab, mcp_server, runtime, store

HAS_FLASK = importlib.util.find_spec("flask") is not None


class FakeVMFilesystem:
    """In-memory mock of a VM /workspace filesystem enforcing fileId/etag semantics."""

    def __init__(self, initial_files=None):
        self.files = {}  # path -> {"text": str, "fileId": str, "etag": str, "resourceId": str}
        self.dirs = {"/"}
        self.seq = 0
        for p, text in (initial_files or {}).items():
            self._set_file(p, text)

    def _set_file(self, path, text, *, file_id=None):
        self.seq += 1
        fid = file_id or f"fid-{self.seq}"
        etag = runtime.digest(text)
        rid = f"dev:ino:{self.seq}"
        self.files[path] = {"text": text, "fileId": fid, "etag": etag, "resourceId": rid}
        parent = path.rsplit("/", 1)[0] or "/"
        while parent and parent != "/":
            self.dirs.add(parent)
            parent = parent.rsplit("/", 1)[0] or "/"

    def workspace(self, vm_id, operation, file_path, **fields):
        if operation == "stat":
            if file_path in self.files:
                return {"type": "file", "size": len(self.files[file_path]["text"].encode()), "resourceId": self.files[file_path]["resourceId"]}
            if file_path in self.dirs:
                return {"type": "directory", "size": 0, "resourceId": f"dir:{file_path}"}
            raise runtime.RequestError("VM에서 파일을 찾을 수 없습니다.", 404)

        if operation == "list":
            if file_path not in self.dirs:
                raise runtime.RequestError("폴더를 찾을 수 없습니다.", 404)
            prefix = "" if file_path == "/" else file_path
            depth = len([p for p in file_path.split("/") if p])
            out = []
            for d in sorted(self.dirs):
                if d == "/":
                    continue
                parts = [p for p in d.split("/") if p]
                if len(parts) == depth + 1 and (file_path == "/" or d.startswith(prefix + "/")):
                    out.append([parts[-1], "directory"])
            for p in sorted(self.files):
                parts = [x for x in p.split("/") if x]
                if len(parts) == depth + 1 and (file_path == "/" or p.startswith(prefix + "/")):
                    out.append([parts[-1], "file"])
            return {"entries": out, "cursor": None}

        if operation == "read":
            if file_path not in self.files:
                raise runtime.RequestError("VM에서 파일을 찾을 수 없습니다.", 404)
            f = self.files[file_path]
            return {"fileId": f["fileId"], "etag": f["etag"], "resourceId": f["resourceId"], "content": runtime.b64(f["text"].encode())}

        if operation == "mkdir":
            self.dirs.add(file_path)
            return {"path": file_path, "operation": "mkdir"}

        if operation == "write":
            import base64
            text = base64.b64decode(fields["content"]).decode("utf-8")
            if fields.get("create"):
                if file_path in self.files:
                    raise runtime.RequestError("같은 이름의 파일이 있습니다.", 409)
                self._set_file(file_path, text)
            else:
                if file_path not in self.files:
                    raise runtime.RequestError("VM에서 파일을 찾을 수 없습니다.", 404)
                cur = self.files[file_path]
                if fields.get("etag") != cur["etag"] or fields.get("fileId") != cur["fileId"]:
                    raise runtime.RequestError("충돌", 409)
                self._set_file(file_path, text, file_id=cur["fileId"])
            f = self.files[file_path]
            return {"fileId": f["fileId"], "etag": f["etag"], "resourceId": f["resourceId"]}

        if operation == "rename":
            target = fields["target"]
            if file_path in self.files:
                self.files[target] = self.files.pop(file_path)
                return {"path": file_path, "target": target}
            if file_path in self.dirs:
                self.dirs.discard(file_path)
                self.dirs.add(target)
                prefix = file_path + "/"
                for p in list(self.files):
                    if p.startswith(prefix):
                        self.files[target + p[len(file_path):]] = self.files.pop(p)
                return {"path": file_path, "target": target}
            raise runtime.RequestError("VM에서 파일을 찾을 수 없습니다.", 404)

        if operation == "delete":
            if file_path in self.files:
                self.files.pop(file_path)
                return {"path": file_path}
            if file_path in self.dirs:
                prefix = file_path + "/"
                children = [p for p in self.files if p.startswith(prefix)]
                if children and not fields.get("recursive"):
                    raise runtime.RequestError("비어 있는 폴더만 삭제할 수 있습니다.", 409)
                for p in children:
                    self.files.pop(p, None)
                self.dirs.discard(file_path)
                return {"path": file_path}
            raise runtime.RequestError("VM에서 파일을 찾을 수 없습니다.", 404)

        raise AssertionError(f"Unexpected op: {operation}")


class CollabStagingAndMcpTests(unittest.TestCase):
    def setUp(self):
        collab.staging.reset_for_tests()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.env_patch = patch.dict(os.environ, {"QNB_DATABASE": str(Path(self.tmpdir.name) / "qnb.sqlite3")})
        self.env_patch.start()
        store.initialize()
        with store.database() as db:
            db.execute("INSERT INTO accounts (id, email, password, vm_id) VALUES (1, 'alice@example.test', 'pw', 1900000000)")
            db.execute("INSERT INTO accounts (id, email, password, vm_id) VALUES (2, 'bob@example.test', 'pw', 1900000001)")
        self.workspace = {"owner_id": 1, "owner_email": "alice@example.test", "vm_id": 1900000000, "shared": False}
        self.alice = {"accountId": 1, "email": "alice@example.test", "nickname": "alice", "kind": "browser"}
        self.bob = {"accountId": 2, "email": "bob@example.test", "nickname": "bob", "kind": "browser"}

    def tearDown(self):
        collab.staging.reset_for_tests()
        self.env_patch.stop()
        self.tmpdir.cleanup()

    def test_concurrent_automerge_staging_explicit_save_and_zero_user_unstage(self):
        fs = FakeVMFilesystem({"/Proof.lean": "line1\nline2\nline3\n"})
        with patch("qnb.runtime.workspace", side_effect=fs.workspace):
            q_a, _ = collab.staging.register_client(1, "ws-a", self.alice)
            q_b, _ = collab.staging.register_client(1, "ws-b", self.bob)

            open_a = collab.staging.open_file(self.workspace, "/Proof.lean", "ws-a", self.alice)
            open_b = collab.staging.open_file(self.workspace, "/Proof.lean", "ws-b", self.bob)
            self.assertEqual(open_a["activeCount"], 1)
            self.assertEqual(open_b["activeCount"], 2)

            # Both Alice and Bob fork changes independently from the initial Automerge state
            chg_a = collab.staging.bridge.update_text(open_a["docBase64"], open_a["fileId"], "line1-alice\nline2\nline3\n")["changesBase64"]
            chg_b = collab.staging.bridge.update_text(open_b["docBase64"], open_b["fileId"], "line1\nline2\nline3-bob\n")["changesBase64"]

            collab.staging.edit_file(self.workspace, "/Proof.lean", "ws-a", self.alice, changes_b64=chg_a)
            res_b = collab.staging.edit_file(self.workspace, "/Proof.lean", "ws-b", self.bob, changes_b64=chg_b)

            # Merged cleanly in Automerge staging buffer WITHOUT modifying VM filesystem
            self.assertEqual(res_b["text"], "line1-alice\nline2\nline3-bob\n")
            self.assertTrue(res_b["dirty"])
            self.assertEqual(fs.files["/Proof.lean"]["text"], "line1\nline2\nline3\n")

            # Verify broadcast events hit connected queues
            events_a = []
            while not q_a.empty():
                events_a.append(q_a.get_nowait())
            self.assertTrue(any(ev.get("type") == "stage_patch" and ev.get("text") == "line1-alice\nline2\nline3-bob\n" for ev in events_a))

            # Explicit save flushes to VM filesystem
            saved = collab.staging.save_file(self.workspace, "/Proof.lean", self.alice)
            self.assertFalse(saved["dirty"])
            self.assertTrue(saved["staged"])
            self.assertEqual(fs.files["/Proof.lean"]["text"], "line1-alice\nline2\nline3-bob\n")

            # Further edits after explicit save stay staged only in memory/DB
            res_b2 = collab.staging.edit_file(self.workspace, "/Proof.lean", "ws-b", self.bob, new_text="line1-alice\nline2-edited\nline3-bob\n")
            self.assertTrue(res_b2["dirty"])
            self.assertEqual(fs.files["/Proof.lean"]["text"], "line1-alice\nline2\nline3-bob\n")

            # Alice closes -> Bob still active (1 user) -> stays staged, NOT yet saved to disk
            close_a = collab.staging.close_file(self.workspace, "/Proof.lean", "ws-a", self.alice)
            self.assertEqual(close_a["activeCount"], 1)
            self.assertFalse(close_a["unstaged"])
            self.assertEqual(fs.files["/Proof.lean"]["text"], "line1-alice\nline2\nline3-bob\n")

            # Bob disconnects/closes -> 0 active users -> auto-save to VM filesystem and unstage!
            close_b = collab.staging.close_file(self.workspace, "/Proof.lean", "ws-b", self.bob)
            self.assertEqual(close_b["activeCount"], 0)
            self.assertTrue(close_b["autoSaved"])
            self.assertTrue(close_b["unstaged"])
            self.assertEqual(fs.files["/Proof.lean"]["text"], "line1-alice\nline2-edited\nline3-bob\n")
            self.assertEqual(collab.staging.list_staged(1)["stagedFiles"], [])

            # Check Bob's queue still clean / events consistent
            self.assertIsNotNone(q_b)

    def test_fs_mutations_broadcast_and_migrate_staged_files(self):
        fs = FakeVMFilesystem({"/dir/app.py": "print(1)\n"})
        with patch("qnb.runtime.workspace", side_effect=fs.workspace):
            q_a, _ = collab.staging.register_client(1, "ws-a", self.alice)
            collab.staging.open_file(self.workspace, "/dir/app.py", "ws-a", self.alice)
            collab.staging.edit_file(self.workspace, "/dir/app.py", "ws-a", self.alice, new_text="print(99)\n")

            # Rename folder moves staged path cleanly and broadcasts fs_event
            collab.staging.mutate_fs(self.workspace, self.alice, "mkdir", "/newdir")
            collab.staging.mutate_fs(self.workspace, self.alice, "rename", "/dir/app.py", target="/newdir/main.py")
            staged_paths = [s["path"] for s in collab.staging.list_staged(1)["stagedFiles"]]
            self.assertEqual(staged_paths, ["/newdir/main.py"])

            # Recursive delete removes folder and evicts staged entry + broadcasts
            collab.staging.mutate_fs(self.workspace, self.alice, "delete", "/newdir", recursive=True)
            self.assertEqual(collab.staging.list_staged(1)["stagedFiles"], [])
            self.assertNotIn("/newdir/main.py", fs.files)

            events = []
            while not q_a.empty():
                events.append(q_a.get_nowait()["type"])
            self.assertEqual(events.count("fs_event"), 3)

    @unittest.skipUnless(HAS_FLASK, "Flask required for HTTP /api/mcp and token tests")
    def test_mcp_server_live_coedit_and_zero_user_auto_save_unstage(self):
        from qnb.app import app

        fs = FakeVMFilesystem({"/demo.lean": "theorem t : True := by\n  sorry\n"})
        with patch("qnb.runtime.workspace", side_effect=fs.workspace):
            client = app.test_client()
            with store.database() as db:
                acc = db.execute("SELECT * FROM accounts WHERE id = 1").fetchone()
            tok = store.create_mcp_token(acc["id"], "CLI Test")["token"]
            headers = {"Authorization": f"Bearer {tok}", "X-QNB-MCP-Session": "mcp-cli-1"}

            # 1) Browser user Alice has /demo.lean open -> MCP edits via Automerge and stays staged
            q_a, _ = collab.staging.register_client(1, "ws-a", self.alice)
            collab.staging.open_file(self.workspace, "/demo.lean", "ws-a", self.alice)

            rpc_edit = client.post("/api/mcp", headers=headers, json={
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {
                    "name": "qnb_edit_staged_file",
                    "arguments": {"path": "/demo.lean", "old_text": "sorry", "new_text": "trivial"},
                },
            })
            self.assertEqual(rpc_edit.status_code, 200)
            payload = json.loads(rpc_edit.get_json()["result"]["content"][0]["text"])
            self.assertEqual(payload["text"], "theorem t : True := by\n  trivial\n")
            self.assertTrue(payload["dirty"])
            self.assertFalse(payload["unstaged"])
            # Disk unchanged while Alice has it open
            self.assertEqual(fs.files["/demo.lean"]["text"], "theorem t : True := by\n  sorry\n")

            # Alice closes tab -> 0 users -> auto-saves MCP's edit to disk & unstages
            collab.staging.unregister_client(1, "ws-a")
            self.assertEqual(fs.files["/demo.lean"]["text"], "theorem t : True := by\n  trivial\n")
            self.assertEqual(collab.staging.list_staged(1)["stagedFiles"], [])

            # 2) With 0 active users on /demo.lean, MCP edit auto-saves and unstages immediately!
            rpc_edit2 = client.post("/api/mcp", headers=headers, json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "qnb_edit_staged_file",
                    "arguments": {"path": "/demo.lean", "old_text": "trivial", "new_text": "exact True.intro"},
                },
            })
            self.assertEqual(rpc_edit2.status_code, 200)
            payload2 = json.loads(rpc_edit2.get_json()["result"]["content"][0]["text"])
            self.assertTrue(payload2["autoSaved"])
            self.assertTrue(payload2["unstaged"])
            self.assertEqual(fs.files["/demo.lean"]["text"], "theorem t : True := by\n  exact True.intro\n")
            self.assertEqual(collab.staging.list_staged(1)["stagedFiles"], [])
            self.assertIsNotNone(q_a)

    @unittest.skipUnless(HAS_FLASK, "Flask required for HTTP /mcp and SSE tests")
    def test_always_on_streamable_http_and_sse_mcp_endpoints(self):
        import time as _time
        from qnb import mcp_server
        from qnb.app import app

        fs = FakeVMFilesystem({"/AlwaysOn.lean": "def x := 1\n"})
        with patch("qnb.runtime.workspace", side_effect=fs.workspace):
            client = app.test_client()
            health = client.get("/mcp/health")
            self.assertEqual(health.status_code, 200)
            hjson = health.get_json()
            self.assertTrue(hjson["ok"])
            self.assertEqual(hjson["mode"], "always-on")
            self.assertIn("streamable-http", hjson["transports"])

            unauth = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
            self.assertEqual(unauth.status_code, 401)
            self.assertIn("Bearer", unauth.headers.get("WWW-Authenticate", ""))

            with store.database() as db:
                acc = db.execute("SELECT * FROM accounts WHERE id = 1").fetchone()
            tok = store.create_mcp_token(acc["id"], "AlwaysOn CLI")["token"]
            auth_headers = {"Authorization": f"Bearer {tok}"}

            # 1) Streamable HTTP initialize + notification + keep_staged edit + DELETE release -> 0-user auto-save
            init_resp = client.post(
                "/mcp",
                headers=auth_headers,
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}},
            )
            self.assertEqual(init_resp.status_code, 200)
            sid = init_resp.headers.get("Mcp-Session-Id")
            self.assertTrue(sid)
            self.assertEqual(init_resp.get_json()["result"]["protocolVersion"], "2025-03-26")

            notif_resp = client.post(
                "/mcp",
                headers={**auth_headers, "Mcp-Session-Id": sid},
                json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            )
            self.assertEqual(notif_resp.status_code, 202)

            edit_resp = client.post(
                "/mcp",
                headers={**auth_headers, "Mcp-Session-Id": sid},
                json={
                    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {
                        "name": "qnb_edit_staged_file",
                        "arguments": {"path": "/AlwaysOn.lean", "old_text": "1", "new_text": "77", "keep_staged": True},
                    },
                },
            )
            self.assertEqual(edit_resp.status_code, 200)
            p1 = json.loads(edit_resp.get_json()["result"]["content"][0]["text"])
            self.assertTrue(p1["dirty"])
            self.assertFalse(p1["unstaged"])
            self.assertEqual(fs.files["/AlwaysOn.lean"]["text"], "def x := 1\n")

            del_resp = client.delete("/mcp", headers={**auth_headers, "Mcp-Session-Id": sid})
            self.assertEqual(del_resp.status_code, 200)
            self.assertTrue(del_resp.get_json()["released"])
            self.assertEqual(fs.files["/AlwaysOn.lean"]["text"], "def x := 77\n")
            self.assertEqual(collab.staging.list_staged(1)["stagedFiles"], [])

            # 2) Abandoned keep_staged session is reaped by hub.reap_expired -> 0-user auto-save & unstage
            idle_sid = "mcp-idle-reap-test"
            idle_edit = client.post(
                "/mcp",
                headers={**auth_headers, "Mcp-Session-Id": idle_sid},
                json={
                    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {
                        "name": "qnb_edit_staged_file",
                        "arguments": {"path": "/AlwaysOn.lean", "old_text": "77", "new_text": "88", "keep_staged": True},
                    },
                },
            )
            self.assertEqual(idle_edit.status_code, 200)
            self.assertEqual(fs.files["/AlwaysOn.lean"]["text"], "def x := 77\n")
            reaped = mcp_server.hub.reap_expired(now=_time.monotonic() + 9999)
            self.assertIn(idle_sid, reaped)
            self.assertEqual(fs.files["/AlwaysOn.lean"]["text"], "def x := 88\n")
            self.assertEqual(collab.staging.list_staged(1)["stagedFiles"], [])

            # 3) Legacy /mcp/messages endpoint accepts ?token= + ?sessionId= query params cleanly
            msg_resp = client.post(
                f"/mcp/messages?sessionId=mcp-msg-test&token={tok}",
                json={
                    "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {
                        "name": "qnb_edit_staged_file",
                        "arguments": {"path": "/AlwaysOn.lean", "old_text": "88", "new_text": "99"},
                    },
                },
            )
            self.assertEqual(msg_resp.status_code, 200)
            p3 = json.loads(msg_resp.get_json()["result"]["content"][0]["text"])
            self.assertTrue(p3["autoSaved"])
            self.assertEqual(fs.files["/AlwaysOn.lean"]["text"], "def x := 99\n")
            mcp_server.hub.close_session("mcp-msg-test")


if __name__ == "__main__":
    unittest.main()
