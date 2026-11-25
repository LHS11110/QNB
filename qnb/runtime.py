import base64
import hashlib
import json
import os
import posixpath
import re
import socket
from threading import Lock
from pathlib import Path

INSPECTOR = Path(__file__).with_name("Inspect.lean").read_bytes()
FILE_LIMIT = 131072
FILE_CHUNK_SIZE = 98304
LARGE_FILE_LIMIT = 8 * 1024 * 1024
VM_DISK_GIB = int(os.environ.get("QNB_VM_DISK_GIB", "12"))
configured = set()
configuration_lock = Lock()


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def vm(vm_id, payload):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
            channel.settimeout(245 if payload.get("operation") == "prepare" else 95)
            channel.connect(os.environ.get("QNB_VM_SOCKET", "/run/agora-runtime/manager.sock"))
            channel.sendall(json.dumps({"canvasId": vm_id, **payload}).encode() + b"\n")
            with channel.makefile("rb") as stream:
                frame = stream.readline(2400001)
        if not frame.endswith(b"\n"):
            raise ValueError("Incomplete runtime response")
        result = json.loads(frame)
    except (OSError, ValueError) as error:
        raise RequestError("VM 관리자에 연결할 수 없습니다. 런타임 상태와 소켓 권한을 확인하세요.", 503) from error
    if not isinstance(result, dict):
        raise RequestError("VM 응답 형식이 올바르지 않습니다.", 502)
    return result


def configure_disk(vm_id):
    with configuration_lock:
        if vm_id in configured:
            return
        settings = vm(vm_id, {"action": "settings_get"})
        if "diskGiB" not in settings:
            raise RequestError("VM 디스크 설정을 읽을 수 없습니다.", 503)
        if settings["diskGiB"] < VM_DISK_GIB:
            result = vm(vm_id, {"action": "disk_set", "revision": settings["revision"],
                                "sizeGiB": VM_DISK_GIB})
            if result.get("diskGiB", 0) < VM_DISK_GIB:
                raise RequestError("VM에 필요한 디스크를 할당할 수 없습니다.", 503)
        configured.add(vm_id)


def path(value):
    if not isinstance(value, str) or not value.startswith("/") or len(value.encode()) > 4096:
        raise RequestError("올바른 절대 워크스페이스 경로가 필요합니다.")
    if value != "/" and any(
        item in ("", ".", "..") or len(item.encode()) > 255
        for item in value[1:].split("/")
    ):
        raise RequestError("올바른 워크스페이스 경로가 필요합니다.")
    if "\x00" in value or "\\" in value:
        raise RequestError("올바른 워크스페이스 경로가 필요합니다.")
    return value


def workspace(vm_id, operation, file_path, **fields):
    configure_disk(vm_id)
    result = vm(vm_id, {"action": "workspace", "request": {
        "operation": operation, "path": path(file_path), **fields,
    }})
    code = result.get("error")
    if code:
        messages = {
            "FILE_NOT_FOUND": ("VM에서 파일을 찾을 수 없습니다.", 404),
            "FILE_EXISTS": ("같은 이름의 파일 또는 폴더가 이미 있습니다.", 409),
            "FILE_CONFLICT": ("VM에서 파일이 변경되었습니다. 다시 열어 최신 내용을 확인하세요.", 409),
            "FILE_REPLACED": ("파일이 다른 파일로 교체되었습니다. 다시 열어주세요.", 409),
            "DIRECTORY_NOT_EMPTY": ("비어 있는 폴더만 삭제할 수 있습니다.", 409),
            "FILE_TOO_LARGE": ("파일 크기는 128 KiB까지 지원합니다.", 413),
            "TRANSFER_TOO_LARGE": ("파일 크기는 8 MiB까지 지원합니다.", 413),
            "TRANSFER_BUSY": ("다른 파일을 전송 중입니다. 잠시 후 다시 시도하세요.", 409),
            "TRANSFER_INCOMPLETE": ("파일 조각이 누락됐습니다.", 409),
            "WORKSPACE_REQUEST_INVALID": ("VM 파일 요청을 처리할 수 없습니다. 큰 파일은 최신 게스트 파일 에이전트가 필요합니다.", 400),
            "RUNTIME_UNAVAILABLE": ("VM을 사용할 수 없습니다. VM 관리자 상태를 확인하세요.", 503),
            "WORKSPACE_UNAVAILABLE": ("VM 파일 서비스가 응답하지 않습니다. 게스트 디스크와 에이전트를 확인하세요.", 503),
            "WORKSPACE_AGENT_UPGRADE_REQUIRED": ("VM의 파일 에이전트를 업데이트해야 합니다.", 503),
        }
        message, status = messages.get(code, (f"VM 파일 작업 실패 ({code}).", 400))
        raise RequestError(message, status)
    return result


def read_text(vm_id, file_path):
    result = workspace(vm_id, "read", file_path)
    try:
        content = base64.b64decode(result["content"], validate=True).decode("utf-8")
    except (UnicodeDecodeError, ValueError, KeyError) as error:
        raise RequestError("UTF-8 텍스트 파일만 편집할 수 있습니다.", 415) from error
    return {key: result[key] for key in ("fileId", "etag", "resourceId") if key in result} | {"text": content}


def file_chunks(vm_id, file_path):
    offset = 0
    fields = {}
    while True:
        chunk = workspace(vm_id, "read_chunk", file_path, offset=offset, **fields)
        if not fields:
            fields["version"] = chunk["version"]
            size = chunk["size"]
        content = base64.b64decode(chunk["content"], validate=True)
        if (chunk["offset"] != offset or chunk["version"] != fields["version"] or chunk["size"] != size
                or not 0 <= size <= LARGE_FILE_LIMIT or len(content) != min(FILE_CHUNK_SIZE, size - offset)):
            raise RequestError("VM 파일 조각 응답이 올바르지 않습니다.", 502)
        yield chunk
        offset += len(content)
        if offset == size:
            return


def b64(data):
    return base64.b64encode(data).decode("ascii")


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def notebook_key(file_path):
    return "qnb-" + digest(file_path)


def jupyter(vm_id, operation, file_path, code=""):
    result = vm(vm_id, {"action": "notebook", "operation": operation,
                        "notebook": notebook_key(file_path), "code": code})
    if "exitCode" not in result and not result.get("reset"):
        raise RequestError(f"Jupyter 커널 작업 실패 ({result.get('error', 'VM 응답 오류')}).", 503)
    return result


def source(cell):
    value = cell.get("source")
    if isinstance(value, list) and all(isinstance(line, str) for line in value):
        return "".join(value)
    if isinstance(value, str):
        return value
    raise RequestError("노트북 셀의 소스 형식이 올바르지 않습니다.")


def notebook(vm_id, file_path, etag):
    if not isinstance(etag, str) or not etag:
        raise RequestError("실행 전에 최신 파일을 저장하세요.", 409)
    try:
        saved = read_text(vm_id, file_path)
    except RequestError as error:
        if error.status != 413:
            raise
        content = bytearray()
        for chunk in file_chunks(vm_id, file_path):
            if chunk["version"] != etag:
                raise RequestError("실행 전에 최신 파일을 저장하세요.", 409)
            content.extend(base64.b64decode(chunk["content"]))
        saved = {"text": content, "etag": etag}
    if etag not in (saved["etag"], saved.get("resourceId")):
        raise RequestError("실행 전에 최신 파일을 저장하세요.", 409)
    try:
        doc = json.loads(saved["text"])
        if not isinstance(doc, dict) or doc.get("nbformat") != 4:
            raise ValueError("Invalid notebook format")
        cells = doc["cells"]
        if not isinstance(cells, list) or not all(isinstance(cell, dict) for cell in cells):
            raise ValueError("Invalid notebook cells")
        return doc
    except (KeyError, ValueError, RecursionError) as error:
        raise RequestError("올바른 nbformat 4 노트북이 필요합니다.") from error


def language(doc, cell):
    metadata = cell.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise RequestError("노트북 셀 메타데이터가 올바르지 않습니다.")
    explicit = metadata.get("qnb_language")
    if explicit in ("lean4", "python"):
        return explicit
    if source(cell).startswith("%%lean4 ") or source(cell).split("\n", 1)[0] == "%%lean4":
        return "lean4"
    metadata = doc.get("metadata") or {}
    kernel = metadata.get("kernelspec") if isinstance(metadata, dict) else None
    name = kernel.get("name", "python3") if isinstance(kernel, dict) else "python3"
    if not isinstance(name, str):
        raise RequestError("노트북의 커널 이름이 올바르지 않습니다.")
    if name.lower() in ("lean4", "lean"):
        return "lean4"
    if name.lower().startswith("python"):
        return "python"
    raise RequestError(f"지원하지 않는 노트북 커널입니다 ({name}). 셀의 커널을 선택하세요.")


def lean_prefix(doc, index):
    blocks = []
    for cell in doc["cells"][:index + 1]:
        if cell.get("cell_type") != "code" or language(doc, cell) != "lean4":
            continue
        code = source(cell).replace("\r\n", "\n")
        if re.match(r"^%%lean4(?:[ \t][^\n]*)?(?:\n|$)", code):
            # Preserve the line occupied by the cell magic for diagnostic offsets.
            code = "\n" + code.partition("\n")[2]
        blocks.append(code)
    return "\n\n".join(blocks), sum(block.count("\n") + 2 for block in blocks[:-1])


def lean_command(document, directory, marker, archives):
    # Only encoded data and shell-quoted arguments enter the fixed VM command.
    from shlex import quote

    saved = json.dumps(archives, ensure_ascii=False, separators=(",", ":")).encode()
    working = quote("/workspace" + (directory if directory != "/" else ""))
    return f"""(
set -e
cd -- {working}
tmp=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf -- "$tmp"' EXIT
printf '%s' '{b64(INSPECTOR)}' | /usr/bin/base64 -d > "$tmp/Inspect.lean"
printf '%s' '{b64(document.encode())}' | /usr/bin/base64 -d > "$tmp/Notebook.lean"
printf '%s' '{b64(saved)}' | /usr/bin/base64 -d > "$tmp/archives.json"
lean=/opt/agora/proof/lean/bin/lean
if [ ! -x "$lean" ]; then printf '%s\n' 'Lean 4 도구가 VM에 설치되어 있지 않습니다.'; exit 1; fi
export LEAN_PATH="$PWD:/workspace"
"$lean" --run "$tmp/Inspect.lean" "$tmp/Notebook.lean" "$tmp/report.json" "$tmp/archives.json" '{marker}-started'
printf '\n%s\n' '{marker}'
/bin/cat "$tmp/report.json"
)
"""


def proof_records(document, rows, recovered=None):
    recovered = recovered or {}
    if not isinstance(rows, list) or len(rows) > 500:
        raise ValueError("Invalid Lean report")
    lines = document.split("\n")
    declarations = {}
    for row in rows:
        name, start, start_col, end, end_col, deps = (
            row[k] for k in ("name", "startLine", "startColumn", "endLine", "endColumn", "dependencies")
        )
        axioms = row.get("axioms", [])
        if (not isinstance(name, str) or not name or len(name) > 500 or name in declarations
                or not all(type(n) is int for n in (start, start_col, end, end_col))
                or not 1 <= start <= end <= len(lines)
                or not 0 <= start_col <= len(lines[start - 1])
                or not 0 <= end_col <= len(lines[end - 1])
                or not isinstance(deps, list)
                or not all(isinstance(dep, str) and 0 < len(dep) <= 500 for dep in deps)
                or not isinstance(axioms, list)
                or not all(axiom in ("propext", "Classical.choice", "Quot.sound") for axiom in axioms)):
            raise ValueError("Invalid Lean declaration")
        span = lines[start - 1:end]
        span[-1] = span[-1][:end_col]
        span[0] = span[0][start_col:]
        content = "\n".join(span)
        if not content.strip():
            raise ValueError("Empty Lean declaration")
        declarations[name] = {"name": name, "source": content, "hash": digest(content),
                              "line": start, "names": sorted(set(deps)),
                              "axioms": sorted(set(axioms)),
                              "span": (start, start_col, end, end_col), "statement": row.get("statement")}
    resolved, pending = {}, set()

    def resolve(name):
        if name not in declarations:
            return recovered.get(name) or "external:" + digest(name)
        if name in resolved:
            return resolved[name]["id"]
        if name in pending:
            raise ValueError("Cyclic Lean report")
        pending.add(name)
        row = declarations[name]
        dependencies = [{"id": resolve(dep), "name": dep} for dep in row.pop("names")]
        dependencies.extend({"id": "axiom:" + digest(axiom), "name": axiom, "kind": "axiom"}
                            for axiom in row.pop("axioms"))
        row["id"] = digest(json.dumps([name, row["hash"], dependencies], ensure_ascii=False))
        row["dependencies"] = dependencies
        resolved[name] = row
        pending.remove(name)
        return row["id"]

    for name in sorted(declarations, key=lambda name: declarations[name]["span"]):
        resolve(name)
    return list(resolved.values())


UNKNOWN_NAME = re.compile(r"unknown (?:identifier|constant) '(.+)'")
UNKNOWN_NAMESPACE = re.compile(r"unknown namespace '(.+)'")
UNKNOWN_FUNCTION = re.compile(r"function expected at\n  ([^\s]+)\nterm has type\n  \?m\.\d+")


def missing_names(diagnostics):
    names = {}
    for message in diagnostics:
        if message["severity"] != "error":
            continue
        match = UNKNOWN_NAME.fullmatch(message["data"]) or UNKNOWN_FUNCTION.fullmatch(message["data"])
        if match and 0 < len(match[1]) <= 500:
            name = match[1].removeprefix("_root_.")
            names.setdefault(name, message["pos"]["line"])
    return names


def recovery_line(diagnostics, selected, line):
    for message in diagnostics:
        match = UNKNOWN_NAMESPACE.fullmatch(message["data"])
        if message["severity"] == "error" and match and selected.startswith(match[1] + "."):
            line = min(line, message["pos"]["line"])
    return line


def lean_attempt(vm_id, file_path, document, marker, archives, *, preparing=False):
    command = lean_command(document, posixpath.dirname(file_path), marker, archives)
    if len(command.encode()) > 65536:
        raise RequestError("Lean 소스와 저장된 선언이 VM 실행 한도를 초과했습니다.", 413)
    started = marker + "-started\n"
    # A readiness probe is safe to retry. Notebook code is retried only before elaboration.
    for _ in range(3):
        result = vm(vm_id, {"language": "bash", "code": command})
        if not result.get("timedOut") or (not preparing and started in result.get("output", "")):
            break
    if "exitCode" not in result:
        raise RequestError(f"Lean 실행 실패 ({result.get('error', 'VM 응답 오류')}).", 503)
    output = result.get("output", "").replace(started, "", 1)
    if result.get("timedOut"):
        if preparing or started not in result.get("output", ""):
            raise RequestError("VM의 Lean 실행 환경 준비 시간이 초과되었습니다. 셀 실행을 다시 시도하세요.", 503)
        output = "Lean 검사 시간 제한을 초과했습니다."
    if result.get("truncated"):
        output = "Lean 검사 결과가 VM 출력 한도를 초과했습니다."
    diagnostics, separator, report = output.rpartition(f"\n{marker}\n")
    notes = (diagnostics if separator else output).strip()
    notes = re.sub(r"/[^\s:]+/Notebook\.lean:", "Notebook.lean:", notes)
    if result["exitCode"] != 0:
        return None, notes or "Lean 검사가 실패했습니다."
    if not separator:
        raise ValueError("Missing Lean report")
    inspection = json.loads(report)
    diagnostics = inspection["diagnostics"]
    formatted = [f"Notebook.lean:{item['pos']['line']}:{item['pos']['column']}: "
                 f"{item['severity']}: {item['data']}" for item in diagnostics]
    return inspection, "\n".join(filter(None, [notes, *formatted]))


def check_lean(vm_id, file_path, document, offset, marker, lookup):
    entries, bindings = [], {}
    attempted = set()
    try:
        readiness, output = lean_attempt(
            vm_id, "/qnb-readiness.lean", "theorem qnbRuntimeReady : True := True.intro\n",
            marker + "-ready", [], preparing=True,
        )
        if readiness is None or not readiness["ok"]:
            raise RequestError(f"VM의 Lean 실행 환경을 준비하지 못했습니다. {output}", 503)
        for attempt in range(4):
            inspection, output = lean_attempt(vm_id, file_path, document, marker, entries)
            if inspection is None:
                return 1, output, [], [], [], [], {}
            if inspection["ok"]:
                break
            if attempt == 3:
                return 1, output, [], [], [], [], {}
            missing = {name: line for name, line in missing_names(inspection["diagnostics"]).items()
                       if name not in attempted}
            if not missing or len(attempted) + len(missing) > 12:
                return 1, output, [], [], [], [], {}
            attempted.update(missing)
            existing = {entry["entry"]["name"] for entry in entries}
            additions = []
            legacy = []
            for name, line in missing.items():
                found = lookup(name)
                if found:
                    entry, imported_ids = found
                    if entry is None:
                        legacy.append(name)
                        continue
                    selected = entry["entry"]["name"]
                    if selected not in existing:
                        existing.add(selected)
                        entry["entry"]["line"] = recovery_line(inspection["diagnostics"], selected, line)
                        additions.append(entry)
                        bindings[selected] = imported_ids
            if not additions:
                if legacy:
                    output += "\n저장된 커널 명제가 필요합니다. 원본 노트북을 다시 실행하세요 · " + ", ".join(legacy)
                return 1, output, [], [], [], [], {}
            entries.extend(additions)
        recovered = inspection["recovered"]
        imported = {}
        for origin in recovered:
            archive_bindings = bindings[origin["root"]]
            for name in origin["names"]:
                if name in archive_bindings:
                    imported[name] = archive_bindings[name]
        rows = proof_records(document, inspection["declarations"], imported)
        definitions = proof_records(document, inspection["definitions"], imported)
        rejected = inspection["rejected"]
        if not isinstance(rejected, list) or not all(isinstance(name, str) for name in rejected):
            raise ValueError("Invalid rejected declarations")
        notes = []
        assumed = [name for origin in recovered for name in origin["names"] if name in imported]
        if assumed:
            notes.append("DB 검증을 신뢰해 공리로 추가한 정리 · " + ", ".join(assumed))
        if entries:
            notes.append("DB에서 복원한 Lean 선언 · " + ", ".join(entry["entry"]["name"] for entry in entries))
        if rejected:
            notes.append("검증 조건을 충족하지 않아 DB 저장에서 제외된 정리 · " + ", ".join(rejected))
        output = "\n".join(filter(None, [output, *notes]))
    except (ValueError, KeyError, TypeError, RecursionError) as error:
        raise RequestError("Lean 검사 결과를 해석할 수 없습니다.", 502) from error
    return 0, output, rows, [row["name"] for row in rows if row["line"] > offset], definitions, entries, imported
