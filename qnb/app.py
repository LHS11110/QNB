import json
import os
import queue as _queue
import re
import secrets
import select
import socket
import sqlite3
import time
import uuid
from threading import BoundedSemaphore
from urllib.parse import urlencode, urlsplit

from flask import Flask, Response, g, jsonify, request, send_from_directory, stream_with_context
from flask_sock import Sock
from simple_websocket import ConnectionClosed
from werkzeug.security import check_password_hash, generate_password_hash

from . import auth, channels, codegraph, collab, gitstatus, identity, mailer, mcp_server, planner, runtime, stepper, store, visualize
from .runtime import RequestError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
app.config["SOCK_SERVER_OPTIONS"] = {
    "max_message_size": app.config["MAX_CONTENT_LENGTH"], "ping_interval": 25,
}
sock = Sock(app)
vm_connections = BoundedSemaphore(128)
SESSION_AGE = 7 * 86400
COOKIE = "qnb_session"
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
VM_BASE = int(os.environ.get("QNB_VM_ID_BASE", "1900000000"))
VM_LIMIT = int(os.environ.get("QNB_VM_ID_COUNT", "32"))
if VM_BASE < 1 or VM_LIMIT < 1 or VM_BASE + VM_LIMIT > 2147483648:
    raise RuntimeError("Invalid reserved VM ID range")
store.initialize()
channels.initialize()
planner.initialize()
collab.staging.recover_orphaned_staging()


@app.errorhandler(RequestError)
def request_error(error):
    return jsonify(error=str(error)), error.status


@app.errorhandler(UnicodeEncodeError)
def invalid_unicode(_error):
    return jsonify(error="올바른 UTF-8 텍스트가 필요합니다."), 400


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="요청 크기 제한을 초과했습니다."), 413


PUBLIC_ENDPOINTS = {
    "session_status", "signup", "login", "login_mfa", "email_verify_link",
    "passkey_login_options", "passkey_login_verify",
    "qr_login_start", "qr_login_poll",
}

WORKSPACE_SAFE_ENDPOINTS = PUBLIC_ENDPOINTS | {
    "logout", "profile_update", "security_status",
    "mfa_setup", "mfa_enable", "mfa_disable",
    "passkey_register_options", "passkey_register_verify", "passkey_delete",
    "mcp_tokens_list", "mcp_tokens_create", "mcp_tokens_delete",
    "qr_login_approve",
    "workspaces_overview", "workspaces_invite", "workspaces_respond",
    "workspaces_select", "workspaces_remove",
}


def _is_mcp_route(path):
    return path in ("/mcp", "/api/mcp") or path.startswith("/mcp/") or path.startswith("/api/mcp/")


# Endpoints an account may use before confirming its email address.
UNVERIFIED_ENDPOINTS = PUBLIC_ENDPOINTS | {"logout", "email_verify", "email_resend", "profile_update"}


def _mcp_token_from_headers():
    token = request.headers.get("X-QNB-MCP-Token", "").strip()
    if token:
        return token
    auth_hdr = request.headers.get("Authorization", "")
    if auth_hdr.lower().startswith("bearer "):
        return auth_hdr[7:].strip()
    return request.args.get("token", "").strip()


@app.before_request
def authenticate():
    if _is_mcp_route(request.path):
        if request.method == "OPTIONS" or request.path in ("/mcp/health", "/api/mcp/health"):
            return
        mcp_token = _mcp_token_from_headers()
        if not mcp_token:
            return (
                jsonify({
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32001, "message": "MCP Bearer 토큰이 필요합니다."},
                }),
                401,
                {"WWW-Authenticate": 'Bearer realm="qnb-mcp"'},
            )
        ws_owner = request.headers.get("X-QNB-Workspace-Owner") or request.args.get("workspaceOwnerId")
        g.account, g.workspace = store.authenticate_mcp_token(mcp_token, ws_owner)
        if not g.account:
            return (
                jsonify({
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32001, "message": "유효하지 않은 MCP 토큰입니다."},
                }),
                401,
                {"WWW-Authenticate": 'Bearer realm="qnb-mcp"'},
            )
        g.auth_kind = "mcp"
        return
    if not request.path.startswith("/api/"):
        return
    if request.method == "POST" and not request.is_json:
        raise RequestError("JSON 요청이 필요합니다.", 415)
    mcp_token = _mcp_token_from_headers()
    if mcp_token:
        ws_owner = request.headers.get("X-QNB-Workspace-Owner") or request.args.get("workspaceOwnerId")
        g.account, g.workspace = store.authenticate_mcp_token(mcp_token, ws_owner)
        if not g.account:
            raise RequestError("유효하지 않은 MCP 토큰입니다.", 401)
        if not identity.is_verified(g.account):
            raise RequestError("이메일 인증을 완료해야 사용할 수 있습니다.", 403)
        g.auth_kind = "mcp"
        return
    strict = request.endpoint not in WORKSPACE_SAFE_ENDPOINTS
    g.account, g.workspace = session_context(request.cookies.get(COOKIE), strict=strict)
    g.auth_kind = "browser"
    if not g.account and request.endpoint not in PUBLIC_ENDPOINTS:
        raise RequestError("로그인이 필요합니다.", 401)
    if g.account and not identity.is_verified(g.account) and request.endpoint not in UNVERIFIED_ENDPOINTS:
        raise RequestError("이메일 인증을 완료해야 사용할 수 있습니다.", 403)


def session_context(token, *, strict=False):
    if token:
        token_hash = runtime.digest(token)
        with store.database() as db:
            account = db.execute("""
                SELECT a.*, COALESCE(ap.nickname, '') AS nickname, COALESCE(ap.tag, '') AS tag, s.workspace_owner_id
                FROM accounts a
                JOIN sessions s ON a.id = s.account_id
                LEFT JOIN account_profiles ap ON ap.account_id = a.id
                WHERE s.token_hash = ? AND s.expires > ?
            """, (token_hash, int(time.time()))).fetchone()
            if account:
                return account, store.resolve_workspace(db, account, token_hash, strict=strict)
    return None, None


def session_account(token):
    return session_context(token)[0]


@app.after_request
def headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    # Automerge WASM uses wasm-unsafe-eval; home scroll stage and xterm use inline styles.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
        "script-src 'self' 'wasm-unsafe-eval'; "
        "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; "
        "worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
        "connect-src 'self' https://api.open-meteo.com"
    )
    if _is_mcp_route(request.path):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = (
            "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, "
            "Last-Event-ID, X-QNB-MCP-Token, X-QNB-MCP-Session, X-QNB-Workspace-Owner"
        )
        response.headers["Access-Control-Expose-Headers"] = "Mcp-Session-Id, MCP-Protocol-Version"
        response.headers.setdefault("Cache-Control", "no-cache, no-store")
    elif request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise RequestError("올바른 JSON 객체가 필요합니다.")
    return data


def credentials():
    data = payload()
    email, password = data.get("email"), data.get("password")
    if not isinstance(email, str) or len(email) > 254 or not EMAIL.fullmatch(email.strip()):
        raise RequestError("올바른 이메일 주소를 입력하세요.")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise RequestError("비밀번호는 8자 이상 128자 이하로 입력하세요.")
    return email.strip().lower(), password


def valid_nickname(value, fallback_email=""):
    if value is None or (isinstance(value, str) and not value.strip()):
        base = fallback_email.split("@", 1)[0].strip() or "researcher"
        return base[:32]
    if not isinstance(value, str):
        raise RequestError("닉네임은 문자열이어야 합니다.")
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()
    if not 1 <= len(cleaned) <= 32:
        raise RequestError("닉네임은 1자 이상 32자 이하로 입력하세요.")
    return cleaned


def external_origin():
    proto = "https" if (
        os.environ.get("QNB_SECURE_COOKIE") == "1"
        or request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https"
    ) else request.scheme
    return f"{proto}://{request.host}"


def webauthn_rp():
    rp_id = request.host.split(":", 1)[0].lower()
    origins = {external_origin().lower(), f"{request.scheme}://{request.host}".lower()}
    return rp_id, origins


def start_session(account):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with store.database() as db:
        db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
        if old_token := request.cookies.get(COOKIE):
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (runtime.digest(old_token),))
        db.execute(
            "INSERT INTO sessions (token_hash, account_id, expires, workspace_owner_id) VALUES (?, ?, ?, ?)",
            (runtime.digest(token), account["id"], now + SESSION_AGE, account["id"]),
        )
    nickname = (
        account["nickname"]
        if "nickname" in account.keys() and account["nickname"]
        else store.get_nickname(account["id"], account["email"])
    )
    _, tag = identity.profile(account["id"])
    response = jsonify(email=account["email"], nickname=nickname, tag=tag,
                       handle=identity.handle(nickname, tag), emailVerified=identity.is_verified(account))
    response.set_cookie(COOKIE, token, max_age=SESSION_AGE, httponly=True, samesite="Strict",
                        secure=os.environ.get("QNB_SECURE_COOKIE") == "1")
    return response


@app.get("/favicon.ico")
@app.get("/favicon.svg")
def favicon():
    return send_from_directory(app.static_folder, "favicon.svg", mimetype="image/svg+xml")


@app.get("/")
@app.get("/login")
@app.get("/signup")
@app.get("/qr-approve")
@app.get("/ide")
@app.get("/proofs")
@app.get("/verify-email")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/session")
def session_status():
    if not g.account:
        return jsonify(email=None)
    with store.database() as db:
        pending = store.pending_invite_count(db, g.account["email"])
    security = store.security_overview(g.account["id"])
    nickname = g.account["nickname"] or g.account["email"].split("@", 1)[0]
    tag = g.account["tag"] if "tag" in g.account.keys() else ""
    return jsonify(
        email=g.account["email"],
        nickname=nickname,
        tag=tag,
        handle=identity.handle(nickname, tag),
        emailVerified=identity.is_verified(g.account),
        mailConfigured=mailer.configured(),
        mfaEnabled=security["mfaEnabled"],
        passkeyCount=len(security["passkeys"]),
        workspace={
            "ownerId": g.workspace["owner_id"],
            "ownerEmail": g.workspace["owner_email"],
            "shared": g.workspace["shared"],
        },
        pendingInvites=pending,
    )


def valid_email_address(value):
    if not isinstance(value, str) or len(value) > 254 or not EMAIL.fullmatch(value.strip()):
        raise RequestError("올바른 이메일 주소를 입력하세요.")
    return value.strip().lower()


@app.get("/api/workspaces")
def workspaces_overview():
    return jsonify(store.list_workspaces(g.account, g.workspace))


@app.post("/api/workspaces/invite")
def workspaces_invite():
    data = payload()
    target = data.get("target", data.get("email"))
    if isinstance(target, str) and "#" in target and "@" not in target:
        found = identity.find_by_handle(target)
        if not found:
            raise RequestError("해당 닉네임#태그의 사용자를 찾을 수 없습니다.", 404)
        email = found["email"]
    else:
        email = valid_email_address(target)
    result = store.invite_member(g.account, email)
    with store.database() as db:
        invitee = db.execute("SELECT id FROM accounts WHERE email = ?", (email,)).fetchone()
    if invitee:
        nickname, tag = identity.profile(g.account["id"])
        channels.manager.notify_account(invitee["id"], {
            "type": "invite", "ownerId": g.account["id"], "from": identity.handle(nickname, tag),
        })
    return jsonify(result)


@app.post("/api/workspaces/respond")
def workspaces_respond():
    data = payload()
    owner_id = data.get("ownerId")
    decision = data.get("decision")
    if type(owner_id) is not int or owner_id < 1:
        raise RequestError("올바른 워크스페이스 소유자를 지정하세요.")
    if decision not in ("accept", "decline"):
        raise RequestError("decision 값은 'accept' 또는 'decline'이어야 합니다.")
    result = store.respond_invite(g.account, owner_id, decision == "accept")
    if decision == "accept" and data.get("switch") is True:
        result["workspace"] = store.select_workspace(
            runtime.digest(request.cookies[COOKIE]), g.account, owner_id
        )
    return jsonify(result)


@app.post("/api/workspaces/select")
def workspaces_select():
    data = payload()
    owner_id = data.get("ownerId")
    if type(owner_id) is not int or owner_id < 1:
        raise RequestError("올바른 워크스페이스를 선택하세요.")
    return jsonify(store.select_workspace(runtime.digest(request.cookies[COOKIE]), g.account, owner_id))


@app.post("/api/workspaces/remove")
def workspaces_remove():
    data = payload()
    if "email" in data:
        email = valid_email_address(data.get("email"))
        return jsonify(store.remove_workspace_member(g.account, email=email))
    owner_id = data.get("ownerId")
    if type(owner_id) is not int or owner_id < 1:
        raise RequestError("올바른 대상 워크스페이스를 지정하세요.")
    return jsonify(store.remove_workspace_member(g.account, owner_id=owner_id))


@app.post("/api/signup")
def signup():
    email, password = credentials()
    nickname = valid_nickname(payload().get("nickname"), email)
    encoded = generate_password_hash(password)
    try:
        with store.database() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM accounts WHERE email = ?", (email,)).fetchone():
                raise RequestError("이미 가입한 이메일입니다.", 409)
            vm_id = db.execute("SELECT COALESCE(MAX(vm_id) + 1, ?) FROM accounts", (VM_BASE,)).fetchone()[0]
            if not VM_BASE <= vm_id < VM_BASE + VM_LIMIT:
                raise RequestError("현재 새 VM 워크스페이스를 배정할 수 없습니다.", 503)
            account_id = db.execute(
                "INSERT INTO accounts (email, password, vm_id, email_verified) VALUES (?, ?, ?, 0)",
                (email, encoded, vm_id),
            ).lastrowid
            identity.create_profile(db, account_id, nickname)
    except sqlite3.IntegrityError as error:
        raise RequestError("계정을 만들 수 없습니다.", 409) from error
    send_verification(account_id, email, nickname, force=True)
    with store.database() as db:
        account = db.execute("SELECT a.*, ? AS nickname FROM accounts a WHERE a.id = ?", (nickname, account_id)).fetchone()
    return start_session(account)


def send_verification(account_id, email, nickname, *, force=False):
    code, token = identity.issue_code(account_id, force=force)
    link = external_origin() + "/verify-email?token=" + token
    return mailer.verification_email(email, nickname, code, link)


@app.post("/api/email/resend")
def email_resend():
    if identity.is_verified(g.account):
        return jsonify(verified=True)
    sent = send_verification(g.account["id"], g.account["email"], g.account["nickname"] or g.account["email"])
    return jsonify(sent=True, delivered=sent)


@app.post("/api/email/verify")
def email_verify():
    if identity.is_verified(g.account):
        return jsonify(verified=True)
    return jsonify(identity.verify_code(g.account["id"], payload().get("code")))


@app.post("/api/email/verify-link")
def email_verify_link():
    return jsonify(identity.verify_token(payload().get("token")))


@app.post("/api/login")
def login():
    email, password = credentials()
    with store.database() as db:
        account = db.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
    if not account or not check_password_hash(account["password"], password):
        raise RequestError("이메일 또는 비밀번호를 확인하세요.", 401)
    mfa = store.get_mfa_record(account["id"])
    if mfa and mfa["enabled"]:
        mfa_token = store.create_challenge("mfa_login", secrets.token_urlsafe(16), account_id=account["id"], ttl=300)
        return jsonify(mfaRequired=True, mfaToken=mfa_token)
    return start_session(account)


@app.post("/api/login/mfa")
def login_mfa():
    data = payload()
    mfa_token = data.get("mfaToken")
    code = data.get("code")
    if not isinstance(mfa_token, str) or not isinstance(code, str):
        raise RequestError("MFA 인증 토큰과 코드를 입력하세요.")
    challenge = store.consume_challenge(mfa_token, "mfa_login")
    if not challenge or not challenge["account_id"]:
        raise RequestError("MFA 인증 세션이 만료되었습니다. 다시 로그인하세요.", 401)
    account_id = challenge["account_id"]
    mfa = store.get_mfa_record(account_id)
    if not mfa or not mfa["enabled"]:
        raise RequestError("MFA 설정을 확인할 수 없습니다.", 400)
    verified = auth.verify_totp(mfa["secret"], code) or store.consume_recovery_code(
        account_id, auth.hash_recovery_code(code)
    )
    if not verified:
        # Re-issue token? Better: keep retry simple by asking user or allowing up to a few tries?
        # Consuming on mismatch prevents brute force; clear error instructs re-login if expired.
        raise RequestError("인증 코드 또는 복구 코드가 올바르지 않습니다. 다시 시도하세요.", 401)
    with store.database() as db:
        account = db.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not account:
        raise RequestError("계정을 찾을 수 없습니다.", 404)
    return start_session(account)


@app.post("/api/profile")
def profile_update():
    nickname = valid_nickname(payload().get("nickname"), g.account["email"])
    return jsonify(identity.update_nickname(g.account["id"], nickname))


@app.get("/api/security")
def security_status():
    return jsonify(store.security_overview(g.account["id"]))


@app.post("/api/mfa/setup")
def mfa_setup():
    secret = auth.generate_totp_secret()
    store.save_mfa_secret(g.account["id"], secret)
    uri = auth.totp_uri(g.account["email"], secret)
    return jsonify(secret=secret, otpauthUri=uri, qrDataUrl=auth.qr_svg_data_url(uri))


@app.post("/api/mfa/enable")
def mfa_enable():
    code = payload().get("code")
    mfa = store.get_mfa_record(g.account["id"])
    if not mfa:
        raise RequestError("먼저 MFA 설정을 시작하세요.")
    if not auth.verify_totp(mfa["secret"], code):
        raise RequestError("6자리 인증 코드가 올바르지 않습니다.", 400)
    plain_codes, hashed_codes = auth.generate_recovery_codes()
    store.enable_mfa(g.account["id"], hashed_codes)
    return jsonify(mfaEnabled=True, recoveryCodes=plain_codes)


@app.post("/api/mfa/disable")
def mfa_disable():
    code = payload().get("code")
    mfa = store.get_mfa_record(g.account["id"])
    if not mfa or not mfa["enabled"]:
        return jsonify(mfaEnabled=False)
    verified = isinstance(code, str) and (
        auth.verify_totp(mfa["secret"], code)
        or store.consume_recovery_code(g.account["id"], auth.hash_recovery_code(code))
    )
    if not verified:
        raise RequestError("현재 인증 코드 또는 복구 코드를 입력하세요.", 401)
    store.disable_mfa(g.account["id"])
    return jsonify(mfaEnabled=False)


@app.post("/api/passkeys/register/options")
def passkey_register_options():
    rp_id, _ = webauthn_rp()
    challenge = auth.b64url_encode(secrets.token_bytes(32))
    challenge_token = store.create_challenge("passkey_reg", challenge, account_id=g.account["id"])
    existing = [
        {"type": "public-key", "id": row["credential_id"]}
        for row in store.list_passkeys(g.account["id"])
    ]
    nickname = g.account["nickname"] or g.account["email"].split("@", 1)[0]
    return jsonify(
        challengeToken=challenge_token,
        publicKey={
            "rp": {"name": "QNB Proof Workspace", "id": rp_id},
            "user": {
                "id": auth.b64url_encode(str(g.account["id"]).encode("utf-8")),
                "name": g.account["email"],
                "displayName": nickname,
            },
            "challenge": challenge,
            "pubKeyCredParams": [
                {"type": "public-key", "alg": -7},
                {"type": "public-key", "alg": -257},
            ],
            "timeout": 60000,
            "attestation": "none",
            "excludeCredentials": existing,
            "authenticatorSelection": {
                "residentKey": "preferred",
                "userVerification": "preferred",
            },
        },
    )


@app.post("/api/passkeys/register/verify")
def passkey_register_verify():
    data = payload()
    challenge_token = data.get("challengeToken")
    credential = data.get("credential")
    label = valid_nickname(data.get("label") or "내 패스키")
    if not isinstance(challenge_token, str):
        raise RequestError("패스키 등록 토큰이 필요합니다.")
    row = store.consume_challenge(challenge_token, "passkey_reg")
    if not row or row["account_id"] != g.account["id"]:
        raise RequestError("패스키 등록 요청이 만료되었습니다. 다시 시도하세요.", 400)
    rp_id, origins = webauthn_rp()
    try:
        verified = auth.verify_registration(credential, row["challenge"], origins, rp_id)
    except ValueError as error:
        raise RequestError(str(error), 400) from error
    try:
        store.add_passkey(
            g.account["id"], verified["credential_id"], label, verified["public_key"], verified["sign_count"]
        )
    except sqlite3.IntegrityError as error:
        raise RequestError("이미 등록된 패스키입니다.", 409) from error
    return jsonify(store.security_overview(g.account["id"]))


@app.post("/api/passkeys/delete")
def passkey_delete():
    cred_id = payload().get("credentialId")
    if not isinstance(cred_id, str) or not cred_id:
        raise RequestError("삭제할 패스키 ID가 필요합니다.")
    store.delete_passkey(g.account["id"], cred_id)
    return jsonify(store.security_overview(g.account["id"]))


@app.post("/api/passkeys/login/options")
def passkey_login_options():
    data = payload()
    email = data.get("email")
    allow_credentials = []
    if isinstance(email, str) and email.strip():
        clean_email = valid_email_address(email)
        with store.database() as db:
            acc = db.execute("SELECT id FROM accounts WHERE email = ?", (clean_email,)).fetchone()
        if acc:
            allow_credentials = [
                {"type": "public-key", "id": row["credential_id"]}
                for row in store.list_passkeys(acc["id"])
            ]
    rp_id, _ = webauthn_rp()
    challenge = auth.b64url_encode(secrets.token_bytes(32))
    challenge_token = store.create_challenge("passkey_auth", challenge)
    return jsonify(
        challengeToken=challenge_token,
        publicKey={
            "challenge": challenge,
            "rpId": rp_id,
            "timeout": 60000,
            "userVerification": "preferred",
            "allowCredentials": allow_credentials,
        },
    )


@app.post("/api/passkeys/login/verify")
def passkey_login_verify():
    data = payload()
    challenge_token = data.get("challengeToken")
    credential = data.get("credential")
    if not isinstance(challenge_token, str) or not isinstance(credential, dict):
        raise RequestError("패스키 로그인 요청이 올바르지 않습니다.")
    row = store.consume_challenge(challenge_token, "passkey_auth")
    if not row:
        raise RequestError("패스키 인증 시간이 만료되었습니다. 다시 시도하세요.", 401)
    cred_id = credential.get("id") or credential.get("rawId")
    if not isinstance(cred_id, str) or not cred_id:
        raise RequestError("패스키 식별자가 누락되었습니다.", 400)
    stored = store.get_passkey(cred_id)
    if not stored:
        raise RequestError("등록되지 않은 패스키입니다.", 401)
    rp_id, origins = webauthn_rp()
    try:
        new_count, uv = auth.verify_authentication(
            credential, stored["public_key"], stored["sign_count"], row["challenge"], origins, rp_id
        )
    except ValueError as error:
        raise RequestError(str(error), 401) from error
    store.update_passkey_count(cred_id, new_count)
    with store.database() as db:
        account = db.execute("SELECT * FROM accounts WHERE id = ?", (stored["account_id"],)).fetchone()
    mfa = store.get_mfa_record(account["id"])
    if mfa and mfa["enabled"] and not uv:
        mfa_token = store.create_challenge("mfa_login", secrets.token_urlsafe(16), account_id=account["id"], ttl=300)
        return jsonify(mfaRequired=True, mfaToken=mfa_token)
    return start_session(account)


@app.post("/api/qr-login/start")
def qr_login_start():
    code, poll_secret = store.start_qr_session()
    approve_url = f"{external_origin()}/qr-approve?code={code}"
    return jsonify(
        code=code,
        pollSecret=poll_secret,
        approveUrl=approve_url,
        qrDataUrl=auth.qr_svg_data_url(approve_url),
    )


@app.post("/api/qr-login/approve")
def qr_login_approve():
    code = payload().get("code")
    if not isinstance(code, str) or not code:
        raise RequestError("QR 코드가 필요합니다.")
    store.approve_qr_session(code, g.account["id"])
    return jsonify(approved=True)


@app.post("/api/qr-login/poll")
def qr_login_poll():
    data = payload()
    code = data.get("code")
    poll_secret = data.get("pollSecret")
    if not isinstance(code, str) or not isinstance(poll_secret, str):
        raise RequestError("QR 세션 정보가 올바르지 않습니다.")
    account = store.poll_qr_session(code, poll_secret)
    if account is None:
        return jsonify(status="pending")
    return start_session(account)


@app.post("/api/logout")
def logout():
    with store.database() as db:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (runtime.digest(request.cookies[COOKIE]),))
    response = jsonify(email=None)
    response.delete_cookie(COOKIE)
    return response


@app.get("/api/files")
def files():
    return read_workspace(
        request.args.get("operation", "list"),
        request.args.get("path", "/"),
        request.args.get("cursor", 0, type=int),
    )


def read_workspace(operation, path, cursor=0):
    vm_id = g.workspace["vm_id"]
    file_path = runtime.path(path)
    if operation == "list":
        if type(cursor) is not int or not 0 <= cursor <= 10000:
            raise RequestError("올바르지 않은 목록 위치입니다.")
        return runtime.workspace(vm_id, "list", file_path, cursor=cursor)
    if operation == "read":
        return runtime.read_text(vm_id, file_path)
    if operation == "stat":
        return runtime.workspace(vm_id, "stat", file_path)
    raise RequestError("지원하지 않는 파일 조회입니다.")


@app.post("/api/files")
def mutate_file():
    return change_workspace(payload())


def change_workspace(data):
    file_path = runtime.path(data.get("path"))
    operation = data.get("operation")
    actor = collab.actor_from_account(g.account, kind=getattr(g, "auth_kind", "browser"))
    if operation == "write":
        text = data.get("text")
        if not isinstance(text, str):
            raise RequestError("저장할 텍스트가 필요합니다.")
        if data.get("create") is True:
            return collab.staging.mutate_fs(g.workspace, actor, "write", file_path, text=text, create=True)
        for field in ("etag", "fileId"):
            value = data.get(field)
            if not isinstance(value, str) or not 1 <= len(value) <= 128:
                raise RequestError("저장 전 파일을 열어주세요.", 409)
        return collab.staging.mutate_fs(
            g.workspace, actor, "write", file_path,
            text=text, etag=data.get("etag"), fileId=data.get("fileId"), resourceId=data.get("resourceId"),
        )
    if operation == "rename":
        resource_id = data.get("resourceId")
        if resource_id is not None and (not isinstance(resource_id, str) or not 1 <= len(resource_id) <= 128):
            raise RequestError("편집할 파일이나 폴더를 다시 선택하세요.", 409)
        return collab.staging.mutate_fs(
            g.workspace, actor, "rename", file_path,
            resourceId=resource_id, target=data.get("target"),
        )
    if operation == "delete":
        resource_id = data.get("resourceId")
        if resource_id is not None and (not isinstance(resource_id, str) or not 1 <= len(resource_id) <= 128):
            raise RequestError("편집할 파일이나 폴더를 다시 선택하세요.", 409)
        return collab.staging.mutate_fs(
            g.workspace, actor, "delete", file_path,
            resourceId=resource_id, recursive=bool(data.get("recursive", False)),
        )
    if operation == "mkdir":
        return collab.staging.mutate_fs(g.workspace, actor, "mkdir", file_path)
    raise RequestError("지원하지 않는 파일 작업입니다.")


@app.get("/api/planner")
def planner_snapshot():
    return jsonify(planner.snapshot(g.workspace["owner_id"]) | {"me": g.account["id"]})


@app.post("/api/planner")
def planner_mutate():
    owner_id = g.workspace["owner_id"]
    item, event = planner.mutate(owner_id, g.account["id"], payload())
    channels.manager._broadcast(owner_id, event | {"actorId": g.account["id"]})
    return jsonify(item)


@app.get("/api/mcp-tokens")
def mcp_tokens_list():
    return jsonify(tokens=store.list_mcp_tokens(g.account["id"]))


@app.post("/api/mcp-tokens")
def mcp_tokens_create():
    label = payload().get("label")
    return jsonify(store.create_mcp_token(g.account["id"], label))


@app.post("/api/mcp-tokens/delete")
def mcp_tokens_delete():
    token_id = payload().get("id")
    if type(token_id) is not int or token_id < 1:
        raise RequestError("삭제할 토큰 ID가 필요합니다.")
    return jsonify(store.delete_mcp_token(g.account["id"], token_id))


def _mcp_session_id_from_request():
    for candidate in (
        request.headers.get("Mcp-Session-Id", ""),
        request.headers.get("X-QNB-MCP-Session", ""),
        request.args.get("sessionId", ""),
        request.args.get("session_id", ""),
    ):
        if candidate and candidate.strip():
            return candidate.strip()
    return ""


def _sse_client_disconnected(client_sock):
    if client_sock is None:
        return False
    try:
        readable, _, exceptional = select.select([client_sock], [], [client_sock], 0)
        if exceptional:
            return True
        if readable:
            data = client_sock.recv(1, socket.MSG_PEEK)
            if not data:
                return True
    except OSError:
        return True
    return False


def _mcp_sse_response(mcp_sid, q, *, initial_frames=()):
    client_sock = request.environ.get("gunicorn.socket")

    def generate():
        last_ping = time.monotonic()
        try:
            for frame in initial_frames:
                yield frame
            while True:
                if _sse_client_disconnected(client_sock):
                    break
                try:
                    msg = q.get(timeout=0.4)
                except _queue.Empty:
                    now = time.monotonic()
                    if now - last_ping >= 15.0:
                        last_ping = now
                        yield ": ping\n\n"
                    continue
                if msg is None:
                    break
                last_ping = time.monotonic()
                yield f"event: message\ndata: {json.dumps(msg, ensure_ascii=False)}\n\n"
        finally:
            mcp_server.hub.detach_sse(mcp_sid, q)

    return Response(
        stream_with_context(generate()),
        status=200,
        mimetype="text/event-stream",
        headers={
            "Mcp-Session-Id": mcp_sid,
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
        },
    )


def _mcp_sse_stream():
    actor = collab.actor_from_account(g.account, kind="mcp")
    mcp_sid = f"mcp-sse-{uuid.uuid4().hex[:16]}"
    q = mcp_server.hub.attach_sse(mcp_sid, g.workspace, actor, sse_owned=True)
    msg_base = "/api/mcp/messages" if request.path.startswith("/api/") else "/mcp/messages"
    params = {"sessionId": mcp_sid}
    if tok := request.args.get("token", "").strip():
        params["token"] = tok
    if ws_owner := request.args.get("workspaceOwnerId", "").strip():
        params["workspaceOwnerId"] = ws_owner
    endpoint_uri = f"{msg_base}?{urlencode(params)}"
    return _mcp_sse_response(mcp_sid, q, initial_frames=(f"event: endpoint\ndata: {endpoint_uri}\n\n",))


@app.route("/mcp/health", methods=["GET", "OPTIONS"])
@app.route("/api/mcp/health", methods=["GET", "OPTIONS"])
def mcp_health():
    if request.method == "OPTIONS":
        return ("", 204)
    origin = external_origin()
    return jsonify(
        ok=True,
        service="qnb-mcp",
        mode="always-on",
        status="standing_by",
        transports=["streamable-http", "sse"],
        protocolVersions=list(mcp_server.SUPPORTED_PROTOCOL_VERSIONS),
        activeSessions=mcp_server.hub.active_count(),
        endpoints={
            "streamableHttp": f"{origin}/mcp",
            "sse": f"{origin}/mcp/sse",
            "messages": f"{origin}/mcp/messages",
        },
    )


@app.route("/mcp", methods=["GET", "POST", "DELETE", "OPTIONS"])
@app.route("/api/mcp", methods=["GET", "POST", "DELETE", "OPTIONS"])
def mcp_rpc():
    if request.method == "OPTIONS":
        return ("", 204)

    provided_sid = _mcp_session_id_from_request()
    if request.method == "DELETE":
        if provided_sid:
            mcp_server.hub.close_session(provided_sid)
        return jsonify(ok=True, released=True, sessionId=provided_sid)

    actor = collab.actor_from_account(g.account, kind="mcp")
    if request.method == "GET":
        accept = request.headers.get("Accept", "").lower()
        if "text/event-stream" in accept:
            if provided_sid:
                q = mcp_server.hub.attach_sse(provided_sid, g.workspace, actor, sse_owned=False)
                return _mcp_sse_response(provided_sid, q, initial_frames=(": connected\n\n",))
            return _mcp_sse_stream()
        return jsonify(
            service="qnb-mcp",
            mode="always-on",
            status="standing_by",
            workspaceOwner=g.workspace["owner_email"],
            tools=len(mcp_server.TOOLS),
        )

    data = request.get_json(force=True, silent=True)
    if data is None:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}), 400

    mcp_sid = provided_sid or f"mcp-{uuid.uuid4().hex[:16]}"
    mcp_server.hub.ensure_session(mcp_sid, g.workspace, actor)
    resp, code = mcp_server.handle_jsonrpc_payload(data, g.workspace, actor, mcp_session_id=mcp_sid)
    if resp is None:
        return ("", 202, {"Mcp-Session-Id": mcp_sid})

    accept = request.headers.get("Accept", "").lower()
    if "text/event-stream" in accept and "application/json" not in accept:
        return Response(
            f"event: message\ndata: {json.dumps(resp, ensure_ascii=False)}\n\n",
            status=200,
            mimetype="text/event-stream",
            headers={"Mcp-Session-Id": mcp_sid, "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
        )
    res = jsonify(resp)
    res.status_code = code
    res.headers["Mcp-Session-Id"] = mcp_sid
    return res


@app.route("/mcp/sse", methods=["GET", "OPTIONS"])
@app.route("/api/mcp/sse", methods=["GET", "OPTIONS"])
def mcp_sse():
    if request.method == "OPTIONS":
        return ("", 204)
    return _mcp_sse_stream()


@app.route("/mcp/messages", methods=["POST", "OPTIONS"])
@app.route("/api/mcp/messages", methods=["POST", "OPTIONS"])
def mcp_messages():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(force=True, silent=True)
    if data is None:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}), 400

    actor = collab.actor_from_account(g.account, kind="mcp")
    mcp_sid = _mcp_session_id_from_request() or f"mcp-msg-{uuid.uuid4().hex[:16]}"
    mcp_server.hub.ensure_session(mcp_sid, g.workspace, actor)
    resp, code = mcp_server.handle_jsonrpc_payload(data, g.workspace, actor, mcp_session_id=mcp_sid)
    if resp is not None and mcp_server.hub.push_sse_message(mcp_sid, resp):
        return ("", 202, {"Mcp-Session-Id": mcp_sid})
    if resp is None:
        return ("", 202, {"Mcp-Session-Id": mcp_sid})
    res = jsonify(resp)
    res.status_code = code
    res.headers["Mcp-Session-Id"] = mcp_sid
    return res


@app.get("/api/file-info")
def file_info():
    return read_workspace("stat", request.args.get("path"))


@app.post("/api/kernel")
def kernel():
    return kernel_operation(payload())


@app.before_request
def validate_vm_socket_origin():
    if request.endpoint not in ("vm_socket", "kernel_socket", "collab_socket", "channels_socket"):
        return
    try:
        origin = urlsplit(request.headers.get("Origin", ""))
    except ValueError as error:
        raise RequestError("허용되지 않은 WebSocket 출처입니다.", 403) from error
    schemes = ("https",) if os.environ.get("QNB_SECURE_COOKIE") == "1" else ("http", "https")
    if origin.scheme not in schemes or origin.netloc.lower() != request.host.lower():
        raise RequestError("허용되지 않은 WebSocket 출처입니다.", 403)


@sock.route("/api/kernel/ws")
def kernel_socket(ws):
    serve_vm_request(ws, kernel_operation)


@sock.route("/api/collab/ws")
def collab_socket(ws):
    if not vm_connections.acquire(blocking=False):
        ws.close()
        return
    try:
        serve_collab_connection(ws)
    finally:
        vm_connections.release()


def serve_collab_connection(ws):
    import queue as _queue

    token = request.cookies.get(COOKIE)
    account, workspace = session_context(token, strict=True)
    if not account:
        ws.send(json.dumps({"error": "로그인이 필요합니다.", "status": 401}, ensure_ascii=False))
        return
    owner_id = workspace["owner_id"]
    session_id = "ws-" + uuid.uuid4().hex[:16]
    actor = collab.actor_from_account(account, kind="browser")
    out_queue, snapshot = collab.staging.register_client(owner_id, session_id, actor)
    check_at = time.monotonic() + 10.0

    try:
        ws.send(json.dumps(snapshot | {"selfSessionId": session_id}, ensure_ascii=False))
        while True:
            while True:
                try:
                    ev = out_queue.get_nowait()
                except _queue.Empty:
                    break
                ws.send(json.dumps(ev, ensure_ascii=False))

            now = time.monotonic()
            if now >= check_at:
                acc, cur_ws = session_context(token, strict=True)
                if not acc or cur_ws["owner_id"] != owner_id:
                    ws.send(json.dumps({"type": "workspace_revoked", "status": 403}, ensure_ascii=False))
                    return
                check_at = now + 10.0

            frame = ws.receive(timeout=0.05)
            if frame is None:
                continue
            try:
                data = json.loads(frame) if isinstance(frame, str) else None
            except (ValueError, RecursionError):
                data = None
            if not isinstance(data, dict):
                continue

            req_id = data.get("reqId")
            msg_type = data.get("type")
            try:
                if msg_type == "ping":
                    res = {"pong": True}
                elif msg_type == "stage_open":
                    res = collab.staging.open_file(workspace, data.get("path"), session_id, actor, attach=True)
                elif msg_type == "stage_edit":
                    res = collab.staging.edit_file(
                        workspace,
                        data.get("path"),
                        session_id,
                        actor,
                        changes_b64=data.get("changesBase64"),
                        doc_b64=data.get("docBase64"),
                        new_text=data.get("text"),
                        cursor_line=data.get("cursorLine"),
                        auto_unstage_if_zero=True,
                    )
                elif msg_type == "stage_save":
                    res = collab.staging.save_file(workspace, data.get("path"), actor)
                elif msg_type == "stage_close":
                    res = collab.staging.close_file(workspace, data.get("path"), session_id, actor)
                elif msg_type == "cursor":
                    collab.staging.update_cursor(owner_id, data.get("path"), session_id, actor, data.get("cursorLine"))
                    res = None
                elif msg_type == "fs_mutate":
                    res = collab.staging.mutate_fs(
                        workspace,
                        actor,
                        data.get("operation"),
                        data.get("path"),
                        target=data.get("target"),
                        resourceId=data.get("resourceId"),
                        text=data.get("text"),
                        create=data.get("create"),
                        recursive=data.get("recursive"),
                    )
                else:
                    raise RequestError("지원하지 않는 실시간 협업 명령입니다.")

                if req_id is not None:
                    ws.send(json.dumps({"replyTo": req_id, "result": res}, ensure_ascii=False))
            except RequestError as err:
                if req_id is not None:
                    ws.send(json.dumps({"replyTo": req_id, "error": str(err), "status": err.status}, ensure_ascii=False))
            except Exception:
                app.logger.exception("Collab WebSocket error")
                if req_id is not None:
                    ws.send(json.dumps({"replyTo": req_id, "error": "실시간 협업 처리 중 오류가 발생했습니다.", "status": 500}, ensure_ascii=False))
    except ConnectionClosed:
        pass
    finally:
        collab.staging.unregister_client(owner_id, session_id)


@sock.route("/api/channels/ws")
def channels_socket(ws):
    if not vm_connections.acquire(blocking=False):
        ws.close()
        return
    try:
        serve_channels_connection(ws)
    finally:
        vm_connections.release()


def serve_channels_connection(ws):
    """Chat + voice hub: every frame is relayed by the server, never peer-to-peer."""
    import queue as _queue

    token = request.cookies.get(COOKIE)
    account, workspace = session_context(token, strict=True)
    if not account:
        ws.send(json.dumps({"error": "로그인이 필요합니다.", "status": 401}, ensure_ascii=False))
        return
    owner_id = workspace["owner_id"]
    actor = collab.actor_from_account(account, kind="browser")
    hub = channels.manager
    client = hub.connect(owner_id, actor)
    check_at = time.monotonic() + 10.0

    def drain():
        while True:
            try:
                item = client.out.get_nowait()
            except _queue.Empty:
                return
            ws.send(item if isinstance(item, bytes) else json.dumps(item, ensure_ascii=False))

    try:
        ws.send(json.dumps(hub.init_payload(owner_id, client), ensure_ascii=False))
        while True:
            drain()

            now = time.monotonic()
            if now >= check_at:
                acc, cur_ws = session_context(token, strict=True)
                if not acc or cur_ws["owner_id"] != owner_id:
                    ws.send(json.dumps({"type": "workspace_revoked", "status": 403}, ensure_ascii=False))
                    return
                check_at = now + 10.0

            frame = ws.receive(timeout=0.01)
            if frame is None:
                continue
            if isinstance(frame, bytes):
                hub.relay_voice(owner_id, client, frame)
                continue
            try:
                data = json.loads(frame)
            except (ValueError, RecursionError):
                data = None
            if not isinstance(data, dict):
                continue
            req_id = data.get("reqId")
            kind = data.get("type")
            try:
                if kind == "ping":
                    res = {"pong": True}
                elif kind == "history":
                    res = {"channel": data.get("channel"),
                           "messages": hub.history(owner_id, data.get("channel"), data.get("before"))}
                elif kind == "send":
                    res = hub.send_message(owner_id, client, data.get("channel"), data.get("text"))
                elif kind == "create_channel":
                    res = hub.create_channel(owner_id, data.get("name"), data.get("kind"))
                elif kind == "delete_channel":
                    res = hub.delete_channel(owner_id, actor, data.get("channel"))
                elif kind == "voice_join":
                    res = hub.join_voice(owner_id, client, data.get("channel"))
                elif kind == "voice_leave":
                    res = hub.leave_voice(owner_id, client)
                elif kind == "voice_mute":
                    res = hub.set_muted(owner_id, client, data.get("muted"))
                else:
                    raise RequestError("지원하지 않는 채널 명령입니다.")
                # Deliver broadcasts queued before this command first, so a reply is never
                # followed by an older presence snapshot (which would undo e.g. a voice join).
                drain()
                if req_id is not None:
                    ws.send(json.dumps({"replyTo": req_id, "result": res}, ensure_ascii=False))
            except RequestError as err:
                if req_id is not None:
                    ws.send(json.dumps({"replyTo": req_id, "error": str(err), "status": err.status},
                                       ensure_ascii=False))
    except ConnectionClosed:
        pass
    except Exception:
        app.logger.exception("Channels WebSocket error")
    finally:
        hub.disconnect(owner_id, client)


@sock.route("/api/vm/ws")
def vm_socket(ws):
    if not vm_connections.acquire(blocking=False):
        ws.close()
        return
    try:
        serve_vm_connection(ws)
    finally:
        vm_connections.release()


def serve_vm_connection(ws):
    token = request.cookies.get(COOKIE)
    if request.args.get("stream") == "terminal":
        serve_terminal(ws, token)
        return

    def operation(data):
        account, workspace = session_context(token, strict=True)
        if not account:
            raise RequestError("로그인이 필요합니다.", 401)
        g.account, g.workspace = account, workspace
        return vm_operation(ws, data)

    while serve_vm_request(ws, operation):
        pass


def terminal_message(frame, defaults=None):
    try:
        data = json.loads(frame) if isinstance(frame, str) else None
    except (ValueError, RecursionError):
        data = None
    if not isinstance(data, dict):
        raise RequestError("터미널 요청이 올바르지 않습니다.")
    return runtime.terminal_fields((defaults or {}) | data)


def terminal_init_command(actor_id, account_name, actor_email, marker):
    """Per-user shell account inside the shared VM: own HOME, USER, prompt, whoami and git identity."""
    from shlex import quote

    home = f"/var/tmp/qnb-home-u{int(actor_id)}"
    name = re.sub(r"[\x00-\x1f\x7f$`\"'\\/]", "", account_name or "").strip()
    name = re.sub(r"\s+", "_", name)[:40] or f"user{actor_id}"
    user = quote(name)
    ps1 = quote(name.replace("\\", "") + "@qnb:\\w$ ")
    whoami_lines = " ".join(quote(line) for line in ("#!/bin/sh", 'printf "%s\\n" "${USER:-workspace}"'))
    git_name = quote(name)
    git_email = quote(actor_email or f"user{actor_id}@qnb.local")
    return (
        f" mkdir -p {home}/.config {home}/.cache {home}/.local/bin {home}/.local/share {home}/.local/state {home}/.npm-global"
        f" && chmod 700 {home}"
        f" && touch {home}/.bash_history && chmod 600 {home}/.bash_history"
        f" && export HOME={home} USER={user} LOGNAME={user} QNB_ACCOUNT_ID={int(actor_id)}"
        f" XDG_CONFIG_HOME={home}/.config XDG_CACHE_HOME={home}/.cache"
        f" XDG_DATA_HOME={home}/.local/share XDG_STATE_HOME={home}/.local/state"
        f" NPM_CONFIG_PREFIX={home}/.npm-global HISTFILE={home}/.bash_history"
        f" PROMPT_COMMAND='history -a'"
        f' PATH="{home}/.local/bin:{home}/.npm-global/bin:$PATH"'
        f" PS1={ps1}"
        f" && printf '%s\\n' {whoami_lines} > {home}/.local/bin/whoami && chmod 755 {home}/.local/bin/whoami"
        f" && {{ git config --global user.name >/dev/null 2>&1 || git config --global user.name {git_name}; }}"
        f" && {{ git config --global user.email >/dev/null 2>&1 || git config --global user.email {git_email}; }}"
        f" ; cd /workspace 2>/dev/null || true; history -c; history -r 2>/dev/null || true; printf '\\033[2J\\033[3J\\033[H__QNB_%s_%s__\\n' 'READY' '{marker}'\n"
    )


def serve_terminal(ws, token):
    vm_id = g.workspace["vm_id"]
    actor_id = g.account["id"]
    actor_email = g.account["email"]
    expected_owner_id = g.workspace["owner_id"]
    initial = None
    try:
        initial = terminal_message(ws.receive(timeout=5))
        if initial["operation"] != "open":
            raise RequestError("먼저 터미널을 열어주세요.")
        with runtime.terminal_channel(vm_id, actor_id, initial) as channel:
            pending = bytearray()
            ready_deadline = time.monotonic() + 95
            check_session_at = time.monotonic() + 10
            init_marker = secrets.token_hex(8)
            sentinel = f"__QNB_READY_{init_marker}__".encode()
            initializing = False
            ready_frame = None
            init_output = bytearray()
            init_deadline = 0.0
            queued_commands = []

            def flush_ready(trailing):
                nonlocal initializing, ready_frame
                initializing = False
                payload_frame = dict(ready_frame)
                payload_frame["data"] = runtime.b64(trailing) if trailing else ""
                ws.send(json.dumps(payload_frame, ensure_ascii=False))
                ready_frame = None
                for cmd in queued_commands:
                    channel.sendall(json.dumps(cmd).encode() + b"\n")
                queued_commands.clear()

            while True:
                now = time.monotonic()
                if ready_deadline and now >= ready_deadline:
                    raise RequestError("VM 터미널 준비 시간이 초과되었습니다.", 503)
                if initializing and now >= init_deadline:
                    flush_ready(b"")
                if now >= check_session_at:
                    account, workspace = session_context(token, strict=True)
                    if not account:
                        raise RequestError("로그인이 필요합니다.", 401)
                    if workspace["owner_id"] != expected_owner_id:
                        raise RequestError("워크스페이스가 변경되어 터미널을 종료합니다.", 409)
                    check_session_at = now + 10
                if select.select([channel], [], [], 0)[0]:
                    chunk = channel.recv(65536)
                    if not chunk:
                        return
                    pending.extend(chunk)
                    while b"\n" in pending:
                        raw_frame, _, pending = pending.partition(b"\n")
                        ready_deadline = None
                        decoded_text = raw_frame.decode()
                        try:
                            parsed = json.loads(decoded_text)
                        except ValueError:
                            parsed = None
                        if isinstance(parsed, dict) and parsed.get("type") == "ready" and ready_frame is None:
                            initializing = True
                            ready_frame = parsed
                            init_deadline = time.monotonic() + 6.0
                            init_cmd = {
                                "operation": "input",
                                "data": terminal_init_command(
                                    actor_id, identity.workspace_account_name(expected_owner_id, actor_id),
                                    actor_email, init_marker),
                                "cols": initial["cols"],
                                "rows": initial["rows"],
                            }
                            channel.sendall(json.dumps(init_cmd).encode() + b"\n")
                            continue
                        if initializing and isinstance(parsed, dict):
                            if parsed.get("error") or parsed.get("exited"):
                                flush_ready(b"")
                                ws.send(decoded_text)
                                continue
                            if parsed.get("data"):
                                import base64 as _b64
                                ready_frame["offset"] = parsed.get("offset", ready_frame.get("offset", 0))
                                init_output.extend(_b64.b64decode(parsed["data"]))
                                idx = init_output.find(sentinel)
                                if idx != -1:
                                    after = init_output[idx + len(sentinel):].lstrip(b"\r\n")
                                    flush_ready(bytes(after))
                            continue
                        ws.send(decoded_text)
                    if len(pending) > 65536:
                        raise RequestError("VM 터미널 응답이 올바르지 않습니다.", 502)
                message = ws.receive(timeout=0.02)
                if message is None:
                    continue
                fields = terminal_message(message, initial)
                command = {key: fields[key] for key in ("operation", "data", "cols", "rows")}
                if command["operation"] not in ("input", "resize", "close"):
                    raise RequestError("지원하지 않는 터미널 작업입니다.")
                if initializing and command["operation"] != "close":
                    queued_commands.append(command)
                else:
                    channel.sendall(json.dumps(command).encode() + b"\n")
    except ConnectionClosed:
        pass
    except (RequestError, OSError, UnicodeError) as error:
        message = str(error) if isinstance(error, RequestError) else "VM 터미널 연결이 끊겼습니다."
        try:
            ws.send(json.dumps({"error": message}, ensure_ascii=False))
        except ConnectionClosed:
            pass
    finally:
        if initial and initial["operation"] == "open":
            try:
                runtime.terminal(vm_id, actor_id, initial | {"operation": "close"})
            except RequestError:
                app.logger.debug("Unable to close VM terminal session")


def vm_operation(ws, data):
    resource = data.get("resource")
    if resource == "terminal":
        return runtime.terminal(g.workspace["vm_id"], g.account["id"], data)
    if resource == "kernel":
        return kernel_operation(data)
    if resource == "visualize":
        return visualize_operation(data)
    if resource == "git":
        if data.get("operation") != "status":
            raise RequestError("지원하지 않는 Git 작업입니다.")
        return gitstatus.status(g.workspace["vm_id"], data.get("path", "/"))
    if resource == "workspace":
        operation = data.get("operation")
        if operation == "read":
            return stream_workspace_file(ws, runtime.path(data.get("path")))
        if operation == "read_binary":
            return stream_workspace_binary(ws, runtime.path(data.get("path")))
        if operation == "write_stream":
            return receive_workspace_file(ws, data)
        if operation == "upload_stream":
            return receive_workspace_upload(ws, data)
        if operation in ("list", "stat"):
            return read_workspace(operation, data.get("path"), data.get("cursor", 0))
        return change_workspace(data)
    raise RequestError("지원하지 않는 VM 작업입니다.")


def stream_workspace_file(ws, file_path):
    vm_id = g.workspace["vm_id"]
    try:
        return runtime.read_text(vm_id, file_path)
    except RequestError as error:
        if error.status != 413:
            raise
    for chunk in runtime.file_chunks(vm_id, file_path):
        ws.send(json.dumps({"chunk": chunk["content"]}))
    version = chunk["version"]
    return {"resourceId": version, "etag": version, "chunked": True}


def stream_workspace_binary(ws, file_path):
    """Send any file (image, PDF, ...) as base64 chunks for in-browser preview."""
    vm_id = g.workspace["vm_id"]
    info = runtime.workspace(vm_id, "stat", file_path)
    if info.get("type") != "file":
        raise RequestError("파일만 미리 볼 수 있습니다.")
    size = info.get("size", 0)
    if type(size) is not int or size > runtime.LARGE_FILE_LIMIT:
        raise RequestError("미리 보기는 8 MiB 이하 파일만 지원합니다.", 413)
    if size <= runtime.FILE_LIMIT:
        result = runtime.workspace(vm_id, "read", file_path)
        return {"binary": True, "size": size, "content": result.get("content", "")}
    for chunk in runtime.file_chunks(vm_id, file_path):
        ws.send(json.dumps({"binaryChunk": chunk["content"]}))
    return {"binary": True, "size": size, "chunked": True}


def receive_workspace_upload(ws, data):
    """Create a new file from raw bytes pasted or dropped into the IDE (images, PDFs, any file)."""
    file_path = runtime.path(data.get("path"))
    if file_path == "/":
        raise RequestError("업로드할 파일 경로가 필요합니다.")
    size = data.get("size")
    if type(size) is not int or not 0 <= size <= runtime.LARGE_FILE_LIMIT:
        raise RequestError("파일 크기는 8 MiB까지 지원합니다.", 413)
    vm_id = g.workspace["vm_id"]
    runtime.ensure_parent_directory(vm_id, file_path)
    created = runtime.workspace(vm_id, "write", file_path, requestId=uuid.uuid4().hex,
                                content="", create=True, overwrite=False)
    actor = collab.actor_from_account(g.account, kind=getattr(g, "auth_kind", "browser"))
    if size:
        version = created.get("resourceId") or runtime.workspace(vm_id, "stat", file_path)["resourceId"]
        try:
            saved = receive_workspace_file(ws, {"path": file_path, "size": size, "resourceId": version})
        except (RequestError, ConnectionClosed):
            try:
                stale = runtime.workspace(vm_id, "stat", file_path)["resourceId"]
                runtime.workspace(vm_id, "delete", file_path, requestId=uuid.uuid4().hex,
                                  resourceId=stale, recursive=False)
            except (RequestError, KeyError):
                app.logger.warning("Unable to remove incomplete upload")
            raise
    else:
        saved = {"resourceId": created.get("resourceId", "")}
    collab.staging._broadcast(g.workspace["owner_id"], {
        "type": "fs_event", "action": "create", "path": file_path, "actor": actor,
    })
    return {"path": file_path, "size": size, "resourceId": saved.get("resourceId", "")}


def receive_workspace_file(ws, data):
    file_path = runtime.path(data.get("path"))
    vm_id = g.workspace["vm_id"]
    size = data.get("size")
    if type(size) is not int or not 0 <= size <= runtime.LARGE_FILE_LIMIT:
        raise RequestError("파일 크기는 8 MiB까지 지원합니다.", 413)
    version = data.get("resourceId")
    if not isinstance(version, str) or not 1 <= len(version) <= 128:
        raise RequestError("전송 전에 파일을 다시 열어주세요.", 409)
    transfer = uuid.uuid4().hex
    offset = 0
    staging_attempted = False
    try:
        while True:
            ws.send(json.dumps({"uploadOffset": offset}))
            frame = ws.receive(timeout=15)
            if not isinstance(frame, bytes) or len(frame) != min(runtime.FILE_CHUNK_SIZE, size - offset):
                raise RequestError("파일 조각이 누락됐거나 크기가 올바르지 않습니다.", 400)
            staging_attempted = True
            staged = runtime.workspace(vm_id, "stage_chunk", file_path, transferId=transfer,
                                       offset=offset, content=runtime.b64(frame))
            offset += len(frame)
            if staged.get("offset") != offset:
                raise RequestError("VM 파일 조각 응답이 올바르지 않습니다.", 502)
            if offset == size:
                break
        saved = runtime.workspace(vm_id, "commit_chunks", file_path, transferId=transfer,
                                  size=size, version=version)
        return {"resourceId": saved["resourceId"], "etag": saved["resourceId"], "chunked": True}
    finally:
        if staging_attempted:
            try:
                runtime.workspace(vm_id, "abort_chunks", file_path, transferId=transfer)
            except RequestError:
                app.logger.warning("Unable to clean up incomplete VM file staging")


def serve_vm_request(ws, operation):
    try:
        frame = ws.receive(timeout=12)
        if frame is None:
            return False
        try:
            data = json.loads(frame) if isinstance(frame, str) else None
        except (ValueError, RecursionError):
            data = None
        if not isinstance(data, dict):
            raise RequestError("올바른 JSON 객체가 필요합니다.")
        response = {"result": operation(data)}
    except RequestError as error:
        response = {"error": str(error), "status": error.status}
    except UnicodeEncodeError:
        response = {"error": "올바른 UTF-8 텍스트가 필요합니다.", "status": 400}
    except ConnectionClosed:
        return False
    except Exception:
        app.logger.exception("VM WebSocket operation failed")
        response = {"error": "VM 작업 중 서버 오류가 발생했습니다.", "status": 500}
    try:
        ws.send(json.dumps(response, ensure_ascii=False))
    except ConnectionClosed:
        return False
    return response.get("status") != 401


def _run_lean_document(vm_id, owner, file_path, document, *, want_viz=False):
    status, output, rows, names, definitions, entries, imported = runtime.check_lean(
        vm_id, file_path, document, 0, secrets.token_hex(24),
        lambda name: store.lookup_declaration(owner, name),
    )
    projection_pending = False
    if status == 0:
        inserted = store.save_declarations(owner, file_path, rows, definitions, document, entries, imported)
        saved = {row["name"] for row in inserted}
        aliased = [name for name in names if name not in saved]
        names = [name for name in names if name in saved]
        if aliased:
            note = "동일 명제가 이미 DB에 저장되어 기존 정리에 별칭으로 연결됨 · " + ", ".join(aliased)
            output = "\n".join(filter(None, [output, note]))
        # The durable proof queue publishes to Neo4j after the notebook response.
        projection_pending = bool(inserted)
    if status == 0 and not output:
        output = "Lean 검사 통과"
    result = {
        "exitCode": status,
        "saved": names,
        "graphPending": projection_pending,
        "outputs": [{"output_type": "stream", "name": "stdout" if status == 0 else "stderr", "text": output}],
    }
    if want_viz:
        result["visualization"] = visualize.collect_lean_visualization(
            vm_id, file_path, document,
            status=status, rows=rows, definitions=definitions, entries=entries, output=output,
        )
    return result


def kernel_operation(data):
    file_path = runtime.path(data.get("path"))
    if not file_path.endswith(".ipynb"):
        raise RequestError("먼저 .ipynb 파일을 여세요.")
    vm_id = g.workspace["vm_id"]
    operation = data.get("operation")
    if operation in ("prepare", "reset"):
        runtime.workspace(vm_id, "stat", file_path)
        return runtime.jupyter(vm_id, operation, file_path)
    if operation != "run":
        raise RequestError("지원하지 않는 커널 작업입니다.")
    want_viz = bool(data.get("visualize"))
    runtime.configure_disk(vm_id)
    if "code" in data or "language" in data:
        lang = data.get("language")
        if lang not in ("lean4", "python"):
            raise RequestError("지원하지 않는 노트북 커널입니다. 셀의 커널을 선택하세요.")
        raw_code = data.get("code")
        if not isinstance(raw_code, str):
            raise RequestError("노트북 셀의 소스 형식이 올바르지 않습니다.")
        cell = {"cell_type": "code", "metadata": {"qnb_language": lang}, "source": raw_code}
        selected_language = lang
    else:
        doc = runtime.notebook(vm_id, file_path, data.get("etag"))
        index = data.get("index")
        if type(index) is not int or not 0 <= index < len(doc["cells"]):
            raise RequestError("실행할 셀을 선택하세요.")
        cell = doc["cells"][index]
        if cell.get("cell_type") != "code":
            raise RequestError("코드 셀만 실행할 수 있습니다.")
        selected_language = runtime.language(doc, cell)
    if selected_language == "python":
        code = runtime.source(cell)
        if len(code.encode()) > 65536:
            raise RequestError("셀 코드가 64 KiB를 초과했습니다.", 413)
        if code.startswith(("%%lean4", "%%rocq")):
            raise RequestError("셀의 매직 명령과 선택한 커널을 확인하세요.")
        if want_viz:
            return visualize.jupyter_with_trace(vm_id, file_path, code)
        return runtime.jupyter(vm_id, "execute", file_path, code)
    document = runtime.lean_cell_source(cell)
    return _run_lean_document(vm_id, g.workspace["owner_id"], file_path, document, want_viz=want_viz)


def visualize_operation(data):
    file_path = runtime.path(data.get("path"))
    lang = data.get("language")
    if lang not in ("lean4", "python", "cpp", "java"):
        raise RequestError("시각화 실행은 Lean 4 · Python · C++ · Java 파일만 지원합니다.")
    code = data.get("code")
    if not isinstance(code, str):
        raise RequestError("실행할 코드 문자열이 필요합니다.")
    if len(code.encode("utf-8")) > 65536:
        raise RequestError("코드 크기가 64 KiB를 초과했습니다.", 413)
    vm_id = g.workspace["vm_id"]
    runtime.configure_disk(vm_id)
    if lang == "python":
        return visualize.trace_python_script(vm_id, file_path, code)
    if lang in ("cpp", "java"):
        return stepper.trace(vm_id, file_path, code, lang)
    return _run_lean_document(vm_id, g.workspace["owner_id"], file_path, code, want_viz=True)


@app.post("/api/visualize")
def visualize_route():
    return jsonify(visualize_operation(payload()))


@app.get("/api/axioms")
def axioms_list():
    owner = g.workspace["owner_id"]
    can_manage = (not g.workspace["shared"]) and (g.account["id"] == owner)
    return jsonify(axioms=store.list_axioms(owner), canManage=can_manage)


@app.post("/api/axioms")
def axioms_add():
    owner = g.workspace["owner_id"]
    if g.workspace["shared"] or g.account["id"] != owner:
        raise RequestError("VM 워크스페이스 소유자만 공리를 추가할 수 있습니다.", 403)
    source = payload().get("source")
    if not isinstance(source, str) or not source.strip():
        raise RequestError("등록할 Lean 공리(axiom) 선언을 입력하세요.")
    if len(source.encode("utf-8")) > 32768:
        raise RequestError("공리 선언 크기는 32 KiB를 초과할 수 없습니다.", 413)
    vm_id = g.workspace["vm_id"]
    runtime.configure_disk(vm_id)
    axiom_rows, definitions, entries, imported, output = runtime.check_lean_axioms(
        vm_id, source, secrets.token_hex(24),
        lambda name: store.lookup_declaration(owner, name),
    )
    saved = store.save_axioms(owner, axiom_rows, definitions, source, entries, imported)
    return jsonify(saved=saved, axioms=store.list_axioms(owner), output=output)


@app.post("/api/axioms/delete")
def axioms_delete():
    owner = g.workspace["owner_id"]
    if g.workspace["shared"] or g.account["id"] != owner:
        raise RequestError("VM 워크스페이스 소유자만 공리를 삭제할 수 있습니다.", 403)
    name = payload().get("name")
    if not isinstance(name, str) or not name.strip():
        raise RequestError("삭제할 공리 이름을 입력하세요.")
    result = store.delete_axiom(owner, name.strip())
    return jsonify(result | {"axioms": store.list_axioms(owner)})


@app.get("/api/graph")
def graph():
    page = request.args.get("page", 0, type=int)
    if not 0 <= page <= 100000:
        raise RequestError("올바르지 않은 그래프 페이지입니다.")
    return store.dependency_graph(g.workspace["owner_id"], page)


@app.get("/api/code-graph")
def code_graph():
    """VM 워크스페이스의 Python, C++, Java 소스를 읽어 의존성 그래프를 만든다."""
    vm_id = g.workspace["vm_id"]
    owner_id = g.workspace["owner_id"]
    root = runtime.path(request.args.get("path", "/"))

    def list_directory(path, cursor):
        return runtime.workspace(vm_id, "list", path, cursor=cursor)

    def read_file(path):
        return collab.staging.read_effective_text(owner_id, vm_id, path)

    started = time.monotonic()
    files, skipped, truncated = codegraph.collect(list_directory, read_file, root)
    result = codegraph.analyze(files)
    result.update(
        root=root, skipped=skipped, truncated=truncated or result["truncated"],
        fileCount=len(files), elapsed=round(time.monotonic() - started, 3),
    )
    return result


@app.get("/api/proof-tree")
def proof_tree():
    limits = []
    for parameter, default, minimum, maximum in (
        ("page", 0, 0, 100000), ("limit", 30, 1, 100), ("depth", 3, 0, 12),
    ):
        try:
            value = int(request.args.get(parameter, default))
        except ValueError:
            value = minimum - 1
        if not minimum <= value <= maximum:
            raise RequestError(f"{parameter} 값은 {minimum}~{maximum} 범위의 정수여야 합니다.")
        limits.append(value)
    page, limit, depth = limits
    return store.proof_tree(g.workspace["owner_id"], page, request.args.get("root"), limit, depth)


@app.get("/api/theorem/<node_id>")
def theorem(node_id):
    with store.database() as db:
        row = db.execute("""
            SELECT name, source, content_hash AS hash, path
            FROM theorems WHERE account_id = ? AND node_id = ?
        """, (g.workspace["owner_id"], node_id)).fetchone()
        if not row:
            row = db.execute("""
                SELECT name, source, content_hash AS hash, '워크스페이스 공리' AS path
                FROM workspace_axioms WHERE account_id = ? AND node_id = ?
            """, (g.workspace["owner_id"], node_id)).fetchone()
    if not row:
        raise RequestError("저장된 정리를 찾을 수 없습니다.", 404)
    return dict(row)
