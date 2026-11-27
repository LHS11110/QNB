import json
import os
import secrets
import sqlite3
import time
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from .runtime import RequestError, digest

ACCOUNT_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    vm_id INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS account_profiles (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
    nickname TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    expires INTEGER NOT NULL,
    workspace_owner_id INTEGER REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS workspace_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    invitee_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (owner_id, invitee_email)
);
CREATE INDEX IF NOT EXISTS workspace_invites_email ON workspace_invites (invitee_email, status);
CREATE TABLE IF NOT EXISTS account_mfa (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    recovery_hashes TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    label TEXT NOT NULL,
    public_key TEXT NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys (account_id);
CREATE TABLE IF NOT EXISTS auth_challenges (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    account_id INTEGER,
    challenge TEXT NOT NULL,
    expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS qr_login_sessions (
    code TEXT PRIMARY KEY,
    poll_secret TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'consumed')),
    expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_axioms (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    dependencies TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, name),
    UNIQUE (account_id, node_id)
);
CREATE TABLE IF NOT EXISTS staged_files (
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    path TEXT NOT NULL,
    vm_id INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    disk_etag TEXT NOT NULL,
    disk_resource_id TEXT NOT NULL DEFAULT '',
    disk_text TEXT NOT NULL,
    staged_text TEXT NOT NULL,
    automerge_b64 TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (owner_id, path)
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    label TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    token_prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_tokens_account ON mcp_tokens (account_id);
"""

PROOF_SCHEMA = """
CREATE TABLE IF NOT EXISTS theorems (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, node_id)
);
CREATE INDEX IF NOT EXISTS theorem_name ON theorems (account_id, name);
CREATE TABLE IF NOT EXISTS lean_archives (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    prerequisites TEXT NOT NULL,
    bindings TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS lean_archive_statements (
    account_id INTEGER NOT NULL,
    archive_id TEXT NOT NULL,
    statements TEXT NOT NULL,
    PRIMARY KEY (account_id, archive_id),
    FOREIGN KEY (account_id, archive_id) REFERENCES lean_archives(account_id, id)
);
CREATE TABLE IF NOT EXISTS lean_symbols (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    FOREIGN KEY (account_id, archive_id) REFERENCES lean_archives(account_id, id),
    PRIMARY KEY (account_id, name, archive_id)
);
CREATE INDEX IF NOT EXISTS lean_symbol_short_name ON lean_symbols (account_id, short_name);
"""

SCHEMA = ACCOUNT_SCHEMA + PROOF_SCHEMA

PROOF_TABLES = {
    "theorems": ("account_id", "node_id"),
    "lean_archives": ("account_id", "id"),
    "lean_archive_statements": ("account_id", "archive_id"),
    "lean_symbols": ("account_id", "name", "archive_id"),
}

GRAPH_UPSERT = """
UNWIND $rows AS row
MERGE (n:Declaration {owner: $owner, id: row.id})
SET n.name = row.name, n.hash = row.hash, n.path = row.path, n.kind = 'theorem'
WITH n, row
UNWIND row.dependencies AS dep
MERGE (d:Declaration {owner: $owner, id: dep.id})
ON CREATE SET d.name = dep.name
SET d.kind = coalesce(dep.kind, 'theorem')
MERGE (n)-[:DEPENDS_ON]->(d)
"""

GRAPH_READ = """
MATCH (n:Declaration {owner: $owner})
WHERE n.id IN $ids
OPTIONAL MATCH (n)-[:DEPENDS_ON]->(d:Declaration {owner: $owner})
RETURN n { .id, .name, .hash, .path, .kind }, collect(d { .id, .name, .hash, .path, .kind })
ORDER BY n.name, n.id
"""


def database_path():
    return Path(os.environ.get("QNB_DATABASE", "data/qnb.sqlite3")).resolve()


@contextmanager
def database():
    location = database_path()
    location.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(location, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys = ON")
        with db:
            yield db
    finally:
        db.close()


def initialize():
    with database() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        db.execute("""
            INSERT OR IGNORE INTO account_profiles (account_id, nickname)
            SELECT id, CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE 'researcher' END
            FROM accounts
        """)
        session_cols = {row["name"] for row in db.execute("PRAGMA table_info(sessions)").fetchall()}
        if "workspace_owner_id" not in session_cols:
            db.execute("ALTER TABLE sessions ADD COLUMN workspace_owner_id INTEGER REFERENCES accounts(id)")
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'theorem_statements'").fetchone():
            initialize_theorem_statements(db)
        db.execute("""
            CREATE TABLE IF NOT EXISTS proof_sync_offsets (
                consumer TEXT PRIMARY KEY, sequence INTEGER NOT NULL
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS proof_sync_queue (
                sequence INTEGER PRIMARY KEY,
                table_name TEXT NOT NULL,
                row_key TEXT NOT NULL,
                queued_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS proof_sync_queue_table
            ON proof_sync_queue (table_name, sequence)
        """)
        for table, keys in PROOF_TABLES.items():
            trigger = f"queue_{table}_insert"
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (trigger,)).fetchone():
                db.execute(f"""
                    INSERT INTO proof_sync_queue (table_name, row_key, queued_at)
                    SELECT ?, json_array({", ".join(keys)}), 0 FROM {table} ORDER BY rowid
                """, (table,))
                new_key = ", ".join(f"NEW.{key}" for key in keys)
                db.execute(f"""
                    CREATE TRIGGER {trigger} AFTER INSERT ON {table}
                    BEGIN
                        INSERT INTO proof_sync_queue (table_name, row_key)
                        VALUES ('{table}', json_array({new_key}));
                    END
                """)


def _own_workspace(account):
    return {
        "owner_id": account["id"],
        "owner_email": account["email"],
        "vm_id": account["vm_id"],
        "shared": False,
    }


def resolve_workspace(db, account, token_hash=None, *, strict=False):
    owner_id = account["workspace_owner_id"] if "workspace_owner_id" in account.keys() else None
    if not owner_id or owner_id == account["id"]:
        return _own_workspace(account)
    row = db.execute("""
        SELECT o.id AS owner_id, o.email AS owner_email, o.vm_id
        FROM workspace_invites w
        JOIN accounts o ON o.id = w.owner_id
        WHERE w.owner_id = ? AND w.invitee_email = ? AND w.status = 'accepted'
    """, (owner_id, account["email"])).fetchone()
    if row:
        return {
            "owner_id": row["owner_id"],
            "owner_email": row["owner_email"],
            "vm_id": row["vm_id"],
            "shared": True,
        }
    if token_hash:
        db.execute("UPDATE sessions SET workspace_owner_id = ? WHERE token_hash = ?",
                   (account["id"], token_hash))
    if strict:
        raise RequestError("공유 워크스페이스 접근 권한이 해제되었습니다.", 403)
    return _own_workspace(account)


def pending_invite_count(db, email):
    row = db.execute("""
        SELECT count(*) AS cnt FROM workspace_invites
        WHERE invitee_email = ? AND status = 'pending'
    """, (email,)).fetchone()
    return int(row["cnt"]) if row else 0


def list_workspaces(account, active_workspace):
    with database() as db:
        shared_rows = db.execute("""
            SELECT o.id AS owner_id, o.email AS owner_email
            FROM workspace_invites w
            JOIN accounts o ON o.id = w.owner_id
            WHERE w.invitee_email = ? AND w.status = 'accepted'
            ORDER BY o.email
        """, (account["email"],)).fetchall()
        incoming_rows = db.execute("""
            SELECT w.owner_id, o.email AS owner_email, w.created_at
            FROM workspace_invites w
            JOIN accounts o ON o.id = w.owner_id
            WHERE w.invitee_email = ? AND w.status = 'pending'
            ORDER BY w.created_at DESC
        """, (account["email"],)).fetchall()
        member_rows = db.execute("""
            SELECT w.invitee_email AS email, w.status, w.created_at,
                   EXISTS(SELECT 1 FROM accounts a WHERE a.email = w.invitee_email) AS registered
            FROM workspace_invites w
            WHERE w.owner_id = ? AND w.status IN ('pending', 'accepted')
            ORDER BY CASE w.status WHEN 'accepted' THEN 0 ELSE 1 END, w.invitee_email
        """, (account["id"],)).fetchall()
    workspaces = [{"ownerId": account["id"], "ownerEmail": account["email"], "shared": False}]
    workspaces.extend(
        {"ownerId": row["owner_id"], "ownerEmail": row["owner_email"], "shared": True}
        for row in shared_rows
    )
    return {
        "current": {
            "ownerId": active_workspace["owner_id"],
            "ownerEmail": active_workspace["owner_email"],
            "shared": active_workspace["shared"],
        },
        "workspaces": workspaces,
        "incoming": [
            {"ownerId": row["owner_id"], "ownerEmail": row["owner_email"], "createdAt": row["created_at"]}
            for row in incoming_rows
        ],
        "members": [
            {
                "email": row["email"],
                "status": row["status"],
                "registered": bool(row["registered"]),
                "createdAt": row["created_at"],
            }
            for row in member_rows
        ],
    }


def invite_member(owner_account, invitee_email):
    if invitee_email == owner_account["email"]:
        raise RequestError("자신의 계정은 이미 워크스페이스 소유자입니다.")
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("""
            SELECT status FROM workspace_invites WHERE owner_id = ? AND invitee_email = ?
        """, (owner_account["id"], invitee_email)).fetchone()
        if existing:
            if existing["status"] == "accepted":
                raise RequestError("이미 워크스페이스에 참여한 사용자입니다.", 409)
            if existing["status"] == "pending":
                raise RequestError("이미 초대를 보낸 이메일입니다.", 409)
            db.execute("""
                UPDATE workspace_invites
                SET status = 'pending', created_at = unixepoch()
                WHERE owner_id = ? AND invitee_email = ?
            """, (owner_account["id"], invitee_email))
        else:
            db.execute("""
                INSERT INTO workspace_invites (owner_id, invitee_email, status)
                VALUES (?, ?, 'pending')
            """, (owner_account["id"], invitee_email))
    return {"invited": invitee_email, "status": "pending"}


def respond_invite(account, owner_id, accept):
    new_status = "accepted" if accept else "declined"
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("""
            SELECT status FROM workspace_invites
            WHERE owner_id = ? AND invitee_email = ?
        """, (owner_id, account["email"])).fetchone()
        if not row:
            raise RequestError("워크스페이스 초대를 찾을 수 없습니다.", 404)
        if row["status"] != "pending":
            raise RequestError("이미 처리된 초대입니다.", 409)
        db.execute("""
            UPDATE workspace_invites SET status = ?
            WHERE owner_id = ? AND invitee_email = ?
        """, (new_status, owner_id, account["email"]))
    return {"ownerId": owner_id, "status": new_status}


def select_workspace(token_hash, account, owner_id):
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        if owner_id == account["id"]:
            workspace = _own_workspace(account)
        else:
            row = db.execute("""
                SELECT o.id AS owner_id, o.email AS owner_email, o.vm_id
                FROM workspace_invites w
                JOIN accounts o ON o.id = w.owner_id
                WHERE w.owner_id = ? AND w.invitee_email = ? AND w.status = 'accepted'
            """, (owner_id, account["email"])).fetchone()
            if not row:
                raise RequestError("접근 가능한 공유 워크스페이스가 아닙니다.", 403)
            workspace = {
                "owner_id": row["owner_id"],
                "owner_email": row["owner_email"],
                "vm_id": row["vm_id"],
                "shared": True,
            }
        db.execute("UPDATE sessions SET workspace_owner_id = ? WHERE token_hash = ?",
                   (workspace["owner_id"], token_hash))
    return {
        "ownerId": workspace["owner_id"],
        "ownerEmail": workspace["owner_email"],
        "shared": workspace["shared"],
    }


def remove_workspace_member(account, *, email=None, owner_id=None):
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        if email is not None:
            deleted = db.execute("""
                DELETE FROM workspace_invites WHERE owner_id = ? AND invitee_email = ?
            """, (account["id"], email)).rowcount
            if not deleted:
                raise RequestError("초대 또는 멤버를 찾을 수 없습니다.", 404)
            target = db.execute("SELECT id FROM accounts WHERE email = ?", (email,)).fetchone()
            if target:
                db.execute("""
                    UPDATE sessions SET workspace_owner_id = account_id
                    WHERE account_id = ? AND workspace_owner_id = ?
                """, (target["id"], account["id"]))
            return {"removed": email}
        if owner_id is None or owner_id == account["id"]:
            raise RequestError("본인 워크스페이스에서는 나갈 수 없습니다.")
        deleted = db.execute("""
            DELETE FROM workspace_invites WHERE owner_id = ? AND invitee_email = ?
        """, (owner_id, account["email"])).rowcount
        if not deleted:
            raise RequestError("참여 중인 공유 워크스페이스를 찾을 수 없습니다.", 404)
        db.execute("""
            UPDATE sessions SET workspace_owner_id = account_id
            WHERE account_id = ? AND workspace_owner_id = ?
        """, (account["id"], owner_id))
        return {"left": owner_id}


def update_nickname(account_id, nickname):
    with database() as db:
        db.execute("""
            INSERT INTO account_profiles (account_id, nickname) VALUES (?, ?)
            ON CONFLICT(account_id) DO UPDATE SET nickname = excluded.nickname
        """, (account_id, nickname))
    return {"nickname": nickname}


def get_nickname(account_id, fallback_email=""):
    with database() as db:
        row = db.execute("SELECT nickname FROM account_profiles WHERE account_id = ?", (account_id,)).fetchone()
    if row and row["nickname"]:
        return row["nickname"]
    return (fallback_email.split("@", 1)[0] or "researcher")[:32]


def security_overview(account_id):
    with database() as db:
        mfa = db.execute("SELECT enabled FROM account_mfa WHERE account_id = ?", (account_id,)).fetchone()
        keys = db.execute("""
            SELECT credential_id AS id, label, created_at AS createdAt
            FROM passkeys WHERE account_id = ? ORDER BY created_at DESC
        """, (account_id,)).fetchall()
    return {
        "mfaEnabled": bool(mfa and mfa["enabled"]),
        "passkeys": [dict(row) for row in keys],
    }


def save_mfa_secret(account_id, secret):
    with database() as db:
        db.execute("""
            INSERT INTO account_mfa (account_id, secret, enabled, recovery_hashes, updated_at)
            VALUES (?, ?, 0, '[]', unixepoch())
            ON CONFLICT(account_id) DO UPDATE SET
                secret = excluded.secret,
                enabled = CASE WHEN account_mfa.enabled = 1 THEN 1 ELSE 0 END,
                updated_at = unixepoch()
        """, (account_id, secret))


def get_mfa_record(account_id):
    with database() as db:
        return db.execute("SELECT * FROM account_mfa WHERE account_id = ?", (account_id,)).fetchone()


def enable_mfa(account_id, recovery_hashes):
    with database() as db:
        db.execute("""
            UPDATE account_mfa SET enabled = 1, recovery_hashes = ?, updated_at = unixepoch()
            WHERE account_id = ?
        """, (json.dumps(recovery_hashes), account_id))


def disable_mfa(account_id):
    with database() as db:
        db.execute("DELETE FROM account_mfa WHERE account_id = ?", (account_id,))


def consume_recovery_code(account_id, hashed_code):
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT recovery_hashes FROM account_mfa WHERE account_id = ? AND enabled = 1", (account_id,)).fetchone()
        if not row:
            return False
        hashes_list = json.loads(row["recovery_hashes"])
        if hashed_code not in hashes_list:
            return False
        hashes_list.remove(hashed_code)
        db.execute("UPDATE account_mfa SET recovery_hashes = ?, updated_at = unixepoch() WHERE account_id = ?",
                   (json.dumps(hashes_list), account_id))
        return True


def create_challenge(kind, challenge, account_id=None, ttl=300):
    token = secrets.token_urlsafe(24)
    now = int(time.time())
    with database() as db:
        db.execute("DELETE FROM auth_challenges WHERE expires <= ?", (now,))
        db.execute("INSERT INTO auth_challenges (token, kind, account_id, challenge, expires) VALUES (?, ?, ?, ?, ?)",
                   (token, kind, account_id, challenge, now + ttl))
    return token


def consume_challenge(token, kind):
    now = int(time.time())
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM auth_challenges WHERE token = ? AND kind = ? AND expires > ?",
                         (token, kind, now)).fetchone()
        if not row:
            return None
        db.execute("DELETE FROM auth_challenges WHERE token = ?", (token,))
        return dict(row)


def add_passkey(account_id, credential_id, label, public_key, sign_count):
    with database() as db:
        db.execute("""
            INSERT INTO passkeys (credential_id, account_id, label, public_key, sign_count)
            VALUES (?, ?, ?, ?, ?)
        """, (credential_id, account_id, label, public_key, sign_count))


def list_passkeys(account_id=None):
    with database() as db:
        if account_id is None:
            return db.execute("SELECT credential_id, account_id, label FROM passkeys").fetchall()
        return db.execute("SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at DESC", (account_id,)).fetchall()


def get_passkey(credential_id):
    with database() as db:
        return db.execute("""
            SELECT p.*, a.email, COALESCE(ap.nickname, '') AS nickname, a.vm_id
            FROM passkeys p
            JOIN accounts a ON a.id = p.account_id
            LEFT JOIN account_profiles ap ON ap.account_id = a.id
            WHERE p.credential_id = ?
        """, (credential_id,)).fetchone()


def update_passkey_count(credential_id, sign_count):
    with database() as db:
        db.execute("UPDATE passkeys SET sign_count = ? WHERE credential_id = ?", (sign_count, credential_id))


def delete_passkey(account_id, credential_id):
    with database() as db:
        deleted = db.execute("DELETE FROM passkeys WHERE account_id = ? AND credential_id = ?",
                             (account_id, credential_id)).rowcount
    if not deleted:
        raise RequestError("패스키를 찾을 수 없습니다.", 404)


def start_qr_session(ttl=180):
    code = secrets.token_urlsafe(24)
    poll_secret = secrets.token_urlsafe(24)
    now = int(time.time())
    with database() as db:
        db.execute("DELETE FROM qr_login_sessions WHERE expires <= ?", (now,))
        db.execute("""
            INSERT INTO qr_login_sessions (code, poll_secret, status, expires)
            VALUES (?, ?, 'pending', ?)
        """, (code, digest(poll_secret), now + ttl))
    return code, poll_secret


def approve_qr_session(code, account_id):
    now = int(time.time())
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM qr_login_sessions WHERE code = ? AND expires > ?", (code, now)).fetchone()
        if not row:
            raise RequestError("만료되었거나 유효하지 않은 QR 로그인 코드입니다.", 404)
        if row["status"] != "pending":
            raise RequestError("이미 처리된 QR 로그인 요청입니다.", 409)
        db.execute("UPDATE qr_login_sessions SET account_id = ?, status = 'approved' WHERE code = ?",
                   (account_id, code))


def poll_qr_session(code, poll_secret):
    now = int(time.time())
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM qr_login_sessions WHERE code = ? AND expires > ?", (code, now)).fetchone()
        if not row or row["poll_secret"] != digest(poll_secret):
            raise RequestError("유효하지 않거나 만료된 QR 세션입니다.", 404)
        if row["status"] == "pending":
            return None
        if row["status"] == "consumed":
            raise RequestError("이미 사용된 QR 세션입니다.", 409)
        account = db.execute("SELECT * FROM accounts WHERE id = ?", (row["account_id"],)).fetchone()
        if not account:
            raise RequestError("계정을 찾을 수 없습니다.", 404)
        db.execute("UPDATE qr_login_sessions SET status = 'consumed' WHERE code = ?", (code,))
        return account


def save_axioms(owner_id, axiom_rows, definitions, document, entries, imported):
    if not axiom_rows:
        return []
    prerequisites = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    archive = digest(json.dumps(["axiom", document, entries, imported], ensure_ascii=False, sort_keys=True))
    bindings = dict(imported)
    saved = []
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        for row in axiom_rows:
            node_id = row["id"]
            bindings[row["name"]] = node_id
            db.execute("""
                INSERT INTO workspace_axioms (account_id, node_id, name, content_hash, source, dependencies)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id, name) DO UPDATE SET
                    node_id = excluded.node_id,
                    content_hash = excluded.content_hash,
                    source = excluded.source,
                    dependencies = excluded.dependencies,
                    created_at = CURRENT_TIMESTAMP
            """, (owner_id, node_id, row["name"], row["hash"], row["source"],
                  json.dumps(row["dependencies"], ensure_ascii=False)))
            saved.append({"nodeId": node_id, "name": row["name"], "hash": row["hash"], "source": row["source"]})
        db.execute("INSERT OR IGNORE INTO lean_archives VALUES (?, ?, ?, ?, ?)",
                   (owner_id, archive, document, prerequisites, json.dumps(bindings, ensure_ascii=False)))
        db.execute("INSERT OR IGNORE INTO lean_archive_statements VALUES (?, ?, ?)",
                   (owner_id, archive, "[]"))
        db.executemany("INSERT OR IGNORE INTO lean_symbols VALUES (?, ?, ?, ?)", [
            (owner_id, row["name"], row["name"].rsplit(".", 1)[-1], archive)
            for row in axiom_rows + definitions if not row["name"].startswith("_private.")
        ])
    return saved


def list_axioms(owner_id):
    with database() as db:
        rows = db.execute("""
            SELECT node_id AS nodeId, name, content_hash AS hash, source, created_at AS createdAt
            FROM workspace_axioms WHERE account_id = ? ORDER BY name
        """, (owner_id,)).fetchall()
    return [dict(row) for row in rows]


def delete_axiom(owner_id, name):
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        deleted = db.execute("DELETE FROM workspace_axioms WHERE account_id = ? AND name = ?", (owner_id, name)).rowcount
        if not deleted:
            raise RequestError("등록된 공리를 찾을 수 없습니다.", 404)
        db.execute("DELETE FROM lean_symbols WHERE account_id = ? AND name = ?", (owner_id, name))
    return {"deleted": name}


def create_mcp_token(account_id, label):
    clean_label = (label or "CLI Agent").strip()[:48] or "CLI Agent"
    raw_token = "qnb_mcp_" + secrets.token_urlsafe(24)
    token_hash = digest(raw_token)
    prefix = raw_token[:16]
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        cur = db.execute(
            "INSERT INTO mcp_tokens (account_id, label, token_hash, token_prefix) VALUES (?, ?, ?, ?)",
            (account_id, clean_label, token_hash, prefix),
        )
        token_id = cur.lastrowid
    return {"id": token_id, "label": clean_label, "prefix": prefix, "token": raw_token}


def list_mcp_tokens(account_id):
    with database() as db:
        rows = db.execute("""
            SELECT id, label, token_prefix AS prefix, created_at AS createdAt, last_used_at AS lastUsedAt
            FROM mcp_tokens WHERE account_id = ? ORDER BY created_at DESC, id DESC
        """, (account_id,)).fetchall()
    return [dict(row) for row in rows]


def delete_mcp_token(account_id, token_id):
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        deleted = db.execute("DELETE FROM mcp_tokens WHERE id = ? AND account_id = ?", (token_id, account_id)).rowcount
    if not deleted:
        raise RequestError("MCP 토큰을 찾을 수 없습니다.", 404)
    return {"deleted": token_id}


def authenticate_mcp_token(raw_token, workspace_owner_id=None):
    if not isinstance(raw_token, str) or not raw_token.startswith("qnb_mcp_"):
        return None, None
    token_hash = digest(raw_token.strip())
    with database() as db:
        row = db.execute("""
            SELECT a.*, COALESCE(ap.nickname, '') AS nickname, t.id AS token_id
            FROM mcp_tokens t
            JOIN accounts a ON a.id = t.account_id
            LEFT JOIN account_profiles ap ON ap.account_id = a.id
            WHERE t.token_hash = ?
        """, (token_hash,)).fetchone()
        if not row:
            return None, None
        db.execute("UPDATE mcp_tokens SET last_used_at = unixepoch() WHERE id = ?", (row["token_id"],))
        account_dict = dict(row)
        target_owner = account_dict["id"] if workspace_owner_id is None else int(workspace_owner_id)
        account_dict["workspace_owner_id"] = target_owner
        workspace_info = resolve_workspace(db, account_dict, None, strict=True)
        return row, workspace_info


def statement_fingerprint(statement):
    if not statement or "type" not in statement:
        return None
    levels = {name: index for index, name in enumerate(statement["levelParams"])}

    def normalize(term):
        if isinstance(term, list):
            return [normalize(item) for item in term]
        if not isinstance(term, dict):
            return term
        if "mdata" in term:
            return normalize(term["mdata"]["expr"])
        if "param" in term:
            return {"param": levels[term["param"]]}
        if "letE" in term:
            return {"letE": {key: normalize(value) for key, value in term["letE"].items()
                             if key not in ("declName", "nonDep")}}
        return {key: normalize(value) for key, value in term.items()
                if key not in ("binderName", "binderInfo")}

    return digest(json.dumps([len(levels), normalize(statement["type"])], sort_keys=True))


def statement_key(statement, fingerprint, archive_id):
    # Local constants with the same name can denote different definitions in different notebooks.
    if statement.get("needsContext", True):
        return digest(json.dumps([archive_id, fingerprint]))
    return fingerprint


def initialize_theorem_statements(db):
    db.execute("""
        CREATE TABLE theorem_statements (
            account_id INTEGER NOT NULL,
            statement_key TEXT NOT NULL,
            node_id TEXT NOT NULL,
            PRIMARY KEY (account_id, statement_key),
            FOREIGN KEY (account_id, node_id) REFERENCES theorems(account_id, node_id)
        )
    """)
    archives = db.execute("""
        SELECT a.account_id, a.id, a.bindings, t.statements
        FROM lean_archives a JOIN lean_archive_statements t
          ON a.account_id = t.account_id AND a.id = t.archive_id
        ORDER BY a.rowid
    """)
    for archive in archives:
        bindings = json.loads(archive["bindings"])
        for item in json.loads(archive["statements"]):
            statement = item["statement"]
            if fingerprint := statement_fingerprint(statement):
                key = statement_key(statement, fingerprint, archive["id"])
                db.execute("""
                    INSERT OR IGNORE INTO theorem_statements
                    SELECT account_id, ?, node_id FROM theorems WHERE account_id = ? AND node_id = ?
                """, (key, archive["account_id"], bindings.get(statement["name"])))


def save_declarations(account_id, file_path, rows, definitions, document, entries, imported):
    if not (rows or definitions):
        return []
    prerequisites = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    archive = digest(json.dumps([document, entries, imported], ensure_ascii=False, sort_keys=True))
    statements = [{"span": row["span"], "statement": row["statement"]} for row in rows]
    inserted = []
    aliases = {}
    bindings = dict(imported)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        for row in rows:
            statement = row["statement"]
            fingerprint = statement_fingerprint(statement)
            key = statement_key(statement, fingerprint, archive) if fingerprint else None
            existing = db.execute("""
                SELECT t.node_id, t.name FROM theorem_statements s JOIN theorems t USING (account_id, node_id)
                WHERE s.account_id = ? AND s.statement_key = ?
            """, (account_id, key)).fetchone() if key else None
            if existing:
                aliases[row["id"]] = {"id": existing["node_id"], "name": existing["name"]}
                bindings[row["name"]] = existing["node_id"]
                continue
            node_id = digest(json.dumps([row["id"], fingerprint])) if fingerprint else row["id"]
            dependencies = {}
            for dep in row["dependencies"]:
                target = aliases.get(dep["id"], dep)
                if target["id"] != node_id:
                    dependencies[target["id"]] = target
            deps = list(dependencies.values())
            result = db.execute("""
                INSERT OR IGNORE INTO theorems
                (account_id, node_id, name, content_hash, source, path, dependencies)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (account_id, node_id, row["name"], row["hash"], row["source"], file_path,
                  json.dumps(deps, ensure_ascii=False)))
            bindings[row["name"]] = node_id
            aliases[row["id"]] = {"id": node_id, "name": row["name"]}
            if key:
                db.execute("INSERT INTO theorem_statements VALUES (?, ?, ?)", (account_id, key, node_id))
            if result.rowcount:
                inserted.append(row | {"id": node_id, "dependencies": deps, "path": file_path})
        db.execute("INSERT OR IGNORE INTO lean_archives VALUES (?, ?, ?, ?, ?)",
                   (account_id, archive, document, prerequisites, json.dumps(bindings, ensure_ascii=False)))
        db.execute("INSERT OR IGNORE INTO lean_archive_statements VALUES (?, ?, ?)",
                   (account_id, archive, json.dumps(statements, ensure_ascii=False)))
        db.executemany("INSERT OR IGNORE INTO lean_symbols VALUES (?, ?, ?, ?)", [
            (account_id, row["name"], row["name"].rsplit(".", 1)[-1], archive)
            for row in rows + definitions if not row["name"].startswith("_private.")
        ])
    return inserted


def masked_archive_source(source, statements):
    # Older snapshots stored spaces in place of theorem proofs.
    lines = [list(line) for line in source.split("\n")]
    for row in statements:
        start, start_col, end, end_col = row["span"]
        for line in range(start - 1, end):
            left = start_col if line == start - 1 else 0
            right = end_col if line == end - 1 else len(lines[line])
            lines[line][left:right] = " " * (right - left)
    return "\n".join("".join(line) for line in lines)


def archive_entry(name, source, prerequisites, *, is_axiom=False):
    entry = {"name": name, "source": source, "prerequisites": prerequisites, "line": 1, "statements": []}
    if is_axiom:
        entry["isAxiom"] = True
    return {"entry": entry}


def restore_archive_source(db, account_id, snapshot):
    entry = snapshot["entry"]
    source = entry["source"]
    if entry["statements"]:
        candidates = set()
        for row in db.execute("""
            SELECT a.source, typed.statements, a.prerequisites
            FROM lean_symbols s JOIN lean_archives a
              ON a.account_id = s.account_id AND a.id = s.archive_id
            JOIN lean_archive_statements typed
              ON typed.account_id = a.account_id AND typed.archive_id = a.id
            WHERE s.account_id = ? AND s.name = ?
        """, (account_id, entry["name"])):
            statements = json.loads(row["statements"])
            if ([item["statement"] for item in statements] == entry["statements"]
                    and json.loads(row["prerequisites"]) == entry["prerequisites"]
                    and masked_archive_source(row["source"], statements) == source):
                candidates.add(row["source"])
        if len(candidates) != 1:
            raise RequestError(f"저장된 선언 {entry['name']}의 증명 원본을 확인할 수 없습니다. 원본 셀을 다시 실행하세요.", 409)
        source = candidates.pop()
    prerequisites = [restore_archive_source(db, account_id, item) for item in entry["prerequisites"]]
    return {"entry": entry | {"source": source, "prerequisites": prerequisites, "statements": []}}


def lookup_declaration(account_id, name):
    with database() as db:
        query = """
            SELECT s.name, a.source, a.prerequisites, a.bindings, typed.statements
            FROM lean_symbols s JOIN lean_archives a
              ON a.account_id = s.account_id AND a.id = s.archive_id
            JOIN lean_archive_statements typed
              ON typed.account_id = a.account_id AND typed.archive_id = a.id
            WHERE s.account_id = ?
        """
        record = db.execute(query + " AND s.name = ? ORDER BY s.rowid DESC LIMIT 1",
                            (account_id, name)).fetchone()
        if not record and "." not in name:
            matches = db.execute("""
                SELECT DISTINCT name FROM lean_symbols
                WHERE account_id = ? AND short_name = ? LIMIT 2
            """, (account_id, name)).fetchall()
            if len(matches) == 1:
                record = db.execute(query + " AND s.name = ? ORDER BY s.rowid DESC LIMIT 1",
                                    (account_id, matches[0]["name"])).fetchone()
        parent = name
        while not record and "." in parent:
            parent = parent.rsplit(".", 1)[0]
            record = db.execute(query + " AND s.name = ? ORDER BY s.rowid DESC LIMIT 1",
                                (account_id, parent)).fetchone()
        if record:
            prerequisites = [restore_archive_source(db, account_id, item)
                             for item in json.loads(record["prerequisites"])]
            is_axiom = bool(db.execute(
                "SELECT 1 FROM workspace_axioms WHERE account_id = ? AND name = ?",
                (account_id, record["name"]),
            ).fetchone())
            entry = archive_entry(record["name"], record["source"], prerequisites, is_axiom=is_axiom)
            return entry, json.loads(record["bindings"])
        legacy = db.execute("""
            SELECT 1 FROM lean_symbols WHERE account_id = ? AND name = ?
            UNION ALL
            SELECT 1 FROM theorems WHERE account_id = ? AND name = ?
        """, (account_id, name, account_id, name)).fetchone()
        if legacy:
            return None, {}
        return None


def graph_query(statement, **parameters):
    endpoint = os.environ.get("QNB_NEO4J_URL", "http://neo4j:7474").rstrip("/")
    request = Request(endpoint + "/db/neo4j/query/v2", data=json.dumps({
        "statement": statement, "parameters": parameters,
    }).encode(), headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=5) as response:
            data = json.load(response)
        if data.get("errors"):
            raise ValueError(data["errors"])
        return data["data"]["values"]
    except (URLError, TimeoutError, KeyError, TypeError, ValueError) as error:
        raise RequestError("그래프 DB에 연결할 수 없습니다. 저장된 정리는 연결이 복구되면 다시 표시됩니다.", 503) from error


def project(owner, rows):
    if not rows:
        return
    graph_query("CREATE CONSTRAINT qnb_owner_id IF NOT EXISTS FOR (n:Declaration) REQUIRE (n.owner, n.id) IS UNIQUE")
    graph_query(GRAPH_UPSERT, owner=owner, rows=rows)


def proof_tree(owner, page, root_id, limit, max_depth):
    with database() as db:
        catalog = db.execute("""
            SELECT node_id AS id, name FROM theorems
            WHERE account_id = ? ORDER BY rowid DESC LIMIT 26 OFFSET ?
        """, (owner, page * 25)).fetchall()
        result = {"theorems": [dict(row) for row in catalog[:25]], "hasMore": len(catalog) > 25,
                  "root": None, "nodes": [], "edges": [], "limitedBy": []}
        if root_id is None:
            if not catalog:
                return result
            root_id = catalog[0]["id"]

        def load(node_id):
            row = db.execute("""
                SELECT node_id AS id, name, content_hash AS hash, path, dependencies
                FROM theorems WHERE account_id = ? AND node_id = ?
            """, (owner, node_id)).fetchone()
            if row is not None:
                node = dict(row)
                dependencies = json.loads(node.pop("dependencies"))
                return node | {"kind": "theorem"}, dependencies
            ax = db.execute("""
                SELECT node_id AS id, name, content_hash AS hash, dependencies
                FROM workspace_axioms WHERE account_id = ? AND node_id = ?
            """, (owner, node_id)).fetchone()
            if ax is not None:
                node = dict(ax)
                dependencies = json.loads(node.pop("dependencies"))
                return node | {"path": "워크스페이스 공리", "kind": "axiom"}, dependencies
            return None, []

        root, dependencies = load(root_id)
        if root is None:
            raise RequestError("저장된 정리를 찾을 수 없습니다.", 404)
        nodes = {root_id: root | {"depth": 0}}
        pending = deque([(root_id, 0, dependencies)])
        edges = {}
        external = []
        limited = set()
        while pending:
            source, depth, dependencies = pending.popleft()
            if depth == max_depth:
                if dependencies:
                    limited.add("depth")
                continue
            for dependency in dependencies:
                target = dependency["id"]
                if target.startswith(("axiom:", "external:")):
                    external.append((source, depth + 1, dependency))
                    continue
                if target not in nodes:
                    if len(nodes) == limit:
                        limited.add("nodes")
                        continue
                    node, children = load(target)
                    nodes[target] = (node or {
                        "id": target, "name": dependency["name"], "kind": dependency.get("kind", "theorem"),
                    }) | {"depth": depth + 1}
                    if children:
                        pending.append((target, depth + 1, children))
                edges[source, target] = {"from": source, "to": target}
        # Keep the saved proof chain visible when imported lemmas exhaust the node budget.
        for source, depth, dependency in external:
            target = dependency["id"]
            if target not in nodes:
                if len(nodes) == limit:
                    limited.add("nodes")
                    continue
                nodes[target] = dependency | {"kind": dependency.get("kind", "theorem"), "depth": depth}
            edges[source, target] = {"from": source, "to": target}
        return result | {"root": root_id, "nodes": list(nodes.values()), "edges": list(edges.values()),
                         "limitedBy": sorted(limited)}


def dependency_graph(owner, page):
    with database() as db:
        records = db.execute("""
            SELECT node_id AS id, name, content_hash AS hash, path, dependencies
            FROM theorems WHERE account_id = ?
            ORDER BY rowid DESC LIMIT 26 OFFSET ?
        """, (owner, page * 25)).fetchall()
        if not records:
            return {"nodes": [], "edges": [], "hasMore": False}
        rows = [dict(record) for record in records[:25]]
        for row in rows:
            row["dependencies"] = json.loads(row["dependencies"])

        # Rehydrate dependency metadata after a graph restart or rebuild.
        linked = {dep["id"] for row in rows for dep in row["dependencies"]
                  if dep.get("kind") != "axiom" and not dep["id"].startswith("external:")}
        for dependency in linked - {row["id"] for row in rows}:
            record = db.execute("""
                SELECT node_id AS id, name, content_hash AS hash, path
                FROM theorems WHERE account_id = ? AND node_id = ?
            """, (owner, dependency)).fetchone()
            if record:
                graph_row = dict(record) | {"dependencies": []}
                graph_row["primary"] = False
                rows.append(graph_row)
    project(owner, rows)
    ids = [row["id"] for row in rows if row.get("primary", True)]
    nodes, edges = {}, []
    for node, dependencies in graph_query(GRAPH_READ, owner=owner, ids=ids):
        nodes[node["id"]] = node | {"primary": True}
        for dependency in dependencies:
            nodes.setdefault(dependency["id"], dependency)
            edges.append({"from": node["id"], "to": dependency["id"]})
    return {"nodes": list(nodes.values()), "edges": edges, "hasMore": len(records) > 25}
