import importlib.util
import os
import queue
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qnb import channels, gitstatus, store
from qnb.runtime import RequestError

HAS_FLASK = importlib.util.find_spec("flask") is not None
HAS_GIT = shutil.which("git") is not None


def drain(client):
    items = []
    while True:
        try:
            items.append(client.out.get_nowait())
        except queue.Empty:
            return items


class ChannelHubTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"QNB_DATABASE": str(Path(self.tmp.name) / "qnb.sqlite3")})
        self.env.start()
        store.initialize()
        channels.initialize()
        with store.database() as db:
            db.executemany(
                "INSERT INTO accounts (id, email, password, vm_id) VALUES (?, ?, 'hash', ?)",
                [(1, "owner@example.test", 1900000000), (2, "guest@example.test", 1900000001),
                 (3, "other@example.test", 1900000002)],
            )
        self.hub = channels.ChannelManager()
        self.owner = {"accountId": 1, "email": "owner@example.test", "nickname": "owner", "kind": "browser"}
        self.guest = {"accountId": 2, "email": "guest@example.test", "nickname": "guest", "kind": "browser"}
        self.other = {"accountId": 3, "email": "other@example.test", "nickname": "other", "kind": "browser"}

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_default_channels_and_chat_broadcast_is_scoped_to_workspace(self):
        a = self.hub.connect(1, self.owner)
        b = self.hub.connect(1, self.guest)
        outsider = self.hub.connect(3, self.other)  # a different workspace
        listed = self.hub.list_channels(1)
        self.assertEqual([c["kind"] for c in listed], ["text", "voice"])
        drain(a), drain(b), drain(outsider)

        sent = self.hub.send_message(1, b, "general", "  안녕하세요\r\n두 번째 줄  ")
        self.assertEqual(sent["text"], "안녕하세요\n두 번째 줄")
        for client in (a, b):
            events = [e for e in drain(client) if isinstance(e, dict) and e["type"] == "message"]
            self.assertEqual(events[0]["message"]["nickname"], "guest")
        self.assertEqual(drain(outsider), [])
        self.assertEqual([m["id"] for m in self.hub.history(1, "general")], [sent["id"]])
        self.assertEqual(self.hub.history(3, "general"), [])

        with self.assertRaises(RequestError):
            self.hub.send_message(1, a, "general", "   ")
        with self.assertRaises(RequestError):
            self.hub.send_message(1, a, "voice", "text into a voice channel")
        with self.assertRaises(RequestError) as too_long:
            self.hub.send_message(1, a, "general", "x" * (channels.MESSAGE_LIMIT + 1))
        self.assertEqual(too_long.exception.status, 413)

    def test_history_paginates_backwards(self):
        a = self.hub.connect(1, self.owner)
        ids = [self.hub.send_message(1, a, "general", f"m{i}")["id"] for i in range(channels.HISTORY_LIMIT + 5)]
        latest = self.hub.history(1, "general")
        self.assertEqual(len(latest), channels.HISTORY_LIMIT)
        self.assertEqual(latest[-1]["id"], ids[-1])
        older = self.hub.history(1, "general", before=latest[0]["id"])
        self.assertEqual([m["id"] for m in older], ids[:5])

    def test_voice_frames_are_relayed_only_to_same_channel_peers(self):
        a = self.hub.connect(1, self.owner)
        b = self.hub.connect(1, self.guest)
        c = self.hub.connect(1, self.other)
        second = self.hub.create_channel(1, "회의실", "voice")
        joined_a = self.hub.join_voice(1, a, "voice")
        self.hub.join_voice(1, b, "voice")
        self.hub.join_voice(1, c, second["id"])
        drain(a), drain(b), drain(c)

        self.assertEqual(self.hub.relay_voice(1, a, b"\x01" * 640), 1)
        packets = [p for p in drain(b) if isinstance(p, bytes)]
        self.assertEqual(len(packets), 1)
        self.assertEqual(struct.unpack(">H", packets[0][:2])[0], joined_a["slot"])
        self.assertEqual(packets[0][2:], b"\x01" * 640)
        self.assertEqual([p for p in drain(a) if isinstance(p, bytes)], [])
        self.assertEqual([p for p in drain(c) if isinstance(p, bytes)], [])

        # muted senders, oversized frames and non-members are dropped
        self.hub.set_muted(1, a, True)
        self.assertEqual(self.hub.relay_voice(1, a, b"\x01" * 640), 0)
        self.hub.set_muted(1, a, False)
        self.assertEqual(self.hub.relay_voice(1, a, b"\x01" * (channels.VOICE_FRAME_MAX + 1)), 0)
        self.hub.leave_voice(1, b)
        self.assertEqual(self.hub.relay_voice(1, a, b"\x01" * 640), 0)

    def test_voice_rate_limit_and_presence(self):
        a = self.hub.connect(1, self.owner)
        b = self.hub.connect(1, self.guest)
        self.hub.join_voice(1, a, "voice")
        self.hub.join_voice(1, b, "voice")
        drain(b)
        relayed = sum(self.hub.relay_voice(1, a, b"\x00" * 64) for _ in range(channels.VOICE_FRAMES_PER_SECOND + 20))
        self.assertEqual(relayed, channels.VOICE_FRAMES_PER_SECOND)
        presence = [e for e in drain(a) if isinstance(e, dict) and e["type"] == "presence"][-1]
        in_voice = {m["nickname"]: m["voiceChannel"] for m in presence["members"]}
        self.assertEqual(in_voice, {"owner": "voice", "guest": "voice"})
        self.hub.disconnect(1, b)
        self.assertEqual([m["nickname"] for m in self.hub.members(1)], ["owner"])

    def test_channel_management_permissions(self):
        a = self.hub.connect(1, self.owner)
        created = self.hub.create_channel(1, "공지", "text")
        with self.assertRaises(RequestError):
            self.hub.create_channel(1, "공지", "text")
        with self.assertRaises(RequestError):
            self.hub.create_channel(1, "", "text")
        with self.assertRaises(RequestError):
            self.hub.create_channel(1, "bad", "video")
        with self.assertRaises(RequestError) as forbidden:
            self.hub.delete_channel(1, self.guest, created["id"])
        self.assertEqual(forbidden.exception.status, 403)
        self.hub.send_message(1, a, created["id"], "hello")
        self.hub.delete_channel(1, self.owner, created["id"])
        self.assertNotIn(created["id"], [c["id"] for c in self.hub.list_channels(1)])
        with store.database() as db:
            left = db.execute("SELECT COUNT(*) FROM chat_messages WHERE channel_id = ?", (created["id"],)).fetchone()[0]
        self.assertEqual(left, 0)

    def test_categories_group_and_reorder_channels(self):
        a = self.hub.connect(1, self.owner)
        layout = self.hub.layout(1)
        self.assertEqual([c["name"] for c in layout["categories"]], ["텍스트 채널", "음성 채널"])
        self.assertEqual({c["id"]: c["category"] for c in layout["channels"]},
                         {"general": "cat-text", "voice": "cat-voice"})

        project = self.hub.create_category(1, "프로젝트")
        with self.assertRaises(RequestError):
            self.hub.create_category(1, "프로젝트")
        spec = self.hub.create_channel(1, "스펙", "text", project["id"])
        call = self.hub.create_channel(1, "회의", "voice", project["id"])
        drain(a)

        # Drag "general" to the top of the project category.
        self.hub.move_channel(1, "general", project["id"], 0)
        event = [e for e in drain(a) if isinstance(e, dict) and e["type"] == "channels"][-1]
        ordered = [c["id"] for c in event["channels"] if c["category"] == project["id"]]
        self.assertEqual(ordered, ["general", spec["id"], call["id"]])

        self.hub.move_category(1, project["id"], 0)
        self.assertEqual(self.hub.layout(1)["categories"][0]["id"], project["id"])
        self.hub.rename_category(1, project["id"], "프로젝트 A")
        self.hub.rename_channel(1, spec["id"], "명세")

        with self.assertRaises(RequestError) as forbidden:
            self.hub.delete_category(1, self.guest, project["id"])
        self.assertEqual(forbidden.exception.status, 403)
        self.hub.delete_category(1, self.owner, project["id"])
        self.hub.delete_category(1, self.owner, "cat-text")
        self.hub.delete_category(1, self.owner, "cat-voice")
        # Deleting every category keeps the channels, uncategorised, and never re-seeds defaults.
        layout = self.hub.layout(1)
        self.assertEqual(layout["categories"], [])
        self.assertTrue(all(c["category"] is None for c in layout["channels"]))
        self.assertIn("명세", [c["name"] for c in layout["channels"]])

    def test_attachments_are_sniffed_scoped_and_cleaned_up(self):
        import base64
        files = Path(self.tmp.name) / "files"
        with patch.dict(os.environ, {"QNB_CHAT_FILES": str(files)}):
            png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 600_000
            started = channels.start_upload(1, 2, "그림.png", len(png), "image/png")
            step = started["chunkSize"]
            with self.assertRaises(RequestError):  # out-of-order chunk
                channels.upload_chunk(1, 2, started["id"], step, base64.b64encode(png[step:]).decode())
            with self.assertRaises(RequestError):  # someone else's upload
                channels.upload_chunk(1, 1, started["id"], 0, base64.b64encode(png[:step]).decode())
            for offset in range(0, len(png), step):
                channels.upload_chunk(1, 2, started["id"], offset, base64.b64encode(png[offset:offset + step]).decode())
            meta = channels.finish_upload(1, 2, started["id"])
            self.assertEqual((meta["mime"], meta["kind"]), ("image/png", "image"))

            # A file that claims to be an image but is HTML is served as a plain download.
            html = b"<script>alert(1)</script>"
            fake = channels.start_upload(1, 2, "x.png", len(html), "image/png")
            channels.upload_chunk(1, 2, fake["id"], 0, base64.b64encode(html).decode())
            self.assertEqual(channels.finish_upload(1, 2, fake["id"])["kind"], "file")

            with self.assertRaises(RequestError):
                channels.start_upload(1, 2, "big.bin", channels.FILE_LIMIT + 1, "")
            with self.assertRaises(RequestError):
                channels.stored_file(3, started["id"])  # other workspace

            guest = self.hub.connect(1, self.guest)
            owner = self.hub.connect(1, self.owner)
            room = self.hub.create_channel(1, "자료", "text")
            sent = self.hub.send_message(1, guest, room["id"], "", [started["id"]])
            self.assertEqual(sent["attachments"][0]["name"], "그림.png")
            self.assertEqual(self.hub.history(1, room["id"])[0]["attachments"][0]["kind"], "image")
            with self.assertRaises(RequestError):  # cannot attach another member's upload
                self.hub.send_message(1, owner, room["id"], "", [started["id"]])

            path, _ = channels.stored_file(1, started["id"])
            self.assertEqual(path.read_bytes(), png)
            self.hub.delete_channel(1, self.owner, room["id"])
            self.assertFalse(path.exists())


class GitStatusTests(unittest.TestCase):
    def test_parse_handles_branch_header_renames_and_outside_paths(self):
        raw = "\0".join([
            "## main...origin/main [ahead 2, behind 1]",
            " M src/app.py",
            "R  src/new.py", "src/old.py",
            "?? notes/",
            "!! build/",
            "UU merge.txt",
            "A  ../outside.txt",
        ]) + "\0"
        import base64
        output = "noise\n" + gitstatus.MARKER + "\n" + base64.b64encode(b"sub\0").decode() + "\nREPO\n/workspace/proj\n" \
            + base64.b64encode(raw.encode()).decode() + "\n"
        result = gitstatus.parse(output, "/proj")
        self.assertEqual(result["repo"], "/proj")
        self.assertEqual((result["branch"], result["upstream"], result["ahead"], result["behind"]),
                         ("main", "origin/main", 2, 1))
        self.assertEqual(result["subrepos"], ["sub"])
        self.assertEqual(result["files"], [
            ["/proj/src/app.py", "modified", False],
            ["/proj/src/new.py", "renamed", False],
            ["/proj/notes", "untracked", True],
            ["/proj/build", "ignored", True],
            ["/proj/merge.txt", "conflict", False],
        ])
        # ignored ancestor directories are kept so their contents render as ignored
        self.assertEqual(gitstatus.parse(output, "/proj/build/x")["files"], [["/proj/build", "ignored", True]])

    def test_parse_without_repository(self):
        self.assertEqual(gitstatus.parse("", "/"), {"repo": None, "subrepos": []})
        out = gitstatus.MARKER + "\n\nNOREPO\n"
        self.assertEqual(gitstatus.parse(out, "/")["reason"], "norepo")

    @unittest.skipUnless(HAS_GIT, "git is required")
    def test_command_against_real_repository(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root, "proj")
            (repo / "pkg").mkdir(parents=True)
            Path(root, "plain").mkdir()
            env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
            run = lambda *args: subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)
            run("init", "-q", "-b", "main")
            (repo / "tracked.py").write_text("a\n")
            (repo / ".gitignore").write_text("out/\n")
            run("add", ".")
            run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
            (repo / "tracked.py").write_text("b\n")
            (repo / "pkg" / "new.py").write_text("x\n")
            (repo / "out").mkdir()
            (repo / "out" / "bin").write_text("x\n")

            def status(folder):
                command = gitstatus.command(folder).replace("/workspace", root)
                done = subprocess.run(["bash", "-c", command], env=env, capture_output=True, text=True, check=True)
                return gitstatus.parse(done.stdout.replace(root, "/workspace"), folder)

            top = status("/")
            self.assertIsNone(top["repo"])
            self.assertEqual(top["subrepos"], ["proj"])
            inner = status("/proj")
            self.assertEqual(inner["branch"], "main")
            self.assertEqual(sorted(inner["files"]), [
                ["/proj/out", "ignored", True],
                ["/proj/pkg", "untracked", True],
                ["/proj/tracked.py", "modified", False],
            ])


@unittest.skipUnless(HAS_FLASK, "Flask is required to test upload/binary routes")
class UploadRouteTests(unittest.TestCase):
    def test_upload_creates_file_streams_bytes_and_broadcasts(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
        }):
            from qnb import app as app_module, runtime

            calls = []

            def fake_workspace(vm_id, operation, file_path, **fields):
                calls.append((operation, file_path, fields))
                if operation == "stat":
                    if file_path == "/missing":
                        raise RequestError("VM에서 파일을 찾을 수 없습니다.", 404)
                    return {"type": "directory"}
                if operation == "write":
                    return {"resourceId": "rid-0", "fileId": "f", "etag": "e"}
                if operation == "stage_chunk":
                    import base64
                    return {"offset": fields["offset"] + len(base64.b64decode(fields["content"]))}
                if operation == "commit_chunks":
                    return {"resourceId": "rid-1"}
                return {}

            class FakeWS:
                def __init__(self, frames):
                    self.frames = list(frames)
                    self.sent = []

                def send(self, data):
                    self.sent.append(data)

                def receive(self, timeout=None):
                    return self.frames.pop(0)

            payload = bytes(range(256)) * 3
            ws = FakeWS([payload])
            broadcasts = []
            with app_module.app.test_request_context("/"), \
                    patch.object(runtime, "workspace", side_effect=fake_workspace), \
                    patch.object(app_module.collab.staging, "_broadcast", lambda owner, ev: broadcasts.append(ev)):
                app_module.g.workspace = {"vm_id": 7, "owner_id": 1}
                app_module.g.account = {"id": 1, "email": "o@example.test", "nickname": "o"}
                result = app_module.vm_operation(ws, {
                    "resource": "workspace", "operation": "upload_stream",
                    "path": "/img/pasted.png", "size": len(payload),
                })
            self.assertEqual(result["path"], "/img/pasted.png")
            self.assertEqual(result["resourceId"], "rid-1")
            self.assertEqual([c[0] for c in calls[:2]], ["stat", "write"])
            self.assertEqual(calls[0][1], "/img")
            self.assertTrue(calls[1][2]["create"])
            self.assertEqual(calls[1][2]["overwrite"], False)
            self.assertIn(("commit_chunks"), [c[0] for c in calls])
            self.assertEqual(broadcasts[0]["action"], "create")

            # A vanished parent folder is refused before the VM journals a write it cannot finish.
            calls.clear()
            with app_module.app.test_request_context("/"), \
                    patch.object(runtime, "workspace", side_effect=fake_workspace), self.assertRaises(RequestError):
                app_module.g.workspace = {"vm_id": 7, "owner_id": 1}
                app_module.g.account = {"id": 1, "email": "o@example.test", "nickname": "o"}
                app_module.vm_operation(FakeWS([b"x"]), {
                    "resource": "workspace", "operation": "upload_stream", "path": "/missing/a.png", "size": 1,
                })
            self.assertNotIn("write", [c[0] for c in calls])

            with self.assertRaises(RequestError):
                with app_module.app.test_request_context("/"):
                    app_module.g.workspace = {"vm_id": 7, "owner_id": 1}
                    app_module.g.account = {"id": 1, "email": "o@example.test", "nickname": "o"}
                    app_module.vm_operation(FakeWS([]), {
                        "resource": "workspace", "operation": "upload_stream",
                        "path": "/big.bin", "size": runtime.LARGE_FILE_LIMIT + 1,
                    })


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAS_FLASK, "Flask is required to test the attachment endpoints")
class ChannelFileEndpointTests(unittest.TestCase):
    def test_upload_and_serve_with_safe_headers(self):
        import base64
        from qnb.app import app

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "QNB_DATABASE": str(Path(directory) / "qnb.sqlite3"),
            "QNB_CHAT_FILES": str(Path(directory) / "files"),
        }):
            store.initialize()
            channels.initialize()
            owner, outsider = app.test_client(), app.test_client()
            for client, email in ((owner, "owner@example.test"), (outsider, "outsider@example.test")):
                self.assertEqual(client.post("/api/signup", json={"email": email, "password": "password123"}).status_code, 200)
            with store.database() as db:
                db.execute("UPDATE accounts SET email_verified = 1")

            pdf = b"%PDF-1.4\n" + b"0" * 1000

            def upload(client, name, data):
                started = client.post("/api/channels/files", json={"operation": "start", "name": name, "size": len(data), "mime": ""}).get_json()
                client.post("/api/channels/files", json={"operation": "chunk", "id": started["id"], "offset": 0,
                                                         "data": base64.b64encode(data).decode()})
                return client.post("/api/channels/files", json={"operation": "finish", "id": started["id"]}).get_json()

            meta = upload(owner, "논문.pdf", pdf)
            self.assertEqual(meta["kind"], "pdf")
            served = owner.get(f"/api/channels/files/{meta['id']}")
            self.assertEqual(served.status_code, 200)
            self.assertEqual(served.mimetype, "application/pdf")
            self.assertEqual(served.data, pdf)
            self.assertIn("inline", served.headers["Content-Disposition"])
            self.assertIn("frame-ancestors 'self'", served.headers["Content-Security-Policy"])
            self.assertIn("default-src 'none'", served.headers["Content-Security-Policy"])
            ranged = owner.get(f"/api/channels/files/{meta['id']}", headers={"Range": "bytes=0-4"})
            self.assertEqual((ranged.status_code, ranged.data), (206, b"%PDF-"))
            download = owner.get(f"/api/channels/files/{meta['id']}?download=1")
            self.assertEqual(download.mimetype, "application/octet-stream")
            self.assertIn("attachment", download.headers["Content-Disposition"])

            page = upload(owner, "page.html", b"<html><script>alert(1)</script>")
            risky = owner.get(f"/api/channels/files/{page['id']}")
            self.assertEqual(risky.mimetype, "application/octet-stream")
            self.assertIn("attachment", risky.headers["Content-Disposition"])

            self.assertEqual(outsider.get(f"/api/channels/files/{meta['id']}").status_code, 404)
            self.assertEqual(app.test_client().get(f"/api/channels/files/{meta['id']}").status_code, 401)
            for response in (served, ranged, download, risky):
                response.close()
