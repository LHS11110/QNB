"""Workspace chat and voice channels relayed through the server (no peer-to-peer).

Every browser joins the hub of its current workspace over one WebSocket. Text
messages are persisted and broadcast to everyone in the workspace. Voice frames
are small binary packets (16 kHz mu-law, ~40 ms each) that the server fans out
to the other members of the same voice channel.
"""

import queue
import re
import struct
import time
import uuid
from dataclasses import dataclass, field
from threading import Lock, RLock

from . import store
from .runtime import RequestError

MESSAGE_LIMIT = 2000
HISTORY_LIMIT = 100
CHANNEL_NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,40}$")
MAX_CHANNELS = 30
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
"""


def initialize():
    with store.database() as db:
        db.executescript(SCHEMA)


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
        with store.database() as db:
            rows = db.execute(
                "SELECT id, name, kind FROM chat_channels WHERE owner_id = ? ORDER BY created_at, rowid",
                (owner_id,),
            ).fetchall()
            if not rows:
                db.executemany(
                    "INSERT OR IGNORE INTO chat_channels (owner_id, id, name, kind) VALUES (?, ?, ?, ?)",
                    [(owner_id, cid, name, kind) for cid, name, kind in DEFAULT_CHANNELS],
                )
                rows = db.execute(
                    "SELECT id, name, kind FROM chat_channels WHERE owner_id = ? ORDER BY created_at, rowid",
                    (owner_id,),
                ).fetchall()
        return [dict(row) for row in rows]

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
                "SELECT id, account_id, nickname, text, created_at FROM chat_messages"
                f" WHERE owner_id = ? AND channel_id = ?{clause} ORDER BY id DESC LIMIT {HISTORY_LIMIT}",
                params,
            ).fetchall()
        return [self._message_payload(channel_id, row) for row in reversed(rows)]

    @staticmethod
    def _message_payload(channel_id, row):
        return {
            "id": row["id"], "channel": channel_id, "accountId": row["account_id"],
            "nickname": row["nickname"], "text": row["text"], "createdAt": row["created_at"],
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
            "channels": self.list_channels(owner_id),
            "members": self.members(owner_id),
        }

    def send_message(self, owner_id, client, channel_id, text):
        self._channel(owner_id, channel_id, "text")
        if not isinstance(text, str):
            raise RequestError("메시지 내용이 필요합니다.")
        text = text.replace("\r\n", "\n").strip()
        if not text:
            raise RequestError("빈 메시지는 보낼 수 없습니다.")
        if len(text) > MESSAGE_LIMIT:
            raise RequestError(f"메시지는 {MESSAGE_LIMIT}자까지 보낼 수 있습니다.", 413)
        nickname = client.actor.get("nickname", "")
        with store.database() as db:
            cur = db.execute(
                "INSERT INTO chat_messages (owner_id, channel_id, account_id, nickname, text) VALUES (?, ?, ?, ?, ?)",
                (owner_id, channel_id, client.actor["accountId"], nickname, text),
            )
            row = db.execute(
                "SELECT id, account_id, nickname, text, created_at FROM chat_messages WHERE id = ?",
                (cur.lastrowid,),
            ).fetchone()
        message = self._message_payload(channel_id, row)
        self._broadcast(owner_id, {"type": "message", "message": message})
        return message

    def create_channel(self, owner_id, name, kind):
        if kind not in ("text", "voice"):
            raise RequestError("채널 종류가 올바르지 않습니다.")
        name = name.strip() if isinstance(name, str) else ""
        if not CHANNEL_NAME.fullmatch(name):
            raise RequestError("채널 이름은 1~40자여야 합니다.")
        channels = self.list_channels(owner_id)
        if len(channels) >= MAX_CHANNELS:
            raise RequestError(f"채널은 최대 {MAX_CHANNELS}개까지 만들 수 있습니다.", 409)
        if any(c["name"] == name and c["kind"] == kind for c in channels):
            raise RequestError("같은 이름의 채널이 이미 있습니다.", 409)
        channel_id = uuid.uuid4().hex[:12]
        with store.database() as db:
            db.execute(
                "INSERT INTO chat_channels (owner_id, id, name, kind) VALUES (?, ?, ?, ?)",
                (owner_id, channel_id, name, kind),
            )
        self._broadcast(owner_id, {"type": "channels", "channels": self.list_channels(owner_id)})
        return {"id": channel_id, "name": name, "kind": kind}

    def delete_channel(self, owner_id, actor, channel_id):
        if actor.get("accountId") != owner_id:
            raise RequestError("워크스페이스 소유자만 채널을 삭제할 수 있습니다.", 403)
        self._channel(owner_id, channel_id)
        if len(self.list_channels(owner_id)) <= 1:
            raise RequestError("마지막 채널은 삭제할 수 없습니다.", 409)
        with store.database() as db:
            db.execute("DELETE FROM chat_messages WHERE owner_id = ? AND channel_id = ?", (owner_id, channel_id))
            db.execute("DELETE FROM chat_channels WHERE owner_id = ? AND id = ?", (owner_id, channel_id))
        hub = self._hub(owner_id)
        with hub.lock:
            for c in hub.clients.values():
                if c.voice_channel == channel_id:
                    c.voice_channel = None
        self._broadcast(owner_id, {"type": "channels", "channels": self.list_channels(owner_id)})
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
