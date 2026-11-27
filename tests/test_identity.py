import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import identity, store
from qnb.runtime import RequestError

HAS_FLASK = importlib.util.find_spec("flask") is not None


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"QNB_DATABASE": str(Path(self.tmp.name) / "qnb.sqlite3")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_existing_accounts_are_grandfathered_and_tagged(self):
        # A database created before tags / verification existed.
        db = sqlite3.connect(os.environ["QNB_DATABASE"])
        db.executescript("""
            CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
                                   password TEXT NOT NULL, vm_id INTEGER NOT NULL UNIQUE);
            CREATE TABLE account_profiles (account_id INTEGER PRIMARY KEY, nickname TEXT NOT NULL DEFAULT '');
            INSERT INTO accounts (email, password, vm_id) VALUES ('a@x.test', 'h', 1), ('b@x.test', 'h', 2);
            INSERT INTO account_profiles VALUES (1, 'kim'), (2, 'KIM');
        """)
        db.commit()
        db.close()
        store.initialize()
        with store.database() as db:
            rows = db.execute("SELECT a.email_verified, p.tag FROM accounts a JOIN account_profiles p ON p.account_id = a.id").fetchall()
        self.assertEqual([r["email_verified"] for r in rows], [1, 1])
        tags = [r["tag"] for r in rows]
        self.assertTrue(all(t and t.isdigit() and len(t) == 4 for t in tags))
        self.assertNotEqual(tags[0], tags[1])  # same nickname ignoring case → different tags

    def test_duplicate_nicknames_handles_and_account_names(self):
        store.initialize()
        with store.database() as db:
            for i, email in enumerate(("o@x.test", "g@x.test", "h@x.test"), start=1):
                db.execute("INSERT INTO accounts (id, email, password, vm_id) VALUES (?, ?, 'h', ?)", (i, email, i))
                identity.create_profile(db, i, "앨리스" if i < 3 else "밥")
            db.execute("INSERT INTO workspace_invites (owner_id, invitee_email, status) VALUES (1, 'g@x.test', 'accepted')")
        n1, t1 = identity.profile(1)
        n2, t2 = identity.profile(2)
        self.assertEqual((n1, n2), ("앨리스", "앨리스"))
        self.assertNotEqual(t1, t2)
        self.assertEqual(identity.find_by_handle(f"앨리스#{t2}")["email"], "g@x.test")
        self.assertIsNone(identity.find_by_handle("앨리스"))
        # duplicate nickname inside the workspace → the tag disambiguates the terminal account
        self.assertEqual(identity.workspace_account_name(1, 1), f"앨리스#{t1}")
        self.assertEqual(identity.workspace_account_name(1, 2), f"앨리스#{t2}")
        self.assertEqual(identity.workspace_account_name(3, 3), "밥")
        # renaming keeps the tag when it is free under the new nickname
        renamed = identity.update_nickname(2, "Carol")
        self.assertEqual(renamed["tag"], t2)
        self.assertEqual(identity.workspace_account_name(1, 1), "앨리스")

    def test_code_attempts_expiry_and_rate_limit(self):
        store.initialize()
        with store.database() as db:
            db.execute("INSERT INTO accounts (id, email, password, vm_id, email_verified) VALUES (1, 'a@x.test', 'h', 1, 0)")
        code, token = identity.issue_code(1, force=True)
        with self.assertRaises(RequestError) as limited:
            identity.issue_code(1)
        self.assertEqual(limited.exception.status, 429)
        wrong = "000000" if code != "000000" else "111111"
        with self.assertRaises(RequestError):
            identity.verify_code(1, wrong)
        self.assertEqual(identity.verify_code(1, code), {"verified": True})
        with self.assertRaises(RequestError):
            identity.verify_token(token)  # consumed together with the code
        with store.database() as db:
            self.assertEqual(db.execute("SELECT email_verified FROM accounts WHERE id = 1").fetchone()[0], 1)


@unittest.skipUnless(HAS_FLASK, "Flask is required for the HTTP flow")
class EmailVerificationHttpTests(unittest.TestCase):
    def test_signup_requires_verification_and_invites_by_handle(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            from qnb import app as app_module

            store.initialize()
            sent = []
            with patch.object(app_module.mailer, "verification_email",
                              lambda to, nick, code, link: sent.append((to, code, link)) or True):
                owner = app_module.app.test_client()
                guest = app_module.app.test_client()
                r = owner.post("/api/signup", json={"email": "owner@x.test", "password": "password123", "nickname": "kim"})
                self.assertEqual(r.status_code, 200)
                self.assertFalse(r.get_json()["emailVerified"])
                guest.post("/api/signup", json={"email": "guest@x.test", "password": "password123", "nickname": "kim"})

                # unverified accounts cannot use the workspace yet
                self.assertEqual(owner.get("/api/files").status_code, 403)
                session = owner.get("/api/session").get_json()
                self.assertFalse(session["emailVerified"])
                self.assertRegex(session["handle"], r"^kim#\d{4}$")

                (to, code, link), (_, guest_code, guest_link) = sent
                self.assertEqual(to, "owner@x.test")
                self.assertIn("/verify-email?token=", link)
                bad = owner.post("/api/email/verify", json={"code": "000000" if code != "000000" else "111111"})
                self.assertEqual(bad.status_code, 400)
                self.assertEqual(owner.post("/api/email/verify", json={"code": code}).status_code, 200)
                self.assertTrue(owner.get("/api/session").get_json()["emailVerified"])
                # the link works without a session (e.g. opened on a phone)
                token = guest_link.split("token=", 1)[1]
                anonymous = app_module.app.test_client()
                self.assertEqual(anonymous.post("/api/email/verify-link", json={"token": token}).status_code, 200)

                guest_handle = guest.get("/api/session").get_json()["handle"]
                self.assertNotEqual(guest_handle, session["handle"])  # same nickname, different tag
                notified = []
                with patch.object(app_module.channels.manager, "notify_account", lambda aid, ev: notified.append((aid, ev))):
                    r = owner.post("/api/workspaces/invite", json={"target": guest_handle})
                self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
                self.assertEqual(notified[0][1]["type"], "invite")
                self.assertEqual(owner.post("/api/workspaces/invite", json={"target": "nobody#0000"}).status_code, 404)
                members = owner.get("/api/workspaces").get_json()["members"]
                self.assertEqual(members[0]["handle"], guest_handle)


if __name__ == "__main__":
    unittest.main()
