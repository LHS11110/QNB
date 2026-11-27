"""Line-by-line C++ / Java execution for learning, driven by real debuggers in the VM.

C++  : g++ -g -O0, then gdb (Python API) steps line by line, stepping out of library
       code, reading locals from debug info and expanding containers via libstdc++
       pretty printers.
Java : javac -g, then a small JDI debugger (QnbJdi) launches the program, requests
       line steps with JDK classes excluded, and reads frames, locals and objects.

Both write one JSON line per step; build_result() turns them into the visualizer's
step format (stack frames with locals, heap entries, cumulative stdout).
"""

import base64
import hashlib
import json
import re

from . import runtime
from .runtime import RequestError

MAX_STEPS = 300
RUN_TIMEOUT = 30

GDB_DRIVER = r'''
import json, os, re, itertools
import gdb

SOURCE = os.environ["QNB_SOURCE"]
TRACE = open(os.environ["QNB_TRACE"], "w")
OUT = os.environ["QNB_OUT"]
MAX_STEPS = int(os.environ["QNB_MAX_STEPS"])
state = {"exit": None, "seq": 0, "steps": 0}

def on_exit(event):
    state["exit"] = getattr(event, "exit_code", None)
gdb.events.exited.connect(on_exit)

def clip(text, n=120):
    return text if len(text) <= n else text[:n - 1] + "…"

def user_sal(frame):
    try:
        sal = frame.find_sal()
    except gdb.error:
        return None
    if sal.symtab is None or os.path.basename(sal.symtab.filename) != os.path.basename(SOURCE):
        return None
    return sal

def new_id():
    state["seq"] += 1
    return "obj_%d" % state["seq"]

def fmt(val, heap, depth=0):
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
            if depth >= 3:
                return {"kind": "repr", "type": name, "text": "…"}
            header = str(viz.to_string() or "")
            length = re.search(r"(?:length|with) (\d+)", header)
            children = list(itertools.islice(viz.children(), 26 if hint == "map" else 13))
            oid = new_id()
            entry = {"id": oid, "type": name, "truncated": False}
            if hint == "map":
                pairs = [(children[i][1], children[i + 1][1]) for i in range(0, len(children) - 1, 2)][:12]
                entry["fields"] = [[clip(str(k).strip('"'), 40), fmt(v, heap, depth + 1)] for k, v in pairs]
                count = int(length.group(1)) if length else len(pairs)
            else:
                entry["items"] = [fmt(v if isinstance(v, gdb.Value) else gdb.Value(v), heap, depth + 1) for _, v in children[:12]]
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
            if int(val) == 0:
                return {"kind": "repr", "type": "pointer", "text": "nullptr"}
            if target.code == gdb.TYPE_CODE_INT and target.sizeof == 1:
                try:
                    return {"kind": "prim", "type": "str", "value": clip(val.string(length=200))}
                except gdb.error:
                    pass
            return {"kind": "repr", "type": "pointer", "text": hex(int(val))}
        if depth >= 3:
            return {"kind": "repr", "type": name, "text": "…"}
        if code == gdb.TYPE_CODE_ARRAY:
            low, high = t.range()
            count = high - low + 1
            target = t.target().strip_typedefs()
            if target.code == gdb.TYPE_CODE_INT and target.sizeof == 1:
                try:
                    return {"kind": "prim", "type": "str", "value": clip(val.string())}
                except gdb.error:
                    pass
            oid = new_id()
            heap[oid] = {"id": oid, "type": name, "length": count,
                         "items": [fmt(val[low + i], heap, depth + 1) for i in range(min(count, 12))], "truncated": count > 12}
            return {"kind": "ref", "id": oid}
        if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            oid = new_id()
            fields = []
            for field in t.fields():
                if getattr(field, "is_base_class", False) or not field.name or (hasattr(field, "bitpos") is False):
                    continue
                if len(fields) >= 12:
                    break
                try:
                    fields.append([field.name, fmt(val[field.name], heap, depth + 1)])
                except gdb.error:
                    continue
            heap[oid] = {"id": oid, "type": name, "length": len(fields), "fields": fields, "truncated": False}
            return {"kind": "ref", "id": oid}
        return {"kind": "repr", "type": name, "text": clip(str(val))}
    except (gdb.error, gdb.MemoryError, RuntimeError, ValueError, OverflowError) as error:
        return {"kind": "repr", "type": "?", "text": clip("<%s>" % error, 60)}

def frame_locals(frame, line, heap):
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
            if sym.is_variable and sym.line and sym.line > line:
                continue  # declared further down: not yet in scope
            try:
                out[sym.name] = fmt(sym.value(frame), heap)
            except (gdb.error, RuntimeError):
                continue
            if len(out) >= 24:
                return out
    return out

def snapshot():
    frames = []
    frame = gdb.newest_frame()
    while frame is not None:
        sal = user_sal(frame)
        if sal is not None:
            frames.append((frame, sal))
        frame = frame.older()
    frames.reverse()
    heap = {}
    stack = []
    for frame, sal in frames:
        fn = frame.function()
        name = fn.name if fn is not None else (frame.name() or "?")
        name = re.sub(r"\(.*\)$", "", name)
        stack.append({"func": name, "line": sal.line, "locals": frame_locals(frame, sal.line, heap)})
    return stack, heap

def out_bytes():
    try:
        return os.path.getsize(OUT)
    except OSError:
        return 0

def emit(event, stack, heap):
    top = stack[-1]
    TRACE.write(json.dumps({"event": event, "line": top["line"], "func": top["func"], "stack": stack,
                            "heap": heap, "out": out_bytes()}, ensure_ascii=False) + "\n")
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

previous = last_stack = last_heap = None
while alive() and state["steps"] < MAX_STEPS:
    frame = gdb.selected_frame()
    if user_sal(frame) is None:
        # Library / runtime code: run until we are back in the learner's file.
        try:
            if frame.older() is None:
                break
            gdb.execute("finish", to_string=True)
        except gdb.error:
            break
        continue
    stack, heap = snapshot()
    key = [(f["func"], f["line"]) for f in stack]
    if key != previous:
        depth, prev_depth = len(stack), len(previous or [])
        if previous is not None and depth < prev_depth and last_stack is not None:
            emit("return", last_stack[:prev_depth], last_heap)
        emit("call" if depth > prev_depth else "line", stack, heap)
        previous, last_stack, last_heap = key, stack, heap
    try:
        gdb.execute("step", to_string=True)
    except gdb.error:
        break

if alive():
    try:
        gdb.execute("delete", to_string=True)
        gdb.execute("continue", to_string=True)
    except gdb.error:
        pass
TRACE.write(json.dumps({"exit": state["exit"]}) + "\n")
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
  static final String[] EXCLUDES = {"java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "kotlin.*"};

  public static void main(String[] a) throws Exception {
    String mainClass = a[0], classPath = a[1]; sourceName = a[2];
    trace = new PrintWriter(new OutputStreamWriter(new FileOutputStream(a[3]), StandardCharsets.UTF_8));
    FileOutputStream out = new FileOutputStream(a[4]); FileOutputStream err = new FileOutputStream(a[5]);
    maxSteps = Integer.parseInt(a[6]);
    LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
    Map<String, Connector.Argument> args = connector.defaultArguments();
    args.get("main").setValue(mainClass);
    args.get("options").setValue("-cp " + classPath + " -Xss16m -Dfile.encoding=UTF-8");
    VirtualMachine vm = connector.launch(args);
    Process process = vm.process();
    process.getOutputStream().close();
    Thread outPump = pump(process.getInputStream(), out, true), errPump = pump(process.getErrorStream(), err, false);
    EventRequestManager erm = vm.eventRequestManager();
    ClassPrepareRequest prepare = erm.createClassPrepareRequest();
    prepare.addSourceNameFilter(sourceName);
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
          for (Method m : type.methodsByName("main")) {
            if (m.isStatic() && m.location() != null) erm.createBreakpointRequest(m.location()).enable();
          }
        } else if (event instanceof BreakpointEvent && !stepping) {
          stepping = true;
          ThreadReference thread = ((BreakpointEvent) event).thread();
          StepRequest step = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
          for (String ex : EXCLUDES) step.addClassExclusionFilter(ex);
          step.enable();
          Object[] r = record(thread, previous, lastStack, lastHeap, lastDepth);
          if (r != null) { previous = (List<String>) r[0]; lastStack = (String) r[1]; lastHeap = (String) r[2]; lastDepth = (Integer) r[3]; }
        } else if (event instanceof StepEvent) {
          ThreadReference thread = ((StepEvent) event).thread();
          if (steps >= maxSteps) { event.request().disable(); continue; }
          Object[] r = record(thread, previous, lastStack, lastHeap, lastDepth);
          if (r != null) { previous = (List<String>) r[0]; lastStack = (String) r[1]; lastHeap = (String) r[2]; lastDepth = (Integer) r[3]; }
        } else if (event instanceof ExceptionEvent) {
          ExceptionEvent ex = (ExceptionEvent) event;
          trace.println("{\"exception\":" + esc(ex.exception().referenceType().name(), 200) + "}");
        }
      }
      set.resume();
    }
    outPump.join(2000); errPump.join(2000);
    int code = process.waitFor();
    trace.println("{\"exit\":" + code + "}");
    trace.close();
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
    return text instanceof StringReference ? ((StringReference) text).value() : o.referenceType().name();
  }

  static Thread pump(InputStream in, OutputStream sink, boolean count) {
    Thread t = new Thread(() -> {
      byte[] buf = new byte[8192]; int n;
      try { while ((n = in.read(buf)) > 0) { sink.write(buf, 0, n); sink.flush(); if (count) { synchronized (QnbJdi.class) { outBytes += n; } lastOutputAt = System.nanoTime(); } } }
      catch (IOException ignored) { }
    });
    t.setDaemon(true); t.start(); return t;
  }

  static Object[] record(ThreadReference thread, List<String> previous, String lastStack, String lastHeap, int lastDepth) {
    // 1) Capture everything from the frames first: formatting may invoke methods (toArray, ...),
    //    which resumes the thread and invalidates StackFrame objects.
    List<Object[]> snap = new ArrayList<>();  // {func, line, this, names, values}
    try {
      List<StackFrame> frames = thread.frames();
      for (int i = frames.size() - 1; i >= 0; i--) {
        StackFrame f = frames.get(i);
        Location l = f.location();
        try { if (!sourceName.equals(l.sourceName())) continue; } catch (AbsentInformationException e) { continue; }
        List<String> names = new ArrayList<>(); List<Value> values = new ArrayList<>();
        try {
          List<LocalVariable> vars = f.visibleVariables();
          if (vars.size() > 24) vars = vars.subList(0, 24);
          Map<LocalVariable, Value> got = f.getValues(vars);
          for (LocalVariable v : vars) { names.add(v.name()); values.add(got.get(v)); }
        } catch (AbsentInformationException ignored) { }
        String func = l.declaringType().name().replaceAll(".*[.$]", "") + "." + l.method().name();
        snap.add(new Object[]{func, l.lineNumber(), f.thisObject(), names, values});
      }
    } catch (IncompatibleThreadStateException | InvalidStackFrameException e) {
      return null;
    }
    if (snap.isEmpty()) return null;
    List<String> key = new ArrayList<>();
    for (Object[] f : snap) key.add(f[0] + ":" + f[1]);
    if (key.equals(previous)) return null;
    // 2) Format values.
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
      stack.append(stack.length() > 0 ? "," : "").append("{\"func\":").append(esc((String) f[0], 120)).append(",\"line\":").append(f[1]).append(",\"locals\":").append(locals).append("}}");
    }
    Object[] top = snap.get(snap.size() - 1);
    int depth = snap.size();
    if (previous != null && depth < lastDepth && lastStack != null) {
      emitLine("return", lastLine(lastStack), lastFunc(lastStack), lastStack, lastHeap);
    }
    emitLine(depth > lastDepth ? "call" : "line", (Integer) top[1], (String) top[0], stack.toString(), heap.toString());
    return new Object[]{key, stack.toString(), heap.toString(), depth};
  }

  static int lastLine(String stack) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"line\":(\\d+)").matcher(stack); int v = 0; while (m.find()) v = Integer.parseInt(m.group(1)); return v; }
  static String lastFunc(String stack) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"func\":\"([^\"]*)\"").matcher(stack); String v = "?"; while (m.find()) v = m.group(1); return v; }

  static void emitLine(String event, int line, String func, String stack, String heap) {
    settleOutput();
    long out; synchronized (QnbJdi.class) { out = outBytes; }
    trace.println("{\"event\":\"" + event + "\",\"line\":" + line + ",\"func\":" + esc(func, 120) + ",\"stack\":[" + stack + "],\"heap\":{" + heap + "},\"out\":" + out + "}");
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
    if (depth >= 3) return repr(type, "…");
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
import base64, hashlib, json, os, shutil, subprocess, tempfile
cfg = json.loads(base64.b64decode(%(cfg)r).decode())
lang = cfg["language"]
work = tempfile.mkdtemp(prefix="qnb-step-")
result = {"exitCode": 1, "stdout": "", "stderr": "", "trace": [], "note": ""}
paths = {k: os.path.join(work, k) for k in ("trace.jsonl", "stdout.txt", "stderr.txt")}
def clip(text, n=20000):
    return text if len(text) <= n else text[:n] + "\n…(생략)"
def need(tool, message):
    if not shutil.which(tool):
        result["stderr"] = message; result["note"] = "nodebugger"; raise SystemExit
UPGRADE = "VM 이미지에 디버거가 없습니다. 관리자가 deploy/guest/Dockerfile로 VM 이미지를 갱신해야 합니다."
try:
    if lang == "cpp":
        need("g++", "VM에 g++ 컴파일러가 없습니다.")
        need("gdb", UPGRADE + " (gdb)")
        src = os.path.join(work, cfg["fileName"])
        open(src, "w", encoding="utf-8").write(cfg["source"])
        exe = os.path.join(work, "program")
        p = subprocess.run(["g++", "-std=c++17", "-g", "-O0", "-fno-omit-frame-pointer", "-o", exe, src], capture_output=True, text=True, timeout=90)
        if p.returncode:
            result["stderr"] = clip(p.stderr.replace(work + "/", "")); result["note"] = "compile"; raise SystemExit
        driver = os.path.join(work, "driver.py")
        open(driver, "w").write(cfg["driver"])
        env = dict(os.environ, QNB_SOURCE=src, QNB_TRACE=paths["trace.jsonl"], QNB_OUT=paths["stdout.txt"],
                   QNB_ERR=paths["stderr.txt"], QNB_MAX_STEPS=str(cfg["maxSteps"]))
        cmd = ["timeout", str(cfg["timeout"]), "gdb", "-q", "-batch", "-nx", "-x", driver, exe]
    else:
        need("javac", UPGRADE + " (JDK)")
        classes = os.path.join(work, "classes"); os.makedirs(classes)
        src = os.path.join(work, cfg["className"] + ".java")
        open(src, "w", encoding="utf-8").write(cfg["source"])
        p = subprocess.run(["javac", "-g", "-encoding", "UTF-8", "-nowarn", "-d", classes, src], capture_output=True, text=True, timeout=120)
        if p.returncode:
            result["stderr"] = clip(p.stderr.replace(work + "/", "")); result["note"] = "compile"; raise SystemExit
        digest = hashlib.sha256(cfg["jdi"].encode()).hexdigest()[:16]
        tool = os.path.join(tempfile.gettempdir(), "qnb-jdi-" + digest)
        if not os.path.exists(os.path.join(tool, "QnbJdi.class")):
            staging = tempfile.mkdtemp(prefix="qnb-jdi-build-")
            open(os.path.join(staging, "QnbJdi.java"), "w").write(cfg["jdi"])
            p = subprocess.run(["javac", "-nowarn", "-d", staging, os.path.join(staging, "QnbJdi.java")], capture_output=True, text=True, timeout=120)
            if p.returncode:
                result["stderr"] = "디버거를 준비하지 못했습니다.\n" + p.stderr; raise SystemExit
            try:
                os.rename(staging, tool)
            except OSError:
                shutil.rmtree(staging, ignore_errors=True)
        cmd = ["timeout", str(cfg["timeout"]), "java", "-cp", tool, "QnbJdi", cfg["mainClass"], classes, cfg["className"] + ".java",
               paths["trace.jsonl"], paths["stdout.txt"], paths["stderr.txt"], str(cfg["maxSteps"])]
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
                elif "exception" in item:
                    result["exception"] = item["exception"]
                else:
                    result["trace"].append(item)
    raw = open(paths["stdout.txt"], "rb").read() if os.path.exists(paths["stdout.txt"]) else b""
    err = open(paths["stderr.txt"], encoding="utf-8", errors="replace").read() if os.path.exists(paths["stderr.txt"]) else ""
    if timed_out:
        err += "\n[QNB] 실행 시간 제한(%%d초)을 초과해 중단했습니다." %% cfg["timeout"]
        exit_code = 124
    if exit_code is None and not result["trace"]:
        err += "\n" + debugger_err[-2000:]
    result["exitCode"] = 0 if exit_code in (0, None) and not timed_out and not result.get("exception") else (exit_code or 1)
    result["stdout"] = clip(raw.decode("utf-8", "replace"))
    result["stdoutBytes"] = base64.b64encode(raw[:200000]).decode()
    result["stderr"] = clip(err.strip())
except SystemExit:
    pass
finally:
    shutil.rmtree(work, ignore_errors=True)
print(json.dumps(result, ensure_ascii=True))
'''


JAVA_CLASS = re.compile(r"\bpublic\s+(?:(?:final|abstract|sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)")
JAVA_DECL = re.compile(r"\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)[^{;]*\{")
JAVA_NOISE = re.compile(r'//[^\n]*|/\*.*?\*/|"""(?:\\.|[^\\])*?"""|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])+\'', re.S)


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


def explain(event, func, line, code):
    if event == "call":
        return f"함수 {func}() 호출 진입"
    if event == "return":
        return f"{func}() 실행을 마치고 반환합니다"
    snippet = code.strip()
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
                and len(following["stack"]) == len(step["stack"]) and following["line"] < step["line"]):
            continue
        previous = kept[-1] if kept else None
        if (previous is not None and step["event"] == "line" and previous["event"] == "line"
                and previous["func"] == step["func"] and previous["line"] == step["line"]
                and len(previous["stack"]) == len(step["stack"])):
            kept[-1] = step  # same line revisited after a cleanup bounce: keep the latest state
            continue
        kept.append(step)
    for index, step in enumerate(kept):
        step["index"] = index
    return kept


def build_result(data, code, file_path, language):
    lines = code.splitlines()
    stdout_bytes = base64.b64decode(data.get("stdoutBytes") or "") if data.get("stdoutBytes") else data.get("stdout", "").encode()
    steps = []
    edges = {}
    for index, item in enumerate(data.get("trace", [])[:MAX_STEPS]):
        line = item.get("line", 0)
        text = lines[line - 1] if 1 <= line <= len(lines) else ""
        stack = [{"file": file_path, "func": f.get("func", "?"), "line": f.get("line", 0), "locals": f.get("locals", {})}
                 for f in item.get("stack", [])]
        if item.get("event") == "call" and len(stack) >= 2:
            key = (stack[-2]["func"], stack[-1]["func"])
            edges[key] = edges.get(key, 0) + 1
        out = stdout_bytes[:item.get("out", 0)].decode("utf-8", "replace")[-8192:]
        heap = _stable_ids(stack, item.get("heap", {}))
        if language == "cpp":
            for entry in heap.values():
                entry["type"] = pretty_type(entry.get("type", ""))
        steps.append({
            "index": index, "event": item.get("event", "line"), "file": file_path, "func": item.get("func", "?"),
            "line": line, "code": text, "explain": explain(item.get("event"), item.get("func"), line, text),
            "stack": stack, "heap": heap, "stdout": out, "returnValue": None, "error": None,
        })
    steps = _drop_cleanup_bounces(steps)
    exit_code = data.get("exitCode", 1)
    if steps and exit_code not in (0, None):
        steps[-1]["error"] = f"종료 코드 {exit_code}"
    outputs = []
    if data.get("stdout"):
        outputs.append({"output_type": "stream", "name": "stdout", "text": data["stdout"]})
    stderr = data.get("stderr", "")
    if data.get("exception"):
        stderr = (f"처리되지 않은 예외: {data['exception']}\n" + stderr).strip()
        if steps:
            steps[-1]["error"] = data["exception"]
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
            "callEdges": [{"fromFile": file_path, "fromFunc": a, "toFile": file_path, "toFunc": b, "count": c}
                          for (a, b), c in edges.items()],
            "truncatedSteps": total >= MAX_STEPS,
            "maxSteps": MAX_STEPS,
            "totalSteps": len(steps),
            "note": data.get("note", ""),
        },
    }


def trace(vm_id, file_path, code, language):
    if language not in ("cpp", "java"):
        raise RequestError("C++ 또는 Java 파일만 단계 실행할 수 있습니다.")
    class_name, main_class = _java_names(code, file_path) if language == "java" else ("", "")
    cfg = {
        "language": language, "source": code, "fileName": file_path.rsplit("/", 1)[-1],
        "className": class_name, "mainClass": main_class, "timeout": RUN_TIMEOUT, "maxSteps": MAX_STEPS,
        "cwd": "/workspace" + (file_path.rsplit("/", 1)[0] or ""),
        "driver": GDB_DRIVER if language == "cpp" else "", "jdi": JDI_DEBUGGER if language == "java" else "",
    }
    script = RUNNER % {"cfg": base64.b64encode(json.dumps(cfg).encode()).decode()}
    res = runtime.vm(vm_id, {"language": "python", "code": script})
    if "exitCode" not in res:
        raise RequestError(f"실행 실패 ({res.get('error', 'VM 응답 오류')}).", 503)
    raw = (res.get("output") or "").strip().splitlines()
    try:
        data = json.loads(raw[-1])
    except (IndexError, ValueError) as error:
        raise RequestError("VM 실행 결과를 해석하지 못했습니다.", 502) from error
    return build_result(data, code, file_path, language)
