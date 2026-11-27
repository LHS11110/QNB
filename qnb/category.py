"""Category Theory formal parser, type checker, equational prover, and visualizer."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass


# --------------------------------------------------------------------------- AST

@dataclass(frozen=True)
class CatTerm:
    pass


@dataclass(frozen=True)
class ObjApp(CatTerm):
    func: str
    arg: CatTerm


@dataclass(frozen=True)
class ObjName(CatTerm):
    name: str


@dataclass(frozen=True)
class ObjProd(CatTerm):
    left: CatTerm
    right: CatTerm


@dataclass(frozen=True)
class ObjCoprod(CatTerm):
    left: CatTerm
    right: CatTerm


@dataclass(frozen=True)
class MorphId(CatTerm):
    obj: CatTerm


@dataclass(frozen=True)
class MorphVar(CatTerm):
    name: str
    arg: CatTerm | None = None


@dataclass(frozen=True)
class MorphComp(CatTerm):
    left: CatTerm   # applied second: (left o right) : dom(right) -> cod(left)
    right: CatTerm


@dataclass(frozen=True)
class MorphFMap(CatTerm):
    functor: str
    inner: CatTerm


@dataclass(frozen=True)
class MorphInv(CatTerm):
    inner: CatTerm


@dataclass(frozen=True)
class MorphPair(CatTerm):
    left: CatTerm
    right: CatTerm


@dataclass(frozen=True)
class MorphCopair(CatTerm):
    left: CatTerm
    right: CatTerm


@dataclass(frozen=True)
class MorphBang(CatTerm):
    obj: CatTerm
    kind: str = "terminal"  # "terminal" (!) or "initial" (?)


def format_obj(term: CatTerm) -> str:
    if isinstance(term, ObjName):
        return term.name
    if isinstance(term, ObjApp):
        inner = format_obj(term.arg)
        return f"{term.func}({inner})"
    if isinstance(term, ObjProd):
        return f"({format_obj(term.left)} × {format_obj(term.right)})"
    if isinstance(term, ObjCoprod):
        return f"({format_obj(term.left)} + {format_obj(term.right)})"
    return str(term)


def format_morph(term: CatTerm, *, parens=False) -> str:
    if isinstance(term, MorphId):
        return f"id({format_obj(term.obj)})"
    if isinstance(term, MorphVar):
        if term.arg is not None:
            return f"{term.name}({format_obj(term.arg)})"
        return term.name
    if isinstance(term, MorphComp):
        s = f"{format_morph(term.left, parens=True)} ∘ {format_morph(term.right, parens=True)}"
        return f"({s})" if parens else s
    if isinstance(term, MorphFMap):
        return f"{term.functor}({format_morph(term.inner)})"
    if isinstance(term, MorphInv):
        return f"inv({format_morph(term.inner)})"
    if isinstance(term, MorphPair):
        return f"⟨{format_morph(term.left)}, {format_morph(term.right)}⟩"
    if isinstance(term, MorphCopair):
        return f"[{format_morph(term.left)}, {format_morph(term.right)}]"
    if isinstance(term, MorphBang):
        sym = "!" if term.kind == "terminal" else "¿"
        return f"{sym}({format_obj(term.obj)})"
    return str(term)


# --------------------------------------------------------------------------- Lexer / Parser

_TOK_RE = re.compile(
    r"\s*(?:(⟨|⟩|<->|↔|≅|=>|⇒|->|→|-o|⊣|-\||∘|×|←|<-|\[|\]|\(|\)|,|:|=|\.|!|\?|⟨|⟩|\+)|([A-Za-z0-9_'][A-Za-z0-9_']*))"
)


class ParseError(ValueError):
    pass


def _tokenize(text: str):
    tokens = []
    pos = 0
    n = len(text)
    while pos < n:
        if text[pos].isspace():
            pos += 1
            continue
        if text[pos] == "<" and text[pos:pos + 2] == "<-":
            tokens.append("<-")
            pos += 2
            continue
        if text[pos] == "<" and not text[pos:pos + 3] == "<->":
            tokens.append("⟨")
            pos += 1
            continue
        if text[pos] == ">" and not text[pos - 1:pos + 1] == "->":
            tokens.append("⟩")
            pos += 1
            continue
        m = _TOK_RE.match(text, pos)
        if not m or m.end() == pos:
            raise ParseError(f"구문 해석 실패: `{text[pos:pos + 16]}`")
        tok = m.group(1) or m.group(2)
        if tok == "→":
            tok = "->"
        elif tok == "⇒":
            tok = "=>"
        elif tok == "↔" or tok == "≅":
            tok = "<->"
        elif tok == "⊣":
            tok = "-|"
        elif tok == ".":
            tok = "∘"
        elif tok == "←":
            tok = "<-"
        tokens.append(tok)
        pos = m.end()
    return tokens


class _Parser:
    def __init__(self, tokens, env):
        self.tokens = tokens
        self.pos = 0
        self.env = env

    def peek(self, k=0):
        idx = self.pos + k
        return self.tokens[idx] if idx < len(self.tokens) else None

    def pop(self, expected=None):
        tok = self.peek()
        if expected is not None and tok != expected:
            raise ParseError(f"`{expected}`가 필요하지만 `{tok or 'EOF'}`가 왔습니다.")
        self.pos += 1
        return tok

    def parse_obj(self) -> CatTerm:
        left = self.parse_obj_atom()
        while self.peek() in ("×", "+"):
            op = self.pop()
            right = self.parse_obj_atom()
            left = ObjProd(left, right) if op == "×" else ObjCoprod(left, right)
        return left

    def parse_obj_atom(self) -> CatTerm:
        tok = self.peek()
        if tok == "(":
            self.pop("(")
            inner = self.parse_obj()
            self.pop(")")
            return inner
        if not tok:
            raise ParseError("대상(Object) 이름이 필요합니다.")
        name = self.pop()
        if name in self.env["functors"] and self.peek() == "(":
            self.pop("(")
            arg = self.parse_obj()
            self.pop(")")
            return ObjApp(name, arg)
        return ObjName(name)

    def parse_morph(self) -> CatTerm:
        parts = [self.parse_morph_atom()]
        while self.peek() == "∘":
            self.pop("∘")
            parts.append(self.parse_morph_atom())
        # Right-associative fold for composition (f ∘ g ∘ h = f ∘ (g ∘ h))
        term = parts[-1]
        for p in reversed(parts[:-1]):
            term = MorphComp(p, term)
        return term

    def parse_morph_atom(self) -> CatTerm:
        tok = self.peek()
        if not tok:
            raise ParseError("사상(Morphism) 표현식이 필요합니다.")
        if tok == "(":
            self.pop("(")
            inner = self.parse_morph()
            self.pop(")")
            return inner
        if tok == "⟨":
            self.pop("⟨")
            left = self.parse_morph()
            self.pop(",")
            right = self.parse_morph()
            self.pop("⟩")
            return MorphPair(left, right)
        if tok == "[":
            self.pop("[")
            left = self.parse_morph()
            self.pop(",")
            right = self.parse_morph()
            self.pop("]")
            return MorphCopair(left, right)
        if tok in ("id", "inv"):
            kw = self.pop()
            if self.peek() == "(":
                self.pop("(")
                arg = self.parse_obj() if kw == "id" else self.parse_morph()
                self.pop(")")
            else:
                arg = self.parse_obj_atom() if kw == "id" else self.parse_morph_atom()
            return MorphId(arg) if kw == "id" else MorphInv(arg)
        if tok in ("!", "?"):
            sym = self.pop()
            if self.peek() == "(":
                self.pop("(")
                obj = self.parse_obj()
                self.pop(")")
            else:
                obj = self.parse_obj_atom()
            return MorphBang(obj, "terminal" if sym == "!" else "initial")
        name = self.pop()
        if name in self.env["functors"]:
            if self.peek() == "(":
                self.pop("(")
                inner = self.parse_morph()
                self.pop(")")
            else:
                inner = self.parse_morph_atom()
            return MorphFMap(name, inner)
        if name in self.env["indexed_morphs"]:
            if self.peek() == "(":
                self.pop("(")
                arg = self.parse_obj()
                self.pop(")")
            else:
                arg = self.parse_obj_atom()
            return MorphVar(name, arg)
        return MorphVar(name)


def parse_obj_expr(text: str, env) -> CatTerm:
    p = _Parser(_tokenize(text), env)
    term = p.parse_obj()
    if p.peek() is not None:
        raise ParseError(f"해석되지 않은 토큰: `{p.peek()}`")
    return term


def parse_morph_expr(text: str, env) -> CatTerm:
    p = _Parser(_tokenize(text), env)
    term = p.parse_morph()
    if p.peek() is not None:
        raise ParseError(f"해석되지 않은 토큰: `{p.peek()}`")
    return term


def parse_eq_expr(text: str, env) -> tuple[CatTerm, CatTerm]:
    tokens = _tokenize(text)
    if "=" not in tokens:
        raise ParseError("등식(`LHS = RHS`)이 필요합니다.")
    eq_idx = tokens.index("=")
    lp = _Parser(tokens[:eq_idx], env)
    lhs = lp.parse_morph()
    if lp.peek() is not None:
        raise ParseError(f"좌변 해석 오류: `{lp.peek()}`")
    rp = _Parser(tokens[eq_idx + 1:], env)
    rhs = rp.parse_morph()
    if rp.peek() is not None:
        raise ParseError(f"우변 해석 오류: `{rp.peek()}`")
    return lhs, rhs


# --------------------------------------------------------------------------- Type Checker

class CatTypeError(ValueError):
    pass


def apply_functor_obj(functor: str, obj: CatTerm, env) -> tuple[CatTerm, str]:
    info = env["functors"].get(functor)
    if not info:
        raise CatTypeError(f"선언되지 않은 함자(Functor): `{functor}`")
    obj_cat = check_obj(obj, env)
    if obj_cat != info["src"]:
        raise CatTypeError(
            f"함자 `{functor} : {info['src']} → {info['dst']}`에 `{info['src']}`가 아닌 `{obj_cat}`의 대상 `{format_obj(obj)}`를 넣었습니다."
        )
    return ObjApp(functor, obj), info["dst"]


def check_obj(obj: CatTerm, env) -> str:
    if isinstance(obj, ObjName):
        if obj.name not in env["objects"]:
            raise CatTypeError(f"선언되지 않은 대상(Object): `{obj.name}`")
        return env["objects"][obj.name]["category"]
    if isinstance(obj, ObjApp):
        _, dst = apply_functor_obj(obj.func, obj.arg, env)
        return dst
    if isinstance(obj, (ObjProd, ObjCoprod)):
        c1 = check_obj(obj.left, env)
        c2 = check_obj(obj.right, env)
        if c1 != c2:
            raise CatTypeError(f"서로 다른 범주(`{c1}`, `{c2}`)의 대상을 곱/쌍대곱으로 결합할 수 없습니다.")
        return c1
    raise CatTypeError(f"잘못된 대상 표현식: {obj}")


def infer_morphism(term: CatTerm, env) -> tuple[CatTerm, CatTerm, str]:
    if isinstance(term, MorphId):
        cat = check_obj(term.obj, env)
        return term.obj, term.obj, cat

    if isinstance(term, MorphVar):
        if term.arg is not None:
            info = env["indexed_morphs"].get(term.name)
            if not info:
                raise CatTypeError(f"선언되지 않은 자연변환/단위 사상: `{term.name}`")
            arg_cat = check_obj(term.arg, env)
            if arg_cat != info["param_cat"]:
                raise CatTypeError(
                    f"`{term.name}`의 매개 대상은 `{info['param_cat']}` 범주여야 하지만 `{format_obj(term.arg)} : {arg_cat}`가 주어졌습니다."
                )
            dom = info["dom_fn"](term.arg)
            cod = info["cod_fn"](term.arg)
            return dom, cod, info["cat"]
        info = env["morphisms"].get(term.name)
        if not info:
            raise CatTypeError(f"선언되지 않은 사상(Morphism): `{term.name}`")
        return info["dom"], info["cod"], info["category"]

    if isinstance(term, MorphComp):
        r_dom, r_cod, r_cat = infer_morphism(term.right, env)
        l_dom, l_cod, l_cat = infer_morphism(term.left, env)
        if r_cat != l_cat:
            raise CatTypeError(f"합성 불가능: `{format_morph(term.left)}`({l_cat})과 `{format_morph(term.right)}`({r_cat})의 범주가 다릅니다.")
        if r_cod != l_dom:
            raise CatTypeError(
                f"사상 합성 타입 불일치: `{format_morph(term.left)} ∘ {format_morph(term.right)}` 에서 "
                f"`{format_morph(term.right)}`의 공역 `{format_obj(r_cod)}` ≠ `{format_morph(term.left)}`의 정의역 `{format_obj(l_dom)}`"
            )
        return r_dom, l_cod, r_cat

    if isinstance(term, MorphFMap):
        info = env["functors"].get(term.functor)
        if not info:
            raise CatTypeError(f"선언되지 않은 함자(Functor): `{term.functor}`")
        dom, cod, cat = infer_morphism(term.inner, env)
        if cat != info["src"]:
            raise CatTypeError(
                f"함자 `{term.functor}`의 정의역 범주는 `{info['src']}`이지만 `{format_morph(term.inner)} : {cat}`가 주어졌습니다."
            )
        return ObjApp(term.functor, dom), ObjApp(term.functor, cod), info["dst"]

    if isinstance(term, MorphInv):
        if not (isinstance(term.inner, MorphVar) and term.inner.name in env["isos"]):
            raise CatTypeError(f"`{format_morph(term.inner)}`는 `iso`로 선언된 동형사상이 아닙니다.")
        dom, cod, cat = infer_morphism(term.inner, env)
        return cod, dom, cat

    if isinstance(term, MorphPair):
        ld, lc, lcat = infer_morphism(term.left, env)
        rd, rc, rcat = infer_morphism(term.right, env)
        if lcat != rcat or ld != rd:
            raise CatTypeError(f"곱 쌍 `⟨u, v⟩`의 정의역과 범주가 일치해야 합니다 (`{format_obj(ld)}` ≠ `{format_obj(rd)}`).")
        prod_obj = env["products"].get((lc, rc))
        if not prod_obj:
            raise CatTypeError(f"`{format_obj(lc)}`와 `{format_obj(rc)}`의 곱(Product) 대상이 선언되지 않았습니다.")
        return ld, prod_obj, lcat

    if isinstance(term, MorphCopair):
        ld, lc, lcat = infer_morphism(term.left, env)
        rd, rc, rcat = infer_morphism(term.right, env)
        if lcat != rcat or lc != rc:
            raise CatTypeError(f"쌍대곱 쌍 `[u, v]`의 공역과 범주가 일치해야 합니다 (`{format_obj(lc)}` ≠ `{format_obj(rc)}`).")
        coprod_obj = env["coproducts"].get((ld, rd))
        if not coprod_obj:
            raise CatTypeError(f"`{format_obj(ld)}`와 `{format_obj(rd)}`의 쌍대곱(Coproduct) 대상이 선언되지 않았습니다.")
        return coprod_obj, lc, lcat

    if isinstance(term, MorphBang):
        cat = check_obj(term.obj, env)
        if term.kind == "terminal":
            t_obj = env["terminals"].get(cat)
            if not t_obj:
                raise CatTypeError(f"범주 `{cat}`에 종단 대상(terminal)이 선언되지 않았습니다.")
            return term.obj, t_obj, cat
        i_obj = env["initials"].get(cat)
        if not i_obj:
            raise CatTypeError(f"범주 `{cat}`에 시초 대상(initial)이 선언되지 않았습니다.")
        return i_obj, term.obj, cat

    raise CatTypeError(f"알 수 없는 사상: {term}")


# --------------------------------------------------------------------------- Rewriting

def _reassoc_flat(term: CatTerm) -> list[CatTerm]:
    if isinstance(term, MorphComp):
        return _reassoc_flat(term.left) + _reassoc_flat(term.right)
    return [term]


def _fold_comp(items: list[CatTerm]) -> CatTerm:
    assert items
    cur = items[-1]
    for item in reversed(items[:-1]):
        cur = MorphComp(item, cur)
    return cur


def _fold_left_comp(items: list[CatTerm]) -> CatTerm:
    assert items
    cur = items[0]
    for item in items[1:]:
        cur = MorphComp(cur, item)
    return cur


def _canon_assoc(term: CatTerm) -> CatTerm:
    if isinstance(term, MorphComp):
        flat = [_canon_assoc(x) for x in _reassoc_flat(term)]
        return _fold_comp(flat)
    if isinstance(term, MorphFMap):
        return MorphFMap(term.functor, _canon_assoc(term.inner))
    if isinstance(term, MorphInv):
        return MorphInv(_canon_assoc(term.inner))
    if isinstance(term, MorphPair):
        return MorphPair(_canon_assoc(term.left), _canon_assoc(term.right))
    if isinstance(term, MorphCopair):
        return MorphCopair(_canon_assoc(term.left), _canon_assoc(term.right))
    return term


def _rewrite_once(term: CatTerm, fn):
    new_t, hit = fn(term)
    if hit:
        return new_t, True
    if isinstance(term, MorphComp):
        nl, h = _rewrite_once(term.left, fn)
        if h:
            return MorphComp(nl, term.right), True
        nr, h = _rewrite_once(term.right, fn)
        if h:
            return MorphComp(term.left, nr), True
    elif isinstance(term, MorphFMap):
        ni, h = _rewrite_once(term.inner, fn)
        if h:
            return MorphFMap(term.functor, ni), True
    elif isinstance(term, MorphInv):
        ni, h = _rewrite_once(term.inner, fn)
        if h:
            return MorphInv(ni), True
    elif isinstance(term, MorphPair):
        nl, h = _rewrite_once(term.left, fn)
        if h:
            return MorphPair(nl, term.right), True
        nr, h = _rewrite_once(term.right, fn)
        if h:
            return MorphPair(term.left, nr), True
    elif isinstance(term, MorphCopair):
        nl, h = _rewrite_once(term.left, fn)
        if h:
            return MorphCopair(nl, term.right), True
        nr, h = _rewrite_once(term.right, fn)
        if h:
            return MorphCopair(term.left, nr), True
    return term, False


def _replace_subterm(term: CatTerm, pat: CatTerm, rep: CatTerm) -> tuple[CatTerm, bool]:
    # Try exact subterm match first, then contiguous associative slice match.
    if term == pat:
        return rep, True
    if isinstance(term, MorphComp) and isinstance(pat, MorphComp):
        t_parts = _reassoc_flat(term)
        p_parts = _reassoc_flat(pat)
        k = len(p_parts)
        if k <= len(t_parts):
            for i in range(len(t_parts) - k + 1):
                if t_parts[i:i + k] == p_parts:
                    updated = t_parts[:i] + [rep] + t_parts[i + k:]
                    return _fold_comp(updated), True
    return term, False


def _diff_strings(before: str, after: str):
    if before == after:
        return before, "", "", ""
    p = 0
    lim = min(len(before), len(after))
    while p < lim and before[p] == after[p]:
        p += 1
    b_rem = before[p:]
    a_rem = after[p:]
    s = 0
    slim = min(len(b_rem), len(a_rem))
    while s < slim and b_rem[-1 - s] == a_rem[-1 - s]:
        s += 1
    prefix = before[:p]
    suffix = b_rem[len(b_rem) - s:] if s else ""
    redex = b_rem[:len(b_rem) - s] if s else b_rem
    contractum = a_rem[:len(a_rem) - s] if s else a_rem
    return prefix, redex, contractum, suffix


def _simplify_id(term: CatTerm) -> tuple[CatTerm, bool]:
    if isinstance(term, MorphComp):
        if isinstance(term.left, MorphId):
            return term.right, True
        if isinstance(term.right, MorphId):
            return term.left, True
    return term, False


def _functor_id_rule(term: CatTerm, env, *, reverse=False) -> tuple[CatTerm, bool]:
    if not reverse and isinstance(term, MorphFMap) and isinstance(term.inner, MorphId):
        return MorphId(ObjApp(term.functor, term.inner.obj)), True
    if reverse and isinstance(term, MorphId) and isinstance(term.obj, ObjApp):
        return MorphFMap(term.obj.func, MorphId(term.obj.arg)), True
    return term, False


def _functor_comp_rule(term: CatTerm, *, merge=False) -> tuple[CatTerm, bool]:
    if not merge and isinstance(term, MorphFMap) and isinstance(term.inner, MorphComp):
        return MorphComp(MorphFMap(term.functor, term.inner.left), MorphFMap(term.functor, term.inner.right)), True
    if merge and isinstance(term, MorphComp):
        parts = _reassoc_flat(term)
        for i in range(len(parts) - 1):
            a, b = parts[i], parts[i + 1]
            if isinstance(a, MorphFMap) and isinstance(b, MorphFMap) and a.functor == b.functor:
                merged = MorphFMap(a.functor, MorphComp(a.inner, b.inner))
                return _fold_comp(parts[:i] + [merged] + parts[i + 2:]), True
    return term, False


def _naturality_rule(term: CatTerm, env, nat_name: str | None = None, *, reverse=False) -> tuple[CatTerm, bool]:
    # G(f) ∘ α(A) = α(B) ∘ F(f) for α : F => G and f : A -> B
    if not isinstance(term, MorphComp):
        return term, False
    parts = _reassoc_flat(term)
    for i in range(len(parts) - 1):
        left, right = parts[i], parts[i + 1]
        if not reverse:
            # G(f) ∘ α(A) -> α(B) ∘ F(f)
            if isinstance(left, MorphFMap) and isinstance(right, MorphVar) and right.arg is not None:
                ninfo = env["nats"].get(right.name)
                if ninfo and (nat_name is None or right.name == nat_name) and left.functor == ninfo["dst_f"]:
                    f_dom, f_cod, _ = infer_morphism(left.inner, env)
                    if f_dom == right.arg:
                        rep = MorphComp(MorphVar(right.name, f_cod), MorphFMap(ninfo["src_f"], left.inner))
                        return _fold_comp(parts[:i] + [rep] + parts[i + 2:]), True
        else:
            # α(B) ∘ F(f) -> G(f) ∘ α(A)
            if isinstance(left, MorphVar) and left.arg is not None and isinstance(right, MorphFMap):
                ninfo = env["nats"].get(left.name)
                if ninfo and (nat_name is None or left.name == nat_name) and right.functor == ninfo["src_f"]:
                    f_dom, f_cod, _ = infer_morphism(right.inner, env)
                    if f_cod == left.arg:
                        rep = MorphComp(MorphFMap(ninfo["dst_f"], right.inner), MorphVar(left.name, f_dom))
                        return _fold_comp(parts[:i] + [rep] + parts[i + 2:]), True
    return term, False


def _triangle_rule(term: CatTerm, env, mode: str) -> tuple[CatTerm, bool]:
    # zig: eps(F(A)) ∘ F(eta(A)) -> id(F(A))
    # zag: G(eps(B)) ∘ eta(G(B)) -> id(G(B))
    if not isinstance(term, MorphComp):
        return term, False
    parts = _reassoc_flat(term)
    for adj in env["adjunctions"]:
        F, G, eta, eps = adj["left"], adj["right"], adj["unit"], adj["counit"]
        for i in range(len(parts) - 1):
            a, b = parts[i], parts[i + 1]
            if mode in ("zig", "both"):
                if (isinstance(a, MorphVar) and a.name == eps and isinstance(a.arg, ObjApp) and a.arg.func == F
                        and isinstance(b, MorphFMap) and b.functor == F
                        and isinstance(b.inner, MorphVar) and b.inner.name == eta and b.inner.arg == a.arg.arg):
                    rep = MorphId(ObjApp(F, b.inner.arg))
                    return _fold_comp(parts[:i] + [rep] + parts[i + 2:]), True
            if mode in ("zag", "both"):
                if (isinstance(a, MorphFMap) and a.functor == G
                        and isinstance(a.inner, MorphVar) and a.inner.name == eps
                        and isinstance(b, MorphVar) and b.name == eta and isinstance(b.arg, ObjApp)
                        and b.arg.func == G and b.arg.arg == a.inner.arg):
                    rep = MorphId(ObjApp(G, a.inner.arg))
                    return _fold_comp(parts[:i] + [rep] + parts[i + 2:]), True
    return term, False


def _product_rule(term: CatTerm, env, *, beta=True) -> tuple[CatTerm, bool]:
    if beta and isinstance(term, MorphComp):
        parts = _reassoc_flat(term)
        for i in range(len(parts) - 1):
            proj, pair = parts[i], parts[i + 1]
            if isinstance(proj, MorphVar) and isinstance(pair, MorphPair):
                pmeta = env["projections"].get(proj.name)
                if pmeta:
                    dom, cod, _ = infer_morphism(pair, env)
                    if cod == pmeta["prod"]:
                        chosen = pair.left if pmeta["which"] == 0 else pair.right
                        return _fold_comp(parts[:i] + [chosen] + parts[i + 2:]), True
    if not beta and isinstance(term, MorphPair):
        # <fst, snd> -> id(P), or <fst ∘ h, snd ∘ h> -> h
        if isinstance(term.left, MorphVar) and isinstance(term.right, MorphVar):
            lm = env["projections"].get(term.left.name)
            rm = env["projections"].get(term.right.name)
            if lm and rm and lm["prod"] == rm["prod"] and lm["which"] == 0 and rm["which"] == 1:
                return MorphId(lm["prod"]), True
        if isinstance(term.left, MorphComp) and isinstance(term.right, MorphComp) and term.left.right == term.right.right:
            lp, rp = term.left.left, term.right.left
            if isinstance(lp, MorphVar) and isinstance(rp, MorphVar):
                lm = env["projections"].get(lp.name)
                rm = env["projections"].get(rp.name)
                if lm and rm and lm["prod"] == rm["prod"] and lm["which"] == 0 and rm["which"] == 1:
                    return term.left.right, True
    return term, False


def _coproduct_rule(term: CatTerm, env, *, beta=True) -> tuple[CatTerm, bool]:
    if beta and isinstance(term, MorphComp):
        parts = _reassoc_flat(term)
        for i in range(len(parts) - 1):
            copair, inj = parts[i], parts[i + 1]
            if isinstance(copair, MorphCopair) and isinstance(inj, MorphVar):
                imeta = env["injections"].get(inj.name)
                if imeta:
                    dom, _, _ = infer_morphism(copair, env)
                    if dom == imeta["coprod"]:
                        chosen = copair.left if imeta["which"] == 0 else copair.right
                        return _fold_comp(parts[:i] + [chosen] + parts[i + 2:]), True
    if not beta and isinstance(term, MorphCopair):
        if isinstance(term.left, MorphVar) and isinstance(term.right, MorphVar):
            lm = env["injections"].get(term.left.name)
            rm = env["injections"].get(term.right.name)
            if lm and rm and lm["coprod"] == rm["coprod"] and lm["which"] == 0 and rm["which"] == 1:
                return MorphId(lm["coprod"]), True
        if isinstance(term.left, MorphComp) and isinstance(term.right, MorphComp) and term.left.left == term.right.left:
            li, ri = term.left.right, term.right.right
            if isinstance(li, MorphVar) and isinstance(ri, MorphVar):
                lm = env["injections"].get(li.name)
                rm = env["injections"].get(ri.name)
                if lm and rm and lm["coprod"] == rm["coprod"] and lm["which"] == 0 and rm["which"] == 1:
                    return term.left.left, True
    return term, False


def _iso_rule(term: CatTerm, env) -> tuple[CatTerm, bool]:
    if isinstance(term, MorphComp):
        parts = _reassoc_flat(term)
        for i in range(len(parts) - 1):
            a, b = parts[i], parts[i + 1]
            if isinstance(a, MorphInv) and a.inner == b:
                dom, _, _ = infer_morphism(b, env)
                return _fold_comp(parts[:i] + [MorphId(dom)] + parts[i + 2:]), True
            if isinstance(b, MorphInv) and b.inner == a:
                _, cod, _ = infer_morphism(a, env)
                return _fold_comp(parts[:i] + [MorphId(cod)] + parts[i + 2:]), True
    return term, False


def _uniq_bang_rule(term: CatTerm, env, kind: str) -> tuple[CatTerm, bool]:
    dom, cod, cat = infer_morphism(term, env)
    if kind == "terminal":
        t_obj = env["terminals"].get(cat)
        if t_obj and cod == t_obj and not isinstance(term, MorphBang):
            return MorphBang(dom, "terminal"), True
    else:
        i_obj = env["initials"].get(cat)
        if i_obj and dom == i_obj and not isinstance(term, MorphBang):
            return MorphBang(cod, "initial"), True
    return term, False


def _full_normalize(term: CatTerm, env) -> CatTerm:
    cur = _canon_assoc(term)
    for _ in range(16):
        prev = cur
        for fn in (
            _simplify_id,
            lambda t: _functor_id_rule(t, env, reverse=False),
            lambda t: _functor_comp_rule(t, merge=False),
            lambda t: _iso_rule(t, env),
            lambda t: _product_rule(t, env, beta=True),
            lambda t: _coproduct_rule(t, env, beta=True),
            lambda t: _triangle_rule(t, env, "both"),
        ):
            while True:
                nxt, hit = _rewrite_once(cur, fn)
                if not hit:
                    break
                cur = _canon_assoc(nxt)
        if cur == prev:
            break
    return cur


# --------------------------------------------------------------------------- Diagram Layout

def _collect_morph_refs(term: CatTerm, refs=None):
    if refs is None:
        refs = []
    if isinstance(term, MorphVar):
        refs.append(term.name)
    elif isinstance(term, MorphComp):
        _collect_morph_refs(term.left, refs)
        _collect_morph_refs(term.right, refs)
    elif isinstance(term, MorphFMap):
        refs.append(term.functor)
        _collect_morph_refs(term.inner, refs)
    elif isinstance(term, MorphInv):
        refs.append("inv")
        _collect_morph_refs(term.inner, refs)
    elif isinstance(term, MorphPair):
        _collect_morph_refs(term.left, refs)
        _collect_morph_refs(term.right, refs)
    elif isinstance(term, MorphCopair):
        _collect_morph_refs(term.left, refs)
        _collect_morph_refs(term.right, refs)
    return refs


def _build_diagram(env):
    cats = list(env["categories"]) or ["C"]
    cat_count = len(cats)
    cat_index = {c: idx for idx, c in enumerate(cats)}
    by_cat = {c: [] for c in cats}
    for name, info in env["objects"].items():
        by_cat.setdefault(info["category"], []).append(name)

    nodes = []
    pos_map = {}
    band_w = 880 / max(1, cat_count)
    for c in cats:
        idx = cat_index[c]
        cx = 100 + band_w * idx + band_w * 0.5
        objs = by_cat.get(c, [])
        n = len(objs)
        radius_x = min(band_w * 0.36, 175)
        radius_y = 185 if n > 2 else 110
        for i, name in enumerate(objs):
            if n == 1:
                x, y = cx, 290
            elif n == 2:
                x, y = cx - 95 + i * 190, 290
            else:
                angle = -math.pi / 2 + (2 * math.pi * i) / n
                x = cx + radius_x * math.cos(angle)
                y = 290 + radius_y * math.sin(angle)
            nodes.append({
                "id": name,
                "label": name,
                "category": c,
                "x": round(x, 1),
                "y": round(y, 1),
                "special": "terminal" if env["terminals"].get(c) == ObjName(name)
                else ("initial" if env["initials"].get(c) == ObjName(name) else "object"),
            })
            pos_map[name] = (x, y)

    # Also register any derived F(A) / A×B / A+B object nodes seen in morphisms so arrows connect cleanly.
    def ensure_node(obj_term: CatTerm, cat: str) -> str:
        label = format_obj(obj_term)
        if label in pos_map:
            return label
        base_x, base_y = pos_map.get(getattr(obj_term, "name", ""), (100 + band_w * cat_index.get(cat, 0) + band_w * 0.5, 290))
        if isinstance(obj_term, ObjApp):
            arg_lbl = ensure_node(obj_term.arg, env["functors"].get(obj_term.func, {}).get("src", cat))
            ax, ay = pos_map.get(arg_lbl, (base_x, base_y))
            idx = cat_index.get(cat, 0)
            x = 100 + band_w * idx + band_w * 0.5 + ((len(nodes) % 3) - 1) * 85
            y = min(495, max(95, ay + (len(nodes) % 2) * 35))
        elif isinstance(obj_term, (ObjProd, ObjCoprod)):
            l_lbl = ensure_node(obj_term.left, cat)
            r_lbl = ensure_node(obj_term.right, cat)
            lx, ly = pos_map[l_lbl]
            rx, ry = pos_map[r_lbl]
            x, y = (lx + rx) / 2, (ly + ry) / 2 - 75
        else:
            idx = cat_index.get(cat, 0)
            x = 100 + band_w * idx + band_w * 0.5
            y = 140 + (len(nodes) * 55) % 320
        nodes.append({"id": label, "label": label, "category": cat, "x": round(x, 1), "y": round(y, 1), "special": "derived"})
        pos_map[label] = (x, y)
        return label

    edges = []
    pair_counts = {}
    for name, minfo in env["morphisms"].items():
        s_lbl = ensure_node(minfo["dom"], minfo["category"])
        t_lbl = ensure_node(minfo["cod"], minfo["category"])
        pair_key = tuple(sorted((s_lbl, t_lbl)))
        occ = pair_counts.get(pair_key, 0)
        pair_counts[pair_key] = occ + 1
        edges.append({
            "id": name,
            "label": f"{name} : {s_lbl} → {t_lbl}",
            "name": name,
            "source": s_lbl,
            "target": t_lbl,
            "category": minfo["category"],
            "curveIndex": occ,
            "kind": minfo.get("kind", "morphism"),
        })

    # String-diagram dual wires for morphisms & functors
    string_wires = [
        {"name": m["name"], "dom": m["source"], "cod": m["target"], "category": m["category"], "kind": m["kind"]}
        for m in edges
    ]
    return {"mode": "quiver", "nodes": nodes, "edges": edges, "stringWires": string_wires, "categories": cats}


# --------------------------------------------------------------------------- Main Checker

_HINT_MAP = {
    "id_left": "항등 사상의 왼쪽 합성 `id(B) ∘ f = f` 를 제거합니다.",
    "id_right": "항등 사상의 오른쪽 합성 `f ∘ id(A) = f` 를 제거합니다.",
    "simp_id": "양쪽 항등 사상 `id` 를 한꺼번에 소거합니다.",
    "assoc": "사상 합성의 결합법칙 `(h ∘ g) ∘ f = h ∘ (g ∘ f)` 로 괄호를 정규화합니다.",
    "functor_id": "함자의 항등 보존 공리 `F(id(A)) = id(F(A))` 를 적용합니다.",
    "functor_comp": "함자의 합성 분배 공리 `F(g ∘ f) = F(g) ∘ F(f)` 로 전개합니다.",
    "functor_merge": "함자 상의 합성 `F(g) ∘ F(f)` 을 `F(g ∘ f)` 로 병합합니다.",
    "naturality": "자연 변환의 가환 사각형 공리 `G(f) ∘ α(A) = α(B) ∘ F(f)` 를 적용합니다.",
    "product_beta": "곱 보편성 β-축약 `π₁ ∘ ⟨u, v⟩ = u`, `π₂ ∘ ⟨u, v⟩ = v` 를 계산합니다.",
    "product_eta": "곱 보편성 η-확장 `⟨π₁ ∘ h, π₂ ∘ h⟩ = h` 를 적용합니다.",
    "coproduct_beta": "쌍대곱 β-축약 `[u, v] ∘ ι₁ = u`, `[u, v] ∘ ι₂ = v` 를 계산합니다.",
    "coproduct_eta": "쌍대곱 η-동치 `[h ∘ ι₁, h ∘ ι₂] = h` 를 적용합니다.",
    "iso_cancel": "동형 사상과 역사상의 합성 `inv(u) ∘ u = id` 를 소거합니다.",
    "terminal_uniq": "종단 대상(1)으로 향하는 사상의 유일성을 적용합니다.",
    "initial_uniq": "시초 대상(0)에서 나오는 사상의 유일성을 적용합니다.",
    "zig": "수반 함자(Adjunction) 첫 번째 삼각 항등식 `ε(F(A)) ∘ F(η(A)) = id(F(A))` 를 적용합니다.",
    "zag": "수반 함자(Adjunction) 두 번째 삼각 항등식 `G(ε(B)) ∘ η(G(B)) = id(G(B))` 를 적용합니다.",
    "rw": "지정한 등식 공리/정리로 현재 명제의 부분식을 치환합니다.",
    "symm": "목표 등식의 좌변과 우변을 맞바꿉니다.",
    "normalize": "범주론 공리들을 자동 정규형으로 축약·계산합니다.",
    "rfl": "양변이 동일한 사상임을 확인해 증명을 종결합니다.",
}


def verify_and_visualize(file_path: str, source: str):
    """Parse, type-check, verify proofs, and build Category Theory diagram & step trace."""
    lines = source.replace("\r\n", "\n").split("\n")
    env = {
        "categories": [],
        "objects": {},
        "morphisms": {},
        "indexed_morphs": {},
        "functors": {},
        "nats": {},
        "adjunctions": [],
        "isos": set(),
        "terminals": {},
        "initials": {},
        "products": {},
        "coproducts": {},
        "projections": {},
        "injections": {},
        "laws": {},
    }

    steps = []
    theorems = []
    in_block = False
    cur_thm = None  # active theorem proof state
    first_error = None

    def ensure_cat(cat_name=None):
        if cat_name:
            if cat_name not in env["categories"]:
                env["categories"].append(cat_name)
            return cat_name
        if not env["categories"]:
            env["categories"].append("C")
        return env["categories"][-1]

    def record_error(line_no, raw_line, msg, tactic="error"):
        nonlocal first_error
        if first_error is None:
            first_error = f"{line_no}행: {msg}"
        steps.append({
            "index": len(steps),
            "line": line_no,
            "endLine": line_no,
            "code": raw_line,
            "tactic": tactic,
            "hint": msg,
            "theorem": cur_thm["name"] if cur_thm else None,
            "status": "error",
            "goal": None,
            "computation": {"operation": "오류 (Type / Proof Error)", "summary": msg, "rules": []},
            "highlightEdges": [],
        })

    for idx, raw_line in enumerate(lines, start=1):
        stripped = raw_line.strip()
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
        # Strip inline `--` comment
        code_line = raw_line.split("--", 1)[0].strip()
        if not code_line:
            continue

        try:
            # 1) Proof block tactic when inside an active theorem
            if cur_thm is not None and not re.match(
                r"^(category|object|objects|morphism|hom|iso|terminal|initial|product|coproduct|functor|nat|adjunction|axiom|theorem|lemma|example)\b",
                code_line,
            ):
                lhs, rhs = cur_thm["lhs"], cur_thm["rhs"]
                before_lhs_str, before_rhs_str = format_morph(lhs), format_morph(rhs)
                parts = code_line.split(None, 1)
                tactic = parts[0].lstrip("·•-*").strip()
                arg = parts[1].strip() if len(parts) > 1 else ""
                rule_used = []
                new_lhs, new_rhs = lhs, rhs
                solved_here = False
                op = f"전술 적용 ({tactic})"

                if tactic in ("id_left", "id_right", "simp_id"):
                    def apply_id_all(t):
                        if tactic == "id_left":
                            return (t.right, True) if isinstance(t, MorphComp) and isinstance(t.left, MorphId) else (t, False)
                        if tactic == "id_right":
                            return (t.left, True) if isinstance(t, MorphComp) and isinstance(t.right, MorphId) else (t, False)
                        return _simplify_id(t)
                    new_lhs, h1 = _rewrite_once(lhs, apply_id_all)
                    new_rhs, h2 = _rewrite_once(rhs, apply_id_all)
                    while tactic == "simp_id":
                        nl, hh1 = _rewrite_once(new_lhs, apply_id_all)
                        nr, hh2 = _rewrite_once(new_rhs, apply_id_all)
                        new_lhs, new_rhs = nl, nr
                        if not hh1 and not hh2:
                            break
                        h1 = h1 or hh1
                        h2 = h2 or hh2
                    if not (h1 or h2):
                        raise CatTypeError(f"`{tactic}`로 소거할 항등 사상이 없습니다.")
                    rule_used.append({"name": tactic, "signature": "id(B) ∘ f = f, f ∘ id(A) = f"})
                    op = f"항등 소거 ({tactic})"
                elif tactic in ("assoc", "assoc_left", "assoc_right"):
                    new_lhs = _fold_left_comp(_reassoc_flat(lhs)) if tactic == "assoc_left" else _canon_assoc(lhs)
                    new_rhs = _fold_left_comp(_reassoc_flat(rhs)) if tactic == "assoc_left" else _canon_assoc(rhs)
                    rule_used.append({"name": tactic, "signature": "(h ∘ g) ∘ f = h ∘ (g ∘ f)"})
                    op = "결합법칙 정규화 (assoc)"
                elif tactic == "functor_id":
                    rev = arg.startswith(("<-", "←"))
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _functor_id_rule(t, env, reverse=rev))
                    new_rhs, h2 = _rewrite_once(rhs, lambda t: _functor_id_rule(t, env, reverse=rev))
                    if not (h1 or h2):
                        raise CatTypeError("`F(id(A))` 또는 `id(F(A))` 패턴을 찾지 못했습니다.")
                    rule_used.append({"name": "functor_id", "signature": "F(id(A)) = id(F(A))"})
                    op = "함자 항등 보존 (F(id) = id(F))"
                elif tactic in ("functor_comp", "functor_merge"):
                    merge = tactic == "functor_merge" or arg == "merge"
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _functor_comp_rule(t, merge=merge))
                    new_rhs, h2 = _rewrite_once(rhs, lambda t: _functor_comp_rule(t, merge=merge))
                    if not (h1 or h2):
                        raise CatTypeError("함자 합성 법칙을 적용할 부분식을 찾지 못했습니다.")
                    rule_used.append({"name": tactic, "signature": "F(g ∘ f) = F(g) ∘ F(f)"})
                    op = "함자 합성 법칙"
                elif tactic == "naturality":
                    rev = False
                    nat_arg = arg
                    if nat_arg.startswith(("<-", "←")):
                        rev = True
                        nat_arg = nat_arg.lstrip("<-←").strip()
                    nat_name = nat_arg or None
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _naturality_rule(t, env, nat_name, reverse=rev))
                    new_rhs, h2 = (new_rhs, False) if h1 else _rewrite_once(rhs, lambda t: _naturality_rule(t, env, nat_name, reverse=rev))
                    if not (h1 or h2):
                        raise CatTypeError("자연성 사각형 `G(f) ∘ α(A) ↔ α(B) ∘ F(f)` 패턴을 찾지 못했습니다.")
                    rule_used.append({"name": f"naturality {nat_arg}".strip(), "signature": "G(f) ∘ α(A) = α(B) ∘ F(f)"})
                    op = "자연성 치환 (Naturality Square)"
                elif tactic in ("product_beta", "product_eta"):
                    beta = tactic == "product_beta"
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _product_rule(t, env, beta=beta))
                    new_rhs, h2 = _rewrite_once(rhs, lambda t: _product_rule(t, env, beta=beta))
                    if not (h1 or h2):
                        raise CatTypeError("곱(Product) 보편성 패턴을 찾지 못했습니다.")
                    rule_used.append({"name": tactic, "signature": "fst ∘ ⟨u,v⟩ = u, ⟨fst ∘ h, snd ∘ h⟩ = h"})
                    op = "곱 보편성 축약"
                elif tactic in ("coproduct_beta", "coproduct_eta"):
                    beta = tactic == "coproduct_beta"
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _coproduct_rule(t, env, beta=beta))
                    new_rhs, h2 = _rewrite_once(rhs, lambda t: _coproduct_rule(t, env, beta=beta))
                    if not (h1 or h2):
                        raise CatTypeError("쌍대곱(Coproduct) 보편성 패턴을 찾지 못했습니다.")
                    rule_used.append({"name": tactic, "signature": "[u,v] ∘ inl = u, [h ∘ inl, h ∘ inr] = h"})
                    op = "쌍대곱 보편성 축약"
                elif tactic == "iso_cancel":
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _iso_rule(t, env))
                    new_rhs, h2 = _rewrite_once(rhs, lambda t: _iso_rule(t, env))
                    if not (h1 or h2):
                        raise CatTypeError("소거 가능한 동형 사상 `inv(u) ∘ u` 또는 `u ∘ inv(u)`가 없습니다.")
                    rule_used.append({"name": "iso_cancel", "signature": "inv(u) ∘ u = id, u ∘ inv(u) = id"})
                    op = "동형 역원 소거"
                elif tactic in ("terminal_uniq", "initial_uniq"):
                    k = "terminal" if tactic == "terminal_uniq" else "initial"
                    new_lhs, h1 = _uniq_bang_rule(lhs, env, k)
                    new_rhs, h2 = _uniq_bang_rule(rhs, env, k)
                    if not (h1 or h2):
                        raise CatTypeError("종단/시초 대상 보편 유일성을 적용할 수 없습니다.")
                    rule_used.append({"name": tactic, "signature": "∀ f g : X → 1, f = g"})
                    op = "보편 유일성 정규화"
                elif tactic in ("zig", "zag"):
                    new_lhs, h1 = _rewrite_once(lhs, lambda t: _triangle_rule(t, env, tactic))
                    new_rhs, h2 = _rewrite_once(rhs, lambda t: _triangle_rule(t, env, tactic))
                    if not (h1 or h2):
                        raise CatTypeError(f"`{tactic}` 삼각 항등식 패턴이 현재 목표에 없습니다.")
                    sig = "ε(F(A)) ∘ F(η(A)) = id(F(A))" if tactic == "zig" else "G(ε(B)) ∘ η(G(B)) = id(G(B))"
                    rule_used.append({"name": tactic, "signature": sig})
                    op = f"수반 함자 삼각 항등식 ({tactic})"
                elif tactic == "symm":
                    new_lhs, new_rhs = rhs, lhs
                    rule_used.append({"name": "symm", "signature": "a = b  ⇒  b = a"})
                    op = "등식 대칭 교환"
                elif tactic in ("rw", "rewrite"):
                    raw_names = arg.strip("[]")
                    rule_names = [r.strip() for r in raw_names.split(",") if r.strip()]
                    if not rule_names:
                        raise CatTypeError("`rw [규칙이름]` 형식으로 사용할 등식을 지정하세요.")
                    for rspec in rule_names:
                        rev = rspec.startswith(("<-", "←"))
                        rname = rspec.lstrip("<-←").strip()
                        if rname not in env["laws"]:
                            raise CatTypeError(f"선언되지 않은 등식 공리/정리: `{rname}`")
                        rlhs, rrhs = env["laws"][rname]
                        pat, rep = (rrhs, rlhs) if rev else (rlhs, rrhs)
                        nl, h1 = _rewrite_once(new_lhs, lambda t, p=pat, r=rep: _replace_subterm(t, p, r))
                        nr, h2 = (new_rhs, False) if h1 else _rewrite_once(new_rhs, lambda t, p=pat, r=rep: _replace_subterm(t, p, r))
                        if not (h1 or h2):
                            raise CatTypeError(f"등식 `{rname}` (`{format_morph(pat)} → {format_morph(rep)}`)과 일치하는 부분식을 찾지 못했습니다.")
                        new_lhs, new_rhs = nl, nr
                        rule_used.append({"name": rspec, "signature": f"{format_morph(rlhs)} = {format_morph(rrhs)}"})
                    op = "등식 치환 (Rewrite)"
                elif tactic in ("normalize", "simp"):
                    new_lhs = _full_normalize(lhs, env)
                    new_rhs = _full_normalize(rhs, env)
                    rule_used.append({"name": "normalize", "signature": "id / functor / beta / triangle normalization"})
                    op = "범주 공리 자동 정규화"
                elif tactic in ("rfl", "qed"):
                    nl = _full_normalize(lhs, env)
                    nr = _full_normalize(rhs, env)
                    if nl != nr:
                        raise CatTypeError(f"양변이 일치하지 않습니다: `{format_morph(nl)}` ≠ `{format_morph(nr)}`")
                    new_lhs, new_rhs = nl, nr
                    solved_here = True
                    rule_used.append({"name": "rfl", "signature": "f = f"})
                    op = "반사율 종결 (Q.E.D. ✓)"
                else:
                    raise ParseError(f"알 수 없는 범주론 전술: `{tactic}`")

                cur_thm["lhs"], cur_thm["rhs"] = new_lhs, new_rhs
                after_lhs_str, after_rhs_str = format_morph(new_lhs), format_morph(new_rhs)
                if solved_here or (_canon_assoc(new_lhs) == _canon_assoc(new_rhs) and tactic in ("rfl", "qed")):
                    solved_here = True
                if solved_here:
                    env["laws"][cur_thm["name"]] = (cur_thm["orig_lhs"], cur_thm["orig_rhs"])
                    cur_thm["verified"] = True

                before_goal = f"{before_lhs_str}  =  {before_rhs_str}"
                after_goal = "Q.E.D. ✓" if solved_here else f"{after_lhs_str}  =  {after_rhs_str}"
                prefix, redex, contractum, suffix = _diff_strings(before_lhs_str, after_lhs_str)
                if not redex and before_rhs_str != after_rhs_str:
                    prefix, redex, contractum, suffix = _diff_strings(before_rhs_str, after_rhs_str)
                summary = (
                    f"정리 `{cur_thm['name']}`의 양변이 `{format_morph(new_lhs)}` 로 일치해 증명이 완료되었습니다."
                    if solved_here
                    else f"`{before_lhs_str}` → `{after_lhs_str}` 로 사상 합성이 변환되었습니다."
                )
                refs = list(dict.fromkeys(_collect_morph_refs(new_lhs) + _collect_morph_refs(new_rhs)))
                steps.append({
                    "index": len(steps),
                    "line": idx,
                    "endLine": idx,
                    "code": raw_line,
                    "tactic": tactic,
                    "hint": _HINT_MAP.get(tactic, "범주론 전술을 적용합니다."),
                    "theorem": cur_thm["name"],
                    "status": "solved" if solved_here else "open",
                    "goal": {
                        "lhs": after_lhs_str,
                        "rhs": after_rhs_str,
                        "dom": format_obj(cur_thm["dom"]),
                        "cod": format_obj(cur_thm["cod"]),
                        "cat": cur_thm["cat"],
                    },
                    "computation": {
                        "operation": op,
                        "before": before_goal,
                        "after": after_goal,
                        "prefix": prefix,
                        "redex": redex,
                        "contractum": contractum,
                        "suffix": suffix,
                        "rules": rule_used,
                        "summary": summary,
                    },
                    "highlightEdges": refs,
                })
                if solved_here:
                    cur_thm = None
                continue

            # If a new declaration started while previous theorem wasn't closed with rfl/qed
            if cur_thm is not None:
                raise CatTypeError(f"정리 `{cur_thm['name']}` 증명이 `rfl` 또는 `qed`로 닫히지 않았습니다.")

            # 2) Top-level declarations
            if code_line.startswith("category "):
                names = [x.strip() for x in re.split(r"[\s,]+", code_line[len("category "):].strip()) if x.strip()]
                for c in names:
                    ensure_cat(c)
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "category", "hint": f"범주 {', '.join(names)} 를 선언합니다.",
                    "status": "decl", "highlightEdges": [],
                })
            elif code_line.startswith(("object ", "objects ")):
                body = code_line.split(None, 1)[1]
                cat = None
                if ":" in body:
                    left, cat_part = body.rsplit(":", 1)
                    cat = ensure_cat(cat_part.strip())
                else:
                    left = body
                    cat = ensure_cat()
                names = [x.strip() for x in re.split(r"[\s,]+", left.strip()) if x.strip()]
                for obj_name in names:
                    env["objects"][obj_name] = {"category": cat}
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "object", "hint": f"범주 {cat} 의 대상 {', '.join(names)} 를 선언합니다.",
                    "status": "decl", "highlightEdges": [],
                })
            elif code_line.startswith(("morphism ", "hom ")):
                body = code_line.split(None, 1)[1]
                cat = None
                if re.search(r"\s+in\s+[A-Za-z0-9_']+$", body):
                    body, cat_part = re.split(r"\s+in\s+", body, maxsplit=1)
                    cat = ensure_cat(cat_part.strip())
                name_part, sig_part = body.split(":", 1)
                names = [x.strip() for x in re.split(r"[\s,]+", name_part.strip()) if x.strip()]
                arrow = "->" if "->" in sig_part else "→"
                dom_str, cod_str = sig_part.split(arrow, 1)
                dom = parse_obj_expr(dom_str, env)
                cod = parse_obj_expr(cod_str, env)
                dc = check_obj(dom, env)
                cc = check_obj(cod, env)
                if dc != cc:
                    raise CatTypeError(f"사상 `{names[0]}`의 정의역(`{dc}`)과 공역(`{cc}`) 범주가 다릅니다.")
                use_cat = cat or dc
                for mname in names:
                    env["morphisms"][mname] = {"dom": dom, "cod": cod, "category": use_cat, "kind": "morphism"}
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "morphism", "hint": f"사상 {', '.join(names)} : {format_obj(dom)} → {format_obj(cod)} 선언",
                    "status": "decl", "highlightEdges": names,
                })
            elif code_line.startswith("iso "):
                body = code_line[4:].strip()
                name_part, sig_part = body.split(":", 1)
                mname = name_part.strip()
                sep = "<->" if "<->" in sig_part else ("↔" if "↔" in sig_part else "≅")
                dom_str, cod_str = sig_part.split(sep, 1)
                dom = parse_obj_expr(dom_str, env)
                cod = parse_obj_expr(cod_str, env)
                dc, cc = check_obj(dom, env), check_obj(cod, env)
                if dc != cc:
                    raise CatTypeError("동형사상의 양쪽 대상은 같은 범주에 있어야 합니다.")
                env["morphisms"][mname] = {"dom": dom, "cod": cod, "category": dc, "kind": "iso"}
                env["isos"].add(mname)
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "iso", "hint": f"동형 사상 `{mname} : {format_obj(dom)} ≅ {format_obj(cod)}` (가역)",
                    "status": "decl", "highlightEdges": [mname],
                })
            elif code_line.startswith(("terminal ", "initial ")):
                kind = "terminal" if code_line.startswith("terminal ") else "initial"
                body = code_line.split(None, 1)[1].strip()
                if ":" in body:
                    obj_name, cat_part = body.split(":", 1)
                    cat = ensure_cat(cat_part.strip())
                else:
                    obj_name, cat = body, ensure_cat()
                obj_name = obj_name.strip()
                env["objects"][obj_name] = {"category": cat}
                if kind == "terminal":
                    env["terminals"][cat] = ObjName(obj_name)
                else:
                    env["initials"][cat] = ObjName(obj_name)
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": kind, "hint": f"범주 {cat} 의 {'종단' if kind == 'terminal' else '시초'} 대상 `{obj_name}`",
                    "status": "decl", "highlightEdges": [],
                })
            elif code_line.startswith(("product ", "coproduct ")):
                is_prod = code_line.startswith("product ")
                body = code_line.split(None, 1)[1].strip()
                m = re.match(r"^([A-Za-z0-9_']+)\s+of\s+([^,]+),\s*(.+)$", body)
                if not m:
                    raise ParseError("`product P of A, B` 형식으로 선언하세요.")
                p_name, a_name, b_name = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
                a_obj, b_obj = parse_obj_expr(a_name, env), parse_obj_expr(b_name, env)
                ac, bc = check_obj(a_obj, env), check_obj(b_obj, env)
                if ac != bc:
                    raise CatTypeError("곱/쌍대곱의 두 성분은 같은 범주에 있어야 합니다.")
                p_obj = ObjName(p_name)
                env["objects"][p_name] = {"category": ac}
                if is_prod:
                    env["products"][(a_obj, b_obj)] = p_obj
                    env["morphisms"]["fst"] = {"dom": p_obj, "cod": a_obj, "category": ac, "kind": "projection"}
                    env["morphisms"]["snd"] = {"dom": p_obj, "cod": b_obj, "category": ac, "kind": "projection"}
                    env["projections"]["fst"] = {"prod": p_obj, "which": 0}
                    env["projections"]["snd"] = {"prod": p_obj, "which": 1}
                    hl = ["fst", "snd"]
                else:
                    env["coproducts"][(a_obj, b_obj)] = p_obj
                    env["morphisms"]["inl"] = {"dom": a_obj, "cod": p_obj, "category": ac, "kind": "injection"}
                    env["morphisms"]["inr"] = {"dom": b_obj, "cod": p_obj, "category": ac, "kind": "injection"}
                    env["injections"]["inl"] = {"coprod": p_obj, "which": 0}
                    env["injections"]["inr"] = {"coprod": p_obj, "which": 1}
                    hl = ["inl", "inr"]
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "product" if is_prod else "coproduct",
                    "hint": f"{'곱' if is_prod else '쌍대곱'} `{p_name}` 및 사영/단사 사상 등록",
                    "status": "decl", "highlightEdges": hl,
                })
            elif code_line.startswith("functor "):
                body = code_line[8:].strip()
                fname, sig = body.split(":", 1)
                fname = fname.strip()
                arrow = "->" if "->" in sig else "→"
                src, dst = sig.split(arrow, 1)
                src_c, dst_c = ensure_cat(src.strip()), ensure_cat(dst.strip())
                env["functors"][fname] = {"src": src_c, "dst": dst_c}
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "functor", "hint": f"함자 `{fname} : {src_c} → {dst_c}` 선언",
                    "status": "decl", "highlightEdges": [fname],
                })
            elif code_line.startswith("nat "):
                body = code_line[4:].strip()
                nname, sig = body.split(":", 1)
                nname = nname.strip()
                sep = "=>" if "=>" in sig else "⇒"
                sf, df = sig.split(sep, 1)
                sf, df = sf.strip(), df.strip()
                if sf not in env["functors"] or df not in env["functors"]:
                    raise CatTypeError("자연변환의 양쪽은 선언된 함자여야 합니다.")
                f1, f2 = env["functors"][sf], env["functors"][df]
                if f1["src"] != f2["src"] or f1["dst"] != f2["dst"]:
                    raise CatTypeError(f"자연변환 `{nname}`의 두 함자 `{sf}`, `{df}`의 시작/도착 범주가 일치해야 합니다.")
                env["nats"][nname] = {"src_f": sf, "dst_f": df, "cat": f1["dst"]}
                env["indexed_morphs"][nname] = {
                    "param_cat": f1["src"],
                    "cat": f1["dst"],
                    "dom_fn": lambda a, f=sf: ObjApp(f, a),
                    "cod_fn": lambda a, g=df: ObjApp(g, a),
                }
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "nat", "hint": f"자연 변환 `{nname} : {sf} ⇒ {df}` 선언",
                    "status": "decl", "highlightEdges": [nname],
                })
            elif code_line.startswith("adjunction "):
                # adjunction F -| G : C <-> D   [unit eta counit eps]
                m = re.match(r"^adjunction\s+([A-Za-z0-9_']+)\s*(?:-\||⊣)\s*([A-Za-z0-9_']+)\s*:\s*([A-Za-z0-9_']+)\s*(?:<->|↔)\s*([A-Za-z0-9_']+)(?:\s+unit\s+([A-Za-z0-9_']+)\s+counit\s+([A-Za-z0-9_']+))?$", code_line)
                if not m:
                    raise ParseError("`adjunction F -| G : C <-> D` 형식으로 선언하세요.")
                F, G, C, D = m.group(1), m.group(2), ensure_cat(m.group(3)), ensure_cat(m.group(4))
                unit = m.group(5) or "eta"
                counit = m.group(6) or "eps"
                env["functors"].setdefault(F, {"src": C, "dst": D})
                env["functors"].setdefault(G, {"src": D, "dst": C})
                env["indexed_morphs"][unit] = {
                    "param_cat": C, "cat": C,
                    "dom_fn": lambda a: a,
                    "cod_fn": lambda a, gg=G, ff=F: ObjApp(gg, ObjApp(ff, a)),
                }
                env["indexed_morphs"][counit] = {
                    "param_cat": D, "cat": D,
                    "dom_fn": lambda b, ff=F, gg=G: ObjApp(ff, ObjApp(gg, b)),
                    "cod_fn": lambda b: b,
                }
                env["adjunctions"].append({"left": F, "right": G, "src": C, "dst": D, "unit": unit, "counit": counit})
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "adjunction", "hint": f"수반 함자 `{F} ⊣ {G}` (단위 `{unit}`, 쌍대단위 `{counit}`)",
                    "status": "decl", "highlightEdges": [F, G, unit, counit],
                })
            elif code_line.startswith("axiom "):
                body = code_line[6:].strip()
                aname, eq_part = body.split(":", 1)
                aname = aname.strip()
                lhs, rhs = parse_eq_expr(eq_part, env)
                ld, lc, lcat = infer_morphism(lhs, env)
                rd, rc, rcat = infer_morphism(rhs, env)
                if (ld, lc, lcat) != (rd, rc, rcat):
                    raise CatTypeError(f"공리 `{aname}`의 양변 사상 타입이 다릅니다.")
                env["laws"][aname] = (lhs, rhs)
                steps.append({
                    "index": len(steps), "line": idx, "endLine": idx, "code": raw_line,
                    "tactic": "axiom", "hint": f"가환 등식 공리 `{aname}` 등록",
                    "goal": {"lhs": format_morph(lhs), "rhs": format_morph(rhs), "dom": format_obj(ld), "cod": format_obj(lc), "cat": lcat},
                    "status": "decl", "highlightEdges": list(dict.fromkeys(_collect_morph_refs(lhs) + _collect_morph_refs(rhs))),
                })
            elif code_line.startswith(("theorem ", "lemma ", "example ")):
                body = code_line.split(None, 1)[1].strip()
                if body.endswith(" by"):
                    body = body[:-3].strip()
                tname, eq_part = body.split(":", 1)
                tname = tname.strip()
                lhs, rhs = parse_eq_expr(eq_part, env)
                ld, lc, lcat = infer_morphism(lhs, env)
                rd, rc, rcat = infer_morphism(rhs, env)
                if (ld, lc, lcat) != (rd, rc, rcat):
                    raise CatTypeError(
                        f"정리 `{tname}` 양변의 타입 불일치: 좌변 `{format_obj(ld)} → {format_obj(lc)}` vs 우변 `{format_obj(rd)} → {format_obj(rc)}`"
                    )
                cur_thm = {
                    "name": tname,
                    "line": idx,
                    "lhs": lhs,
                    "rhs": rhs,
                    "orig_lhs": lhs,
                    "orig_rhs": rhs,
                    "dom": ld,
                    "cod": lc,
                    "cat": lcat,
                    "verified": False,
                }
                theorems.append(cur_thm)
                refs = list(dict.fromkeys(_collect_morph_refs(lhs) + _collect_morph_refs(rhs)))
                steps.append({
                    "index": len(steps),
                    "line": idx,
                    "endLine": idx,
                    "code": raw_line,
                    "tactic": "theorem",
                    "hint": f"정리 `{tname}` 목표 설정",
                    "theorem": tname,
                    "status": "open",
                    "goal": {
                        "lhs": format_morph(lhs),
                        "rhs": format_morph(rhs),
                        "dom": format_obj(ld),
                        "cod": format_obj(lc),
                        "cat": lcat,
                    },
                    "computation": {
                        "operation": "목표 명제 초기화",
                        "before": f"{format_morph(lhs)}  =  {format_morph(rhs)}",
                        "after": f"{format_morph(lhs)}  =  {format_morph(rhs)}",
                        "prefix": "",
                        "redex": "",
                        "contractum": "",
                        "suffix": "",
                        "rules": [],
                        "summary": f"`{format_obj(ld)} → {format_obj(lc)}` 사상 등식을 증명합니다.",
                    },
                    "highlightEdges": refs,
                })
            else:
                raise ParseError(f"알 수 없는 범주론 문장: `{code_line}`")
        except (ParseError, CatTypeError, ValueError) as exc:
            record_error(idx, raw_line, str(exc))
            if cur_thm is not None:
                cur_thm = None

    if cur_thm is not None:
        msg = f"정리 `{cur_thm['name']}`의 증명이 `rfl` 또는 `qed`로 종결되지 않았습니다."
        record_error(cur_thm["line"], f"theorem {cur_thm['name']}", msg, tactic="incomplete")

    ok = first_error is None and all(t["verified"] for t in theorems)
    verified_count = sum(1 for t in theorems if t["verified"])
    if not first_error and theorems:
        summary_out = f"범주론 검증 통과 · 정리 {verified_count}/{len(theorems)}개 증명 완료 ({len(steps)}단계)"
    elif not first_error:
        summary_out = f"범주론 선언 검사 통과 · 대상 {len(env['objects'])}개 · 사상 {len(env['morphisms'])}개"
    else:
        summary_out = first_error

    diagram = _build_diagram(env)
    pipeline = [
        {"id": "parse", "label": "범주 구문 분석", "status": "ok" if not first_error else "error",
         "detail": f"범주 {len(env['categories'])}개 · 대상 {len(env['objects'])}개"},
        {"id": "type", "label": "정의역·공역 검사", "status": "ok" if not first_error else "error",
         "detail": f"사상 {len(env['morphisms'])}개 · 함자 {len(env['functors'])}개"},
        {"id": "proof", "label": "도식 가환 증명", "status": "ok" if ok else "error",
         "detail": f"정리 {verified_count}/{len(theorems)}개 완료" if theorems else "선언 전용"},
        {"id": "diagram", "label": "Quiver/String 생성", "status": "ok",
         "detail": f"노드 {len(diagram['nodes'])}개 · 화살 {len(diagram['edges'])}개"},
    ]

    return {
        "exitCode": 0 if ok else 1,
        "outputs": [{"output_type": "stream", "name": "stdout" if ok else "stderr", "text": summary_out}],
        "visualization": {
            "kind": "category",
            "path": file_path,
            "ok": ok,
            "objects": [{"name": k, "category": v["category"]} for k, v in env["objects"].items()],
            "morphisms": diagram["edges"],
            "functors": [{"name": k, **v} for k, v in env["functors"].items()],
            "naturalTransformations": [{"name": k, **v} for k, v in env["nats"].items()],
            "adjunctions": env["adjunctions"],
            "laws": [
                {"name": k, "lhs": format_morph(v[0]), "rhs": format_morph(v[1])}
                for k, v in env["laws"].items()
            ],
            "theorems": [
                {
                    "name": t["name"],
                    "line": t["line"],
                    "dom": format_obj(t["dom"]),
                    "cod": format_obj(t["cod"]),
                    "cat": t["cat"],
                    "statement": f"{format_morph(t['orig_lhs'])} = {format_morph(t['orig_rhs'])}",
                    "verified": t["verified"],
                }
                for t in theorems
            ],
            "diagram": diagram,
            "steps": steps,
            "pipeline": pipeline,
            "error": first_error,
        },
    }
