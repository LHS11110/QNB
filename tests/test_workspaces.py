import importlib.util
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import store
from qnb.runtime import RequestError

HAS_FLASK = importlib.util.find_spec("flask") is not None


class WorkspaceCollaborationTests(unittest.TestCase):
    def test_invite_accept_switch_and_revoke_uses_distinct_accounts_and_shared_vm(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            store.initialize()
            with store.database() as db:
                db.executemany(
                    "INSERT INTO accounts (id, email, password, vm_id) VALUES (?, ?, 'hash', ?)",
                    [(1, "owner@example.test", 1900000000), (2, "guest@example.test", 1900000001)],
                )
                db.execute(
                    "INSERT INTO sessions (token_hash, account_id, expires, workspace_owner_id) VALUES ('tok-guest', 2, 9999999999, 2)"
                )

            owner = {"id": 1, "email": "owner@example.test", "vm_id": 1900000000, "workspace_owner_id": 1}
            guest = {"id": 2, "email": "guest@example.test", "vm_id": 1900000001, "workspace_owner_id": 2}

            self.assertEqual(store.invite_member(owner, "guest@example.test")["status"], "pending")
            self.assertEqual(store.respond_invite(guest, 1, True)["status"], "accepted")
            selected = store.select_workspace("tok-guest", guest, 1)
            self.assertTrue(selected["shared"])
            self.assertEqual(selected["ownerId"], 1)

            with store.database() as db:
                guest_row = db.execute(
                    "SELECT a.*, s.workspace_owner_id FROM accounts a JOIN sessions s ON a.id = s.account_id WHERE s.token_hash = 'tok-guest'"
                ).fetchone()
                resolved = store.resolve_workspace(db, guest_row, "tok-guest", strict=True)
                self.assertEqual(resolved["vm_id"], 1900000000)
                self.assertEqual(resolved["owner_id"], 1)
                self.assertTrue(resolved["shared"])

            # Revoking membership resets guest session back to their own VM and raises 403 in strict mode
            store.remove_workspace_member(owner, email="guest@example.test")
            with store.database() as db:
                restored_col = db.execute("SELECT workspace_owner_id FROM sessions WHERE token_hash = 'tok-guest'").fetchone()[0]
                self.assertEqual(restored_col, 2)
                db.execute("UPDATE sessions SET workspace_owner_id = 1 WHERE token_hash = 'tok-guest'")
                stale_row = db.execute(
                    "SELECT a.*, s.workspace_owner_id FROM accounts a JOIN sessions s ON a.id = s.account_id WHERE s.token_hash = 'tok-guest'"
                ).fetchone()
                with self.assertRaises(RequestError) as error:
                    store.resolve_workspace(db, stale_row, "tok-guest", strict=True)
                self.assertEqual(error.exception.status, 403)

    @unittest.skipUnless(HAS_FLASK, "Flask is required to test collaboration endpoints and terminal isolation")
    def test_collaboration_http_routes_and_per_user_terminal_home(self):
        import pty
        import select as _select
        import subprocess
        from qnb.app import app, terminal_init_command

        cmd_owner = terminal_init_command(1, "OwnerNick", "owner@example.test", "m1")
        cmd_guest = terminal_init_command(2, "GuestNick", "guest@example.test", "m2")
        self.assertIn("HOME=/var/tmp/qnb-home-u1", cmd_owner)
        self.assertIn("OwnerNick@qnb", cmd_owner)
        self.assertIn("HOME=/var/tmp/qnb-home-u2", cmd_guest)
        self.assertIn("GuestNick@qnb", cmd_guest)
        self.assertIn("cd /workspace", cmd_guest)
        self.assertIn("XDG_CONFIG_HOME=/var/tmp/qnb-home-u2/.config", cmd_guest)

        # Verify bash PTY emits ready sentinel AND prompt on both 1st and 2nd fresh shells
        with tempfile.TemporaryDirectory() as tmp_home_parent:
            fake_cmd = (
                cmd_owner.replace("/var/tmp/qnb-home-u1", f"{tmp_home_parent}/u1")
                .replace("cd /workspace", f"cd {tmp_home_parent}")
            )
            for run_idx in range(2):
                master, slave = pty.openpty()
                try:
                    proc = subprocess.Popen(
                        ["/bin/bash", "--noprofile", "--norc", "-i"],
                        stdin=slave, stdout=slave, stderr=slave,
                        start_new_session=True,
                    )
                    os.close(slave)
                    os.write(master, fake_cmd.encode())
                    out = bytearray()
                    deadline = time.monotonic() + 3.0
                    while time.monotonic() < deadline:
                        if _select.select([master], [], [], 0.05)[0]:
                            chunk = os.read(master, 4096)
                            if not chunk:
                                break
                            out.extend(chunk)
                            if b"__QNB_READY_m1__" in out and b"OwnerNick@qnb:" in out:
                                break
                    proc.kill()
                    proc.wait(timeout=3)
                    self.assertIn(b"__QNB_READY_m1__", out, f"run {run_idx} missing ready sentinel: {out!r}")
                    self.assertIn(b"OwnerNick@qnb:", out, f"run {run_idx} missing prompt: {out!r}")
                finally:
                    os.close(master)

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            store.initialize()
            owner_client = app.test_client()
            guest_client = app.test_client()

            fav = owner_client.get("/favicon.ico")
            self.assertEqual(fav.status_code, 200)
            self.assertIn("svg", fav.mimetype)
            self.assertIn(b"<circle", fav.data)
            fav.close()

            fav_svg = owner_client.get("/static/favicon.svg")
            self.assertEqual(fav_svg.status_code, 200)
            fav_svg.close()

            self.assertEqual(owner_client.post("/api/signup", json={
                "email": "owner@example.test", "password": "password123",
            }).status_code, 200)
            self.assertEqual(guest_client.post("/api/signup", json={
                "email": "guest@example.test", "password": "password123",
            }).status_code, 200)
            with store.database() as db:  # skip the email-verification step in these HTTP tests
                db.execute("UPDATE accounts SET email_verified = 1")

            self.assertEqual(owner_client.post("/api/workspaces/invite", json={
                "email": "guest@example.test",
            }).status_code, 200)

            guest_session = guest_client.get("/api/session").get_json()
            self.assertEqual(guest_session["email"], "guest@example.test")
            self.assertEqual(guest_session["pendingInvites"], 1)

            owner_id = owner_client.get("/api/session").get_json()["workspace"]["ownerId"]
            respond = guest_client.post("/api/workspaces/respond", json={
                "ownerId": owner_id, "decision": "accept", "switch": True,
            })
            self.assertEqual(respond.status_code, 200)
            self.assertTrue(respond.get_json()["workspace"]["shared"])

            with patch("qnb.runtime.workspace", return_value={"entries": [], "cursor": None}) as ws_call:
                self.assertEqual(guest_client.get("/api/files?operation=list&path=/").status_code, 200)
                # Guest uses owner's VM ID while staying logged in as guest@example.test
                owner_vm_id = 1900000000
                self.assertEqual(ws_call.call_args.args[0], owner_vm_id)

            # Owner removes guest; guest's next workspace read recovers cleanly on /api/session
            self.assertEqual(owner_client.post("/api/workspaces/remove", json={
                "email": "guest@example.test",
            }).status_code, 200)
            guest_after = guest_client.get("/api/session").get_json()
            self.assertFalse(guest_after["workspace"]["shared"])
            self.assertEqual(guest_after["email"], "guest@example.test")


if __name__ == "__main__":
    unittest.main()
