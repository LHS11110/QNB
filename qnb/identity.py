"""User identity: nickname#tag handles and email verification.

Nicknames may repeat; a 4-digit tag (Discord style) keeps every handle unique.
Email verification proves ownership of the address that invites are sent to.
"""

import hashlib
import hmac
import os
import re
import secrets
import time

from . import store
from .runtime import RequestError

HANDLE = re.compile(r"^(?P<nickname>[^#\x00-\x1f\x7f]{1,32})#(?P<tag>\d{4})$")
CODE_TTL = 30 * 60
RESEND_INTERVAL = 60
MAX_SENDS_PER_HOUR = 5
MAX_ATTEMPTS = 6


def initialize():
    with store.database() as db:
        db.execute("BEGIN IMMEDIATE")
        profile_cols = {row["name"] for row in db.execute("PRAGMA table_info(account_profiles)")}
        if "tag" not in profile_cols:
            db.execute("ALTER TABLE account_profiles ADD COLUMN tag TEXT")
        account_cols = {row["name"] for row in db.execute("PRAGMA table_info(accounts)")}
        if "email_verified" not in account_cols:
            # Accounts that existed before verification was introduced are grandfathered in.
            db.execute("ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1")
            db.execute("ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER")
        db.execute("""
            CREATE TABLE IF NOT EXISTS email_verifications (
                account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
                code_hash TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                sent_at INTEGER NOT NULL,
                send_log TEXT NOT NULL DEFAULT ''
            )
        """)
        db.execute("""
            INSERT OR IGNORE INTO account_profiles (account_id, nickname)
            SELECT id, CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE 'researcher' END
            FROM accounts
        """)
        for row in db.execute("SELECT account_id, nickname FROM account_profiles WHERE tag IS NULL OR tag = ''").fetchall():
            db.execute("UPDATE account_profiles SET tag = ? WHERE account_id = ?",
                       (free_tag(db, row["nickname"]), row["account_id"]))
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_handle ON account_profiles (lower(nickname), tag)")


def free_tag(db, nickname, preferred=None):
    taken = {row["tag"] for row in db.execute(
        "SELECT tag FROM account_profiles WHERE lower(nickname) = lower(?) AND tag IS NOT NULL", (nickname,))}
    if preferred and preferred not in taken:
        return preferred
    if len(taken) >= 9000:
        raise RequestError("이 닉네임은 더 이상 사용할 수 없습니다. 다른 닉네임을 선택하세요.", 409)
    while True:
        tag = f"{secrets.randbelow(9000) + 1000}"
        if tag not in taken:
            return tag


def handle(nickname, tag):
    return f"{nickname}#{tag}" if tag else nickname


def create_profile(db, account_id, nickname):
    db.execute("INSERT INTO account_profiles (account_id, nickname, tag) VALUES (?, ?, ?)",
               (account_id, nickname, free_tag(db, nickname)))


def update_nickname(account_id, nickname):
    with store.database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT nickname, tag FROM account_profiles WHERE account_id = ?", (account_id,)).fetchone()
        if row and row["tag"] and row["nickname"].lower() == nickname.lower():
            tag = row["tag"]  # same name (maybe different case): keep the handle
        else:
            # Keep the current tag when the new nickname still has it free.
            tag = free_tag(db, nickname, preferred=row["tag"] if row else None)
        db.execute("""
            INSERT INTO account_profiles (account_id, nickname, tag) VALUES (?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET nickname = excluded.nickname, tag = excluded.tag
        """, (account_id, nickname, tag))
    return {"nickname": nickname, "tag": tag, "handle": handle(nickname, tag)}


def profile(account_id):
    with store.database() as db:
        row = db.execute("SELECT nickname, tag FROM account_profiles WHERE account_id = ?", (account_id,)).fetchone()
    return (row["nickname"], row["tag"]) if row else ("", "")


def find_by_handle(text):
    match = HANDLE.fullmatch(text.strip()) if isinstance(text, str) else None
    if not match:
        return None
    with store.database() as db:
        return db.execute("""
            SELECT a.id, a.email, p.nickname, p.tag FROM account_profiles p JOIN accounts a ON a.id = p.account_id
            WHERE lower(p.nickname) = lower(?) AND p.tag = ?
        """, (match["nickname"].strip(), match["tag"])).fetchone()


def workspace_account_name(owner_id, account_id):
    """Terminal account name: the nickname, plus #tag only when it clashes inside this workspace."""
    with store.database() as db:
        rows = db.execute("""
            SELECT a.id, p.nickname, p.tag FROM accounts a JOIN account_profiles p ON p.account_id = a.id
            WHERE a.id = ? OR a.email IN (
                SELECT invitee_email FROM workspace_invites WHERE owner_id = ? AND status = 'accepted')
        """, (owner_id, owner_id)).fetchall()
        me = next((r for r in rows if r["id"] == account_id), None)
        if me is None:
            me = db.execute("SELECT ? AS id, nickname, tag FROM account_profiles WHERE account_id = ?",
                            (account_id, account_id)).fetchone()
    if me is None:
        return f"user{account_id}"
    clash = any(r["id"] != account_id and r["nickname"].lower() == me["nickname"].lower() for r in rows)
    return handle(me["nickname"], me["tag"]) if clash else me["nickname"]


# ---------------- email verification ----------------

def _pepper():
    return os.environ.get("QNB_SECRET_KEY") or "qnb-email-verification"


def _hash(value):
    return hmac.new(_pepper().encode(), value.encode(), hashlib.sha256).hexdigest()


def is_verified(account):
    return "email_verified" not in account.keys() or bool(account["email_verified"])


def issue_code(account_id, *, force=False):
    """Create (or rotate) a verification code + link token. Returns (code, token) or raises on rate limit."""
    now = int(time.time())
    with store.database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM email_verifications WHERE account_id = ?", (account_id,)).fetchone()
        history = [int(x) for x in (row["send_log"].split(",") if row and row["send_log"] else []) if int(x) > now - 3600]
        if row and not force:
            wait = row["sent_at"] + RESEND_INTERVAL - now
            if wait > 0:
                raise RequestError(f"{wait}초 후에 다시 보낼 수 있습니다.", 429)
        if len(history) >= MAX_SENDS_PER_HOUR:
            raise RequestError("인증 메일을 너무 자주 요청했습니다. 1시간 후에 다시 시도하세요.", 429)
        code = f"{secrets.randbelow(1_000_000):06d}"
        token = secrets.token_urlsafe(32)
        history.append(now)
        db.execute("""
            INSERT INTO email_verifications (account_id, code_hash, token_hash, expires, attempts, sent_at, send_log)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash, token_hash = excluded.token_hash,
                expires = excluded.expires, attempts = 0, sent_at = excluded.sent_at, send_log = excluded.send_log
        """, (account_id, _hash(code), _hash(token), now + CODE_TTL, now, ",".join(map(str, history))))
    return code, token


def _mark_verified(db, account_id):
    db.execute("UPDATE accounts SET email_verified = 1, email_verified_at = unixepoch() WHERE id = ?", (account_id,))
    db.execute("DELETE FROM email_verifications WHERE account_id = ?", (account_id,))


def verify_code(account_id, code):
    if not isinstance(code, str) or not re.fullmatch(r"\s*\d{6}\s*", code):
        raise RequestError("6자리 인증 코드를 입력하세요.")
    with store.database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM email_verifications WHERE account_id = ?", (account_id,)).fetchone()
        if not row or row["expires"] < time.time():
            raise RequestError("인증 코드가 만료되었습니다. 새 코드를 받으세요.", 410)
        if row["attempts"] >= MAX_ATTEMPTS:
            raise RequestError("시도 횟수를 초과했습니다. 새 코드를 받으세요.", 429)
        if not hmac.compare_digest(row["code_hash"], _hash(code.strip())):
            db.execute("UPDATE email_verifications SET attempts = attempts + 1 WHERE account_id = ?", (account_id,))
            left = MAX_ATTEMPTS - row["attempts"] - 1
            raise RequestError(f"인증 코드가 올바르지 않습니다. (남은 시도 {left}회)", 400)
        _mark_verified(db, account_id)
    return {"verified": True}


def verify_token(token):
    if not isinstance(token, str) or not 20 <= len(token) <= 100:
        raise RequestError("인증 링크가 올바르지 않습니다.")
    with store.database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("""
            SELECT v.account_id, v.expires, a.email FROM email_verifications v JOIN accounts a ON a.id = v.account_id
            WHERE v.token_hash = ?
        """, (_hash(token),)).fetchone()
        if not row or row["expires"] < time.time():
            raise RequestError("인증 링크가 만료되었거나 이미 사용되었습니다.", 410)
        _mark_verified(db, row["account_id"])
    return {"verified": True, "email": row["email"]}
