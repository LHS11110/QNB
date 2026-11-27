"""MCP (Model Context Protocol) JSON-RPC 2.0 server and stdio CLI bridge for QNB staged workspaces."""

import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

from . import collab, runtime
from .runtime import RequestError

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
PROTOCOL_VERSION = "2025-03-26"
MCP_SESSION_IDLE_SECONDS = int(os.environ.get("QNB_MCP_IDLE_SECONDS", "180"))

SERVER_INSTRUCTIONS = (
    "QNB 상시 대기 MCP 서버입니다. 모든 파일 편집은 백엔드 스테이징 영역에서 "
    "Automerge CRDT로 병합되어 연결된 브라우저 협업자에게 즉시 브로드캐스팅되며, "
    "스테이징 파일을 점유한 활성 사용자(브라우저/MCP)가 0명이 되면 자동으로 VM 디스크에 저장 후 스테이징에서 내립니다."
)

TOOLS = [
    {
        "name": "qnb_workspace_status",
        "description": "현재 워크스페이스의 접속 중인 사용자와 백엔드 스테이징 영역에 올라온 파일 목록을 조회합니다.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "qnb_list_files",
        "description": "워크스페이스 디렉터리의 파일 및 폴더 목록을 조회하고 각 파일의 스테이징/미저장 상태를 함께 반환합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "조회할 절대 경로 (기본값: '/')", "default": "/"},
                "cursor": {"type": "integer", "minimum": 0, "default": 0},
            },
        },
    },
    {
        "name": "qnb_open_staged_file",
        "description": "파일을 백엔드 스테이징 영역으로 열어 현재 MCP 세션을 작업자로 등록하고 최신 Automerge 내용을 반환합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "절대 파일 경로 (예: '/main.lean')"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "qnb_read_staged_file",
        "description": "스테이징 영역의 최신 파일 내용을 읽습니다. 미스테이징 상태면 디스크에서 불러온 뒤, 다른 작업자가 0명이고 keep_staged=false면 즉시 언스테이징합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "절대 파일 경로"},
                "keep_staged": {"type": "boolean", "description": "읽은 뒤에도 MCP 작업 세션을 유지할지 여부", "default": False},
            },
            "required": ["path"],
        },
    },
    {
        "name": "qnb_edit_staged_file",
        "description": "백엔드 스테이징 영역의 파일을 Automerge CRDT로 편집합니다. 연결된 다른 사용자에게 실시간 브로드캐스팅되며, 작업 중인 사용자가 0명이면 자동으로 파일시스템에 저장 후 스테이징에서 내립니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "절대 파일 경로"},
                "text": {"type": "string", "description": "전체 파일 본문을 대체할 새 텍스트 (old_text/new_text와 택1)"},
                "old_text": {"type": "string", "description": "부분 치환할 기존 텍스트"},
                "new_text": {"type": "string", "description": "부분 치환 후 새 텍스트"},
                "replace_all": {"type": "boolean", "default": False},
                "keep_staged": {"type": "boolean", "description": "편집 후에도 MCP 작업 세션을 유지할지 여부", "default": False},
            },
            "required": ["path"],
        },
    },
    {
        "name": "qnb_save_staged_file",
        "description": "스테이징 영역의 변경 내용을 VM 파일시스템에 명시적으로 저장합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "절대 파일 경로"}},
            "required": ["path"],
        },
    },
    {
        "name": "qnb_close_staged_file",
        "description": "해당 파일에서 MCP 작업 세션을 해제합니다. 남은 작업자가 0명이면 변경 사항을 자동 저장하고 스테이징에서 내립니다.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "절대 파일 경로"}},
            "required": ["path"],
        },
    },
    {
        "name": "qnb_create_file",
        "description": "VM 파일시스템에 새 파일을 생성하고 모든 협업자에게 브로드캐스팅합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "새 파일의 절대 경로"},
                "text": {"type": "string", "default": ""},
            },
            "required": ["path"],
        },
    },
    {
        "name": "qnb_mkdir",
        "description": "VM 파일시스템에 새 폴더를 생성하고 모든 협업자에게 브로드캐스팅합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "새 폴더의 절대 경로"}},
            "required": ["path"],
        },
    },
    {
        "name": "qnb_rename_entry",
        "description": "파일이나 폴더의 이름을 바꾸거나 이동하고 스테이징 영역과 모든 협업자에게 반영합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "원본 절대 경로"},
                "target": {"type": "string", "description": "새 절대 경로"},
            },
            "required": ["path", "target"],
        },
    },
    {
        "name": "qnb_delete_entry",
        "description": "파일 또는 폴더를 삭제하고 스테이징 영역과 모든 협업자에게 반영합니다.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "삭제할 절대 경로"},
                "recursive": {"type": "boolean", "default": True},
            },
            "required": ["path"],
        },
    },
]


def _text_result(payload, *, is_error=False):
    text = json.dumps(payload, ensure_ascii=False, indent=2) if not isinstance(payload, str) else payload
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _call_tool(name, args, workspace, actor, mcp_session_id):
    args = args if isinstance(args, dict) else {}
    owner_id = workspace["owner_id"]
    vm_id = workspace["vm_id"]

    if name == "qnb_workspace_status":
        status = collab.staging.list_staged(owner_id)
        return {
            "workspace": {
                "ownerId": owner_id,
                "ownerEmail": workspace["owner_email"],
                "shared": workspace["shared"],
            },
            **status,
        }

    if name == "qnb_list_files":
        dir_path = runtime.path(args.get("path", "/"))
        cursor = args.get("cursor", 0)
        listed = runtime.workspace(vm_id, "list", dir_path, cursor=cursor)
        staged_map = {item["path"]: item for item in collab.staging.list_staged(owner_id)["stagedFiles"]}
        prefix = "" if dir_path == "/" else dir_path
        enriched = []
        for entry_name, entry_type in listed.get("entries", []):
            full_path = f"{prefix}/{entry_name}"
            stage_info = staged_map.get(full_path)
            enriched.append({
                "name": entry_name,
                "path": full_path,
                "type": entry_type,
                "staged": stage_info is not None,
                "dirty": stage_info["dirty"] if stage_info else False,
                "activeUsers": stage_info["activeCount"] if stage_info else 0,
            })
        return {"path": dir_path, "entries": enriched, "cursor": listed.get("cursor")}

    if name == "qnb_open_staged_file":
        return collab.staging.open_file(workspace, args.get("path"), mcp_session_id, actor, attach=True)

    if name == "qnb_read_staged_file":
        file_path = args.get("path")
        keep = bool(args.get("keep_staged", False))
        opened = collab.staging.open_file(workspace, file_path, mcp_session_id, actor, attach=keep)
        if not keep and opened["activeCount"] == 0:
            collab.staging.close_file(workspace, file_path, mcp_session_id, actor)
        return opened

    if name == "qnb_edit_staged_file":
        file_path = runtime.path(args.get("path"))
        keep = bool(args.get("keep_staged", False))
        full_text = args.get("text")
        old_text = args.get("old_text")
        new_text = args.get("new_text")
        if full_text is not None:
            target_text = full_text
        elif isinstance(old_text, str) and isinstance(new_text, str):
            current = collab.staging.open_file(workspace, file_path, mcp_session_id, actor, attach=keep)
            src = current["text"]
            count = src.count(old_text)
            if count == 0:
                if not keep and current["activeCount"] == 0:
                    collab.staging.close_file(workspace, file_path, mcp_session_id, actor)
                raise RequestError("치환할 old_text를 파일에서 찾지 못했습니다.", 409)
            if args.get("replace_all"):
                target_text = src.replace(old_text, new_text)
            else:
                if count > 1:
                    if not keep and current["activeCount"] == 0:
                        collab.staging.close_file(workspace, file_path, mcp_session_id, actor)
                    raise RequestError(f"old_text가 {count}곳에서 발견되었습니다. 더 구체적으로 지정하거나 replace_all=true를 사용하세요.", 409)
                target_text = src.replace(old_text, new_text, 1)
        else:
            raise RequestError("text 또는 (old_text, new_text)를 모두 제공해야 합니다.")

        if keep:
            collab.staging.open_file(workspace, file_path, mcp_session_id, actor, attach=True)
        return collab.staging.edit_file(
            workspace, file_path, mcp_session_id, actor,
            new_text=target_text,
            auto_unstage_if_zero=not keep,
        )

    if name == "qnb_save_staged_file":
        return collab.staging.save_file(workspace, args.get("path"), actor)

    if name == "qnb_close_staged_file":
        return collab.staging.close_file(workspace, args.get("path"), mcp_session_id, actor)

    if name == "qnb_create_file":
        return collab.staging.mutate_fs(
            workspace, actor, "write", args.get("path"),
            text=args.get("text", ""), create=True,
        )

    if name == "qnb_mkdir":
        return collab.staging.mutate_fs(workspace, actor, "mkdir", args.get("path"))

    if name == "qnb_rename_entry":
        return collab.staging.mutate_fs(
            workspace, actor, "rename", args.get("path"),
            target=args.get("target"),
        )

    if name == "qnb_delete_entry":
        return collab.staging.mutate_fs(
            workspace, actor, "delete", args.get("path"),
            recursive=args.get("recursive", True),
        )

    raise RequestError(f"알 수 없는 MCP 도구입니다: {name}", 404)


class McpSessionHub:
    """Always-on in-process registry for remote MCP Streamable HTTP & SSE sessions."""

    def __init__(self, idle_seconds=MCP_SESSION_IDLE_SECONDS):
        self.idle_seconds = idle_seconds
        self._lock = threading.Lock()
        self._sessions = {}
        self._reaper_started = False

    def _ensure_reaper_locked(self):
        if self._reaper_started:
            return
        self._reaper_started = True

        def _loop():
            while True:
                time.sleep(15.0)
                try:
                    self.reap_expired()
                except Exception:
                    pass

        t = threading.Thread(target=_loop, name="qnb-mcp-reaper", daemon=True)
        t.start()

    def active_count(self):
        with self._lock:
            return len(self._sessions)

    def ensure_session(self, session_id, workspace, actor, *, sse_owned=False):
        now = time.monotonic()
        with self._lock:
            self._ensure_reaper_locked()
            entry = self._sessions.get(session_id)
            if entry is not None:
                entry["last_seen"] = now
                if sse_owned:
                    entry["sse_owned"] = True
                return session_id
            self._sessions[session_id] = {
                "session_id": session_id,
                "owner_id": workspace["owner_id"],
                "account_id": actor.get("accountId"),
                "actor": actor,
                "created_at": now,
                "last_seen": now,
                "sse_queues": set(),
                "sse_owned": bool(sse_owned),
            }
        collab.staging.register_client(workspace["owner_id"], session_id, actor)
        return session_id

    def attach_sse(self, session_id, workspace, actor, *, sse_owned=False):
        self.ensure_session(session_id, workspace, actor, sse_owned=sse_owned)
        q = queue.Queue(maxsize=256)
        with self._lock:
            entry = self._sessions.get(session_id)
            if entry is None:
                self._sessions[session_id] = {
                    "session_id": session_id,
                    "owner_id": workspace["owner_id"],
                    "account_id": actor.get("accountId"),
                    "actor": actor,
                    "created_at": time.monotonic(),
                    "last_seen": time.monotonic(),
                    "sse_queues": {q},
                    "sse_owned": bool(sse_owned),
                }
            else:
                entry["sse_queues"].add(q)
                entry["last_seen"] = time.monotonic()
        return q

    def push_sse_message(self, session_id, message):
        with self._lock:
            entry = self._sessions.get(session_id)
            if not entry:
                return False
            entry["last_seen"] = time.monotonic()
            queues = list(entry["sse_queues"])
        if not queues:
            return False
        for q in queues:
            try:
                q.put_nowait(message)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(message)
                except queue.Full:
                    pass
        return True

    def detach_sse(self, session_id, q):
        should_close = False
        with self._lock:
            entry = self._sessions.get(session_id)
            if entry:
                entry["sse_queues"].discard(q)
                entry["last_seen"] = time.monotonic()
                if entry["sse_owned"] and not entry["sse_queues"]:
                    should_close = True
        if should_close:
            self.close_session(session_id)

    def close_session(self, session_id):
        with self._lock:
            entry = self._sessions.pop(session_id, None)
            if not entry:
                return {"released": True, "sessionId": session_id, "events": []}
            queues = list(entry["sse_queues"])
            owner_id = entry["owner_id"]
        for q in queues:
            try:
                q.put_nowait(None)
            except queue.Full:
                try:
                    q.get_nowait()
                    q.put_nowait(None)
                except (queue.Empty, queue.Full):
                    pass
        events = collab.staging.unregister_client(owner_id, session_id)
        return {"released": True, "sessionId": session_id, "events": events}

    def reap_expired(self, now=None):
        current = time.monotonic() if now is None else now
        expired = []
        with self._lock:
            for sid, entry in self._sessions.items():
                if not entry["sse_queues"] and (current - entry["last_seen"]) > self.idle_seconds:
                    expired.append(sid)
        for sid in expired:
            self.close_session(sid)
        return expired


hub = McpSessionHub()


def handle_jsonrpc(req, workspace, actor, *, mcp_session_id):
    if not isinstance(req, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}, 400

    req_id = req.get("id")
    is_notification = "id" not in req
    method = req.get("method")
    params = req.get("params") or {}

    if method == "notifications/initialized" or method == "notifications/cancelled":
        return None, 202

    if is_notification:
        # Handle side effects if any, then return HTTP 202 with no JSON-RPC response body.
        if method == "qnb/releaseSession":
            hub.close_session(mcp_session_id)
        return None, 202

    if method == "initialize":
        requested = params.get("protocolVersion") if isinstance(params, dict) else None
        negotiated = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else PROTOCOL_VERSION
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": negotiated,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "qnb-mcp", "version": "1.1.0"},
                "instructions": SERVER_INSTRUCTIONS,
            },
        }, 200

    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}, 200

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}, 200

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments") or {}
        try:
            res = _call_tool(tool_name, arguments, workspace, actor, mcp_session_id)
            return {"jsonrpc": "2.0", "id": req_id, "result": _text_result(res, is_error=False)}, 200
        except RequestError as err:
            return {"jsonrpc": "2.0", "id": req_id, "result": _text_result(str(err), is_error=True)}, 200

    if method == "qnb/releaseSession":
        res = hub.close_session(mcp_session_id)
        return {"jsonrpc": "2.0", "id": req_id, "result": res}, 200

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }, 200


def handle_jsonrpc_payload(payload, workspace, actor, *, mcp_session_id):
    if isinstance(payload, list):
        if not payload:
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}, 400
        responses = []
        for item in payload:
            resp, _ = handle_jsonrpc(item, workspace, actor, mcp_session_id=mcp_session_id)
            if resp is not None:
                responses.append(resp)
        if not responses:
            return None, 202
        return responses, 200
    if isinstance(payload, dict):
        return handle_jsonrpc(payload, workspace, actor, mcp_session_id=mcp_session_id)
    return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}, 400


def _post_remote(url, token, session_id, workspace_owner, payload):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
        "Mcp-Session-Id": session_id,
        "X-QNB-MCP-Session": session_id,
    }
    if workspace_owner:
        headers["X-QNB-Workspace-Owner"] = str(workspace_owner)
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as resp:
            if resp.status in (202, 204):
                return None
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        return {
            "jsonrpc": "2.0",
            "id": payload.get("id") if isinstance(payload, dict) else None,
            "error": {"code": -32000, "message": f"HTTP {err.code}: {detail}"},
        }
    except (urllib.error.URLError, ValueError) as err:
        return {
            "jsonrpc": "2.0",
            "id": payload.get("id") if isinstance(payload, dict) else None,
            "error": {"code": -32001, "message": str(err)},
        }


def main():
    base_url = os.environ.get("QNB_URL", "https://qnb.p-e.kr").rstrip("/")
    token = os.environ.get("QNB_MCP_TOKEN", "").strip()
    workspace_owner = os.environ.get("QNB_WORKSPACE_OWNER", "").strip()
    if not token:
        sys.stderr.write("QNB_MCP_TOKEN 환경변수가 필요합니다.\n")
        sys.exit(1)

    endpoint = f"{base_url}/mcp"
    session_id = "mcp-" + uuid.uuid4().hex[:12]

    try:
        for line in sys.stdin:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                msg = json.loads(stripped)
            except ValueError as err:
                out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(err)}}
                sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                continue
            response = _post_remote(endpoint, token, session_id, workspace_owner, msg)
            if response is not None and "id" in msg and msg["id"] is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
    finally:
        _post_remote(endpoint, token, session_id, workspace_owner, {
            "jsonrpc": "2.0",
            "id": "cleanup",
            "method": "qnb/releaseSession",
            "params": {},
        })


if __name__ == "__main__":
    main()
