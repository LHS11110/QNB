import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from urllib.parse import urlsplit

from flask import Flask, g, jsonify, request, send_from_directory
from flask_sock import Sock
from simple_websocket import ConnectionClosed
from werkzeug.security import check_password_hash, generate_password_hash

from . import runtime, store
from .runtime import RequestError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024
app.config["SOCK_SERVER_OPTIONS"] = {
    "max_message_size": app.config["MAX_CONTENT_LENGTH"], "ping_interval": 25,
}
sock = Sock(app)
SESSION_AGE = 7 * 86400
COOKIE = "qnb_session"
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
VM_BASE = int(os.environ.get("QNB_VM_ID_BASE", "1900000000"))
VM_LIMIT = int(os.environ.get("QNB_VM_ID_COUNT", "32"))
if VM_BASE < 1 or VM_LIMIT < 1 or VM_BASE + VM_LIMIT > 2147483648:
    raise RuntimeError("Invalid reserved VM ID range")
store.initialize()


@app.errorhandler(RequestError)
def request_error(error):
    return jsonify(error=str(error)), error.status


@app.errorhandler(UnicodeEncodeError)
def invalid_unicode(_error):
    return jsonify(error="올바른 UTF-8 텍스트가 필요합니다."), 400


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="요청 크기 제한을 초과했습니다."), 413


@app.before_request
def authenticate():
    if not request.path.startswith("/api/"):
        return
    if request.method == "POST" and not request.is_json:
        raise RequestError("JSON 요청이 필요합니다.", 415)
    token = request.cookies.get(COOKIE)
    g.account = None
    if token:
        with store.database() as db:
            g.account = db.execute("""
                SELECT a.* FROM accounts a JOIN sessions s ON a.id = s.account_id
                WHERE s.token_hash = ? AND s.expires > ?
            """, (runtime.digest(token), int(time.time()))).fetchone()
    if not g.account and request.endpoint not in ("session_status", "signup", "login"):
        raise RequestError("로그인이 필요합니다.", 401)


@app.after_request
def headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
        "img-src 'self' data:; style-src 'self'; connect-src 'self'"
    )
    if request.path.startswith("/api/"):
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


def start_session(account):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with store.database() as db:
        db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
        if old_token := request.cookies.get(COOKIE):
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (runtime.digest(old_token),))
        db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (runtime.digest(token), account["id"], now + SESSION_AGE))
    response = jsonify(email=account["email"])
    response.set_cookie(COOKIE, token, max_age=SESSION_AGE, httponly=True, samesite="Strict",
                        secure=os.environ.get("QNB_SECURE_COOKIE") == "1")
    return response


@app.get("/")
@app.get("/ide")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/session")
def session_status():
    return jsonify(email=g.account["email"] if g.account else None)


@app.post("/api/signup")
def signup():
    email, password = credentials()
    encoded = generate_password_hash(password)
    try:
        with store.database() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM accounts WHERE email = ?", (email,)).fetchone():
                raise RequestError("이미 가입한 이메일입니다.", 409)
            vm_id = db.execute("SELECT COALESCE(MAX(vm_id) + 1, ?) FROM accounts", (VM_BASE,)).fetchone()[0]
            if not VM_BASE <= vm_id < VM_BASE + VM_LIMIT:
                raise RequestError("현재 새 VM 워크스페이스를 배정할 수 없습니다.", 503)
            account_id = db.execute("INSERT INTO accounts (email, password, vm_id) VALUES (?, ?, ?)",
                                    (email, encoded, vm_id)).lastrowid
    except sqlite3.IntegrityError as error:
        raise RequestError("계정을 만들 수 없습니다.", 409) from error
    return start_session({"id": account_id, "email": email})


@app.post("/api/login")
def login():
    email, password = credentials()
    with store.database() as db:
        account = db.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
    if not account or not check_password_hash(account["password"], password):
        raise RequestError("이메일 또는 비밀번호를 확인하세요.", 401)
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
    vm_id = g.account["vm_id"]
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
    vm_id = g.account["vm_id"]
    file_path = runtime.path(data.get("path"))
    operation = data.get("operation")
    fields = {"requestId": uuid.uuid4().hex}
    if operation == "write":
        text = data.get("text")
        if not isinstance(text, str):
            raise RequestError("저장할 텍스트가 필요합니다.")
        content = text.encode()
        if len(content) > runtime.FILE_LIMIT:
            raise RequestError("파일 크기는 128 KiB까지 지원합니다.", 413)
        fields["content"] = runtime.b64(content)
        if data.get("create") is True:
            fields.update(create=True, overwrite=False)
        else:
            for field in ("etag", "fileId"):
                value = data.get(field)
                if not isinstance(value, str) or not 1 <= len(value) <= 128:
                    raise RequestError("저장 전 파일을 열어주세요.", 409)
                fields[field] = value
    elif operation in ("rename", "delete"):
        resource_id = data.get("resourceId")
        if not isinstance(resource_id, str) or not 1 <= len(resource_id) <= 128:
            raise RequestError("편집할 파일이나 폴더를 다시 선택하세요.", 409)
        fields["resourceId"] = resource_id
        if operation == "rename":
            fields["target"] = runtime.path(data.get("target"))
    elif operation != "mkdir":
        raise RequestError("지원하지 않는 파일 작업입니다.")
    return runtime.workspace(vm_id, operation, file_path, **fields)


@app.get("/api/file-info")
def file_info():
    return read_workspace("stat", request.args.get("path"))


@app.post("/api/kernel")
def kernel():
    return kernel_operation(payload())


@app.before_request
def validate_vm_socket_origin():
    if request.endpoint not in ("vm_socket", "kernel_socket"):
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


@sock.route("/api/vm/ws")
def vm_socket(ws):
    serve_vm_request(ws, lambda data: vm_operation(ws, data))


def vm_operation(ws, data):
    resource = data.get("resource")
    if resource == "kernel":
        return kernel_operation(data)
    if resource == "workspace":
        operation = data.get("operation")
        if operation == "read":
            return stream_workspace_file(ws, runtime.path(data.get("path")))
        if operation == "write_stream":
            return receive_workspace_file(ws, data)
        if operation in ("list", "stat"):
            return read_workspace(operation, data.get("path"), data.get("cursor", 0))
        return change_workspace(data)
    raise RequestError("지원하지 않는 VM 작업입니다.")


def stream_workspace_file(ws, file_path):
    vm_id = g.account["vm_id"]
    try:
        return runtime.read_text(vm_id, file_path)
    except RequestError as error:
        if error.status != 413:
            raise
    for chunk in runtime.file_chunks(vm_id, file_path):
        ws.send(json.dumps({"chunk": chunk["content"]}))
    version = chunk["version"]
    return {"resourceId": version, "etag": version, "chunked": True}


def receive_workspace_file(ws, data):
    file_path = runtime.path(data.get("path"))
    vm_id = g.account["vm_id"]
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
    frame = ws.receive(timeout=5)
    if frame is None:
        return
    try:
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
        return
    except Exception:
        app.logger.exception("VM WebSocket operation failed")
        response = {"error": "VM 작업 중 서버 오류가 발생했습니다.", "status": 500}
    ws.send(json.dumps(response, ensure_ascii=False))


def kernel_operation(data):
    file_path = runtime.path(data.get("path"))
    if not file_path.endswith(".ipynb"):
        raise RequestError("먼저 .ipynb 파일을 여세요.")
    vm_id = g.account["vm_id"]
    operation = data.get("operation")
    if operation in ("prepare", "reset"):
        runtime.workspace(vm_id, "stat", file_path)
        return runtime.jupyter(vm_id, operation, file_path)
    if operation != "run":
        raise RequestError("지원하지 않는 커널 작업입니다.")
    doc = runtime.notebook(vm_id, file_path, data.get("etag"))
    index = data.get("index")
    if type(index) is not int or not 0 <= index < len(doc["cells"]):
        raise RequestError("실행할 셀을 선택하세요.")
    cell = doc["cells"][index]
    if cell.get("cell_type") != "code":
        raise RequestError("코드 셀만 실행할 수 있습니다.")
    if runtime.language(doc, cell) == "python":
        code = runtime.source(cell)
        if len(code.encode()) > 65536:
            raise RequestError("셀 코드가 64 KiB를 초과했습니다.", 413)
        if code.startswith(("%%lean4", "%%rocq")):
            raise RequestError("셀의 매직 명령과 선택한 커널을 확인하세요.")
        return runtime.jupyter(vm_id, "execute", file_path, code)
    document, offset = runtime.lean_prefix(doc, index)
    owner = g.account["id"]
    status, output, rows, names, definitions, entries, imported = runtime.check_lean(
        vm_id, file_path, document, offset, secrets.token_hex(24),
        lambda name: store.lookup_declaration(owner, name),
    )
    projection_pending = False
    if status == 0:
        inserted = store.save_declarations(owner, file_path, rows, definitions, document, entries, imported)
        saved = {row["name"] for row in inserted}
        names = [name for name in names if name in saved]
        try:
            store.project(owner, inserted)
        except RequestError:
            projection_pending = True
    if status == 0 and not output:
        output = "Lean 검사 통과"
    return {"exitCode": status, "saved": names, "graphPending": projection_pending,
            "outputs": [{"output_type": "stream", "name": "stdout" if status == 0 else "stderr", "text": output}]}


@app.get("/api/graph")
def graph():
    page = request.args.get("page", 0, type=int)
    if not 0 <= page <= 100000:
        raise RequestError("올바르지 않은 그래프 페이지입니다.")
    return store.dependency_graph(g.account["id"], page)


@app.get("/api/theorem/<node_id>")
def theorem(node_id):
    with store.database() as db:
        row = db.execute("""
            SELECT name, source, content_hash AS hash, path
            FROM theorems WHERE account_id = ? AND node_id = ?
        """, (g.account["id"], node_id)).fetchone()
    if not row:
        raise RequestError("저장된 정리를 찾을 수 없습니다.", 404)
    return dict(row)
