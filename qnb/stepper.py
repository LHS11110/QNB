"""Line-by-line C++ / Java execution for learning, driven by real debuggers in the VM.

C++  : Multi-file g++ -g -O0 compile, then gdb (Python API) steps line by line,
       stepping out of library code, dereferencing pointers/structs, hiding
       uninitialized declaration slots, catching fatal signals, and expanding
       STL containers via libstdc++ pretty printers.
Java : Multi-file javac -g compile, then JDI debugger (QnbJdi) steps line by
       line (excluding JDK classes), captures method return values, collections,
       object graphs, and uncaught exception locations.

Both compress trace JSON via QNBZ: framing to stay well within VM output limits
and build_result() formats steps with variable diffs, explanations, and pipeline status.
"""

import base64
import hashlib
import json
import posixpath
import re
import zlib

from . import runtime
from .runtime import RequestError

MAX_STEPS = 300
RUN_TIMEOUT = 30

GDB_DRIVER = r'''
import json, os, re, itertools
import gdb

STAGE_ROOT = os.path.realpath(os.environ["QNB_STAGE_ROOT"])
ENTRY_REL = os.environ["QNB_ENTRY_REL"]
FILE_MAP = json.loads(os.environ.get("QNB_FILE_MAP", "{}"))
TRACE = open(os.environ["QNB_TRACE"], "w", encoding="utf-8")
OUT = os.environ["QNB_OUT"]
MAX_STEPS = int(os.environ["QNB_MAX_STEPS"])

state = {"exit": None, "signal": None, "seq": 0, "steps": 0, "done_signal": False}
seen_vars = set()
src_cache = {}

def on_exit(event):
    state["exit"] = getattr(event, "exit_code", None)
gdb.events.exited.connect(on_exit)

def on_stop(event):
    sig = getattr(event, "stop_signal", None)
    if sig and sig not in ("SIGTRAP", "SIGINT", "SIGSTOP"):
        state["signal"] = sig
gdb.events.stop.connect(on_stop)

def clip(text, n=120):
    return text if len(text) <= n else text[:n - 1] + "…"

def read_line_text(real_path, lineno):
    lines = src_cache.get(real_path)
    if lines is None:
        try:
            with open(real_path, encoding="utf-8", errors="replace") as fp:
                lines = fp.read().splitlines()
        except OSError:
            lines = []
        src_cache[real_path] = lines
    return lines[lineno - 1] if 1 <= lineno <= len(lines) else ""

def user_sal(frame):
    try:
        sal = frame.find_sal()
    except gdb.error:
        return None, None, None
    if sal.symtab is None:
        return None, None, None
    try:
        full = sal.symtab.fullname()
    except gdb.error:
        full = None
    candidate = full or sal.symtab.filename
    real = os.path.realpath(candidate)
    if not (real == STAGE_ROOT or real.startswith(STAGE_ROOT + os.sep)):
        return None, None, None
    rel = os.path.relpath(real, STAGE_ROOT).replace(os.sep, "/")
    ws_file = FILE_MAP.get(rel) or FILE_MAP.get(ENTRY_REL) or ("/" + rel)
    return sal, ws_file, real

def new_id():
    state["seq"] += 1
    return "obj_%d" % state["seq"]

def collect_addr_names(frames):
    names = {}
    for idx, (frame, sal, _, _) in enumerate(frames):
        fn = frame.function()
        fname = fn.name if fn is not None else (frame.name() or "?")
        fname = re.sub(r"\(.*\)$", "", fname)
        try:
            block = frame.block()
        except RuntimeError:
            continue
        while block is not None:
            for sym in block:
                if not (sym.is_variable or sym.is_argument) or sym.name.startswith("__"):
                    continue
                if sym.is_variable and sym.line and sal.line <= sym.line and (idx, fname, sym.name, sym.line) not in seen_vars:
                    continue
                try:
                    addr = sym.value(frame).address
                    if addr is not None and int(addr):
                        names.setdefault(int(addr), sym.name)
                except (gdb.error, RuntimeError):
                    pass
            if block.function is not None:
                break
            block = block.superblock
    return names

def fmt(val, heap, depth=0, ptr_seen=None, addr_names=None):
    if ptr_seen is None:
        ptr_seen = {}
    if addr_names is None:
        addr_names = {}
    try:
        t = val.type.strip_typedefs()
        if t.code in (gdb.TYPE_CODE_REF, getattr(gdb, "TYPE_CODE_RVALUE_REF", -1)):
            val = val.referenced_value()
            t = val.type.strip_typedefs()
        name = str(t)
        viz = gdb.default_visualizer(val)
        if viz is not None:
            hint = viz.display_hint() if hasattr(viz, "display_hint") else None
            if hint == "string" or not hasattr(viz, "children"):
                text = str(val)
                if hint == "string" and len(text) >= 2 and text[0] == text[-1] == '"':
                    return {"kind": "prim", "type": "str", "value": clip(text[1:-1])}
                return {"kind": "repr", "type": name, "text": clip(text)}
            if depth >= 6 or len(heap) >= 90:
                return {"kind": "repr", "type": name, "text": "…"}
            header = str(viz.to_string() or "")
            length = re.search(r"(?:length|with) (\d+)", header)
            children = list(itertools.islice(viz.children(), 26 if hint == "map" else 13))
            oid = new_id()
            entry = {"id": oid, "type": name, "truncated": False}
            if hint == "map":
                pairs = [(children[i][1], children[i + 1][1]) for i in range(0, len(children) - 1, 2)][:12]
                entry["fields"] = [[clip(str(k).strip('"'), 40), fmt(v, heap, depth + 1, ptr_seen, addr_names)] for k, v in pairs]
                count = int(length.group(1)) if length else len(pairs)
            else:
                entry["items"] = [fmt(v if isinstance(v, gdb.Value) else gdb.Value(v), heap, depth + 1, ptr_seen, addr_names) for _, v in children[:12]]
                count = int(length.group(1)) if length else len(children)
            entry["length"] = count
            entry["truncated"] = count > 12
            heap[oid] = entry
            return {"kind": "ref", "id": oid}
        code = t.code
        if code == gdb.TYPE_CODE_BOOL:
            return {"kind": "prim", "type": "bool", "value": bool(val)}
        if code == gdb.TYPE_CODE_INT and name in ("char", "signed char", "unsigned char") and t.sizeof == 1:
            n = int(val)
            return {"kind": "prim", "type": "char", "value": chr(n) if 32 <= n < 127 else "\\x%02x" % (n & 255)}
        if code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR):
            return {"kind": "prim", "type": "int", "value": int(val)}
        if code == gdb.TYPE_CODE_FLT:
            f = float(val)
            if f != f or f in (float("inf"), float("-inf")):
                return {"kind": "repr", "type": "float", "text": str(f)}
            return {"kind": "prim", "type": "float", "value": f}
        if code == gdb.TYPE_CODE_ENUM:
            return {"kind": "repr", "type": name, "text": str(val)}
        if code == gdb.TYPE_CODE_PTR:
            target = t.target().strip_typedefs()
            addr = int(val)
            if addr == 0:
                return {"kind": "repr", "type": "pointer", "text": "nullptr"}
            if target.code == gdb.TYPE_CODE_INT and target.sizeof == 1:
                try:
                    return {"kind": "prim", "type": "str", "value": clip(val.string(length=200))}
                except (gdb.error, gdb.MemoryError):
                    pass
            if depth >= 8 or len(heap) >= 90:  # linked lists / trees follow pointers deeper
                return {"kind": "repr", "type": "pointer", "text": hex(addr)}
            if target.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                if addr in ptr_seen:
                    return {"kind": "ref", "id": ptr_seen[addr], "ptr": True}
                if (addr, str(target)) in ptr_seen:  # a local struct this pointer points at (&n1)
                    return {"kind": "ref", "id": ptr_seen[(addr, str(target))], "ptr": True}
                try:
                    target_val = val.dereference()
                    # Probe memory readability before allocating heap entry
                    target_val.fetch_lazy()
                except (gdb.error, gdb.MemoryError, RuntimeError):
                    return {"kind": "repr", "type": "pointer", "text": "%s (접근 불가)" % hex(addr)}
                oid = new_id()
                ptr_seen[addr] = oid
                ptr_seen[(addr, str(target))] = oid
                fields = []
                readable = True
                for field in target.fields():
                    if getattr(field, "is_base_class", False) or not field.name or not hasattr(field, "bitpos"):
                        continue
                    if len(fields) >= 12:
                        break
                    try:
                        fields.append([field.name, fmt(target_val[field.name], heap, depth + 1, ptr_seen, addr_names)])
                    except (gdb.error, gdb.MemoryError):
                        readable = False
                        break
                if not readable and not fields:
                    ptr_seen.pop(addr, None)
                    ptr_seen.pop((addr, str(target)), None)
                    return {"kind": "repr", "type": "pointer", "text": "%s (접근 불가)" % hex(addr)}
                heap[oid] = {"id": oid, "type": str(target), "length": len(fields), "fields": fields, "truncated": False, "addr": hex(addr)}
                return {"kind": "ref", "id": oid, "ptr": True}
            if target.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_FLT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_ENUM):
                try:
                    dval = fmt(val.dereference(), heap, depth + 1, ptr_seen, addr_names)
                    dtxt = dval.get("text") if dval.get("kind") == "repr" else str(dval.get("value"))
                    prefix = ("&" + addr_names[addr]) if addr in addr_names else hex(addr)
                    return {"kind": "repr", "type": "%s*" % target, "text": clip("%s → %s" % (prefix, dtxt))}
                except (gdb.error, gdb.MemoryError):
                    return {"kind": "repr", "type": "pointer", "text": "%s (접근 불가)" % hex(addr)}
            if addr in addr_names:
                return {"kind": "repr", "type": "pointer", "text": "&" + addr_names[addr]}
            return {"kind": "repr", "type": "pointer", "text": hex(addr)}
        if depth >= 6 or len(heap) >= 90:
            return {"kind": "repr", "type": name, "text": "…"}
        if code == gdb.TYPE_CODE_ARRAY:
            low, high = t.range()
            count = high - low + 1
            target = t.target().strip_typedefs()
            if target.code == gdb.TYPE_CODE_INT and target.sizeof == 1:
                try:
                    return {"kind": "prim", "type": "str", "value": clip(val.string())}
                except (gdb.error, gdb.MemoryError):
                    pass
            oid = new_id()
            heap[oid] = {"id": oid, "type": name, "length": count,
                         "items": [fmt(val[low + i], heap, depth + 1, ptr_seen, addr_names) for i in range(min(count, 12))], "truncated": count > 12}
            return {"kind": "ref", "id": oid}
        if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            # A struct and a pointer to it (Node n1; … &n1) must be one object, so graphs built from
            # local nodes connect. Keyed by (address, type): a first member shares its parent's address.
            try:
                saddr = int(val.address) if val.address is not None else None
            except (gdb.error, RuntimeError, ValueError):
                saddr = None
            if saddr is not None and (saddr, name) in ptr_seen:
                return {"kind": "ref", "id": ptr_seen[(saddr, name)]}
            oid = new_id()
            if saddr is not None:
                ptr_seen[(saddr, name)] = oid
            fields = []
            for field in t.fields():
                if getattr(field, "is_base_class", False) or not field.name or not hasattr(field, "bitpos"):
                    continue
                if len(fields) >= 12:
                    break
                try:
                    fields.append([field.name, fmt(val[field.name], heap, depth + 1, ptr_seen, addr_names)])
                except (gdb.error, gdb.MemoryError):
                    continue
            heap[oid] = {"id": oid, "type": name, "length": len(fields), "fields": fields, "truncated": False}
            return {"kind": "ref", "id": oid}
        return {"kind": "repr", "type": name, "text": clip(str(val))}
    except (gdb.error, gdb.MemoryError, RuntimeError, ValueError, OverflowError) as error:
        return {"kind": "repr", "type": "?", "text": clip("<%s>" % error, 60)}

def frame_locals(frame, depth_idx, fname, line, heap, ptr_seen, addr_names):
    out = {}
    try:
        block = frame.block()
    except RuntimeError:
        return out
    scopes = []
    while block is not None:
        scopes.append(block)
        if block.function is not None:
            break
        block = block.superblock
    for scope in reversed(scopes):  # outer first; inner declarations shadow
        for sym in scope:
            if not (sym.is_variable or sym.is_argument) or sym.name.startswith("__"):
                continue
            if sym.is_variable and sym.line:
                vkey = (depth_idx, fname, sym.name, sym.line)
                if line < sym.line:
                    continue
                if line == sym.line and vkey not in seen_vars:
                    # Declaration line stops before initialization completes; mark for next revisit.
                    seen_vars.add(vkey)
                    continue
                seen_vars.add(vkey)
            try:
                out[sym.name] = fmt(sym.value(frame), heap, 0, ptr_seen, addr_names)
            except (gdb.error, RuntimeError):
                continue
            if len(out) >= 32:
                return out
    return out

def snapshot():
    frames = []
    frame = gdb.newest_frame()
    while frame is not None:
        sal, ws_file, real = user_sal(frame)
        if sal is not None:
            frames.append((frame, sal, ws_file, real))
        frame = frame.older()
    frames.reverse()
    heap = {}
    stack = []
    ptr_seen = {}
    addr_names = collect_addr_names(frames)
    for idx, (frame, sal, ws_file, _) in enumerate(frames):
        fn = frame.function()
        name = fn.name if fn is not None else (frame.name() or "?")
        name = re.sub(r"\(.*\)$", "", name)
        stack.append({"file": ws_file, "func": name, "line": sal.line,
                      "locals": frame_locals(frame, idx, name, sal.line, heap, ptr_seen, addr_names)})
    return stack, heap, frames

RETURN_EXPR = re.compile(r"^\s*return\s+([^;]+?)\s*;")

def eval_return_hint(frame, real_path, line):
    text = read_line_text(real_path, line)
    m = RETURN_EXPR.match(text)
    if not m:
        return None
    expr = m.group(1).strip()
    if any(tok in expr for tok in ("(", "++", "--", "=")):
        return None
    try:
        frame.select()
        val = gdb.parse_and_eval(expr)
        info = fmt(val, {})
        if info.get("kind") == "prim":
            return clip(json.dumps(info["value"], ensure_ascii=False) if info.get("type") == "str" else str(info["value"]), 60)
        if info.get("kind") == "repr":
            return clip(info.get("text", ""), 60)
    except (gdb.error, RuntimeError):
        return None
    return None

def out_bytes():
    try:
        return os.path.getsize(OUT)
    except OSError:
        return 0

def emit(event, stack, heap, ret=None, sig=None):
    top = stack[-1]
    row = {"event": event, "file": top["file"], "line": top["line"], "func": top["func"],
           "stack": stack, "heap": heap, "out": out_bytes()}
    if ret is not None:
        row["ret"] = ret
    if sig is not None:
        row["signal"] = sig
    TRACE.write(json.dumps(row, ensure_ascii=False) + "\n")
    state["steps"] += 1

def alive():
    try:
        return gdb.selected_inferior().pid != 0 and gdb.selected_thread() is not None
    except gdb.error:
        return False

for command in ("set pagination off", "set confirm off", "set disable-randomization off",
                "set print thread-events off", "set startup-with-shell on",
                "skip -rfu ^std::", "skip -rfu ^__gnu_cxx::", "skip -gfi /usr/include/*"):
    try:
        gdb.execute(command, to_string=True)
    except gdb.error:
        pass
if os.path.exists("/usr/libexec/coreutils/libstdbuf.so"):
    # Unbuffered stdio so output written by a line shows up at that step, not at exit.
    gdb.execute("set environment LD_PRELOAD /usr/libexec/coreutils/libstdbuf.so", to_string=True)
    gdb.execute("set environment _STDBUF_O 0", to_string=True)
gdb.execute("break main", to_string=True)
gdb.execute("run < /dev/null > %s 2> %s" % (OUT, os.environ["QNB_ERR"]), to_string=True)

previous = last_stack = last_heap = pending_ret = None
while alive() and state["steps"] < MAX_STEPS:
    if state["signal"]:
        stack, heap, _ = snapshot()
        if stack:
            emit("exception", stack, heap, sig=state["signal"])
        state["done_signal"] = True
        break
    frame = gdb.selected_frame()
    sal, _, real = user_sal(frame)
    if sal is None:
        try:
            if frame.older() is None:
                break
            gdb.execute("finish", to_string=True)
        except gdb.error:
            break
        continue
    stack, heap, user_frames = snapshot()
    if state["signal"]:
        emit("exception", stack, heap, sig=state["signal"])
        state["done_signal"] = True
        break
    key = [(f["file"], f["func"], f["line"]) for f in stack]
    if key != previous:
        depth, prev_depth = len(stack), len(previous or [])
        if previous is not None and depth < prev_depth and last_stack is not None:
            emit("return", last_stack[:prev_depth], last_heap, ret=pending_ret)
            pending_ret = None
        emit("call" if depth > prev_depth else "line", stack, heap)
        previous, last_stack, last_heap = key, stack, heap
    hint_ret = eval_return_hint(user_frames[-1][0], real, sal.line) if user_frames else None
    if hint_ret is not None:
        pending_ret = hint_ret
    try:
        gdb.execute("step", to_string=True)
    except gdb.error:
        break

if not state["done_signal"] and last_stack is not None and state["steps"] < MAX_STEPS:
    if state["signal"]:
        stack, heap, _ = snapshot()
        if stack:
            emit("exception", stack, heap, sig=state["signal"])
    elif last_stack:
        emit("return", last_stack, last_heap, ret=pending_ret)

if alive() and not state["signal"]:
    try:
        gdb.execute("delete", to_string=True)
        gdb.execute("continue", to_string=True)
    except gdb.error:
        pass
meta = {"exit": state["exit"]}
if state["signal"]:
    meta["signal"] = state["signal"]
TRACE.write(json.dumps(meta) + "\n")
TRACE.close()
'''

JDI_DEBUGGER = r'''
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class QnbJdi {
  static PrintWriter trace; static int seq = 0; static long outBytes = 0; static int steps = 0;
  static String sourceName; static int maxSteps;
  static Map<String, String> fileMap = new HashMap<>();
  static String pendingRet = null;
  static final String[] EXCLUDES = {"java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "kotlin.*"};

  public static void main(String[] a) throws Exception {
    String mainClass = a[0], classPath = a[1]; sourceName = a[2];
    trace = new PrintWriter(new OutputStreamWriter(new FileOutputStream(a[3]), StandardCharsets.UTF_8));
    FileOutputStream out = new FileOutputStream(a[4]); FileOutputStream err = new FileOutputStream(a[5]);
    maxSteps = Integer.parseInt(a[6]);
    if (a.length > 7) parseMap(a[7]);
    LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
    Map<String, Connector.Argument> args = connector.defaultArguments();
    args.get("main").setValue(mainClass);
    args.get("options").setValue("-cp " + classPath + " -Xmx192m -Xss2m -XX:+UseSerialGC -Dfile.encoding=UTF-8");
    VirtualMachine vm = connector.launch(args);
    Process process = vm.process();
    process.getOutputStream().close();
    Thread outPump = pump(process.getInputStream(), out, true), errPump = pump(process.getErrorStream(), err, false);
    EventRequestManager erm = vm.eventRequestManager();
    ClassPrepareRequest prepare = erm.createClassPrepareRequest();
    for (String ex : EXCLUDES) prepare.addClassExclusionFilter(ex);
    prepare.enable();
    ExceptionRequest uncaught = erm.createExceptionRequest(null, false, true);
    for (String ex : EXCLUDES) uncaught.addClassExclusionFilter(ex);
    uncaught.enable();
    boolean stepping = false; List<String> previous = null; String lastStack = null, lastHeap = null; int lastDepth = 0;
    EventQueue queue = vm.eventQueue();
    outer:
    while (true) {
      EventSet set = queue.remove();
      for (Event event : set) {
        if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) break outer;
        if (event instanceof ClassPrepareEvent) {
          ReferenceType type = ((ClassPrepareEvent) event).referenceType();
          if (type.name().equals(mainClass)) {
            for (Method m : type.methodsByName("main")) {
              if (m.isStatic() && m.location() != null) erm.createBreakpointRequest(m.location()).enable();
            }
          }
        } else if (event instanceof BreakpointEvent && !stepping) {
          stepping = true;
          ThreadReference thread = ((BreakpointEvent) event).thread();
          StepRequest step = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
          for (String ex : EXCLUDES) step.addClassExclusionFilter(ex);
          step.enable();
          if (vm.canGetMethodReturnValues()) {
            MethodExitRequest mex = erm.createMethodExitRequest();
            for (String ex : EXCLUDES) mex.addClassExclusionFilter(ex);
            mex.addThreadFilter(thread);
            mex.enable();
          }
          Object[] r = record(thread, previous, lastStack, lastHeap, lastDepth);
          if (r != null) { previous = (List<String>) r[0]; lastStack = (String) r[1]; lastHeap = (String) r[2]; lastDepth = (Integer) r[3]; }
        } else if (event instanceof MethodExitEvent) {
          MethodExitEvent me = (MethodExitEvent) event;
          if (!"void".equals(me.method().returnTypeName()) && resolveLocationFile(me.location()) != null) {
            pendingRet = summarizeReturn(me.returnValue(), me.thread());
          }
        } else if (event instanceof StepEvent) {
          ThreadReference thread = ((StepEvent) event).thread();
          if (steps >= maxSteps) { event.request().disable(); continue; }
          Object[] r = record(thread, previous, lastStack, lastHeap, lastDepth);
          if (r != null) { previous = (List<String>) r[0]; lastStack = (String) r[1]; lastHeap = (String) r[2]; lastDepth = (Integer) r[3]; }
        } else if (event instanceof ExceptionEvent) {
          ExceptionEvent ex = (ExceptionEvent) event;
          ObjectReference exObj = ex.exception();
          String detail = exObj.referenceType().name();
          Field msgField = exObj.referenceType().fieldByName("detailMessage");
          if (msgField != null) {
            Value mv = exObj.getValue(msgField);
            if (mv instanceof StringReference) detail += ": " + ((StringReference) mv).value();
          }
          recordException(ex.thread(), detail);
          trace.println("{\"exception\":" + esc(detail, 200) + "}");
        }
      }
      set.resume();
    }
    if (lastStack != null && steps < maxSteps) {
      emitLine("return", lastLine(lastStack), lastFunc(lastStack), lastFile(lastStack), lastStack, lastHeap, pendingRet);
      pendingRet = null;
    }
    outPump.join(2000); errPump.join(2000);
    int code = process.waitFor();
    trace.println("{\"exit\":" + code + "}");
    trace.close();
  }

  static void parseMap(String jsonText) {
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"([^\"]+)\"\\s*:\\s*\"([^\"]+)\"").matcher(jsonText);
    while (m.find()) fileMap.put(m.group(1), m.group(2));
  }

  static String resolveLocationFile(Location l) {
    try {
      String sp = l.sourcePath().replace('\\', '/');
      if (fileMap.containsKey(sp)) return fileMap.get(sp);
    } catch (AbsentInformationException ignored) { }
    try {
      String sn = l.sourceName();
      if (fileMap.containsKey(sn)) return fileMap.get(sn);
      if (sourceName.equals(sn)) return fileMap.getOrDefault(sn, "/" + sn);
    } catch (AbsentInformationException ignored) { }
    return null;
  }

  static String summarizeReturn(Value v, ThreadReference thread) {
    if (v == null) return "null";
    if (v instanceof BooleanValue || v instanceof PrimitiveValue) return v.toString();
    if (v instanceof StringReference) return esc(((StringReference) v).value(), 60);
    if (v instanceof ObjectReference) return keyText(v, thread);
    return String.valueOf(v);
  }

  static volatile long lastOutputAt = 0;

  /* The target is suspended at a step: give the pump thread a moment to copy what was already
   * printed. (available() cannot be used: it blocks on the stream lock held by the pump's read.) */
  static void settleOutput() {
    try {
      Thread.sleep(2);
      long deadline = System.nanoTime() + 30_000_000L;
      while (System.nanoTime() < deadline && System.nanoTime() - lastOutputAt < 5_000_000L) Thread.sleep(1);
    } catch (InterruptedException ignored) { }
  }

  static String keyText(Value k, ThreadReference thread) {
    if (k == null) return "null";
    if (k instanceof StringReference) return ((StringReference) k).value();
    if (k instanceof PrimitiveValue) return k.toString();
    ObjectReference o = (ObjectReference) k;
    Field value = o.referenceType().fieldByName("value");
    if (o.referenceType().name().startsWith("java.lang.") && value != null) return String.valueOf(o.getValue(value));
    Value text = invoke(o, thread, "toString", "()Ljava/lang/String;");
    return text instanceof StringReference ? ((StringReference) text).value() : o.referenceType().name().replaceAll(".*[.$]", "");
  }

  static Thread pump(InputStream in, OutputStream sink, boolean count) {
    Thread t = new Thread(() -> {
      byte[] buf = new byte[8192]; int n;
      try { while ((n = in.read(buf)) > 0) { sink.write(buf, 0, n); sink.flush(); if (count) { synchronized (QnbJdi.class) { outBytes += n; } lastOutputAt = System.nanoTime(); } } }
      catch (IOException ignored) { }
    });
    t.setDaemon(true); t.start(); return t;
  }

  static void recordException(ThreadReference thread, String detail) {
    Object[] res = capture(thread);
    if (res == null) return;
    String stack = (String) res[1], heap = (String) res[2];
    List<Object[]> snap = (List<Object[]>) res[3];
    Object[] top = snap.get(snap.size() - 1);
    emitLine("exception", (Integer) top[1], (String) top[0], (String) top[5], stack, heap, null);
  }

  static Object[] capture(ThreadReference thread) {
    List<Object[]> snap = new ArrayList<>();  // {func, line, this, names, values, file}
    try {
      List<StackFrame> frames = thread.frames();
      for (int i = frames.size() - 1; i >= 0; i--) {
        StackFrame f = frames.get(i);
        Location l = f.location();
        String wsFile = resolveLocationFile(l);
        if (wsFile == null) continue;
        List<String> names = new ArrayList<>(); List<Value> values = new ArrayList<>();
        try {
          List<LocalVariable> vars = f.visibleVariables();
          if (vars.size() > 24) vars = vars.subList(0, 24);
          Map<LocalVariable, Value> got = f.getValues(vars);
          for (LocalVariable v : vars) { names.add(v.name()); values.add(got.get(v)); }
        } catch (AbsentInformationException ignored) { }
        String func = l.declaringType().name().replaceAll(".*[.$]", "") + "." + l.method().name();
        snap.add(new Object[]{func, l.lineNumber(), f.thisObject(), names, values, wsFile});
      }
    } catch (IncompatibleThreadStateException | InvalidStackFrameException e) {
      return null;
    }
    if (snap.isEmpty()) return null;
    List<String> key = new ArrayList<>();
    for (Object[] f : snap) key.add(f[5] + ":" + f[0] + ":" + f[1]);
    Map<ObjectReference, String> seen = new HashMap<>();
    StringBuilder heap = new StringBuilder(), stack = new StringBuilder();
    for (Object[] f : snap) {
      StringBuilder locals = new StringBuilder("{");
      int n = 0;
      if (f[2] != null) { locals.append("\"this\":").append(show((Value) f[2], heap, seen, 0, thread)); n++; }
      List<String> names = (List<String>) f[3]; List<Value> values = (List<Value>) f[4];
      for (int i = 0; i < names.size(); i++) {
        locals.append(n++ > 0 ? "," : "").append(esc(names.get(i), 60)).append(":").append(show(values.get(i), heap, seen, 0, thread));
      }
      stack.append(stack.length() > 0 ? "," : "").append("{\"file\":").append(esc((String) f[5], 240))
          .append(",\"func\":").append(esc((String) f[0], 120)).append(",\"line\":").append(f[1]).append(",\"locals\":").append(locals).append("}}");
    }
    return new Object[]{key, stack.toString(), heap.toString(), snap};
  }

  static Object[] record(ThreadReference thread, List<String> previous, String lastStack, String lastHeap, int lastDepth) {
    Object[] cap = capture(thread);
    if (cap == null) return null;
    List<String> key = (List<String>) cap[0];
    if (key.equals(previous)) return null;
    String stack = (String) cap[1], heap = (String) cap[2];
    List<Object[]> snap = (List<Object[]>) cap[3];
    Object[] top = snap.get(snap.size() - 1);
    int depth = snap.size();
    if (previous != null && depth < lastDepth && lastStack != null) {
      emitLine("return", lastLine(lastStack), lastFunc(lastStack), lastFile(lastStack), lastStack, lastHeap, pendingRet);
      pendingRet = null;
    }
    emitLine(depth > lastDepth ? "call" : "line", (Integer) top[1], (String) top[0], (String) top[5], stack, heap, null);
    return new Object[]{key, stack, heap, depth};
  }

  static int lastLine(String stack) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"line\":(\\d+)").matcher(stack); int v = 0; while (m.find()) v = Integer.parseInt(m.group(1)); return v; }
  static String lastFunc(String stack) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"func\":\"([^\"]*)\"").matcher(stack); String v = "?"; while (m.find()) v = m.group(1); return v; }
  static String lastFile(String stack) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"file\":\"([^\"]*)\"").matcher(stack); String v = "/" + sourceName; while (m.find()) v = m.group(1); return v; }

  static void emitLine(String event, int line, String func, String file, String stack, String heap, String ret) {
    settleOutput();
    long out; synchronized (QnbJdi.class) { out = outBytes; }
    String retPart = ret != null ? ",\"ret\":" + esc(ret, 80) : "";
    trace.println("{\"event\":\"" + event + "\",\"file\":" + esc(file, 240) + ",\"line\":" + line + ",\"func\":" + esc(func, 120)
        + ",\"stack\":[" + stack + "],\"heap\":{" + heap + "},\"out\":" + out + retPart + "}");
    trace.flush();
    steps++;
  }

  static String esc(String s, int limit) {
    StringBuilder b = new StringBuilder("\""); int n = 0;
    for (int i = 0; i < s.length(); i++) { char c = s.charAt(i);
      if (++n > limit) { b.append('…'); break; }
      switch (c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break;
        default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); } }
    return b.append('"').toString();
  }

  static String prim(String type, String value) { return "{\"kind\":\"prim\",\"type\":\"" + type + "\",\"value\":" + value + "}"; }
  static String repr(String type, String text) { return "{\"kind\":\"repr\",\"type\":" + esc(type, 80) + ",\"text\":" + esc(text, 120) + "}"; }

  static Value invoke(ObjectReference obj, ThreadReference thread, String name, String signature) {
    try {
      Method m = obj.referenceType().methodsByName(name, signature).stream().findFirst().orElse(null);
      if (m == null) { for (Method c : ((ClassType) obj.referenceType()).allMethods()) if (c.name().equals(name) && c.signature().equals(signature)) { m = c; break; } }
      return m == null ? null : obj.invokeMethod(thread, m, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
    } catch (Exception e) { return null; }
  }

  static boolean isA(ReferenceType type, String iface) {
    if (!(type instanceof ClassType)) return false;
    for (InterfaceType i : ((ClassType) type).allInterfaces()) if (i.name().equals(iface)) return true;
    return false;
  }

  static String show(Value v, StringBuilder heap, Map<ObjectReference, String> seen, int depth, ThreadReference thread) {
    if (v == null) return repr("null", "null");
    if (v instanceof BooleanValue) return prim("bool", String.valueOf(((BooleanValue) v).value()));
    if (v instanceof CharValue) return prim("char", esc(String.valueOf(((CharValue) v).value()), 4));
    if (v instanceof IntegerValue || v instanceof LongValue || v instanceof ShortValue || v instanceof ByteValue) return prim("int", v.toString());
    if (v instanceof DoubleValue || v instanceof FloatValue) { double d = ((PrimitiveValue) v).doubleValue(); return Double.isNaN(d) || Double.isInfinite(d) ? repr("float", String.valueOf(d)) : prim("float", String.valueOf(d)); }
    if (v instanceof StringReference) return prim("str", esc(((StringReference) v).value(), 120));
    ObjectReference obj = (ObjectReference) v;
    String type = obj.referenceType().name().replaceAll(".*[.$]", "");
    if (obj.referenceType().name().startsWith("java.lang.") && obj.referenceType() instanceof ClassType) {
      Field value = obj.referenceType().fieldByName("value");
      if (value != null && obj.getValue(value) instanceof PrimitiveValue) return show(obj.getValue(value), heap, seen, depth, thread);
    }
    String known = seen.get(obj);
    if (known != null) return "{\"kind\":\"ref\",\"id\":\"" + known + "\"}";
    if (depth >= 7 || seen.size() >= 90) return repr(type, "…");
    String id = "obj_" + (++seq); seen.put(obj, id);
    StringBuilder items = new StringBuilder(); int n = 0, len; boolean fields = false;
    if (obj instanceof ArrayReference) {
      ArrayReference arr = (ArrayReference) obj; len = arr.length();
      type = arr.referenceType().name().replaceAll(".*[.$]", "");
      for (Value item : arr.getValues(0, Math.min(len, 12))) items.append(n++ > 0 ? "," : "").append(show(item, heap, seen, depth + 1, thread));
    } else if (isA(obj.referenceType(), "java.util.Map")) {
      fields = true;
      Value entries = invoke(obj, thread, "entrySet", "()Ljava/util/Set;");
      Value array = entries instanceof ObjectReference ? invoke((ObjectReference) entries, thread, "toArray", "()[Ljava/lang/Object;") : null;
      len = array instanceof ArrayReference ? ((ArrayReference) array).length() : 0;
      if (array instanceof ArrayReference) for (Value e : ((ArrayReference) array).getValues(0, Math.min(len, 12))) {
        ObjectReference entry = (ObjectReference) e;
        Value k = invoke(entry, thread, "getKey", "()Ljava/lang/Object;"), val = invoke(entry, thread, "getValue", "()Ljava/lang/Object;");
        items.append(n++ > 0 ? "," : "").append("[").append(esc(keyText(k, thread), 40)).append(",").append(show(val, heap, seen, depth + 1, thread)).append("]");
      }
    } else if (isA(obj.referenceType(), "java.util.Collection")) {
      Value array = invoke(obj, thread, "toArray", "()[Ljava/lang/Object;");
      len = array instanceof ArrayReference ? ((ArrayReference) array).length() : 0;
      if (array instanceof ArrayReference) for (Value item : ((ArrayReference) array).getValues(0, Math.min(len, 12))) items.append(n++ > 0 ? "," : "").append(show(item, heap, seen, depth + 1, thread));
    } else {
      fields = true; len = 0;
      for (Field f : obj.referenceType().allFields()) {
        if (f.isStatic() || f.isSynthetic()) continue;
        if (len++ >= 12) continue;
        items.append(n++ > 0 ? "," : "").append("[").append(esc(f.name(), 40)).append(",").append(show(obj.getValue(f), heap, seen, depth + 1, thread)).append("]");
      }
    }
    heap.append(heap.length() > 0 ? "," : "").append("\"").append(id).append("\":{\"id\":\"").append(id).append("\",\"type\":").append(esc(type, 80))
        .append(",\"length\":").append(len).append(fields ? ",\"fields\":[" : ",\"items\":[").append(items).append("],\"truncated\":").append(len > 12).append("}");
    return "{\"kind\":\"ref\",\"id\":\"" + id + "\"}";
  }
}
'''

RUNNER = r'''
import base64, hashlib, json, os, re, shutil, subprocess, tempfile, zlib
cfg = json.loads(base64.b64decode(%(cfg)r).decode())
lang = cfg["language"]
temp_base = "/tmp" if os.path.isdir("/tmp") and os.access("/tmp", os.W_OK) else tempfile.gettempdir()
work = tempfile.mkdtemp(prefix="qnb-step-", dir=temp_base)
stage = os.path.join(work, "src")
os.makedirs(stage, exist_ok=True)
result = {"exitCode": 1, "stdout": "", "stderr": "", "trace": [], "note": "", "sources": {}}
paths = {k: os.path.join(work, k) for k in ("trace.jsonl", "stdout.txt", "stderr.txt")}

CPP_EXTS = {".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".tpp"}
CPP_SRCS = {".cc", ".cpp", ".cxx", ".c++"}
SKIP_DIRS = {"build", "target", "out", "node_modules", "__pycache__", "dist"}
MAIN_SIG = re.compile(r"(?:^|\s)(?:int|void|auto)\s+main\s*\(")
STRIP_COMMENTS = re.compile(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"', re.S)

def clip(text, n=20000):
    return text if len(text) <= n else text[:n] + "\n…(생략)"

def need(tool, message):
    if not shutil.which(tool):
        result["stderr"] = message; result["note"] = "nodebugger"; raise SystemExit

def stage_project():
    file_map = {}
    project_dir = cfg.get("projectDir") or ""
    ws_base = cfg.get("projectWs") or "/"
    if not ws_base.endswith("/"):
        ws_base += "/"
    allowed = CPP_EXTS if lang == "cpp" else {".java"}
    total_bytes, count = 0, 0
    if os.path.isdir(project_dir):
        for root, dirs, files in os.walk(project_dir):
            rel_dir = os.path.relpath(root, project_dir)
            depth = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
            dirs[:] = [d for d in sorted(dirs) if not d.startswith(".") and d not in SKIP_DIRS] if depth < 1 else []
            for fname in sorted(files):
                if fname.startswith(".") or os.path.splitext(fname)[1].lower() not in allowed:
                    continue
                if count >= 32:
                    break
                full = os.path.join(root, fname)
                try:
                    sz = os.path.getsize(full)
                    if sz > 131072 or total_bytes + sz > 524288:
                        continue
                    data = open(full, "r", encoding="utf-8", errors="replace").read()
                except OSError:
                    continue
                rel = fname if rel_dir == "." else (rel_dir.replace(os.sep, "/") + "/" + fname)
                dst = os.path.join(stage, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                open(dst, "w", encoding="utf-8").write(data)
                ws_path = ws_base + rel
                file_map[rel] = ws_path
                result["sources"][ws_path] = data
                total_bytes += sz; count += 1
    entry_rel = cfg["fileName"] if lang == "cpp" else (cfg["className"] + ".java")
    entry_ws = cfg.get("filePath") or (ws_base + entry_rel)
    entry_dst = os.path.join(stage, entry_rel)
    os.makedirs(os.path.dirname(entry_dst), exist_ok=True)
    open(entry_dst, "w", encoding="utf-8").write(cfg["source"])
    file_map[entry_rel] = entry_ws
    result["sources"][entry_ws] = cfg["source"]
    return file_map, entry_rel, entry_dst

def has_main_fn(src_text):
    cleaned = STRIP_COMMENTS.sub(" ", src_text)
    return bool(MAIN_SIG.search(cleaned))

UPGRADE = "VM 이미지에 디버거가 없습니다. 관리자가 deploy/guest/Dockerfile로 VM 이미지를 갱신해야 합니다."
try:
    file_map, entry_rel, src = stage_project()
    if lang == "cpp":
        need("g++", "VM에 g++ 컴파일러가 없습니다.")
        need("gdb", UPGRADE + " (gdb)")
        compile_inputs = [src]
        for rel in sorted(file_map):
            if rel == entry_rel or "/" in rel:
                continue
            if os.path.splitext(rel)[1].lower() in CPP_SRCS:
                cand = os.path.join(stage, rel)
                try:
                    txt = open(cand, encoding="utf-8", errors="replace").read()
                except OSError:
                    continue
                if not has_main_fn(txt):
                    compile_inputs.append(cand)
                    if len(compile_inputs) >= 12:
                        break
        exe = os.path.join(work, "program")
        p = subprocess.run(["g++", "-std=c++17", "-g", "-O0", "-fno-omit-frame-pointer", "-I", stage, "-o", exe, *compile_inputs],
                           capture_output=True, text=True, timeout=90)
        if p.returncode:
            err_msg = p.stderr.replace(stage + "/", cfg.get("projectWs", "/") + ("" if cfg.get("projectWs", "/").endswith("/") else "/"))
            err_msg = err_msg.replace(work + "/", "")
            result["stderr"] = clip(err_msg); result["note"] = "compile"; raise SystemExit
        driver = os.path.join(work, "driver.py")
        open(driver, "w").write(cfg["driver"])
        env = dict(os.environ, QNB_STAGE_ROOT=stage, QNB_ENTRY_REL=entry_rel, QNB_FILE_MAP=json.dumps(file_map),
                   QNB_TRACE=paths["trace.jsonl"], QNB_OUT=paths["stdout.txt"], QNB_ERR=paths["stderr.txt"],
                   QNB_MAX_STEPS=str(cfg["maxSteps"]))
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        cmd = ["timeout", str(cfg["timeout"]), "gdb", "-q", "-batch", "-nx", "-x", driver, exe]
    else:
        need("javac", UPGRADE + " (JDK)")
        classes = os.path.join(work, "classes"); os.makedirs(classes)
        p = subprocess.run(["javac", "-g", "-encoding", "UTF-8", "-nowarn", "-sourcepath", stage, "-d", classes, src],
                           capture_output=True, text=True, timeout=120)
        if p.returncode:
            err_msg = p.stderr.replace(stage + "/", cfg.get("projectWs", "/") + ("" if cfg.get("projectWs", "/").endswith("/") else "/"))
            err_msg = err_msg.replace(work + "/", "")
            result["stderr"] = clip(err_msg); result["note"] = "compile"; raise SystemExit
        digest = hashlib.sha256(cfg["jdi"].encode()).hexdigest()[:16]
        tool = os.path.join(temp_base, "qnb-jdi-" + digest)
        if not os.path.exists(os.path.join(tool, "QnbJdi.class")):
            staging = tempfile.mkdtemp(prefix="qnb-jdi-build-", dir=temp_base)
            open(os.path.join(staging, "QnbJdi.java"), "w").write(cfg["jdi"])
            p = subprocess.run(["javac", "-nowarn", "-d", staging, os.path.join(staging, "QnbJdi.java")], capture_output=True, text=True, timeout=120)
            if p.returncode:
                result["stderr"] = "디버거를 준비하지 못했습니다.\n" + p.stderr; raise SystemExit
            try:
                os.rename(staging, tool)
            except OSError:
                shutil.rmtree(staging, ignore_errors=True)
        cmd = ["timeout", str(cfg["timeout"]), "java", "-Xmx192m", "-XX:+UseSerialGC", "-cp", tool, "QnbJdi",
               cfg["mainClass"], classes, cfg["className"] + ".java",
               paths["trace.jsonl"], paths["stdout.txt"], paths["stderr.txt"], str(cfg["maxSteps"]), json.dumps(file_map)]
        env = dict(os.environ)
    cwd = cfg["cwd"] if os.path.isdir(cfg["cwd"]) else work
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env, cwd=cwd, timeout=cfg["timeout"] + 10)
        debugger_err = p.stderr
        timed_out = p.returncode == 124
    except subprocess.TimeoutExpired:
        debugger_err, timed_out = "", True
    exit_code = None
    if os.path.exists(paths["trace.jsonl"]):
        with open(paths["trace.jsonl"], encoding="utf-8", errors="replace") as fp:
            for line in fp:
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if "exit" in item:
                    exit_code = item["exit"]
                    if "signal" in item:
                        result["signal"] = item["signal"]
                elif "exception" in item:
                    result["exception"] = item["exception"]
                else:
                    if "signal" in item and "signal" not in result:
                        result["signal"] = item["signal"]
                    result["trace"].append(item)
    raw = open(paths["stdout.txt"], "rb").read() if os.path.exists(paths["stdout.txt"]) else b""
    err = open(paths["stderr.txt"], encoding="utf-8", errors="replace").read() if os.path.exists(paths["stderr.txt"]) else ""
    if timed_out:
        err += "\n[QNB] 실행 시간 제한(%%d초)을 초과해 중단했습니다." %% cfg["timeout"]
        exit_code = 124
    if result.get("signal") and exit_code in (0, None):
        sig_codes = {"SIGSEGV": 139, "SIGABRT": 134, "SIGFPE": 136, "SIGBUS": 135}
        exit_code = sig_codes.get(result["signal"], 1)
    if exit_code is None and not result["trace"]:
        err += "\n" + debugger_err[-2000:]
    result["exitCode"] = 0 if exit_code in (0, None) and not timed_out and not result.get("exception") and not result.get("signal") else (exit_code or 1)
    result["stdout"] = clip(raw.decode("utf-8", "replace"))
    result["stdoutBytes"] = base64.b64encode(raw[:200000]).decode()
    result["stderr"] = clip(err.strip())
except SystemExit:
    pass
finally:
    shutil.rmtree(work, ignore_errors=True)
payload = json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
print("QNBZ:" + base64.b64encode(zlib.compress(payload, 6)).decode("ascii"))
'''


JAVA_CLASS = re.compile(r"\bpublic\s+(?:(?:final|abstract|sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)")
JAVA_DECL = re.compile(r"\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)[^{;]*\{")
JAVA_NOISE = re.compile(r'//[^\n]*|/\*.*?\*/|"""(?:\\.|[^\\])*?"""|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])+\'', re.S)
DIAG_PATTERN = re.compile(r"^([^\s:][^:\n]*):(\d+):(?:(\d+):)?\s*(?:fatal\s+)?error:\s*(.+)$", re.M)


def _decode_runner_output(text):
    line = (text or "").strip().splitlines()[-1]
    if line.startswith("QNBZ:"):
        raw = zlib.decompress(base64.b64decode(line[5:])).decode("utf-8")
        return json.loads(raw)
    return json.loads(line)


def _java_names(source, file_path):
    """(public top-level class → file name, binary name of the class that declares main)."""
    match = JAVA_CLASS.search(source)
    class_name = match.group(1) if match else re.sub(r"\W", "_", file_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]) or "Main"
    # Blank out comments and literals (same length) so braces can be matched safely.
    code = JAVA_NOISE.sub(lambda m: " " * len(m.group(0)), source)
    spans = []
    for decl in JAVA_DECL.finditer(code):
        open_at = decl.end() - 1
        depth, close_at = 0, len(code)
        for index in range(open_at, len(code)):
            if code[index] == "{":
                depth += 1
            elif code[index] == "}":
                depth -= 1
                if depth == 0:
                    close_at = index
                    break
        spans.append((open_at, close_at, decl.group(1)))
    main = re.search(r"\bstatic\s+(?:final\s+)?(?:public\s+)?void\s+main\s*\(", code)
    if not main:
        return class_name, class_name
    owners = [span for span in spans if span[0] < main.start() < span[1]]
    if not owners:
        return class_name, class_name
    owners.sort(key=lambda span: span[0])  # outermost first
    return class_name, "$".join(name for _, _, name in owners)


def _parse_compile_errors(stderr, primary_path):
    errors = []
    seen = set()
    for match in DIAG_PATTERN.finditer(stderr or ""):
        raw_file, line_str, col_str, msg = match.group(1), match.group(2), match.group(3), match.group(4).strip()
        if raw_file.startswith("/workspace/"):
            raw_file = raw_file[10:]
        elif not raw_file.startswith("/"):
            raw_dir = posixpath.dirname(primary_path)
            raw_file = posixpath.join(raw_dir if raw_dir != "/" else "", raw_file)
            if not raw_file.startswith("/"):
                raw_file = "/" + raw_file
        line = int(line_str)
        col = int(col_str) if col_str else None
        key = (raw_file, line, msg)
        if key not in seen:
            seen.add(key)
            errors.append({"file": raw_file, "line": line, "column": col, "message": msg[:240]})
        if len(errors) >= 12:
            break
    return errors


def _format_val_brief(val, heap):
    if not isinstance(val, dict):
        return str(val)
    if val.get("kind") == "prim":
        return json.dumps(val.get("value"), ensure_ascii=False) if val.get("type") == "str" else str(val.get("value"))
    if val.get("kind") == "repr":
        return str(val.get("text") or "")
    if val.get("kind") == "ref":
        oid = val.get("id", "")
        entry = (heap or {}).get(oid)
        short_id = oid.replace("obj_", "")
        if entry:
            return f"{entry.get('type', 'obj')}#{short_id} ({entry.get('length', 0)})"
        return f"#{short_id}"
    return str(val)


def compute_step_changes(prev_step, cur_step):
    """Compute human-friendly variable/return/error change chips between adjacent steps."""
    changes = []
    ev = cur_step.get("event")
    if ev == "call":
        changes.append({"kind": "call", "label": f"호출: {cur_step.get('func', '?')}()"})
    elif ev == "return":
        ret = cur_step.get("returnValue")
        changes.append({"kind": "return", "label": f"반환 → {ret}" if ret is not None else f"{cur_step.get('func', '?')}() 종료"})
    elif ev == "exception":
        err = cur_step.get("error") or "예외/시그널 발생"
        changes.append({"kind": "error", "label": err[:60]})

    cur_stack = cur_step.get("stack") or []
    prev_stack = (prev_step or {}).get("stack") or []
    cur_top = cur_stack[-1] if cur_stack else None
    if cur_top:
        cur_locals = cur_top.get("locals") or {}
        prev_locals = {}
        for pf in reversed(prev_stack):
            if pf.get("func") == cur_top.get("func") and pf.get("file", "") == cur_top.get("file", ""):
                prev_locals = pf.get("locals") or {}
                break
        prev_heap = (prev_step or {}).get("heap") or {}
        cur_heap = cur_step.get("heap") or {}
        for name, val in cur_locals.items():
            if len(changes) >= 5:
                break
            cur_s = _format_val_brief(val, cur_heap)
            if name not in prev_locals:
                changes.append({"kind": "new", "label": f"+ {name} = {cur_s}"})
            else:
                prev_s = _format_val_brief(prev_locals[name], prev_heap)
                if cur_s != prev_s:
                    changes.append({"kind": "update", "label": f"{name}: {prev_s} → {cur_s}"})
    return changes


def explain(event, func, line, code, *, stack=None, ret=None, sig=None):
    if event == "exception":
        if sig:
            return f"치명적 시그널({sig})로 프로그램이 중단되었습니다 (메모리 접근 또는 연산 오류를 확인하세요)"
        return f"예외가 발생해 실행이 중단되었습니다"
    if event == "call":
        is_recursive = bool(stack and sum(1 for f in stack if f.get("func") == func) >= 2)
        if is_recursive:
            depth = sum(1 for f in stack if f.get("func") == func)
            return f"재귀 호출: {func}() {depth}단계 진입"
        return f"함수 {func}() 호출 진입"
    if event == "return":
        if ret is not None:
            return f"{func}() 실행을 마치고 {ret} 반환"
        return f"{func}() 실행을 마치고 반환합니다"
    snippet = code.strip()
    if re.match(r"^(?:for|while)\s*\(", snippet):
        return f"{line}행 반복문 조건/진행 확인: {snippet[:64]}"
    if re.match(r"^(?:if|else\s+if|switch)\b", snippet):
        return f"{line}행 조건 분기 판별: {snippet[:64]}"
    if re.search(r"\bnew\b", snippet):
        return f"{line}행 힙 메모리 동적 할당: {snippet[:64]}"
    if "->" in snippet or re.match(r"^\*[\w]+\s*=", snippet):
        return f"{line}행 포인터 역참조 및 멤버 접근: {snippet[:64]}"
    return f"{line}행 실행: {snippet[:64]}" if snippet else f"{line}행 실행"


NOISE_ARG = re.compile(r",\s*(?:std::)?(?:allocator|less|hash|equal_to|char_traits)<")


def pretty_type(name):
    """vector<int, std::allocator<int> > → vector<int>; map<string, int, less<…>, allocator<…>> → map<string, int>."""
    name = name.replace("std::", "").replace("__cxx11::", "")
    while True:
        match = NOISE_ARG.search(name)
        if not match:
            break
        depth, j = 0, match.end() - 1
        while j < len(name):
            depth += {"<": 1, ">": -1}.get(name[j], 0)
            if depth == 0:
                break
            j += 1
        name = name[:match.start()] + name[j + 1:]
    name = re.sub(r"\s+>", ">", name)
    return name.replace("basic_string<char>", "string")


def _stable_ids(stack, heap):
    """Debuggers create fresh object ids at every step; renumber them in frame/variable order so the
    same variable keeps the same id and the visualizer only flags values that really changed."""
    mapping = {}

    def visit(value):
        if not isinstance(value, dict) or value.get("kind") != "ref":
            return
        old = value.get("id")
        if old in mapping:
            value["id"] = mapping[old]
            return
        mapping[old] = value["id"] = f"obj_{len(mapping) + 1}"
        entry = heap.get(old)
        if entry:
            for item in entry.get("items") or []:
                visit(item)
            for _, item in entry.get("fields") or []:
                visit(item)

    for frame in stack:
        for value in frame.get("locals", {}).values():
            visit(value)
    renamed = {}
    for old, new in mapping.items():
        if old in heap:
            entry = dict(heap[old], id=new)
            renamed[new] = entry
    return renamed


def _drop_cleanup_bounces(steps):
    """GCC attributes temporaries' cleanup to the closing brace, so stepping a declaration can visit
    "}" and jump back. Hide those visits; a real end-of-function "}" is followed by a return."""
    kept = []
    for index, step in enumerate(steps):
        following = steps[index + 1] if index + 1 < len(steps) else None
        if (step["event"] == "line" and step["code"].strip() in ("}", "};") and following is not None
                and following["event"] == "line" and following["func"] == step["func"]
                and following.get("file") == step.get("file")
                and len(following["stack"]) == len(step["stack"]) and following["line"] < step["line"]):
            continue
        previous = kept[-1] if kept else None
        if (previous is not None and step["event"] == "line" and previous["event"] == "line"
                and previous["func"] == step["func"] and previous.get("file") == step.get("file")
                and previous["line"] == step["line"]
                and len(previous["stack"]) == len(step["stack"])):
            kept[-1] = step  # same line revisited after a cleanup bounce: keep the latest state
            continue
        kept.append(step)
    for index, step in enumerate(kept):
        step["index"] = index
    return kept


def _build_pipeline(language, note, exit_code, steps, compile_errors):
    compiler_label = "g++ -g 컴파일" if language == "cpp" else "javac -g 컴파일"
    debugger_label = "GDB 한 줄 추적" if language == "cpp" else "JDI 한 줄 추적"
    if note == "nodebugger":
        return [
            {"id": "compile", "label": compiler_label, "status": "error", "detail": "도구 없음"},
            {"id": "trace", "label": debugger_label, "status": "idle", "detail": "대기"},
            {"id": "memory", "label": "스택·힙 분석", "status": "idle", "detail": "대기"},
        ]
    if note == "compile":
        detail = f"오류 {len(compile_errors)}건" if compile_errors else "컴파일 실패"
        return [
            {"id": "compile", "label": compiler_label, "status": "error", "detail": detail},
            {"id": "trace", "label": debugger_label, "status": "idle", "detail": "중단"},
            {"id": "memory", "label": "스택·힙 분석", "status": "idle", "detail": "중단"},
        ]
    max_heap = max((len(s.get("heap") or {}) for s in steps), default=0)
    return [
        {"id": "compile", "label": compiler_label, "status": "ok", "detail": "성공"},
        {"id": "trace", "label": debugger_label, "status": "ok" if exit_code == 0 else "error",
         "detail": f"{len(steps)}단계" if exit_code == 0 else f"{len(steps)}단계 · 중단"},
        {"id": "memory", "label": "스택·힙 분석", "status": "ok", "detail": f"힙 객체 {max_heap}개"},
    ]


def build_result(data, code, file_path, language):
    sources = dict(data.get("sources") or {})
    sources.setdefault(file_path, code)
    source_lines = {p: txt.splitlines() for p, txt in sources.items()}
    stdout_bytes = base64.b64decode(data.get("stdoutBytes") or "") if data.get("stdoutBytes") else data.get("stdout", "").encode()
    steps = []
    edges = {}
    for index, item in enumerate(data.get("trace", [])[:MAX_STEPS]):
        step_file = item.get("file") or file_path
        line = item.get("line", 0)
        lines = source_lines.get(step_file) or source_lines.get(file_path, [])
        text = lines[line - 1] if 1 <= line <= len(lines) else ""
        stack = [{
            "file": f.get("file") or file_path,
            "func": f.get("func", "?"),
            "line": f.get("line", 0),
            "locals": f.get("locals", {}),
        } for f in item.get("stack", [])]
        if item.get("event") == "call" and len(stack) >= 2:
            key = (stack[-2]["file"], stack[-2]["func"], stack[-1]["file"], stack[-1]["func"])
            edges[key] = edges.get(key, 0) + 1
        out = stdout_bytes[:item.get("out", 0)].decode("utf-8", "replace")[-8192:]
        heap = _stable_ids(stack, item.get("heap", {}))
        if language == "cpp":
            for entry in heap.values():
                entry["type"] = pretty_type(entry.get("type", ""))
        ret_val = item.get("ret")
        sig = item.get("signal")
        steps.append({
            "index": index, "event": item.get("event", "line"), "file": step_file, "func": item.get("func", "?"),
            "line": line, "code": text,
            "explain": explain(item.get("event"), item.get("func"), line, text, stack=stack, ret=ret_val, sig=sig),
            "stack": stack, "heap": heap, "stdout": out, "returnValue": ret_val,
            "error": sig if sig else None,
        })
    steps = _drop_cleanup_bounces(steps)
    exit_code = data.get("exitCode", 1)
    note = data.get("note", "")
    stderr = data.get("stderr", "")
    compile_errors = _parse_compile_errors(stderr, file_path) if note == "compile" else []

    if data.get("signal"):
        sig_msg = f"치명적 시그널 감지: {data['signal']}"
        stderr = (sig_msg + ("\n" + stderr if stderr else "")).strip()
        if steps:
            steps[-1]["error"] = sig_msg
    elif data.get("exception"):
        stderr = (f"처리되지 않은 예외: {data['exception']}\n" + stderr).strip()
        if steps:
            steps[-1]["error"] = data["exception"]
    elif note == "compile" and not steps:
        first_err = compile_errors[0] if compile_errors else {"file": file_path, "line": 1, "message": stderr.splitlines()[0] if stderr else "컴파일 오류"}
        err_lines = source_lines.get(first_err["file"]) or source_lines.get(file_path, [])
        err_line = first_err["line"]
        steps.append({
            "index": 0, "event": "exception", "file": first_err["file"], "func": "compile",
            "line": err_line,
            "code": err_lines[err_line - 1] if 1 <= err_line <= len(err_lines) else "",
            "explain": f"컴파일 오류: {first_err['message']}",
            "stack": [], "heap": {}, "stdout": "", "returnValue": None,
            "error": first_err["message"],
        })
    elif steps and exit_code not in (0, None):
        steps[-1]["error"] = steps[-1].get("error") or f"종료 코드 {exit_code}"

    for idx, step in enumerate(steps):
        step["changes"] = compute_step_changes(steps[idx - 1] if idx > 0 else None, step)

    outputs = []
    if data.get("stdout"):
        outputs.append({"output_type": "stream", "name": "stdout", "text": data["stdout"]})
    if stderr:
        outputs.append({"output_type": "stream", "name": "stderr", "text": stderr})
    total = len(data.get("trace", []))
    return {
        "exitCode": exit_code,
        "outputs": outputs,
        "visualization": {
            "kind": language,
            "primaryFile": file_path,
            "ok": exit_code == 0,
            "steps": steps,
            "callEdges": [
                {"fromFile": a_f, "fromFunc": a, "toFile": b_f, "toFunc": b, "count": c}
                for (a_f, a, b_f, b), c in edges.items()
            ],
            "compileErrors": compile_errors,
            "pipeline": _build_pipeline(language, note, exit_code, steps, compile_errors),
            "truncatedSteps": total >= MAX_STEPS,
            "maxSteps": MAX_STEPS,
            "totalSteps": len(steps),
            "note": note,
        },
    }


def trace(vm_id, file_path, code, language):
    if language not in ("cpp", "java"):
        raise RequestError("C++ 또는 Java 파일만 단계 실행할 수 있습니다.")
    class_name, main_class = _java_names(code, file_path) if language == "java" else ("", "")
    project_ws = file_path.rsplit("/", 1)[0] or "/"
    cfg = {
        "language": language, "source": code, "fileName": file_path.rsplit("/", 1)[-1],
        "filePath": file_path, "projectWs": project_ws,
        "projectDir": "/workspace" + ("" if project_ws == "/" else project_ws),
        "className": class_name, "mainClass": main_class, "timeout": RUN_TIMEOUT, "maxSteps": MAX_STEPS,
        "cwd": "/workspace" + ("" if project_ws == "/" else project_ws),
        "driver": GDB_DRIVER if language == "cpp" else "", "jdi": JDI_DEBUGGER if language == "java" else "",
    }
    script = RUNNER % {"cfg": base64.b64encode(json.dumps(cfg).encode()).decode()}
    res = runtime.vm(vm_id, {"language": "python", "code": script, "stateless": True})
    if "exitCode" not in res:
        raise RequestError(f"실행 실패 ({res.get('error', 'VM 응답 오류')}).", 503)
    try:
        data = _decode_runner_output(res.get("output") or "")
    except (IndexError, ValueError, zlib.error) as error:
        raise RequestError("VM 실행 결과를 해석하지 못했습니다.", 502) from error
    return build_result(data, code, file_path, language)
