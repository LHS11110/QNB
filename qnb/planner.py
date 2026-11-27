"""Workspace planner: projects, kanban tasks and calendar events.

Everything is scoped to the workspace owner, so invited collaborators share one board.
Changes are broadcast through the channel hub so open IDEs update in real time.
"""

import json
import re
import secrets
import time

from . import store
from .runtime import RequestError

SCHEMA = """
CREATE TABLE IF NOT EXISTS planner_projects (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4338CA',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    start_date TEXT,
    end_date TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS planner_projects_owner ON planner_projects (owner_id);
CREATE TABLE IF NOT EXISTS planner_tasks (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    project_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee_id INTEGER,
    start_date TEXT,
    due_date TEXT,
    position REAL NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS planner_tasks_owner ON planner_tasks (owner_id, status, position);
CREATE TABLE IF NOT EXISTS planner_events (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES accounts(id),
    project_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start TEXT NOT NULL,
    end TEXT,
    all_day INTEGER NOT NULL DEFAULT 1,
    color TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS planner_events_owner ON planner_events (owner_id, start);
"""

TASK_STATUSES = ("todo", "doing", "review", "done")
PRIORITIES = ("low", "medium", "high", "urgent")
PROJECT_STATUSES = ("active", "paused", "done")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
LIMITS = {"project": 200, "task": 3000, "event": 3000}
TABLES = {"project": "planner_projects", "task": "planner_tasks", "event": "planner_events"}


def initialize():
    with store.database() as db:
        db.executescript(SCHEMA)


def _text(value, field, limit, required=False):
    if value is None:
        if required:
            raise RequestError(f"{field}을(를) 입력하세요.")
        return None
    if not isinstance(value, str):
        raise RequestError(f"{field} 형식이 올바르지 않습니다.")
    value = value.strip()
    if required and not value:
        raise RequestError(f"{field}을(를) 입력하세요.")
    if len(value) > limit:
        raise RequestError(f"{field}은(는) {limit}자까지 입력할 수 있습니다.")
    return value


def _date(value, field, pattern=DATE):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise RequestError(f"{field} 날짜 형식이 올바르지 않습니다.")
    return value


def _choice(value, field, choices):
    if value not in choices:
        raise RequestError(f"{field} 값이 올바르지 않습니다.")
    return value


def members(owner_id):
    with store.database() as db:
        rows = db.execute("""
            SELECT a.id, a.email, COALESCE(NULLIF(p.nickname, ''), substr(a.email, 1, instr(a.email, '@') - 1)) AS nickname
            FROM accounts a LEFT JOIN account_profiles p ON p.account_id = a.id
            WHERE a.id = ?
               OR a.email IN (SELECT invitee_email FROM workspace_invites WHERE owner_id = ? AND status = 'accepted')
            ORDER BY a.id = ? DESC, nickname
        """, (owner_id, owner_id, owner_id)).fetchall()
    return [{"id": row["id"], "nickname": row["nickname"]} for row in rows]


def _project(row):
    return {
        "id": row["id"], "name": row["name"], "color": row["color"], "description": row["description"],
        "status": row["status"], "startDate": row["start_date"], "endDate": row["end_date"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def _task(row):
    return {
        "id": row["id"], "projectId": row["project_id"], "title": row["title"], "description": row["description"],
        "status": row["status"], "priority": row["priority"], "assigneeId": row["assignee_id"],
        "startDate": row["start_date"], "dueDate": row["due_date"], "position": row["position"],
        "tags": json.loads(row["tags"] or "[]"), "createdBy": row["created_by"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"], "completedAt": row["completed_at"],
    }


def _event(row):
    return {
        "id": row["id"], "projectId": row["project_id"], "title": row["title"], "description": row["description"],
        "start": row["start"], "end": row["end"], "allDay": bool(row["all_day"]), "color": row["color"],
        "createdBy": row["created_by"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


SERIALIZERS = {"project": _project, "task": _task, "event": _event}


def snapshot(owner_id):
    with store.database() as db:
        projects = [_project(r) for r in db.execute(
            "SELECT * FROM planner_projects WHERE owner_id = ? ORDER BY created_at, rowid", (owner_id,))]
        tasks = [_task(r) for r in db.execute(
            "SELECT * FROM planner_tasks WHERE owner_id = ? ORDER BY status, position, created_at", (owner_id,))]
        events = [_event(r) for r in db.execute(
            "SELECT * FROM planner_events WHERE owner_id = ? ORDER BY start", (owner_id,))]
    return {"projects": projects, "tasks": tasks, "events": events, "members": members(owner_id)}


def _project_ref(db, owner_id, value):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not db.execute(
            "SELECT 1 FROM planner_projects WHERE owner_id = ? AND id = ?", (owner_id, value)).fetchone():
        raise RequestError("프로젝트를 찾을 수 없습니다.", 404)
    return value


def _assignee(owner_id, value):
    if value in (None, ""):
        return None
    if type(value) is not int or value not in {m["id"] for m in members(owner_id)}:
        raise RequestError("담당자는 워크스페이스 멤버여야 합니다.")
    return value


def _fields(db, kind, owner_id, data, partial):
    """Validate the writable columns present in data → {column: value}."""
    out = {}

    def has(key):
        return key in data or not partial

    if kind == "project":
        if has("name"):
            out["name"] = _text(data.get("name"), "프로젝트 이름", 80, required=True)
        if has("color"):
            color = data.get("color") or "#4338CA"
            if not isinstance(color, str) or not COLOR.fullmatch(color):
                raise RequestError("색상 형식이 올바르지 않습니다.")
            out["color"] = color
        if has("description"):
            out["description"] = _text(data.get("description") or "", "설명", 2000) or ""
        if has("status"):
            out["status"] = _choice(data.get("status", "active"), "프로젝트 상태", PROJECT_STATUSES)
        if has("startDate"):
            out["start_date"] = _date(data.get("startDate"), "시작일")
        if has("endDate"):
            out["end_date"] = _date(data.get("endDate"), "종료일")
    elif kind == "task":
        if has("title"):
            out["title"] = _text(data.get("title"), "작업 제목", 200, required=True)
        if has("description"):
            out["description"] = _text(data.get("description") or "", "설명", 4000) or ""
        if has("status"):
            out["status"] = _choice(data.get("status", "todo"), "작업 상태", TASK_STATUSES)
        if has("priority"):
            out["priority"] = _choice(data.get("priority", "medium"), "우선순위", PRIORITIES)
        if has("projectId"):
            out["project_id"] = _project_ref(db, owner_id, data.get("projectId"))
        if has("assigneeId"):
            out["assignee_id"] = _assignee(owner_id, data.get("assigneeId"))
        if has("startDate"):
            out["start_date"] = _date(data.get("startDate"), "시작일")
        if has("dueDate"):
            out["due_date"] = _date(data.get("dueDate"), "마감일")
        if has("position"):
            position = data.get("position", time.time())
            if not isinstance(position, (int, float)) or isinstance(position, bool):
                raise RequestError("정렬 위치가 올바르지 않습니다.")
            out["position"] = float(position)
        if has("tags"):
            tags = data.get("tags") or []
            if not isinstance(tags, list) or len(tags) > 10 or not all(isinstance(t, str) and 0 < len(t.strip()) <= 24 for t in tags):
                raise RequestError("태그는 24자 이하로 최대 10개까지 입력할 수 있습니다.")
            out["tags"] = json.dumps([t.strip() for t in tags], ensure_ascii=False)
    else:
        if has("title"):
            out["title"] = _text(data.get("title"), "일정 제목", 200, required=True)
        if has("description"):
            out["description"] = _text(data.get("description") or "", "설명", 2000) or ""
        if has("start"):
            start = _date(data.get("start"), "시작", DATETIME)
            if not start:
                raise RequestError("일정 시작 날짜를 입력하세요.")
            out["start"] = start
        if has("end"):
            out["end"] = _date(data.get("end"), "종료", DATETIME)
        if has("allDay"):
            out["all_day"] = 1 if data.get("allDay", True) else 0
        if has("projectId"):
            out["project_id"] = _project_ref(db, owner_id, data.get("projectId"))
        if has("color"):
            color = data.get("color")
            if color not in (None, "") and (not isinstance(color, str) or not COLOR.fullmatch(color)):
                raise RequestError("색상 형식이 올바르지 않습니다.")
            out["color"] = color or None
    return out


def _check_range(kind, row):
    if kind == "project" and row.get("start_date") and row.get("end_date") and row["end_date"] < row["start_date"]:
        raise RequestError("종료일은 시작일 이후여야 합니다.")
    if kind == "task" and row.get("start_date") and row.get("due_date") and row["due_date"] < row["start_date"]:
        raise RequestError("마감일은 시작일 이후여야 합니다.")
    if kind == "event" and row.get("end") and row["end"][:10] < row["start"][:10]:
        raise RequestError("종료는 시작 이후여야 합니다.")


def mutate(owner_id, actor_id, data):
    """Apply one create/update/delete; returns (result, broadcast_event)."""
    op = data.get("op")
    kind = data.get("kind")
    if kind not in TABLES:
        raise RequestError("지원하지 않는 항목 종류입니다.")
    table = TABLES[kind]
    item_id = data.get("id")
    payload = data.get("data") or {}
    if not isinstance(payload, dict):
        raise RequestError("올바른 JSON 객체가 필요합니다.")
    with store.database() as db:
        if op == "create":
            count = db.execute(f"SELECT COUNT(*) FROM {table} WHERE owner_id = ?", (owner_id,)).fetchone()[0]
            if count >= LIMITS[kind]:
                raise RequestError("항목 수 한도를 초과했습니다.", 409)
            fields = _fields(db, kind, owner_id, payload, partial=False)
            _check_range(kind, fields)
            fields.update(id=secrets.token_hex(8), owner_id=owner_id)
            if kind != "project":
                fields["created_by"] = actor_id
            if kind == "task" and fields["status"] == "done":
                fields["completed_at"] = int(time.time())
            columns = ", ".join(fields)
            db.execute(f"INSERT INTO {table} ({columns}) VALUES ({', '.join('?' * len(fields))})", list(fields.values()))
        elif op == "update":
            current = db.execute(f"SELECT * FROM {table} WHERE owner_id = ? AND id = ?", (owner_id, item_id)).fetchone()
            if not current:
                raise RequestError("항목을 찾을 수 없습니다.", 404)
            fields = _fields(db, kind, owner_id, payload, partial=True)
            if not fields:
                raise RequestError("변경할 내용이 없습니다.")
            _check_range(kind, {**dict(current), **fields})
            if kind == "task" and "status" in fields and fields["status"] != current["status"]:
                fields["completed_at"] = int(time.time()) if fields["status"] == "done" else None
            fields["updated_at"] = int(time.time())
            assignments = ", ".join(f"{column} = ?" for column in fields)
            db.execute(f"UPDATE {table} SET {assignments} WHERE owner_id = ? AND id = ?",
                       [*fields.values(), owner_id, item_id])
        elif op == "delete":
            if not db.execute(f"DELETE FROM {table} WHERE owner_id = ? AND id = ?", (owner_id, item_id)).rowcount:
                raise RequestError("항목을 찾을 수 없습니다.", 404)
            if kind == "project":
                # Tasks and events stay, detached from the deleted project.
                db.execute("UPDATE planner_tasks SET project_id = NULL WHERE owner_id = ? AND project_id = ?", (owner_id, item_id))
                db.execute("UPDATE planner_events SET project_id = NULL WHERE owner_id = ? AND project_id = ?", (owner_id, item_id))
            return {"deleted": item_id}, {"type": "planner", "op": "delete", "kind": kind, "id": item_id}
        else:
            raise RequestError("지원하지 않는 작업입니다.")
        row = db.execute(f"SELECT * FROM {table} WHERE owner_id = ? AND id = ?",
                         (owner_id, fields.get("id", item_id))).fetchone()
    item = SERIALIZERS[kind](row)
    return item, {"type": "planner", "op": "upsert", "kind": kind, "item": item}
