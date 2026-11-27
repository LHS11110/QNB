"""Python, C++, Java 소스의 파일·함수·변수 단위 의존성 그래프 분석기.

Python은 표준 ``ast`` 모듈로 정확하게 분석하고, C++과 Java는 주석과 문자열을
제거한 뒤 중괄호 구조와 토큰 패턴으로 선언과 참조를 추정한다. 외부 파서에
의존하지 않으므로 VM에서 읽어 온 텍스트만으로 동작한다.
"""

import ast
import posixpath
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

LANGUAGES = {
    ".py": "python",
    ".lean": "lean4",
    ".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp",
    ".h": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".h++": "cpp", ".ipp": "cpp", ".tpp": "cpp",
    ".java": "java",
}
HEADER_SUFFIXES = (".h", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".tpp")
SKIP_DIRECTORIES = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache",
    ".pytest_cache", ".tox", ".lake", "build", "dist", "target", "out", ".gradle", ".idea",
    "cmake-build-debug", "cmake-build-release", ".ipynb_checkpoints",
}
MAX_FILES = 400
MAX_BYTES = 4 * 1024 * 1024
MAX_NODES = 2500
MAX_EDGES = 12000
MAX_DIRECTORIES = 2000

EDGE_KINDS = ("imports", "contains", "calls", "reads", "writes", "inherits")


def language_of(path):
    return LANGUAGES.get(posixpath.splitext(path)[1].lower())


class Graph:
    def __init__(self):
        self.nodes = {}
        self.edges = {}

    def node(self, node_id, kind, name, path, line=None, language=None, qualname=None, **extra):
        existing = self.nodes.get(node_id)
        if existing:
            # C++ 선언 뒤에 정의가 나오면 정의 위치를 우선한다.
            if extra.get("defined") and not existing.get("defined"):
                existing.update(path=path, line=line, defined=True)
            return existing
        record = {"id": node_id, "kind": kind, "name": name, "qualname": qualname or name,
                  "path": path, "line": line, "language": language}
        record.update(extra)
        self.nodes[node_id] = record
        return record

    def edge(self, source, target, kind, line=None):
        if not source or not target or source == target:
            return
        key = (source, target, kind)
        record = self.edges.get(key)
        if record:
            record["count"] += 1
            return
        self.edges[key] = {"from": source, "to": target, "kind": kind, "count": 1, "line": line}


def file_id(path):
    return "file:" + path


def symbol_id(kind, path, qualname):
    return f"{kind}:{path}:{qualname}"


# --------------------------------------------------------------------------- Python


def python_modules(paths):
    """모듈 이름 → 후보 파일 목록. 모든 상위 디렉터리를 패키지 루트 후보로 본다."""
    modules = defaultdict(list)
    for path in paths:
        parts = path.strip("/").split("/")
        stem = parts[-1][:-3]
        names = parts[:-1] + ([] if stem == "__init__" else [stem])
        for start in range(len(names)):
            if names[start:]:
                modules[".".join(names[start:])].append(path)
    return modules


def closest(candidates, origin):
    if not candidates:
        return None
    directory = posixpath.dirname(origin)

    def shared(path):
        return len(posixpath.commonpath([directory, posixpath.dirname(path)]))
    return max(candidates, key=lambda path: (shared(path), -len(path)))


class PythonFile:
    def __init__(self, path, tree):
        self.path = path
        self.tree = tree
        self.symbols = {}   # 모듈 수준 이름 → 노드 id
        self.classes = {}   # 클래스 이름 → {"id":..., "members": {name: id}}
        self.bindings = {}  # import로 생긴 이름 → ("file", path) | ("symbol", path, name)


class PythonAnalyzer:
    def __init__(self, graph, files, errors):
        self.graph = graph
        self.errors = errors
        self.files = {path: PythonFile(path, tree) for path, tree in files.items()}
        self.modules = python_modules(list(self.files))

    def run(self):
        for phase in (self.declare, self.imports, self.references):
            for unit in self.files.values():
                try:
                    phase(unit)
                except RecursionError:
                    self.errors.append({"path": unit.path, "message": "중첩이 너무 깊어 일부 참조를 건너뛰었습니다.",
                                        "line": None})

    def declare(self, unit):
        graph, path = self.graph, unit.path
        fid = file_id(path)

        def add_variable(name, line, owner_id, qualname):
            node_id = symbol_id("variable", path, qualname)
            graph.node(node_id, "variable", name, path, line, "python", qualname)
            graph.edge(owner_id, node_id, "contains", line)
            return node_id

        for statement in unit.tree.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                node_id = symbol_id("function", path, statement.name)
                graph.node(node_id, "function", statement.name, path, statement.lineno, "python")
                graph.edge(fid, node_id, "contains", statement.lineno)
                unit.symbols[statement.name] = node_id
            elif isinstance(statement, ast.ClassDef):
                class_id = symbol_id("class", path, statement.name)
                graph.node(class_id, "class", statement.name, path, statement.lineno, "python")
                graph.edge(fid, class_id, "contains", statement.lineno)
                unit.symbols[statement.name] = class_id
                members = {}
                for item in statement.body:
                    qualname = None
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        qualname = f"{statement.name}.{item.name}"
                        node_id = symbol_id("function", path, qualname)
                        graph.node(node_id, "function", item.name, path, item.lineno, "python", qualname)
                        graph.edge(class_id, node_id, "contains", item.lineno)
                        members[item.name] = node_id
                    else:
                        for name, line in assigned_names(item):
                            members[name] = add_variable(name, line, class_id, f"{statement.name}.{name}")
                for item in ast.walk(statement):
                    # self.x = ... 로 생성되는 인스턴스 필드
                    if isinstance(item, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                        targets = item.targets if isinstance(item, ast.Assign) else [item.target]
                        for target in targets:
                            for sub in ast.walk(target):
                                if (isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name)
                                        and sub.value.id == "self" and sub.attr not in members):
                                    members[sub.attr] = add_variable(
                                        sub.attr, sub.lineno, class_id, f"{statement.name}.{sub.attr}")
                unit.classes[statement.name] = {"id": class_id, "members": members}
            else:
                for name, line in assigned_names(statement):
                    if name not in unit.symbols:
                        unit.symbols[name] = add_variable(name, line, fid, name)

    def resolve_module(self, unit, module, level):
        if level:
            base = posixpath.dirname(unit.path)
            for _ in range(level - 1):
                base = posixpath.dirname(base)
            target = posixpath.join(base, *module.split(".")) if module else base
            for candidate in (target + ".py", posixpath.join(target, "__init__.py")):
                if candidate in self.files:
                    return candidate
            return None
        return closest(self.modules.get(module, []), unit.path)

    def imports(self, unit):
        fid = file_id(unit.path)
        for statement in ast.walk(unit.tree):
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    target = self.resolve_module(unit, alias.name, 0)
                    if target:
                        self.graph.edge(fid, file_id(target), "imports", statement.lineno)
                        if alias.asname:
                            unit.bindings[alias.asname] = ("file", target)
                        elif "." not in alias.name:
                            unit.bindings[alias.name] = ("file", target)
                        else:
                            unit.bindings.setdefault(alias.name.split(".")[0], ("dotted", alias.name))
            elif isinstance(statement, ast.ImportFrom):
                module = statement.module or ""
                source = self.resolve_module(unit, module, statement.level)
                for alias in statement.names:
                    local = alias.asname or alias.name
                    submodule = self.resolve_module(
                        unit, (module + "." if module else "") + alias.name, statement.level)
                    if submodule:
                        self.graph.edge(fid, file_id(submodule), "imports", statement.lineno)
                        unit.bindings[local] = ("file", submodule)
                    elif source:
                        self.graph.edge(fid, file_id(source), "imports", statement.lineno)
                        if alias.name != "*":
                            unit.bindings[local] = ("symbol", source, alias.name)
                if source and any(alias.name == "*" for alias in statement.names):
                    for name in self.files[source].symbols:
                        if not name.startswith("_"):
                            unit.bindings.setdefault(name, ("symbol", source, name))

    def lookup_file_symbol(self, path, name, depth=0):
        unit = self.files.get(path)
        if not unit or depth > 4:
            return None
        if name in unit.symbols:
            return unit.symbols[name]
        binding = unit.bindings.get(name)
        if binding and binding[0] == "symbol":
            return self.lookup_file_symbol(binding[1], binding[2], depth + 1)
        if binding and binding[0] == "file":
            return file_id(binding[1])
        return None

    def resolve_name(self, unit, name):
        if name in unit.symbols:
            return unit.symbols[name]
        binding = unit.bindings.get(name)
        if not binding:
            return None
        if binding[0] == "file":
            return file_id(binding[1])
        if binding[0] == "symbol":
            return self.lookup_file_symbol(binding[1], binding[2])
        return None

    def class_member(self, class_id, member):
        _, path, name = class_id.split(":", 2)
        unit = self.files.get(path)
        info = unit and unit.classes.get(name)
        return info["members"].get(member) if info else None

    def resolve_attribute(self, unit, node, scope_class):
        """a.b, self.b, mod.func 형태의 참조 대상을 찾는다."""
        if isinstance(node.value, ast.Name):
            base = node.value.id
            if base in ("self", "cls") and scope_class:
                return unit.classes[scope_class]["members"].get(node.attr)
            target = self.resolve_name(unit, base)
            if target and target.startswith("file:"):
                return self.lookup_file_symbol(target[5:], node.attr)
            if target and target.startswith("class:"):
                return self.class_member(target, node.attr)
            binding = unit.bindings.get(base)
            if binding and binding[0] == "dotted":
                dotted = dotted_name(node)
                if dotted:
                    parts = dotted.split(".")
                    for cut in range(len(parts) - 1, 0, -1):
                        module = self.resolve_module(unit, ".".join(parts[:cut]), 0)
                        if module:
                            if cut == len(parts) - 1:
                                return self.lookup_file_symbol(module, parts[-1]) or file_id(module)
                            return file_id(module)
        elif isinstance(node.value, ast.Attribute):
            dotted = dotted_name(node)
            if dotted:
                parts = dotted.split(".")
                for cut in range(len(parts) - 1, 0, -1):
                    module = self.resolve_module(unit, ".".join(parts[:cut]), 0)
                    if module and cut == len(parts) - 1:
                        return self.lookup_file_symbol(module, parts[-1])
        return None

    def unique_method(self, name):
        """obj.method() 에서 obj 타입을 모를 때, 프로젝트에서 유일한 메서드 이름이면 연결한다."""
        if name.startswith("__"):
            return None
        if not hasattr(self, "_methods"):
            self._methods = defaultdict(list)
            for unit in self.files.values():
                for info in unit.classes.values():
                    for member, node_id in info["members"].items():
                        if node_id.startswith("function:"):
                            self._methods[member].append(node_id)
        options = self._methods.get(name, [])
        return options[0] if len(options) == 1 else None

    def references(self, unit):
        analyzer = self

        class Visitor(ast.NodeVisitor):
            def __init__(self):
                self.owner = [file_id(unit.path)]
                self.locals = [set()]
                self.globals = [set()]
                self.klass = [None]

            def link(self, target, kind, line):
                if not target:
                    return
                owner = self.owner[-1]
                if kind == "writes" and owner.startswith("file:") and len(self.owner) == 1 \
                        and target.startswith(f"variable:{unit.path}:"):
                    return  # 모듈 수준 정의 자체는 contains 간선으로 충분하다.
                analyzer.graph.edge(owner, target, kind, line)

            def enter_function(self, node, node_id, class_name):
                arguments = node.args
                names = {arg.arg for arg in arguments.posonlyargs + arguments.args + arguments.kwonlyargs}
                if arguments.vararg:
                    names.add(arguments.vararg.arg)
                if arguments.kwarg:
                    names.add(arguments.kwarg.arg)
                declared_global = set()
                for sub in walk_scope(node):
                    if isinstance(sub, (ast.Global, ast.Nonlocal)):
                        declared_global.update(sub.names)
                    elif isinstance(sub, ast.Name) and isinstance(sub.ctx, (ast.Store, ast.Del)):
                        names.add(sub.id)
                    elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        names.add(sub.name)
                    elif isinstance(sub, (ast.Import, ast.ImportFrom)):
                        names.update((alias.asname or alias.name).split(".")[0] for alias in sub.names)
                names -= declared_global
                for decorator in node.decorator_list:
                    self.visit(decorator)
                for default in arguments.defaults + [d for d in arguments.kw_defaults if d]:
                    self.visit(default)
                self.owner.append(node_id or self.owner[-1])
                self.locals.append(names | (self.locals[-1] if not node_id else set()))
                self.globals.append(declared_global)
                self.klass.append(class_name)
                for statement in node.body:
                    self.visit(statement)
                self.owner.pop()
                self.locals.pop()
                self.globals.pop()
                self.klass.pop()

            def visit_FunctionDef(self, node):
                class_name = self.klass[-1]
                node_id = None
                if len(self.owner) == 1:
                    node_id = unit.symbols.get(node.name)
                elif class_name and self.owner[-1] == unit.classes[class_name]["id"]:
                    node_id = unit.classes[class_name]["members"].get(node.name)
                self.enter_function(node, node_id, class_name)

            visit_AsyncFunctionDef = visit_FunctionDef

            def visit_Lambda(self, node):
                arguments = node.args
                names = {arg.arg for arg in arguments.posonlyargs + arguments.args + arguments.kwonlyargs}
                self.locals.append(self.locals[-1] | names)
                self.visit(node.body)
                self.locals.pop()

            def visit_ClassDef(self, node):
                info = unit.classes.get(node.name) if len(self.owner) == 1 else None
                for base in node.bases:
                    target = self.expression_target(base)
                    if info and target:
                        analyzer.graph.edge(info["id"], target, "inherits", node.lineno)
                    else:
                        self.visit(base)
                for decorator in node.decorator_list:
                    self.visit(decorator)
                self.owner.append(info["id"] if info else self.owner[-1])
                self.klass.append(node.name if info else self.klass[-1])
                self.locals.append(set())
                for statement in node.body:
                    self.visit(statement)
                self.locals.pop()
                self.klass.pop()
                self.owner.pop()

            def expression_target(self, node):
                if isinstance(node, ast.Name):
                    return self.resolve(node.id)
                if isinstance(node, ast.Attribute):
                    return analyzer.resolve_attribute(unit, node, self.klass[-1])
                return None

            def resolve(self, name):
                if name in self.locals[-1] and name not in self.globals[-1]:
                    return None
                return analyzer.resolve_name(unit, name)

            def visit_Call(self, node):
                target = self.expression_target(node.func)
                if target is None and isinstance(node.func, ast.Attribute):
                    target = analyzer.unique_method(node.func.attr)
                if target and not target.startswith("file:"):
                    self.link(target, "calls", node.lineno)
                    if isinstance(node.func, ast.Attribute):
                        self.visit(node.func.value)
                else:
                    self.visit(node.func)
                for argument in node.args + [keyword.value for keyword in node.keywords]:
                    self.visit(argument)

            def visit_Name(self, node):
                target = self.resolve(node.id)
                if target and not target.startswith("file:"):
                    kind = "writes" if isinstance(node.ctx, (ast.Store, ast.Del)) else "reads"
                    self.link(target, kind, node.lineno)

            def visit_AugAssign(self, node):
                target = self.expression_target(node.target)
                if target and not target.startswith("file:"):
                    self.link(target, "reads", node.lineno)
                self.generic_visit(node)

            def visit_Attribute(self, node):
                target = analyzer.resolve_attribute(unit, node, self.klass[-1])
                if target and not target.startswith("file:"):
                    kind = "writes" if isinstance(node.ctx, (ast.Store, ast.Del)) else "reads"
                    self.link(target, kind, node.lineno)
                    if not isinstance(node.value, ast.Name):
                        self.visit(node.value)
                else:
                    self.visit(node.value)

            def visit_Import(self, node):
                pass

            visit_ImportFrom = visit_Import

        Visitor().visit(unit.tree)


def walk_scope(node):
    """중첩 함수/클래스 내부로 들어가지 않고 현재 스코프의 노드만 순회한다."""
    pending = list(ast.iter_child_nodes(node))
    while pending:
        item = pending.pop()
        yield item
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            pending.extend(ast.iter_child_nodes(item))


def assigned_names(statement):
    targets = []
    if isinstance(statement, ast.Assign):
        targets = statement.targets
    elif isinstance(statement, (ast.AnnAssign, ast.AugAssign)):
        targets = [statement.target]
    elif isinstance(statement, (ast.If, ast.Try, ast.With)):
        result = []
        for block in ("body", "orelse", "finalbody"):
            for item in getattr(statement, block, []) or []:
                result.extend(assigned_names(item))
        for handler in getattr(statement, "handlers", []) or []:
            for item in handler.body:
                result.extend(assigned_names(item))
        return result
    result = []
    for target in targets:
        for sub in ast.walk(target):
            if isinstance(sub, ast.Name):
                result.append((sub.id, sub.lineno))
    return result


def dotted_name(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


# --------------------------------------------------------------------------- C++ / Java

TOKEN = re.compile(r"""
    (?P<ident>[A-Za-z_$][A-Za-z0-9_$]*)
  | (?P<number>\.?\d[\w.']*)
  | (?P<op>::|->|\+\+|--|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|/=|%=|&=|\|=|\^=|\.\.\.|[{}()\[\];,.<>=+\-*/%&|^!~?:@\#])
""", re.VERBOSE)

CONTROL = {"if", "for", "while", "switch", "catch", "do", "else", "try", "return", "sizeof", "alignof",
           "decltype", "synchronized", "typeid", "static_assert", "new", "delete", "throw", "case",
           "assert", "noexcept", "requires", "co_return", "co_await", "co_yield", "operator"}
CPP_KEYWORDS = {
    "alignas", "auto", "bool", "break", "char", "char8_t", "char16_t", "char32_t", "class", "const", "consteval",
    "constexpr", "constinit", "const_cast", "continue", "default", "double", "dynamic_cast", "enum", "explicit",
    "export", "extern", "false", "float", "friend", "goto", "inline", "int", "long", "mutable", "namespace",
    "nullptr", "private", "protected", "public", "register", "reinterpret_cast", "short", "signed", "static",
    "static_cast", "struct", "template", "this", "thread_local", "true", "typedef", "typename", "union",
    "unsigned", "using", "virtual", "void", "volatile", "wchar_t", "override", "final", "concept", "module",
    "import", "size_t", "std", "NULL",
}
JAVA_KEYWORDS = {
    "abstract", "boolean", "break", "byte", "char", "class", "const", "continue", "default", "double", "enum",
    "extends", "final", "finally", "float", "goto", "implements", "import", "instanceof", "int", "interface",
    "long", "native", "package", "private", "protected", "public", "short", "static", "strictfp", "super",
    "this", "throws", "transient", "void", "volatile", "true", "false", "null", "var", "record", "permits",
    "sealed", "non-sealed", "yield", "String", "Object",
}
TYPE_WORDS = {"class", "struct", "union", "enum", "interface", "record"}
ASSIGN_OPS = {"=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "++", "--"}
INCLUDE = re.compile(r'^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]', re.MULTILINE)
JAVA_PACKAGE = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.MULTILINE)
JAVA_IMPORT = re.compile(r"^\s*import\s+(static\s+)?([\w.]+)(\.\*)?\s*;", re.MULTILINE)


def strip_source(text, language):
    """주석과 문자열/문자 리터럴을 공백으로 바꾸되 줄 번호는 보존한다."""
    output = []
    index, length = 0, len(text)
    while index < length:
        char = text[index]
        pair = text[index:index + 2]
        if pair == "//":
            end = text.find("\n", index)
            end = length if end < 0 else end
            output.append(" " * (end - index))
            index = end
        elif pair == "/*":
            end = text.find("*/", index + 2)
            end = length if end < 0 else end + 2
            output.append(re.sub(r"[^\n]", " ", text[index:end]))
            index = end
        elif language == "cpp" and char == "R" and text.startswith('R"', index) and (
                index == 0 or not (text[index - 1].isalnum() or text[index - 1] == "_")):
            match = re.match(r'R"([^()\\\s]{0,16})\(', text[index:])
            if match:
                closing = ")" + match.group(1) + '"'
                end = text.find(closing, index + match.end())
                end = length if end < 0 else end + len(closing)
                output.append('""' + re.sub(r"[^\n]", " ", text[index + 2:end]))
                index = end
                continue
            output.append(char)
            index += 1
        elif language == "java" and text.startswith('"""', index):
            end = text.find('"""', index + 3)
            end = length if end < 0 else end + 3
            output.append('""' + re.sub(r"[^\n]", " ", text[index + 2:end]))
            index = end
        elif char in "\"'":
            if char == "'" and language == "cpp" and index and text[index - 1].isalnum() \
                    and index + 1 < length and text[index + 1].isalnum():
                output.append(" ")  # C++14 숫자 구분자 1'000
                index += 1
                continue
            end = index + 1
            while end < length and text[end] != char and text[end] != "\n":
                end += 2 if text[end] == "\\" else 1
            end = min(length, end + 1)
            output.append(char + " " * max(0, end - index - 2) + char)
            index = end
        else:
            output.append(char)
            index += 1
    return "".join(output)


def tokenize(text):
    tokens = []
    line = 1
    position = 0
    for match in TOKEN.finditer(text):
        line += text.count("\n", position, match.start())
        position = match.start()
        kind = match.lastgroup
        tokens.append((kind, match.group(), line))
    return tokens


class Symbol:
    __slots__ = ("id", "kind", "name", "qualname", "path", "scope", "line")

    def __init__(self, node_id, kind, name, qualname, path, scope, line):
        self.id, self.kind, self.name, self.qualname = node_id, kind, name, qualname
        self.path, self.scope, self.line = path, scope, line


class BraceUnit:
    def __init__(self, path, text, language):
        self.path = path
        self.language = language
        self.raw = text
        clean = strip_source(text, language)
        if language == "cpp":
            self.includes = [(quote, target.strip(), clean.count("\n", 0, match.start()) + 1)
                             for match in INCLUDE.finditer(text)
                             for quote, target in [match.groups()]]
            # 전처리 지시문 제거 (줄 연속 포함)
            clean = re.sub(r"^[ \t]*#(?:[^\n]*\\\n)*[^\n]*", lambda m: re.sub(r"[^\n]", " ", m.group()),
                           clean, flags=re.MULTILINE)
            self.package = None
            self.imports = []
        else:
            self.includes = []
            package = JAVA_PACKAGE.search(clean)
            self.package = package.group(1) if package else ""
            self.imports = [(bool(m.group(1)), m.group(2), bool(m.group(3)),
                             clean.count("\n", 0, m.start()) + 1) for m in JAVA_IMPORT.finditer(clean)]
            clean = JAVA_PACKAGE.sub(lambda m: " " * len(m.group()), clean)
            clean = JAVA_IMPORT.sub(lambda m: re.sub(r"[^\n]", " ", m.group()), clean)
        self.tokens = tokenize(clean)
        self.bodies = []      # (owner Symbol, class scope, token start, token end, parameters)
        self.static_refs = [] # 파일/클래스 수준 초기화식 (owner id, start, end)


class BraceAnalyzer:
    def __init__(self, graph, files):
        self.graph = graph
        self.units = {path: BraceUnit(path, text, language_of(path)) for path, text in files.items()}
        self.functions = defaultdict(list)   # 이름 → [Symbol]
        self.variables = defaultdict(list)
        self.classes = defaultdict(list)
        self.by_qualname = {}
        self.members = defaultdict(dict)     # 클래스 qualname → {멤버 이름: Symbol}
        self.visible = defaultdict(set)      # 파일 → 참조 가능한 파일
        self.java_types = {}                 # 패키지.클래스 → 파일

    def run(self):
        for unit in self.units.values():
            self.declare(unit)
        for unit in self.units.values():
            if unit.language == "cpp":
                self.resolve_includes(unit)
            else:
                self.resolve_java_imports(unit)
        self.java_visibility()
        for unit in self.units.values():
            self.references(unit)

    # -- 선언 수집

    def register(self, unit, kind, name, scope, line, defined=True, owner_id=None, local=False):
        separator = "::" if unit.language == "cpp" else "."
        qualname = separator.join(scope + [name]) if scope else name
        language = unit.language
        shared = language == "cpp" and not local
        key = (language, kind, qualname) if shared else (language, kind, qualname, unit.path)
        if shared and key in self.by_qualname:
            symbol = self.by_qualname[key]
            self.graph.node(symbol.id, kind, name, unit.path, line, language, qualname, defined=defined)
            if defined:
                symbol.path, symbol.line = unit.path, line
            self.graph.edge(owner_id or file_id(unit.path), symbol.id,
                            "contains" if defined else "declares", line)
            return symbol
        if shared:
            # C++ 심볼은 헤더 선언과 소스 정의를 하나의 노드로 합친다.
            node_id = f"{kind}:cpp:{qualname}"
        else:
            node_id = symbol_id(kind, unit.path, qualname)
        symbol = Symbol(node_id, kind, name, qualname, unit.path, tuple(scope), line)
        self.graph.node(node_id, kind, name, unit.path, line, language, qualname, defined=defined)
        self.graph.edge(owner_id or file_id(unit.path), node_id, "contains" if defined else "declares", line)
        self.by_qualname[key] = symbol
        {"function": self.functions, "variable": self.variables, "class": self.classes}[kind][name].append(symbol)
        if scope:
            self.members[(language, separator.join(scope))].setdefault(name, symbol)
        return symbol

    def declare(self, unit):
        tokens = unit.tokens
        keywords = CPP_KEYWORDS if unit.language == "cpp" else JAVA_KEYWORDS
        # 스택 항목: (종류, 이름, 소유 노드 id)
        stack = [("file", None, file_id(unit.path))]
        statement = 0
        index = 0
        count = len(tokens)

        def scope_names():
            return [name for kind, name, _ in stack if kind in ("namespace", "class") and name]

        def owner():
            for kind, _, node_id in reversed(stack):
                if kind == "class":
                    return node_id
            return file_id(unit.path)

        def matching(start, opening, closing):
            depth = 0
            for position in range(start, count):
                value = tokens[position][1]
                if value == opening:
                    depth += 1
                elif value == closing:
                    depth -= 1
                    if depth == 0:
                        return position
            return count - 1

        while index < count:
            kind, value, line = tokens[index]
            if value == "{":
                header = tokens[statement:index]
                values = [token[1] for token in header]
                class_name = type_declaration(values)
                if values and values[0] == "namespace" or (unit.language == "cpp" and values[:1] == ["extern"]
                                                            and len(values) <= 2):
                    name = values[1] if len(values) > 1 and values[0] == "namespace" and \
                        header[1][0] == "ident" else None
                    if name and len(values) > 2 and "::" in values:
                        name = "::".join(v for v in values[1:] if v != "::" and v != "inline")
                    stack.append(("namespace", name, stack[-1][2]))
                    index += 1
                    statement = index
                    continue
                function = function_header(header, keywords) if stack[-1][0] in ("file", "namespace", "class") \
                    else None
                if function and (class_name is None or values.index(class_name[0]) > function["paren"]):
                    name_parts = function["name"]
                    scope = scope_names() + name_parts[:-1]
                    symbol = self.register(unit, "function", name_parts[-1], scope, function["line"],
                                           owner_id=owner())
                    if name_parts[:-1]:
                        class_key = (unit.language, "::".join(scope))
                        self.members[class_key].setdefault(name_parts[-1], symbol)
                    end = matching(index, "{", "}")
                    unit.bodies.append((symbol, tuple(scope_names() + name_parts[:-1]),
                                        index + 1, end, function["parameters"], statement))
                    index = end + 1
                    statement = index
                    continue
                if class_name:
                    name, position = class_name
                    scope = scope_names()
                    symbol = self.register(unit, "class", name, scope, header[position][2], owner_id=owner())
                    unit.static_refs.append((symbol.id, statement + position + 1, index, "inherits"))
                    if values[0] == "enum" or (len(values) > 1 and values[1] == "enum"):
                        # 열거형 상수 → 변수 노드
                        end = matching(index, "{", "}")
                        expect = True
                        depth = 0
                        for position2 in range(index + 1, end):
                            token = tokens[position2]
                            if token[1] in "({[":
                                depth += 1
                            elif token[1] in ")}]":
                                depth -= 1
                            elif token[1] == "," and depth == 0:
                                expect = True
                            elif token[1] == ";" and depth == 0:
                                break
                            elif expect and token[0] == "ident" and depth == 0:
                                self.register(unit, "variable", token[1], scope + [name], token[2],
                                              owner_id=symbol.id)
                                expect = False
                        if unit.language == "cpp":
                            index = end + 1
                            statement = index
                            continue
                    stack.append(("class", name, symbol.id))
                    index += 1
                    statement = index
                    continue
                # 초기화 중괄호, 람다, 익명 블록 등은 문장의 일부로 건너뛴다.
                index = matching(index, "{", "}") + 1
                if stack[-1][0] == "class" and unit.language == "java" and not values:
                    statement = index  # 인스턴스 초기화 블록
                continue
            if value == "}":
                if len(stack) > 1:
                    stack.pop()
                index += 1
                statement = index
                continue
            if value == ";":
                header = tokens[statement:index]
                if stack[-1][0] in ("file", "namespace", "class"):
                    self.declaration(unit, header, scope_names(), owner(), keywords, statement)
                index += 1
                statement = index
                continue
            if value == ":" and stack[-1][0] == "class" and index == statement + 1 and \
                    tokens[statement][1] in ("public", "private", "protected"):
                index += 1
                statement = index
                continue
            index += 1

    def declaration(self, unit, header, scope, owner_id, keywords, start):
        values = [token[1] for token in header]
        if not values or values[0] in ("using", "typedef", "friend", "return", "static_assert", "template",
                                       "namespace", "goto", "break", "continue", "throw", "export", "module",
                                       "import", "package", "case", "default"):
            if values and values[0] == "template":
                close = template_end(values)
                if close is not None:
                    self.declaration(unit, header[close + 1:], scope, owner_id, keywords, start + close + 1)
            return
        if type_declaration(values) and "(" not in values:
            if "=" not in values and len([v for v in values if v not in ("const", "volatile")]) <= 3:
                return  # 전방 선언
        function = function_header(header, keywords)
        if function and ("=" not in values or values.index("=") > function["paren"]):
            name_parts = function["name"]
            # 함수 선언(프로토타입). C++에서는 정의와 하나의 노드로 합쳐진다.
            self.register(unit, "function", name_parts[-1], scope + name_parts[:-1], function["line"],
                          defined=False if unit.language == "cpp" else True, owner_id=owner_id)
            return
        external = unit.language == "cpp" and "extern" in values
        local = unit.language == "cpp" and "static" in values and not owner_id.startswith("class:")
        for name, line, init_start, init_end in declarators(header, keywords):
            symbol = self.register(unit, "variable", name, scope, line, defined=not external,
                                   owner_id=owner_id, local=local)
            if init_start is not None:
                unit.static_refs.append((symbol.id, start + init_start, start + init_end, "init"))
        type_end = first_declarator_index(header, keywords)
        if type_end:
            unit.static_refs.append((owner_id, start, start + type_end, "type"))

    # -- 파일 간 가시성

    def resolve_includes(self, unit):
        directory = posixpath.dirname(unit.path)
        for quote, target, line in unit.includes:
            found = None
            if quote == '"':
                candidate = posixpath.normpath(posixpath.join(directory, target))
                if candidate in self.units:
                    found = candidate
            if not found:
                suffix = "/" + target.lstrip("./")
                matches = [path for path in self.units if path.endswith(suffix)]
                found = closest(matches, unit.path)
            if found:
                self.graph.edge(file_id(unit.path), file_id(found), "imports", line)
                self.visible[unit.path].add(found)
        # include 전이 폐쇄 + 같은 이름의 헤더/소스 짝
        stem = posixpath.splitext(unit.path)[0]
        for path in self.units:
            if path != unit.path and posixpath.splitext(path)[0] == stem:
                self.visible[unit.path].add(path)

    def resolve_java_imports(self, unit):
        for key, symbol in self.by_qualname.items():
            language, kind, qualname = key[:3]
            if language == "java" and kind == "class" and symbol.path == unit.path and "." not in qualname:
                self.java_types[(unit.package + "." if unit.package else "") + qualname] = unit.path

    def java_visibility(self):
        packages = defaultdict(set)
        for unit in self.units.values():
            if unit.language == "java":
                packages[unit.package].add(unit.path)
        for unit in self.units.values():
            if unit.language != "java":
                continue
            self.visible[unit.path] |= packages[unit.package] - {unit.path}
            for static, name, wildcard, line in unit.imports:
                targets = []
                if wildcard:
                    if name in packages:
                        targets = list(packages[name])
                    elif name in self.java_types:
                        targets = [self.java_types[name]]
                else:
                    parts = name.split(".")
                    for cut in range(len(parts), 0, -1):
                        qualified = ".".join(parts[:cut])
                        if qualified in self.java_types:
                            targets = [self.java_types[qualified]]
                            break
                for target in targets:
                    if target != unit.path:
                        self.graph.edge(file_id(unit.path), file_id(target), "imports", line)
                        self.visible[unit.path].add(target)

    # -- 참조

    def candidates(self, table, name, unit, scope):
        symbols = table.get(name)
        if not symbols:
            return None
        if len(symbols) == 1:
            symbol = symbols[0]
            return symbol if self.reachable(unit, symbol) else None
        visible = self.visible_files(unit.path)

        def rank(symbol):
            shared = 0
            for left, right in zip(symbol.scope, scope):
                if left != right:
                    break
                shared += 1
            return (symbol.path == unit.path, shared, symbol.path in visible)
        best = max(symbols, key=rank)
        return best if self.reachable(unit, best) else None

    def visible_files(self, path):
        cache = getattr(self, "_visible_cache", None)
        if cache is None:
            cache = self._visible_cache = {}
        if path in cache:
            return cache[path]
        seen = {path}
        pending = [path]
        while pending:
            current = pending.pop()
            for target in self.visible.get(current, ()):
                if target not in seen:
                    seen.add(target)
                    pending.append(target)
                    # 헤더와 짝을 이루는 구현 파일도 함께 본다.
                    stem = posixpath.splitext(target)[0]
                    for other in self.units:
                        if other not in seen and posixpath.splitext(other)[0] == stem:
                            seen.add(other)
        cache[path] = seen
        return seen

    def reachable(self, unit, symbol):
        if symbol.path == unit.path:
            return True
        if self.units[symbol.path].language != unit.language:
            return False
        if unit.language == "cpp" and symbol.kind == "function":
            return True  # 링크 단위 전역 함수
        return symbol.path in self.visible_files(unit.path)

    def member(self, language, class_name, name, scope):
        separator = "::" if language == "cpp" else "."
        for depth in range(len(scope), -1, -1):
            prefix = separator.join(list(scope[:depth]) + [class_name])
            members = self.members.get((language, prefix))
            if members and name in members:
                return members[name]
        return None

    def class_chain(self, language, scope):
        """현재 클래스와 상위 클래스 스코프 목록 (가장 안쪽부터)."""
        separator = "::" if language == "cpp" else "."
        return [separator.join(scope[:depth]) for depth in range(len(scope), 0, -1)]

    def references(self, unit):
        tokens = unit.tokens
        keywords = CPP_KEYWORDS if unit.language == "cpp" else JAVA_KEYWORDS
        for owner_id, start, end, mode in unit.static_refs:
            if mode == "inherits":
                for position in range(start, end):
                    kind, value, line = tokens[position]
                    if kind == "ident" and value not in keywords:
                        target = self.candidates(self.classes, value, unit, ())
                        if target and target.id != owner_id:
                            self.graph.edge(owner_id, target.id, "inherits", line)
            else:
                self.scan(unit, owner_id, (), start, end, set(), keywords)
        for symbol, scope, start, end, parameters, header_start in unit.bodies:
            locals_ = set(parameters)
            self.scan(unit, symbol.id, scope, start, end, locals_, keywords, declare_locals=True)

    def scan(self, unit, owner_id, scope, start, end, locals_, keywords, declare_locals=False):
        tokens = unit.tokens
        language = unit.language
        chain = self.class_chain(language, list(scope))
        for position in range(start, min(end, len(tokens))):
            kind, value, line = tokens[position]
            if kind != "ident" or value in keywords or value in CONTROL:
                continue
            previous = tokens[position - 1][1] if position > 0 else ""
            following = tokens[position + 1][1] if position + 1 < len(tokens) else ""
            before = tokens[position - 2] if position > 1 else (None, "", 0)
            if declare_locals and is_local_declaration(tokens, position, keywords):
                locals_.add(value)
                continue
            if following == "::" or (language == "java" and following == "." and value[:1].isupper()
                                     and value not in locals_):
                # 한정자 자체: 클래스 참조로 본다.
                if previous not in ("::", ".", "->"):
                    target = self.candidates(self.classes, value, unit, scope)
                    if target and target.id != owner_id:
                        self.graph.edge(owner_id, target.id, "reads", line)
                continue
            target = None
            if previous in ("::", ".", "->"):
                qualifier = before[1]
                if qualifier == "this" or (language == "cpp" and previous == "::" and before[0] != "ident"):
                    for class_name in chain:
                        members = self.members.get((language, class_name), {})
                        if value in members:
                            target = members[value]
                            break
                    if target is None and previous == "::":
                        target = self.global_symbol(value, following)
                elif before[0] == "ident" and (previous == "::" or (language == "java" and qualifier[:1].isupper())):
                    target = self.member(language, qualifier, value, scope)
                elif following == "(":
                    # obj.method(...) : 프로젝트 전체에서 유일한 메서드 이름이면 연결
                    options = [s for s in self.functions.get(value, []) if s.scope and s.path in
                               self.visible_files(unit.path) | {unit.path}]
                    if len(options) == 1:
                        target = options[0]
                if target is None:
                    continue
            elif value in locals_:
                continue
            else:
                for class_name in chain:
                    members = self.members.get((language, class_name), {})
                    if value in members:
                        target = members[value]
                        break
                if target is None:
                    if following == "(" or (following == "<" and language == "cpp"):
                        target = (self.candidates(self.functions, value, unit, scope)
                                  or self.candidates(self.classes, value, unit, scope))
                    else:
                        target = (self.candidates(self.variables, value, unit, scope)
                                  or self.candidates(self.classes, value, unit, scope)
                                  or self.candidates(self.functions, value, unit, scope))
            if target is None or target.id == owner_id:
                continue
            if target.kind == "function" or (target.kind == "class" and (following == "(" or previous == "new")):
                edge = "calls" if following in ("(", "<") or previous == "new" else "reads"
            elif following in ASSIGN_OPS or previous in ("++", "--"):
                edge = "writes"
            elif following == "[" and assignment_after_index(tokens, position + 1):
                edge = "writes"
            else:
                edge = "reads"
            self.graph.edge(owner_id, target.id, edge, line)

    def global_symbol(self, name, following):
        table = self.functions if following == "(" else self.variables
        options = [symbol for symbol in table.get(name, []) if not symbol.scope]
        return options[0] if len(options) == 1 else None


def assignment_after_index(tokens, start):
    depth = 0
    for position in range(start, min(len(tokens), start + 64)):
        value = tokens[position][1]
        if value == "[":
            depth += 1
        elif value == "]":
            depth -= 1
            if depth == 0:
                following = tokens[position + 1][1] if position + 1 < len(tokens) else ""
                if following == "[":
                    continue
                return following in ASSIGN_OPS
    return False


def type_declaration(values):
    """class/struct/enum/interface 선언이면 (이름, 위치)를 반환한다."""
    depth = 0
    for position, value in enumerate(values):
        if value in ("(", "<"):
            depth += 1
        elif value in (")", ">"):
            depth -= 1
        elif depth <= 0 and value in TYPE_WORDS:
            if position and values[position - 1] in ("enum",):
                continue
            following = position + 1
            while following < len(values) and values[following] in ("class", "struct", "alignas", "final"):
                following += 1
            if following < len(values) and values[following] == "@":
                following += 1
            if following < len(values) and re.match(r"[A-Za-z_$]", values[following]) and \
                    values[following] not in ("final",):
                name_position = following
                # 한정된 이름 A::B 의 마지막 부분
                while name_position + 2 < len(values) and values[name_position + 1] == "::":
                    name_position += 2
                return values[name_position], name_position
            return None
    return None


def template_end(values):
    if not values or values[0] != "template" or len(values) < 2 or values[1] != "<":
        return None
    depth = 0
    for position in range(1, len(values)):
        if values[position] == "<":
            depth += 1
        elif values[position] == ">":
            depth -= 1
            if depth == 0:
                return position
    return None


def function_header(header, keywords):
    """`... name ( params ) qualifiers` 형태면 함수 정보 사전을 반환한다."""
    values = [token[1] for token in header]
    if not values:
        return None
    offset = 0
    close = template_end(values)
    if close is not None:
        offset = close + 1
    # Java 애너테이션 @Name(...) 건너뛰기
    while offset < len(values) and values[offset] == "@":
        offset += 2
        if offset < len(values) and values[offset] == "(":
            depth = 0
            for position in range(offset, len(values)):
                if values[position] == "(":
                    depth += 1
                elif values[position] == ")":
                    depth -= 1
                    if depth == 0:
                        offset = position + 1
                        break
    depth = 0
    for position in range(offset, len(values)):
        value = values[position]
        if value == "<":
            depth += 1
        elif value == ">":
            depth = max(0, depth - 1)
        elif value == "(" and depth == 0:
            if position == offset:
                return None
            name_token = header[position - 1]
            name = name_token[1]
            # 연산자 오버로딩(operator==)과 호출·제어문은 함수 정의로 보지 않는다.
            if name_token[0] != "ident" or name in CONTROL or name in keywords or \
                    (position >= 2 and values[position - 2] == "operator"):
                return None
            if position - 2 >= offset and values[position - 2] in ("=", "return", ",", "(", ".", "->", "new"):
                return None
            parts = [name]
            cursor = position - 2
            while cursor - 1 >= offset and values[cursor] == "::" and header[cursor - 1][0] == "ident":
                parts.insert(0, values[cursor - 1])
                cursor -= 2
            if cursor >= offset and values[cursor] == "~":
                parts[-1] = "~" + parts[-1]
                cursor -= 1
            # 반환 타입이 없으면 생성자/소멸자/매크로 호출이어야 한다.
            if cursor < offset and len(parts) == 1 and not header_is_constructor_like(values, position):
                return None
            depth_parens = 0
            end = position
            for scan in range(position, len(values)):
                if values[scan] == "(":
                    depth_parens += 1
                elif values[scan] == ")":
                    depth_parens -= 1
                    if depth_parens == 0:
                        end = scan
                        break
            else:
                return None
            trailing = values[end + 1:]
            if trailing and trailing[0] not in ("const", "noexcept", "override", "final", "throws", "->",
                                                 ":", "&", "&&", "volatile", "=", "mutable", "requires",
                                                 "try", "[", "default"):
                if not re.fullmatch(r"_\w*|[A-Z][A-Z0-9_]*", trailing[0]):  # __THROW, NOEXCEPT 같은 매크로
                    return None
            parameters = parameter_names(header[position + 1:end], keywords)
            return {"name": parts, "line": name_token[2], "paren": position, "parameters": parameters,
                    "initializers": ":" in trailing}
    return None


def header_is_constructor_like(values, position):
    return position + 1 < len(values) and values[position - 1][:1].isupper()


def parameter_names(tokens, keywords):
    names = set()
    depth = 0
    group = []
    for token in list(tokens) + [("op", ",", 0)]:
        value = token[1]
        if value in ("(", "<", "[", "{"):
            depth += 1
        elif value in (")", ">", "]", "}"):
            depth -= 1
        if value == "," and depth <= 0:
            cut = next((i for i, t in enumerate(group) if t[1] == "="), len(group))
            idents = [t for t in group[:cut] if t[0] == "ident" and t[1] not in keywords]
            if len(idents) >= 2 or (idents and len(group[:cut]) > 1 and group[:cut][-1][0] == "ident"
                                    and len(idents) == 1 and group[0][1] in keywords):
                names.add(idents[-1][1])
            group = []
        else:
            group.append(token)
    return names


def first_declarator_index(header, keywords):
    for position, token in enumerate(header):
        if token[1] in ("=", ",", "[", "{", "("):
            return max(0, position - 1)
    return max(0, len(header) - 1)


def declarators(header, keywords):
    """`Type a = 1, b[3];` 에서 (이름, 줄, 초기화식 시작, 끝)을 추출한다."""
    values = [token[1] for token in header]
    if not values:
        return []
    offset = 0
    while offset < len(values) and values[offset] == "@":
        offset += 2
    results = []
    depth = 0
    angle = 0
    group_start = offset
    first = True
    pieces = []
    for position in range(offset, len(values) + 1):
        value = values[position] if position < len(values) else ","
        if value in ("(", "[", "{"):
            depth += 1
        elif value in (")", "]", "}"):
            depth -= 1
        elif value == "<" and depth == 0 and "=" not in values[group_start:position]:
            angle += 1
        elif value == ">" and depth == 0 and angle:
            angle -= 1
        elif value == "," and depth == 0 and angle == 0:
            pieces.append((group_start, position, first))
            group_start = position + 1
            first = False
    for start, end, is_first in pieces:
        equals = next((i for i in range(start, end) if values[i] in ("=", "{")), None)
        name_end = equals if equals is not None else end
        bracket = next((i for i in range(start, name_end) if values[i] in ("[", ":")), None)
        if bracket is not None:
            name_end = bracket
        candidate = name_end - 1
        if candidate < start or header[candidate][0] != "ident" or values[candidate] in keywords:
            continue
        identifiers = [i for i in range(start, name_end) if header[i][0] == "ident"]
        if is_first and len(identifiers) < 2 and not (set(values[start:name_end]) & {"*", "&", ">"}):
            continue  # 타입 없는 표현식 문장
        if "(" in values[start:name_end]:
            continue
        init = (equals + (1 if values[equals] == "=" else 0), end) if equals is not None else (None, None)
        results.append((values[candidate], header[candidate][2], *init))
    return results


def is_local_declaration(tokens, position, keywords):
    """함수 본문에서 지역 변수 선언으로 보이는 식별자인지 판단한다."""
    if position == 0:
        return False
    following = tokens[position + 1][1] if position + 1 < len(tokens) else ""
    if following not in ("=", ";", ",", "{", ":", ")", "[", "("):
        return False
    previous_kind, previous, _ = tokens[position - 1]
    if previous in ("*", "&", "&&"):
        cursor = position - 1
        while cursor > 0 and tokens[cursor][1] in ("*", "&", "&&", "const"):
            cursor -= 1
        previous_kind, previous = tokens[cursor][0], tokens[cursor][1]
        before = tokens[cursor - 1][1] if cursor > 0 else ""
        if previous_kind != "ident" or before in ("=", "(", ",", "return") and previous not in keywords:
            return previous in keywords and previous not in ("return", "this")
    if previous == ">":
        return following in ("=", ";", ",", "{", ":", ")")
    if previous == "]" and tokens[position - 2][1] == "[":
        return True  # Java 배열 타입 int[] a
    if previous_kind != "ident" or previous in CONTROL or previous in ("return", "this", "goto", "else",
                                                                       "case", "new", "throw", "delete"):
        return False
    if following == "(" and previous not in keywords:
        return False  # 함수 호출 결과 사용 등
    if following == ")" and tokens[position - 2][1] not in ("(", ","):
        return False
    return True


# --------------------------------------------------------------------------- Lean 4

LEAN_DECL_KINDS = {
    "structure": "class",
    "class": "class",
    "inductive": "class",
    "theorem": "function",
    "lemma": "function",
    "def": "function",
    "abbrev": "function",
    "instance": "function",
    "axiom": "variable",
    "opaque": "variable",
    "constant": "variable",
}
LEAN_MODIFIERS = {"private", "protected", "noncomputable", "partial", "unsafe", "scoped", "local"}
LEAN_IMPORT = re.compile(r"^[ \t]*import[ \t]+([A-Za-z_][\w.']*)", re.MULTILINE)
LEAN_IDENT = re.compile(r"[A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*")


def strip_lean_comments(text):
    """Lean 4 주석(-- 및 중첩 /- -/)과 문자열을 공백으로 바꾸고 줄 번호를 보존한다."""
    out = []
    i, n = 0, len(text)
    depth = 0
    while i < n:
        ch = text[i]
        pair = text[i:i + 2]
        if depth:
            if pair == "/-":
                depth += 1
                out.append("  ")
                i += 2
            elif pair == "-/":
                depth -= 1
                out.append("  ")
                i += 2
            else:
                out.append("\n" if ch == "\n" else " ")
                i += 1
        elif pair == "/-":
            depth = 1
            out.append("  ")
            i += 2
        elif pair == "--":
            end = text.find("\n", i)
            end = n if end < 0 else end
            out.append(" " * (end - i))
            i = end
        elif ch == '"':
            end = i + 1
            while end < n and text[end] != '"':
                if text[end] == "\\" and end + 1 < n:
                    end += 2
                else:
                    end += 1
            end = min(n, end + 1)
            out.append("".join("\n" if c == "\n" else " " for c in text[i:end]))
            i = end
        else:
            out.append(ch)
            i += 1
    return "".join(out)


class LeanAnalyzer:
    def __init__(self, graph, files):
        self.graph = graph
        self.files = files
        self.clean = {path: strip_lean_comments(text) for path, text in files.items()}
        self.by_qualname = {}
        self.by_short = defaultdict(list)
        self.units = []  # (path, [(node_id, kind, qualname, start_pos, end_pos)])

    def resolve_import(self, origin, mod_name):
        rel = "/" + mod_name.replace(".", "/") + ".lean"
        if rel in self.files:
            return rel
        origin_dir = posixpath.dirname(origin).rstrip("/")
        if origin_dir:
            candidate = origin_dir + rel
            if candidate in self.files:
                return candidate
        matches = [p for p in self.files if p == rel or p.endswith(rel)]
        return min(matches, key=len) if matches else None

    def run(self):
        for path, clean in sorted(self.clean.items()):
            fid = file_id(path)
            for match in LEAN_IMPORT.finditer(clean):
                target = self.resolve_import(path, match.group(1))
                if target:
                    line = clean.count("\n", 0, match.start()) + 1
                    self.graph.edge(fid, file_id(target), "imports", line)
            self._collect_declarations(path, clean)

        for path, decls in self.units:
            clean = self.clean[path]
            for node_id, _kind, qualname, start_pos, end_pos in decls:
                snippet = clean[start_pos:end_pos]
                base_line = clean.count("\n", 0, start_pos) + 1
                seen = set()
                for m in LEAN_IDENT.finditer(snippet):
                    tok = m.group(0)
                    if tok in seen:
                        continue
                    target = self._resolve_symbol(tok, qualname)
                    if target and target[0] != node_id:
                        seen.add(tok)
                        edge_kind = "reads" if target[1] == "variable" else "calls"
                        line = base_line + snippet.count("\n", 0, m.start())
                        self.graph.edge(node_id, target[0], edge_kind, line)

    def _collect_declarations(self, path, clean):
        fid = file_id(path)
        namespaces = []
        raw_decls = []
        lines = clean.splitlines(keepends=True)
        offset = 0
        for idx, raw_line in enumerate(lines, start=1):
            stripped = raw_line.strip()
            if not stripped:
                offset += len(raw_line)
                continue
            parts = stripped.split()
            if parts[0] == "namespace" and len(parts) >= 2 and re.fullmatch(r"[A-Za-z_][\w.']*", parts[1]):
                namespaces.append(parts[1].split("."))
                offset += len(raw_line)
                continue
            if parts[0] == "end":
                if len(parts) == 1 and namespaces:
                    namespaces.pop()
                elif len(parts) >= 2 and namespaces:
                    end_parts = parts[1].split(".")
                    if namespaces[-1] == end_parts or namespaces[-1][-len(end_parts):] == end_parts:
                        namespaces.pop()
                offset += len(raw_line)
                continue
            pos = 0
            while pos < len(parts) and parts[pos] in LEAN_MODIFIERS:
                pos += 1
            if pos < len(parts) and parts[pos] in LEAN_DECL_KINDS:
                decl_word = parts[pos]
                kind = LEAN_DECL_KINDS[decl_word]
                name = None
                if pos + 1 < len(parts):
                    cand = parts[pos + 1].split(":")[0].split("(")[0].split("{")[0].split("[")[0]
                    if re.fullmatch(r"[A-Za-z_][\w.']*", cand):
                        name = cand
                if name:
                    prefix = [p for ns in namespaces for p in ns]
                    qualname = ".".join(prefix + [name]) if prefix else name
                    short = name.rsplit(".", 1)[-1]
                    node_id = symbol_id(kind, path, qualname)
                    self.graph.node(node_id, kind, short, path, idx, "lean4", qualname)
                    self.graph.edge(fid, node_id, "contains", idx)
                    self.by_qualname[qualname] = (node_id, kind)
                    self.by_short[short].append((node_id, kind))
                    raw_decls.append((node_id, kind, qualname, offset))
            offset += len(raw_line)

        decls = []
        for idx, (node_id, kind, qualname, start_pos) in enumerate(raw_decls):
            end_pos = raw_decls[idx + 1][3] if idx + 1 < len(raw_decls) else len(clean)
            decls.append((node_id, kind, qualname, start_pos, end_pos))
        self.units.append((path, decls))

    def _resolve_symbol(self, token, current_qualname):
        if token in self.by_qualname:
            return self.by_qualname[token]
        if "." in current_qualname and "." not in token:
            ns = current_qualname.rsplit(".", 1)[0]
            while ns:
                cand = f"{ns}.{token}"
                if cand in self.by_qualname:
                    return self.by_qualname[cand]
                ns = ns.rsplit(".", 1)[0] if "." in ns else ""
        candidates = self.by_short.get(token, [])
        return candidates[0] if len(candidates) == 1 else None


# --------------------------------------------------------------------------- 진입점


def analyze(files):
    """{경로: 텍스트} → 그래프 사전."""
    graph = Graph()
    errors = []
    groups = defaultdict(dict)
    for path, text in sorted(files.items()):
        language = language_of(path)
        if not language:
            continue
        graph.node(file_id(path), "file", posixpath.basename(path), path, 1, language, path,
                   lines=text.count("\n") + 1)
        groups[language][path] = text
    if groups["python"]:
        valid = {}
        for path, text in groups["python"].items():
            try:
                valid[path] = ast.parse(text, filename=path)
            except (SyntaxError, ValueError) as error:
                errors.append({"path": path, "message": f"Python 구문 오류: {error.msg if hasattr(error, 'msg') else error}",
                               "line": getattr(error, "lineno", None)})
            except RecursionError:
                errors.append({"path": path, "message": "중첩이 너무 깊어 분석하지 못했습니다.", "line": None})
        PythonAnalyzer(graph, valid, errors).run()
    brace = {path: text for language in ("cpp", "java") for path, text in groups[language].items()}
    if brace:
        BraceAnalyzer(graph, brace).run()
    if groups["lean4"]:
        LeanAnalyzer(graph, groups["lean4"]).run()
    nodes = list(graph.nodes.values())
    edges = [edge for edge in graph.edges.values() if edge["from"] in graph.nodes and edge["to"] in graph.nodes]
    truncated = False
    if len(nodes) > MAX_NODES:
        truncated = True
        keep = {node["id"] for node in nodes if node["kind"] == "file"}
        degree = defaultdict(int)
        for edge in edges:
            degree[edge["from"]] += 1
            degree[edge["to"]] += 1
        for node in sorted(nodes, key=lambda item: -degree[item["id"]]):
            if len(keep) >= MAX_NODES:
                break
            keep.add(node["id"])
        nodes = [node for node in nodes if node["id"] in keep]
        edges = [edge for edge in edges if edge["from"] in keep and edge["to"] in keep]
    if len(edges) > MAX_EDGES:
        truncated = True
        priority = {kind: index for index, kind in enumerate(("imports", "contains", "inherits", "calls",
                                                              "writes", "reads", "declares"))}
        edges = sorted(edges, key=lambda edge: (priority.get(edge["kind"], 9), -edge["count"]))[:MAX_EDGES]
    summary = defaultdict(int)
    for node in nodes:
        summary[node["kind"]] += 1
    languages = defaultdict(int)
    for path in files:
        if language_of(path):
            languages[language_of(path)] += 1
    return {"nodes": nodes, "edges": edges, "errors": errors, "truncated": truncated,
            "summary": dict(summary), "languages": dict(languages)}


def collect(list_directory, read_file, root, limit=MAX_FILES, byte_limit=MAX_BYTES):
    """VM 워크스페이스에서 지원 언어 소스를 수집한다.

    ``list_directory(path, cursor)`` 는 ``{"entries": [[name, type], ...], "cursor": int|None}`` 를,
    ``read_file(path)`` 는 텍스트를 반환해야 한다.
    """
    if language_of(root):
        return {root: read_file(root)}, [], False
    sources = []
    pending = [root]
    directories = 0
    truncated = False
    while pending and len(sources) < limit:
        directory = pending.pop(0)
        directories += 1
        if directories > MAX_DIRECTORIES:
            truncated = True
            break
        cursor = 0
        while cursor is not None:
            listing = list_directory(directory, cursor)
            for name, kind in listing.get("entries", []):
                path = (directory.rstrip("/") or "") + "/" + name
                if kind == "directory":
                    if name not in SKIP_DIRECTORIES and not name.startswith("."):
                        pending.append(path)
                elif language_of(name):
                    sources.append(path)
            cursor = listing.get("cursor")
    if len(sources) > limit:
        sources = sources[:limit]
        truncated = True
    files = {}
    skipped = []
    total = 0

    def load(path):
        try:
            return path, read_file(path), None
        except Exception as error:  # noqa: BLE001 - 파일별 실패는 결과에 기록한다.
            return path, None, str(error)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for path, text, error in pool.map(load, sources):
            if error is not None:
                skipped.append({"path": path, "message": error})
                continue
            total += len(text.encode())
            if total > byte_limit:
                truncated = True
                skipped.append({"path": path, "message": "분석 크기 제한을 초과해 건너뛰었습니다."})
                continue
            files[path] = text
    return files, skipped, truncated
