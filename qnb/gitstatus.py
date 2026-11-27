"""Git tracking state for the IDE explorer, computed inside the workspace VM."""

import base64
import posixpath
from shlex import quote

from . import runtime
from .runtime import RequestError

MARKER = "__QNB_GIT__"
MAX_ENTRIES = 4000


def command(folder):
    """Build a read-only bash command printing repo metadata + NUL-separated porcelain v1."""
    working = quote("/workspace" + (folder if folder != "/" else ""))
    # Hooks/fsmonitor are disabled so listing a folder never runs repository-provided programs.
    git = ("git -c core.fsmonitor=false -c core.untrackedCache=false -c safe.directory='*' "
           "-c status.showUntrackedFiles=normal --no-optional-locks")
    return f"""(
cd -- {working} 2>/dev/null || exit 0
printf '%s\\n' '{MARKER}'
for d in */ .[!.]*/; do [ -e "${{d}}.git" ] && printf '%s\\0' "${{d%/}}"; done 2>/dev/null | head -c 65536 | base64 -w0
printf '\\n'
command -v git >/dev/null 2>&1 || {{ printf 'NOGIT\\n'; exit 0; }}
top=$({git} rev-parse --show-toplevel 2>/dev/null) || {{ printf 'NOREPO\\n'; exit 0; }}
printf 'REPO\\n%s\\n' "$top"
{git} status --porcelain=v1 -z -b --ignored=matching 2>/dev/null | head -c 600000 | base64 -w0
printf '\\n'
)"""


def _b64(text):
    try:
        return base64.b64decode(text.strip() or "", validate=False).decode("utf-8", "replace")
    except ValueError:
        return ""


def parse(output, folder):
    """Turn the VM command output into explorer decorations relative to /workspace."""
    _, sep, tail = output.partition(MARKER + "\n")
    if not sep:
        return {"repo": None, "subrepos": []}
    lines = tail.split("\n")
    subrepos = sorted(name for name in _b64(lines[0]).split("\0") if name and "/" not in name)
    lines = lines[1:]
    state = lines[0].strip() if lines else ""
    if state != "REPO" or len(lines) < 3:
        return {"repo": None, "reason": state.lower() or "norepo", "subrepos": subrepos}
    top = lines[1].strip()
    records = _b64(lines[2]).split("\0")
    branch, ahead, behind, upstream = "", 0, 0, ""
    files = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if record.startswith("## "):
            branch, upstream, ahead, behind = _branch(record[3:])
            continue
        if len(record) < 4:
            continue
        code, rel = record[:2], record[3:]
        if code[0] in "RC":
            index += 1  # the original path follows a rename/copy record
        absolute = posixpath.normpath(posixpath.join(top, rel.rstrip("/")))
        if absolute == "/workspace":
            ws_path = "/"
        elif absolute.startswith("/workspace/"):
            ws_path = absolute[len("/workspace"):]
        else:
            continue
        inside = folder == "/" or ws_path == folder or ws_path.startswith(folder + "/")
        ancestor = rel.endswith("/") and folder.startswith(ws_path.rstrip("/") + "/")
        if not (inside or ancestor):
            continue
        files.append([ws_path, _classify(code), rel.endswith("/")])
        if len(files) >= MAX_ENTRIES:
            break
    # A repository rooted above /workspace (e.g. "/") still maps onto workspace paths.
    if top == "/workspace":
        root = "/"
    elif top.startswith("/workspace/"):
        root = top[len("/workspace"):]
    else:
        root = None
    return {
        "repo": root if root is not None else top,
        "repoOutside": root is None,
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "files": files,
        "subrepos": subrepos,
        "truncated": len(files) >= MAX_ENTRIES,
    }


def _branch(header):
    # Examples: "main...origin/main [ahead 1, behind 2]", "No commits yet on main", "HEAD (no branch)"
    ahead = behind = 0
    info = ""
    if " [" in header and header.endswith("]"):
        header, _, info = header.partition(" [")
        info = info[:-1]
        for part in info.split(", "):
            word, _, number = part.partition(" ")
            if word == "ahead" and number.isdigit():
                ahead = int(number)
            elif word == "behind" and number.isdigit():
                behind = int(number)
    if header.startswith("No commits yet on "):
        return header[len("No commits yet on "):], "", 0, 0
    local, _, upstream = header.partition("...")
    return local, upstream, ahead, behind


def _classify(code):
    x, y = code[0], code[1]
    if code == "??":
        return "untracked"
    if code == "!!":
        return "ignored"
    if "U" in code or code in ("AA", "DD"):
        return "conflict"
    if x == "D" or y == "D":
        return "deleted"
    if x == "A":
        return "added"
    if x in "RC":
        return "renamed"
    if y in "MT" or x in "MT":
        return "modified" if y in "MT" else "staged"
    return "modified"


def status(vm_id, folder):
    folder = runtime.path(folder)
    result = runtime.vm(vm_id, {"language": "bash", "code": command(folder)})
    if "exitCode" not in result:
        raise RequestError("VM에서 Git 상태를 확인할 수 없습니다.", 503)
    if result.get("truncated"):
        return {"repo": None, "reason": "truncated"}
    return parse(result.get("output", ""), folder)
