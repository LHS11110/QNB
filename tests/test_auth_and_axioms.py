import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from qnb import auth, store
from qnb.runtime import check_lean, proof_records

HAS_FLASK = importlib.util.find_spec("flask") is not None
LEAN = os.environ.get("QNB_TEST_LEAN")
INSPECTOR = Path(__file__).resolve().parents[1] / "qnb" / "Inspect.lean"


def _cbor_uint(major: int, val: int) -> bytes:
    if val < 24:
        return bytes([(major << 5) | val])
    if val < 256:
        return bytes([(major << 5) | 24, val])
    if val < 65536:
        return bytes([(major << 5) | 25]) + val.to_bytes(2, "big")
    raise ValueError("Too large")


def _cbor_bytes(b: bytes) -> bytes:
    return _cbor_uint(2, len(b)) + b


def _cbor_text(s: str) -> bytes:
    raw = s.encode("utf-8")
    return _cbor_uint(3, len(raw)) + raw


def _cbor_int(val: int) -> bytes:
    if val >= 0:
        return _cbor_uint(0, val)
    return _cbor_uint(1, -1 - val)


def _cbor_map(items: list[tuple]) -> bytes:
    out = bytearray(_cbor_uint(5, len(items)))
    for k, v in items:
        out.extend(_cbor_int(k) if isinstance(k, int) else _cbor_text(k))
        if isinstance(v, int):
            out.extend(_cbor_int(v))
        elif isinstance(v, bytes):
            out.extend(_cbor_bytes(v))
        elif isinstance(v, str):
            out.extend(_cbor_text(v))
        else:
            raise TypeError(type(v))
    return bytes(out)


class AuthAndCustomAxiomsTests(unittest.TestCase):
    def test_totp_and_passkey_es256_verification(self):
        secret = auth.generate_totp_secret()
        now = 1700000000
        import base64
        padded = secret + "=" * ((8 - len(secret) % 8) % 8)
        key_bytes = base64.b32decode(padded)
        code = auth._totp_at(key_bytes, now // 30)
        self.assertTrue(auth.verify_totp(secret, code, now=now))
        self.assertFalse(auth.verify_totp(secret, "000000" if code != "000000" else "111111", now=now))

        priv = ec.generate_private_key(ec.SECP256R1())
        pub_nums = priv.public_key().public_numbers()
        x = pub_nums.x.to_bytes(32, "big")
        y = pub_nums.y.to_bytes(32, "big")
        cose = _cbor_map([(1, 2), (3, -7), (-1, 1), (-2, x), (-3, y)])
        cred_id = b"test-cred-id-1234"
        rp_id = "qnb.p-e.kr"
        origin = "https://qnb.p-e.kr"
        rp_hash = hashlib.sha256(rp_id.encode()).digest()
        auth_data = rp_hash + bytes([0x45]) + (1).to_bytes(4, "big") + (b"\x00" * 16) + len(cred_id).to_bytes(2, "big") + cred_id + cose
        att_obj = _cbor_map([("fmt", "none"), ("authData", auth_data)])
        reg_challenge = auth.b64url_encode(b"reg-challenge-bytes")
        reg_client_data = json.dumps({"type": "webauthn.create", "challenge": reg_challenge, "origin": origin}).encode()
        reg_cred = {
            "id": auth.b64url_encode(cred_id),
            "rawId": auth.b64url_encode(cred_id),
            "response": {
                "clientDataJSON": auth.b64url_encode(reg_client_data),
                "attestationObject": auth.b64url_encode(att_obj),
            },
        }
        registered = auth.verify_registration(reg_cred, reg_challenge, {origin}, rp_id)
        self.assertEqual(registered["credential_id"], auth.b64url_encode(cred_id))

        auth_challenge = auth.b64url_encode(b"auth-challenge-bytes")
        auth_client_data = json.dumps({"type": "webauthn.get", "challenge": auth_challenge, "origin": origin}).encode()
        assertion_data = rp_hash + bytes([0x05]) + (2).to_bytes(4, "big")
        sig = priv.sign(assertion_data + hashlib.sha256(auth_client_data).digest(), ec.ECDSA(hashes.SHA256()))
        assertion = {
            "id": registered["credential_id"],
            "response": {
                "clientDataJSON": auth.b64url_encode(auth_client_data),
                "authenticatorData": auth.b64url_encode(assertion_data),
                "signature": auth.b64url_encode(sig),
            },
        }
        new_count, uv = auth.verify_authentication(assertion, registered["public_key"], 1, auth_challenge, {origin}, rp_id)
        self.assertEqual(new_count, 2)
        self.assertTrue(uv)

        bad_assertion = {
            "id": registered["credential_id"],
            "response": {
                **assertion["response"],
                "signature": auth.b64url_encode(b"\x00" * len(sig)),
            },
        }
        with self.assertRaises(ValueError):
            auth.verify_authentication(bad_assertion, registered["public_key"], 1, auth_challenge, {origin}, rp_id)

    @unittest.skipUnless(LEAN, "set QNB_TEST_LEAN to the Lean 4.10 guest binary")
    def test_owner_axiom_allowed_for_collaborator_cells_while_cell_local_axioms_blocked(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(folder) / "qnb.sqlite3"),
        }):
            store.initialize()
            with store.database() as db:
                db.execute("INSERT INTO accounts (id, email, password, vm_id) VALUES (1, 'owner@test', 'h', 1900000000)")
                db.execute("INSERT INTO account_profiles (account_id, nickname) VALUES (1, 'euler')")

            # 1. Local axiom inside a normal cell is blocked and dependent theorem is rejected
            local_ax_code = "axiom localFake : False\ntheorem bad_from_local : False := localFake\n"
            nb = Path(folder) / "Local.lean"
            rep = Path(folder) / "Local.json"
            arch = Path(folder) / "Empty.json"
            nb.write_text(local_ax_code)
            arch.write_text("[]")
            subprocess.run([LEAN, "--run", str(INSPECTOR), str(nb), str(rep), str(arch)], check=True, capture_output=True)
            local_report = json.loads(rep.read_text())
            self.assertEqual(local_report["declarations"], [])
            self.assertEqual(local_report["rejected"], ["bad_from_local"])
            self.assertEqual(local_report["localAxioms"], ["localFake"])

            # 2. Register axiom in owner mode (--allow-local-axioms) and store in DB
            ax_source = "axiom sensor_bound (n : Nat) : n ≤ n + 1\n"
            nb_ax = Path(folder) / "Ax.lean"
            rep_ax = Path(folder) / "Ax.json"
            nb_ax.write_text(ax_source)
            subprocess.run([LEAN, "--run", str(INSPECTOR), str(nb_ax), str(rep_ax), str(arch), "allow-local-axioms"], check=True, capture_output=True)
            ax_report = json.loads(rep_ax.read_text())
            ax_rows = proof_records(ax_source, ax_report["customAxioms"], {})
            saved_ax = store.save_axioms(1, ax_rows, [], ax_source, [], {})
            self.assertEqual(len(saved_ax), 1)
            ax_node_id = saved_ax[0]["nodeId"]

            # 3. Another cell / collaborator looks up `sensor_bound` from DB and proves a theorem using it
            entry, bindings = store.lookup_declaration(1, "sensor_bound")
            self.assertTrue(entry["entry"].get("isAxiom"))
            arch_ax = Path(folder) / "AxArch.json"
            arch_ax.write_text(json.dumps([entry]))
            thm_code = "theorem step_valid (k : Nat) : k ≤ k + 1 := sensor_bound k\n"
            nb_thm = Path(folder) / "Thm.lean"
            rep_thm = Path(folder) / "Thm.json"
            nb_thm.write_text(thm_code)
            subprocess.run([LEAN, "--run", str(INSPECTOR), str(nb_thm), str(rep_thm), str(arch_ax)], check=True, capture_output=True)
            thm_report = json.loads(rep_thm.read_text())
            self.assertTrue(thm_report["ok"], thm_report)
            self.assertEqual(thm_report["rejected"], [])
            thm_rows = proof_records(thm_code, thm_report["declarations"], bindings)
            inserted = store.save_declarations(1, "/shared.ipynb", thm_rows, [], thm_code, [entry], bindings)
            self.assertEqual([r["name"] for r in inserted], ["step_valid"])
            self.assertEqual(inserted[0]["dependencies"], [{"id": ax_node_id, "name": "sensor_bound"}])

            # 4. Proof tree loads the custom axiom node with source and hash
            tree = store.proof_tree(1, 0, inserted[0]["id"], 30, 3)
            ax_nodes = [n for n in tree["nodes"] if n["id"] == ax_node_id]
            self.assertEqual(len(ax_nodes), 1)
            self.assertEqual(ax_nodes[0]["kind"], "axiom")
            self.assertEqual(ax_nodes[0]["path"], "워크스페이스 공리")

            # 5. Forging same-named axiom locally in a normal cell without recovery is still rejected!
            forged_code = "axiom sensor_bound : False\ntheorem evil : False := sensor_bound\n"
            nb_forged = Path(folder) / "Forged.lean"
            rep_forged = Path(folder) / "Forged.json"
            nb_forged.write_text(forged_code)
            subprocess.run([LEAN, "--run", str(INSPECTOR), str(nb_forged), str(rep_forged), str(arch)], check=True, capture_output=True)
            forged_report = json.loads(rep_forged.read_text())
            self.assertEqual(forged_report["declarations"], [])
            self.assertEqual(forged_report["rejected"], ["evil"])

    @unittest.skipUnless(HAS_FLASK, "Flask is required to test auth and axiom HTTP endpoints")
    def test_profile_mfa_qr_login_and_owner_only_axioms_http(self):
        from qnb.app import app

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            store.initialize()
            owner_client = app.test_client()
            guest_client = app.test_client()
            pc_client = app.test_client()

            self.assertEqual(owner_client.post("/api/signup", json={
                "email": "owner@example.test", "password": "password123", "nickname": "euler",
            }).status_code, 200)
            self.assertEqual(guest_client.post("/api/signup", json={
                "email": "guest@example.test", "password": "password123", "nickname": "noether",
            }).status_code, 200)
            with store.database() as db:  # skip the email-verification step in these HTTP tests
                db.execute("UPDATE accounts SET email_verified = 1")

            self.assertEqual(owner_client.get("/api/session").get_json()["nickname"], "euler")
            self.assertEqual(owner_client.post("/api/profile", json={"nickname": "gauss"}).get_json()["nickname"], "gauss")
            self.assertEqual(owner_client.get("/api/session").get_json()["nickname"], "gauss")

            # Enable TOTP MFA on owner account
            setup = owner_client.post("/api/mfa/setup", json={}).get_json()
            import base64
            padded = setup["secret"] + "=" * ((8 - len(setup["secret"]) % 8) % 8)
            totp_code = auth._totp_at(base64.b32decode(padded), int(time.time()) // 30)
            enabled = owner_client.post("/api/mfa/enable", json={"code": totp_code}).get_json()
            self.assertTrue(enabled["mfaEnabled"])
            recovery_code = enabled["recoveryCodes"][0]

            # Login requires MFA second step
            owner_client.post("/api/logout", json={})
            step1 = owner_client.post("/api/login", json={
                "email": "owner@example.test", "password": "password123",
            }).get_json()
            self.assertTrue(step1["mfaRequired"])
            self.assertIsNone(owner_client.get("/api/session").get_json()["email"])
            step2 = owner_client.post("/api/login/mfa", json={
                "mfaToken": step1["mfaToken"], "code": recovery_code,
            })
            self.assertEqual(step2.status_code, 200)
            self.assertEqual(owner_client.get("/api/session").get_json()["email"], "owner@example.test")

            # Mobile QR login: PC starts -> Mobile approves -> PC polls & gets session
            qr = pc_client.post("/api/qr-login/start", json={}).get_json()
            self.assertEqual(pc_client.post("/api/qr-login/poll", json={
                "code": qr["code"], "pollSecret": qr["pollSecret"],
            }).get_json()["status"], "pending")
            self.assertEqual(owner_client.post("/api/qr-login/approve", json={
                "code": qr["code"],
            }).status_code, 200)
            polled = pc_client.post("/api/qr-login/poll", json={
                "code": qr["code"], "pollSecret": qr["pollSecret"],
            })
            self.assertEqual(polled.status_code, 200)
            self.assertEqual(pc_client.get("/api/session").get_json()["email"], "owner@example.test")
            # Replay blocked
            self.assertEqual(pc_client.post("/api/qr-login/poll", json={
                "code": qr["code"], "pollSecret": qr["pollSecret"],
            }).status_code, 409)

            # Invite guest to owner's workspace; guest cannot register/delete axioms (403), only read!
            owner_id = owner_client.get("/api/session").get_json()["workspace"]["ownerId"]
            owner_client.post("/api/workspaces/invite", json={"email": "guest@example.test"})
            guest_client.post("/api/workspaces/respond", json={
                "ownerId": owner_id, "decision": "accept", "switch": True,
            })
            self.assertEqual(guest_client.post("/api/axioms", json={"source": "axiom x : True"}).status_code, 403)
            self.assertEqual(guest_client.post("/api/axioms/delete", json={"name": "x"}).status_code, 403)

            with patch("qnb.runtime.configure_disk"), patch(
                "qnb.runtime.check_lean_axioms",
                return_value=(
                    [{"id": "ax-1", "name": "OwnerAx", "hash": "hx", "source": "axiom OwnerAx : True", "dependencies": []}],
                    [], [], {}, "ok",
                ),
            ):
                added = owner_client.post("/api/axioms", json={"source": "axiom OwnerAx : True"})
                self.assertEqual(added.status_code, 200)
                self.assertEqual(added.get_json()["saved"][0]["name"], "OwnerAx")

            guest_axioms = guest_client.get("/api/axioms").get_json()
            self.assertFalse(guest_axioms["canManage"])
            self.assertEqual([a["name"] for a in guest_axioms["axioms"]], ["OwnerAx"])


if __name__ == "__main__":
    unittest.main()
