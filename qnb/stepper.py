"""Line-by-line tracing for C++ and Java learning sessions.

The VM has compilers but no debugger, so the source is instrumented instead: before
every statement inside a function body we insert a call that records the line, the
visible local variables and the call stack. Inserted code never contains newlines,
so compiler diagnostics keep the learner's original line numbers.
"""

import base64
import json
import re

from . import runtime
from .runtime import RequestError

MAX_STEPS = 300
RUN_TIMEOUT = 10

CPP_TYPE_WORDS = {
    "int", "long", "short", "char", "bool", "float", "double", "unsigned", "signed", "void", "auto",
    "size_t", "wchar_t", "char16_t", "char32_t", "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t", "ptrdiff_t",
}
JAVA_TYPE_WORDS = {"int", "long", "short", "char", "boolean", "float", "double", "byte", "var", "void"}
QUALIFIERS = {"const", "static", "constexpr", "volatile", "final", "register", "inline", "thread_local", "mutable", "typename", "struct", "class", "enum"}
NOT_DECL_START = {
    "return", "delete", "throw", "goto", "break", "continue", "new", "co_return", "co_yield", "co_await",
    "using", "typedef", "assert", "yield", "this", "super", "sizeof", "static_assert", "operator", "template",
}
CONTROL = {"if", "for", "while", "switch", "do", "try", "else", "catch", "finally", "case", "default"}
CONTAINER_KEYWORDS = {"class", "struct", "union", "namespace", "enum", "interface", "record"}
SUFFIX_QUALIFIERS = {"const", "noexcept", "override", "final", "volatile", "mutable", "&", "&&"}

TOKEN_RE = re.compile(r"""
    (?P<ws>\s+)
  | (?P<lcomment>//[^\n]*)
  | (?P<bcomment>/\*.*?\*/)
  | (?P<textblock>\"\"\"(?:\\.|[^\\])*?\"\"\")
  | (?P<rawstr>(?:u8|u|U|L)?R\"(?P<delim>[^()\\\s]{0,16})\((?:.|\n)*?\)(?P=delim)\")
  | (?P<string>(?:u8|u|U|L)?\"(?:\\.|[^\"\\\n])*\")
  | (?P<char>(?:u8|u|U|L)?'(?:\\.|[^'\\\n])+')
  | (?P<number>\.?\d(?:[\w.']|[eEpP][+-])*)
  | (?P<ident>[A-Za-z_$][\w$]*)
  | (?P<punct>::|->|\+\+|--|<<=|>>=|<=>|<<|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|/=|%=|&=|\|=|\^=|\.\.\.|[^\s\w])
""", re.S | re.X)


class Token:
    __slots__ = ("kind", "text", "start", "end", "line")

    def __init__(self, kind, text, start, end, line):
        self.kind, self.text, self.start, self.end, self.line = kind, text, start, end, line

    def __repr__(self):
        return f"{self.text!r}@{self.line}"


def tokenize(source, language):
    tokens = []
    pos, line = 0, 1
    at_line_start = True
    while pos < len(source):
        if language == "cpp" and at_line_start:
            # Preprocessor directives (with backslash continuations) are not code we instrument.
            match = re.match(r"[ \t]*#(?:[^\n\\]|\\.)*", source[pos:], re.S)
            if match:
                text = match.group(0)
                line += text.count("\n")
                pos += len(text)
                continue
        match = TOKEN_RE.match(source, pos)
        if not match:
            raise ValueError(f"tokenize error at {line}")
        kind = match.lastgroup if match.lastgroup != "delim" else "rawstr"
        if match.group("rawstr") is not None:
            kind = "rawstr"
        text = match.group(0)
        if kind not in ("ws", "lcomment", "bcomment"):
            tokens.append(Token("string" if kind in ("textblock", "rawstr", "string", "char") else kind,
                                text, pos, match.end(), line))
            at_line_start = False
        line += text.count("\n")
        if kind == "ws" and "\n" in text:
            at_line_start = True
        elif kind != "ws":
            at_line_start = kind == "lcomment"  # a line comment always runs to the end of the line
        pos = match.end()
    return tokens


class Instrumenter:
    def __init__(self, source, language):
        self.source = source
        self.lang = language
        self.toks = tokenize(source, language)
        self.ins = []  # (offset, order, text)
        self.functions = 0
        self.class_names = []

    # ---------------- token helpers ----------------

    def t(self, i):
        return self.toks[i].text if 0 <= i < len(self.toks) else ""

    def match_close(self, i):
        """Index of the bracket closing the one at i."""
        pairs = {"(": ")", "[": "]", "{": "}"}
        open_t, close_t = self.t(i), pairs[self.t(i)]
        depth = 0
        for j in range(i, len(self.toks)):
            text = self.toks[j].text
            if text == open_t:
                depth += 1
            elif text == close_t:
                depth -= 1
                if depth == 0:
                    return j
        raise ValueError("unbalanced brackets")

    def skip_angles(self, i):
        """i at '<' following a type name: return index after the matching '>'."""
        depth = 0
        j = i
        while j < len(self.toks):
            text = self.t(j)
            if text == "<":
                depth += 1
            elif text == ">":
                depth -= 1
            elif text == ">>":
                depth -= 2
            elif text in ("(", "["):
                j = self.match_close(j)
            elif text in (";", "{", "}"):
                return None
            j += 1
            if depth <= 0:
                return j
        return None

    def insert(self, offset, text, order=0):
        self.ins.append((offset, order, text))

    # ---------------- top level ----------------

    def run(self):
        self.scan_container(0, len(self.toks), class_name=None)
        out = []
        last = 0
        for offset, _, text in sorted(self.ins, key=lambda item: (item[0], item[1])):
            out.append(self.source[last:offset])
            out.append(text)
            last = offset
        out.append(self.source[last:])
        return "".join(out)

    def scan_container(self, start, end, class_name):
        i = start
        statement_start = start
        while i < end:
            text = self.t(i)
            if text == ";":
                statement_start = i + 1
                i += 1
                continue
            if text == "}":
                i += 1
                statement_start = i
                continue
            if text == "(":
                close = self.match_close(i)
                after = close + 1
                # C++ constructor initializer list: ") : a(x), b{y} {"
                if self.lang == "cpp" and self.t(after) == ":":
                    body = self.skip_initializers(after + 1)
                    if body is not None:
                        self.instrument_function(statement_start, i, close, body, class_name)
                        i = self.match_close(body) + 1
                        statement_start = i
                        continue
                j = after
                while j < end and (self.t(j) in SUFFIX_QUALIFIERS or self.t(j) == "throws" or self.toks[j].kind == "ident" and self.t(j - 1) in ("throws", ",") and self.lang == "java"):
                    if self.t(j) == "noexcept" and self.t(j + 1) == "(":
                        j = self.match_close(j + 1)
                    j += 1
                if self.t(j) == "->":  # trailing return type
                    j += 1
                    while j < end and self.t(j) not in ("{", ";", "="):
                        j = self.skip_angles(j) if self.t(j) == "<" else j + 1
                        if j is None:
                            break
                if j is not None and self.t(j) == "{":
                    self.instrument_function(statement_start, i, close, j, class_name)
                    i = self.match_close(j) + 1
                    statement_start = i
                    continue
                i = close + 1
                continue
            if text == "{":
                head = [tok.text for tok in self.toks[statement_start:i]]
                keyword = next((w for w in head if w in CONTAINER_KEYWORDS), None)
                close = self.match_close(i)
                if keyword and keyword != "enum" and "=" not in head:
                    name = None
                    if keyword in ("class", "struct", "interface", "record", "union"):
                        k = head.index(keyword)
                        name = head[k + 1] if k + 1 < len(head) else None
                        if name:
                            self.class_names.append(name)
                    self.scan_container(i + 1, close, name if keyword != "namespace" else class_name)
                elif head[:1] == ["extern"]:
                    self.scan_container(i + 1, close, class_name)
                i = close + 1
                # a class body is followed by ';' in C++; enum/initializer bodies are skipped entirely
                statement_start = i
                continue
            i += 1

    def skip_initializers(self, j):
        while j < len(self.toks):
            while j < len(self.toks) and self.t(j) not in ("(", "{"):
                if self.t(j) == "<":
                    j = self.skip_angles(j)
                    if j is None:
                        return None
                    continue
                if self.t(j) in (";", "}"):
                    return None
                j += 1
            if j >= len(self.toks):
                return None
            j = self.match_close(j) + 1
            if self.t(j) == ",":
                j += 1
                continue
            return j if self.t(j) == "{" else None
        return None

    # ---------------- functions ----------------

    def param_names(self, open_i, close_i):
        names = []
        for part in self.split_top(open_i + 1, close_i):
            texts = [self.t(k) for k in part]
            if not texts or texts in (["void"], ["..."]) or "(" in texts:
                continue
            if "=" in texts:
                part = part[:texts.index("=")]
                texts = texts[:texts.index("=")]
            while texts and texts[-1] == "]":
                k = len(texts) - 1
                while k >= 0 and texts[k] != "[":
                    k -= 1
                texts = texts[:k]
            idents = [w for w in texts if re.fullmatch(r"[A-Za-z_$][\w$]*", w) and w not in QUALIFIERS]
            if len(texts) >= 2 and idents and re.fullmatch(r"[A-Za-z_$][\w$]*", texts[-1]):
                names.append(texts[-1])
        return names

    def split_top(self, start, end):
        parts, current, depth = [], [], 0
        k = start
        while k < end:
            text = self.t(k)
            if text in ("(", "[", "{"):
                close = self.match_close(k)
                current.extend(range(k, close + 1))
                k = close + 1
                continue
            if text == "<":
                depth += 1
            elif text == ">":
                depth = max(0, depth - 1)
            elif text == ">>":
                depth = max(0, depth - 2)
            if text == "," and depth == 0:
                parts.append(current)
                current = []
            else:
                current.append(k)
            k += 1
        if current:
            parts.append(current)
        return parts

    def instrument_function(self, head_start, open_i, close_i, body_i, class_name):
        name_tok = self.toks[open_i - 1] if open_i > 0 else None
        if not name_tok or name_tok.kind != "ident" or name_tok.text in CONTROL or name_tok.text in ("sizeof", "decltype", "alignof"):
            return
        head = [self.t(k) for k in range(head_start, open_i)]
        if self.lang == "java" and ("abstract" in head or "native" in head):
            return
        if self.lang == "cpp" and ("constexpr" in head or "consteval" in head):
            return
        name = name_tok.text
        qualified = f"{class_name}.{name}" if class_name and self.lang == "java" else name
        body_end = self.match_close(body_i)
        scope = self.param_names(open_i, close_i)
        self.functions += 1
        line = name_tok.line
        first = body_i + 1
        if self.lang == "cpp":
            self.insert(self.toks[body_i].end, f" __qnb::Frame __qnb_frame(\"{qualified}\", {line});")
        else:
            # A constructor's this(...)/super(...) call must remain the first statement.
            if self.t(first) in ("this", "super") and self.t(first + 1) == "(":
                end = self.match_close(first + 1)
                while self.t(end) != ";":
                    end += 1
                first = end + 1
                anchor = self.toks[end].end
            else:
                anchor = self.toks[body_i].end
            self.insert(anchor, f" __QnbT.enter(\"{qualified}\", {line}); try {{")
            self.insert(self.toks[body_end].start, "} finally { __QnbT.exit(); } ", order=-1)
        self.parse_block_items(first, body_end, list(scope))

    # ---------------- statements ----------------

    def step_text(self, line, scope):
        names = list(dict.fromkeys(reversed(scope)))[::-1][-24:]
        if self.lang == "cpp":
            args = "".join(f", __QNB_V({n})" for n in names)
            return f"__QNB_STEP({line}{args}); "
        args = "".join(f", \"{n}\", {n}" for n in names)
        return f"__QnbT.step({line}{args}); "

    def parse_block_items(self, i, end, scope):
        scope = list(scope)
        case_mark = len(scope)
        while i < end:
            text = self.t(i)
            if text in ("case", "default"):
                # switch label: skip to ':' (or '->' for Java arrow labels)
                j = i
                while j < end and self.t(j) not in (":", "->"):
                    if self.t(j) in ("(", "[", "{"):
                        j = self.match_close(j)
                    j += 1
                # declarations after an earlier label are not definitely assigned here
                del scope[case_mark:]
                i = j + 1
                continue
            if self.toks[i].kind == "ident" and self.t(i + 1) == ":" and text not in CONTROL and self.t(i + 2) != ":":
                i += 2  # goto/break label
                continue
            i, scope = self.parse_statement(i, scope, wrap=False)
        return scope

    def parse_statement(self, i, scope, wrap):
        """Instrument the statement starting at i; returns (index after it, scope after it)."""
        tok = self.toks[i]
        text = tok.text
        if text == "{":
            close = self.match_close(i)
            self.parse_block_items(i + 1, close, scope)
            return close + 1, scope
        if text == ";":
            return i + 1, scope
        prefix = self.step_text(tok.line, scope)
        if wrap:
            self.insert(tok.start, "{ " + prefix)
        else:
            self.insert(tok.start, prefix)

        if text == "if" or (text == "constexpr" and self.t(i - 1) == "if"):
            j = i + 1
            if self.t(j) == "constexpr":
                j += 1
            close = self.match_close(j)
            end, _ = self.parse_statement(close + 1, scope, wrap=self.t(close + 1) != "{")
            if self.t(end) == "else":
                nxt = end + 1
                end, _ = self.parse_statement(nxt, scope, wrap=self.t(nxt) != "{")
        elif text in ("while", "switch"):
            close = self.match_close(i + 1)
            body = close + 1
            if text == "switch":
                body_close = self.match_close(body)
                self.parse_block_items(body + 1, body_close, scope)
                end = body_close + 1
            elif self.t(body) == ";":
                end = body + 1
            else:
                end, _ = self.parse_statement(body, scope, wrap=self.t(body) != "{")
        elif text == "for":
            open_i = i + 1
            close = self.match_close(open_i)
            inner = list(scope) + self.for_header_names(open_i, close)
            body = close + 1
            end = body + 1 if self.t(body) == ";" else self.parse_statement(body, inner, wrap=self.t(body) != "{")[0]
        elif text == "do":
            body_end, _ = self.parse_statement(i + 1, scope, wrap=self.t(i + 1) != "{")
            close = self.match_close(body_end + 1)  # while ( ... )
            end = close + 2
        elif text == "try":
            j = i + 1
            if self.t(j) == "(":  # Java try-with-resources
                resources = self.decl_names_in(j + 1, self.match_close(j), require_init=True)
                j = self.match_close(j) + 1
            else:
                resources = []
            close = self.match_close(j)
            self.parse_block_items(j + 1, close, list(scope) + resources)
            end = close + 1
            while self.t(end) in ("catch", "finally"):
                if self.t(end) == "catch":
                    p_close = self.match_close(end + 1)
                    names = self.param_names(end + 1, p_close)
                    b_close = self.match_close(p_close + 1)
                    self.parse_block_items(p_close + 2, b_close, list(scope) + names)
                    end = b_close + 1
                else:
                    b_close = self.match_close(end + 1)
                    self.parse_block_items(end + 2, b_close, scope)
                    end = b_close + 1
        else:
            end = self.simple_end(i)
            if text not in NOT_DECL_START:
                scope = list(scope) + self.decl_names(i, end - 1)
        if wrap:
            self.insert(self.toks[end - 1].end, " }", order=1)
        return end, scope

    def simple_end(self, i):
        j = i
        while j < len(self.toks):
            text = self.t(j)
            if text in ("(", "[", "{"):
                j = self.match_close(j) + 1
                continue
            if text == ";":
                return j + 1
            if text == "}":
                raise ValueError(f"missing ';' near line {self.toks[j].line}")
            j += 1
        raise ValueError("unterminated statement")

    # ---------------- declarations ----------------

    def for_header_names(self, open_i, close_i):
        # range-for / for-each: "for (T name : expr)"
        depth = 0
        for k in range(open_i + 1, close_i):
            text = self.t(k)
            if text in ("(", "[", "{"):
                depth += 1
            elif text in (")", "]", "}"):
                depth -= 1
            elif text == ":" and depth == 0:
                names = self.declarator_names(open_i + 1, k, require_init=False, allow_no_init=True)
                return names
            elif text == ";" and depth == 0:
                return self.decl_names_in(open_i + 1, k, require_init=self.lang == "java")
        return []

    def decl_names_in(self, start, end, require_init):
        return self.declarator_names(start, end, require_init=require_init, allow_no_init=False)

    def decl_names(self, start, semicolon):
        return self.declarator_names(start, semicolon, require_init=self.lang == "java", allow_no_init=False)

    def declarator_names(self, start, end, require_init, allow_no_init):
        """Names declared by tokens [start, end) or [] when it is not a declaration."""
        k = start
        type_words = CPP_TYPE_WORDS if self.lang == "cpp" else JAVA_TYPE_WORDS
        while k < end and self.t(k) in QUALIFIERS:
            k += 1
        if k >= end or self.toks[k].kind != "ident" or self.t(k) in NOT_DECL_START or self.t(k) in CONTROL:
            return []
        if self.lang == "java" and self.t(k) == "@":
            return []
        base = self.t(k)
        builtin = base in type_words
        k += 1
        while k < end:
            text = self.t(k)
            if text == "::" and k + 1 < end and self.toks[k + 1].kind == "ident":
                k += 2
            elif text == "." and k + 1 < end and self.toks[k + 1].kind == "ident":
                k += 2
            elif text == "<":
                nxt = self.skip_angles(k)
                if nxt is None:
                    return []
                k = nxt
            elif self.toks[k].kind == "ident" and self.t(k) in type_words | {"const", "long", "unsigned", "signed", "short"} and builtin:
                k += 1
            else:
                break
        # pointer/reference/array markers
        while k < end and self.t(k) in ("*", "&", "&&", "const") or (self.t(k) == "[" and self.t(k + 1) == "]"):
            k += 2 if self.t(k) == "[" else 1
        if k >= end:
            return []
        names = []
        # structured binding: auto [a, b] = ...
        if self.lang == "cpp" and self.t(k) == "[" and base == "auto":
            close = self.match_close(k)
            return [self.t(m) for m in range(k + 1, close) if self.toks[m].kind == "ident"]
        if self.toks[k].kind != "ident" or self.t(k) in NOT_DECL_START:
            return []
        follow = self.t(k + 1) if k + 1 < end else ";"
        if k + 1 >= end:
            follow = ";"
        if follow not in ("=", ";", ",", "[", "(", "{", ":"):
            return []
        # remaining declarators separated by top-level commas
        for part in self.split_top(k, end):
            texts = [self.t(m) for m in part]
            while texts and texts[0] in ("*", "&", "&&"):
                texts = texts[1:]
            if not texts or not re.fullmatch(r"[A-Za-z_$][\w$]*", texts[0]):
                continue
            initialised = "=" in texts or (len(texts) > 1 and texts[1] in ("(", "{"))
            if require_init and not initialised and not allow_no_init:
                continue
            if self.lang == "cpp" and not initialised and builtin and not allow_no_init:
                continue  # an uninitialised scalar would only show garbage
            names.append(texts[0])
        return names


def instrument(source, language):
    inst = Instrumenter(source, language)
    out = inst.run()
    if not inst.functions:
        raise ValueError("no function bodies found")
    return out, inst


CPP_RUNTIME = r'''
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <sstream>
#include <iostream>
#include <iterator>
#include <type_traits>
#include <utility>
#include <vector>
#include <memory>
#include <optional>
#include <cxxabi.h>
#include <unistd.h>
namespace __qnb {
static FILE* trace_file = nullptr;
static long steps = 0;
static const long MAX_STEPS = %(max_steps)d;
static long heap_seq = 0;
inline std::string esc(std::string_view s, size_t limit = 120) {
  std::string out = "\"";
  size_t n = 0;
  for (unsigned char c : s) {
    if (++n > limit) { out += "\xe2\x80\xa6"; break; }
    switch (c) {
      case '"': out += "\\\""; break; case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break; case '\t': out += "\\t"; break; case '\r': out += "\\r"; break;
      default: if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%%04x", c); out += b; } else out += (char)c;
    }
  }
  return out + "\"";
}
template <class T> std::string type_name() {
  int status = 0;
  char* d = abi::__cxa_demangle(typeid(T).name(), nullptr, nullptr, &status);
  std::string r = (status == 0 && d) ? d : typeid(T).name();
  std::free(d);
  if (r.rfind("std::__cxx11::basic_string<char", 0) == 0) return "string";
  auto lt = r.find('<'); if (lt != std::string::npos && r.size() > 40) r = r.substr(0, lt) + "<…>";
  if (r.rfind("std::", 0) == 0) r = r.substr(5);
  return r;
}
struct Heap { std::string entries; };
template <class T, class = void> struct is_iterable : std::false_type {};
template <class T> struct is_iterable<T, std::void_t<decltype(std::begin(std::declval<const T&>())), decltype(std::end(std::declval<const T&>()))>> : std::true_type {};
template <class T, class = void> struct is_streamable : std::false_type {};
template <class T> struct is_streamable<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>> : std::true_type {};
template <class T, class = void> struct is_pair_like : std::false_type {};
template <class T> struct is_pair_like<T, std::void_t<decltype(std::declval<const T&>().first), decltype(std::declval<const T&>().second)>> : std::true_type {};
template <class T, class = void> struct has_mapped : std::false_type {};
template <class T> struct has_mapped<T, std::void_t<typename T::mapped_type>> : std::true_type {};
template <class T> std::string show(const T& v, Heap& h, int depth = 0);
template <class T> std::string prim_number(const char* type, const T& v) {
  std::ostringstream os; os.precision(10); os << +v;
  std::string s = os.str();
  if (s == "nan" || s == "inf" || s == "-inf") return std::string("{\"kind\":\"repr\",\"type\":\"") + type + "\",\"text\":\"" + s + "\"}";
  return std::string("{\"kind\":\"prim\",\"type\":\"") + type + "\",\"value\":" + s + "}";
}
template <class T> std::string show(const T& v, Heap& h, int depth) {
  using U = std::remove_cv_t<std::remove_reference_t<T>>;
  if constexpr (std::is_same_v<U, bool>) return std::string("{\"kind\":\"prim\",\"type\":\"bool\",\"value\":") + (v ? "true" : "false") + "}";
  else if constexpr (std::is_same_v<U, char>) return "{\"kind\":\"prim\",\"type\":\"char\",\"value\":" + esc(std::string(1, v)) + "}";
  else if constexpr (std::is_integral_v<U>) return prim_number("int", v);
  else if constexpr (std::is_floating_point_v<U>) return prim_number("float", v);
  else if constexpr (std::is_enum_v<U>) return prim_number("enum", static_cast<std::underlying_type_t<U>>(v));
  else if constexpr (std::is_same_v<U, std::string> || std::is_same_v<U, std::string_view>) return "{\"kind\":\"prim\",\"type\":\"str\",\"value\":" + esc(v) + "}";
  else if constexpr (std::is_same_v<U, const char*> || std::is_same_v<U, char*>) return v ? "{\"kind\":\"prim\",\"type\":\"str\",\"value\":" + esc(v) + "}" : std::string("{\"kind\":\"repr\",\"type\":\"pointer\",\"text\":\"nullptr\"}");
  else if constexpr (std::is_array_v<U> && std::is_same_v<std::remove_cv_t<std::remove_extent_t<U>>, char>) return "{\"kind\":\"prim\",\"type\":\"str\",\"value\":" + esc(v) + "}";
  else if constexpr (std::is_pointer_v<U> || std::is_null_pointer_v<U>) {
    if constexpr (std::is_null_pointer_v<U>) return "{\"kind\":\"repr\",\"type\":\"pointer\",\"text\":\"nullptr\"}";
    else { char b[32]; std::snprintf(b, sizeof b, "%%p", (const void*)v); return std::string("{\"kind\":\"repr\",\"type\":\"pointer\",\"text\":\"") + (v ? b : "nullptr") + "\"}"; }
  }
  else if constexpr (is_pair_like<U>::value) {
    if (depth >= 3) return "{\"kind\":\"repr\",\"type\":\"pair\",\"text\":\"(…)\"}";
    std::string id = "obj_" + std::to_string(++heap_seq);
    std::string a = show(v.first, h, depth + 1), b = show(v.second, h, depth + 1);
    h.entries += (h.entries.empty() ? "" : ",") + esc(id) + ":{\"id\":" + esc(id) + ",\"type\":\"pair\",\"length\":2,\"fields\":[[\"first\"," + a + "],[\"second\"," + b + "]],\"truncated\":false}";
    return "{\"kind\":\"ref\",\"id\":" + esc(id) + "}";
  }
  else if constexpr (is_iterable<U>::value) {
    if (depth >= 3) return "{\"kind\":\"repr\",\"type\":" + esc(type_name<U>()) + ",\"text\":\"[…]\"}";
    std::string id = "obj_" + std::to_string(++heap_seq);
    std::string items; size_t n = 0; bool more = false;
    for (const auto& item : v) {
      if (n >= 12) { more = true; ++n; continue; }
      if constexpr (has_mapped<U>::value) {
        std::ostringstream key;
        if constexpr (is_streamable<std::remove_cv_t<decltype(item.first)>>::value) key << item.first; else key << "?";
        items += (n ? "," : "") + std::string("[") + esc(key.str(), 40) + "," + show(item.second, h, depth + 1) + "]";
      } else {
        items += (n ? "," : "") + show(item, h, depth + 1);
      }
      ++n;
    }
    h.entries += (h.entries.empty() ? "" : ",") + esc(id) + ":{\"id\":" + esc(id) + ",\"type\":" + esc(type_name<U>()) + ",\"length\":" + std::to_string(n) + (has_mapped<U>::value ? ",\"fields\":[" : ",\"items\":[") + items + "],\"truncated\":" + (more ? "true" : "false") + "}";
    return "{\"kind\":\"ref\",\"id\":" + esc(id) + "}";
  }
  else if constexpr (is_streamable<U>::value) { std::ostringstream os; os << v; return "{\"kind\":\"repr\",\"type\":" + esc(type_name<U>()) + ",\"text\":" + esc(os.str()) + "}"; }
  else return "{\"kind\":\"repr\",\"type\":" + esc(type_name<U>()) + ",\"text\":" + esc("<" + type_name<U>() + ">") + "}";
}
struct Var { const char* name; std::string value; std::string heap; };
template <class T> Var var(const char* name, const T& v) { Heap h; std::string s = show(v, h); return Var{name, s, h.entries}; }
struct Frame;
static Frame* top = nullptr;
static long output_offset() {
  std::fflush(stdout); std::cout.flush();
  off_t off = lseek(1, 0, SEEK_CUR);
  return off < 0 ? 0 : (long)off;
}
static bool open_trace() {
  if (!trace_file) { const char* p = std::getenv("QNB_TRACE"); if (!p) return false; trace_file = std::fopen(p, "w"); }
  return trace_file != nullptr;
}
static void guard() {
  if (steps == MAX_STEPS * 40) { std::fflush(stdout); std::fprintf(stderr, "\n[QNB] 실행 단계가 너무 많아 중단했습니다.\n"); std::_Exit(124); }
}
struct Frame {
  const char* func; int line; Frame* parent; std::string locals = "{}"; std::string heap;
  Frame(const char* f, int l) : func(f), line(l), parent(top) { top = this; emit("call", l, nullptr, 0); }
  ~Frame() { emit("return", line, nullptr, 0); top = parent; }
  static void emit(const char* event, int line, const Var* vars, size_t count) {
    ++steps; guard();
    if (steps > MAX_STEPS || !open_trace()) return;
    if (vars && top) {
      std::string locals = "{"; std::string heap;
      for (size_t i = 0; i < count; ++i) {
        locals += (i ? "," : "") + esc(vars[i].name) + ":" + vars[i].value;
        if (!vars[i].heap.empty()) heap += (heap.empty() ? "" : ",") + vars[i].heap;
      }
      top->locals = locals + "}"; top->heap = heap; top->line = line;
    }
    std::string stack, heap;
    std::vector<Frame*> chain; for (Frame* f = top; f; f = f->parent) chain.push_back(f);
    for (size_t i = chain.size(); i-- > 0;) {
      Frame* f = chain[i];
      stack += std::string(stack.empty() ? "" : ",") + "{\"func\":" + esc(f->func) + ",\"line\":" + std::to_string(f->line) + ",\"locals\":" + f->locals + "}";
      if (!f->heap.empty()) heap += (heap.empty() ? "" : ",") + f->heap;
    }
    std::fprintf(trace_file, "{\"event\":\"%%s\",\"line\":%%d,\"func\":%%s,\"stack\":[%%s],\"heap\":{%%s},\"out\":%%ld}\n",
                 event, line, esc(top ? top->func : "?").c_str(), stack.c_str(), heap.c_str(), output_offset());
    std::fflush(trace_file);
  }
};
inline void step(int line, std::initializer_list<Var> vars) { Frame::emit("line", line, vars.begin(), vars.size()); }
}
#define __QNB_V(name) ::__qnb::var(#name, name)
#define __QNB_STEP(line, ...) ::__qnb::step(line, {__VA_ARGS__})
#line 1
'''

JAVA_RUNTIME = r'''
final class __QnbT {
  static final int MAX_STEPS = %(max_steps)d;
  static long steps = 0, outBytes = 0; static int seq = 0;
  static java.io.PrintWriter trace;
  static final java.util.ArrayDeque<Object[]> stack = new java.util.ArrayDeque<>();
  static {
    final java.io.OutputStream base = new java.io.FileOutputStream(java.io.FileDescriptor.out);
    System.setOut(new java.io.PrintStream(new java.io.OutputStream() {
      public void write(int b) throws java.io.IOException { base.write(b); outBytes++; }
      public void write(byte[] b, int o, int n) throws java.io.IOException { base.write(b, o, n); outBytes += n; }
      public void flush() throws java.io.IOException { base.flush(); }
    }, true, java.nio.charset.StandardCharsets.UTF_8));
    try { String p = System.getenv("QNB_TRACE"); if (p != null) trace = new java.io.PrintWriter(new java.io.OutputStreamWriter(new java.io.FileOutputStream(p), java.nio.charset.StandardCharsets.UTF_8)); } catch (Exception e) { trace = null; }
  }
  static String esc(String s, int limit) {
    StringBuilder b = new StringBuilder("\""); int n = 0;
    for (int i = 0; i < s.length(); i++) { char c = s.charAt(i);
      if (++n > limit) { b.append('…'); break; }
      switch (c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break;
        default: if (c < 0x20) b.append(String.format("\\u%%04x", (int) c)); else b.append(c); } }
    return b.append('"').toString();
  }
  static String esc(String s) { return esc(s, 120); }
  static String show(Object v, StringBuilder heap, java.util.IdentityHashMap<Object, String> seen, int depth) {
    if (v == null) return "{\"kind\":\"repr\",\"type\":\"null\",\"text\":\"null\"}";
    if (v instanceof Boolean) return "{\"kind\":\"prim\",\"type\":\"bool\",\"value\":" + v + "}";
    if (v instanceof Character) return "{\"kind\":\"prim\",\"type\":\"char\",\"value\":" + esc(v.toString()) + "}";
    if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) return "{\"kind\":\"prim\",\"type\":\"int\",\"value\":" + v + "}";
    if (v instanceof Double || v instanceof Float) { double d = ((Number) v).doubleValue(); if (Double.isNaN(d) || Double.isInfinite(d)) return "{\"kind\":\"repr\",\"type\":\"float\",\"text\":\"" + d + "\"}"; return "{\"kind\":\"prim\",\"type\":\"float\",\"value\":" + v + "}"; }
    if (v instanceof CharSequence) return "{\"kind\":\"prim\",\"type\":\"str\",\"value\":" + esc(v.toString()) + "}";
    if (v instanceof Number || v instanceof Enum) return "{\"kind\":\"repr\",\"type\":" + esc(v.getClass().getSimpleName()) + ",\"text\":" + esc(String.valueOf(v)) + "}";
    String known = seen.get(v);
    if (known != null) return "{\"kind\":\"ref\",\"id\":" + esc(known) + "}";
    if (depth >= 3) return "{\"kind\":\"repr\",\"type\":" + esc(v.getClass().getSimpleName()) + ",\"text\":\"…\"}";
    String id = "obj_" + (++seq); seen.put(v, id);
    StringBuilder items = new StringBuilder(); int n = 0; boolean more = false; boolean fields = false;
    if (v.getClass().isArray()) {
      int len = java.lang.reflect.Array.getLength(v);
      for (int i = 0; i < len; i++) { if (n >= 12) { more = true; break; } items.append(n++ > 0 ? "," : "").append(show(java.lang.reflect.Array.get(v, i), heap, seen, depth + 1)); }
      n = len;
    } else if (v instanceof java.util.Map) {
      fields = true; int len = 0;
      for (Object e : ((java.util.Map<?, ?>) v).entrySet()) { java.util.Map.Entry<?, ?> en = (java.util.Map.Entry<?, ?>) e; if (len++ >= 12) { more = true; continue; } items.append(len > 1 ? "," : "").append("[").append(esc(String.valueOf(en.getKey()), 40)).append(",").append(show(en.getValue(), heap, seen, depth + 1)).append("]"); }
      n = len;
    } else if (v instanceof Iterable) {
      int len = 0;
      for (Object item : (Iterable<?>) v) { if (len++ >= 12) { more = true; continue; } items.append(len > 1 ? "," : "").append(show(item, heap, seen, depth + 1)); }
      n = len;
    } else {
      fields = true;
      for (Class<?> c = v.getClass(); c != null && c != Object.class && n < 12; c = c.getSuperclass()) {
        for (java.lang.reflect.Field f : c.getDeclaredFields()) {
          if (java.lang.reflect.Modifier.isStatic(f.getModifiers()) || f.isSynthetic()) continue;
          Object fv; try { f.setAccessible(true); fv = f.get(v); } catch (Exception e) { continue; }
          if (n >= 12) { more = true; break; }
          items.append(n++ > 0 ? "," : "").append("[").append(esc(f.getName(), 40)).append(",").append(show(fv, heap, seen, depth + 1)).append("]");
        }
      }
    }
    String type = v.getClass().isArray() ? v.getClass().getComponentType().getSimpleName() + "[]" : v.getClass().getSimpleName();
    heap.append(heap.length() > 0 ? "," : "").append(esc(id)).append(":{\"id\":").append(esc(id)).append(",\"type\":").append(esc(type)).append(",\"length\":").append(n)
        .append(fields ? ",\"fields\":[" : ",\"items\":[").append(items).append("],\"truncated\":").append(more).append("}");
    return "{\"kind\":\"ref\",\"id\":" + esc(id) + "}";
  }
  static void guard() { if (steps == (long) MAX_STEPS * 40) { System.out.flush(); System.err.println("\n[QNB] 실행 단계가 너무 많아 중단했습니다."); Runtime.getRuntime().halt(124); } }
  static void emit(String event, int line) {
    steps++; guard();
    if (steps > MAX_STEPS || trace == null) return;
    StringBuilder st = new StringBuilder(), heap = new StringBuilder();
    java.util.Iterator<Object[]> it = stack.descendingIterator();
    while (it.hasNext()) { Object[] f = it.next();
      st.append(st.length() > 0 ? "," : "").append("{\"func\":").append(esc((String) f[0])).append(",\"line\":").append(f[1]).append(",\"locals\":").append(f[2]).append("}");
      if (((String) f[3]).length() > 0) heap.append(heap.length() > 0 ? "," : "").append(f[3]); }
    System.out.flush();
    String func = stack.isEmpty() ? "?" : (String) stack.peek()[0];
    trace.println("{\"event\":\"" + event + "\",\"line\":" + line + ",\"func\":" + esc(func) + ",\"stack\":[" + st + "],\"heap\":{" + heap + "},\"out\":" + outBytes + "}");
    trace.flush();
  }
  static void enter(String func, int line) { stack.push(new Object[]{func, line, "{}", ""}); emit("call", line); }
  static void exit() { Object[] f = stack.peek(); emit("return", f == null ? 0 : (Integer) f[1]); stack.poll(); }
  static void step(int line, Object... kv) {
    Object[] f = stack.peek();
    if (f != null && steps < MAX_STEPS) {
      StringBuilder locals = new StringBuilder("{"), heap = new StringBuilder();
      java.util.IdentityHashMap<Object, String> seen = new java.util.IdentityHashMap<>();
      for (int i = 0; i + 1 < kv.length; i += 2) locals.append(i > 0 ? "," : "").append(esc((String) kv[i])).append(":").append(show(kv[i + 1], heap, seen, 0));
      f[1] = line; f[2] = locals.append("}").toString(); f[3] = heap.toString();
    }
    emit("line", line);
  }
}
'''

RUNNER = r'''
import base64, json, os, re, shutil, subprocess, tempfile
cfg = json.loads(base64.b64decode(%(cfg)r).decode())
lang = cfg["language"]
work = tempfile.mkdtemp(prefix="qnb-step-")
result = {"exitCode": 1, "stdout": "", "stderr": "", "trace": [], "traced": False, "note": ""}
def clip(text, n=20000):
    return text if len(text) <= n else text[:n] + "\n…(생략)"
def compile_cpp(src, name):
    path = os.path.join(work, name + ".cpp")
    open(path, "w", encoding="utf-8").write(src)
    if not shutil.which("g++"):
        return None, "VM에 g++ 컴파일러가 없습니다."
    p = subprocess.run(["g++", "-std=c++17", "-O0", "-w", "-o", os.path.join(work, name), path], capture_output=True, text=True, timeout=60)
    return (os.path.join(work, name) if p.returncode == 0 else None), p.stderr.replace(path, cfg["display"])
def compile_java(src, name, cls):
    d = os.path.join(work, name); os.makedirs(d)
    path = os.path.join(d, cls + ".java")
    open(path, "w", encoding="utf-8").write(src)
    if not shutil.which("javac"):
        return None, "VM에 JDK(javac)가 설치되어 있지 않습니다. Java 단계 실행을 하려면 VM 이미지에 JDK를 추가하세요."
    p = subprocess.run(["javac", "-encoding", "UTF-8", "-nowarn", "-d", d, path], capture_output=True, text=True, timeout=90)
    return (d if p.returncode == 0 else None), p.stderr.replace(path, cfg["display"])
def run(cmd, trace):
    out_path = os.path.join(work, "stdout.txt")
    env = dict(os.environ)
    if trace:
        env["QNB_TRACE"] = os.path.join(work, "trace.jsonl")
    with open(out_path, "wb") as out:
        try:
            p = subprocess.run(["timeout", str(cfg["timeout"])] + cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.PIPE, env=env, cwd=cfg["cwd"] if os.path.isdir(cfg["cwd"]) else work, timeout=cfg["timeout"] + 5)
            code, err = p.returncode, p.stderr.decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            code, err = 124, ""
    if code == 124 and "[QNB]" not in err:
        err += "\n[QNB] 실행 시간 제한(%%d초)을 초과했습니다." %% cfg["timeout"]
    raw = open(out_path, "rb").read()
    return code, raw, err
try:
    if lang == "cpp":
        exe, err = compile_cpp(cfg["instrumented"], "traced") if cfg.get("instrumented") else (None, "")
        cmd_traced = [exe] if exe else None
        if not exe:
            exe2, err2 = compile_cpp(cfg["source"], "plain")
            if not exe2:
                result["stderr"] = clip(err2); result["note"] = "compile"
                raise SystemExit
            cmd_plain = [exe2]
    else:
        exe, err = compile_java(cfg["instrumented"], "traced", cfg["className"]) if cfg.get("instrumented") else (None, "")
        cmd_traced = ["java", "-Xss16m", "-cp", exe, cfg["mainClass"]] if exe else None
        if not exe:
            if "javac" in err and "설치" in err:
                result["stderr"] = err; result["note"] = "nojdk"; raise SystemExit
            exe2, err2 = compile_java(cfg["source"], "plain", cfg["className"])
            if not exe2:
                result["stderr"] = clip(err2); result["note"] = "compile"
                raise SystemExit
            cmd_plain = ["java", "-cp", exe2, cfg["mainClass"]]
    if cmd_traced:
        code, raw, err = run(cmd_traced, True)
        result["traced"] = True
        tpath = os.path.join(work, "trace.jsonl")
        if os.path.exists(tpath):
            with open(tpath, encoding="utf-8", errors="replace") as fp:
                for line in fp:
                    try:
                        result["trace"].append(json.loads(line))
                    except ValueError:
                        break
    else:
        code, raw, err = run(cmd_plain, False)
        result["note"] = "untraced"
    result["exitCode"] = code
    result["stdout"] = clip(raw.decode("utf-8", "replace"))
    result["stdoutBytes"] = base64.b64encode(raw[:200000]).decode()
    result["stderr"] = clip(err)
except SystemExit:
    pass
finally:
    shutil.rmtree(work, ignore_errors=True)
print(json.dumps(result, ensure_ascii=True))
'''

JAVA_CLASS = re.compile(r"\bpublic\s+(?:(?:final|abstract|sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)")
JAVA_MAIN_OWNER = re.compile(r"\b(?:class|record|enum|interface)\s+([A-Za-z_$][\w$]*)[^{]*\{")


def _java_names(source, file_path):
    match = JAVA_CLASS.search(source)
    class_name = match.group(1) if match else re.sub(r"\W", "_", file_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]) or "Main"
    main_class = class_name
    main = re.search(r"static\s+(?:final\s+)?void\s+main\s*\(", source)
    if main:
        owners = [m for m in JAVA_MAIN_OWNER.finditer(source) if m.start() < main.start()]
        if owners:
            main_class = owners[-1].group(1)
    return class_name, main_class


def explain(event, func, line, code):
    if event == "call":
        return f"함수 {func}() 호출 진입"
    if event == "return":
        return f"{func}() 실행을 마치고 반환합니다"
    snippet = code.strip()
    return f"{line}행 실행: {snippet[:64]}" if snippet else f"{line}행 실행"


def trace(vm_id, file_path, code, language):
    if language not in ("cpp", "java"):
        raise RequestError("C++ 또는 Java 파일만 단계 실행할 수 있습니다.")
    display = file_path.rsplit("/", 1)[-1]
    note = ""
    try:
        instrumented, _ = instrument(code, language)
        runtime_src = (CPP_RUNTIME if language == "cpp" else JAVA_RUNTIME) % {"max_steps": MAX_STEPS}
        if language == "cpp":
            instrumented = runtime_src + instrumented
        else:
            instrumented = instrumented + "\n" + runtime_src.replace("\n", " ")
    except (ValueError, IndexError) as error:
        instrumented = None
        note = f"코드 구조를 분석하지 못해 단계 추적 없이 실행합니다 ({error})."
    class_name, main_class = _java_names(code, file_path) if language == "java" else ("", "")
    cfg = {
        "language": language, "source": code, "instrumented": instrumented, "display": display,
        "className": class_name, "mainClass": main_class, "timeout": RUN_TIMEOUT,
        "cwd": "/workspace" + (file_path.rsplit("/", 1)[0] or ""),
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
    return build_result(data, code, file_path, language, note)


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


def build_result(data, code, file_path, language, note=""):
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
        heap = item.get("heap", {})
        if language == "cpp":
            for entry in heap.values():
                entry["type"] = pretty_type(entry.get("type", ""))
        steps.append({
            "index": index, "event": item.get("event", "line"), "file": file_path, "func": item.get("func", "?"),
            "line": line, "code": text, "explain": explain(item.get("event"), item.get("func"), line, text),
            "stack": stack, "heap": heap, "stdout": out, "returnValue": None, "error": None,
        })
    exit_code = data.get("exitCode", 1)
    if steps and exit_code not in (0, None):
        steps[-1]["error"] = f"종료 코드 {exit_code}"
    outputs = []
    if data.get("stdout"):
        outputs.append({"output_type": "stream", "name": "stdout", "text": data["stdout"]})
    messages = {
        "untraced": "※ 단계 추적 계측을 적용하지 못해 일반 실행 결과만 표시합니다.",
        "compile": "컴파일 오류",
    }
    stderr = data.get("stderr", "")
    if data.get("note") == "untraced":
        stderr = (note or messages["untraced"]) + ("\n" + stderr if stderr else "")
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
