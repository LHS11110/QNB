"""Workspace chat and voice channels relayed through the server (no peer-to-peer).

Every browser joins the hub of its current workspace over one WebSocket. Text
messages are persisted and broadcast to everyone in the workspace. Voice frames
are small binary packets (16 kHz mu-law, ~40 ms each) that the server fans out
to the other members of the same voice channel.
"""

import base64
import json
import os
import queue
import re
import struct
import time
import uuid
from pathlib import Path
from dataclasses import dataclass, field
from threading import Lock, RLock

from . import store
from .runtime import RequestError

MESSAGE_LIMIT = 2000
HISTORY_LIMIT = 100
CHANNEL_NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,40}$")
MAX_CHANNELS = 30
MAX_CATEGORIES = 20
ATTACHMENTS_PER_MESSAGE = 10
FILE_LIMIT = 50 * 1024 * 1024
WORKSPACE_FILE_QUOTA = 1024 * 1024 * 1024
FILE_CHUNK = 512 * 1024
FILE_NAME = re.compile(r"^[^\x00-\x1f\x7f/\\]{1,120}$")
DEFAULT_CATEGORIES = (("text", "텍스트 채널"), ("voice", "음성 채널"))
VOICE_FRAME_MAX = 2048
VOICE_FRAMES_PER_SECOND = 60
VOICE_MEMBER_LIMIT = 16
DEFAULT_CHANNELS = (("general", "일반", "text"), ("voice", "음성 라운지", "voice"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_channels (
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (owner_id, id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    channel_id TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    nickname TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages (owner_id, channel_id, id);
CREATE TABLE IF NOT EXISTS chat_categories (
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (owner_id, id)
);
CREATE TABLE IF NOT EXISTS chat_category_seeds (
    owner_id INTEGER PRIMARY KEY REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS chat_files (
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    id TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'file',
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (owner_id, id)
);
"""

# Only these types are ever served inline; everything else downloads as octet-stream.
INLINE_TYPES = {
    "image/png": "image", "image/jpeg": "image", "image/gif": "image", "image/webp": "image",
    "video/mp4": "video", "video/webm": "video", "video/ogg": "video",
    "audio/mpeg": "audio", "audio/ogg": "audio", "audio/wav": "audio", "audio/webm": "audio",
    "application/pdf": "pdf",
}


def initialize():
    with store.database() as db:
        db.executescript(SCHEMA)
        message_columns = {row["name"] for row in db.execute("PRAGMA table_info(chat_messages)")}
        if "tag" not in message_columns:
            db.execute("ALTER TABLE chat_messages ADD COLUMN tag TEXT NOT NULL DEFAULT ''")
        if "attachments" not in message_columns:
            db.execute("ALTER TABLE chat_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        channel_columns = {row["name"] for row in db.execute("PRAGMA table_info(chat_channels)")}
        if "category_id" not in channel_columns:
            db.execute("ALTER TABLE chat_channels ADD COLUMN category_id TEXT")
        if "position" not in channel_columns:
            db.execute("ALTER TABLE chat_channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0")


def files_root():
    return Path(os.environ.get("QNB_CHAT_FILES", store.database_path().parent / "chat-files"))


def _file_path(owner_id, file_id):
    if not re.fullmatch(r"[0-9a-f]{24}", file_id or ""):
        raise RequestError("파일을 찾을 수 없습니다.", 404)
    return files_root() / str(int(owner_id)) / file_id


def sniff_type(head, declared):
    """Decide the served type from the file's own bytes, never from the client's claim alone."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head[4:8] == b"ftyp":
        return "audio/mp4" if head[8:11] == b"M4A" else "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm" if declared == "audio/webm" else "video/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg" if declared.startswith("audio/") else "video/ogg"
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    return "application/octet-stream"


def file_kind(mime):
    return INLINE_TYPES.get(mime, "audio" if mime == "audio/mp4" else "file")


def start_upload(owner_id, account_id, name, size, declared):
    name = name.strip() if isinstance(name, str) else ""
    if not FILE_NAME.fullmatch(name):
        raise RequestError("파일 이름이 올바르지 않습니다.")
    if type(size) is not int or size < 1:
        raise RequestError("빈 파일은 올릴 수 없습니다.")
    if size > FILE_LIMIT:
        raise RequestError(f"파일은 {FILE_LIMIT // (1024 * 1024)}MB까지 올릴 수 있습니다.", 413)
    declared = declared if isinstance(declared, str) and len(declared) <= 100 else ""
    now = int(time.time())
    with store.database() as db:
        stale = db.execute(
            "SELECT id FROM chat_files WHERE owner_id = ? AND complete = 0 AND created_at < ?",
            (owner_id, now - 3600),
        ).fetchall()
        for row in stale:
            _file_path(owner_id, row["id"]).unlink(missing_ok=True)
        db.execute("DELETE FROM chat_files WHERE owner_id = ? AND complete = 0 AND created_at < ?", (owner_id, now - 3600))
        used = db.execute("SELECT COALESCE(SUM(size), 0) FROM chat_files WHERE owner_id = ?", (owner_id,)).fetchone()[0]
        if used + size > WORKSPACE_FILE_QUOTA:
            raise RequestError("워크스페이스 채팅 파일 저장 공간(1GB)이 가득 찼습니다.", 413)
        file_id = uuid.uuid4().hex[:24]
        db.execute(
            "INSERT INTO chat_files (owner_id, id, account_id, name, mime, size) VALUES (?, ?, ?, ?, ?, ?)",
            (owner_id, file_id, account_id, name, declared, size),
        )
    path = _file_path(owner_id, file_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return {"id": file_id, "chunkSize": FILE_CHUNK}


def _upload_row(db, owner_id, account_id, file_id):
    row = db.execute(
        "SELECT * FROM chat_files WHERE owner_id = ? AND id = ? AND account_id = ?",
        (owner_id, file_id, account_id),
    ).fetchone()
    if not row:
        raise RequestError("업로드를 찾을 수 없습니다. 다시 올려 주세요.", 404)
    return row


def upload_chunk(owner_id, account_id, file_id, offset, data):
    if not isinstance(data, str) or len(data) > FILE_CHUNK * 4 // 3 + 8:
        raise RequestError("파일 조각이 올바르지 않습니다.")
    try:
        chunk = base64.b64decode(data, validate=True)
    except ValueError as error:
        raise RequestError("파일 조각이 올바르지 않습니다.") from error
    with store.database() as db:
        row = _upload_row(db, owner_id, account_id, file_id)
        if row["complete"] or offset != row["received"] or not chunk or row["received"] + len(chunk) > row["size"]:
            raise RequestError("파일 조각 순서가 맞지 않습니다.", 409)
        with _file_path(owner_id, file_id).open("ab") as handle:
            handle.write(chunk)
        db.execute(
            "UPDATE chat_files SET received = received + ? WHERE owner_id = ? AND id = ?",
            (len(chunk), owner_id, file_id),
        )
    return {"received": row["received"] + len(chunk)}


def finish_upload(owner_id, account_id, file_id):
    with store.database() as db:
        row = _upload_row(db, owner_id, account_id, file_id)
        path = _file_path(owner_id, file_id)
        if row["received"] != row["size"] or path.stat().st_size != row["size"]:
            raise RequestError("파일이 끝까지 올라가지 않았습니다.", 409)
        with path.open("rb") as handle:
            mime = sniff_type(handle.read(64), row["mime"])
        db.execute(
            "UPDATE chat_files SET complete = 1, mime = ?, kind = ? WHERE owner_id = ? AND id = ?",
            (mime, file_kind(mime), owner_id, file_id),
        )
    return {"id": file_id, "name": row["name"], "mime": mime, "kind": file_kind(mime), "size": row["size"]}


def stored_file(owner_id, file_id):
    path = _file_path(owner_id, file_id)
    with store.database() as db:
        row = db.execute(
            "SELECT name, mime, kind, size FROM chat_files WHERE owner_id = ? AND id = ? AND complete = 1",
            (owner_id, file_id),
        ).fetchone()
    if not row or not path.is_file():
        raise RequestError("파일을 찾을 수 없습니다.", 404)
    return path, dict(row)


@dataclass
class Client:
    session_id: str
    actor: dict
    out: queue.Queue
    voice_channel: str | None = None
    slot: int = 0
    muted: bool = False
    window_start: float = 0.0
    window_frames: int = 0


@dataclass
class Hub:
    owner_id: int
    lock: RLock = field(default_factory=RLock)
    clients: dict = field(default_factory=dict)
    next_slot: int = 1


def _put(q, item):
    try:
        q.put_nowait(item)
    except queue.Full:
        # Drop the oldest pending item so slow clients never block the broadcaster.
        try:
            q.get_nowait()
        except queue.Empty:
            pass
        try:
            q.put_nowait(item)
        except queue.Full:
            pass


def _member(client):
    return {
        "sessionId": client.session_id,
        "accountId": client.actor.get("accountId"),
        "nickname": client.actor.get("nickname", ""),
        "tag": client.actor.get("tag", ""),
        "voiceChannel": client.voice_channel,
        "slot": client.slot if client.voice_channel else 0,
        "muted": client.muted,
    }


class ChannelManager:
    def __init__(self):
        self._lock = Lock()
        self._hubs = {}

    def reset_for_tests(self):
        with self._lock:
            self._hubs.clear()

    def _hub(self, owner_id):
        with self._lock:
            hub = self._hubs.get(owner_id)
            if hub is None:
                hub = self._hubs[owner_id] = Hub(owner_id)
            return hub

    # ---------- persistence ----------

    def list_channels(self, owner_id):
        return self.layout(owner_id)["channels"]

    def layout(self, owner_id):
        """Channels and categories of a workspace, seeding the defaults on first use."""
        with store.database() as db:
            if not db.execute("SELECT 1 FROM chat_channels WHERE owner_id = ? LIMIT 1", (owner_id,)).fetchone():
                db.executemany(
                    "INSERT OR IGNORE INTO chat_channels (owner_id, id, name, kind) VALUES (?, ?, ?, ?)",
                    [(owner_id, cid, name, kind) for cid, name, kind in DEFAULT_CHANNELS],
                )
            if db.execute("INSERT OR IGNORE INTO chat_category_seeds (owner_id) VALUES (?)", (owner_id,)).rowcount:
                # Once per workspace, existing channels keep their old look: one category per kind.
                for position, (kind, name) in enumerate(DEFAULT_CATEGORIES):
                    db.execute(
                        "INSERT OR IGNORE INTO chat_categories (owner_id, id, name, position) VALUES (?, ?, ?, ?)",
                        (owner_id, "cat-" + kind, name, position),
                    )
                    db.execute(
                        "UPDATE chat_channels SET category_id = ? WHERE owner_id = ? AND kind = ? AND category_id IS NULL",
                        ("cat-" + kind, owner_id, kind),
                    )
            categories = db.execute(
                "SELECT id, name, position FROM chat_categories WHERE owner_id = ? ORDER BY position, created_at, rowid",
                (owner_id,),
            ).fetchall()
            rows = db.execute(
                "SELECT id, name, kind, category_id, position FROM chat_channels WHERE owner_id = ?"
                " ORDER BY position, created_at, rowid",
                (owner_id,),
            ).fetchall()
        known = {c["id"] for c in categories}
        channels = [
            {"id": r["id"], "name": r["name"], "kind": r["kind"],
             "category": r["category_id"] if r["category_id"] in known else None, "position": r["position"]}
            for r in rows
        ]
        return {"channels": channels, "categories": [dict(c) for c in categories]}

    def _broadcast_layout(self, owner_id):
        layout = self.layout(owner_id)
        self._broadcast(owner_id, {"type": "channels", **layout})

    def _category(self, owner_id, category_id, *, allow_none=False):
        if category_id is None and allow_none:
            return None
        if not isinstance(category_id, str) or not 1 <= len(category_id) <= 64:
            raise RequestError("카테고리를 다시 선택하세요.")
        if not any(c["id"] == category_id for c in self.layout(owner_id)["categories"]):
            raise RequestError("카테고리를 찾을 수 없습니다.", 404)
        return category_id

    @staticmethod
    def _clean_name(name, what):
        name = name.strip() if isinstance(name, str) else ""
        if not CHANNEL_NAME.fullmatch(name):
            raise RequestError(f"{what} 이름은 1~40자여야 합니다.")
        return name

    def _channel(self, owner_id, channel_id, kind=None):
        if not isinstance(channel_id, str) or not 1 <= len(channel_id) <= 64:
            raise RequestError("채널을 다시 선택하세요.")
        # list_channels seeds the default channels for workspaces that have none yet.
        row = next((c for c in self.list_channels(owner_id) if c["id"] == channel_id), None)
        if not row or (kind and row["kind"] != kind):
            raise RequestError("채널을 찾을 수 없습니다.", 404)
        return row

    def history(self, owner_id, channel_id, before=None):
        self._channel(owner_id, channel_id, "text")
        params = [owner_id, channel_id]
        clause = ""
        if type(before) is int and before > 0:
            clause = " AND id < ?"
            params.append(before)
        with store.database() as db:
            rows = db.execute(
                "SELECT id, account_id, nickname, tag, text, attachments, created_at FROM chat_messages"
                f" WHERE owner_id = ? AND channel_id = ?{clause} ORDER BY id DESC LIMIT {HISTORY_LIMIT}",
                params,
            ).fetchall()
        return [self._message_payload(channel_id, row) for row in reversed(rows)]

    @staticmethod
    def _message_payload(channel_id, row):
        return {
            "id": row["id"], "channel": channel_id, "accountId": row["account_id"],
            "nickname": row["nickname"], "tag": row["tag"], "text": row["text"], "createdAt": row["created_at"],
            "attachments": json.loads(row["attachments"] or "[]"),
        }

    # ---------- connection lifecycle ----------

    def connect(self, owner_id, actor):
        client = Client(session_id="ch-" + uuid.uuid4().hex[:16], actor=actor, out=queue.Queue(maxsize=512))
        hub = self._hub(owner_id)
        with hub.lock:
            hub.clients[client.session_id] = client
        self._broadcast_presence(owner_id)
        return client

    def disconnect(self, owner_id, client):
        hub = self._hub(owner_id)
        with hub.lock:
            hub.clients.pop(client.session_id, None)
            empty = not hub.clients
        if empty:
            with self._lock:
                if self._hubs.get(owner_id) is hub and not hub.clients:
                    self._hubs.pop(owner_id, None)
        else:
            self._broadcast_presence(owner_id)

    def notify_account(self, account_id, event):
        """Deliver an event to every open connection of one account, whatever workspace it is in."""
        with self._lock:
            hubs = list(self._hubs.values())
        for hub in hubs:
            with hub.lock:
                targets = [c.out for c in hub.clients.values() if c.actor.get("accountId") == account_id]
            for q in targets:
                _put(q, event)

    def members(self, owner_id):
        hub = self._hub(owner_id)
        with hub.lock:
            return [_member(c) for c in hub.clients.values()]

    def _broadcast(self, owner_id, event, *, exclude=None):
        hub = self._hub(owner_id)
        with hub.lock:
            targets = [c.out for sid, c in hub.clients.items() if sid != exclude]
        for q in targets:
            _put(q, event)

    def _broadcast_presence(self, owner_id):
        self._broadcast(owner_id, {"type": "presence", "members": self.members(owner_id)})

    # ---------- commands ----------

    def init_payload(self, owner_id, client):
        return {
            "type": "init",
            "selfSessionId": client.session_id,
            **self.layout(owner_id),
            "members": self.members(owner_id),
        }

    def send_message(self, owner_id, client, channel_id, text, attachments=None):
        self._channel(owner_id, channel_id, "text")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise RequestError("메시지 내용이 필요합니다.")
        text = text.replace("\r\n", "\n").strip()
        files = self._attachments(owner_id, client.actor["accountId"], attachments)
        if not text and not files:
            raise RequestError("빈 메시지는 보낼 수 없습니다.")
        if len(text) > MESSAGE_LIMIT:
            raise RequestError(f"메시지는 {MESSAGE_LIMIT}자까지 보낼 수 있습니다.", 413)
        nickname = client.actor.get("nickname", "")
        with store.database() as db:
            cur = db.execute(
                "INSERT INTO chat_messages (owner_id, channel_id, account_id, nickname, tag, text, attachments)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (owner_id, channel_id, client.actor["accountId"], nickname, client.actor.get("tag", ""), text,
                 json.dumps(files, ensure_ascii=False)),
            )
            row = db.execute(
                "SELECT id, account_id, nickname, tag, text, attachments, created_at FROM chat_messages WHERE id = ?",
                (cur.lastrowid,),
            ).fetchone()
        message = self._message_payload(channel_id, row)
        self._broadcast(owner_id, {"type": "message", "message": message})
        return message

    @staticmethod
    def _attachments(owner_id, account_id, ids):
        if not ids:
            return []
        if not isinstance(ids, list) or len(ids) > ATTACHMENTS_PER_MESSAGE or not all(isinstance(i, str) for i in ids):
            raise RequestError(f"첨부 파일은 한 번에 {ATTACHMENTS_PER_MESSAGE}개까지 보낼 수 있습니다.")
        files = []
        with store.database() as db:
            for file_id in dict.fromkeys(ids):
                row = db.execute(
                    "SELECT id, name, mime, kind, size FROM chat_files"
                    " WHERE owner_id = ? AND id = ? AND account_id = ? AND complete = 1",
                    (owner_id, file_id, account_id),
                ).fetchone()
                if not row:
                    raise RequestError("첨부 파일을 찾을 수 없습니다. 다시 올려 주세요.", 404)
                files.append(dict(row))
        return files

    def create_channel(self, owner_id, name, kind, category=None):
        if kind not in ("text", "voice"):
            raise RequestError("채널 종류가 올바르지 않습니다.")
        name = self._clean_name(name, "채널")
        category = self._category(owner_id, category, allow_none=True)
        channels = self.list_channels(owner_id)
        if len(channels) >= MAX_CHANNELS:
            raise RequestError(f"채널은 최대 {MAX_CHANNELS}개까지 만들 수 있습니다.", 409)
        if any(c["name"] == name and c["kind"] == kind for c in channels):
            raise RequestError("같은 이름의 채널이 이미 있습니다.", 409)
        channel_id = uuid.uuid4().hex[:12]
        position = 1 + max((c["position"] for c in channels if c["category"] == category), default=-1)
        with store.database() as db:
            db.execute(
                "INSERT INTO chat_channels (owner_id, id, name, kind, category_id, position) VALUES (?, ?, ?, ?, ?, ?)",
                (owner_id, channel_id, name, kind, category, position),
            )
        self._broadcast_layout(owner_id)
        return {"id": channel_id, "name": name, "kind": kind, "category": category}

    def rename_channel(self, owner_id, channel_id, name):
        row = self._channel(owner_id, channel_id)
        name = self._clean_name(name, "채널")
        if any(c["name"] == name and c["kind"] == row["kind"] and c["id"] != channel_id for c in self.list_channels(owner_id)):
            raise RequestError("같은 이름의 채널이 이미 있습니다.", 409)
        with store.database() as db:
            db.execute("UPDATE chat_channels SET name = ? WHERE owner_id = ? AND id = ?", (name, owner_id, channel_id))
        self._broadcast_layout(owner_id)
        return {"id": channel_id, "name": name}

    def move_channel(self, owner_id, channel_id, category, index):
        """Drag and drop: put a channel at `index` inside `category` (None = uncategorised)."""
        self._channel(owner_id, channel_id)
        category = self._category(owner_id, category, allow_none=True)
        siblings = [c["id"] for c in self.list_channels(owner_id) if c["category"] == category and c["id"] != channel_id]
        index = index if type(index) is int else len(siblings)
        siblings.insert(max(0, min(index, len(siblings))), channel_id)
        with store.database() as db:
            db.execute("UPDATE chat_channels SET category_id = ? WHERE owner_id = ? AND id = ?", (category, owner_id, channel_id))
            db.executemany(
                "UPDATE chat_channels SET position = ? WHERE owner_id = ? AND id = ?",
                [(i, owner_id, cid) for i, cid in enumerate(siblings)],
            )
        self._broadcast_layout(owner_id)
        return {"id": channel_id, "category": category}

    def create_category(self, owner_id, name):
        name = self._clean_name(name, "카테고리")
        categories = self.layout(owner_id)["categories"]
        if len(categories) >= MAX_CATEGORIES:
            raise RequestError(f"카테고리는 최대 {MAX_CATEGORIES}개까지 만들 수 있습니다.", 409)
        if any(c["name"] == name for c in categories):
            raise RequestError("같은 이름의 카테고리가 이미 있습니다.", 409)
        category_id = "cat-" + uuid.uuid4().hex[:10]
        with store.database() as db:
            db.execute(
                "INSERT INTO chat_categories (owner_id, id, name, position) VALUES (?, ?, ?, ?)",
                (owner_id, category_id, name, 1 + max((c["position"] for c in categories), default=-1)),
            )
        self._broadcast_layout(owner_id)
        return {"id": category_id, "name": name}

    def rename_category(self, owner_id, category_id, name):
        self._category(owner_id, category_id)
        name = self._clean_name(name, "카테고리")
        if any(c["name"] == name and c["id"] != category_id for c in self.layout(owner_id)["categories"]):
            raise RequestError("같은 이름의 카테고리가 이미 있습니다.", 409)
        with store.database() as db:
            db.execute("UPDATE chat_categories SET name = ? WHERE owner_id = ? AND id = ?", (name, owner_id, category_id))
        self._broadcast_layout(owner_id)
        return {"id": category_id, "name": name}

    def move_category(self, owner_id, category_id, index):
        self._category(owner_id, category_id)
        order = [c["id"] for c in self.layout(owner_id)["categories"] if c["id"] != category_id]
        index = index if type(index) is int else len(order)
        order.insert(max(0, min(index, len(order))), category_id)
        with store.database() as db:
            db.executemany(
                "UPDATE chat_categories SET position = ? WHERE owner_id = ? AND id = ?",
                [(i, owner_id, cid) for i, cid in enumerate(order)],
            )
        self._broadcast_layout(owner_id)
        return {"id": category_id}

    def delete_category(self, owner_id, actor, category_id):
        """Remove a category; its channels stay and become uncategorised."""
        if actor.get("accountId") != owner_id:
            raise RequestError("워크스페이스 소유자만 카테고리를 삭제할 수 있습니다.", 403)
        self._category(owner_id, category_id)
        with store.database() as db:
            db.execute("UPDATE chat_channels SET category_id = NULL WHERE owner_id = ? AND category_id = ?", (owner_id, category_id))
            db.execute("DELETE FROM chat_categories WHERE owner_id = ? AND id = ?", (owner_id, category_id))
        self._broadcast_layout(owner_id)
        return {"deleted": category_id}

    def delete_channel(self, owner_id, actor, channel_id):
        if actor.get("accountId") != owner_id:
            raise RequestError("워크스페이스 소유자만 채널을 삭제할 수 있습니다.", 403)
        self._channel(owner_id, channel_id)
        if len(self.list_channels(owner_id)) <= 1:
            raise RequestError("마지막 채널은 삭제할 수 없습니다.", 409)
        with store.database() as db:
            attached = {
                item["id"]
                for row in db.execute(
                    "SELECT attachments FROM chat_messages WHERE owner_id = ? AND channel_id = ? AND attachments != '[]'",
                    (owner_id, channel_id),
                )
                for item in json.loads(row["attachments"])
            }
            for file_id in attached:
                db.execute("DELETE FROM chat_files WHERE owner_id = ? AND id = ?", (owner_id, file_id))
                _file_path(owner_id, file_id).unlink(missing_ok=True)
            db.execute("DELETE FROM chat_messages WHERE owner_id = ? AND channel_id = ?", (owner_id, channel_id))
            db.execute("DELETE FROM chat_channels WHERE owner_id = ? AND id = ?", (owner_id, channel_id))
        hub = self._hub(owner_id)
        with hub.lock:
            for c in hub.clients.values():
                if c.voice_channel == channel_id:
                    c.voice_channel = None
        self._broadcast_layout(owner_id)
        self._broadcast_presence(owner_id)
        return {"deleted": channel_id}

    def join_voice(self, owner_id, client, channel_id):
        self._channel(owner_id, channel_id, "voice")
        hub = self._hub(owner_id)
        with hub.lock:
            occupants = sum(1 for c in hub.clients.values()
                            if c.voice_channel == channel_id and c is not client)
            if occupants >= VOICE_MEMBER_LIMIT:
                raise RequestError(f"음성 채널은 최대 {VOICE_MEMBER_LIMIT}명까지 참여할 수 있습니다.", 409)
            client.voice_channel = channel_id
            client.slot = hub.next_slot
            hub.next_slot = hub.next_slot % 65535 + 1
            client.muted = False
        self._broadcast_presence(owner_id)
        return {"channel": channel_id, "slot": client.slot}

    def leave_voice(self, owner_id, client):
        hub = self._hub(owner_id)
        with hub.lock:
            client.voice_channel = None
            client.slot = 0
        self._broadcast_presence(owner_id)
        return {"left": True}

    def set_muted(self, owner_id, client, muted):
        hub = self._hub(owner_id)
        with hub.lock:
            client.muted = bool(muted)
        self._broadcast_presence(owner_id)
        return {"muted": client.muted}

    def relay_voice(self, owner_id, client, frame):
        """Fan one encoded audio frame out to the sender's voice channel peers.

        Wire format (server → client): uint16 big-endian speaker slot + payload.
        """
        if not isinstance(frame, (bytes, bytearray)) or not 1 <= len(frame) <= VOICE_FRAME_MAX:
            return 0
        now = time.monotonic()
        hub = self._hub(owner_id)
        with hub.lock:
            channel = client.voice_channel
            if not channel or client.muted:
                return 0
            if now - client.window_start >= 1.0:
                client.window_start, client.window_frames = now, 0
            client.window_frames += 1
            if client.window_frames > VOICE_FRAMES_PER_SECOND:
                return 0
            packet = struct.pack(">H", client.slot) + bytes(frame)
            targets = [c.out for c in hub.clients.values()
                       if c is not client and c.voice_channel == channel]
        for q in targets:
            _put(q, packet)
        return len(targets)


manager = ChannelManager()
