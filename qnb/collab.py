"""Backend-centric Automerge real-time staging, broadcasting, and auto-save engine."""

import json
import os
import queue
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock, RLock

from . import runtime, store
from .runtime import RequestError

COLLAB_TEXT_LIMIT = 512 * 1024  # 512 KiB max for CRDT staged editing
CRDT_SCRIPT = Path(__file__).with_name("crdt_daemon.cjs")


def _find_node():
    candidates = [
        os.environ.get("QNB_NODE_BIN"),
        "/usr/local/bin/node",
        "/usr/bin/node",
        shutil.which("node"),
    ]
    for cand in candidates:
        if cand and Path(cand).exists():
            return cand
    raise RequestError("Automerge CRDT 런타임(node)을 찾을 수 없습니다.", 503)


class CrdtBridge:
    """Thread-safe persistent Node.js bridge speaking JSON-lines with @automerge/automerge."""

    def __init__(self, script=CRDT_SCRIPT):
        self.script = Path(script)
        self.lock = Lock()
        self.proc = None

    def _ensure_proc(self):
        if self.proc is not None and self.proc.poll() is None:
            return self.proc
        if not self.script.exists():
            raise RequestError("CRDT 번들(crdt_daemon.cjs)을 찾을 수 없습니다.", 503)
        node_bin = _find_node()
        self.proc = subprocess.Popen(
            [node_bin, "--max-old-space-size=192", str(self.script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        return self.proc

    def call(self, op, **kwargs):
        req_id = uuid.uuid4().hex
        payload = json.dumps({"id": req_id, "op": op, **kwargs}, ensure_ascii=False) + "\n"
        with self.lock:
            for attempt in range(2):
                proc = self._ensure_proc()
                try:
                    proc.stdin.write(payload)
                    proc.stdin.flush()
                    line = proc.stdout.readline()
                    if not line:
                        raise BrokenPipeError("CRDT worker EOF")
                    resp = json.loads(line)
                    if not resp.get("ok"):
                        raise RequestError(f"Automerge 병합 오류: {resp.get('error', 'unknown')}", 409)
                    return resp["result"]
                except (BrokenPipeError, OSError, ValueError) as err:
                    try:
                        proc.kill()
                        proc.wait(timeout=1)
                    except (OSError, subprocess.SubprocessError):
                        pass
                    self.proc = None
                    if attempt == 1:
                        raise RequestError("실시간 협업 엔진이 응답하지 않습니다.", 503) from err

    def init_doc(self, file_id, text):
        return self.call("init", fileId=file_id, text=text)

    def update_text(self, doc_b64, file_id, text):
        return self.call("update_text", docBase64=doc_b64, fileId=file_id, text=text)

    def apply_changes(self, doc_b64, file_id, changes_b64=None, fallback_doc_b64=None, fallback_text=None):
        return self.call(
            "apply_changes",
            docBase64=doc_b64,
            fileId=file_id,
            changesBase64=changes_b64 or [],
            fallbackDocBase64=fallback_doc_b64,
            fallbackText=fallback_text,
        )


@dataclass
class StagedFile:
    owner_id: int
    vm_id: int
    path: str
    file_id: str
    disk_etag: str
    disk_resource_id: str
    disk_text: str
    staged_text: str
    automerge_b64: str
    heads: list = field(default_factory=list)
    dirty: bool = False
    chunked: bool = False
    active_sessions: dict = field(default_factory=dict)  # session_id -> actor dict
    cursors: dict = field(default_factory=dict)  # session_id -> int line

    def collaborators(self):
        seen = {}
        for sid, actor in self.active_sessions.items():
            seen[sid] = {
                "sessionId": sid,
                "email": actor.get("email", ""),
                "nickname": actor.get("nickname", ""),
                "handle": actor.get("handle", actor.get("nickname", "")),
                "kind": actor.get("kind", "browser"),
                "cursorLine": self.cursors.get(sid),
            }
        return list(seen.values())


@dataclass
class WorkspaceRoom:
    owner_id: int
    lock: RLock = field(default_factory=RLock)
    files: dict = field(default_factory=dict)  # path -> StagedFile
    clients: dict = field(default_factory=dict)  # session_id -> {"queue": Queue, "actor": dict}


def _actor_payload(account, *, kind="browser"):
    email = account["email"] if "email" in account.keys() else ""
    nick = ""
    if "nickname" in account.keys() and account["nickname"]:
        nick = account["nickname"]
    if not nick and email:
        nick = email.split("@", 1)[0]
    tag = account["tag"] if "tag" in account.keys() and account["tag"] else ""
    nick = nick or f"user-{account['id']}"
    return {
        "accountId": account["id"],
        "email": email,
        "nickname": nick,
        "tag": tag,
        "handle": f"{nick}#{tag}" if tag else nick,
        "kind": kind,
    }


def actor_from_account(account, *, kind="browser"):
    return _actor_payload(account, kind=kind)


class StagingManager:
    """Server-side staging area coordinating clients, Automerge CRDT state, and VM filesystem."""

    def __init__(self, bridge=None):
        self.bridge = bridge or CrdtBridge()
        self._rooms_lock = Lock()
        self._rooms = {}

    def _room(self, owner_id):
        with self._rooms_lock:
            room = self._rooms.get(owner_id)
            if room is None:
                room = WorkspaceRoom(owner_id=owner_id)
                self._rooms[owner_id] = room
            return room

    def reset_for_tests(self):
        with self._rooms_lock:
            self._rooms.clear()

    def _persist_stage(self, entry: StagedFile):
        with store.database() as db:
            db.execute("""
                INSERT INTO staged_files (
                    owner_id, path, vm_id, file_id, disk_etag, disk_resource_id,
                    disk_text, staged_text, automerge_b64, dirty, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
                ON CONFLICT(owner_id, path) DO UPDATE SET
                    vm_id = excluded.vm_id,
                    file_id = excluded.file_id,
                    disk_etag = excluded.disk_etag,
                    disk_resource_id = excluded.disk_resource_id,
                    disk_text = excluded.disk_text,
                    staged_text = excluded.staged_text,
                    automerge_b64 = excluded.automerge_b64,
                    dirty = excluded.dirty,
                    updated_at = unixepoch()
            """, (
                entry.owner_id, entry.path, entry.vm_id, entry.file_id,
                entry.disk_etag, entry.disk_resource_id, entry.disk_text,
                entry.staged_text, entry.automerge_b64, 1 if entry.dirty else 0,
            ))

    def _delete_stage_db(self, owner_id, path_prefix, include_children=False):
        with store.database() as db:
            if include_children:
                db.execute(
                    "DELETE FROM staged_files WHERE owner_id = ? AND (path = ? OR path LIKE ?)",
                    (owner_id, path_prefix, path_prefix.rstrip("/") + "/%"),
                )
            else:
                db.execute("DELETE FROM staged_files WHERE owner_id = ? AND path = ?", (owner_id, path_prefix))

    def _load_stage_db(self, owner_id, file_path):
        with store.database() as db:
            row = db.execute(
                "SELECT * FROM staged_files WHERE owner_id = ? AND path = ?",
                (owner_id, file_path),
            ).fetchone()
        if not row:
            return None
        return StagedFile(
            owner_id=row["owner_id"],
            vm_id=row["vm_id"],
            path=row["path"],
            file_id=row["file_id"],
            disk_etag=row["disk_etag"],
            disk_resource_id=row["disk_resource_id"],
            disk_text=row["disk_text"],
            staged_text=row["staged_text"],
            automerge_b64=row["automerge_b64"],
            dirty=bool(row["dirty"]),
        )

    def recover_orphaned_staging(self):
        """Flush any dirty staged files left behind after an unclean server restart."""
        try:
            with store.database() as db:
                rows = db.execute("SELECT * FROM staged_files").fetchall()
        except Exception:
            return 0
        flushed = 0
        for row in rows:
            if row["dirty"]:
                try:
                    runtime.write_text_force(
                        row["vm_id"], row["path"], row["staged_text"],
                        file_id=row["file_id"], etag=row["disk_etag"],
                        resource_id=row["disk_resource_id"],
                    )
                    flushed += 1
                except RequestError:
                    continue
            self._delete_stage_db(row["owner_id"], row["path"])
        return flushed

    def register_client(self, owner_id, session_id, actor):
        room = self._room(owner_id)
        q = queue.Queue(maxsize=256)
        with room.lock:
            room.clients[session_id] = {"queue": q, "actor": actor}
            snapshot = self._room_snapshot_locked(room)
        return q, snapshot

    def unregister_client(self, owner_id, session_id):
        room = self._room(owner_id)
        events = []
        with room.lock:
            room.clients.pop(session_id, None)
            for path in list(room.files.keys()):
                entry = room.files.get(path)
                if not entry or session_id not in entry.active_sessions:
                    continue
                actor = entry.active_sessions.pop(session_id, None)
                entry.cursors.pop(session_id, None)
                if not entry.active_sessions:
                    ev = self._flush_and_unstage_locked(room, path, actor, reason="zero_users")
                    events.append(ev)
                else:
                    events.append({
                        "type": "stage_presence",
                        "path": path,
                        "collaborators": entry.collaborators(),
                        "activeCount": len(entry.active_sessions),
                    })
        for ev in events:
            self._broadcast(owner_id, ev)
        return events

    def _room_snapshot_locked(self, room):
        return {
            "type": "workspace_init",
            "ownerId": room.owner_id,
            "collaborators": [
                {
                    "sessionId": sid,
                    "email": info["actor"].get("email", ""),
                    "nickname": info["actor"].get("nickname", ""),
                    "handle": info["actor"].get("handle", info["actor"].get("nickname", "")),
                    "kind": info["actor"].get("kind", "browser"),
                }
                for sid, info in room.clients.items()
            ],
            "stagedFiles": [
                {
                    "path": entry.path,
                    "dirty": entry.dirty,
                    "collaborators": entry.collaborators(),
                    "activeCount": len(entry.active_sessions),
                }
                for entry in room.files.values()
            ],
        }

    def _broadcast(self, owner_id, event, *, exclude_session=None):
        room = self._room(owner_id)
        with room.lock:
            targets = [
                (sid, info["queue"])
                for sid, info in room.clients.items()
                if sid != exclude_session
            ]
        for _, q in targets:
            try:
                q.put_nowait(event)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(event)
                except queue.Full:
                    pass

    def list_staged(self, owner_id):
        room = self._room(owner_id)
        with room.lock:
            items = [
                {
                    "path": entry.path,
                    "dirty": entry.dirty,
                    "activeCount": len(entry.active_sessions),
                    "collaborators": entry.collaborators(),
                    "bytes": len(entry.staged_text.encode("utf-8")),
                }
                for entry in sorted(room.files.values(), key=lambda x: x.path)
            ]
            clients = [
                {
                    "sessionId": sid,
                    "email": info["actor"].get("email", ""),
                    "nickname": info["actor"].get("nickname", ""),
                    "handle": info["actor"].get("handle", info["actor"].get("nickname", "")),
                    "kind": info["actor"].get("kind", "browser"),
                }
                for sid, info in room.clients.items()
            ]
        return {"stagedFiles": items, "connectedClients": clients}

    def get_staged_text_if_any(self, owner_id, path):
        norm = runtime.path(path)
        room = self._room(owner_id)
        with room.lock:
            entry = room.files.get(norm)
            if entry:
                return entry.staged_text
        db_entry = self._load_stage_db(owner_id, norm)
        return db_entry.staged_text if db_entry else None

    def read_effective_text(self, owner_id, vm_id, path):
        staged = self.get_staged_text_if_any(owner_id, path)
        if staged is not None:
            return staged
        return runtime.read_text(vm_id, path)["text"]

    def _ensure_staged_locked(self, room: WorkspaceRoom, workspace: dict, file_path: str):
        entry = room.files.get(file_path)
        if entry is not None:
            return entry
        from_db = self._load_stage_db(room.owner_id, file_path)
        if from_db is not None:
            room.files[file_path] = from_db
            return from_db

        vm_id = workspace["vm_id"]
        data = runtime.read_text_any(vm_id, file_path, max_bytes=COLLAB_TEXT_LIMIT)
        text = data["text"]
        if len(text.encode("utf-8")) > COLLAB_TEXT_LIMIT:
            raise RequestError("실시간 협업 편집은 512 KiB 이하 텍스트 파일만 지원합니다.", 413)
        file_id = data.get("fileId") or uuid.uuid4().hex
        init_res = self.bridge.init_doc(file_id, text)
        entry = StagedFile(
            owner_id=room.owner_id,
            vm_id=vm_id,
            path=file_path,
            file_id=file_id,
            disk_etag=data.get("etag") or runtime.digest(text),
            disk_resource_id=data.get("resourceId") or "",
            disk_text=text,
            staged_text=init_res["text"],
            automerge_b64=init_res["docBase64"],
            heads=init_res.get("heads", []),
            dirty=False,
            chunked=bool(data.get("chunked")),
        )
        room.files[file_path] = entry
        self._persist_stage(entry)
        return entry

    def open_file(self, workspace, path, session_id, actor, *, attach=True):
        file_path = runtime.path(path)
        if file_path == "/":
            raise RequestError("열 수 있는 파일 경로를 지정하세요.")
        owner_id = workspace["owner_id"]
        room = self._room(owner_id)
        presence_event = None
        with room.lock:
            entry = self._ensure_staged_locked(room, workspace, file_path)
            if attach and session_id:
                entry.active_sessions[session_id] = actor
                presence_event = {
                    "type": "stage_presence",
                    "path": file_path,
                    "collaborators": entry.collaborators(),
                    "activeCount": len(entry.active_sessions),
                }
            payload = {
                "path": entry.path,
                "text": entry.staged_text,
                "docBase64": entry.automerge_b64,
                "heads": entry.heads,
                "dirty": entry.dirty,
                "fileId": entry.file_id,
                "etag": entry.disk_etag,
                "resourceId": entry.disk_resource_id,
                "chunked": entry.chunked,
                "staged": True,
                "collaborators": entry.collaborators(),
                "activeCount": len(entry.active_sessions),
            }
        if presence_event:
            self._broadcast(owner_id, presence_event)
        return payload

    def edit_file(
        self, workspace, path, session_id, actor,
        *, changes_b64=None, doc_b64=None, new_text=None, cursor_line=None,
        auto_unstage_if_zero=True,
    ):
        file_path = runtime.path(path)
        owner_id = workspace["owner_id"]
        room = self._room(owner_id)
        patch_event = None
        unstage_event = None
        with room.lock:
            entry = self._ensure_staged_locked(room, workspace, file_path)
            if new_text is not None:
                if not isinstance(new_text, str):
                    raise RequestError("편집할 텍스트 형식이 올바르지 않습니다.")
                if len(new_text.encode("utf-8")) > COLLAB_TEXT_LIMIT:
                    raise RequestError("파일 크기는 512 KiB까지 지원합니다.", 413)
                merged = self.bridge.update_text(entry.automerge_b64, entry.file_id, new_text)
                out_changes = merged.get("changesBase64", [])
            else:
                merged = self.bridge.apply_changes(
                    entry.automerge_b64, entry.file_id,
                    changes_b64=changes_b64,
                    fallback_doc_b64=doc_b64,
                )
                out_changes = merged.get("outChangesBase64", [])

            if len(merged["text"].encode("utf-8")) > COLLAB_TEXT_LIMIT:
                raise RequestError("병합된 문서가 512 KiB 제한을 초과했습니다.", 413)

            entry.staged_text = merged["text"]
            entry.automerge_b64 = merged["docBase64"]
            entry.heads = merged.get("heads", [])
            entry.dirty = entry.staged_text != entry.disk_text
            if session_id and session_id in entry.active_sessions and isinstance(cursor_line, int):
                entry.cursors[session_id] = cursor_line
            self._persist_stage(entry)

            patch_event = {
                "type": "stage_patch",
                "path": file_path,
                "text": entry.staged_text,
                "docBase64": entry.automerge_b64,
                "changesBase64": out_changes,
                "heads": entry.heads,
                "dirty": entry.dirty,
                "originSessionId": session_id,
                "actor": actor,
                "cursorLine": cursor_line,
                "collaborators": entry.collaborators(),
                "activeCount": len(entry.active_sessions),
            }

            auto_saved = False
            unstaged = False
            if auto_unstage_if_zero and len(entry.active_sessions) == 0:
                unstage_event = self._flush_and_unstage_locked(room, file_path, actor, reason="zero_users")
                auto_saved = bool(unstage_event.get("autoSaved"))
                unstaged = True

            result = {
                "path": file_path,
                "text": entry.staged_text,
                "docBase64": entry.automerge_b64,
                "heads": entry.heads,
                "dirty": False if unstaged else entry.dirty,
                "activeCount": len(entry.active_sessions) if not unstaged else 0,
                "autoSaved": auto_saved,
                "unstaged": unstaged,
                "etag": unstage_event.get("etag", entry.disk_etag) if unstage_event else entry.disk_etag,
                "resourceId": unstage_event.get("resourceId", entry.disk_resource_id) if unstage_event else entry.disk_resource_id,
            }

        self._broadcast(owner_id, patch_event)
        if unstage_event:
            self._broadcast(owner_id, unstage_event)
        return result

    def update_cursor(self, owner_id, path, session_id, actor, cursor_line):
        file_path = runtime.path(path)
        room = self._room(owner_id)
        with room.lock:
            entry = room.files.get(file_path)
            if not entry or session_id not in entry.active_sessions:
                return
            if isinstance(cursor_line, int) and cursor_line >= 1:
                entry.cursors[session_id] = cursor_line
            ev = {
                "type": "stage_presence",
                "path": file_path,
                "collaborators": entry.collaborators(),
                "activeCount": len(entry.active_sessions),
            }
        self._broadcast(owner_id, ev, exclude_session=session_id)

    def save_file(self, workspace, path, actor):
        file_path = runtime.path(path)
        owner_id = workspace["owner_id"]
        room = self._room(owner_id)
        saved_event = None
        unstage_event = None
        with room.lock:
            entry = room.files.get(file_path) or self._load_stage_db(owner_id, file_path)
            if entry is not None:
                room.files[file_path] = entry
                res = runtime.write_text_force(
                    workspace["vm_id"], file_path, entry.staged_text,
                    file_id=entry.file_id, etag=entry.disk_etag, resource_id=entry.disk_resource_id,
                )
                entry.disk_text = entry.staged_text
                entry.disk_etag = res["etag"]
                if res.get("fileId"):
                    entry.file_id = res["fileId"]
                entry.disk_resource_id = res["resourceId"]
                entry.chunked = res["chunked"]
                entry.dirty = False
                still_staged = len(entry.active_sessions) > 0
                if still_staged:
                    self._persist_stage(entry)
                else:
                    room.files.pop(file_path, None)
                    self._delete_stage_db(owner_id, file_path)
                    unstage_event = {
                        "type": "file_unstaged",
                        "path": file_path,
                        "autoSaved": False,
                        "reason": "saved_zero_users",
                        "etag": entry.disk_etag,
                        "fileId": entry.file_id,
                        "resourceId": entry.disk_resource_id,
                    }
                saved_event = {
                    "type": "file_saved",
                    "path": file_path,
                    "etag": entry.disk_etag,
                    "fileId": entry.file_id,
                    "resourceId": entry.disk_resource_id,
                    "chunked": entry.chunked,
                    "dirty": False,
                    "staged": still_staged,
                    "actor": actor,
                }
                result = {
                    "path": file_path,
                    "etag": entry.disk_etag,
                    "fileId": entry.file_id,
                    "resourceId": entry.disk_resource_id,
                    "chunked": entry.chunked,
                    "dirty": False,
                    "staged": still_staged,
                }
            else:
                info = runtime.workspace(workspace["vm_id"], "stat", file_path)
                result = {
                    "path": file_path,
                    "etag": info.get("resourceId", ""),
                    "fileId": "",
                    "resourceId": info.get("resourceId", ""),
                    "dirty": False,
                    "staged": False,
                }
        if saved_event:
            self._broadcast(owner_id, saved_event)
        if unstage_event:
            self._broadcast(owner_id, unstage_event)
        return result

    def _flush_and_unstage_locked(self, room: WorkspaceRoom, file_path: str, actor, *, reason="zero_users"):
        entry = room.files.get(file_path)
        if entry is None:
            self._delete_stage_db(room.owner_id, file_path)
            return {
                "type": "file_unstaged",
                "path": file_path,
                "autoSaved": False,
                "reason": reason,
            }
        auto_saved = False
        if entry.dirty:
            res = runtime.write_text_force(
                entry.vm_id, file_path, entry.staged_text,
                file_id=entry.file_id, etag=entry.disk_etag, resource_id=entry.disk_resource_id,
            )
            entry.disk_text = entry.staged_text
            entry.disk_etag = res["etag"]
            if res.get("fileId"):
                entry.file_id = res["fileId"]
            entry.disk_resource_id = res["resourceId"]
            entry.dirty = False
            auto_saved = True
        room.files.pop(file_path, None)
        self._delete_stage_db(room.owner_id, file_path)
        return {
            "type": "file_unstaged",
            "path": file_path,
            "autoSaved": auto_saved,
            "reason": reason,
            "actor": actor,
            "etag": entry.disk_etag,
            "fileId": entry.file_id,
            "resourceId": entry.disk_resource_id,
        }

    def close_file(self, workspace, path, session_id, actor=None):
        file_path = runtime.path(path)
        owner_id = workspace["owner_id"]
        room = self._room(owner_id)
        event = None
        result = {"path": file_path, "activeCount": 0, "autoSaved": False, "unstaged": False}
        with room.lock:
            entry = room.files.get(file_path)
            if entry:
                entry.active_sessions.pop(session_id, None)
                entry.cursors.pop(session_id, None)
                if len(entry.active_sessions) == 0:
                    event = self._flush_and_unstage_locked(room, file_path, actor, reason="zero_users")
                    result = {
                        "path": file_path,
                        "activeCount": 0,
                        "autoSaved": event.get("autoSaved", False),
                        "unstaged": True,
                        "etag": event.get("etag", ""),
                        "resourceId": event.get("resourceId", ""),
                    }
                else:
                    event = {
                        "type": "stage_presence",
                        "path": file_path,
                        "collaborators": entry.collaborators(),
                        "activeCount": len(entry.active_sessions),
                    }
                    result = {
                        "path": file_path,
                        "activeCount": len(entry.active_sessions),
                        "autoSaved": False,
                        "unstaged": False,
                    }
        if event:
            self._broadcast(owner_id, event)
        return result

    def mutate_fs(self, workspace, actor, operation, path, **kwargs):
        file_path = runtime.path(path)
        owner_id = workspace["owner_id"]
        vm_id = workspace["vm_id"]
        room = self._room(owner_id)

        if operation == "mkdir":
            res = runtime.workspace(vm_id, "mkdir", file_path, requestId=uuid.uuid4().hex)
            ev = {"type": "fs_event", "action": "mkdir", "path": file_path, "actor": actor}
            self._broadcast(owner_id, ev)
            return res

        if operation == "write":
            text = kwargs.get("text")
            if not isinstance(text, str):
                raise RequestError("저장할 텍스트가 필요합니다.")
            if kwargs.get("create"):
                if len(text.encode("utf-8")) > runtime.FILE_LIMIT:
                    raise RequestError("파일 크기는 128 KiB까지 지원합니다.", 413)
                runtime.ensure_parent_directory(vm_id, file_path)
                res = runtime.workspace(
                    vm_id, "write", file_path,
                    requestId=uuid.uuid4().hex, content=runtime.b64(text.encode("utf-8")),
                    create=True, overwrite=False,
                )
                ev = {"type": "fs_event", "action": "create", "path": file_path, "actor": actor}
                self._broadcast(owner_id, ev)
                return res
            # Normal write updates staged + filesystem through save semantics
            with room.lock:
                entry = room.files.get(file_path) or self._load_stage_db(owner_id, file_path)
                if entry is not None:
                    room.files[file_path] = entry
                    merged = self.bridge.update_text(entry.automerge_b64, entry.file_id, text)
                    entry.staged_text = merged["text"]
                    entry.automerge_b64 = merged["docBase64"]
                    entry.heads = merged.get("heads", [])
                    entry.dirty = True
            if entry is not None:
                return self.save_file(workspace, file_path, actor)
            saved = runtime.write_text_force(
                vm_id, file_path, text,
                file_id=kwargs.get("fileId"), etag=kwargs.get("etag"),
                resource_id=kwargs.get("resourceId"),
            )
            self._broadcast(owner_id, {
                "type": "file_saved",
                "path": file_path,
                "etag": saved["etag"],
                "fileId": saved.get("fileId", ""),
                "resourceId": saved.get("resourceId", ""),
                "dirty": False,
                "staged": False,
                "actor": actor,
            })
            return saved

        if operation == "rename":
            target = runtime.path(kwargs.get("target"))
            resource_id = kwargs.get("resourceId")
            if not isinstance(resource_id, str) or not resource_id:
                resource_id = runtime.workspace(vm_id, "stat", file_path)["resourceId"]
            res = runtime.workspace(
                vm_id, "rename", file_path,
                requestId=uuid.uuid4().hex, resourceId=resource_id, target=target,
            )
            prefix = file_path.rstrip("/") + "/"
            with room.lock:
                moved = {}
                for k in list(room.files.keys()):
                    if k == file_path or k.startswith(prefix):
                        item = room.files.pop(k)
                        new_k = target + k[len(file_path):]
                        item.path = new_k
                        moved[new_k] = item
                room.files.update(moved)
                with store.database() as db:
                    rows = db.execute(
                        "SELECT path FROM staged_files WHERE owner_id = ? AND (path = ? OR path LIKE ?)",
                        (owner_id, file_path, prefix + "%"),
                    ).fetchall()
                    for row in rows:
                        old_p = row["path"]
                        new_p = target + old_p[len(file_path):]
                        db.execute(
                            "UPDATE staged_files SET path = ?, updated_at = unixepoch() WHERE owner_id = ? AND path = ?",
                            (new_p, owner_id, old_p),
                        )
            ev = {
                "type": "fs_event", "action": "rename",
                "path": file_path, "target": target, "actor": actor,
            }
            self._broadcast(owner_id, ev)
            return res | {"target": target}

        if operation == "delete":
            resource_id = kwargs.get("resourceId")
            if not isinstance(resource_id, str) or not resource_id:
                resource_id = runtime.workspace(vm_id, "stat", file_path)["resourceId"]
            recursive = bool(kwargs.get("recursive", False))
            try:
                res = runtime.workspace(
                    vm_id, "delete", file_path,
                    requestId=uuid.uuid4().hex, resourceId=resource_id, recursive=recursive,
                )
            except RequestError as err:
                if err.status == 409 and "비어 있는 폴더" in str(err) and recursive:
                    raise
                raise
            prefix = file_path.rstrip("/") + "/"
            with room.lock:
                for k in list(room.files.keys()):
                    if k == file_path or k.startswith(prefix):
                        room.files.pop(k, None)
                self._delete_stage_db(owner_id, file_path, include_children=True)
            ev = {"type": "fs_event", "action": "delete", "path": file_path, "actor": actor}
            self._broadcast(owner_id, ev)
            return res

        raise RequestError("지원하지 않는 파일 작업입니다.")


staging = StagingManager()
