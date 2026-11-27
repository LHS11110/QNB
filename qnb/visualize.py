"""Educational execution & proof visualization helpers for Lean 4 and Python."""

import base64
import json
import posixpath
import re
import secrets
import zlib

from . import runtime, stepper

MAX_PY_STEPS = 300
MAX_PY_STACK = 16
MAX_PY_ITEMS = 12
MAX_PY_HEAP = 40
MAX_PY_STR = 120
MAX_PY_STDOUT = 8192

TACTIC_HINTS = (
    ("theorem", "새로운 정리와 목표 명제를 선언하고 증명을 시작합니다."),
    ("lemma", "보조 정리를 선언하고 증명을 시작합니다."),
    ("example", "이름 없는 연습 명제를 선언하고 증명합니다."),
    ("def", "새로운 함수나 값을 정의합니다."),
    ("abbrev", "전개 가능한 축약 정의를 만듭니다."),
    ("structure", "여러 필드를 묶는 구조체 타입을 정의합니다."),
    ("inductive", "생성자로 이루어진 귀납적 데이터 타입을 정의합니다."),
    ("intro", "전칭(∀) 또는 함의(→) 목표에서 변수·가정을 컨텍스트로 끌어옵니다."),
    ("intros", "목표의 변수와 가정을 한꺼번에 컨텍스트로 가져옵니다."),
    ("induction", "귀납법으로 기저 사례(zero/nil)와 귀납 단계(succ/cons)로 분해합니다."),
    ("rcases", "가정이나 식을 패턴으로 분해해 하위 변수와 조건을 꺼냅니다."),
    ("cases", "생성자 또는 조건에 따라 증명 경우를 나눕니다."),
    ("rw", "등식이나 동치를 이용해 목표 또는 가정을 치환합니다."),
    ("rewrite", "등식 규칙으로 식의 형태를 다시 씁니다."),
    ("simp", "단순화 규칙을 반복 적용해 식을 자동으로 정리합니다."),
    ("exact", "목표 타입과 정확히 일치하는 증명항을 직접 제출합니다."),
    ("apply", "목표와 결론이 맞는 정리·함수를 역방향으로 적용해 하위 목표를 만듭니다."),
    ("refine", "일부 구멍(?_)을 남긴 채 증명항 구조를 채웁니다."),
    ("have", "증명 도중에 사용할 중간 보조 가정을 세우고 증명합니다."),
    ("let", "증명 문맥에 지역 값을 정의합니다."),
    ("constructor", "논리곱(∧)이나 존재(∃) 등 단일 생성자 목표를 분해합니다."),
    ("left", "논리합(∨) 목표에서 왼쪽 명제를 증명하기로 선택합니다."),
    ("right", "논리합(∨) 목표에서 오른쪽 명제를 증명하기로 선택합니다."),
    ("rfl", "양변이 정의상 같음(반사율)을 확인해 목표를 닫습니다."),
    ("unfold", "정의된 함수나 기호를 본문으로 펼칩니다."),
    ("dsimp", "정의상 계산(β/δ-축약)만으로 식을 단순화합니다."),
    ("calc", "등식·부등식 사슬을 단계별로 연결해 증명합니다."),
    ("by_cases", "명제가 참인 경우와 거짓인 경우로 배중률 분기합니다."),
    ("by_contra", "목표의 부정을 가정해 모순을 이끌어내는 귀류법을 시작합니다."),
    ("contradiction", "가정들 사이의 모순을 찾아 목표를 즉시 닫습니다."),
    ("assumption", "현재 가정 중 목표와 일치하는 항목으로 증명합니다."),
    ("funext", "함수의 같음을 모든 입력에 대한 출력의 같음으로 바꿉니다."),
    ("congr", "함수 적용의 바깥 구조를 맞추고 인자 일치 목표로 분해합니다."),
    ("ext", "외연성 원리를 적용해 구조체·함수·집합의 같음을 분해합니다."),
    ("#check", "식의 타입을 확인합니다."),
    ("#eval", "식을 계산해 평가 결과를 출력합니다."),
    ("#print", "선언의 정의 또는 의존 공리를 출력합니다."),
)


def tactic_hint(line_text):
    stripped = line_text.strip()
    if not stripped:
        return ""
    head = stripped.lstrip("|·• ").split(None, 1)[0]
    head_clean = head.rstrip(":,([{").lower()
    for token, hint in TACTIC_HINTS:
        if head_clean == token or stripped.startswith(token + " "):
            return hint
    return "현재 증명 상태(가정 → 목표)를 변환합니다."


def parse_lean_goal(raw_goal):
    """Parse a single Lean plainGoal string into case, hypotheses, and target."""
    if not isinstance(raw_goal, str) or not raw_goal.strip():
        return {"case": None, "hypotheses": [], "target": ""}
    lines = raw_goal.splitlines()
    case_name = None
    if lines and lines[0].startswith("case "):
        case_name = lines[0][5:].strip()
        lines = lines[1:]

    ctx_lines = []
    target_lines = []
    in_target = False
    for line in lines:
        if not in_target and line.lstrip().startswith("⊢"):
            in_target = True
            target_lines.append(line.lstrip()[1:].lstrip())
        elif in_target:
            target_lines.append(line)
        else:
            ctx_lines.append(line)

    hypotheses = []
    for line in ctx_lines:
        if not line.strip():
            continue
        if not line[0].isspace() and ":" in line:
            name, typ = line.split(":", 1)
            hypotheses.append({"name": name.strip(), "type": typ.strip()})
        elif hypotheses:
            hypotheses[-1]["type"] += " " + line.strip()
        else:
            hypotheses.append({"name": "", "type": line.strip()})

    return {
        "case": case_name,
        "hypotheses": hypotheses,
        "target": "\n".join(target_lines).strip(),
    }


def flatten_archives(entries):
    """Collect DB-restored prerequisite declarations in post-order without duplicates."""
    seen = set()
    sources = []

    def visit(item):
        entry = item.get("entry") if isinstance(item, dict) else None
        if not isinstance(entry, dict):
            return
        name = entry.get("name")
        for prereq in entry.get("prerequisites") or []:
            visit(prereq)
        if name and name in seen:
            return
        if name:
            seen.add(name)
        src = entry.get("source")
        if isinstance(src, str) and src.strip():
            sources.append(src.strip())

    for entry in entries or []:
        visit(entry)
    return sources


def _prepare_lsp_document(document, entries):
    """Build an LSP document with imports first, DB archive sources second, and user lines mapped."""
    doc_lines = document.splitlines()
    import_indices = []
    body_indices = []
    in_header = True
    for idx, line in enumerate(doc_lines):
        stripped = line.strip()
        if in_header and (not stripped or stripped.startswith("import ") or stripped.startswith("--")):
            import_indices.append(idx)
        else:
            in_header = False
            body_indices.append(idx)

    prelude_lines = []
    for src in flatten_archives(entries):
        for line in src.splitlines():
            if not line.strip().startswith("import "):
                prelude_lines.append(line)
        prelude_lines.append("")

    combined = [doc_lines[i] for i in import_indices] + prelude_lines + [doc_lines[i] for i in body_indices]
    line_map = {}
    for pos, orig_idx in enumerate(import_indices):
        line_map[orig_idx + 1] = pos
    offset = len(import_indices) + len(prelude_lines)
    for pos, orig_idx in enumerate(body_indices):
        line_map[orig_idx + 1] = offset + pos
    return "\n".join(combined), line_map


def _strip_lean_inline_comment(line):
    """Strip a trailing Lean `--` line comment outside double-quoted string literals."""
    in_str = False
    escaped = False
    for idx, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_str:
            escaped = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if not in_str and ch == "-" and idx + 1 < len(line) and line[idx + 1] == "-":
            return line[:idx].rstrip()
    return line.rstrip()


def _utf16_col(text, char_index):
    return len(text[:char_index].encode("utf-16-le")) // 2


def _lean_line_span(line):
    """Return accurate UTF-16 (col_start, col_end, hover_tokens) for a Lean proof line.

    Adjusts col_start past bullets (`·`, `•`) and inline `| case =>` headers when a
    tactic follows on the same line, and trims inline `--` comments from col_end so
    LSP plainGoal probes land right before and right after the tactic itself.
    """
    code = _strip_lean_inline_comment(line)
    indent = len(code) - len(code.lstrip())
    probe_start = indent
    rest = code[indent:]
    bullet_match = re.match(r"^(?:[·•+\-*])\s+(?=\S)", rest)
    if bullet_match:
        probe_start += bullet_match.end()
    else:
        case_match = re.match(r"^\|\s*[^=\n]*=>\s+(?=\S)", rest)
        if case_match:
            probe_start += case_match.end()

    # Extract up to 2 identifier/theorem tokens (e.g. `Nat.add_succ`, `ih`) for hover docs.
    tokens = []
    seen = set()
    body = code[probe_start:]
    skip = {"rw", "simp", "dsimp", "apply", "exact", "intro", "intros", "cases", "induction",
            "have", "let", "show", "calc", "with", "at", "only", "by", "rfl", "trivial",
            "theorem", "lemma", "def", "example", "import", "open", "where", "match", "fun"}
    for match in re.finditer(r"\b[A-Za-z_][A-Za-z0-9_'.]*", body):
        name = match.group(0)
        if name in skip or name in seen:
            continue
        seen.add(name)
        tokens.append({"name": name, "col": _utf16_col(line, probe_start + match.start())})
        if len(tokens) >= 2:
            break
    col_start = _utf16_col(line, probe_start)
    col_end = _utf16_col(line, len(code))
    if col_end < col_start:
        col_end = col_start
    return col_start, col_end, tokens


def _extract_hover_signature(hover_result):
    if not isinstance(hover_result, dict):
        return ""
    contents = hover_result.get("contents")
    raw = ""
    if isinstance(contents, dict):
        raw = contents.get("value") or ""
    elif isinstance(contents, list):
        raw = "\n".join(c.get("value", "") if isinstance(c, dict) else str(c) for c in contents)
    elif isinstance(contents, str):
        raw = contents
    if not raw:
        return ""
    # Prefer the first ```lean ... ``` code block if present, else first non-empty lines.
    block = re.search(r"```(?:lean4?|lean)?\s*\n(.*?)```", raw, re.S)
    text = block.group(1).strip() if block else raw.strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return " ".join(lines)[:220]


def _diff_targets(before_target, after_target):
    """Split before/after proposition targets into (prefix, redex, contractum, suffix)."""
    if not before_target and not after_target:
        return "", "", "", ""
    if not after_target:
        return "", before_target, "True (Q.E.D. ✓)", ""
    if before_target == after_target:
        return before_target, "", "", ""
    prefix_len = 0
    limit = min(len(before_target), len(after_target))
    while prefix_len < limit and before_target[prefix_len] == after_target[prefix_len]:
        prefix_len += 1
    # Snap back to delimiter boundary if inside a word when helpful.
    while prefix_len > 0 and prefix_len < limit and before_target[prefix_len].isalnum() and after_target[prefix_len].isalnum():
        if before_target[prefix_len - 1].isalnum():
            prefix_len -= 1
        else:
            break
    b_rem = before_target[prefix_len:]
    a_rem = after_target[prefix_len:]
    suffix_len = 0
    s_limit = min(len(b_rem), len(a_rem))
    while suffix_len < s_limit and b_rem[-1 - suffix_len] == a_rem[-1 - suffix_len]:
        suffix_len += 1
    prefix = before_target[:prefix_len]
    suffix = b_rem[len(b_rem) - suffix_len:] if suffix_len else ""
    redex = b_rem[:len(b_rem) - suffix_len] if suffix_len else b_rem
    contractum = a_rem[:len(a_rem) - suffix_len] if suffix_len else a_rem
    return prefix, redex, contractum, suffix


def compute_lean_proposition_trace(raw_line, before_goals, after_goals, *, added_hyps=None, hover_items=None):
    """Compute a human-readable proposition reduction/calculation record for one Lean step."""
    stripped = _strip_lean_inline_comment(raw_line).strip()
    tactic = stripped.split(None, 1)[0] if stripped else ""
    tactic = tactic.lstrip("·•+-*")
    if not before_goals and not after_goals:
        return None
    before_target = before_goals[0]["target"] if before_goals else ""
    after_target = after_goals[0]["target"] if after_goals else ""
    solved = bool(before_goals) and len(after_goals) == 0

    rules = []
    for item in (hover_items or []):
        name = item.get("name") or ""
        sig = _extract_hover_signature(item.get("hover"))
        if name and sig:
            rules.append({"name": name, "signature": sig})
    # Also note bracketed rule names in `rw [...]` / `simp [...]` even if hover was unavailable.
    seen_rules = {r["name"] for r in rules}
    for bm in re.findall(r"\[([^\]]+)\]", stripped):
        for tok in bm.split(","):
            clean = tok.strip().lstrip("←").strip().split(None, 1)[0]
            if clean and clean not in seen_rules and not clean.startswith("_"):
                seen_rules.add(clean)
                rules.append({"name": clean, "signature": ""})

    prefix, redex, contractum, suffix = _diff_targets(before_target, after_target)
    if solved:
        op = "목표 종결 (Q.E.D.)" if tactic not in ("rfl", "decide", "omega", "simp", "exact") else f"계산 종결 ({tactic})"
        summary = f"`{before_target}` 양변이 정의/동치로 정규화되어 목표가 완전히 닫혔습니다."
    elif len(after_goals) > len(before_goals):
        op = f"하위 목표 분할 ({len(before_goals)} → {len(after_goals)})"
        branch_preview = "  |  ".join(g["target"] for g in after_goals[:3])
        if len(after_goals) > 3:
            branch_preview += f"  (+{len(after_goals) - 3}개)"
        prefix, redex, contractum, suffix = "", before_target, branch_preview, ""
        summary = f"`{tactic or stripped}` 적용으로 `{len(after_goals)}`개의 사례/귀납 하위 명제로 전개되었습니다."
    elif len(after_goals) < len(before_goals) and after_goals:
        op = f"현 하위 목표 완료 (남은 목표 {len(after_goals)}개)"
        summary = f"현재 분기를 해결하고 다음 하위 목표 `{after_target}`로 이동했습니다."
    elif before_target == after_target and (added_hyps or []):
        op = "맥락 가설 도입 (Context 확장)"
        hyp_text = ", ".join(added_hyps)
        summary = f"명제 본문 `{after_target}`을 유지하면서 가설 `{hyp_text}`를 문맥에 추가했습니다."
    elif tactic in ("rw", "rewrite"):
        op = "등식 치환 (Rewrite)"
        rule_names = ", ".join(r["name"] for r in rules[:3]) or stripped
        summary = f"`{rule_names}` 등식을 이용해 `{redex or before_target}` → `{contractum or after_target}` 로 치환했습니다."
    elif tactic in ("simp", "dsimp", "norm_num", "ring"):
        op = f"정규화 · 단순화 ({tactic})"
        summary = f"정의 전개와 단순화 규칙으로 `{redex or before_target}` 를 `{contractum or after_target}` 로 계산했습니다."
    elif tactic in ("intro", "intros") or added_hyps:
        op = "전칭/함의 가설 도입"
        summary = f"목표에서 가설({', '.join(added_hyps or [])})을 추출해 남은 결론 `{after_target}`을 정리했습니다."
    else:
        op = f"전술 변환 ({tactic or 'step'})"
        if before_target != after_target:
            summary = f"`{before_target}` 에서 `{after_target}` 로 목표 명제가 변환되었습니다."
        else:
            summary = "현재 증명 상태가 유지/정리되었습니다."

    return {
        "operation": op,
        "before": before_target,
        "after": after_target,
        "prefix": prefix,
        "redex": redex,
        "contractum": contractum,
        "suffix": suffix,
        "subgoalCountBefore": len(before_goals),
        "subgoalCountAfter": len(after_goals),
        "rules": rules[:4],
        "summary": summary,
    }


def _build_lsp_probe_script(lsp_doc, line_queries, working_dir):
    payload = json.dumps({"doc": lsp_doc, "queries": line_queries, "cwd": working_dir}, ensure_ascii=True)
    return f"""
import ctypes, json, os, selectors, signal, subprocess, time

cfg = json.loads({payload!r})
# Become a child subreaper: the `lean --worker` the server spawns is re-parented to us (not the
# VM's PID 1, which never reaps it), so killing the server cannot leave zombies that eat the
# VM's small pids budget.
try:
    ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
except Exception:
    pass
cwd = cfg["cwd"] if os.path.isdir(cfg["cwd"]) else "/workspace"
env = dict(os.environ)
env["LEAN_PATH"] = cwd + ":/workspace"
# `-j2`: with the default single task thread on a 1-vCPU VM the Lean 4.10 file worker deadlocks
# mid-elaboration and never answers $/lean/plainGoal (every probe then waited out the deadline).
proc = subprocess.Popen(
    ["/opt/agora/proof/lean/bin/lean", "--server", "-j2"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    cwd=cwd, env=env, start_new_session=True,
)
buf = b""
deadline = time.monotonic() + 24.0

def send(msg):
    raw = json.dumps(msg).encode("utf-8")
    proc.stdin.write(f"Content-Length: {{len(raw)}}\\r\\n\\r\\n".encode() + raw)
    proc.stdin.flush()

def pump(wanted_ids):
    global buf
    responses = {{}}
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline and not wanted_ids.issubset(responses):
            progressed = False
            while b"\\r\\n\\r\\n" in buf:
                hdr, rest = buf.split(b"\\r\\n\\r\\n", 1)
                cl = 0
                for h in hdr.split(b"\\r\\n"):
                    if h.lower().startswith(b"content-length:"):
                        cl = int(h.split(b":", 1)[1].strip())
                if len(rest) < cl:
                    break
                msg = json.loads(rest[:cl])
                buf = rest[cl:]
                progressed = True
                mid = msg.get("id")
                if mid in wanted_ids:
                    responses[mid] = msg.get("result")
                elif "method" in msg and "id" in msg:
                    send({{"jsonrpc": "2.0", "id": msg["id"], "result": None}})
            if wanted_ids.issubset(responses):
                break
            if progressed:
                continue
            rem = deadline - time.monotonic()
            if rem <= 0 or not sel.select(min(rem, 0.1)):
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            buf += chunk
    finally:
        sel.close()
    return responses

out = []
try:
    uri = "file://" + cwd.rstrip("/") + "/QnbViz.lean"
    send({{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {{"processId": None, "rootUri": "file://" + cwd, "capabilities": {{}}}}}})
    pump({{1}})
    send({{"jsonrpc": "2.0", "method": "initialized", "params": {{}}}})
    send({{"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {{"textDocument": {{"uri": uri, "languageId": "lean4", "version": 1, "text": cfg["doc"]}}}}}})
    # Pipeline plainGoal + hover requests across lines for faster response.
    req_id = 10
    wanted = set()
    meta = []
    for q in cfg["queries"]:
        req_id += 1
        before_id = req_id
        send({{"jsonrpc": "2.0", "id": before_id, "method": "$/lean/plainGoal", "params": {{"textDocument": {{"uri": uri}}, "position": {{"line": q["lspLine"], "character": q["colStart"]}}}}}})
        req_id += 1
        after_id = req_id
        send({{"jsonrpc": "2.0", "id": after_id, "method": "$/lean/plainGoal", "params": {{"textDocument": {{"uri": uri}}, "position": {{"line": q["lspLine"], "character": q["colEnd"]}}}}}})
        wanted.update((before_id, after_id))
        hover_ids = []
        for tok in q.get("tokens", [])[:2]:
            req_id += 1
            hid = req_id
            send({{"jsonrpc": "2.0", "id": hid, "method": "textDocument/hover", "params": {{"textDocument": {{"uri": uri}}, "position": {{"line": q["lspLine"], "character": tok["col"]}}}}}})
            wanted.add(hid)
            hover_ids.append((tok["name"], hid))
        meta.append((q["origLine"], before_id, after_id, hover_ids))
    responses = pump(wanted)
    for orig_line, before_id, after_id, hover_ids in meta:
        out.append({{
            "line": orig_line,
            "before": responses.get(before_id),
            "after": responses.get(after_id),
            "hovers": [{{"name": name, "hover": responses.get(hid)}} for name, hid in hover_ids if responses.get(hid)],
        }})
finally:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        proc.kill()
    reap_until = time.monotonic() + 2.0
    while time.monotonic() < reap_until:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0:
            time.sleep(0.02)
print(json.dumps(out, ensure_ascii=True))
"""


def probe_lean_lsp(vm_id, file_path, document, entries=None):
    """Run pipelined Lean 4 LSP goal + hover probe safely & statelessly in the VM."""
    lines = document.splitlines()
    lsp_doc, line_map = _prepare_lsp_document(document, entries)
    queries = []
    in_block = False
    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("/-"):
            if "-/" not in stripped[2:]:
                in_block = True
            continue
        if in_block:
            if "-/" in stripped:
                in_block = False
            continue
        if stripped.startswith("--"):
            continue
        col_start, col_end, tokens = _lean_line_span(line)
        queries.append({
            "origLine": idx,
            "lspLine": line_map[idx],
            "colStart": col_start,
            "colEnd": col_end,
            "tokens": tokens,
        })
        if len(queries) >= 80:
            break

    working = "/workspace" + (posixpath.dirname(file_path) if posixpath.dirname(file_path) != "/" else "")
    lsp_rows = {}
    if queries:
        try:
            script = _build_lsp_probe_script(lsp_doc, queries, working)
            res = runtime.vm(vm_id, {"language": "python", "code": script, "stateless": True})
            if res.get("exitCode") == 0 and res.get("output"):
                for item in json.loads(res["output"].strip().splitlines()[-1]):
                    lsp_rows[item["line"]] = item
        except (runtime.RequestError, ValueError, KeyError, IndexError):
            lsp_rows = {}
    return lines, queries, lsp_rows


def collect_lean_visualization(vm_id, file_path, document, *, status, rows, definitions, entries, output, pre_probed=None):
    """Collect Lean 4 tactic-by-tactic goals, proposition computation traces, and 4-stage pipeline."""
    if pre_probed is not None and not entries:
        lines, queries, lsp_rows = pre_probed
    else:
        lines, queries, lsp_rows = probe_lean_lsp(vm_id, file_path, document, entries)

    steps = []
    for idx, q in enumerate(queries):
        orig_line = q["origLine"]
        raw_line = lines[orig_line - 1]
        probed = lsp_rows.get(orig_line, {})
        before_raw = probed.get("before")
        after_raw = probed.get("after")
        before_goals = [parse_lean_goal(g) for g in (before_raw or {}).get("goals", [])]
        after_goals = [parse_lean_goal(g) for g in (after_raw or {}).get("goals", [])]
        solved = after_raw is not None and len(after_goals) == 0 and (len(before_goals) > 0 or bool(before_raw))
        if not before_goals and not after_goals and not solved:
            step_status = "decl"
        elif solved:
            step_status = "solved"
        else:
            step_status = "open"

        before_names = {h["name"] for h in (before_goals[0]["hypotheses"] if before_goals else []) if h["name"]}
        added = [
            h["name"]
            for h in (after_goals[0]["hypotheses"] if after_goals else [])
            if h["name"] and h["name"] not in before_names
        ]
        # Compute endLine up to the line right before the next parsed step (keeps comments/blanks attached).
        next_line = queries[idx + 1]["origLine"] if idx + 1 < len(queries) else len(lines) + 1
        end_line = max(orig_line, next_line - 1)
        computation = compute_lean_proposition_trace(
            raw_line, before_goals, after_goals, added_hyps=added, hover_items=probed.get("hovers") or [],
        )
        steps.append({
            "index": len(steps),
            "line": orig_line,
            "endLine": end_line,
            "colStart": q["colStart"],
            "colEnd": q["colEnd"],
            "code": raw_line,
            "tactic": _strip_lean_inline_comment(raw_line).strip().split(None, 1)[0] if raw_line.strip() else "",
            "hint": tactic_hint(raw_line),
            "goalsBefore": before_goals,
            "goalsAfter": after_goals,
            "addedHypotheses": added,
            "computation": computation,
            "status": step_status,
        })

    recovered = [e["entry"]["name"] for e in (entries or []) if isinstance(e, dict) and e.get("entry")]
    decls = [
        {
            "name": r["name"],
            "kind": "theorem",
            "line": r["line"],
            "hash": r["hash"],
            "dependencies": [d["name"] for d in r.get("dependencies", []) if d.get("kind") != "axiom"],
            "axioms": [d["name"] for d in r.get("dependencies", []) if d.get("kind") == "axiom"],
        }
        for r in (rows or [])
    ] + [
        {
            "name": d["name"],
            "kind": "def",
            "line": d["line"],
            "hash": d["hash"],
            "dependencies": [dep["name"] for dep in d.get("dependencies", []) if dep.get("kind") != "axiom"],
            "axioms": [],
        }
        for d in (definitions or [])
    ]
    decls.sort(key=lambda d: d["line"])

    pipeline = [
        {
            "id": "parse",
            "label": "구문 · DB 복원",
            "status": "ok",
            "detail": f"복원 선언 {len(recovered)}건" if recovered else "독립 환경",
        },
        {
            "id": "elaborate",
            "label": "전술 전개",
            "status": "ok" if status == 0 else "error",
            "detail": f"{sum(1 for s in steps if s['status'] != 'decl')}개 상태 단계",
        },
        {
            "id": "kernel",
            "label": "커널 검증",
            "status": "ok" if status == 0 else "error",
            "detail": f"정리 {len(rows)}개 · 정의 {len(definitions)}개" if status == 0 else "타입/증명 오류",
        },
        {
            "id": "store",
            "label": "SHA-256 저장",
            "status": "ok" if (status == 0 and rows) else ("skip" if status == 0 else "error"),
            "detail": f"DB 영속화 {len(rows)}건" if (status == 0 and rows) else "저장 대상 없음",
        },
    ]

    return {
        "kind": "lean4",
        "path": file_path,
        "ok": status == 0,
        "steps": steps,
        "pipeline": pipeline,
        "declarations": decls,
        "recovered": recovered,
        "output": output,
    }


# --------------------------------------------------------------------------- Python Tracer

PYTHON_TRACER_CORE = """
import io as _qnb_io
import json as _qnb_json
import os as _qnb_os
import sys as _qnb_sys
import types as _qnb_types
import collections as _qnb_collections

_QNB_MAX_STEPS = 300
_QNB_MAX_STACK = 16
_QNB_MAX_ITEMS = 12
_QNB_MAX_HEAP = 60
_QNB_MAX_STR = 120
_QNB_MAX_STDOUT = 8192
_QNB_SKIP_VARS = {
    "In", "Out", "_", "__", "___", "_oh", "_dh", "_ih", "exit", "quit", "get_ipython",
    "__name__", "__doc__", "__package__", "__loader__", "__spec__", "__annotations__",
    "__builtins__", "__file__", "__cached__",
}

def _qnb_clip(text, limit=_QNB_MAX_STR):
    if len(text) > limit:
        return text[:limit - 1] + "…"
    return text

def _qnb_serialize(val, heap, seen, depth=0):
    if val is None or isinstance(val, (bool, int, float)):
        if isinstance(val, float) and (val != val or val == float("inf") or val == float("-inf")):
            return {"kind": "repr", "type": "float", "text": str(val)}
        return {"kind": "prim", "type": type(val).__name__, "value": val}
    if isinstance(val, str):
        return {"kind": "prim", "type": "str", "value": _qnb_clip(val)}
    # containers stay shallow; objects (linked lists, trees, graph nodes) may nest deeper
    if depth >= (7 if hasattr(val, "__dict__") else 4):
        return {"kind": "repr", "type": type(val).__name__, "text": _qnb_clip(repr(val))}

    oid = id(val)
    if oid in seen:
        return {"kind": "ref", "id": seen[oid]}
    if len(heap) >= _QNB_MAX_HEAP:
        return {"kind": "repr", "type": type(val).__name__, "text": _qnb_clip(repr(val))}

    ref_id = f"obj_{len(heap) + 1}"
    # Reserve the id before serialising children, otherwise nested objects get the same id.
    if isinstance(val, (list, tuple, set, frozenset, _qnb_collections.deque)):
        seen[oid] = ref_id
        heap[ref_id] = {"id": ref_id}
        seq = list(val)
        entry = {
            "id": ref_id,
            "type": type(val).__name__,
            "length": len(seq),
            "items": [_qnb_serialize(x, heap, seen, depth + 1) for x in seq[:_QNB_MAX_ITEMS]],
            "truncated": len(seq) > _QNB_MAX_ITEMS,
        }
        heap[ref_id] = entry
        return {"kind": "ref", "id": ref_id}
    if isinstance(val, dict):
        seen[oid] = ref_id
        heap[ref_id] = {"id": ref_id}
        pairs = list(val.items())[:_QNB_MAX_ITEMS]
        entry = {
            "id": ref_id,
            "type": type(val).__name__ if type(val).__name__ in ("defaultdict", "OrderedDict", "Counter") else "dict",
            "length": len(val),
            "fields": [[_qnb_clip(str(k), 40), _qnb_serialize(v, heap, seen, depth + 1)] for k, v in pairs],
            "truncated": len(val) > _QNB_MAX_ITEMS,
        }
        heap[ref_id] = entry
        return {"kind": "ref", "id": ref_id}
    if hasattr(val, "__dict__") and not isinstance(val, (type, _qnb_types.ModuleType, _qnb_types.FunctionType)):
        seen[oid] = ref_id
        heap[ref_id] = {"id": ref_id}
        raw_fields = [(k, v) for k, v in vars(val).items() if not k.startswith("__") and not callable(v)]
        entry = {
            "id": ref_id,
            "type": type(val).__name__,
            "length": len(raw_fields),
            "fields": [[_qnb_clip(str(k), 40), _qnb_serialize(v, heap, seen, depth + 1)] for k, v in raw_fields[:_QNB_MAX_ITEMS]],
            "truncated": len(raw_fields) > _QNB_MAX_ITEMS,
        }
        heap[ref_id] = entry
        return {"kind": "ref", "id": ref_id}
    return {"kind": "repr", "type": type(val).__name__, "text": _qnb_clip(repr(val))}

def _qnb_should_trace(frame):
    fn = frame.f_code.co_filename or ""
    name = frame.f_code.co_name or ""
    if name.startswith("_qnb_"):
        return False
    if fn == "<cell>":
        return True
    return fn.startswith("/workspace/") and not fn.startswith("/workspace/.python")

def _qnb_norm_file(fn, primary):
    if fn == "<cell>":
        return primary
    if fn.startswith("/workspace/"):
        return fn[10:]
    return fn

def _qnb_make_tracer(primary_path, stdout_buf, source_lines_map):
    steps = []
    call_edges = {}
    state = {"truncated": False, "last_error": None}

    def capture_stack(frame):
        frames = []
        cur = frame
        while cur is not None and len(frames) < _QNB_MAX_STACK:
            if _qnb_should_trace(cur):
                frames.append(cur)
            cur = cur.f_back
        frames.reverse()
        heap = {}
        seen = {}
        out = []
        for f in frames:
            loc = {}
            for k, v in list(f.f_locals.items()):
                if k in _QNB_SKIP_VARS or k.startswith("_qnb_"):
                    continue
                if isinstance(v, (_qnb_types.ModuleType, _qnb_types.FunctionType, _qnb_types.BuiltinFunctionType, type)):
                    continue
                loc[str(k)] = _qnb_serialize(v, heap, seen)
                if len(loc) >= 24:
                    break
            fn = _qnb_norm_file(f.f_code.co_filename, primary_path)
            func = "<module>" if f.f_code.co_name == "<module>" else f.f_code.co_name
            out.append({"file": fn, "func": func, "line": f.f_lineno, "locals": loc})
        return out, heap

    def explain_step(event, func, line, code_line, arg):
        if event == "call":
            return f"함수 {func}() 호출 진입"
        if event == "return":
            if func == "<module>":
                return "실행을 마쳤습니다"
            return f"{func}() 반환 → {_qnb_clip(repr(arg), 60)}"
        if event == "exception":
            exc_type = arg[0].__name__ if arg and arg[0] else "Error"
            exc_val = _qnb_clip(str(arg[1]) if arg and len(arg) > 1 else "", 60)
            return f"예외 발생: {exc_type}: {exc_val}"
        snippet = code_line.strip()
        if snippet:
            return f"{line}행 실행: {_qnb_clip(snippet, 64)}"
        return f"{line}행 실행"

    def tracer(frame, event, arg):
        if not _qnb_should_trace(frame):
            return None
        if event == "call":
            caller = frame.f_back
            if caller is not None and _qnb_should_trace(caller):
                src_file = _qnb_norm_file(caller.f_code.co_filename, primary_path)
                src_func = "<module>" if caller.f_code.co_name == "<module>" else caller.f_code.co_name
                dst_file = _qnb_norm_file(frame.f_code.co_filename, primary_path)
                dst_func = frame.f_code.co_name
                key = (src_file, src_func, dst_file, dst_func)
                call_edges[key] = call_edges.get(key, 0) + 1
        if event in ("line", "call", "return", "exception"):
            if len(steps) >= _QNB_MAX_STEPS:
                state["truncated"] = True
                _qnb_sys.settrace(None)
                return None
            fn = _qnb_norm_file(frame.f_code.co_filename, primary_path)
            func = "<module>" if frame.f_code.co_name == "<module>" else frame.f_code.co_name
            line_no = frame.f_lineno
            lines = source_lines_map.get(fn)
            if lines is None and frame.f_code.co_filename.startswith("/workspace/"):
                try:
                    with open(frame.f_code.co_filename, "r", encoding="utf-8") as fp:
                        lines = fp.read().splitlines()
                except OSError:
                    lines = []
                source_lines_map[fn] = lines
            code_line = lines[line_no - 1] if lines and 1 <= line_no <= len(lines) else ""
            stack, heap = capture_stack(frame)
            out_text = stdout_buf.getvalue() if stdout_buf is not None else ""
            if len(out_text) > _QNB_MAX_STDOUT:
                out_text = out_text[-_QNB_MAX_STDOUT:]
            ret_val = _qnb_clip(repr(arg), 80) if event == "return" and func != "<module>" else None
            err_text = None
            if event == "exception" and arg and arg[0]:
                err_text = f"{arg[0].__name__}: {_qnb_clip(str(arg[1]), 120)}"
                state["last_error"] = err_text
            steps.append({
                "index": len(steps),
                "event": event,
                "file": fn,
                "func": func,
                "line": line_no,
                "code": code_line,
                "explain": explain_step(event, func, line_no, code_line, arg),
                "stack": stack,
                "heap": heap,
                "stdout": out_text,
                "returnValue": ret_val,
                "error": err_text,
            })
        return tracer

    def finalize():
        edges = [
            {"fromFile": k[0], "fromFunc": k[1], "toFile": k[2], "toFunc": k[3], "count": c}
            for k, c in call_edges.items()
        ]
        return {
            "kind": "python",
            "primaryFile": primary_path,
            "steps": steps,
            "callEdges": edges,
            "truncatedSteps": state["truncated"],
            "totalSteps": len(steps),
        }

    return tracer, finalize
"""


def _decode_trace_line(line):
    text = (line or "").strip()
    if text.startswith("QNBZ:"):
        raw = zlib.decompress(base64.b64decode(text[5:])).decode("utf-8")
        return json.loads(raw)
    return json.loads(text)


def _enrich_python_viz(viz):
    """Attach step variable diffs and pipeline summary for the code visualizer."""
    steps = viz.get("steps") or []
    for idx, step in enumerate(steps):
        if "changes" not in step:
            step["changes"] = stepper.compute_step_changes(steps[idx - 1] if idx > 0 else None, step)
    if "pipeline" not in viz:
        max_heap = max((len(s.get("heap") or {}) for s in steps), default=0)
        ok = bool(viz.get("ok", True))
        viz["pipeline"] = [
            {"id": "parse", "label": "AST 구문 파싱", "status": "ok" if (steps or ok) else "error", "detail": "준비됨"},
            {"id": "trace", "label": "sys.settrace 추적", "status": "ok" if ok else "error",
             "detail": f"{len(steps)}단계" if ok else "예외 중단"},
            {"id": "memory", "label": "스택·힙 분석", "status": "ok", "detail": f"힙 객체 {max_heap}개"},
        ]
    return viz


def trace_python_script(vm_id, file_path, code):
    """Execute a .py file inside the VM under sys.settrace and capture execution steps."""
    working = "/workspace" + (posixpath.dirname(file_path) if posixpath.dirname(file_path) != "/" else "")
    runner = f"""{PYTHON_TRACER_CORE}
import base64 as _qnb_b64
import contextlib as _qnb_ctx
import pathlib as _qnb_path
import traceback as _qnb_tb
import zlib as _qnb_zlib

_qnb_code = {code!r}
_qnb_path_str = {file_path!r}
_qnb_prev_cwd = _qnb_os.getcwd()
_qnb_cwd = {working!r}
if _qnb_os.path.isdir(_qnb_cwd):
    _qnb_os.chdir(_qnb_cwd)
if _qnb_cwd not in _qnb_sys.path:
    _qnb_sys.path.insert(0, _qnb_cwd)
if "/workspace" not in _qnb_sys.path:
    _qnb_sys.path.insert(1, "/workspace")

class _QnbTee(_qnb_io.TextIOBase):
    def __init__(self, primary, mirror):
        self.primary = primary
        self.mirror = mirror
    def write(self, s):
        self.primary.write(s)
        self.mirror.write(s)
        return len(s)
    def flush(self):
        self.primary.flush()
        self.mirror.flush()

_qnb_buf = _qnb_io.StringIO()
_qnb_err_buf = _qnb_io.StringIO()
_qnb_src_map = {{_qnb_path_str: _qnb_code.splitlines()}}
_qnb_tracer, _qnb_fin = _qnb_make_tracer(_qnb_path_str, _qnb_buf, _qnb_src_map)
_qnb_ns = {{"__name__": "__main__", "__file__": "/workspace" + _qnb_path_str}}
_qnb_rc = 0
try:
    for _qnb_mname, _qnb_mod in list(_qnb_sys.modules.items()):
        _qnb_mfile = getattr(_qnb_mod, '__file__', None) or ''
        if isinstance(_qnb_mfile, str) and _qnb_mfile.startswith('/workspace/'):
            _qnb_sys.modules.pop(_qnb_mname, None)
    _qnb_compiled = compile(_qnb_code, "/workspace" + _qnb_path_str, "exec")
    with _qnb_ctx.redirect_stdout(_qnb_buf), _qnb_ctx.redirect_stderr(_qnb_err_buf):
        _qnb_sys.settrace(_qnb_tracer)
        try:
            exec(_qnb_compiled, _qnb_ns, _qnb_ns)
        finally:
            _qnb_sys.settrace(None)
except BaseException:
    _qnb_rc = 1
    _qnb_tb.print_exc(file=_qnb_err_buf)
finally:
    try:
        _qnb_os.chdir(_qnb_prev_cwd)
    except OSError:
        pass

_qnb_viz = _qnb_fin()
_qnb_viz["ok"] = (_qnb_rc == 0)
_qnb_out = _qnb_buf.getvalue()
_qnb_err = _qnb_err_buf.getvalue()
_qnb_payload = _qnb_json.dumps({{
    "exitCode": _qnb_rc,
    "stdout": _qnb_out,
    "stderr": _qnb_err,
    "visualization": _qnb_viz,
}}, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
print("QNBZ:" + _qnb_b64.b64encode(_qnb_zlib.compress(_qnb_payload, 6)).decode("ascii"))
"""
    res = runtime.vm(vm_id, {"language": "python", "code": runner, "stateless": True})
    if "exitCode" not in res:
        raise runtime.RequestError(f"Python 실행 실패 ({res.get('error', 'VM 응답 오류')}).", 503)
    raw = (res.get("output") or "").strip()
    if res.get("exitCode") != 0 or not raw:
        err_msg = raw or "Python 시각화 실행에 실패했습니다."
        return {
            "exitCode": 1,
            "outputs": [{"output_type": "stream", "name": "stderr", "text": err_msg}],
            "visualization": {
                "kind": "python",
                "primaryFile": file_path,
                "ok": False,
                "steps": [],
                "callEdges": [],
                "truncatedSteps": False,
                "totalSteps": 0,
            },
        }
    data = _decode_trace_line(raw.splitlines()[-1])
    _enrich_python_viz(data["visualization"])
    outputs = []
    if data.get("stdout"):
        outputs.append({"output_type": "stream", "name": "stdout", "text": data["stdout"]})
    if data.get("stderr"):
        outputs.append({"output_type": "stream", "name": "stderr", "text": data["stderr"]})
    return {
        "exitCode": data["exitCode"],
        "outputs": outputs,
        "visualization": data["visualization"],
    }


def jupyter_with_trace(vm_id, file_path, code):
    """Run a Python notebook cell once in the Jupyter kernel while capturing a trace."""
    import ast as _server_ast

    try:
        _server_ast.parse(code, "<cell>", "exec")
    except SyntaxError as err:
        result = runtime.jupyter(vm_id, "execute", file_path, code)
        result["visualization"] = {
            "kind": "python",
            "primaryFile": file_path,
            "ok": False,
            "steps": [{
                "index": 0,
                "event": "exception",
                "file": file_path,
                "func": "<module>",
                "line": err.lineno or 1,
                "code": (err.text or "").rstrip("\n"),
                "explain": f"구문 오류: {err.msg}",
                "stack": [],
                "heap": {},
                "stdout": "",
                "returnValue": None,
                "error": f"SyntaxError: {err.msg}",
            }],
            "callEdges": [],
            "truncatedSteps": False,
            "totalSteps": 1,
        }
        return result

    token = secrets.token_hex(8)
    trace_file = f"/tmp/.qnb_pytrace_{token}.json"
    wrapped = f"""{PYTHON_TRACER_CORE}
import ast as _qnb_ast

class _QnbCellStdout:
    def __init__(self, orig, mirror):
        self.orig = orig
        self.mirror = mirror
    def write(self, s):
        self.mirror.write(s)
        return self.orig.write(s)
    def flush(self):
        return self.orig.flush()
    def __getattr__(self, name):
        return getattr(self.orig, name)

_qnb_code = {code!r}
_qnb_trace_file = {trace_file!r}
_qnb_primary = {file_path!r}
_qnb_buf = _qnb_io.StringIO()
_qnb_src_map = {{_qnb_primary: _qnb_code.splitlines()}}
_qnb_tracer, _qnb_fin = _qnb_make_tracer(_qnb_primary, _qnb_buf, _qnb_src_map)
_qnb_tree = _qnb_ast.parse(_qnb_code, "<cell>", "exec")
_qnb_has_tail = bool(_qnb_tree.body and isinstance(_qnb_tree.body[-1], _qnb_ast.Expr))
if _qnb_has_tail:
    _qnb_tail_node = _qnb_tree.body.pop()
    _qnb_tree.body.append(_qnb_ast.Assign(
        targets=[_qnb_ast.Name(id="_qnb_cell_value", ctx=_qnb_ast.Store())],
        value=_qnb_tail_node.value,
    ))
    _qnb_ast.fix_missing_locations(_qnb_tree)
_qnb_compiled = compile(_qnb_tree, "<cell>", "exec")
_qnb_orig_stdout = _qnb_sys.stdout
_qnb_ns = globals()
_qnb_ns.pop("_qnb_cell_value", None)
_qnb_ok = True
try:
    _qnb_sys.stdout = _QnbCellStdout(_qnb_orig_stdout, _qnb_buf)
    _qnb_sys.settrace(_qnb_tracer)
    try:
        exec(_qnb_compiled, _qnb_ns, _qnb_ns)
    finally:
        _qnb_sys.settrace(None)
        _qnb_sys.stdout = _qnb_orig_stdout
except BaseException:
    _qnb_ok = False
    raise
finally:
    _qnb_viz = _qnb_fin()
    _qnb_viz["ok"] = _qnb_ok
    try:
        with open(_qnb_trace_file, "w", encoding="utf-8") as _fp:
            _fp.write(_qnb_json.dumps(_qnb_viz, ensure_ascii=True))
    except OSError:
        pass
if _qnb_has_tail and _qnb_ns.get("_qnb_cell_value") is not None:
    try:
        from IPython.display import display as _qnb_display
        _qnb_display(_qnb_ns.pop("_qnb_cell_value"))
    except Exception:
        _qnb_ns.pop("_qnb_cell_value", None)
"""
    if len(wrapped.encode("utf-8")) > 65536:
        return runtime.jupyter(vm_id, "execute", file_path, code)

    result = runtime.jupyter(vm_id, "execute", file_path, wrapped)
    reader = (
        f"import base64, pathlib, zlib; p=pathlib.Path({trace_file!r}); "
        "raw=p.read_bytes() if p.exists() else b''; p.unlink(missing_ok=True); "
        "print('QNBZ:' + base64.b64encode(zlib.compress(raw, 6)).decode('ascii') if raw else '')"
    )
    try:
        trace_res = runtime.vm(vm_id, {"language": "python", "code": reader, "stateless": True})
        raw_trace = (trace_res.get("output") or "").strip()
        if trace_res.get("exitCode") == 0 and raw_trace:
            result["visualization"] = _enrich_python_viz(_decode_trace_line(raw_trace.splitlines()[-1]))
    except (runtime.RequestError, ValueError, KeyError, zlib.error):
        pass
    return result
